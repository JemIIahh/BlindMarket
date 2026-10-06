/**
 * The gas-sponsorship relayer (docs/AGENT-GAS-FUNDING.md, "The flow" and
 * "Operations"): it sends a hosted agent's signed escrow call through the
 * agent's EIP-7702 delegate and pays the gas, and settles reservations.
 *
 * - One writer: the process that holds a Postgres session advisory lock on a
 *   dedicated connection sends; any other refuses, and the worker falls back
 *   to its own gas.
 * - One transaction at a time (createSerialTxQueue), each held until mined.
 * - Write-ahead: every transaction is stored signed, with its nonce, before
 *   it is broadcast. recover() re-broadcasts those bytes and never signs
 *   again; a transaction whose nonce went to another is marked dropped.
 * - Before each send it re-checks the export log, the on-chain worker and
 *   status, that the task was assigned through our /accept, the deadline and
 *   the wallet's code. It simulates the exact transaction, refuses an
 *   estimate above GAS_SPONSOR_MAX_GAS, sets the gas limit to estimate ×
 *   1.15 and caps maxFeePerGas. The kill switch, the export log and the
 *   simulation are checked again once the call reaches the front of the
 *   queue, just before it is signed.
 * - Success is the escrow's own event for the task in the receipt with the
 *   wallet still delegated afterwards. A setup (authorization) that leaves no
 *   event is retried once per wallet at most.
 * - Cost is gasUsed × effectiveGasPrice, reverts included. Each call is
 *   recorded as a 'gas_sponsored' event; failures go to Sentry.
 */
import { ethers } from 'ethers';
import * as Sentry from '@sentry/node';
import type pg from 'pg';
import type { DeployedAgent } from '../types.js';
import { TaskStatus } from '../types.js';
import { chainRuntime } from './chainRuntime.js';
import { getPool } from './neonDb.js';
import { createSerialTxQueue } from './serialTxQueue.js';
import { getTaskOn, effectiveDeadlineOn } from './escrow.js';
import { recordEvent } from './analyticsService.js';
import { safeErrorMessage } from '../middleware/errorHandler.js';
import * as a2aStore from './a2aStore.js';
import {
  GAS_LIMIT_MARGIN_PERCENT,
  MAX_SETUP_ATTEMPTS,
  MIN_SECONDS_BEFORE_DEADLINE,
  RESERVATION_TTL_SECONDS,
  gasSponsorSettings,
  runnableSettings,
  type GasSponsorSettings,
} from './gasSponsorConfig.js';
import { agentEligibility, taskEligibility } from './gasSponsorEligibility.js';
import {
  closeReservation,
  getControls,
  getReservation,
  getReservationById,
  heldReservations,
  markReservationUsed,
  nextStoredNonce,
  recordSignedTx,
  reserve,
  setControls,
  settleTx,
  setTxStatus,
  setupAttempts,
  txsForReservation,
  unsettledTxs,
  usage,
  walletKeyExported,
  type Reservation,
  type SponsoredTx as SponsoredTxRecord,
} from './gasSponsorStore.js';
import { authorizationSigner, authorizationToRpc, isDelegatedTo, signSetCodeTx, type Authorization } from './eip7702.js';
import { callSigner, DelegateKind, delegateError, encodeExecute, receiptProvesCall } from './blindAgentDelegate.js';

type Enabled = Extract<GasSponsorSettings, { enabled: true }>;

const RECEIPT_POLL_MS = 1_000;
let receiptTimeoutMs = 60_000;
const SWEEP_MS = 60_000;
const WRITER_RETRY_MS = 30_000;

export interface SponsoredCallInput {
  agent: DeployedAgent;
  kind: 'submit' | 'release';
  taskId: bigint;
  /** bytes32; zero for a release. */
  evidenceHash: string;
  nonce: bigint;
  deadline: bigint;
  signature: string;
  authorization?: Authorization;
}

/**
 * ok: the call landed (ours, or the same signed call sent by someone else).
 * Otherwise a refusal, final unless code is PENDING (202): then our
 * transaction is out and may still land, so the caller must not fall back
 * to paying its own gas or hand the task back (sponsoredCallStatus says when
 * it is final).
 */
export type RelayResult =
  | { ok: true; txHash: string | null; landedElsewhere?: boolean }
  | { ok: false; status: number; code: string; message: string; txHash?: string };

/** What became of an agent's sponsored call for a task (GET /a2a/tasks/:id/sponsored-call). */
export type CallStatus =
  | { status: 'none' }
  | { status: 'pending'; txHash: string }
  | { status: 'confirmed'; txHash: string | null }
  | { status: 'failed'; txHash: string | null; reason: string };

const refuse = (status: number, code: string, message: string): RelayResult => ({ ok: false, status, code, message });
const pendingResult = (txHash: string, message: string): RelayResult => ({ ok: false, status: 202, code: 'PENDING', message, txHash });

// ── The writer ───────────────────────────────────────────────────────────────

let writer: { client: pg.PoolClient; key: string } | null = null;
const enqueue = createSerialTxQueue();

export function isSponsorWriter(): boolean {
  return writer !== null;
}

function writerKey(settings: Enabled): string {
  return `gas-sponsor-writer:${settings.chainId}:${settings.sponsor.address.toLowerCase()}`;
}

/** Take the single-writer lock for this sponsor on this chain. False when another process holds it. */
export async function acquireSponsorWriter(settings: Enabled): Promise<boolean> {
  if (writer) return true;
  const client = await (await getPool()).connect();
  const key = writerKey(settings);
  try {
    const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [key]);
    if (!rows[0]?.locked) {
      client.release();
      return false;
    }
  } catch (err) {
    client.release();
    throw err;
  }
  // A dropped connection releases the lock server-side: stop writing, and
  // release the client with the error so the pool destroys it and its slot
  // comes back. Only while it is still ours: once released, the pool owns it,
  // and a second release throws.
  client.on('error', (err) => {
    if (writer?.client !== client) return;
    writer = null;
    client.release(err);
  });
  writer = { client, key };
  return true;
}

