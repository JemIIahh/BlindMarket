import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * GET /health/settlement serves the settlement chains as data, from config
 * alone: no RPC, no Redis. The web app reads it at boot to learn the posting
 * chain and each chain's token, escrow and relay name, so it can gate a page
 * load on it — which /health/bridge, with its verifier and balance reads,
 * cannot.
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
      escrow: { verifier: boom('escrow.verifier') },
      baseEscrow: { verifier: boom('baseEscrow.verifier') },
      provider: { getBalance: boom('provider.getBalance') },
      baseProvider: { getBalance: boom('baseProvider.getBalance') },
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

const OG_ESCROW = '0x3d0374963DaaD43e31d42373eb11156A8e8ce2Ff';
const BASE_ESCROW = '0xCca5ab873158b888158AD9Dc36fb4Ee683eFbEBf';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ZERO = '0x0000000000000000000000000000000000000000';

const app = express();
app.use('/health', healthRouter);

async function settlement() {
  const res = await request(app).get('/health/settlement');
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  return res.body.data;
}

beforeEach(() => {
  Object.assign(cfg, {
    ogChainId: 16661,
    ogRpcUrl: 'https://rpc.example/secret-key',
    blindEscrowAddress: OG_ESCROW,
    baseChainId: 84532,
    baseRpcUrl: 'https://base.example/secret-key',
    baseEscrowAddress: BASE_ESCROW,
    baseUsdcAddress: USDC,
    postingChain: '',
    settlementTier: null,
  });
});

describe('GET /health/settlement', () => {
  it('names the posting chain and every chain as data', async () => {
    const data = await settlement();
    expect(data.postingChain).toBe('base');
    expect(data.chains).toEqual([
      {
        chain: '0g',
        chainId: 16661,
        tier: 'mainnet',
        escrowAddress: OG_ESCROW,
        token: { kind: 'native', address: ZERO, symbol: '0G', decimals: 18 },
        relayChain: null,
        gasSymbol: '0G',
        postable: false,
      },
      {
        chain: 'base',
        chainId: 84532,
        tier: 'testnet',
        escrowAddress: BASE_ESCROW,
        token: { kind: 'erc20', address: USDC, symbol: 'USDC', decimals: 6 },
        relayChain: 'base-sepolia',
        gasSymbol: 'ETH',
        postable: true,
      },
    ]);
    expect(data).toMatchObject({ settlementTier: 'mixed', tierSource: 'chains' });
    expect(data).not.toHaveProperty('postingChainError');
  });

  it('reads no chain, signer, indexer or dispute state (the mocks throw)', async () => {
    await settlement();
  });

  it('never returns an RPC URL', async () => {
    const body = JSON.stringify(await settlement());
    expect(body).not.toContain('secret-key');
    expect(body).not.toContain('rpcUrl');
  });

  it('follows POSTING_CHAIN', async () => {
    cfg.postingChain = '0g';
    const data = await settlement();
    expect(data.postingChain).toBe('0g');
    expect(data.chains.map((c: any) => [c.chain, c.postable])).toEqual([['0g', true], ['base', false]]);
  });

  it('posts on 0G when there is no Base escrow', async () => {
    cfg.baseEscrowAddress = '';
    const data = await settlement();
    expect(data.postingChain).toBe('0g');
    const base = data.chains.find((c: any) => c.chain === 'base');
    expect(base).toMatchObject({ escrowAddress: null, postable: false, relayChain: 'base-sepolia' });
  });

  it('reports an unknown POSTING_CHAIN instead of failing', async () => {
    cfg.postingChain = 'arc';
    const data = await settlement();
    expect(data.postingChain).toBeNull();
    expect(data.postingChainError).toMatch(/POSTING_CHAIN="arc"/);
    expect(data.chains.every((c: any) => c.postable === false)).toBe(true);
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
