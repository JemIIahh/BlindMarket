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

const { chain, cfg, ready, fingerprintErrors, parkedCounts } = vi.hoisted(() => {
  const signer = (address: string) => ({ getAddress: async () => address });
  return {
    ready: { '0g': true, base: true } as Record<string, boolean>,
    fingerprintErrors: {} as Record<string, string | null>,
    parkedCounts: {} as Record<string, number | Error>,
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

const { healthRouter } = await import('./health.js');

const SIGNER = '0x00000000000000000000000000000000000000aa';
const OG_ESCROW = '0x3d0374963DaaD43e31d42373eb11156A8e8ce2Ff';
const BASE_ESCROW = '0xCca5ab873158b888158AD9Dc36fb4Ee683eFbEBf';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const OG_TOKEN = { kind: 'native', address: '0x0000000000000000000000000000000000000000', symbol: '0G', decimals: 18 };
const BASE_TOKEN = { kind: 'erc20', address: USDC, symbol: 'USDC', decimals: 6 };

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
    baseUsdcAddress: USDC,
    postingChain: '',
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
  for (const k of Object.keys(parkedCounts)) delete parkedCounts[k];
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
      {
        chain: '0g', configured: true, chainId: 16661, tier: 'mainnet', escrowAddress: OG_ESCROW,
        token: OG_TOKEN, relayChain: null, gasSymbol: '0G', postable: false,
      },
      {
        chain: 'base', configured: true, chainId: 84532, tier: 'testnet', escrowAddress: BASE_ESCROW,
        token: BASE_TOKEN, relayChain: 'base-sepolia', gasSymbol: 'ETH', postable: true,
      },
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

  it('counts parked dispute rulings per chain, and survives a failed count', async () => {
    parkedCounts.base = 2;
    parkedCounts['0g'] = new Error('redis down');
    const data = await bridge();
    expect(data.chains[1]).toMatchObject({ chain: 'base', parkedDisputes: 2 });
    expect(data.chains[0]).not.toHaveProperty('parkedDisputes');
    expect(data.configured).toBe(true);
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
    expect(data.chains[1]).toEqual({
      chain: 'base', configured: false, chainId: 84532, tier: 'testnet', escrowAddress: null,
      token: BASE_TOKEN, relayChain: 'base-sepolia', gasSymbol: 'ETH', postable: false,
    });
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

describe('GET /health/bridge rotate command per deployment set', () => {
  const OG_TESTNET_ESCROW = '0x1111111111111111111111111111111111111111';

  async function withSet<T>(deploymentSet: string, fn: () => Promise<T>): Promise<T> {
    const saved = { deploymentSet: cfg.deploymentSet, escrow: chain.escrow };
    // A 0G verifier mismatch too, so both chains print a command.
    chain.escrow = { verifier: async () => '0x00000000000000000000000000000000000000bb' };
    Object.assign(cfg, { deploymentSet, ogChainId: 16602, blindEscrowAddress: OG_TESTNET_ESCROW });
    try {
      return await fn();
    } finally {
      cfg.deploymentSet = saved.deploymentSet;
      chain.escrow = saved.escrow;
    }
  }

  // rotate-verifier refuses to send on Base Sepolia / 0G testnet without
  // EXPECTED_ESCROW, so production's own command must carry it too.
  it('names the escrow, without DEPLOYMENT_SET, when DEPLOYMENT_SET is unset', async () => {
    const data = await withSet('', bridge);
    expect(data.rotateCommand).toBe(
      `cd contracts && EXPECTED_ESCROW=${OG_TESTNET_ESCROW} ` +
        `MARKETPLACE_SIGNER_ADDRESS=${SIGNER} npx hardhat run scripts/rotate-verifier.ts --network 0g-testnet`,
    );
    expect(data.base.rotateCommand).toBe(
      `cd contracts && EXPECTED_ESCROW=${BASE_ESCROW} ` +
        `MARKETPLACE_SIGNER_ADDRESS=${SIGNER} npx hardhat run scripts/rotate-verifier.ts --network base-sepolia`,
    );
  });

  it('leaves EXPECTED_ESCROW out when the escrow is the zero address', async () => {
    const data = await withSet('', async () => {
      cfg.blindEscrowAddress = '0x0000000000000000000000000000000000000000';
      return bridge();
    });
    expect(data.rotateCommand).toBe(
      `cd contracts && MARKETPLACE_SIGNER_ADDRESS=${SIGNER} npx hardhat run scripts/rotate-verifier.ts --network 0g-testnet`,
    );
  });

  it("targets the staging records and this backend's escrow when DEPLOYMENT_SET=staging", async () => {
    const data = await withSet('staging', bridge);
    expect(data.rotateCommand).toBe(
      `cd contracts && DEPLOYMENT_SET=staging EXPECTED_ESCROW=${OG_TESTNET_ESCROW} ` +
        `MARKETPLACE_SIGNER_ADDRESS=${SIGNER} npx hardhat run scripts/rotate-verifier.ts --network 0g-testnet`,
    );
    expect(data.base.rotateCommand).toBe(
      `cd contracts && DEPLOYMENT_SET=staging EXPECTED_ESCROW=${BASE_ESCROW} ` +
        `MARKETPLACE_SIGNER_ADDRESS=${SIGNER} npx hardhat run scripts/rotate-verifier.ts --network base-sepolia`,
    );
  });
});

// The MCP reads the top-level 0G fields and `base`. These pin every one of
// them, values and key order, so the per-chain additions can't move them.
describe('GET /health/bridge legacy keys', () => {
  const VERIFIER_BB = '0x00000000000000000000000000000000000000bb';

  /** Keys added after the MCP's contract; every other key is legacy. */
  const ADDED_KEYS = ['chains', 'postingChain', 'postingChainError', 'settlementTier', 'tierSource'];

  /** The body without those. */
  async function legacyBody() {
    const saved = cfg.deploymentSet;
    cfg.deploymentSet = '';
    try {
      const data = await bridge();
      // Stripping must not hide anything: this stack has a valid posting chain.
      expect(data).not.toHaveProperty('postingChainError');
      return Object.fromEntries(Object.entries(data).filter(([key]) => !ADDED_KEYS.includes(key)));
    } finally {
      cfg.deploymentSet = saved;
    }
  }

  function expectExactly(actual: Record<string, unknown>, expected: Record<string, unknown>) {
    expect(actual).toEqual(expected);
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  }

  it('are unchanged when both chains are ready', async () => {
    expectExactly(await legacyBody(), {
      configured: true,
      escrowAddress: OG_ESCROW,
      chainId: 16661,
      signerAddress: SIGNER,
      onChainVerifier: SIGNER,
      verifierMatches: true,
      escrowReadError: null,
      signerBalanceOg: '1.0',
      signerGasLow: false,
      signerBalanceError: null,
      rotateCommand: null,
      base: {
        configured: true,
        signerAddress: SIGNER,
        escrowAddress: BASE_ESCROW,
        chainId: 84532,
        onChainVerifier: VERIFIER_BB,
        verifierMatches: false,
        escrowReadError: null,
        signerUsdcBalance: '5000000',
        signerEthBalance: '0.01',
        signerEthLow: false,
        signerBalanceError: null,
        rotateCommand:
          `cd contracts && EXPECTED_ESCROW=${BASE_ESCROW} ` +
          `MARKETPLACE_SIGNER_ADDRESS=${SIGNER} npx hardhat run scripts/rotate-verifier.ts --network base-sepolia`,
      },
    });
  });

  it('are unchanged when neither chain can settle', async () => {
    setUp({ og: false, base: false });
    expectExactly(await legacyBody(), {
      configured: false,
      reason: '0G: MARKETPLACE_SIGNER_PRIVATE_KEY not set; Base: BASE_MARKETPLACE_SIGNER_PRIVATE_KEY not set',
      escrowAddress: OG_ESCROW,
      chainId: 16661,
      base: null,
    });
  });

  it('are unchanged on a stack with no Base escrow', async () => {
    setUp({ og: true, base: false, baseEscrow: false });
    expectExactly(await legacyBody(), {
      configured: true,
      escrowAddress: OG_ESCROW,
      chainId: 16661,
      signerAddress: SIGNER,
      onChainVerifier: SIGNER,
      verifierMatches: true,
      escrowReadError: null,
      signerBalanceOg: '1.0',
      signerGasLow: false,
      signerBalanceError: null,
      rotateCommand: null,
      base: null,
    });
  });
});

describe('GET /health/bridge per-chain settlement facts', () => {
  it('names the posting chain: Base when it has an escrow, else 0G', async () => {
    expect((await bridge()).postingChain).toBe('base');
    setUp({ og: true, base: false, baseEscrow: false });
    const data = await bridge();
    expect(data.postingChain).toBe('0g');
    expect(data.chains.map((c: { postable: boolean }) => c.postable)).toEqual([true, false]);
  });

  it('follows POSTING_CHAIN', async () => {
    cfg.postingChain = '0g';
    const data = await bridge();
    expect(data.postingChain).toBe('0g');
    expect(data.chains.map((c: { postable: boolean }) => c.postable)).toEqual([true, false]);
  });

  it('is not postable on a chain whose settlement token is unset, as POST /tasks refuses it', async () => {
    cfg.baseUsdcAddress = '';
    const data = await bridge();
    expect(data.postingChain).toBe('base');
    expect(data.chains[1]).toMatchObject({ token: { ...BASE_TOKEN, address: null }, postable: false });
  });

  it('is postable whether or not the chain can settle yet', async () => {
    setUp({ og: true, base: false });
    const data = await bridge();
    expect(data.chains[1]).toMatchObject({ configured: false, postable: true });
  });

  it("names Base mainnet's relay chain on a Base mainnet stack", async () => {
    cfg.baseChainId = 8453;
    const data = await bridge();
    expect(data.chains[1]).toMatchObject({ chainId: 8453, tier: 'mainnet', relayChain: 'base-mainnet' });
  });

  // index.ts refuses to boot on this, but vercel.ts mounts the router without
  // that check, and a diagnostic endpoint should report the misconfiguration
  // rather than fail on it.
  it('reports an unknown POSTING_CHAIN instead of failing', async () => {
    cfg.postingChain = 'arc';
    const data = await bridge();
    expect(data.postingChain).toBeNull();
    expect(data.postingChainError).toMatch(/POSTING_CHAIN="arc" is not a settlement chain/);
    expect(data.chains.map((c: { postable: boolean }) => c.postable)).toEqual([false, false]);
    expect(data.configured).toBe(true);
  });

  it('never returns an RPC URL', async () => {
    Object.assign(cfg, {
      ogRpcUrl: 'https://og-rpc.example/secret-og-key',
      baseRpcUrl: 'https://base-rpc.example/v2/secret-base-key',
    });
    const res = await request(app).get('/health/bridge');
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/secret-(og|base)-key|rpc\.example/);
    expect(res.text).not.toMatch(/rpcUrl/i);
  });
});

describe('GET /health/bridge network tier', () => {
  it('reads the tier back from the chains when SETTLEMENT_TIER is unset', async () => {
    // Production today: 0G mainnet with Base Sepolia.
    expect(await bridge()).toMatchObject({ settlementTier: 'mixed', tierSource: 'chains' });
  });

  it('reports one tier when the settling chains agree', async () => {
    cfg.baseChainId = 8453;
    expect(await bridge()).toMatchObject({ settlementTier: 'mainnet', tierSource: 'chains' });
    Object.assign(cfg, { ogChainId: 16602, baseChainId: 84532 });
    expect(await bridge()).toMatchObject({ settlementTier: 'testnet', tierSource: 'chains' });
  });

  it('ignores a chain this stack has no escrow on', async () => {
    // 0G mainnet only: Base Sepolia is configured in code but not settled on.
    setUp({ og: true, base: false, baseEscrow: false });
    expect(await bridge()).toMatchObject({ settlementTier: 'mainnet', tierSource: 'chains' });
  });

  it('names SETTLEMENT_TIER as the source when it is set, even against the chains', async () => {
    cfg.settlementTier = 'testnet';
    expect(await bridge()).toMatchObject({ settlementTier: 'testnet', tierSource: 'SETTLEMENT_TIER' });
  });
});
