import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/**
 * Local spend ledger for idempotent money movement.
 *
 * Every spending tool call carries a required idempotencyKey. Each spend
 * advances through created → funded → indexed; the record persists the
 * taskHash + funding txHash the moment they exist, so a crash between the
 * funding tx and /a2a/tasks/index is resumable (re-run the index with the
 * saved txHash) instead of double-funding a second escrow.
 */

/** created → funded → indexed is the escrow-funding path (rent/post). On
 *  Base there is an extra 'approved' between created and funded: the USDC
 *  approve is its own transaction, and a crash after it must not re-approve.
 *  created → sent → confirmed is the refund path (cancel/timeout), which has
 *  nothing to index — the money moves back on the one transaction. */
export type SpendStage = 'created' | 'approved' | 'funded' | 'indexed' | 'sent' | 'confirmed';

/** Every kind moves money and so carries an idempotencyKey: rent/post pay it
 *  out of the wallet, cancel/timeout pull it back, deploy pays the agent
 *  deploy fee (created → sent once the fee transaction is broadcast →
 *  confirmed once the agent exists). 'post-batch' is a post_tasks call: it
 *  holds the one escrow approval for the rows still to fund, and each row is
 *  its own 'post' spend under `<idempotencyKey>#<row fingerprint>`.
 *  'deploy-batch' is a deploy_agents call: it holds which agents the key
 *  deploys (batchDigest), and each agent is its own 'deploy' spend under
 *  `<idempotencyKey>#<n>`, n counted from 1 as in the agent's name. */
export type SpendKind = 'rent' | 'post' | 'post-batch' | 'cancel' | 'timeout' | 'deploy' | 'deploy-batch';

export interface SpendRecord {
  idempotencyKey: string;
  kind: SpendKind;
  stage: SpendStage;
  taskHash?: string;
  /** on-chain numeric task id — the refund routes address tasks by id, not hash */
  taskId?: number;
  /** claim_timeout: the task's on-chain status when the claim was made. A
   *  Submitted (2) task ends Disputed, not Cancelled, on an escrow that sends
   *  work delivered before the deadline and never judged for review. */
  fromStatus?: number;
  /** A confirmed refund: 'refund' returned the escrow, 'escalate' sent the
   *  task for review and refunded nothing. */
  outcome?: 'refund' | 'escalate';
  txHash?: string;
  /** which chain this spend settles on — decides local-sign vs relay on resume */
  /** the backend chain key the spend started on ('0g', 'base', …) */
  settlement?: string;
  /** the chain id it started on: a key keeps its name on another network
   *  (Arc Testnet 5042002 and Arc mainnet 5042 are both 'arc') */
  chainId?: number;
  /** escrow token: zero address for native 0G, the ERC-20 (USDC) address on a relay chain */
  token?: string;
  /** Base only: the USDC approve tx, persisted so a resume never re-approves */
  approveTxHash?: string;
  /** Base only: relay returned an ERC-4337 user-op hash, not a tx hash —
   *  getTransactionReceipt on it is always null, so waits go by state instead */
  isUserOp?: boolean;
  /** Base only: how the relay paid gas, as reported by the backend. Persisted
   *  so a resumed spend reports the truth rather than re-guessing. */
  gas?: 'user-pays' | 'app-pays' | 'wallet-pays';
  rootHash?: string;
  serviceId?: number;
  targetExecutor?: string;
  privacy?: 'private' | 'public';
  /** hex AES key for a private task — kept ONLY so a crash between upload and
   *  index can re-wrap; removed once the task is indexed. */
  aesKeyHex?: string;
  wrappedKeys?: Record<string, string>;
  publicBrief?: string;
  /** The public one-liner the task board shows (all it shows of a private task). */
  routingSummary?: string;
  verificationMode?: string;
  verificationCriteria?: unknown;
  requiredCapabilities?: string[];
  amountWei?: string;
  durationSecs?: number;
  /** deploy only: the agent the fee paid for */
  agentId?: string;
  /** deploy-batch only: sha256 of the agents' template (name, instructions,
   *  provider, model, skills). A re-call with the key may change the count,
   *  never the agents. */
  batchDigest?: string;
  createdAt: string;
  updatedAt: string;
}

const STATE_DIR = process.env.BLINDMARKET_STATE_DIR ?? path.join(os.homedir(), '.blindmarket');
const STATE_FILE = path.join(STATE_DIR, 'mcp-state.json');

interface StateFile { spends: Record<string, SpendRecord> }

function load(): StateFile {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as StateFile;
  } catch {
    return { spends: {} };
  }
}

