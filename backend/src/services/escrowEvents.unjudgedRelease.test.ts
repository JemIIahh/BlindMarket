import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The worker's releaseUnjudgedWork pays out escalated work nobody ruled on
 * (security audit run 1, C18). It emits UnjudgedWorkReleased, not
 * DisputeResolved, so each chain's dispute scan must pick it up and credit the
 * worker like a ruling in its favour; otherwise the payout never reaches the
 * off-chain earnings and the task stays open for the resume and verifier loops.
 */

const HEAD = 10_000;

const { chain, store, handleDisputeResolved } = vi.hoisted(() => {
  const escrowMock = () => ({
    filters: {
      TaskCreated: vi.fn(() => 'task-created'),
      DisputeResolved: vi.fn(() => 'dispute-resolved'),
      UnjudgedWorkReleased: vi.fn(() => 'unjudged-released'),
    },
    queryFilter: vi.fn(),
  });
  return {
    store: new Map<string, string>(),
    handleDisputeResolved: vi.fn(async (_chain: string, _taskId: bigint, _workerFavored: boolean) => {}),
    chain: {
      baseProvider: { getBlockNumber: vi.fn() },
      arcProvider: { getBlockNumber: vi.fn() },
      baseEscrow: escrowMock(),
      arcEscrow: escrowMock(),
    },
  };
});

vi.mock('./chain.js', () => chain);
vi.mock('./redis.js', () => ({
  redis: {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string, mode?: string) => {
      if (mode === 'NX' && store.has(k)) return null;
      store.set(k, v);
      return 'OK';
    }),
    pipeline: vi.fn(() => ({ set: vi.fn(), exec: vi.fn(async () => []) })),
  },
}));
vi.mock('./deploymentIdentity.js', () => ({ backgroundWritesAllowed: () => true }));
vi.mock('./escrowFingerprint.js', () => ({ checkEscrowFingerprint: vi.fn(async () => {}) }));
vi.mock('./disputeListener.js', () => ({ handleDisputeResolved, retryParkedDisputes: vi.fn(async () => {}) }));

const { pollBaseEscrowOnce } = await import('./baseEscrowEvents.js');
const { pollArcEscrowOnce } = await import('./arcEscrowEvents.js');

const ruling = (taskId: bigint, workerFavored: boolean) => ({ args: { taskId, workerFavored } });
const release = (taskId: bigint) => ({ args: { taskId, workerPayout: 900n, platformFee: 100n } });

beforeEach(() => {
  vi.clearAllMocks();
  handleDisputeResolved.mockReset().mockResolvedValue(undefined);
  store.clear();
  for (const [key, esc, prov] of [
    ['base', chain.baseEscrow, chain.baseProvider],
    ['arc', chain.arcEscrow, chain.arcProvider],
  ] as const) {
    // An existing deployment: tasks indexed to HEAD-10, rulings to HEAD-20.
    store.set(`${key}:events:checkpoint`, String(HEAD - 10));
    store.set(`${key}:events:dispute-checkpoint`, String(HEAD - 20));
    prov.getBlockNumber.mockResolvedValue(HEAD);
    esc.queryFilter.mockImplementation(async (filter: string) =>
      filter === 'dispute-resolved' ? [ruling(4n, false)] : filter === 'unjudged-released' ? [release(5n)] : []);
  }
});

describe.each([
  ['base', () => pollBaseEscrowOnce(), chain.baseEscrow],
  ['arc', () => pollArcEscrowOnce(), chain.arcEscrow],
] as const)('%s dispute scan', (name, poll, esc) => {
  it('credits the worker for released unjudged work, alongside ordinary rulings', async () => {
    await poll();
    expect(esc.queryFilter).toHaveBeenCalledWith('unjudged-released', HEAD - 19, HEAD - 5);
    expect(handleDisputeResolved).toHaveBeenCalledWith(name, 4n, false);
    expect(handleDisputeResolved).toHaveBeenCalledWith(name, 5n, true);
    expect(store.get(`${name}:events:dispute-checkpoint`)).toBe(String(HEAD - 5));
  });

  it('keeps the checkpoint when a release fails, so the scan retries it', async () => {
    handleDisputeResolved.mockImplementation(async (_c: string, taskId: bigint) => {
      if (taskId === 5n) throw new Error('credit failed');
    });
    await poll();
    expect(store.get(`${name}:events:dispute-checkpoint`)).toBe(String(HEAD - 20));
  });
});
