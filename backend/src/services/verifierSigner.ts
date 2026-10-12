/**
 * The verifier signer of each settlement chain, for everything that sends as
 * it: settlement (a2aSettlement.ts) and the open-task judge
 * (openSubmissionJudge.ts). Every transaction one signer sends goes through
 * the one queue (serialTxQueue.ts), or two senders race for a nonce.
 */

import type { Contract } from 'ethers';
import { chainRuntime } from './chainRuntime.js';
import { createSerialTxQueue } from './serialTxQueue.js';
import type { TaskChain } from './taskChain.js';

export type TxQueue = <T>(fn: () => Promise<T>) => Promise<T>;

/** One queue per chain's signer, created on first use. */
const queues = new Map<TaskChain, TxQueue>();

export function verifierQueue(chain: TaskChain): TxQueue {
  let queue = queues.get(chain);
  if (!queue) {
    queue = createSerialTxQueue();
    queues.set(chain, queue);
  }
  return queue;
}

/**
 * The escrow on `chain` connected as its verifier signer, with the signer's
 * queue and lowercase address. null when the chain has no signer configured.
 */
export async function verifierSignerFor(chain: TaskChain): Promise<{ escrow: Contract; enqueue: TxQueue; address: string } | null> {
  const { escrowAsMarketplace, marketplaceSigner } = chainRuntime(chain);
  if (!escrowAsMarketplace || !marketplaceSigner) return null;
  return { escrow: escrowAsMarketplace, enqueue: verifierQueue(chain), address: (await marketplaceSigner.getAddress()).toLowerCase() };
}
