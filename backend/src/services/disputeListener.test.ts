/**
 * DisputeResolved → off-chain accounting, for both chains.
 *
 * Base had no listener, so a dispute ruled for the worker paid them on-chain
 * but never reached their earnings. These tests pin the shared handler: the
 * hash comes from the task's own record, a smart-account worker is credited
 * to its owner, a ruling on the other chain's copy of a hash is ignored, an
 * event is processed once however often it is seen, and a failing event is
 * retried, parked once it has failed for long enough, and retried from the
 * park until it succeeds.
 *
 * Run: npx vitest run src/services/disputeListener.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { store, hashes, redis, getTaskOn, a2aStore, loadAgentBySmartAccount, notifyLifecycle, payout } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  const hash = (k: string) => {
    if (!hashes.has(k)) hashes.set(k, new Map());
    return hashes.get(k)!;
  };
  return {
    store,
    hashes,
    redis: {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string, mode?: string) => {
        if (mode === 'NX' && store.has(k)) return null;
        store.set(k, v);
        return 'OK';
      }),
      del: vi.fn(async (k: string) => Number(store.delete(k)) + Number(hashes.delete(k))),
      exists: vi.fn(async (k: string) => Number(store.has(k) || hashes.has(k))),
      expire: vi.fn(async () => 1),
      hincrby: vi.fn(async (k: string, f: string, by: number) => {
        const n = Number(hash(k).get(f) ?? 0) + by;
        hash(k).set(f, String(n));
        return n;
      }),
      hsetnx: vi.fn(async (k: string, f: string, v: string) => {
        if (hash(k).has(f)) return 0;
        hash(k).set(f, v);
        return 1;
      }),
      hget: vi.fn(async (k: string, f: string) => hashes.get(k)?.get(f) ?? null),
      hset: vi.fn(async (k: string, f: string, v: string) => {
        hash(k).set(f, v);
        return 1;
      }),
      hdel: vi.fn(async (k: string, f: string) => Number(hashes.get(k)?.delete(f) ?? false)),
      hexists: vi.fn(async (k: string, f: string) => Number(hashes.get(k)?.has(f) ?? false)),
      hgetall: vi.fn(async (k: string) => Object.fromEntries(hashes.get(k) ?? [])),
    },
    getTaskOn: vi.fn(),
    a2aStore: { getMeta: vi.fn(), updateState: vi.fn() },
    loadAgentBySmartAccount: vi.fn(),
    notifyLifecycle: vi.fn(async () => {}),
    payout: { recordWorkerPayout: vi.fn(), recordWorkerDispute: vi.fn() },
  };
});

vi.mock('./redis.js', () => ({ redis }));
vi.mock('./escrow.js', () => ({ getTaskOn }));
vi.mock('./a2aStore.js', () => a2aStore);
vi.mock('./deployedAgentStore.js', () => ({ loadAgentBySmartAccount }));
vi.mock('./notificationStore.js', () => ({ notifyLifecycle }));
vi.mock('./workerPayout.js', () => payout);

const HASH = '0x' + 'ab'.repeat(32);
const SMART_ACCOUNT = '0x5555555555555555555555555555555555555555';
const OWNER = '0x0b34000000000000000000000000000000000001';
const WORKER_EOA = '0x7777777777777777777777777777777777777777';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const NATIVE = '0x0000000000000000000000000000000000000000';
const ZERO = '0x0000000000000000000000000000000000000000';
const MINUTE = 60_000;
// Test clock origin. Real failure times are never 0.
const T0 = 1_700_000_000_000;

// Fresh module per test: the parked-retry throttle is module state.
let listener: typeof import('./disputeListener.js');

const COMPLETED = 4;
const CANCELLED = 5;

/** The task as a ruling leaves it: Completed by default (worker paid). */
function onChain(worker: string, extra: Record<string, unknown> = {}) {
  getTaskOn.mockResolvedValue({
    taskId: '7',
    // Mixed case: the handler keys everything on the lowercased hash.
    taskHash: HASH.toUpperCase().replace('0X', '0x'),
    worker,
    token: USDC,
    amount: 5_000_000n,
    status: COMPLETED,
    ...extra,
  });
}