export async function releaseSponsorWriter(): Promise<void> {
  if (!writer) return;
  const { client, key } = writer;
  writer = null;
  await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch(() => {});
  client.release();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const provider = () => chainRuntime('arc').provider;

/**
 * The wallet's code, read straight from the node. ethers answers a repeat of
 * the same getCode within 250 ms from its own cache, so the read right after
 * a fast receipt returned the pre-send '0x' and a call that worked was
 * counted as a no-op (seen in the local E2E). `block` pins the read to the
 * receipt's block.
 */
async function codeAt(wallet: string, block: string = 'latest'): Promise<string> {
  return String(await provider().send('eth_getCode', [wallet, block]));
}

function rpcErrorData(err: unknown): string | null {
  const e = err as { data?: unknown; info?: { error?: { data?: unknown } }; error?: { data?: unknown } } | null;
  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
  return typeof data === 'string' ? data : null;
}

function report(settings: Enabled, wallet: string, kind: string, taskId: bigint, outcome: string, extra: Record<string, unknown> = {}): void {
  void recordEvent({
    event: 'gas_sponsored',
    address: wallet,
    props: { chainId: settings.chainId, kind, taskId: taskId.toString(), outcome, ...extra },
  }).catch(() => {});
  if (outcome !== 'confirmed' && outcome !== 'landed_elsewhere') {
    Sentry.captureMessage(`gas sponsor: ${kind} for task ${taskId} on ${settings.chainId}: ${outcome}`, 'warning');
  }
}

/** The reservation budget: what one call can cost at most, at today's fees. */
export async function reservationBudgetWei(settings: Enabled): Promise<bigint> {
  const fee = await provider().getFeeData().catch(() => null);
  const perGas = fee?.maxFeePerGas ?? null;
  const price = perGas !== null && perGas < settings.maxFeeWei ? perGas : settings.maxFeeWei;
  return (settings.maxGas * GAS_LIMIT_MARGIN_PERCENT * price) / 100n;
}

function escrowInterface(): ethers.Interface {
  const escrow = chainRuntime('arc').escrow;
  if (!escrow) throw new Error('there is no Arc escrow contract here');
  return escrow.interface;
}

/** The escrow's task as of `block`, read straight from the node (no ethers cache). */
async function taskAt(settings: Enabled, taskId: bigint, block = 'latest'): Promise<{ status: number; evidenceHash: string }> {
  const iface = escrowInterface();
  const raw = await provider().send('eth_call', [{ to: settings.escrow, data: iface.encodeFunctionData('getTask', [taskId]) }, block]);
  const [t] = iface.decodeFunctionResult('getTask', raw);
  return { status: Number(t.status), evidenceHash: String(t.evidenceHash) };
}

/** Whether the poster escalated the task's unjudged work (claimTimeout), the precondition of releaseUnjudgedWork. */
async function escalated(settings: Enabled, taskId: bigint): Promise<boolean> {
  const iface = escrowInterface();
  const raw = await provider().send('eth_call', [{ to: settings.escrow, data: iface.encodeFunctionData('unjudgedEscalation', [taskId]) }, 'latest']);
  return Boolean(iface.decodeFunctionResult('unjudgedEscalation', raw)[0]);
}

// ── Circuit breaker ──────────────────────────────────────────────────────────

export interface BreakerTrip {
  at: string;
  action: 'paused' | 'killed';
  reason: string;
  nonce: number;
  txHash: string;
}

let lastTrip: BreakerTrip | null = null;
const stuckAlerted = new Set<string>();
const lostSince = new Map<string, number>();
// A transaction seen at a passed nonce with no record of it landing must look
// lost on two passes this far apart before we call the nonce taken: an RPC
// replica can lag on the transaction while it is ahead on the count.
const LOST_CONFIRM_MS = 25_000;

/**
 * Pause new reservations (or stop every send) by itself, alert, and show the
 * reason on /health/bridge. Only a person lifts it; nothing is re-signed.
 */
async function trip(settings: Enabled, action: 'paused' | 'killed', reason: string, tx: { nonce: number; txHash: string }): Promise<void> {
  lastTrip = { at: new Date().toISOString(), action, reason, nonce: tx.nonce, txHash: tx.txHash };
  await setControls(settings.chainId, action === 'killed' ? { killed: true } : { paused: true }, `auto: ${reason}`, 'auto');
  console.error(`[gasSponsor] ⛔ ${action} automatically: ${reason}`);
  Sentry.captureMessage(`gas sponsor ${action} automatically on ${settings.chainId}: ${reason}`, action === 'killed' ? 'fatal' : 'error');
}

// The node's own refusals of the bytes (txpool validation): they never
// entered a pool and never will.
const REFUSED = /insufficient funds|invalid sender|invalid signature|intrinsic gas too low|exceeds block gas limit|(tx|transaction) type not supported|invalid chain ?id|oversized data|higher than max fee per gas|exceeds the configured cap|empty auth(orization)? list/i;

/**
 * What a failed eth_sendRawTransaction means for the stored bytes:
 * - known: already in the pool;
 * - nonce_low: the nonce is used (ours landed, or the key signed elsewhere);
 * - rejected: the node refused them outright and never will take them;
 * - transient: anything else (no answer, fees moved, an error not recognised
 *   above): the same bytes may be in a pool or land later, so they are kept
 *   and re-sent. Freeing the nonce of bytes that did reach a pool would put
 *   a second transaction at it.
 */
export function classifyBroadcastError(err: unknown): 'known' | 'nonce_low' | 'transient' | 'rejected' {
  const e = err as { code?: string; message?: string; shortMessage?: string; error?: { message?: string }; info?: { error?: { message?: string } } } | null;
  const msg = [e?.message, e?.shortMessage, e?.error?.message, e?.info?.error?.message].filter(Boolean).join(' ');
  if (/already known|known transaction|already imported/i.test(msg)) return 'known';
  if (e?.code === 'NONCE_EXPIRED' || /nonce too low|nonce has already been used|nonce is too low/i.test(msg)) return 'nonce_low';
  if (e?.code === 'INSUFFICIENT_FUNDS' || REFUSED.test(msg)) return 'rejected';
  return 'transient';
}

/**
 * A stored transaction whose nonce the chain has passed: it landed (its
 * receipt lags), or a transaction that is not ours took the nonce. The
 * latter means the sponsor key signs somewhere else: stop every send.
 * Returns true when it is settled as lost.
 */
async function nonceTaken(settings: Enabled, tx: SponsoredTxRecord, now: number, confirmAfterMs = LOST_CONFIRM_MS): Promise<boolean> {
  let seen: { blockNumber?: string | null } | null;
  try {
    seen = await provider().send('eth_getTransactionByHash', [tx.txHash]);
  } catch {
    // No answer is not "not found": the clock below neither starts nor runs.
    return false;
  }
  if (seen?.blockNumber) {
    lostSince.delete(tx.txHash);
    return false;
  }
  const first = lostSince.get(tx.txHash);
  if (first === undefined) lostSince.set(tx.txHash, now);
  if (first === undefined ? confirmAfterMs > 0 : now - first < confirmAfterMs) return false;
  lostSince.delete(tx.txHash);
  await setTxStatus(tx.txHash, 'dropped');
  await trip(settings, 'killed', `the sponsor's nonce ${tx.nonce} was used by a transaction that is not ${tx.txHash}: the sponsor key is signing elsewhere`, tx);
  return true;
}

/** Whether `taskHash` was assigned to `wallet` through our /accept (our marketplaceAssign). */
async function assignedByUs(taskHash: string, wallet: string): Promise<boolean> {
  const state = await a2aStore.getState(taskHash);
  return !!state?.assignTxHash && state.executorAddress?.toLowerCase() === wallet.toLowerCase();
}

/** The hash of a transaction already signed for this reservation and not settled, if any. */
async function inFlight(reservationId: number): Promise<string | null> {
  const tx = (await txsForReservation(reservationId)).find((t) => t.status === 'signed' || t.status === 'sent');
  return tx?.txHash ?? null;
}

/** The evidence /submit recorded for the task, as the escrow will store it. */
async function recordedEvidenceHash(taskHash: string): Promise<string | null> {
  const state = await a2aStore.getState(taskHash);
  if (!state?.resultData) return null;
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(state.resultData)));
}

