import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * GET /health/bridge reports each settlement chain on its own. 0G is agent
 * infra only, so its escrow/chainId stay at the top level for diagnostics, but
 * the settlement chain reporting lives under `base` and `chains`.
 */

const { chain, cfg, ready, fingerprintErrors, parkedCounts } = vi.hoisted(() => {
  const signer = (address: string) => ({ getAddress: async () => address });
  return {
    ready: { base: true } as Record<string, boolean>,
    fingerprintErrors: {} as Record<string, string | null>,
    parkedCounts: {} as Record<string, number | Error>,
    cfg: {} as Record<string, unknown>,
    chain: {
      signer,
      baseMarketplaceSigner: null as unknown,
      arcMarketplaceSigner: null as unknown,
      baseEscrow: null as unknown,
      arcEscrow: null as unknown,
      baseProvider: { getBalance: async () => 10n ** 16n },
      arcProvider: { getBalance: async () => 10n ** 16n },
    },
  };
});

vi.mock('../services/chain.js', () => chain);
vi.mock('../services/a2aSettlement.js', () => ({ isBridgeReady: (c: string) => ready[c] ?? false }));
vi.mock('../services/redis.js', () => ({ redis: {}, redisSub: {} }));
const identity = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock('../services/deploymentIdentity.js', () => ({ deploymentIdentityStatus: () => identity.current }));
vi.mock('../services/escrowFingerprint.js', () => ({
  escrowFingerprintError: (c: string) => fingerprintErrors[c] ?? null,
}));
vi.mock('../services/disputeKeys.js', () => ({
  parkedDisputeCount: async (c: string) => {
    const v = parkedCounts[c] ?? 0;
    if (v instanceof Error) throw v;
    return v;
  },
}));
vi.mock('../services/neonDb.js', () => ({ getPool: vi.fn(), getSchemaStatus: vi.fn(), latestMigrationId: vi.fn(() => 31) }));
vi.mock('../config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../config.js')>();
  Object.assign(cfg, mod.config);
  return { ...mod, config: cfg };
});
// The Base USDC balance read builds its own ethers.Contract.
vi.mock('ethers', async (importOriginal) => {
  const mod = await importOriginal<typeof import('ethers')>();
  class FakeContract { balanceOf = async () => 5_000_000n; }
  return { ...mod, ethers: { ...mod.ethers, Contract: FakeContract } };
});

const { healthRouter, safeErrorMessage } = await import('./health.js');

const SIGNER = '0x00000000000000000000000000000000000000aa';
const OG_ESCROW = '0x3d0374963DaaD43e31d42373eb11156A8e8ce2Ff';
const BASE_ESCROW = '0xCca5ab873158b888158AD9Dc36fb4Ee683eFbEBf';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const BASE_TOKEN = { kind: 'erc20', address: USDC, symbol: 'USDC', decimals: 6 };
const ARC_TOKEN = { kind: 'erc20', address: ARC_USDC, symbol: 'USDC', decimals: 6 };

const app = express();
app.use('/health', healthRouter);

function setUp(opts: { base: boolean; baseEscrow?: boolean; baseSigner?: boolean }) {
  ready.base = opts.base;
  chain.baseMarketplaceSigner = (opts.baseSigner ?? opts.base) ? chain.signer(SIGNER) : null;
  chain.arcMarketplaceSigner = null;
  const hasBaseEscrow = opts.baseEscrow ?? true;
  chain.baseEscrow = hasBaseEscrow ? { verifier: async () => '0x00000000000000000000000000000000000000bb' } : null;
  chain.arcEscrow = null;
  Object.assign(cfg, {
    ogChainId: 16661,
    blindEscrowAddress: OG_ESCROW,
    baseChainId: 84532,
    baseEscrowAddress: hasBaseEscrow ? BASE_ESCROW : '',
    baseUsdcAddress: USDC,
    arcChainId: 5042002,
    arcEscrowAddress: '',
    arcUsdcAddress: ARC_USDC,
    settlementTier: null,
  });
}

async function bridge() {
  const res = await request(app).get('/health/bridge');
  expect(res.status).toBe(200);
  return res.body.data;
}

beforeEach(() => {
  setUp({ base: true });
  for (const k of Object.keys(fingerprintErrors)) delete fingerprintErrors[k];
  for (const k of Object.keys(parkedCounts)) delete parkedCounts[k];
});

