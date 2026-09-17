import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * GET /health/bridge reports each settlement chain on its own. It used to
 * answer `configured: false` unless BOTH chains had a marketplace signer, so a
 * backend that could settle one chain looked broken, and the Base block was
 * only built when 0G was ready too. The MCP server reads the top-level 0G
 * fields and `base`, so their shape is pinned here.
 */

const { chain, cfg, ready, fingerprintErrors } = vi.hoisted(() => {
  const signer = (address: string) => ({ getAddress: async () => address });
  return {
    ready: { '0g': true, base: true } as Record<string, boolean>,
    fingerprintErrors: {} as Record<string, string | null>,
    cfg: {} as Record<string, unknown>,
    chain: {
      signer,
      marketplaceSigner: null as unknown,
      baseMarketplaceSigner: null as unknown,
      escrow: { verifier: async () => '0x00000000000000000000000000000000000000aa' },
      baseEscrow: null as unknown,
      provider: { getBalance: async () => 10n ** 18n },
      baseProvider: { getBalance: async () => 10n ** 16n },
    },
  };
});

vi.mock('../services/chain.js', () => chain);
vi.mock('../services/a2aSettlement.js', () => ({ isBridgeReady: (c: string) => ready[c] }));
vi.mock('../services/redis.js', () => ({ redis: {}, redisSub: {} }));
vi.mock('../services/escrowFingerprint.js', () => ({
  escrowFingerprintError: (c: string) => fingerprintErrors[c] ?? null,
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

const { healthRouter } = await import('./health.js');

const SIGNER = '0x00000000000000000000000000000000000000aa';
const OG_ESCROW = '0x3d0374963DaaD43e31d42373eb11156A8e8ce2Ff';
const BASE_ESCROW = '0xCca5ab873158b888158AD9Dc36fb4Ee683eFbEBf';

const app = express();
app.use('/health', healthRouter);

function setUp(opts: { og: boolean; base: boolean; baseEscrow?: boolean; baseSigner?: boolean }) {
  ready['0g'] = opts.og;
  ready.base = opts.base;
  chain.marketplaceSigner = opts.og ? chain.signer(SIGNER) : null;
  chain.baseMarketplaceSigner = (opts.baseSigner ?? opts.base) ? chain.signer(SIGNER) : null;
  const hasBaseEscrow = opts.baseEscrow ?? true;
  chain.baseEscrow = hasBaseEscrow ? { verifier: async () => '0x00000000000000000000000000000000000000bb' } : null;
  Object.assign(cfg, {
    ogChainId: 16661,
    blindEscrowAddress: OG_ESCROW,
    baseChainId: 84532,
    baseEscrowAddress: hasBaseEscrow ? BASE_ESCROW : '',
  });
}

async function bridge() {
  const res = await request(app).get('/health/bridge');
  expect(res.status).toBe(200);
  return res.body.data;
}

beforeEach(() => {
  setUp({ og: true, base: true });
  for (const k of Object.keys(fingerprintErrors)) delete fingerprintErrors[k];
});

describe('GET /health/bridge', () => {
  it('keeps the response shape the MCP reads when both chains are ready', async () => {
    const data = await bridge();
    expect(data).toMatchObject({
      configured: true,
      signerAddress: SIGNER,
      escrowAddress: OG_ESCROW,
      chainId: 16661,
      verifierMatches: true,
      rotateCommand: null,
      base: { configured: true, escrowAddress: BASE_ESCROW, chainId: 84532, verifierMatches: false },
    });
    expect(data).not.toHaveProperty('reason');
    expect(data.chains).toEqual([
      { chain: '0g', configured: true, chainId: 16661, tier: 'mainnet', escrowAddress: OG_ESCROW },
      { chain: 'base', configured: true, chainId: 84532, tier: 'testnet', escrowAddress: BASE_ESCROW },
    ]);
  });

  it("reports an indexer's escrow mismatch on that chain only, without changing readiness", async () => {
    fingerprintErrors.base = 'base:events:escrow is 84532:0xa1f7… but this backend indexes 84532:0xcca5…';
    const data = await bridge();
    expect(data.configured).toBe(true);
    expect(data).not.toHaveProperty('reason');
    expect(data.chains[0]).not.toHaveProperty('indexerError');
    expect(data.chains[1]).toMatchObject({ chain: 'base', configured: true, indexerError: fingerprintErrors.base });
  });

  it("names Base's own network in its fix command, not 0G's", async () => {
    const data = await bridge();
    expect(data.base.rotateCommand).toMatch(/--network base-sepolia$/);
  });

  it('reports Base even when 0G cannot settle', async () => {
    setUp({ og: false, base: true });
    const data = await bridge();
    expect(data.configured).toBe(true);
    expect(data.base).toMatchObject({ configured: true, escrowAddress: BASE_ESCROW });
    expect(data.reason).toBe('0G: MARKETPLACE_SIGNER_PRIVATE_KEY not set');
    // Still there, so a client can check a 0G transaction's target.
    expect(data.escrowAddress).toBe(OG_ESCROW);
    expect(data).not.toHaveProperty('signerAddress');
    expect(data.chains[0]).toMatchObject({ chain: '0g', configured: false, reason: 'MARKETPLACE_SIGNER_PRIVATE_KEY not set' });
  });

  it('reports 0G ready with base null when only the Base signer is missing', async () => {
    setUp({ og: true, base: false });
    const data = await bridge();
    expect(data).toMatchObject({ configured: true, signerAddress: SIGNER, base: null });
    expect(data.reason).toBe('Base: BASE_MARKETPLACE_SIGNER_PRIVATE_KEY not set');
  });

  it('does not call a deployment without a Base escrow misconfigured', async () => {
    setUp({ og: true, base: false, baseEscrow: false });
    const data = await bridge();
    expect(data).toMatchObject({ configured: true, base: null });
    expect(data).not.toHaveProperty('reason');
    expect(data.chains[1]).toEqual({ chain: 'base', configured: false, chainId: 84532, tier: 'testnet', escrowAddress: null });
  });

  it('names the missing Base escrow when only its signer is set', async () => {
    setUp({ og: true, base: false, baseEscrow: false, baseSigner: true });
    const data = await bridge();
    expect(data).toMatchObject({ configured: true, base: null, reason: 'Base: BASE_ESCROW_ADDRESS not set' });
  });

  it('never reports the zero address as the 0G escrow', async () => {
    setUp({ og: false, base: false });
    cfg.blindEscrowAddress = '0x0000000000000000000000000000000000000000';
    const data = await bridge();
    expect(data.escrowAddress).toBeNull();
    expect(data.chains[0].escrowAddress).toBeNull();
  });

  it('answers configured:false with every missing key when neither chain can settle', async () => {
    setUp({ og: false, base: false });
    const data = await bridge();
    expect(data).toMatchObject({ configured: false, base: null, escrowAddress: OG_ESCROW });
    expect(data.reason).toBe('0G: MARKETPLACE_SIGNER_PRIVATE_KEY not set; Base: BASE_MARKETPLACE_SIGNER_PRIVATE_KEY not set');
  });
});
