/**
 * The bulk posting engine (docs/BULK-POSTING.md). Given checked rows, it
 * approves the whole escrow total once, then funds and lists the tasks:
 * - batch create (the escrow has createTasks): chunks of rows, one
 *   transaction each, listed through /a2a/tasks/index-batch;
 * - otherwise: one row, one transaction, listed through /a2a/tasks/index.
 *
 * Its I/O is injected (the page wires the real API and wallet), so these
 * money rules are tested without either:
 * - a transaction the backend built is sent only when it is exactly the call
 *   these rows asked for, on the pinned escrow and token (lib/bulkCalls);
 *   anything else stops the run with nothing sent;
 * - a row is saved as 'sending' before its transaction goes to the wallet, so
 *   a tab closed mid-send never funds it again on resume (lib/bulkRunStore);
 * - a funding transaction is sent once; a failure after the wallet broadcast
 *   carries on to the listing (lib/postTaskFlow sendFunding);
 * - a failed send is marked unpaid only when it can't have paid: it reverted,
 *   or it failed before the wallet had it. With no hash and no such proof the
 *   row stays 'sending', maybe paid (sendFailure);
 * - the listing request is saved as a pending entry the moment the wallet
 *   broadcasts, so a closed tab still leaves "Retry listing";
 * - a reverted transaction funded nothing: its pending entries are cleared;
 * - any failure to fund or to list pauses the run, so it never keeps paying
 *   while something is wrong.
 */
import type { UnsignedTx } from '../types/api';
import { TxMismatchError, checkBulkCall, type CheckedCall, type ExpectedTask, type PinnedContracts } from './bulkCalls';
import type { BulkRow } from './bulkRows';
import type { PendingIndex } from './pendingIndex';
import { TxRevertedError, sentNothing } from './bulkWallet';
import { defaultAutoCriteria, sendFunding, type BatchIndexResult, type Executor, type FundingResult, type KeyCustodyBlob, type PreparedBrief } from './postTaskFlow';
import type { SentTx } from './txSigner';

/** The backend refuses more wrapped keys than this (POST /tasks, /a2a/tasks/index). */
export const MAX_WRAPPED_KEYS = 200;
/** Default rows per createTasks transaction; capped by the escrow's MAX_BATCH. */
export const DEFAULT_CHUNK = 20;

/**
 * 'funding': its transaction is being built and checked, nothing sent yet.
 * 'sending': handed to the wallet (saved before the wallet has it); with a
 * txHash once the wallet broadcast it.
 */
export type BulkState = 'queued' | 'preparing' | 'funding' | 'sending' | 'listing' | 'done' | 'unlisted' | 'failed' | 'unknown';

export interface RowStatus {
  state: BulkState;
  taskHash?: string;
  txHash?: string;
  taskId?: string | null;
  /** Plain words: why it failed, or why it is funded but not listed. */
  error?: string;
}

export type EngineRow = BulkRow & { fingerprint: string };

export interface BulkDeps {
  /** The poster's wallet (pending entries are filed under it). */
  poster: string;
  /** The escrow every row pays into and its token, as this build knows them
   *  (lib/bulkCalls pinnedContracts): a built transaction must match them. */
  pins: PinnedContracts;
  prepare: (instructions: string, isPublic: boolean) => Promise<PreparedBrief>;
  /** Registered executors, fetched once, only when a private row needs them. */
  executors: () => Promise<Executor[]>;
  wrap: (taskHash: string, key: Uint8Array, executors: Executor[]) => Promise<Record<string, string>>;
  seal: (key: Uint8Array) => Promise<KeyCustodyBlob | undefined>;
  upload: (blob: string) => Promise<string>;
  uploadMany: (blobs: string[]) => Promise<string[]>;
  buildOne: (body: Record<string, unknown>) => Promise<{ unsignedTx: UnsignedTx; chain?: string; chainId?: number }>;
  buildBatch: (tasks: Record<string, unknown>[]) => Promise<{ unsignedTx: UnsignedTx; chain?: string; chainId?: number }>;
  /** Make sure the escrow may pull `total`; throws when the approval fails. */
  ensureAllowance: (total: bigint) => Promise<void>;
  /**
   * Send one checked funding transaction. `onBroadcast` gets its hash as soon
   * as the wallet has it. Throws TxRevertedError for a mined receipt with
   * status 0 (lib/bulkWallet); how any other failure is read: sendFailure.
   */
  send: (call: CheckedCall, onBroadcast: (hash: string) => void) => Promise<SentTx>;
  indexOne: (body: Record<string, unknown>) => Promise<{ resp: { onChainTaskId?: string | null } | null; lastErr: unknown }>;
  indexBatch: (txHash: string, isUserOp: boolean, tasks: Record<string, unknown>[]) => Promise<{ resp: { results: BatchIndexResult[] } | null; lastErr: unknown }>;
  savePending: (entry: Omit<PendingIndex, 'at'>) => void;
  clearPending: (taskHash: string) => void;
  /** Wait before listing a relayed user-op, which lands a few blocks later. */
  userOpDelay?: () => Promise<void>;
  /** Words for an error, for the progress table. */
  describe: (err: unknown) => string;
}

