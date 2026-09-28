import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * GET /health/settlement serves the settlement chains as data, from config
 * plus one cached read per escrow (MAX_BATCH(), for batchCreate): no signer,
 * verifier or balance read, no Redis. The web app reads it at boot to learn
 * the posting chain and each chain's token, escrow and relay name, so it can
 * gate a page load on it — which /health/bridge, with its verifier and
 * balance reads, cannot.
 */

const { chain, cfg } = vi.hoisted(() => {
  const boom = (what: string) => async () => {
    throw new Error(`${what} must not be read by /health/settlement`);
  };
  return {
    cfg: {} as Record<string, unknown>,
    chain: {
      marketplaceSigner: { getAddress: boom('signer') },
      baseMarketplaceSigner: { getAddress: boom('signer') },
      arcMarketplaceSigner: { getAddress: boom('signer') },
      escrow: { verifier: boom('escrow.verifier') },
      baseEscrow: { verifier: boom('baseEscrow.verifier') },
      arcEscrow: { verifier: boom('arcEscrow.verifier') },
      provider: { getBalance: boom('provider.getBalance') },
      baseProvider: { getBalance: boom('baseProvider.getBalance') },
      arcProvider: { getBalance: boom('arcProvider.getBalance') },
    },
  };
});

vi.mock('../services/chain.js', () => chain);
vi.mock('../services/a2aSettlement.js', () => ({
  isBridgeReady: () => {
    throw new Error('isBridgeReady must not be called by /health/settlement');
  },
}));
vi.mock('../services/redis.js', () => ({ redis: {}, redisSub: {} }));
vi.mock('../services/escrowFingerprint.js', () => ({
  escrowFingerprintError: () => {
    throw new Error('escrowFingerprintError must not be called by /health/settlement');
  },
}));
vi.mock('../services/disputeKeys.js', () => ({
  parkedDisputeCount: async () => {
    throw new Error('parkedDisputeCount must not be called by /health/settlement');
  },
}));
vi.mock('../services/neonDb.js', () => ({ getPool: vi.fn(), getSchemaStatus: vi.fn(), latestMigrationId: vi.fn(() => 31) }));
vi.mock('../config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../config.js')>();
  Object.assign(cfg, mod.config);
  return { ...mod, config: cfg };
});

const { healthRouter } = await import('./health.js');
const { _resetBatchCreateSupportCache } = await import('../services/batchSupport.js');

const ARC_ESCROW = '0x3600000000000000000000000000000000000000';
const BASE_ESCROW = '0xCca5ab873158b888158AD9Dc36fb4Ee683eFbEBf';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ARC_USDC = '0x3600000000000000000000000000000000000000';

const app = express();
app.use('/health', healthRouter);
app.use('/api/v1/health', healthRouter);

async function settlement() {
  const res = await request(app).get('/health/settlement');
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  return res.body.data;
}

beforeEach(() => {
  _resetBatchCreateSupportCache();
  delete (chain.baseEscrow as Record<string, unknown>).MAX_BATCH;
  delete (chain.arcEscrow as Record<string, unknown>).MAX_BATCH;
  Object.assign(cfg, {
    ogChainId: 16661,
    ogRpcUrl: 'https://rpc.example/secret-key',
    blindEscrowAddress: '0x3d0374963DaaD43e31d42373eb11156A8e8ce2Ff',
    baseChainId: 84532,
    baseRpcUrl: 'https://base.example/secret-key',
    baseEscrowAddress: BASE_ESCROW,
    baseUsdcAddress: USDC,
    arcChainId: 5042002,
    arcRpcUrl: 'https://arc.example/secret-key',
    arcEscrowAddress: '',
    arcUsdcAddress: ARC_USDC,
    settlementTier: null,
  });
});

