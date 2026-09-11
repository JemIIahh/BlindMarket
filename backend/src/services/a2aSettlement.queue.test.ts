import { describe, it, expect, vi } from 'vitest';

vi.mock('./chain.js', () => ({ escrowAsMarketplace: null, marketplaceSigner: null, baseEscrowAsMarketplace: null, baseMarketplaceSigner: null }));
vi.mock('./a2aStore.js', () => ({}));
vi.mock('./taskChain.js', () => ({ resolveTaskByHash: vi.fn() }));
vi.mock('./escrow.js', () => ({}));
vi.mock('./reputation.js', () => ({}));
vi.mock('./redis.js', () => ({ redis: {} }));

import { createSerialTxQueue, isNonceCollision } from './a2aSettlement.js';

const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

describe('createSerialTxQueue', () => {
  it('does not start the next send until the previous tx is mined', async () => {
    const enqueue = createSerialTxQueue({ retryDelayMs: 0 });
    const mined = deferred<void>();
    const order: string[] = [];
    const first = enqueue(async () => { order.push('send1'); return { wait: () => mined.promise.then(() => order.push('mined1')) }; });
    const second = enqueue(async () => { order.push('send2'); return { wait: async () => {} }; });
    await first; // broadcast returns immediately to the caller
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(['send1']); // send2 is held while tx1 is unmined
    mined.resolve();
    await second;
    expect(order).toEqual(['send1', 'mined1', 'send2']);
  });

  it('retries a nonce collision once and surfaces any other error', async () => {
    const enqueue = createSerialTxQueue({ retryDelayMs: 0 });
    let calls = 0;
    const tx = await enqueue(async () => {
      calls++;
      if (calls === 1) throw new Error('replacement fee too low (transaction="0x02…")');
      return { wait: async () => {} };
    });
    expect(calls).toBe(2);
    expect(tx).toBeTruthy();
    await expect(enqueue(async () => { throw new Error('execution reverted: NotVerifier()'); })).rejects.toThrow('NotVerifier');
  });

  it('a failed send does not wedge the queue', async () => {
    const enqueue = createSerialTxQueue({ retryDelayMs: 0 });
    await enqueue(async () => { throw new Error('boom'); }).catch(() => {});
    const tx = await enqueue(async () => ({ wait: async () => {} }));
    expect(tx).toBeTruthy();
  });
});

describe('isNonceCollision', () => {
  it('recognises the RPC phrasings and ethers codes', () => {
    expect(isNonceCollision(new Error('replacement fee too low'))).toBe(true);
    expect(isNonceCollision(new Error('nonce too low'))).toBe(true);
    expect(isNonceCollision({ code: 'NONCE_EXPIRED', message: '' })).toBe(true);
    expect(isNonceCollision(new Error('execution reverted: DeadlineReached()'))).toBe(false);
    // "already known" = the first broadcast landed; a retry would double-send.
    expect(isNonceCollision(new Error('already known'))).toBe(false);
  });
});