const parkedOn = (chain: 'base' | '0g') => hashes.get(chain === 'base' ? 'base:dispute-parked' : 'a2a:dispute-parked');

beforeEach(async () => {
  vi.clearAllMocks();
  store.clear();
  hashes.clear();
  a2aStore.getMeta.mockResolvedValue({ taskId: HASH, chain: 'base' });
  a2aStore.updateState.mockResolvedValue(undefined);
  loadAgentBySmartAccount.mockResolvedValue(null);
  payout.recordWorkerPayout.mockReset().mockResolvedValue(undefined);
  payout.recordWorkerDispute.mockReset().mockResolvedValue(undefined);
  vi.resetModules();
  listener = await import('./disputeListener.js');
});

describe('a ruling for the worker', () => {
  it('credits a Base smart account to the agent that owns it, in USDC', async () => {
    onChain(SMART_ACCOUNT);
    loadAgentBySmartAccount.mockResolvedValue({ walletAddress: OWNER, smartAccountAddress: SMART_ACCOUNT });

    await listener.handleDisputeResolved('base', 7n, true);

    expect(getTaskOn).toHaveBeenCalledWith('base', 7);
    expect(payout.recordWorkerPayout).toHaveBeenCalledOnce();
    const [hash, executor, id, amount, settlement, opts] = payout.recordWorkerPayout.mock.calls[0];
    expect({ hash, executor, id, amount, settlement }).toEqual({
      hash: HASH, executor: OWNER, id: '7', amount: 5_000_000n, settlement: { chain: 'base', token: USDC },
    });
    expect(opts).toMatchObject({ rethrow: true });
    expect(notifyLifecycle).toHaveBeenCalledWith(HASH, 'completed');
    expect(a2aStore.updateState).toHaveBeenCalledWith(HASH, { status: 'verified' });
  });

  it('credits a worker that is not a smart account as itself, on 0G', async () => {
    a2aStore.getMeta.mockResolvedValue({ taskId: HASH, chain: '0g' });
    onChain(WORKER_EOA, { token: NATIVE, amount: 10n ** 18n });

    await listener.handleDisputeResolved('0g', 7n, true);

    expect(getTaskOn).toHaveBeenCalledWith('0g', 7);
    const [hash, executor, , amount, settlement] = payout.recordWorkerPayout.mock.calls[0];
    expect({ hash, executor, amount, settlement }).toEqual({
      hash: HASH, executor: WORKER_EOA, amount: 10n ** 18n, settlement: { chain: '0g', token: NATIVE },
    });
  });

  it('still credits a task this backend never indexed', async () => {
    a2aStore.getMeta.mockResolvedValue(undefined);
    onChain(WORKER_EOA);
    await listener.handleDisputeResolved('base', 7n, true);
    expect(payout.recordWorkerPayout).toHaveBeenCalledOnce();
  });

  it('retries when the owner lookup fails, rather than crediting the smart account', async () => {
    onChain(SMART_ACCOUNT);
    loadAgentBySmartAccount.mockRejectedValueOnce(new Error('db down'));
    await expect(listener.handleDisputeResolved('base', 7n, true)).rejects.toThrow('db down');
    expect(payout.recordWorkerPayout).not.toHaveBeenCalled();
  });
});