// ── Relay ────────────────────────────────────────────────────────────────────

/**
 * Relay one signed call for a hosted agent. Every refusal is safe to fall
 * back from: nothing was sent, and the worker uses its own gas.
 */
export async function relaySponsoredCall(input: SponsoredCallInput): Promise<RelayResult> {
  const run = await runnableSettings('gas sponsor relay');
  if (!run.ok) return refuse(503, 'GAS_SPONSOR_OFF', `Sponsored gas is off here: ${run.reason}`);
  const settings = run.settings;
  const wallet = ethers.getAddress(input.agent.walletAddress);
  const kind = input.kind === 'submit' ? DelegateKind.SubmitEvidence : DelegateKind.ReleaseUnjudgedWork;
  const held = await getReservation(settings.chainId, input.taskId, input.kind);
  // A call of ours already out for this reservation: wait on it and answer
  // with it, whatever changed since (a kill, an export). Never a second send.
  if (held?.status === 'reserved' && held.agentWallet === wallet.toLowerCase()) {
    const out = await inFlight(held.id);
    if (out) return settle(settings, held, { wallet, kind, taskId: input.taskId }, out);
  }
  if (!writer) return refuse(503, 'GAS_SPONSOR_OFF', 'This backend process is not the sponsor writer');
  const controls = await getControls(settings.chainId);
  if (controls.killed) return refuse(409, 'GAS_SPONSOR_KILLED', 'Sponsored gas is stopped');

  const eligible = await agentEligibility(settings, input.agent);
  if (!eligible.ok) {
    // An export between reservation and relay ends it.
    if (held?.status === 'reserved' && held.agentWallet === wallet.toLowerCase()) await closeReservation(held.id, 'released');
    return refuse(403, 'GAS_SPONSOR_INELIGIBLE', `This agent is not eligible for sponsored gas (${eligible.reason})`);
  }

  const task = await getTaskOn('arc', Number(input.taskId));
  if (task.worker.toLowerCase() !== wallet.toLowerCase()) return refuse(409, 'NOT_WORKER', 'The escrow does not name this agent as the worker');
  const evidenceHash = kind === DelegateKind.SubmitEvidence ? ethers.hexlify(ethers.getBytes(input.evidenceHash)) : ethers.ZeroHash;
  const call = { kind, taskId: input.taskId, evidenceHash, nonce: input.nonce, deadline: input.deadline };
  if (callSigner(settings.chainId, wallet, settings.escrow, call, input.signature)?.toLowerCase() !== wallet.toLowerCase()) {
    return refuse(400, 'BAD_SIGNATURE', "The call is not signed by the agent's wallet");
  }

  // A submit spends the reservation /accept made; a release reserves only
  // once its transaction is ready to go, below.
  let reservation: Reservation | null = null;
  if (kind === DelegateKind.SubmitEvidence) {
    const ours = held && held.agentWallet === wallet.toLowerCase() && (held.status === 'reserved' || held.status === 'used') ? held : null;
    if (ours && task.status === TaskStatus.Submitted && task.evidenceHash.toLowerCase() === evidenceHash.toLowerCase()) {
      // Already on-chain: a repeat of a call we sent, or the agent's own.
      if (ours.status === 'used') return { ok: true, txHash: ours.txHash };
      await markReservationUsed(ours.id, null);
      return { ok: true, txHash: null, landedElsewhere: true };
    }
    if (ours?.status !== 'reserved') {
      return refuse(409, 'NO_RESERVATION', 'No sponsored-gas reservation is held for this task by this agent');
    }
    reservation = ours;
    if (task.status !== TaskStatus.Assigned || task.submissionAttempts !== 0) {
      return refuse(409, 'NOT_FIRST_SUBMIT', 'Only the first submit of an Assigned task is sponsored');
    }
    const deadline = (await effectiveDeadlineOn('arc', Number(input.taskId)).catch(() => null)) ?? task.deadline;
    if (Number(deadline) - Math.floor(Date.now() / 1000) <= MIN_SECONDS_BEFORE_DEADLINE) {
      return refuse(409, 'TOO_CLOSE_TO_DEADLINE', 'Less than a minute is left before the task deadline');
    }
    if (!(await assignedByUs(reservation.taskHash, wallet))) return refuse(409, 'NOT_OURS', 'This task was not assigned through BlindMarket');
    const recorded = await recordedEvidenceHash(reservation.taskHash);
    if (!recorded || recorded.toLowerCase() !== evidenceHash.toLowerCase()) {
      return refuse(409, 'EVIDENCE_MISMATCH', 'The signed evidence is not the result submitted for this task');
    }
  } else {
    // releaseUnjudgedWork needs the poster's escalation (claimTimeout on
    // delivered, unjudged work) and the dispute window passed; the window is
    // left to the simulation below, which reverts inside it.
    if (task.status !== TaskStatus.Disputed || !(await escalated(settings, input.taskId))) {
      return refuse(409, 'NOT_RELEASABLE', 'The task is not escalated unjudged work awaiting release');
    }
    const taskHash = task.taskHash.toLowerCase();
    if (!(await assignedByUs(taskHash, wallet))) return refuse(409, 'NOT_OURS', 'This task was not assigned through BlindMarket');
    const taskOk = await taskEligibility(settings, input.taskId, task, { verifier: false });
    if (!taskOk.ok) return refuse(409, 'GAS_SPONSOR_UNAVAILABLE', `This task does not qualify (${taskOk.reason})`);
  }

  const code = await codeAt(wallet);
  const delegated = isDelegatedTo(code, settings.delegate);
  let authorization = input.authorization;
  if (delegated) {
    authorization = undefined; // already set up: an authorization would only spend gas
  } else {
    if (!authorization) return refuse(409, 'NOT_DELEGATED', 'The wallet is not delegated yet: sign a 7702 authorization to the delegate');
    if (code !== '0x' && !code.toLowerCase().startsWith('0xef0100')) return refuse(409, 'NOT_DELEGATED', 'The wallet holds code that is not a delegation');
    if (BigInt(authorization.chainId) !== BigInt(settings.chainId)) return refuse(400, 'BAD_AUTHORIZATION', 'The authorization must name this chain');
    if (ethers.getAddress(authorization.address) !== settings.delegate) return refuse(400, 'BAD_AUTHORIZATION', 'The authorization must name the BlindMarket delegate');
    if (authorizationSigner(authorization)?.toLowerCase() !== wallet.toLowerCase()) {
      return refuse(400, 'BAD_AUTHORIZATION', "The authorization is not signed by the agent's wallet");
    }
    if ((await setupAttempts(settings.chainId, wallet)) >= MAX_SETUP_ATTEMPTS) {
      return refuse(409, 'SETUP_LIMIT', 'This wallet has used its sponsored setup attempts');
    }
  }

  const data = encodeExecute(call, input.signature);
  const simulated = await simulate(settings, wallet, data, authorization);
  if (!simulated.ok) {
    if (simulated.error?.name === 'InvalidNonce' && kind === DelegateKind.SubmitEvidence && reservation) {
      // Someone else may have landed this signed call already.
      const now = await taskAt(settings, input.taskId);
      if (now.status === TaskStatus.Submitted && now.evidenceHash.toLowerCase() === evidenceHash.toLowerCase()) {
        await markReservationUsed(reservation.id, null);
        report(settings, wallet, input.kind, input.taskId, 'landed_elsewhere');
        return { ok: true, txHash: null, landedElsewhere: true };
      }
    }
    return simulated.refusal;
  }
  const estimate = simulated.estimate;

  const fee = await provider().getFeeData();
  const block = await provider().getBlock('latest');
  if (block?.baseFeePerGas != null && block.baseFeePerGas > settings.maxFeeWei) {
    return refuse(409, 'FEES_TOO_HIGH', 'The base fee is above the sponsor fee cap');
  }
  const maxFeePerGas = fee.maxFeePerGas !== null && fee.maxFeePerGas < settings.maxFeeWei ? fee.maxFeePerGas : settings.maxFeeWei;
  const priority = fee.maxPriorityFeePerGas ?? 0n;
  const maxPriorityFeePerGas = priority < maxFeePerGas ? priority : maxFeePerGas;
  const gasLimit = (estimate * GAS_LIMIT_MARGIN_PERCENT + 99n) / 100n;

  if (!reservation) {
    const reserved = await reserve(
      {
        chainId: settings.chainId, taskId: input.taskId, kind: 'release', taskHash: task.taskHash.toLowerCase(), agentWallet: wallet,
        ownerDid: eligible.ownerDid, poster: task.agent, budgetWei: await reservationBudgetWei(settings),
        ttlSeconds: RESERVATION_TTL_SECONDS,
      },
      settings.caps,
    );
    if (!reserved.ok) return refuse(409, 'GAS_SPONSOR_UNAVAILABLE', `No sponsor budget for this release (${reserved.refusal})`);
    reservation = reserved.reservation;
  }

  return send(settings, reservation, {
    wallet, kind, taskId: input.taskId, data, gasLimit, maxFeePerGas, maxPriorityFeePerGas, authorization,
  });
}