export interface BulkOptions {
  batch: { supported: boolean; maxBatch: number };
  chunkSize?: number;
  /**
   * Record a row's status, in storage before it returns; false when it could
   * not be saved. Rows are recorded as 'sending' before their transaction goes
   * to the wallet, and are not sent when that record failed: after a reload
   * they would look unpaid and could be funded twice.
   */
  onStatus: (fingerprint: string, status: RowStatus) => boolean | void;
  /** Checked between transactions; true stops the run before the next one. */
  shouldPause: () => boolean;
}

/** Everything a row sends: the create request, the listing request, the upload. */
interface PreparedRow {
  row: EngineRow;
  taskHash: string;
  /** The escrow terms asked for: the build request carries them, and the
   *  transaction the backend builds must carry exactly them. */
  task: ExpectedTask;
  blob: string;
  createBody: Record<string, unknown>;
  /** The listing request without txHash (added once known). */
  indexBody: Record<string, unknown>;
}

class RowError extends Error {}

/** A funding or listing failure that stops the run after its row or chunk. */
class PauseRun extends Error {}

async function prepareRow(row: EngineRow, deps: BulkDeps, getExecutors: () => Promise<Executor[]>): Promise<Omit<PreparedRow, 'createBody' | 'indexBody'> & { build: (rootHash: string) => Pick<PreparedRow, 'createBody' | 'indexBody'> }> {
  const isPublic = row.privacy === 'public';
  const brief = await deps.prepare(row.instructions, isPublic);
  let wrappedKeys: Record<string, string> | undefined;
  let keyCustodyBlob: KeyCustodyBlob | undefined;
  if (!isPublic) {
    const all = await getExecutors();
    let targets = all;
    if (row.target) {
      targets = all.filter((e) => e.address.toLowerCase() === row.target);
      if (targets.length === 0) throw new RowError('The target is not a registered executor that can read private briefs. Nothing was paid.');
    }
    if (targets.length > MAX_WRAPPED_KEYS) {
      throw new RowError(`${targets.length} executors can take this task, more than the ${MAX_WRAPPED_KEYS} a private brief can be wrapped to. Post it public or with a target. Nothing was paid.`);
    }
    wrappedKeys = await deps.wrap(brief.taskHash, brief.key, targets);
    keyCustodyBlob = await deps.seal(brief.key);
  }
  const verificationMode = row.verification;
  const verificationCriteria = verificationMode === 'auto' ? defaultAutoCriteria() : undefined;
  // No verifier: a row's verification is 'auto' or 'manual', never 'agent'.
  const task: ExpectedTask = { taskHash: brief.taskHash, amount: row.amountRaw, locationZone: row.zone, duration: BigInt(row.durationSeconds) };
  return {
    row,
    taskHash: brief.taskHash,
    task,
    blob: brief.blob,
    build: (rootHash: string) => ({
      createBody: {
        taskHash: task.taskHash,
        token: deps.pins.token,
        amount: task.amount.toString(),
        category: 'general',
        locationZone: task.locationZone,
        duration: task.duration.toString(),
        targetExecutorType: 'agent' as const,
        verificationMode,
        verificationCriteria,
        requiredCapabilities: row.capabilities,
        rootHash,
        wrappedKeys,
      },
      indexBody: {
        taskHash: brief.taskHash,
        verificationMode,
        verificationCriteria,
        requiredCapabilities: row.capabilities,
        rootHash,
        wrappedKeys,
        keyCustodyBlob,
        ...(row.target ? { targetExecutor: row.target } : {}),
        privacy: isPublic ? ('public' as const) : undefined,
        publicBrief: isPublic ? row.instructions.slice(0, 4000) : undefined,
        routingSummary: row.routingSummary ? row.routingSummary.slice(0, 500) : undefined,
      },
    }),
  };
}

