/**
 * Serialised sending for one signer, used by the A2A settlement bridge
 * (a2aSettlement.ts) and the gas-sponsor relayer (gasSponsorRelayer.ts).
 *
 * Each queue serialises the signer's transactions through MINING, not just
 * through broadcast. Serialising broadcasts alone is not enough: the signer
 * reads its nonce from the RPC's pending view, and Base Sepolia has served a
 * stale pending nonce for a tx broadcast a moment earlier — two /accept calls
 * one second apart both got nonce N and the second failed with "replacement
 * fee too low" (three agents racing two tasks on 0xa1F7…, task 6). So the
 * next send waits for the previous tx's receipt, and a nonce collision that
 * slips through anyway is retried once after the mempool settles.
 */
const NONCE_RETRY_DELAY_MS = 3_000;
// How long the queue waits for a broadcast tx to mine before letting the next
// send through. ethers' wait() has NO timer unless one is given, and a tx
// evicted from a public RPC's pool never resolves — which would freeze every
// later settlement on that chain until a restart. After the timeout the next
// send proceeds; if the RPC still hands out the old nonce, the collision retry
// covers it.
export const HOLD_TIMEOUT_MS = 60_000;

export function isNonceCollision(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  const msg = e?.message ?? '';
  return (
    e?.code === 'NONCE_EXPIRED' ||
    e?.code === 'REPLACEMENT_UNDERPRICED' ||
    // NOT "already known": that means the identical signed tx is already in
    // the pool, i.e. the first broadcast succeeded — re-sending would mint a
    // second tx at nonce N+1 that reverts InvalidStatus.
    /replacement fee too low|replacement transaction underpriced|nonce too low/i.test(msg)
  );
}

type Waitable = { wait?: (confirms?: number, timeoutMs?: number) => Promise<unknown> } | null | undefined;

export function createSerialTxQueue(opts: { retryDelayMs?: number } = {}): <T>(fn: () => Promise<T>) => Promise<T> {
  const retryDelayMs = opts.retryDelayMs ?? NONCE_RETRY_DELAY_MS;
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const send = async (): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        if (!isNonceCollision(err)) throw err;
        console.warn(`[txQueue] nonce collision (${(err as Error).message?.slice(0, 60)}) — retrying once in ${retryDelayMs}ms`);
        await new Promise((r) => setTimeout(r, retryDelayMs));
        return await fn();
      }
    };
    const next = queue.then(send, send);
    // Hold the queue until this tx is mined (or fails), so the next send reads
    // a nonce the RPC has already advanced. The caller gets the tx as soon as
    // it is broadcast and runs its own wait().
    queue = next.then(
      (tx) => {
        const w = (tx as Waitable)?.wait;
        return w ? Promise.resolve(w.call(tx, 1, HOLD_TIMEOUT_MS)).catch(() => undefined) : undefined;
      },
      () => undefined,
    );
    return next;
  };
}
