import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * POST /agents/:id/withdraw sweeps the agent wallet on every chain the
 * settlement registry knows, with each chain's gas numbers from the registry.
 * Where a chain's gas coin is its settlement token (Arc's USDC), a native
 * sweep is refused and an ERC-20 sweep of that token leaves the gas reserve.
 * No chain is like that yet, so those cases mark Base as one.
 *
 * Wallets, providers and tokens are fakes: nothing is signed or sent.
 */

const OWNER = '0x2222222222222222222222222222222222222222';
const AGENT_WALLET = '0x4444444444444444444444444444444444444444';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const OTHER_TOKEN = '0x5555555555555555555555555555555555555555';
const E = 10n ** 18n;

const state = vi.hoisted(() => ({
  cfg: {} as Record<string, unknown>,
  agentStatus: 'stopped',
  native: {} as Record<string, bigint>,
  /** chain → lowercased token address → balance; a missing token is not an ERC-20 there. */
  tokens: {} as Record<string, Record<string, bigint>>,
  sends: [] as Array<{ chain: string; to: string; value: bigint }>,
  transfers: [] as Array<{ chain: string; token: string; to: string; amount: bigint }>,
  /** Registry changes per chain for the gas-coin-is-settlement-token cases. */
  gasCoinIsToken: {} as Record<string, boolean>,
}));

vi.mock('../config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../config.js')>();
  Object.assign(state.cfg, mod.config);
  return { ...mod, config: state.cfg };
});
vi.mock('../services/settlementChains.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../services/settlementChains.js')>();
  type Entry = ReturnType<typeof mod.settlementChainConfig>;
  const adjust = (entry: Entry): Entry =>
    state.gasCoinIsToken[entry.key] ? { ...entry, gas: { ...entry.gas, nativeIsSettlementToken: true } } : entry;
  return {
    ...mod,
    settlementChainConfig: (key: Entry['key']) => adjust(mod.settlementChainConfig(key)),
    settlementChainConfigs: () => mod.settlementChainConfigs().map(adjust),
  };
});
vi.mock('../services/chain.js', () => {
  const fakeProvider = (name: string) => ({ name, getBalance: async () => state.native[name] ?? 0n });
  return { provider: fakeProvider('0g'), baseProvider: fakeProvider('base') };
});
vi.mock('ethers', async (importOriginal) => {
  const mod = await importOriginal<typeof import('ethers')>();
  type FakeProvider = { name: string };
  class FakeWallet {
    readonly address = AGENT_WALLET;
    constructor(_pk: string, readonly provider: FakeProvider) {}
    async sendTransaction({ to, value }: { to: string; value: bigint }) {
      state.sends.push({ chain: this.provider.name, to, value });
      return { hash: `0xnative-${this.provider.name}`, wait: async () => ({ blockNumber: 7 }) };
    }
  }
  class FakeContract {
    private readonly chain: string;
    constructor(private readonly address: string, _abi: unknown, runner: FakeWallet) {
      this.chain = runner.provider.name;
    }
    async balanceOf() {
      const balance = state.tokens[this.chain]?.[this.address.toLowerCase()];
      if (balance === undefined) throw new Error('could not decode result data (value="0x")');
      return balance;
    }
    async transfer(to: string, amount: bigint) {
      state.transfers.push({ chain: this.chain, token: this.address, to, amount });
      return { hash: `0xtoken-${this.chain}`, wait: async () => ({ blockNumber: 8 }) };
    }
    async decimals() { return 6n; }
  }
  return { ...mod, ethers: { ...mod.ethers, Wallet: FakeWallet, Contract: FakeContract } };
});
vi.mock('../services/agentRunner.js', () => ({
  deployAgent: vi.fn(), startAgent: vi.fn(),
  pauseAgent: vi.fn(), stopAgent: vi.fn(), resumeAgent: vi.fn(),
  getAgent: vi.fn(async (id: string) => ({
    id, ownerAddress: OWNER, authorizedOwners: [], walletAddress: AGENT_WALLET,
    status: state.agentStatus, rawPrivateKey: '11'.repeat(32),
  })),
  listAgents: vi.fn(), getAgentLogs: vi.fn(),
  subscribeAgentLogs: vi.fn(async () => () => {}), updateAgent: vi.fn(),
  addAuthorizedOwner: vi.fn(), getAgentStats: vi.fn(),
}));
vi.mock('../services/apiKeyStore.js', () => ({
  lookupApiKey: vi.fn(async (c: string) => (c === 'sk_owner' ? { ownerAddress: OWNER } : null)),
}));
vi.mock('../services/redis.js', () => ({
  redis: {
    get: vi.fn(), set: vi.fn(), exists: vi.fn(), pipeline: vi.fn(),
    smembers: vi.fn(async () => []), sadd: vi.fn(async () => 0),
    srem: vi.fn(async () => 0), del: vi.fn(async () => 0),
  },
}));
vi.mock('../services/reputation.js', () => ({}));
vi.mock('../services/reputationDecay.js', () => ({}));
vi.mock('../services/agentStore.js', () => ({}));
vi.mock('../services/serviceStore.js', () => ({}));
vi.mock('../services/skillStore.js', () => ({ incrementInstallCount: vi.fn(), getSkillBySlug: vi.fn(async () => null) }));
vi.mock('../services/agentEmbedding.js', () => ({ recomputeForWalletBestEffort: vi.fn() }));
vi.mock('../services/agentFactoryListener.js', () => ({ claimDeployCredit: vi.fn(), restoreDeployCredit: vi.fn() }));
vi.mock('../services/skillComposer.js', () => ({ buildInstalledSkill: vi.fn(), assertComposedSizeOk: vi.fn() }));