/** `text`, ending with `note` unless it already says nothing was paid (the
 *  backend's STORAGE_UNAVAILABLE message does). */
function nothingPaid(text: string, note = 'Nothing was paid.'): string {
  return /nothing was paid/i.test(text) ? text : `${text} ${note}`;
}

/**
 * Whether a failure before funding belongs to this row alone (a RowError, or
 * a 4xx about this task such as a duplicate brief), so the run can go on.
 * Anything else (storage down, a network drop, a rate limit, an expired
 * session) would fail every row after it, so the run pauses instead.
 */
function failsOnlyThisRow(e: unknown): boolean {
  if (e instanceof RowError) return true;
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
}

/** A failure before funding, in words for the row. */
function failedBeforeFunding(e: unknown, deps: BulkDeps): string {
  return e instanceof RowError || e instanceof TxMismatchError ? e.message : nothingPaid(deps.describe(e));
}

/** A transaction that isn't what these rows asked for ends the run, not just
 *  the row: the backend building it would build the next one too. */
function stopOnMismatch(e: unknown): void {
  if (e instanceof TxMismatchError) {
    console.warn('[PostMany] Refused a transaction the backend built:', e.detail);
    throw e;
  }
}

const UNSAVED = "This browser couldn't save the run's progress, so this wasn't sent: after a reload it could have been paid for twice. Nothing was paid.";

/**
 * What a failed funding send did, read so that a paid row is never shown as
 * unpaid (and so queued again, and funded twice):
 * - 'reverted': mined with status 0 (TxRevertedError), so nothing was funded;
 * - 'unconfirmed': the wallet broadcast it (`broadcast`), then something else
 *   failed, the receipt wait say. It may have been paid;
 * - 'notSent': no hash, and the failure can't follow a broadcast (the poster
 *   refused, the gas estimate reverted, the wrong chain, no funds for gas);
 * - 'unknown': no hash, and nothing says it wasn't sent. It may have been paid.
 * sendFunding has already taken errors that carry a broadcast hash.
 */
function sendFailure(e: unknown, broadcast: string | null): 'reverted' | 'unconfirmed' | 'notSent' | 'unknown' {
  if (e instanceof TxRevertedError) return 'reverted';
  if (broadcast) return 'unconfirmed';
  return sentNothing(e) ? 'notSent' : 'unknown';
}

const reverted = (what: string) => `The transaction reverted on-chain, so nothing was paid for ${what}; only the network fee was spent.`;

const maybeSent = (why: string) => `May have been paid: the wallet stopped without saying whether it sent this. Check My tasks before posting it again. (${why})`;

/**
 * Fund and list `rows`, in order. Resolves 'finished' when every row was
 * tried, 'paused' when shouldPause() or a failure stopped it early (the rest
 * stay queued). Throws when the up-front approval fails, before any row is
 * funded, and TxMismatchError when a transaction isn't the one its rows
 * asked for, with nothing of it sent.
 */
export async function runBulkPost(rows: EngineRow[], deps: BulkDeps, opts: BulkOptions): Promise<'finished' | 'paused'> {
  if (rows.length === 0) return 'finished';
  let executorsPromise: Promise<Executor[]> | null = null;
  const getExecutors = () => (executorsPromise ??= deps.executors());

  await deps.ensureAllowance(rows.reduce((sum, r) => sum + r.amountRaw, 0n));

  const batch = opts.batch.supported;
  const size = batch ? Math.max(1, Math.min(opts.chunkSize ?? DEFAULT_CHUNK, opts.batch.maxBatch)) : 1;

  for (let start = 0; start < rows.length; start += size) {
    if (opts.shouldPause()) return 'paused';
    const chunk = rows.slice(start, start + size);
    try {
      if (batch) await fundChunk(chunk, deps, opts, getExecutors);
      else await fundOne(chunk[0], deps, opts, getExecutors);
    } catch (e) {
      if (e instanceof PauseRun) return 'paused';
      throw e;
    }
  }
  return 'finished';
}