/**
 * Estimate the exact transaction from the sponsor. A revert, or an estimate
 * above GAS_SPONSOR_MAX_GAS, is a refusal: nothing is sent.
 */
async function simulate(
  settings: Enabled,
  wallet: string,
  data: string,
  authorization: Authorization | undefined,
): Promise<{ ok: true; estimate: bigint } | { ok: false; refusal: RelayResult; error: ethers.ErrorDescription | null }> {
  let estimate: bigint;
  try {
    estimate = BigInt(
      await provider().send('eth_estimateGas', [{
        from: settings.sponsor.address,
        to: wallet,
        data,
        ...(authorization ? { authorizationList: [authorizationToRpc(authorization)] } : {}),
      }]),
    );
  } catch (err) {
    const error = delegateError(rpcErrorData(err));
    return { ok: false, error, refusal: refuse(409, 'SIMULATION_REVERTED', `The call would revert${error ? ` (${error.name})` : ''}: nothing was sent`) };
  }
  if (estimate > settings.maxGas) {
    return { ok: false, error: null, refusal: refuse(409, 'GAS_TOO_HIGH', `The call needs ${estimate} gas, above the ${settings.maxGas} ceiling`) };
  }
  return { ok: true, estimate };
}

/**
 * What can change while a call waits in the queue behind others: the kill
 * switch, a key export, and the call itself (simulated again). Null when it
 * may still go.
 */
