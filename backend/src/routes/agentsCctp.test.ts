import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Route-level tests for the Phase A (outbound) CCTP withdraw endpoint.
 * Modeled on routes/agents.logs.test.ts: the REAL agentsCctpRouter and the
 * REAL (imported, not mocked) authorizeOwner from agents.ts run unmocked, so
 * this exercises the actual ownership gate — auth driven via the DB-backed
 * X-API-Key path (lookupApiKey mocked), same as that file.
 *
 * The one thing this suite exists to prove (CCTP plan §3.4 done-criterion):
 * a repeated POST with the same idempotencyKey against a non-terminal row
 * must NOT submit a second on-chain burn.
 */

const OWNER = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const AGENT_ID = 'agent-1';

function agentRecord(overrides: Partial<any> = {}) {
  return {
    id: AGENT_ID,
    ownerAddress: OWNER,
    authorizedOwners: [],
    name: 'Test Agent',
    instructions: 'do things',
    provider: 'openai',
    model: 'gpt-x',
    apiKey: '',
    encryptedApiKey: '',
    capabilities: ['web_research'],
    tools: [],
    status: 'stopped',
    deployedAt: '2026-01-01',
    walletAddress: '0x4444444444444444444444444444444444444444',
    publicKey: '04abcd',
    encryptedPrivateKey: '',
    rawPrivateKey: '0x' + '11'.repeat(32),
    ...overrides,
  };
}

vi.mock('../services/agentRunner.js', () => ({
  deployAgent: vi.fn(),
  startAgent: vi.fn(),
  pauseAgent: vi.fn(),
  stopAgent: vi.fn(),
  resumeAgent: vi.fn(),
  getAgent: vi.fn(),
  listAgents: vi.fn(),
  getAgentLogs: vi.fn(),
  subscribeAgentLogs: vi.fn(async () => () => {}),
  updateAgent: vi.fn(),
  addAuthorizedOwner: vi.fn(),
  getAgentStats: vi.fn(),
}));

vi.mock('../services/apiKeyStore.js', () => ({
  lookupApiKey: vi.fn(async (candidate: string) => {
    if (candidate === 'sk_owner') return { ownerAddress: OWNER };
    if (candidate === 'sk_other') return { ownerAddress: OTHER };
    return null;
  }),
}));

// Same infra stubs as agents.logs.test.ts — agents.ts (imported transitively
// via authorizeOwner) needs these present to load at all.
vi.mock('../services/chain.js', () => ({ provider: {}, baseProvider: {} }));
vi.mock('../services/redis.js', () => ({
  redis: { get: vi.fn(), set: vi.fn(), exists: vi.fn(), pipeline: vi.fn() },
}));
vi.mock('../services/reputation.js', () => ({}));
vi.mock('../services/reputationDecay.js', () => ({}));
vi.mock('../services/agentStore.js', () => ({}));
vi.mock('../services/serviceStore.js', () => ({}));
vi.mock('../services/skillStore.js', () => ({}));
vi.mock('../services/agentEmbedding.js', () => ({}));
vi.mock('../services/skillComposer.js', () => ({
  buildInstalledSkill: vi.fn(),
  assertComposedSizeOk: vi.fn(),
}));

const { FAKE_SOURCE, FAKE_DEST, executeDepositForBurn, rows, nextIdRef } = vi.hoisted(() => {
  const fakeSource = {
    chainKey: 'base-sepolia',
    chainId: 84532,
    domain: 6,
    rpc: {
      getBalance: async () => 10n ** 18n, // plenty of ETH
      getTransactionReceipt: async () => null,
    },
    tokenMessengerAddress: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    messageTransmitterAddress: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
    usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    isTestnet: true,
    label: 'Base Sepolia',
  };
  const fakeDest = {
    ...fakeSource,
    chainKey: 'ethereum-sepolia',
    domain: 0,
    usdcAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    label: 'Ethereum Sepolia',
  };
  return {
    FAKE_SOURCE: fakeSource,
    FAKE_DEST: fakeDest,
    executeDepositForBurn: vi.fn(async () => ({ txHash: '0xburn' })),
    // Tiny in-memory fake of the store so idempotency semantics are real,
    // not asserted purely via mock call counts.
    rows: new Map<string, any>(),
    nextIdRef: { current: 1 },
  };
});

vi.mock('../services/cctpChains.js', () => ({
  isCctpConfigured: vi.fn(() => true),
  isSupportedCctpChain: vi.fn((k: string) => k === 'ethereum-sepolia'),
  getCctpChain: vi.fn((k: string) => (k === 'ethereum-sepolia' ? FAKE_DEST : k === 'base-sepolia' ? FAKE_SOURCE : null)),
  getBaseCctpChain: vi.fn(() => FAKE_SOURCE),
  supportedCctpChains: vi.fn(() => [FAKE_SOURCE, FAKE_DEST]),
}));

vi.mock('../services/cctp.js', async () => {
  const actual = await vi.importActual<typeof import('../services/cctp.js')>('../services/cctp.js');
  return {
    ...actual,
    executeDepositForBurn,
    estimateMaxFeeRaw: vi.fn(async () => 100n),
  };
});