describe('GET /health/settlement', () => {
  it('names the posting chain and every chain as data', async () => {
    const data = await settlement();
    expect(data.postingChain).toBe('base');
    expect(data.chains).toEqual([
      {
        chain: 'base',
        chainId: 84532,
        tier: 'testnet',
        escrowAddress: BASE_ESCROW,
        token: { kind: 'erc20', address: USDC, symbol: 'USDC', decimals: 6 },
        relayChain: 'base-sepolia',
        gasSymbol: 'ETH',
        postable: true,
        batchCreate: { supported: false, maxBatch: 0 },
      },
      {
        chain: 'arc',
        chainId: 5042002,
        tier: 'testnet',
        escrowAddress: null,
        token: { kind: 'erc20', address: ARC_USDC, symbol: 'USDC', decimals: 6 },
        relayChain: null,
        gasSymbol: 'USDC',
        postable: false,
        batchCreate: { supported: false, maxBatch: 0 },
      },
    ]);
    expect(data).toMatchObject({ settlementTier: 'testnet', tierSource: 'chains' });
    expect(data).not.toHaveProperty('postingChainError');
  });

  it('reads no signer, verifier, balance, indexer or dispute state (the mocks throw)', async () => {
    await settlement();
  });

  it('never returns an RPC URL', async () => {
    const body = JSON.stringify(await settlement());
    expect(body).not.toContain('secret-key');
    expect(body).not.toContain('rpcUrl');
  });

  it('posts on Arc when there is no Base escrow', async () => {
    cfg.baseEscrowAddress = '';
    cfg.arcEscrowAddress = ARC_ESCROW;
    const data = await settlement();
    expect(data.postingChain).toBe('arc');
    const base = data.chains.find((c: any) => c.chain === 'base');
    expect(base).toMatchObject({ escrowAddress: null, postable: false, relayChain: 'base-sepolia' });
  });

  it("names Base mainnet's relay chain and tier on a Base mainnet stack", async () => {
    cfg.baseChainId = 8453;
    cfg.baseUsdcAddress = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const data = await settlement();
    const base = data.chains.find((c: any) => c.chain === 'base');
    expect(base).toMatchObject({ chainId: 8453, tier: 'mainnet', relayChain: 'base-mainnet' });
    expect(data.settlementTier).toBe('mainnet');
  });
});
// Phase 2 of bulk posting (docs/BULK-POSTING.md): clients batch tasks into one
// createTasks when the posting chain's escrow has it. MAX_BATCH() answering
// is the sign; an escrow from before the upgrade reverts on it.
describe('GET /health/settlement — batchCreate', () => {
  const baseEntry = async (path = '/health/settlement') => {
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    return res.body.data.chains.find((c: any) => c.chain === 'base');
  };
  const escrow = () => chain.baseEscrow as Record<string, unknown>;

  it("reports the escrow's MAX_BATCH when it answers, on both mounts", async () => {
    escrow().MAX_BATCH = vi.fn(async () => 50n);
    expect((await baseEntry()).batchCreate).toEqual({ supported: true, maxBatch: 50 });
    expect((await baseEntry('/api/v1/health/settlement')).batchCreate).toEqual({ supported: true, maxBatch: 50 });
  });

  it('reports unsupported, without a read, for a chain with no escrow', async () => {
    escrow().MAX_BATCH = vi.fn(async () => 50n);
    (chain.arcEscrow as Record<string, unknown>).MAX_BATCH = vi.fn(async () => 50n);
    const data = await settlement();
    expect(data.chains.find((c: any) => c.chain === 'arc').batchCreate).toEqual({ supported: false, maxBatch: 0 });
    expect((chain.arcEscrow as any).MAX_BATCH).not.toHaveBeenCalled();
  });

  it('reports unsupported when MAX_BATCH reverts (an escrow without createTasks)', async () => {
    escrow().MAX_BATCH = vi.fn(async () => {
      throw Object.assign(new Error('execution reverted (no data present; likely require(false) occurred'), { code: 'CALL_EXCEPTION' });
    });
    expect((await baseEntry()).batchCreate).toEqual({ supported: false, maxBatch: 0 });
  });

  it('reports unsupported on an RPC error, and still answers 200 with every other field', async () => {
    escrow().MAX_BATCH = vi.fn(async () => {
      throw Object.assign(new Error('request timeout (requestUrl="https://base.example/secret-key")'), { code: 'TIMEOUT' });
    });
    const data = await settlement();
    const base = data.chains.find((c: any) => c.chain === 'base');
    expect(base).toMatchObject({ escrowAddress: BASE_ESCROW, postable: true, batchCreate: { supported: false, maxBatch: 0 } });
    expect(JSON.stringify(data)).not.toContain('secret-key');
  });

  it('caps maxBatch at the 50 tasks one request takes', async () => {
    escrow().MAX_BATCH = vi.fn(async () => 200n);
    expect((await baseEntry()).batchCreate).toEqual({ supported: true, maxBatch: 50 });
  });

  it('reads MAX_BATCH once and serves the cached answer after', async () => {
    escrow().MAX_BATCH = vi.fn(async () => 50n);
    await baseEntry();
    await baseEntry();
    await baseEntry('/api/v1/health/settlement');
    expect(escrow().MAX_BATCH).toHaveBeenCalledTimes(1);
  });
});