async function fundOne(row: EngineRow, deps: BulkDeps, opts: BulkOptions, getExecutors: () => Promise<Executor[]>): Promise<void> {
  const say = (s: RowStatus) => opts.onStatus(row.fingerprint, s);
  say({ state: 'preparing' });
  let prepared: PreparedRow;
  let call: CheckedCall;
  try {
    const p = await prepareRow(row, deps, getExecutors);
    const rootHash = await deps.upload(p.blob);
    prepared = { ...p, ...p.build(rootHash) };
    say({ state: 'funding', taskHash: prepared.taskHash });
    call = checkBulkCall(await deps.buildOne(prepared.createBody), { fn: 'createTask', task: prepared.task }, deps.pins);
  } catch (e) {
    // Nothing was sent. A problem with this row fails just the row; an outage
    // or a mismatched transaction stops the run rather than failing every
    // remaining row one by one.
    say({ state: 'failed', error: failedBeforeFunding(e, deps) });
    stopOnMismatch(e);
    if (!failsOnlyThisRow(e)) throw new PauseRun();
    return;
  }

  let broadcast = null as string | null;
  const onBroadcast = (hash: string) => {
    broadcast = hash;
    deps.savePending({ taskHash: prepared.taskHash, txHash: hash, poster: deps.poster, body: { ...prepared.indexBody, txHash: hash, isUserOp: false } });
    say({ state: 'sending', taskHash: prepared.taskHash, txHash: hash });
  };
  // Write-ahead: 'sending' is in storage before the wallet has the
  // transaction, so a tab that closes from here on never re-funds this row.
  if (say({ state: 'sending', taskHash: prepared.taskHash }) === false) {
    say({ state: 'failed', taskHash: prepared.taskHash, error: UNSAVED });
    throw new PauseRun();
  }
  let funding: FundingResult;
  try {
    funding = await sendFunding(() => deps.send(call, onBroadcast), '[PostMany]');
  } catch (e) {
    const failure = sendFailure(e, broadcast);
    if (failure !== 'unconfirmed') {
      if (failure === 'unknown') {
        // Left 'sending', with no hash: never marked paid or unpaid here.
        say({ state: 'sending', taskHash: prepared.taskHash, error: maybeSent(deps.describe(e)) });
      } else {
        if (broadcast) deps.clearPending(prepared.taskHash);
        say({ state: 'failed', taskHash: prepared.taskHash, error: failure === 'reverted' ? reverted('this task') : nothingPaid(deps.describe(e), 'Nothing was paid for this task.') });
      }
      throw new PauseRun();
    }
    // Broadcast, then the wait failed: listed from the hash like any
    // unconfirmed send, and never sent again.
    console.warn(`[PostMany] Task TX broadcast (${broadcast}) but not confirmed:`, (e as Error)?.message);
    funding = { sent: { hash: broadcast!, receipt: null }, unconfirmed: true };
  }
  const { sent } = funding;
  const isUserOp = sent.userOp ?? false;
  // A hash with no receipt yet (the wait ran out) is not known to have paid.
  const unconfirmed = funding.unconfirmed || (!sent.receipt && !isUserOp);
  const indexBody = { ...prepared.indexBody, txHash: sent.hash, isUserOp };
  deps.savePending({ taskHash: prepared.taskHash, txHash: sent.hash, poster: deps.poster, body: indexBody });
  say({ state: 'listing', taskHash: prepared.taskHash, txHash: sent.hash });
  if (isUserOp) await deps.userOpDelay?.();

  const { resp, lastErr } = await deps.indexOne(indexBody);
  if (!resp) {
    say({
      state: 'unlisted',
      taskHash: prepared.taskHash,
      txHash: sent.hash,
      error: unconfirmed
        ? `Your wallet sent the payment but it isn't confirmed yet. Retry listing once it confirms; don't post this row again. (${deps.describe(lastErr)})`
        : `Paid, but not listed yet. Retry listing; posting this row again would fund a second escrow. (${deps.describe(lastErr)})`,
    });
    throw new PauseRun();
  }
  deps.clearPending(prepared.taskHash);
  say({ state: 'done', taskHash: prepared.taskHash, txHash: sent.hash, taskId: resp.onChainTaskId ?? null });
}