const { agentsRouter, nativeWeiToTokenUnits } = await import('./agents.js');
const { globalErrorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
app.use('/api/v1/agents', agentsRouter);
app.use(globalErrorHandler);

const withdraw = (body: Record<string, unknown> = {}) =>
  request(app).post('/api/v1/agents/agent-1/withdraw').set('X-API-Key', 'sk_owner').send(body);

beforeEach(() => {
  state.agentStatus = 'stopped';
  state.native = {};
  state.tokens = {};
  state.sends = [];
  state.transfers = [];
  state.gasCoinIsToken = {};
  Object.assign(state.cfg, {
    blindEscrowAddress: '0x3d0374963DaaD43e31d42373eb11156A8e8ce2Ff',
    baseEscrowAddress: '0xCca5ab873158b888158AD9Dc36fb4Ee683eFbEBf',
    baseUsdcAddress: USDC,
  });
});

describe('native withdraw', () => {
  it("sweeps 0G, then Base, leaving each chain's gas reserve", async () => {
    state.native = { '0g': 1n * E, base: E / 1000n };
    const res = await withdraw();
    expect(res.status).toBe(200);
    expect(state.sends).toEqual([
      { chain: '0g', to: OWNER, value: E - E / 1000n }, // 0.001 0G reserve
      { chain: 'base', to: OWNER, value: E / 1000n - 3n * E / 10_000n }, // 0.0003 ETH reserve
    ]);
    expect(res.body.data.swept).toEqual([
      { chain: '0g', txHash: '0xnative-0g', asset: '0G', amountSent: '0.999', recipient: OWNER, blockNumber: 7 },
      { chain: 'base', txHash: '0xnative-base', asset: 'ETH', amountSent: '0.0007', recipient: OWNER, blockNumber: 7 },
    ]);
    expect(res.body.data.skipped).toEqual([]);
  });

  it('answers 409 with a reason per chain when every balance is within its reserve', async () => {
    state.native = { '0g': E / 1000n, base: 0n };
    const res = await withdraw();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BALANCE_TOO_LOW');
    expect(res.body.error.skipped.map((s: { chain: string }) => s.chain)).toEqual(['0g', 'base']);
    expect(res.body.error.skipped[0].reason).toMatch(/0\.001 0G\) is below the gas reserve/);
    expect(state.sends).toEqual([]);
  });

  it('still sweeps Base on a deployment with no Base escrow', async () => {
    state.cfg.baseEscrowAddress = '';
    state.native = { base: E / 1000n };
    const res = await withdraw();
    expect(res.status).toBe(200);
    expect(state.sends).toEqual([{ chain: 'base', to: OWNER, value: 7n * E / 10_000n }]);
  });

  it('refuses while the agent is running, before touching any chain', async () => {
    state.agentStatus = 'running';
    state.native = { '0g': E };
    const res = await withdraw();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AGENT_RUNNING');
    expect(state.sends).toEqual([]);
  });
});