describe('GET /health/bridge', () => {
  it('reports Base ready and lists every chain', async () => {
    const data = await bridge();
    expect(data).toMatchObject({
      configured: true,
      escrowAddress: OG_ESCROW,
      chainId: 16661,
      base: { configured: true, escrowAddress: BASE_ESCROW, chainId: 84532, verifierMatches: false },
    });
    expect(data).not.toHaveProperty('reason');
    expect(data.chains).toEqual([
      {
        chain: 'base', configured: true, chainId: 84532, tier: 'testnet', escrowAddress: BASE_ESCROW,
        token: BASE_TOKEN, relayChain: 'base-sepolia', gasSymbol: 'ETH', postable: true,
      },
      {
        chain: 'arc', configured: false, chainId: 5042002, tier: 'testnet', escrowAddress: null,
        token: ARC_TOKEN, relayChain: null, gasSymbol: 'USDC', postable: false,
      },
    ]);
  });

  it("reports an indexer's escrow mismatch on that chain only, without changing readiness", async () => {
    fingerprintErrors.base = 'base:events:escrow is 84532:0xa1f7… but this backend indexes 84532:0xcca5…';
    const data = await bridge();
    expect(data.configured).toBe(true);
    expect(data).not.toHaveProperty('reason');
    expect(data.chains[1]).not.toHaveProperty('indexerError');
    expect(data.chains[0]).toMatchObject({ chain: 'base', configured: true, indexerError: fingerprintErrors.base });
  });

  it('counts parked dispute rulings per chain, and survives a failed count', async () => {
    parkedCounts.base = 2;
    const data = await bridge();
    expect(data.chains[0]).toMatchObject({ chain: 'base', parkedDisputes: 2 });
    expect(data.configured).toBe(true);
  });

  it('reports Base null when only the Base signer is missing', async () => {
    setUp({ base: false });
    const data = await bridge();
    expect(data).toMatchObject({ configured: false, base: null });
    expect(data.reason).toBe('Base: BASE_MARKETPLACE_SIGNER_PRIVATE_KEY not set');
  });

  it('does not call a deployment without a Base escrow misconfigured', async () => {
    setUp({ base: false, baseEscrow: false });
    const data = await bridge();
    expect(data).toMatchObject({ configured: false, base: null });
    expect(data.reason).toBe('no settlement chain has both an escrow and a marketplace signer');
    expect(data.chains[0]).toEqual({
      chain: 'base', configured: false, chainId: 84532, tier: 'testnet', escrowAddress: null,
      token: BASE_TOKEN, relayChain: 'base-sepolia', gasSymbol: 'ETH', postable: false,
    });
  });

  it('names the missing Base escrow when only its signer is set', async () => {
    setUp({ base: false, baseEscrow: false, baseSigner: true });
    const data = await bridge();
    expect(data).toMatchObject({ configured: false, base: null, reason: 'Base: BASE_ESCROW_ADDRESS not set' });
  });

  it('never reports the zero address as an escrow', async () => {
    setUp({ base: false, baseEscrow: false });
    cfg.blindEscrowAddress = '0x0000000000000000000000000000000000000000';
    const data = await bridge();
    expect(data.escrowAddress).toBeNull();
    expect(data.chains[0].escrowAddress).toBeNull();
  });
});

describe('GET /health/bridge rotate command per deployment set', () => {
  it('names the Base escrow, without DEPLOYMENT_SET, when DEPLOYMENT_SET is unset', async () => {
    const data = await bridge();
    expect(data.base.rotateCommand).toBe(
      `cd contracts && EXPECTED_ESCROW=${BASE_ESCROW} ` +
        `MARKETPLACE_SIGNER_ADDRESS=${SIGNER} npx hardhat run scripts/rotate-verifier.ts --network base-sepolia`,
    );
  });

  it('targets the staging records when DEPLOYMENT_SET=staging', async () => {
    cfg.deploymentSet = 'staging';
    const data = await bridge();
    expect(data.base.rotateCommand).toBe(
      `cd contracts && DEPLOYMENT_SET=staging EXPECTED_ESCROW=${BASE_ESCROW} ` +
        `MARKETPLACE_SIGNER_ADDRESS=${SIGNER} npx hardhat run scripts/rotate-verifier.ts --network base-sepolia`,
    );
  });
});