function save(state: StateFile): void {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}

export function getSpend(idempotencyKey: string): SpendRecord | undefined {
  return load().spends[idempotencyKey];
}

export function putSpend(record: SpendRecord): void {
  const state = load();
  state.spends[record.idempotencyKey] = { ...record, updatedAt: new Date().toISOString() };
  save(state);
}

export function updateSpend(idempotencyKey: string, patch: Partial<SpendRecord>): SpendRecord {
  const state = load();
  const existing = state.spends[idempotencyKey];
  if (!existing) throw new Error(`No spend record for idempotency key ${idempotencyKey}`);
  const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  // Once indexed, the AES key has served its purpose — drop it from disk.
  if (updated.stage === 'indexed') delete updated.aesKeyHex;
  state.spends[idempotencyKey] = updated;
  save(state);
  return updated;
}

// ── Quotes (in-memory, short-lived) ─────────────────────────────────────────
// Spending tools are two-step: a call without confirm returns a quote +
// quoteId; the spend only executes when re-called with confirm:true and that
// quoteId. Harness-agnostic human-in-the-loop (MCP elicitation support is
// spotty across clients).
//
// A quote authorizes exactly the spend it quoted, not "some spend of this
// kind". Each tool normalizes what it is about to spend (amount in base
// units, chain, token, escrow, payer, the service and its price, the task,
// the fee terms, a hash of the brief …) into SpendFields, both when it quotes
// and again on confirm after every lookup and before anything is uploaded,
// approved or sent. consumeQuote compares the two: a listing re-priced in
// between, a different amount or task, or a settlement that moved under the
// quote refuses with QUOTE_MISMATCH and nothing is sent. Without this the
// confirm spent whatever its own arguments and the backend's answers said at
// that moment (security audit run 1, C20).

/** One normalized spend: every value that decides what a confirm moves.
 *  Free text (a prompt, instructions) goes in as a hash, never in the clear. */
export type SpendFields = Record<string, string | number | boolean | null | undefined>;

export interface Quote {
  quoteId: string;
  kind: SpendKind;
  summary: Record<string, unknown>;
  /** sha256 of the canonical spend this quote authorizes (spendBinding). */
  binding: string;
  /** The normalized spend itself, kept only to say what changed on a mismatch. */
  spend: SpendFields;
  expiresAt: number;
}

const QUOTE_TTL_MS = 10 * 60 * 1000;
const quotes = new Map<string, Quote>();

/** Canonical digest of exactly what a confirm may spend: key order and
 *  undefined-vs-null do not matter, every value does. */
export function spendBinding(kind: SpendKind, spend: SpendFields): string {
  const canon = JSON.stringify([kind, Object.keys(spend).sort().map((k) => [k, spend[k] ?? null])]);
  return crypto.createHash('sha256').update(canon).digest('hex');
}

export function createQuote(kind: SpendKind, summary: Record<string, unknown>, spend: SpendFields): Quote {
  const quote: Quote = {
    quoteId: crypto.randomBytes(8).toString('hex'),
    kind,
    summary,
    binding: spendBinding(kind, spend),
    spend: { ...spend },
    expiresAt: Date.now() + QUOTE_TTL_MS,
  };
  quotes.set(quote.quoteId, quote);
  return quote;
}

export type QuoteCheck =
  | { ok: true; quote: Quote }
  /** No such quote, another kind's, expired, or already used. */
  | { ok: false; code: 'QUOTE_REQUIRED' }
  /** The confirm would spend something other than what was quoted. */
  | { ok: false; code: 'QUOTE_MISMATCH'; quote: Quote; changed: string[] };

/**
 * Check a confirm against its quote. Single use: a quote is consumed whether
 * or not the confirm matches it, so a mismatch always needs a fresh quote the
 * caller can look at before confirming.
 */
export function consumeQuote(quoteId: string | undefined, kind: SpendKind, spend: SpendFields): QuoteCheck {
  const quote = quoteId ? quotes.get(quoteId) : undefined;
  if (!quote || quote.kind !== kind || quote.expiresAt < Date.now()) return { ok: false, code: 'QUOTE_REQUIRED' };
  quotes.delete(quote.quoteId); // single use, matched or not
  if (quote.binding === spendBinding(kind, spend)) return { ok: true, quote };
  const keys = new Set([...Object.keys(quote.spend), ...Object.keys(spend)]);
  const changed = [...keys].filter((k) => (quote.spend[k] ?? null) !== (spend[k] ?? null)).sort();
  return { ok: false, code: 'QUOTE_MISMATCH', quote, changed };
}
