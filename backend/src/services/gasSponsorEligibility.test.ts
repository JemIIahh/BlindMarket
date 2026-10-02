import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';

/**
 * Every eligibility rule of sponsored gas (docs/AGENT-GAS-FUNDING.md, "Who is
 * eligible" / "What gets sponsored"), each on its own, and the advisory hint.
 * The store, the agent store, the escrow and the chain are fakes.
 */

const agentKey = ethers.Wallet.createRandom().privateKey;
const AGENT = new ethers.Wallet(agentKey).address;
const VERIFIER = '0x' + '5e'.repeat(20);
const USDC = '0x3600000000000000000000000000000000000000';

const state = vi.hoisted(() => ({
  exported: new Set<string>(),
  strikes: { agent: 0, owner: 0 },
  controls: { paused: false, killed: false },
  spent: { hour: 0n, day: 0n },
  agents: new Map<string, Record<string, unknown>>(),
  taskVerifier: '0x0000000000000000000000000000000000000000',
  balances: new Map<string, bigint>(),
  maxFee: 40n * 10n ** 9n,
}));
vi.mock('./gasSponsorStore.js', () => ({
  walletKeyExported: vi.fn(async (w: string) => state.exported.has(w.toLowerCase())),
  strikeCounts: vi.fn(async () => state.strikes),
  getControls: vi.fn(async () => state.controls),
  usage: vi.fn(async () => ({ spentLastHourWei: state.spent.hour, spentLastDayWei: state.spent.day, callsLastDay: 0, failuresLastHour: 0, sendsLastHour: 0 })),
}));
vi.mock('./deployedAgentStore.js', () => ({
  loadAgentByWallet: vi.fn(async (w: string) => state.agents.get(w.toLowerCase()) ?? null),
  loadAgentBySmartAccount: vi.fn(async () => null),
}));
vi.mock('./escrow.js', () => ({ getTaskVerifierOn: vi.fn(async () => state.taskVerifier) }));
vi.mock('./chainRuntime.js', () => ({
  chainRuntime: () => ({
    provider: {
      getFeeData: async () => ({ maxFeePerGas: state.maxFee, gasPrice: state.maxFee / 2n }),
      getBalance: async (a: string) => state.balances.get(a.toLowerCase()) ?? 0n,
    },
  }),
}));
const settingsHolder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('./gasSponsorConfig.js', () => ({ gasSponsorSettings: () => settingsHolder.current }));

const { agentEligibility, taskEligibility, verifierCanRule, sponsorHint, sponsorshipStatus, _resetSponsorHintCache } = await import('./gasSponsorEligibility.js');

const settings = {
  enabled: true,
  chainId: 5042,
  chain: { key: 'arc', chainId: 5042, token: { address: USDC, unit: { symbol: 'USDC', decimals: 6 } }, gas: { workerTxGasLimit: 200_000n } },
  minTaskRaw: 100_000n,
  caps: { maxStrikes: 3, hourlyBudgetWei: 10n ** 17n, dailyBudgetWei: 10n ** 18n },
} as never;

const hosted = (o: Record<string, unknown> = {}) => ({
  id: 'agent-1', ownerAddress: '0xowner', walletAddress: AGENT, rawPrivateKey: agentKey.slice(2), privyUserId: 'did:privy:abc', status: 'running', ...o,
});

beforeEach(() => {
  state.exported.clear();
  state.strikes = { agent: 0, owner: 0 };
  state.controls = { paused: false, killed: false };
  state.spent = { hour: 0n, day: 0n };
  state.agents.clear();
  state.taskVerifier = '0x0000000000000000000000000000000000000000';
  state.balances.clear();
  settingsHolder.current = settings;
  _resetSponsorHintCache();
});

describe('agentEligibility', () => {
  it('passes a hosted agent deployed through Privy, never exported, without strikes', async () => {
    expect(await agentEligibility(settings, hosted() as never)).toEqual({ ok: true, ownerDid: 'did:privy:abc' });
  });

  it.each([
    ['not hosted', null, 'not_hosted'],
    ['a stored key that derives another wallet', hosted({ rawPrivateKey: ethers.Wallet.createRandom().privateKey }), 'key_mismatch'],
    ['no stored key', hosted({ rawPrivateKey: undefined }), 'key_mismatch'],
    ['no Privy user (an API key or agent token deployed it)', hosted({ privyUserId: undefined }), 'no_privy_user'],
  ])('refuses %s', async (_name, agent, reason) => {
    expect(await agentEligibility(settings, agent as never)).toEqual({ ok: false, reason });
  });

  it('refuses a wallet whose key was ever exported', async () => {
    state.exported.add(AGENT.toLowerCase());
    expect(await agentEligibility(settings, hosted() as never)).toEqual({ ok: false, reason: 'key_exported' });
  });

  it('refuses an agent, or a Privy user, at the strike cap', async () => {
    state.strikes = { agent: 3, owner: 0 };
    expect(await agentEligibility(settings, hosted() as never)).toEqual({ ok: false, reason: 'strikes' });
    state.strikes = { agent: 0, owner: 3 };
    expect(await agentEligibility(settings, hosted() as never)).toEqual({ ok: false, reason: 'strikes' });
  });
});