async function recheckBeforeSend(settings: Enabled, tx: Prepared): Promise<RelayResult | null> {
  if ((await getControls(settings.chainId)).killed) return refuse(409, 'GAS_SPONSOR_KILLED', 'Sponsored gas is stopped');
  if (await walletKeyExported(tx.wallet)) {
    return refuse(403, 'GAS_SPONSOR_INELIGIBLE', 'This agent is not eligible for sponsored gas (key_exported)');
  }
  const simulated = await simulate(settings, tx.wallet, tx.data, tx.authorization);
  return simulated.ok ? null : simulated.refusal;
}

interface Prepared {
  wallet: string;
  kind: DelegateKind;
  taskId: bigint;
  data: string;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  authorization?: Authorization;
}

async function send(settings: Enabled, reservation: Reservation, tx: Prepared): Promise<RelayResult> {
  const kindName = tx.kind === DelegateKind.SubmitEvidence ? 'submit' : 'release';
  let outcome: Promise<RelayResult> = Promise.resolve(refuse(503, 'GAS_SPONSOR_OFF', 'not sent'));
  await enqueue(async () => {
    const sponsor = settings.sponsor;
    let raw: string;
    let hash: string;
    let nonce: number;
    try {
      // A repeat of this call (a worker asking again after its request timed
      // out) can queue behind it, having passed the entry check before
      // anything was recorded: send only what the reservation still owes.
      const fresh = await getReservationById(reservation.id);
      if (fresh?.status !== 'reserved') {
        outcome = Promise.resolve(fresh?.status === 'used'
          ? { ok: true, txHash: fresh.txHash }
          : refuse(409, 'NO_RESERVATION', 'The sponsored-gas reservation for this call is no longer held'));
        return null;
      }
      const out = await inFlight(reservation.id);
      if (out) {
        outcome = settle(settings, fresh, tx, out);
        return null;
      }
      const stale = await recheckBeforeSend(settings, tx);
      if (stale) {
        if (stale.ok === false && stale.code === 'GAS_SPONSOR_INELIGIBLE') await closeReservation(reservation.id, 'released');
        else if (tx.kind === DelegateKind.ReleaseUnjudgedWork) await closeReservation(reservation.id, 'released');
        outcome = Promise.resolve(stale);
        return null;
      }
      const [pending, stored] = await Promise.all([
        provider().getTransactionCount(sponsor.address, 'pending'),
        nextStoredNonce(settings.chainId, sponsor.address),
      ]);
      // Our own record wins over a lagging replica: never reuse a stored nonce.
      nonce = Math.max(pending, stored ?? 0);
      if (tx.authorization) {
        ({ raw, hash } = signSetCodeTx(sponsor.signingKey, {
          chainId: BigInt(settings.chainId), nonce, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, maxFeePerGas: tx.maxFeePerGas,
          gasLimit: tx.gasLimit, to: tx.wallet, data: tx.data, authorizationList: [tx.authorization],
        }));
      } else {
        raw = await sponsor.signTransaction({
          type: 2, chainId: settings.chainId, nonce, to: tx.wallet, data: tx.data, value: 0n, gasLimit: tx.gasLimit,
          maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
        });
        hash = ethers.keccak256(raw);
      }
      await recordSignedTx({
        chainId: settings.chainId, reservationId: reservation.id, sponsor: sponsor.address, nonce, rawTx: raw, txHash: hash,
        withAuthorization: !!tx.authorization,
      });
    } catch (err) {
      outcome = Promise.resolve(refuse(503, 'NOT_SENT', `Not sent: ${safeErrorMessage(err)}`));
      return null;
    }
    try {
      await provider().send('eth_sendRawTransaction', [raw]);
    } catch (err) {
      const why = classifyBroadcastError(err);
      if (why !== 'known') {
        report(settings, tx.wallet, kindName, tx.taskId, `broadcast_${why}`, { txHash: hash });
        if (why === 'transient') {
          // Maybe in a pool, maybe not: the bytes are stored and recover() re-sends them.
          outcome = Promise.resolve(pendingResult(hash, `Broadcast of ${hash} did not go through yet; it is re-sent until it lands`));
          return null;
        }
        // Final: these bytes can never land.
        if (why === 'nonce_low') {
          await setTxStatus(hash, 'dropped');
          await trip(settings, 'killed', `the node says the sponsor's nonce ${nonce} is used, but not by ${hash}: the sponsor key is signing elsewhere`, { nonce, txHash: hash });
        } else {
          await setTxStatus(hash, 'rejected');
          await trip(settings, 'paused', `the node rejected sponsored tx ${hash} (nonce ${nonce}): ${safeErrorMessage(err)}`, { nonce, txHash: hash });
        }
        if (tx.kind === DelegateKind.ReleaseUnjudgedWork) await closeReservation(reservation.id, 'released');
        outcome = Promise.resolve(refuse(503, 'NOT_SENT', `Not sent: the node refused ${hash}`));
        return null;
      }
    }
    await setTxStatus(hash, 'sent');
    const settled = settle(settings, reservation, tx, hash);
    outcome = settled;
    // The queue holds the next send until this one is mined.
    return { wait: () => settled };
  });
  return outcome;
}

