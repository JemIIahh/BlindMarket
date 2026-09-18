import type { BlindEscrowClient, OnChainTask, TaskRegistryClient } from '../chain/index.js';
import { aesDecrypt, eciesDecrypt, sealEvidence } from '../crypto/index.js';
import type { EventBus, SdkEvents } from '../events/index.js';
import type { Signer } from '../signer/index.js';
import type { Storage } from '../storage/index.js';
import type { Hex, RootHash, TaskId, TxReceiptLike } from '../types.js';

export interface WorkerDeps {
  escrow: BlindEscrowClient;
  registry: TaskRegistryClient;
  storage: Storage;
  signer: Signer;
  events?: EventBus<SdkEvents>;
}

export interface DecryptInstructionsInput {
  /** ECIES-wrapped AES key delivered out-of-band by the agent (e.g. via the backend API). */
  wrappedKey: Uint8Array;
  /** Worker's private key, hex with or without 0x prefix. */
  workerPrivKey: string;
  /** Storage root hash from the on-chain task metadata. */
  taskHash: RootHash;
}

export interface SubmitEvidenceInput {
  taskId: TaskId;
  evidence: string | Uint8Array;
  /** Agent's uncompressed secp256k1 pubkey (retrieved via the backend or chain). */
  agentPubKey: string;
  /** TEE enclave pubkey for Sealed Inference (from 0G Compute broker). */
  enclavePubKey: string;
}

export interface SubmitEvidenceResult {
  rootHash: RootHash;
  txHash: Hex;
  receipt: TxReceiptLike;
}

/**
 * Worker-side flows: browse open tasks, decrypt assigned instructions, seal
 * evidence for agent + TEE, and claim payment after the deadline if
 * verification stalls. Peer pubkeys and wrapped keys are passed explicitly;
 * the SDK does not assume a specific message-passing substrate.
 */
export class Worker {
  constructor(private readonly deps: WorkerDeps) {}

  async browse(offset: bigint, limit: bigint): Promise<TaskId[]> {
    return this.deps.registry.getOpenTasks(offset, limit);
  }

  async getTaskDetail(taskId: TaskId): Promise<OnChainTask> {
    return this.deps.escrow.getTask(taskId);
  }

  async decryptInstructions(input: DecryptInstructionsInput): Promise<Uint8Array> {
    const aesKey = await eciesDecrypt(input.wrappedKey, input.workerPrivKey);
    const ciphertext = await this.deps.storage.download(input.taskHash);
    return aesDecrypt(ciphertext, aesKey);
  }

  async submitEvidence(input: SubmitEvidenceInput): Promise<SubmitEvidenceResult> {
    const evidenceBytes = typeof input.evidence === 'string'
      ? new TextEncoder().encode(input.evidence)
      : input.evidence;

    const { envelope } = await sealEvidence({
      evidence: evidenceBytes,
      agentPubKey: input.agentPubKey,
      enclavePubKey: input.enclavePubKey,
    });

    const uploaded = await this.deps.storage.upload(envelope);
    const rootHash = uploaded.rootHash;

    const receipt = await this.deps.escrow.submitEvidence(input.taskId, rootHash);

    this.deps.events?.emit('evidence.submitted', {
      taskId: input.taskId,
      rootHash,
      txHash: receipt.hash,
    });

    return { rootHash, txHash: receipt.hash, receipt };
  }

  /**
   * Reclaim escrow after the deadline if completeVerification was never called.
   * BlindEscrow.claimTimeout is `onlyAgent`: only the POSTER can call it, and it
   * refunds the poster the full escrowed amount — the worker is paid nothing on
   * a timeout (the 90% worker / 10% platform split applies only to a passed
   * verification). Called from a worker wallet this reverts.
   */
  async claimTimeout(taskId: TaskId): Promise<TxReceiptLike> {
    const receipt = await this.deps.escrow.claimTimeout(taskId);
    this.deps.events?.emit('payment.claimed', { taskId, txHash: receipt.hash, amount: 0n });
    return receipt;
  }
}