describe('taskEligibility', () => {
  const task = (amount: bigint, token = USDC) => ({ token, amount });

  it('passes a task of at least 0.10 USDC with no verifier agent', async () => {
    expect(await taskEligibility(settings, 1n, task(100_000n))).toEqual({ ok: true });
  });

  it('refuses a smaller reward, or another token', async () => {
    expect(await taskEligibility(settings, 1n, task(99_999n))).toEqual({ ok: false, reason: 'below_minimum' });
    expect(await taskEligibility(settings, 1n, task(10n ** 6n, '0x' + '1'.repeat(40)))).toEqual({ ok: false, reason: 'wrong_token' });
  });

  it('takes a verifier agent that is opted in, running and holds its gas gate', async () => {
    state.taskVerifier = VERIFIER;
    state.agents.set(VERIFIER, { walletAddress: VERIFIER, verifierEnabled: true, status: 'running' });
    state.balances.set(VERIFIER, 200_000n * 40n * 10n ** 9n); // exactly the gate at 40 gwei
    expect(await taskEligibility(settings, 1n, task(10n ** 6n))).toEqual({ ok: true });
  });

  it.each([
    ['not hosted', null, 10n ** 18n],
    ['not opted in', { verifierEnabled: false, status: 'running' }, 10n ** 18n],
    ['not running', { verifierEnabled: true, status: 'stopped' }, 10n ** 18n],
    ['short of its gas gate', { verifierEnabled: true, status: 'running' }, 200_000n * 40n * 10n ** 9n - 1n],
  ])('refuses a verifier agent that is %s', async (_name, record, balance) => {
    state.taskVerifier = VERIFIER;
    if (record) state.agents.set(VERIFIER, { walletAddress: VERIFIER, ...record });
    state.balances.set(VERIFIER, balance as bigint);
    expect(await verifierCanRule(settings, VERIFIER)).toBe(false);
    expect(await taskEligibility(settings, 1n, task(10n ** 6n))).toEqual({ ok: false, reason: 'verifier_not_ready' });
  });

  it('skips the verifier rule for a release', async () => {
    state.taskVerifier = VERIFIER;
    expect(await taskEligibility(settings, 1n, task(10n ** 6n), { verifier: false })).toEqual({ ok: true });
  });
});

describe('sponsorHint', () => {
  const meta = (amount = '100000', chain = 'arc') => ({ chain, reward: { amount, unit: { symbol: 'USDC', decimals: 6 } } }) as never;

  it('hints a qualifying Arc task, and an offer to an eligible agent', async () => {
    state.agents.set(AGENT.toLowerCase(), hosted());
    expect(await sponsorHint(meta())).toBe(true);
    expect(await sponsorHint(meta(), AGENT)).toBe(true);
  });

  it('does not hint when off, off Arc, below the minimum, paused, or over budget', async () => {
    settingsHolder.current = { enabled: false, reason: 'off', misconfigured: false };
    expect(await sponsorHint(meta())).toBe(false);
    settingsHolder.current = settings;
    expect(await sponsorHint(meta('100000', 'base'))).toBe(false);
    expect(await sponsorHint(meta('99999'))).toBe(false);
    state.controls = { paused: true, killed: false };
    expect(await sponsorHint(meta())).toBe(false);
    _resetSponsorHintCache();
    state.controls = { paused: false, killed: false };
    state.spent = { hour: 10n ** 17n, day: 0n };
    expect(await sponsorHint(meta())).toBe(false);
  });

  it('does not hint an offer to an agent that is not eligible', async () => {
    state.agents.set(AGENT.toLowerCase(), hosted({ privyUserId: undefined }));
    expect(await sponsorHint(meta(), AGENT)).toBe(false);
  });
});

describe('sponsorshipStatus (the agent page)', () => {
  it('is sponsored, paused, or not eligible with the reason', async () => {
    expect(await sponsorshipStatus(hosted() as never)).toEqual({ state: 'sponsored' });
    state.controls = { paused: false, killed: true };
    expect(await sponsorshipStatus(hosted() as never)).toEqual({ state: 'paused' });
    state.exported.add(AGENT.toLowerCase());
    expect(await sponsorshipStatus(hosted() as never)).toEqual({ state: 'not_eligible', reason: 'key_exported' });
    settingsHolder.current = { enabled: false, reason: 'off', misconfigured: false };
    expect(await sponsorshipStatus(hosted() as never)).toEqual({ state: 'off' });
  });
});