async function pollReceipt(hash: string, timeoutMs = receiptTimeoutMs): Promise<ethers.TransactionReceipt | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const receipt = await provider().getTransactionReceipt(hash).catch(() => null);
    if (receipt || Date.now() >= deadline) return receipt;
    await new Promise((r) => setTimeout(r, RECEIPT_POLL_MS));
  }
}

/** Settle a mined sponsored transaction against its reservation. */
async function settle(settings: Enabled, reservation: Reservation, tx: Pick<Prepared, 'wallet' | 'kind' | 'taskId'>, hash: string): Promise<RelayResult> {
  const kindName = tx.kind === DelegateKind.SubmitEvidence ? 'submit' : 'release';
  const receipt = await pollReceipt(hash);
  if (!receipt) return pendingResult(hash, `Sent ${hash}; not confirmed yet`);
  const cost = receipt.gasUsed * receipt.gasPrice;
  const proved = receipt.status === 1
    && receiptProvesCall(receipt.logs, settings.escrow, tx.kind, tx.taskId, tx.wallet)
    && isDelegatedTo(await codeAt(tx.wallet, ethers.toQuantity(receipt.blockNumber)), settings.delegate);
  const status = receipt.status !== 1 ? 'reverted' : proved ? 'confirmed' : 'noop';
  await settleTx(hash, status, receipt.gasUsed, cost);
  report(settings, tx.wallet, kindName, tx.taskId, status, { txHash: hash, gasUsed: receipt.gasUsed.toString(), costWei: cost.toString() });
  if (status === 'confirmed') {
    await markReservationUsed(reservation.id, hash);
    return { ok: true, txHash: hash };
  }
  if (tx.kind === DelegateKind.SubmitEvidence && reservation.status === 'reserved') {
    // Lost the race: the same signed call landed first from someone else.
    const [after, recorded] = await Promise.all([
      taskAt(settings, tx.taskId, ethers.toQuantity(receipt.blockNumber)),
      recordedEvidenceHash(reservation.taskHash),
    ]);
    if (after.status === TaskStatus.Submitted && recorded && after.evidenceHash.toLowerCase() === recorded.toLowerCase()) {
      await markReservationUsed(reservation.id, null);
      report(settings, tx.wallet, kindName, tx.taskId, 'landed_elsewhere', { txHash: hash });
      return { ok: true, txHash: null, landedElsewhere: true };
    }
  }
  await maybeAutoPause(settings);
  if (status === 'noop') return refuse(409, 'SETUP_NOOP', 'The transaction ran but did nothing: the wallet is not delegated to the BlindMarket delegate');
  return refuse(409, 'REVERTED', `The sponsored transaction ${hash} reverted`);
}

// ── Recovery ─────────────────────────────────────────────────────────────────

/**
 * Settle or re-broadcast every stored transaction not known to be mined. The
 * same signed bytes go out again; nothing is ever signed twice. Trips the
 * breaker when a transaction can't land: its nonce taken by another
 * transaction (kill), the node rejecting the bytes outright (pause), or no
 * landing within GAS_SPONSOR_STUCK_MINUTES (pause).
 */
export async function recoverSponsorTxs(settings: Enabled, now = Date.now()): Promise<void> {
  if (!writer) return;
  const sponsor = settings.sponsor.address;
  const latest = Number(await provider().send('eth_getTransactionCount', [sponsor, 'latest']));
  for (const tx of await unsettledTxs(settings.chainId, sponsor)) {
    // A read that fails is no answer: leave this transaction for the next
    // tick. Only a node that answers "no receipt" counts it as not mined.
    let receipt: ethers.TransactionReceipt | null;
    try {
      receipt = await provider().getTransactionReceipt(tx.txHash);
    } catch (err) {
      console.warn(`[gasSponsor] could not read the receipt of ${tx.txHash}: ${(err as Error).message}`);
      continue;
    }
    if (receipt) {
      lostSince.delete(tx.txHash);
      await settleStored(settings, tx);
      continue;
    }
    if (tx.nonce < latest) {
      await nonceTaken(settings, tx, now);
      continue;
    }
    try {
      await provider().send('eth_sendRawTransaction', [tx.rawTx]);
      if (tx.status === 'signed') await setTxStatus(tx.txHash, 'sent');
    } catch (err) {
      const why = classifyBroadcastError(err);
      if (why === 'known' || why === 'nonce_low') {
        // The chain has not passed this nonce (checked above), so "nonce too
        // low" counts a pooled transaction at it — ours, as far as anything
        // shows (Hardhat answers this way while automining). If another
        // transaction mines there, the passed-nonce check above catches it.
        if (tx.status === 'signed') await setTxStatus(tx.txHash, 'sent');
      } else if (why === 'rejected') {
        await setTxStatus(tx.txHash, 'rejected');
        await trip(settings, 'paused', `the node rejected sponsored tx ${tx.txHash} (nonce ${tx.nonce}): ${safeErrorMessage(err)}`, tx);
        continue;
      } else {
        console.warn(`[gasSponsor] re-broadcast of ${tx.txHash} failed: ${(err as Error).message}`);
      }
    }
    if (now - tx.createdAt.getTime() >= settings.stuckMs && !stuckAlerted.has(tx.txHash)) {
      stuckAlerted.add(tx.txHash);
      await trip(settings, 'paused', `sponsored tx ${tx.txHash} (nonce ${tx.nonce}) has not landed in ${Math.round(settings.stuckMs / 60_000)} minutes`, tx);
    }
  }
}