describe('GET /health/bridge deployment identity', () => {
  it('is null where the boot check never ran (vercel.ts)', async () => {
    identity.current = null;
    expect((await bridge()).deploymentIdentity).toBeNull();
  });

  it('reports what the boot check found, including stopped writers', async () => {
    identity.current = {
      deploymentId: 'staging-testnet', role: 'not-owner', owner: 'production', writersAllowed: false,
      reason: 'this Redis belongs to deployment "production"; this process is "staging-testnet"',
    };
    try {
      expect((await bridge()).deploymentIdentity).toEqual(identity.current);
    } finally {
      identity.current = null;
    }
  });
});

describe('GET /health/bridge error text', () => {
  const keyed = (short: string) => {
    const e = new Error(`${short} (request={ "method": "eth_call" }, response={ "status": 401 }, info={ "requestUrl": "https://rpc.example/v2/SUPERSECRETKEY456" }, code=SERVER_ERROR, version=6.13.1)`) as Error & { code: string; shortMessage: string };
    e.code = 'SERVER_ERROR';
    e.shortMessage = short;
    return e;
  };

  it('never repeats the RPC URL an ethers error embeds', async () => {
    chain.baseEscrow = { verifier: async () => { throw keyed('missing revert data'); } };
    const res = await request(app).get('/health/bridge');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('SUPERSECRETKEY456');
    expect(res.text).not.toContain('rpc.example');
    expect(res.body.data.base.escrowReadError).toMatch(/^missing revert data \[SERVER_ERROR\]$/);
  });

  it('keeps a plain message as it is, and drops an ethers request dump even without a shortMessage', () => {
    expect(safeErrorMessage(new Error('timeout'))).toBe('timeout');
    expect(safeErrorMessage(new Error('missing revert data (request={ "to": "0x1" }, info={ "requestUrl": "https://rpc.example/v2/KEY" }, code=CALL_EXCEPTION)'))).toBe('missing revert data');
    expect(safeErrorMessage('boom')).toBe('boom');
    expect(safeErrorMessage(null)).toBe('null');
  });
});

describe('GET /health/bridge per-chain settlement facts', () => {
  it('keeps each chain entry’s key order', async () => {
    const data = await bridge();
    for (const entry of data.chains) {
      expect(Object.keys(entry)).toEqual([
        'chain', 'configured', 'chainId', 'tier', 'escrowAddress', 'token', 'relayChain', 'gasSymbol', 'postable',
      ]);
      expect(Object.keys(entry.token)).toEqual(['kind', 'address', 'symbol', 'decimals']);
    }
  });

  it('names the posting chain: Base when it has an escrow, else Arc', async () => {
    expect((await bridge()).postingChain).toBe('base');
    setUp({ base: false, baseEscrow: false });
    cfg.arcEscrowAddress = '0x3600000000000000000000000000000000000000';
    const data = await bridge();
    expect(data.postingChain).toBe('arc');
  });

  it('is postable whether or not the chain can settle yet', async () => {
    setUp({ base: false });
    const data = await bridge();
    expect(data.chains[0]).toMatchObject({ configured: false, postable: true });
  });

  it("names Base mainnet's relay chain on a Base mainnet stack", async () => {
    cfg.baseChainId = 8453;
    const data = await bridge();
    expect(data.chains[0]).toMatchObject({ chainId: 8453, tier: 'mainnet', relayChain: 'base-mainnet' });
  });

  it('never returns an RPC URL', async () => {
    Object.assign(cfg, {
      baseRpcUrl: 'https://base-rpc.example/v2/secret-base-key',
      arcRpcUrl: 'https://arc-rpc.example/v2/secret-arc-key',
    });
    const res = await request(app).get('/health/bridge');
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/secret-(base|arc)-key|rpc\.example/);
    expect(res.text).not.toMatch(/rpcUrl/i);
  });
});

describe('GET /health/bridge network tier', () => {
  it('reads the tier back from the chains when SETTLEMENT_TIER is unset', async () => {
    expect(await bridge()).toMatchObject({ settlementTier: 'testnet', tierSource: 'chains' });
  });

  it('reports one tier when the settling chains agree', async () => {
    cfg.baseChainId = 8453;
    expect(await bridge()).toMatchObject({ settlementTier: 'mainnet', tierSource: 'chains' });
    cfg.baseChainId = 84532;
    expect(await bridge()).toMatchObject({ settlementTier: 'testnet', tierSource: 'chains' });
  });

  it('names SETTLEMENT_TIER as the source when it is set, even against the chains', async () => {
    cfg.settlementTier = 'testnet';
    expect(await bridge()).toMatchObject({ settlementTier: 'testnet', tierSource: 'SETTLEMENT_TIER' });
  });
});