describe('a ruling for the poster', () => {
  it('records one dispute against the owner', async () => {
    onChain(SMART_ACCOUNT, { status: CANCELLED });
    loadAgentBySmartAccount.mockResolvedValue({ walletAddress: OWNER, smartAccountAddress: SMART_ACCOUNT });

    await listener.handleDisputeResolved('base', 7n, false);

    expect(payout.recordWorkerDispute).toHaveBeenCalledWith(HASH, OWNER, { rethrow: true });
    expect(payout.recordWorkerPayout).not.toHaveBeenCalled();
    expect(notifyLifecycle).toHaveBeenCalledWith(HASH, 'disputed');
    expect(a2aStore.updateState).toHaveBeenCalledWith(HASH, { status: 'failed' });
  });

  it('records the dispute on the retry when the first write failed', async () => {
    onChain(WORKER_EOA, { status: CANCELLED });
    payout.recordWorkerDispute.mockRejectedValueOnce(new Error('db down'));

    await expect(listener.handleDisputeResolved('base', 7n, false)).rejects.toThrow('db down');
    await listener.handleDisputeResolved('base', 7n, false);

    expect(payout.recordWorkerDispute).toHaveBeenCalledTimes(2);
    expect(store.get(`a2a:dispute-recorded:${HASH}`)).toBe(WORKER_EOA);
  });
});

describe('an event seen again', () => {
  it('is not processed twice, so the parties are notified once', async () => {
    onChain(WORKER_EOA, { status: CANCELLED });
    await listener.handleDisputeResolved('base', 7n, false);
    await listener.handleDisputeResolved('base', 7n, false);

    expect(getTaskOn).toHaveBeenCalledOnce();
    expect(notifyLifecycle).toHaveBeenCalledOnce();
    expect(payout.recordWorkerDispute).toHaveBeenCalledOnce();
  });

  it('is tracked per chain: the same task id on the other chain is a different event', async () => {
    a2aStore.getMeta.mockResolvedValue(undefined);
    onChain(WORKER_EOA);
    await listener.handleDisputeResolved('base', 7n, true);
    await listener.handleDisputeResolved('0g', 7n, true);
    expect(getTaskOn).toHaveBeenCalledTimes(2);
  });
});

describe('events that change nothing off-chain', () => {
  it('ignores a ruling on the other chain\'s copy of the hash', async () => {
    a2aStore.getMeta.mockResolvedValue({ taskId: HASH, chain: '0g' });
    onChain(WORKER_EOA);

    await listener.handleDisputeResolved('base', 7n, true);

    expect(payout.recordWorkerPayout).not.toHaveBeenCalled();
    expect(notifyLifecycle).not.toHaveBeenCalled();
    expect(a2aStore.updateState).not.toHaveBeenCalled();
  });

  it.each([
    ['for the worker', true, CANCELLED],
    ['for the poster', false, COMPLETED],
    ['for the worker', true, 1],
  ])('skips a ruling %s when the task is not in the state that ruling leaves (status %i)', async (_, favored, status) => {
    onChain(WORKER_EOA, { status });
    await listener.handleDisputeResolved('base', 7n, favored as boolean);
    expect(a2aStore.getMeta).not.toHaveBeenCalled();
    expect(payout.recordWorkerPayout).not.toHaveBeenCalled();
    expect(payout.recordWorkerDispute).not.toHaveBeenCalled();
    expect(a2aStore.updateState).not.toHaveBeenCalled();
  });

  it('retries, rather than skips, a task that still reads as Disputed (a node behind the ruling)', async () => {
    onChain(WORKER_EOA, { status: 6 });
    await expect(listener.handleDisputeResolved('base', 7n, true, T0)).rejects.toThrow('still reads as Disputed');
    expect(store.has('base:dispute-done:7')).toBe(false);
    expect(payout.recordWorkerPayout).not.toHaveBeenCalled();

    onChain(WORKER_EOA);
    await listener.handleDisputeResolved('base', 7n, true, T0 + 5_000);
    expect(payout.recordWorkerPayout).toHaveBeenCalledOnce();
    expect(store.has('base:dispute-done:7')).toBe(true);
  });

  it('skips a task id with no task on-chain', async () => {
    onChain(ZERO, { taskHash: '0x' + '0'.repeat(64) });
    await listener.handleDisputeResolved('base', 7n, true);
    expect(a2aStore.getMeta).not.toHaveBeenCalled();
    expect(a2aStore.updateState).not.toHaveBeenCalled();
  });

  it('credits nobody when the task has no worker, but still closes it', async () => {
    onChain(ZERO, { status: CANCELLED });
    await listener.handleDisputeResolved('base', 7n, false);
    expect(payout.recordWorkerDispute).not.toHaveBeenCalled();
    expect(loadAgentBySmartAccount).not.toHaveBeenCalled();
    expect(a2aStore.updateState).toHaveBeenCalledWith(HASH, { status: 'failed' });
  });
});