/** Settle a stored transaction that has a receipt, against its reservation. */
async function settleStored(settings: Enabled, tx: SponsoredTxRecord): Promise<RelayResult | null> {
  // Every sponsored transaction is sent to the agent's own wallet.
  const reservation = await getReservationById(tx.reservationId);
  if (!reservation) return null;
  return settle(settings, reservation, {
    wallet: ethers.getAddress(reservation.agentWallet),
    kind: reservation.kind === 'submit' ? DelegateKind.SubmitEvidence : DelegateKind.ReleaseUnjudgedWork,
    taskId: reservation.taskId,
  }, tx.txHash);
}

// ── Call status ──────────────────────────────────────────────────────────────

/**
 * What became of the agent's sponsored call for a task: none sent; pending
 * (out, may still land); confirmed (landed, ours or the same call from
 * someone else); or failed for good (reverted, did nothing, its nonce went
 * to another transaction, the node refused it, or the task moved on without
 * it). While it is pending the worker neither pays its own gas for the call
 * nor hands the task back.
 */
export async function sponsoredCallStatus(wallet: string, taskId: bigint, kind: 'submit' | 'release'): Promise<CallStatus> {
  const s = gasSponsorSettings();
  if (!s.enabled) return { status: 'none' };
  const r = await getReservation(s.chainId, taskId, kind);
  if (!r || r.agentWallet !== wallet.toLowerCase()) return { status: 'none' };
  if (r.status === 'used') return { status: 'confirmed', txHash: r.txHash };
  const txs = await txsForReservation(r.id);
  const out = txs.find((t) => t.status === 'signed' || t.status === 'sent');
  if (out) {
    const receipt = await provider().getTransactionReceipt(out.txHash).catch(() => null);
    if (receipt) {
      const settled = await settleStored(s, out);
      if (settled?.ok) return { status: 'confirmed', txHash: settled.txHash };
      return { status: 'failed', txHash: out.txHash, reason: settled?.ok === false ? settled.code : 'settled' };
    }
    // Not mined: final once the task moved on without it (it can only revert now).
    const task = await taskAt(s, taskId);
    if (kind === 'submit' && task.status !== TaskStatus.Assigned) {
      const recorded = await recordedEvidenceHash(r.taskHash);
      if (task.status === TaskStatus.Submitted && recorded && task.evidenceHash.toLowerCase() === recorded.toLowerCase()) {
        await markReservationUsed(r.id, null);
        return { status: 'confirmed', txHash: null };
      }
      return { status: 'failed', txHash: out.txHash, reason: 'task_moved' };
    }
    if (kind === 'release' && task.status !== TaskStatus.Disputed) return { status: 'failed', txHash: out.txHash, reason: 'task_moved' };
    return { status: 'pending', txHash: out.txHash };
  }
  const last = txs[txs.length - 1];
  return last ? { status: 'failed', txHash: last.txHash, reason: last.status } : { status: 'none' };
}

// ── Sweep: reservations and auto-pause ──────────────────────────────────────

/**
 * Close each held reservation at the first of: its call landed (closed when
 * it was sent), the task left Assigned or was handed back off-chain
 * (released), or an hour passed since the assignment (expired, a strike).
 * The strike is for an agent that sat on its reservation, so an hour lost to
 * our side is released without one: sponsorship killed (the relay refuses
 * every call), or a transaction of ours sent for it that failed. One whose
 * transaction is still out isn't swept at all until that transaction is final.
 */
export async function sweepReservations(settings: Enabled, now = Date.now()): Promise<void> {
  const held = await heldReservations(settings.chainId);
  if (held.length === 0) return;
  const killed = (await getControls(settings.chainId)).killed;
  for (const r of held) {
    try {
      // Our transaction is still out: the reservation lives until it is final.
      if ((await inFlight(r.id)) !== null) continue;
      const state = await a2aStore.getState(r.taskHash);
      if (r.kind === 'submit' && state?.executorAddress && state.executorAddress.toLowerCase() !== r.agentWallet) {
        await closeReservation(r.id, 'released');
        continue;
      }
      const task = await getTaskOn('arc', Number(r.taskId));
      const assignedToAgent = task.worker.toLowerCase() === r.agentWallet;
      if (r.kind === 'submit' && assignedToAgent && task.status !== TaskStatus.Assigned) {
        await closeReservation(r.id, 'released');
        continue;
      }
      if (now >= r.expiresAt.getTime()) {
        const stillWaiting = r.kind === 'submit' && assignedToAgent && task.status === TaskStatus.Assigned;
        const ourSide = killed || (await txsForReservation(r.id)).length > 0;
        const strike = stillWaiting && !ourSide;
        await closeReservation(r.id, strike ? 'expired' : 'released', strike ? 'held an hour after assignment without a submit' : undefined);
      }
    } catch (err) {
      console.warn(`[gasSponsor] sweep of reservation ${r.id} failed: ${(err as Error).message}`);
    }
  }
}

