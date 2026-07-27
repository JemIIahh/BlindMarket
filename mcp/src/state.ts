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

export type SpendStage = 'created' | 'funded' | 'indexed';

export interface SpendRecord {
  idempotencyKey: string;
  kind: 'rent' | 'post';
  stage: SpendStage;
  taskHash?: string;
  txHash?: string;
  rootHash?: string;
  serviceId?: number;
  targetExecutor?: string;
  privacy?: 'private' | 'public';
  /** hex AES key for a private task — kept ONLY so a crash between upload and
   *  index can re-wrap; removed once the task is indexed. */
  aesKeyHex?: string;
  wrappedKeys?: Record<string, string>;
  publicBrief?: string;
  verificationMode?: string;
  verificationCriteria?: unknown;
  requiredCapabilities?: string[];
  amountWei?: string;
  durationSecs?: number;
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

export interface Quote {
  quoteId: string;
  kind: 'rent' | 'post';
  summary: Record<string, unknown>;
  expiresAt: number;
}

const QUOTE_TTL_MS = 10 * 60 * 1000;
const quotes = new Map<string, Quote>();

export function createQuote(kind: 'rent' | 'post', summary: Record<string, unknown>): Quote {
  const quote: Quote = {
    quoteId: crypto.randomBytes(8).toString('hex'),
    kind,
    summary,
    expiresAt: Date.now() + QUOTE_TTL_MS,
  };
  quotes.set(quote.quoteId, quote);
  return quote;
}

export function consumeQuote(quoteId: string, kind: 'rent' | 'post'): Quote | null {
  const quote = quotes.get(quoteId);
  if (!quote || quote.kind !== kind || quote.expiresAt < Date.now()) return null;
  quotes.delete(quoteId); // single use
  return quote;
}
