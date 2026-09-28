import { keccak256 } from 'ethers';

/**
 * What became of a funding transaction this CLI sent, read from the chain.
 *
 * A row is saved as funded the moment its transaction is sent, and is never
 * funded again while it might land. Only proof that it never will frees it:
 *
 * - 'mined'    a receipt with status 1: the escrow is funded; list it.
 * - 'reverted' a receipt with status 0: nothing was escrowed.
 * - 'dropped'  no receipt, unknown to the node, and the sender's confirmed
 *              nonce is past the transaction's: another transaction used that
 *              nonce, so this one can never land. Nothing was escrowed.
 * - 'pending'  it may still land (in the mempool, or its nonce not used yet).
 * - 'unknown'  it cannot be told (no nonce saved, the RPC failed): treated
 *              like pending, never paid again.
 */
export type FundingState = 'mined' | 'reverted' | 'dropped' | 'pending' | 'unknown';

/** The JSON-RPC calls this needs: raw, so no response formatting can fail. */
export interface RawRpc {
  send(method: string, params: unknown[]): Promise<unknown>;
}

export interface Funding {
  txHash: string;
  nonce?: number;
  from?: string;
  /** The signed raw transaction, when it was saved: re-broadcast while its nonce is unused. */
  raw?: string;
}

export interface FundingOptions {
  /** The pause before the second receipt read that confirms a drop. */
  recheckMs?: number;
  /** How long to wait for a re-broadcast transaction's receipt, and how often to look. */
  waitMs?: number;
  pollMs?: number;
  /** Told when the saved transaction was handed to the node again. */
  onRebroadcast?: () => void;
}

const quantity = (v: unknown): bigint => BigInt(v as string);

export async function fundingState(rpc: RawRpc, f: Funding, opts: FundingOptions = {}): Promise<FundingState> {
  const latest = async () => quantity(await rpc.send('eth_getTransactionCount', [f.from, 'latest']));
  const receiptOf = async () => rpc.send('eth_getTransactionReceipt', [f.txHash]) as Promise<{ status?: string } | null>;
  // Its nonce is used and it is nowhere: ask for the receipt once more before
  // calling it dropped, so one lagging read cannot free a funded row.
  const droppedUnlessLate = async (): Promise<FundingState> => {
    await new Promise((r) => setTimeout(r, opts.recheckMs ?? 1_500));
    const again = await receiptOf();
    return again ? receiptState(again) : 'dropped';
  };
  try {
    // The nonce first: once a node has used it, a receipt it serves after is final.
    const confirmed = f.nonce !== undefined && f.from ? await latest() : undefined;
    const receipt = await receiptOf();
    if (receipt) return receiptState(receipt);
    if (await rpc.send('eth_getTransactionByHash', [f.txHash])) return 'pending';
    if (confirmed === undefined) return 'unknown';
    if (confirmed > BigInt(f.nonce!)) return await droppedUnlessLate();
    // Its nonce is unused and no node has it: nothing will ever send it, unless
    // it is sent again. The saved transaction, checked to be this very one,
    // can only land once: same nonce, same hash.
    if (!f.raw || confirmed !== BigInt(f.nonce!) || keccak256(f.raw).toLowerCase() !== f.txHash.toLowerCase()) return 'pending';
    try {
      await rpc.send('eth_sendRawTransaction', [f.raw]);
    } catch (err) {
      // Refused: something else may have taken the nonce in between.
      if (!/already known|known transaction/i.test((err as Error)?.message ?? '')) {
        return (await latest()) > BigInt(f.nonce!) ? await droppedUnlessLate() : 'pending';
      }
    }
    opts.onRebroadcast?.();
    const deadline = Date.now() + (opts.waitMs ?? 60_000);
    for (;;) {
      const landed = await receiptOf();
      if (landed) return receiptState(landed);
      if (Date.now() >= deadline) return 'pending';
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 2_000));
    }
  } catch {
    return 'unknown';
  }
}

function receiptState(receipt: { status?: string }): FundingState {
  if (receipt.status === undefined) return 'unknown';
  return quantity(receipt.status) === 1n ? 'mined' : 'reverted';
}

/** What a state means for the row, in the words the CLI prints. */
export const FUNDING_WORDS: Record<FundingState, string> = {
  mined: 'paid',
  reverted: 'its funding reverted, so nothing was paid',
  dropped: 'its funding never landed (another transaction used its nonce), so nothing was paid',
  pending: 'its funding is not confirmed yet and may still land',
  unknown: 'its funding could not be checked',
};
