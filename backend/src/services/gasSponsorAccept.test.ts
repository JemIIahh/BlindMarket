import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The reservation /accept makes for a sponsored submit (gasSponsorAccept.ts):
 * every refusal is a 409 GAS_SPONSOR_UNAVAILABLE naming why, raised before
 * anything about the task changes.
 */

const run = vi.hoisted(() => ({ value: { ok: true, settings: { chainId: 5042002, caps: {} } } as any }));
vi.mock('./gasSponsorConfig.js', () => ({
  RESERVATION_TTL_SECONDS: 3600,
  runnableSettings: async () => run.value,
  gasSponsorSettings: () => ({ enabled: true, chainId: 5042002 }),
}));
const writer = vi.hoisted(() => ({ is: true }));
vi.mock('./gasSponsorRelayer.js', () => ({ isSponsorWriter: () => writer.is, reservationBudgetWei: async () => 10n ** 16n }));
const resolved = vi.hoisted(() => ({ value: { taskId: '41', chain: 'arc' } as any }));
vi.mock('./taskChain.js', () => ({ resolveTaskByHash: async () => resolved.value }));
const task = vi.hoisted(() => ({ value: { status: 0, agent: '0xposter', token: '0xusdc', amount: 10n ** 6n } as any }));
vi.mock('./escrow.js', () => ({ getTaskOn: async () => task.value }));
vi.mock('./deployedAgentStore.js', () => ({ loadAgentByWallet: async () => ({ walletAddress: '0xagent' }) }));
const elig = vi.hoisted(() => ({ agent: { ok: true, ownerDid: 'did:privy:abc' } as any, task: { ok: true } as any }));
vi.mock('./gasSponsorEligibility.js', () => ({ agentEligibility: async () => elig.agent, taskEligibility: async () => elig.task }));
const store = vi.hoisted(() => ({ reserve: vi.fn(), getReservation: vi.fn(), closeReservation: vi.fn(), startReservationClock: vi.fn() }));
vi.mock('./gasSponsorStore.js', () => store);

const { reserveForAccept, holdsReservation } = await import('./gasSponsorAccept.js');
const meta = { taskId: '0xhash', chain: 'arc' } as any;

beforeEach(() => {
  run.value = { ok: true, settings: { chainId: 5042002, caps: {} } };
  writer.is = true;
  resolved.value = { taskId: '41', chain: 'arc' };
  task.value = { status: 0, agent: '0xposter', token: '0xusdc', amount: 10n ** 6n };
  elig.agent = { ok: true, ownerDid: 'did:privy:abc' };
  elig.task = { ok: true };
  store.reserve.mockReset();
  store.reserve.mockResolvedValue({ ok: true, reservation: { id: 1 }, existing: false });
});

const refused = async (reason: string) => {
  await expect(reserveForAccept('0xhash', meta, '0xagent')).rejects.toMatchObject({ statusCode: 409, code: 'GAS_SPONSOR_UNAVAILABLE', reason });
};

describe('reserveForAccept', () => {
  it('reserves the submit of an open Arc task for an eligible agent, against the task poster', async () => {
    expect(await reserveForAccept('0xhash', meta, '0xagent')).toEqual({ id: 1 });
    expect(store.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 5042002, taskId: 41n, kind: 'submit', agentWallet: '0xagent', ownerDid: 'did:privy:abc', poster: '0xposter', ttlSeconds: 3600 }),
      {},
    );
  });

  it.each([
    ['sponsorship is off', () => { run.value = { ok: false, reason: 'off' }; }, 'off'],
    ['this process is not the writer', () => { writer.is = false; }, 'off'],
    ['the task is not indexed on Arc', () => { resolved.value = { taskId: '41', chain: 'base' }; }, 'not_indexed'],
    ['the task is no longer open on-chain', () => { task.value = { ...task.value, status: 1 }; }, 'not_open'],
    ['the agent is not eligible', () => { elig.agent = { ok: false, reason: 'key_exported' }; }, 'key_exported'],
    ['the task does not qualify', () => { elig.task = { ok: false, reason: 'below_minimum' }; }, 'below_minimum'],
    ['a cap is reached', () => { store.reserve.mockResolvedValue({ ok: false, refusal: 'poster_daily' }); }, 'poster_daily'],
  ])('refuses when %s', async (_name, change, reason) => {
    change();
    await refused(reason);
  });

  it('refuses a task off Arc', async () => {
    await expect(reserveForAccept('0xhash', { ...meta, chain: 'base' }, '0xagent')).rejects.toMatchObject({ code: 'GAS_SPONSOR_UNAVAILABLE', reason: 'chain' });
  });
});

describe('holdsReservation', () => {
  it('is true only for the agent holding the reserved submit', async () => {
    store.getReservation.mockResolvedValue({ status: 'reserved', agentWallet: '0xagent' });
    expect(await holdsReservation('0xhash', '0xAGENT')).toBe(true);
    expect(await holdsReservation('0xhash', '0xother')).toBe(false);
    store.getReservation.mockResolvedValue({ status: 'used', agentWallet: '0xagent' });
    expect(await holdsReservation('0xhash', '0xagent')).toBe(false);
  });
});