async function fundChunk(chunk: EngineRow[], deps: BulkDeps, opts: BulkOptions, getExecutors: () => Promise<Executor[]>): Promise<void> {
  const say = (row: EngineRow, s: RowStatus) => opts.onStatus(row.fingerprint, s);
  const staged: Array<Omit<PreparedRow, 'createBody' | 'indexBody'> & { build: (rootHash: string) => Pick<PreparedRow, 'createBody' | 'indexBody'> }> = [];
  for (const row of chunk) {
    say(row, { state: 'preparing' });
    try {
      staged.push(await prepareRow(row, deps, getExecutors));
    } catch (e) {
      say(row, { state: 'failed', error: e instanceof RowError ? e.message : nothingPaid(deps.describe(e)) });
    }
  }
  if (staged.length === 0) return;

  let prepared: PreparedRow[];
  let call: CheckedCall;
  try {
    const rootHashes = await deps.uploadMany(staged.map((s) => s.blob));
    prepared = staged.map((s, i) => ({ ...s, ...s.build(rootHashes[i]) }));
    for (const p of prepared) say(p.row, { state: 'funding', taskHash: p.taskHash });
    // POST /tasks/batch takes the token once for the whole batch.
    const built = await deps.buildBatch(prepared.map((p) => {
      const { token: _t, ...task } = p.createBody;
      return task;
    }));
    // The calldata itself, task by task: the answer's own list of task
    // hashes says nothing about what the transaction does.
    call = checkBulkCall(built, { fn: 'createTasks', tasks: prepared.map((p) => p.task) }, deps.pins);
  } catch (e) {
    const message = failedBeforeFunding(e, deps);
    for (const s of staged) say(s.row, { state: 'failed', taskHash: s.taskHash, error: message });
    stopOnMismatch(e);
    throw new PauseRun();
  }

  let broadcast = null as string | null;
  const onBroadcast = (hash: string) => {
    broadcast = hash;
    for (const p of prepared) {
      deps.savePending({ taskHash: p.taskHash, txHash: hash, poster: deps.poster, body: { ...p.indexBody, txHash: hash, isUserOp: false }, route: 'batch' });
      say(p.row, { state: 'sending', taskHash: p.taskHash, txHash: hash });
    }
  };
  // Write-ahead, as in fundOne: every row of the chunk, before the wallet has it.
  const marked = prepared.map((p) => say(p.row, { state: 'sending', taskHash: p.taskHash }));
  if (marked.includes(false)) {
    for (const p of prepared) say(p.row, { state: 'failed', taskHash: p.taskHash, error: UNSAVED });
    throw new PauseRun();
  }
  let funding: FundingResult;
  try {
    funding = await sendFunding(() => deps.send(call, onBroadcast), '[PostMany]');
  } catch (e) {
    const failure = sendFailure(e, broadcast);
    if (failure !== 'unconfirmed') {
      for (const p of prepared) {
        if (failure === 'unknown') {
          say(p.row, { state: 'sending', taskHash: p.taskHash, error: maybeSent(deps.describe(e)) });
          continue;
        }
        if (broadcast) deps.clearPending(p.taskHash);
        say(p.row, { state: 'failed', taskHash: p.taskHash, error: failure === 'reverted' ? reverted('these tasks') : nothingPaid(deps.describe(e), 'Nothing was paid for these tasks.') });
      }
      throw new PauseRun();
    }
    console.warn(`[PostMany] Batch TX broadcast (${broadcast}) but not confirmed:`, (e as Error)?.message);
    funding = { sent: { hash: broadcast!, receipt: null }, unconfirmed: true };
  }
  const { sent } = funding;
  const isUserOp = sent.userOp ?? false;
  const unconfirmed = funding.unconfirmed || (!sent.receipt && !isUserOp);
  for (const p of prepared) {
    deps.savePending({ taskHash: p.taskHash, txHash: sent.hash, poster: deps.poster, body: { ...p.indexBody, txHash: sent.hash, isUserOp }, route: 'batch' });
    say(p.row, { state: 'listing', taskHash: p.taskHash, txHash: sent.hash });
  }
  if (isUserOp) await deps.userOpDelay?.();

  const { resp, lastErr } = await deps.indexBatch(sent.hash, isUserOp, prepared.map((p) => p.indexBody));
  const byHash = new Map((resp?.results ?? []).map((r) => [r.taskHash.toLowerCase(), r]));
  let anyUnlisted = false;
  for (const p of prepared) {
    const result = byHash.get(p.taskHash.toLowerCase());
    if (result && 'indexed' in result && result.indexed) {
      deps.clearPending(p.taskHash);
      say(p.row, { state: 'done', taskHash: p.taskHash, txHash: sent.hash, taskId: result.onChainTaskId ?? null });
      continue;
    }
    anyUnlisted = true;
    const why = result && 'error' in result ? result.error.message : deps.describe(lastErr);
    say(p.row, {
      state: 'unlisted',
      taskHash: p.taskHash,
      txHash: sent.hash,
      error: unconfirmed
        ? `Your wallet sent the payment but it isn't confirmed yet. Retry listing once it confirms; don't post this row again. (${why})`
        : `Paid, but not listed yet. Retry listing; posting this row again would fund a second escrow. (${why})`,
    });
  }
  if (anyUnlisted) throw new PauseRun();
}