/**
 * Pause new reservations, and alert, when the last hour's spend passed its
 * budget, sends failed too often, or the sponsor holds less than a day of
 * budget. Pause keeps reserved tasks served; only a person lifts it.
 */
export async function maybeAutoPause(settings: Enabled): Promise<string | null> {
  const controls = await getControls(settings.chainId);
  if (controls.paused || controls.killed) return null;
  const used = await usage(settings.chainId);
  let reason: string | null = null;
  if (used.spentLastHourWei > settings.caps.hourlyBudgetWei) reason = 'the last hour spent more than its budget';
  else if (used.failuresLastHour >= settings.maxFailuresPerHour) reason = `${used.failuresLastHour} sponsored sends failed in the last hour`;
  else {
    const balance = await provider().getBalance(settings.sponsor.address).catch(() => null);
    if (balance !== null && balance < settings.caps.dailyBudgetWei) {
      reason = `the sponsor holds ${ethers.formatEther(balance)} USDC, less than one day of budget`;
    }
  }
  if (!reason) return null;
  await setControls(settings.chainId, { paused: true }, `auto: ${reason}`, 'auto');
  console.error(`[gasSponsor] ⛔ paused automatically: ${reason}`);
  Sentry.captureMessage(`gas sponsor paused automatically on ${settings.chainId}: ${reason}`, 'error');
  return reason;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

let started = false;

/**
 * One pass of the writer: take the lock if free, then — while holding it —
 * settle or re-send every stored transaction (and trip the breaker on one
 * that can't land), sweep reservations, and check the automatic pause.
 * Exported for tests.
 */
export async function gasSponsorTick(): Promise<void> {
  const run = await runnableSettings('gas sponsor').catch((e) => ({ ok: false as const, reason: (e as Error).message }));
  if (!run.ok) return;
  try {
    if (!writer && (await acquireSponsorWriter(run.settings))) {
      console.log(`[gasSponsor] writer for Arc ${run.settings.chainId}, sponsor ${run.settings.sponsor.address}`);
    }
    if (writer) {
      await recoverSponsorTxs(run.settings);
      await sweepReservations(run.settings);
      await maybeAutoPause(run.settings);
    }
  } catch (err) {
    console.error(`[gasSponsor] tick failed: ${(err as Error).message}`);
  }
}

/** Run gasSponsorTick now and every 30 s. A no-op when sponsorship is off. */
export function startGasSponsor(): void {
  if (started) return;
  started = true;
  void gasSponsorTick();
  setInterval(() => { void gasSponsorTick(); }, Math.min(SWEEP_MS, WRITER_RETRY_MS)).unref();
}

/** Test hook: how long a relay waits for its receipt before answering pending. */
export function _setReceiptTimeout(ms: number): void {
  receiptTimeoutMs = ms;
}

/** Test hook. */
export async function _resetGasSponsorRelayer(): Promise<void> {
  await releaseSponsorWriter();
  started = false;
  lastTrip = null;
  stuckAlerted.clear();
  lostSince.clear();
}

// ── Status ───────────────────────────────────────────────────────────────────

export interface GasSponsorReport {
  enabled: boolean;
  reason?: string;
  chainId?: number;
  sponsor?: string;
  delegate?: string;
  /** Whether this process is the one that sends. */
  writer?: boolean;
  paused?: boolean;
  killed?: boolean;
  controlReason?: string | null;
  /** Native USDC. */
  sponsorBalance?: string | null;
  /** The last time the breaker paused or stopped sponsorship by itself, in this process. */
  lastTrip?: BreakerTrip | null;
  /** The oldest sponsored transaction not yet landed. */
  oldestPendingTx?: { nonce: number; txHash: string; ageSeconds: number } | null;
  callsToday?: number;
  spentTodayUsdc?: string;
  budgetLeftTodayUsdc?: string;
  spentLastHourUsdc?: string;
}

/**
 * Sponsored gas at a glance, for /health/bridge and the founder route. Never
 * throws. /health/bridge is unauthenticated: an error appears here only as
 * safeErrorMessage gives it (no request detail, RPC URLs masked).
 */
export async function gasSponsorReport(): Promise<GasSponsorReport> {
  try {
    const run = await runnableSettings('gas sponsor report');
    if (!run.ok) return { enabled: false, reason: run.reason };
    const s = run.settings;
    const [controls, used, balance, open] = await Promise.all([
      getControls(s.chainId),
      usage(s.chainId),
      provider().getBalance(s.sponsor.address).catch(() => null),
      unsettledTxs(s.chainId, s.sponsor.address),
    ]);
    const oldest = open[0] ?? null;
    const left = s.caps.dailyBudgetWei > used.spentLastDayWei ? s.caps.dailyBudgetWei - used.spentLastDayWei : 0n;
    return {
      enabled: true,
      chainId: s.chainId,
      sponsor: s.sponsor.address,
      delegate: s.delegate,
      writer: isSponsorWriter(),
      paused: controls.paused,
      killed: controls.killed,
      controlReason: controls.reason,
      sponsorBalance: balance === null ? null : ethers.formatEther(balance),
      callsToday: used.callsLastDay,
      spentTodayUsdc: ethers.formatEther(used.spentLastDayWei),
      budgetLeftTodayUsdc: ethers.formatEther(left),
      spentLastHourUsdc: ethers.formatEther(used.spentLastHourWei),
      lastTrip,
      oldestPendingTx: oldest
        ? { nonce: oldest.nonce, txHash: oldest.txHash, ageSeconds: Math.round((Date.now() - oldest.createdAt.getTime()) / 1000) }
        : null,
    };
  } catch (err) {
    return { enabled: false, reason: `status unavailable: ${safeErrorMessage(err)}` };
  }
}
