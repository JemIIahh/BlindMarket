/**
 * DisputeResolved → off-chain accounting, for both chains.
 *
 * Base had no listener, so a dispute ruled for the worker paid them on-chain
 * but never reached their earnings. These tests pin the shared handler: the
 * hash comes from the task's own record, a smart-account worker is credited
 * to its owner, a ruling on the other chain's copy of a hash is ignored, and
 * a failing event is retried, then parked so it can't hold a checkpoint.
 *
 * Run: npx vitest run src/services/disputeListener.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { store, redis, getTaskOn, a2aStore, loadAgentBySmartAccount, notifyLifecycle, payout } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  return {
    store,
    redis: {
      hashes,
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string, mode?: string) => {
        if (mode === 'NX' && store.has(k)) return null;
        store.set(k, v);
        return 'OK';
      }),
      del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
      incr: vi.fn(async (k: string) => {
        const n = Number(store.get(k) ?? 0) + 1;
        store.set(k, String(n));
        return n;
      }),
      expire: vi.fn(async () => 1),
      hset: vi.fn(async (k: string, field: string, v: string) => {
        if (!hashes.has(k)) hashes.set(k, new Map());
        hashes.get(k)!.set(field, v);
        return 1;
      }),
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

const { handleDisputeResolved, MAX_DISPUTE_ATTEMPTS } = await import('./disputeListener.js');

const HASH = '0x' + 'ab'.repeat(32);
const SMART_ACCOUNT = '0x5555555555555555555555555555555555555555';
const OWNER = '0x0b34000000000000000000000000000000000001';
const WORKER_EOA = '0x7777777777777777777777777777777777777777';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const NATIVE = '0x0000000000000000000000000000000000000000';
const ZERO = '0x0000000000000000000000000000000000000000';

function onChain(worker: string, extra: Record<string, unknown> = {}) {
  getTaskOn.mockResolvedValue({
    taskId: '7',
    // Mixed case: the handler keys everything on the lowercased hash.
    taskHash: HASH.toUpperCase().replace('0X', '0x'),
    worker,
    token: USDC,
    amount: 5_000_000n,
    ...extra,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  redis.hashes.clear();
  a2aStore.getMeta.mockResolvedValue({ taskId: HASH, chain: 'base' });
  a2aStore.updateState.mockResolvedValue(undefined);
  loadAgentBySmartAccount.mockResolvedValue(null);
  payout.recordWorkerPayout.mockResolvedValue(undefined);
  payout.recordWorkerDispute.mockResolvedValue(undefined);
});

describe('a ruling for the worker', () => {
  it('credits a Base smart account to the agent that owns it, in USDC', async () => {
    onChain(SMART_ACCOUNT);
    loadAgentBySmartAccount.mockResolvedValue({ walletAddress: OWNER, smartAccountAddress: SMART_ACCOUNT });

    await handleDisputeResolved('base', 7n, true);

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

    await handleDisputeResolved('0g', 7n, true);

    expect(getTaskOn).toHaveBeenCalledWith('0g', 7);
    const [hash, executor, , amount, settlement] = payout.recordWorkerPayout.mock.calls[0];
    expect({ hash, executor, amount, settlement }).toEqual({
      hash: HASH, executor: WORKER_EOA, amount: 10n ** 18n, settlement: { chain: '0g', token: NATIVE },
    });
  });

  it('still credits a task this backend never indexed', async () => {
    a2aStore.getMeta.mockResolvedValue(undefined);
    onChain(WORKER_EOA);
    await handleDisputeResolved('base', 7n, true);
    expect(payout.recordWorkerPayout).toHaveBeenCalledOnce();
  });
});

describe('a ruling for the poster', () => {
  it('records one dispute against the owner, however often the event is seen', async () => {
    onChain(SMART_ACCOUNT);
    loadAgentBySmartAccount.mockResolvedValue({ walletAddress: OWNER, smartAccountAddress: SMART_ACCOUNT });

    await handleDisputeResolved('base', 7n, false);
    await handleDisputeResolved('base', 7n, false);

    expect(payout.recordWorkerDispute).toHaveBeenCalledOnce();
    expect(payout.recordWorkerDispute).toHaveBeenCalledWith(HASH, OWNER, { rethrow: true });
    expect(payout.recordWorkerPayout).not.toHaveBeenCalled();
    expect(notifyLifecycle).toHaveBeenCalledWith(HASH, 'disputed');
    expect(a2aStore.updateState).toHaveBeenCalledWith(HASH, { status: 'failed' });
  });

  it('records the dispute on the retry when the first write failed', async () => {
    onChain(WORKER_EOA);
    payout.recordWorkerDispute.mockRejectedValueOnce(new Error('db down'));

    await expect(handleDisputeResolved('base', 7n, false)).rejects.toThrow('db down');
    await handleDisputeResolved('base', 7n, false);

    expect(payout.recordWorkerDispute).toHaveBeenCalledTimes(2);
    expect(store.get(`a2a:dispute-recorded:${HASH}`)).toBe(WORKER_EOA);
  });
});

describe('events that change nothing off-chain', () => {
  it('ignores a ruling on the other chain\'s copy of the hash', async () => {
    a2aStore.getMeta.mockResolvedValue({ taskId: HASH, chain: '0g' });
    onChain(WORKER_EOA);

    await handleDisputeResolved('base', 7n, true);

    expect(payout.recordWorkerPayout).not.toHaveBeenCalled();
    expect(notifyLifecycle).not.toHaveBeenCalled();
    expect(a2aStore.updateState).not.toHaveBeenCalled();
  });

  it('skips a task id with no task on-chain', async () => {
    onChain(ZERO, { taskHash: '0x' + '0'.repeat(64) });
    await handleDisputeResolved('base', 7n, true);
    expect(a2aStore.getMeta).not.toHaveBeenCalled();
    expect(a2aStore.updateState).not.toHaveBeenCalled();
  });

  it('credits nobody when the task has no worker, but still closes it', async () => {
    onChain(ZERO);
    await handleDisputeResolved('base', 7n, false);
    expect(payout.recordWorkerDispute).not.toHaveBeenCalled();
    expect(loadAgentBySmartAccount).not.toHaveBeenCalled();
    expect(a2aStore.updateState).toHaveBeenCalledWith(HASH, { status: 'failed' });
  });
});

describe('closing the off-chain state', () => {
  it('accepts a task with no A2A state', async () => {
    onChain(WORKER_EOA);
    a2aStore.updateState.mockRejectedValue(new Error(`No A2A state for task ${HASH}`));
    await expect(handleDisputeResolved('base', 7n, true)).resolves.toBeUndefined();
  });

  it('retries when the state write fails for another reason', async () => {
    onChain(WORKER_EOA);
    a2aStore.updateState.mockRejectedValue(new Error('redis timeout'));
    await expect(handleDisputeResolved('base', 7n, true)).rejects.toThrow('redis timeout');
  });
});

describe('an event that keeps failing', () => {
  it(`is retried ${MAX_DISPUTE_ATTEMPTS - 1} times, then parked`, async () => {
    onChain(WORKER_EOA);
    payout.recordWorkerPayout.mockRejectedValue(new Error('ledger down'));

    for (let i = 1; i < MAX_DISPUTE_ATTEMPTS; i++) {
      await expect(handleDisputeResolved('base', 7n, true)).rejects.toThrow('ledger down');
    }
    await expect(handleDisputeResolved('base', 7n, true)).resolves.toBeUndefined();

    const parked = JSON.parse(redis.hashes.get('a2a:dispute-parked')!.get('base:7')!);
    expect(parked).toMatchObject({ chain: 'base', taskId: '7', workerFavored: true, attempts: MAX_DISPUTE_ATTEMPTS, error: 'ledger down' });
    expect(store.has('a2a:dispute-attempts:base:7')).toBe(false);
  });

  it('starts counting again after a success', async () => {
    onChain(WORKER_EOA);
    payout.recordWorkerPayout.mockRejectedValueOnce(new Error('blip'));

    await expect(handleDisputeResolved('base', 7n, true)).rejects.toThrow('blip');
    expect(store.get('a2a:dispute-attempts:base:7')).toBe('1');

    await handleDisputeResolved('base', 7n, true);
    expect(store.has('a2a:dispute-attempts:base:7')).toBe(false);
  });

  it('counts the same task id on each chain separately', async () => {
    a2aStore.getMeta.mockResolvedValue(undefined);
    onChain(WORKER_EOA);
    payout.recordWorkerPayout.mockRejectedValue(new Error('down'));

    await expect(handleDisputeResolved('base', 7n, true)).rejects.toThrow();
    await expect(handleDisputeResolved('0g', 7n, true)).rejects.toThrow();

    expect(store.get('a2a:dispute-attempts:base:7')).toBe('1');
    expect(store.get('a2a:dispute-attempts:0g:7')).toBe('1');
  });
});