describe('closing the off-chain state', () => {
  it('accepts a task with no A2A state', async () => {
    onChain(WORKER_EOA);
    a2aStore.updateState.mockRejectedValue(new Error(`No A2A state for task ${HASH}`));
    await expect(listener.handleDisputeResolved('base', 7n, true)).resolves.toBeUndefined();
  });

  it('retries when the state write fails for another reason', async () => {
    onChain(WORKER_EOA);
    a2aStore.updateState.mockRejectedValue(new Error('redis timeout'));
    await expect(listener.handleDisputeResolved('base', 7n, true)).rejects.toThrow('redis timeout');
  });
});

describe('an event that keeps failing', () => {
  /** Fail `times` times, `gapMs` apart, starting at `start`. Returns the last time used. */
  async function failRepeatedly(times: number, gapMs: number, start = T0): Promise<number> {
    let now = start;
    for (let i = 0; i < times; i++) {
      now = start + i * gapMs;
      await expect(listener.handleDisputeResolved('base', 7n, true, now)).rejects.toThrow('DisputeResolved base taskId=7: ledger down');
    }
    return now;
  }

  beforeEach(() => {
    onChain(WORKER_EOA);
    payout.recordWorkerPayout.mockRejectedValue(new Error('ledger down'));
  });

  it('is not parked by a burst of attempts, however many', async () => {
    await failRepeatedly(50, 1_000);
    expect(parkedOn('base')).toBeUndefined();
  });

  it('is not parked on time alone', async () => {
    await failRepeatedly(listener.PARK_MIN_ATTEMPTS - 1, MINUTE);
    expect(parkedOn('base')).toBeUndefined();
  });

  it('is parked once it has failed often enough for long enough, and then skipped', async () => {
    await failRepeatedly(listener.PARK_MIN_ATTEMPTS - 1, 30_000);
    await expect(listener.handleDisputeResolved('base', 7n, true, T0 + listener.PARK_MIN_FAILING_MS)).resolves.toBeUndefined();

    const parked = JSON.parse(parkedOn('base')!.get('7')!);
    expect(parked).toMatchObject({ workerFavored: true, attempts: listener.PARK_MIN_ATTEMPTS, error: 'ledger down', retries: 0 });
    expect(hashes.has('base:dispute-attempts:7')).toBe(false);

    // Seen again (a later event in its chunk failed): skipped at once.
    getTaskOn.mockClear();
    await expect(listener.handleDisputeResolved('base', 7n, true, T0 + listener.PARK_MIN_FAILING_MS + 1)).resolves.toBeUndefined();
    expect(getTaskOn).not.toHaveBeenCalled();
  });

  it('does not treat a missing first-failure time as an old failure', async () => {
    // The first-failure time was never stored (hsetnx lost), so it reads as 0.
    const hsetnx = redis.hsetnx.getMockImplementation()!;
    redis.hsetnx.mockImplementation(async () => 0);
    try {
      for (let i = 0; i < listener.PARK_MIN_ATTEMPTS + 2; i++) {
        await expect(listener.handleDisputeResolved('base', 7n, true, T0 + i)).rejects.toThrow();
      }
      expect(parkedOn('base')).toBeUndefined();
    } finally {
      redis.hsetnx.mockImplementation(hsetnx);
    }
  });

  it('never parks when Redis fails while counting', async () => {
    redis.hincrby.mockRejectedValueOnce(new Error('redis down'));
    await expect(listener.handleDisputeResolved('base', 7n, true, T0 + 10 * MINUTE)).rejects.toThrow('redis down');
    expect(parkedOn('base')).toBeUndefined();
  });

  it('starts counting again after a success', async () => {
    await failRepeatedly(3, MINUTE);
    payout.recordWorkerPayout.mockResolvedValue(undefined);
    await listener.handleDisputeResolved('base', 7n, true, T0 + 3 * MINUTE);
    expect(hashes.has('base:dispute-attempts:7')).toBe(false);
    expect(store.has('base:dispute-done:7')).toBe(true);
  });

  it('lets a chunk with several failing rulings through once each has been parked', async () => {
    // Rulings 7, 8, 9 all fail; a scan processes them in order and stops at
    // the first failure, like the indexers do.
    const scan = async (now: number) => {
      for (const id of [7n, 8n, 9n]) await listener.handleDisputeResolved('base', id, true, now);
    };
    let scans = 0;
    let now = T0;
    for (; scans < 200; scans++, now += 30_000) {
      try {
        await scan(now);
        break;
      } catch {
        // retried on the next scan
      }
    }
    expect([...parkedOn('base')!.keys()].sort()).toEqual(['7', '8', '9']);
    // Each ruling costs about PARK_MIN_FAILING_MS, not a multiple of the others.
    expect(now - T0).toBeLessThanOrEqual(3 * (listener.PARK_MIN_FAILING_MS + 30_000));
  });
});