describe('ERC-20 withdraw', () => {
  it('sweeps the whole balance where the token exists and the chain has gas', async () => {
    state.native = { '0g': E, base: E / 1000n };
    state.tokens = { base: { [USDC.toLowerCase()]: 5_000_000n } };
    const res = await withdraw({ tokenAddress: USDC });
    expect(res.status).toBe(200);
    expect(state.transfers).toEqual([{ chain: 'base', token: USDC, to: OWNER, amount: 5_000_000n }]);
    expect(res.body.data.swept).toEqual([{
      chain: 'base', txHash: '0xtoken-base', asset: USDC, amountRaw: '5000000', amountFormatted: '5.000000',
      decimals: 6, recipient: OWNER, blockNumber: 8,
    }]);
    expect(res.body.data.skipped).toEqual([
      { chain: '0g', reason: `${USDC} does not appear to be an ERC20 token on this chain — balanceOf returned empty data` },
    ]);
  });

  it("skips a chain without the registry's minimum gas for the transfer", async () => {
    state.native = { base: E / 100_000n }; // 0.00001 ETH, below 0.00005
    state.tokens = { base: { [USDC.toLowerCase()]: 5_000_000n } };
    const res = await withdraw({ tokenAddress: USDC });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ZERO_BALANCE');
    expect(res.body.error.skipped[1]).toEqual({
      chain: 'base',
      reason: 'insufficient native ETH to pay for the transfer tx (have 0.00001, need ≥0.00005). Top up gas first.',
    });
    expect(state.transfers).toEqual([]);
  });

  it('rejects a malformed token address', async () => {
    const res = await withdraw({ tokenAddress: '0x1234' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_TOKEN');
  });
});

describe('a chain whose gas coin is its settlement token', () => {
  // Base's reserve is 0.0003 of its native coin: 300 units of a 6-decimal token.
  const RESERVE_UNITS = 300n;

  beforeEach(() => {
    state.gasCoinIsToken = { base: true };
  });

  it('refuses a native sweep there, and still sweeps the other chains', async () => {
    state.native = { '0g': E, base: E };
    const res = await withdraw();
    expect(res.status).toBe(200);
    expect(state.sends.map((s) => s.chain)).toEqual(['0g']);
    expect(res.body.data.skipped).toEqual([
      { chain: 'base', reason: `ETH is this chain's settlement token; withdraw it with tokenAddress ${USDC}` },
    ]);
  });

  it('answers 409 when that chain was the only one with a balance', async () => {
    state.native = { base: E };
    const res = await withdraw();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BALANCE_TOO_LOW');
    expect(state.sends).toEqual([]);
  });

  it('leaves the gas reserve, in token units, when sweeping the settlement token', async () => {
    state.native = { base: E };
    state.tokens = { base: { [USDC.toLowerCase()]: 5_000_000n } };
    const res = await withdraw({ tokenAddress: USDC });
    expect(res.status).toBe(200);
    expect(state.transfers).toEqual([{ chain: 'base', token: USDC, to: OWNER, amount: 5_000_000n - RESERVE_UNITS }]);
    expect(res.body.data.swept[0]).toMatchObject({ amountRaw: '4999700', amountFormatted: '4.999700' });
  });

  it('matches the settlement token whatever its letter case', async () => {
    state.native = { base: E };
    state.tokens = { base: { [USDC.toLowerCase()]: 5_000_000n } };
    const res = await withdraw({ tokenAddress: USDC.toLowerCase() });
    expect(res.status).toBe(200);
    expect(state.transfers[0].amount).toBe(5_000_000n - RESERVE_UNITS);
  });

  it('skips the chain when the balance is within the reserve', async () => {
    state.native = { base: E };
    state.tokens = { base: { [USDC.toLowerCase()]: RESERVE_UNITS } };
    const res = await withdraw({ tokenAddress: USDC });
    expect(res.status).toBe(409);
    expect(res.body.error.skipped[1]).toEqual({ chain: 'base', reason: 'balance is below the ETH gas reserve this chain keeps back' });
    expect(state.transfers).toEqual([]);
  });

  it('sweeps any other ERC-20 there whole', async () => {
    state.native = { base: E };
    state.tokens = { base: { [OTHER_TOKEN]: 42n } };
    const res = await withdraw({ tokenAddress: OTHER_TOKEN });
    expect(res.status).toBe(200);
    expect(state.transfers).toEqual([{ chain: 'base', token: OTHER_TOKEN, to: OWNER, amount: 42n }]);
  });
});

describe('nativeWeiToTokenUnits', () => {
  it('converts 18-decimal native amounts to a 6-decimal token, rounding up', () => {
    expect(nativeWeiToTokenUnits(3n * E / 10_000n, 6)).toBe(300n);
    expect(nativeWeiToTokenUnits(10n ** 12n, 6)).toBe(1n);
    expect(nativeWeiToTokenUnits(10n ** 12n + 1n, 6)).toBe(2n);
    expect(nativeWeiToTokenUnits(1n, 6)).toBe(1n);
    expect(nativeWeiToTokenUnits(0n, 6)).toBe(0n);
  });

  it('leaves an 18-decimal token as is', () => {
    expect(nativeWeiToTokenUnits(5n, 18)).toBe(5n);
  });
});