vi.mock('../services/cctpTransferStore.js', () => ({
  createTransfer: vi.fn(async (opts: any) => {
    const row = { id: nextIdRef.current++, stage: 'created', ...opts, idempotency_key: opts.idempotencyKey, burn_tx_hash: null, mint_tx_hash: null, error_message: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    rows.set(opts.idempotencyKey, row);
    return row;
  }),
  getByIdempotencyKey: vi.fn(async (key: string) => rows.get(key) ?? null),
  updateTransfer: vi.fn(async (id: number, patch: any) => {
    const row = [...rows.values()].find((r) => r.id === id);
    if (!row) return null;
    Object.assign(row, patch);
    return row;
  }),
  getById: vi.fn(async (id: number) => [...rows.values()].find((r) => r.id === id) ?? null),
  listForAgent: vi.fn(async () => [...rows.values()]),
  serializeTransfer: vi.fn((t: any) => (t ? { transferId: t.id, stage: t.stage, burnTxHash: t.burn_tx_hash } : null)),
}));

// ERC20 balanceOf is called via `new ethers.Contract(...)` directly in the
// route (not through cctp.js), so stub ethers.Contract's instance methods.
vi.mock('ethers', async () => {
  const actual = await vi.importActual<typeof import('ethers')>('ethers');
  class FakeContract {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_addr: string, _abi: unknown, _runner: unknown) {}
    balanceOf = vi.fn(async () => 10_000_000n); // 10 USDC, 6 decimals
  }
  // `ethers.Contract` (nested, via `import { ethers } from 'ethers'`) is a
  // SEPARATE reference from the top-level named `Contract` export — both
  // must be overridden or the route's `new ethers.Contract(...)` still hits
  // the real class against our fake (non-Provider) rpc object.
  return { ...actual, Contract: FakeContract, ethers: { ...actual.ethers, Contract: FakeContract } };
});

import { agentsCctpRouter } from './agentsCctp.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import * as agentRunner from '../services/agentRunner.js';
import { config } from '../config.js';

// config.ts's `cctp.enabled` defaults to false; flip it on for this suite.
// Mutating the (unmocked, real) config object directly rather than setting
// CCTP_ENABLED via process.env, since ES module imports are hoisted above
// any top-level statement and config.ts would already have read the env var
// by the time an env-var assignment ran.
(config.cctp as { enabled: boolean }).enabled = true;

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/agents', agentsCctpRouter);
  a.use(globalErrorHandler);
  return a;
}

beforeEach(() => {
  rows.clear();
  nextIdRef.current = 1;
  executeDepositForBurn.mockClear();
  vi.mocked(agentRunner.getAgent).mockResolvedValue(agentRecord() as any);
});

describe('POST /api/v1/agents/:id/cctp/withdraw', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await request(app())
      .post(`/api/v1/agents/${AGENT_ID}/cctp/withdraw`)
      .send({ destinationChain: 'ethereum-sepolia', idempotencyKey: 'k1' });
    expect(res.status).toBe(401);
  });

  it('rejects a non-owner', async () => {
    const res = await request(app())
      .post(`/api/v1/agents/${AGENT_ID}/cctp/withdraw`)
      .set('X-API-Key', 'sk_other')
      .send({ destinationChain: 'ethereum-sepolia', idempotencyKey: 'k1' });
    expect(res.status).toBe(403);
  });

  it('submits exactly one burn for a fresh idempotencyKey', async () => {
    const res = await request(app())
      .post(`/api/v1/agents/${AGENT_ID}/cctp/withdraw`)
      .set('X-API-Key', 'sk_owner')
      .send({ destinationChain: 'ethereum-sepolia', idempotencyKey: 'k-fresh' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.stage).toBe('burn_submitted');
    expect(res.body.data.burnTxHash).toBe('0xburn');
    expect(executeDepositForBurn).toHaveBeenCalledTimes(1);
  });

  it('a repeated request with the SAME idempotencyKey does not submit a second burn', async () => {
    const first = await request(app())
      .post(`/api/v1/agents/${AGENT_ID}/cctp/withdraw`)
      .set('X-API-Key', 'sk_owner')
      .send({ destinationChain: 'ethereum-sepolia', idempotencyKey: 'k-repeat' });
    expect(first.status).toBe(200);
    expect(executeDepositForBurn).toHaveBeenCalledTimes(1);

    const second = await request(app())
      .post(`/api/v1/agents/${AGENT_ID}/cctp/withdraw`)
      .set('X-API-Key', 'sk_owner')
      .send({ destinationChain: 'ethereum-sepolia', idempotencyKey: 'k-repeat' });

    expect(second.status).toBe(200);
    // The critical assertion: still only ever called once.
    expect(executeDepositForBurn).toHaveBeenCalledTimes(1);
    expect(second.body.data.transferId).toBe(first.body.data.transferId);
  });

  it('rejects an agent with no rawPrivateKey on record', async () => {
    vi.mocked(agentRunner.getAgent).mockResolvedValue(agentRecord({ rawPrivateKey: undefined }) as any);
    const res = await request(app())
      .post(`/api/v1/agents/${AGENT_ID}/cctp/withdraw`)
      .set('X-API-Key', 'sk_owner')
      .send({ destinationChain: 'ethereum-sepolia', idempotencyKey: 'k-nokey' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_KEY');
    expect(executeDepositForBurn).not.toHaveBeenCalled();
  });

  it('rejects an unsupported destination chain', async () => {
    const res = await request(app())
      .post(`/api/v1/agents/${AGENT_ID}/cctp/withdraw`)
      .set('X-API-Key', 'sk_owner')
      .send({ destinationChain: 'solana', idempotencyKey: 'k-unsupported' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CCTP_UNSUPPORTED_CHAIN');
    expect(executeDepositForBurn).not.toHaveBeenCalled();
  });
});