describe('retrying parked rulings', () => {
  function park(chain: 'base' | '0g', id: string, workerFavored = true, retries = 0) {
    const key = chain === 'base' ? 'base:dispute-parked' : 'a2a:dispute-parked';
    if (!hashes.has(key)) hashes.set(key, new Map());
    hashes.get(key)!.set(id, JSON.stringify({ workerFavored, attempts: 10, firstFailedAt: 'x', parkedAt: 'y', error: 'old', retries }));
  }

  it('processes a parked ruling that now succeeds and unparks it', async () => {
    onChain(WORKER_EOA);
    park('base', '7');

    await listener.retryParkedDisputes('base', 0);

    expect(payout.recordWorkerPayout).toHaveBeenCalledOnce();
    expect(parkedOn('base')!.has('7')).toBe(false);
    expect(store.has('base:dispute-done:7')).toBe(true);
  });

  it('keeps a ruling that still fails, counting the retry', async () => {
    onChain(WORKER_EOA);
    payout.recordWorkerPayout.mockRejectedValue(new Error('still down'));
    park('base', '7', true, 2);

    await expect(listener.retryParkedDisputes('base', 0)).resolves.toBeUndefined();

    expect(JSON.parse(parkedOn('base')!.get('7')!)).toMatchObject({ retries: 3, error: 'still down' });
  });

  it('runs at most once per interval per chain', async () => {
    onChain(WORKER_EOA);
    payout.recordWorkerPayout.mockRejectedValue(new Error('still down'));
    park('base', '7');
    a2aStore.getMeta.mockResolvedValue(undefined);
    park('0g', '7');

    await listener.retryParkedDisputes('base', 0);
    await listener.retryParkedDisputes('base', listener.PARKED_RETRY_MS - 1);
    await listener.retryParkedDisputes('0g', 1);
    expect(getTaskOn).toHaveBeenCalledTimes(2);

    await listener.retryParkedDisputes('base', listener.PARKED_RETRY_MS);
    expect(getTaskOn).toHaveBeenCalledTimes(3);
  });

  it('unparks without reprocessing a ruling already marked done', async () => {
    onChain(WORKER_EOA);
    park('base', '7');
    store.set('base:dispute-done:7', '1');

    await listener.retryParkedDisputes('base', 0);

    expect(getTaskOn).not.toHaveBeenCalled();
    expect(parkedOn('base')!.has('7')).toBe(false);
  });

  it('never throws when Redis cannot be read', async () => {
    redis.hgetall.mockRejectedValueOnce(new Error('redis down'));
    await expect(listener.retryParkedDisputes('base', 0)).resolves.toBeUndefined();
  });
});
