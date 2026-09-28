/**
 * Rows for bulk posting (docs/BULK-POSTING.md): parse a CSV or JSONL file,
 * check each row, fill a saved template from a row's variables, and add up
 * what the run will cost. Pure functions: the page and its tests share them.
 *
 * Column rules match the CLI's `blind post-tasks`: a header row is required,
 * names are case-insensitive, and JSONL rows use the same keys.
 */
import { parseUnits } from 'ethers';
import { AGENT_CAPABILITIES, type AgentCapability } from '../config/capabilities';
import { sha256, toBytes } from './crypto';

/** BlindEscrow.sol MIN_DEADLINE / MAX_DEADLINE, in seconds. */
export const MIN_DURATION_SECONDS = 60 * 60;
export const MAX_DURATION_SECONDS = 90 * 24 * 60 * 60;
export const DEFAULT_DURATION_SECONDS = 24 * 60 * 60;
/** A file past this is almost certainly a mistake; split it. */
export const MAX_ROWS = 1000;
/** Keeps a batch of briefs under the API's 2 MB request limit. */
export const MAX_BRIEF_CHARS = 20_000;

export const KNOWN_COLUMNS = [
  'instructions', 'instructions_file', 'reward', 'amount', 'duration', 'privacy',
  'verification', 'zone', 'routing_summary', 'capabilities', 'target',
] as const;

/** A data row as read: lowercased column name → text. */
export type RawRow = Record<string, string>;

export interface RowIssue {
  /** 1-based data row (the header is row 0). 0 for a file-level problem. */
  row: number;
  message: string;
}

export interface ParsedFile {
  format: 'csv' | 'jsonl';
  rows: RawRow[];
  issues: RowIssue[];
  /** Header names this page doesn't use; shown so a typo is noticed. */
  unknownColumns: string[];
}

export interface BulkRow {
  /** 1-based data row in the file. */
  row: number;
  instructions: string;
  amountRaw: bigint;
  durationSeconds: number;
  privacy: 'public' | 'private';
  verification: 'auto' | 'manual';
  zone: string;
  routingSummary?: string;
  capabilities: AgentCapability[];
  /** Lowercased: the only executor that may take it. */
  target?: string;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/** CSV, unless the name or the first character says JSONL. */
export function detectFormat(text: string, fileName?: string): 'csv' | 'jsonl' {
  const name = fileName?.toLowerCase() ?? '';
  if (name.endsWith('.jsonl') || name.endsWith('.ndjson')) return 'jsonl';
  if (name.endsWith('.csv')) return 'csv';
  return text.replace(/^\uFEFF/, '').trimStart().startsWith('{') ? 'jsonl' : 'csv';
}

/**
 * RFC 4180 records: commas between fields, CRLF or LF between records, quoted
 * fields may hold commas, line breaks and doubled quotes. A leading BOM is
 * dropped and blank lines are skipped. Throws on an unterminated quote or
 * text after a closing quote, naming the record.
 */
export function parseCsvRecords(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;
  let i = 0;
  const endRecord = () => {
    record.push(field);
    // A blank line reads as one empty field: skip it.
    if (!(record.length === 1 && record[0] === '' && !fieldStarted)) records.push(record);
    record = [];
    field = '';
    fieldStarted = false;
  };
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        const next = src[i];
        if (next !== undefined && next !== ',' && next !== '\n' && next !== '\r') {
          throw new Error(`Record ${records.length + 1}: text after a closing quote`);
        }
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      fieldStarted = true;
      i++;
      continue;
    }
    if (ch === ',') {
      record.push(field);
      field = '';
      fieldStarted = true;
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      endRecord();
      i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch;
    fieldStarted = true;
    i++;
  }
  if (quoted) throw new Error(`Record ${records.length + 1}: a quoted field is never closed`);
  if (field !== '' || record.length > 0 || fieldStarted) endRecord();
  return records;
}

function withKnownColumns(header: string[]): { issues: RowIssue[]; unknownColumns: string[] } {
  const issues: RowIssue[] = [];
  const seen = new Set<string>();
  for (const name of header) {
    if (seen.has(name)) issues.push({ row: 0, message: `The column "${name}" appears twice.` });
    seen.add(name);
  }
  const known = new Set<string>(KNOWN_COLUMNS);
  return { issues, unknownColumns: header.filter((h) => h !== '' && !known.has(h)) };
}

function csvRows(text: string): ParsedFile {
  let records: string[][];
  try {
    records = parseCsvRecords(text);
  } catch (e) {
    return { format: 'csv', rows: [], issues: [{ row: 0, message: `${(e as Error).message}.` }], unknownColumns: [] };
  }
  if (records.length === 0) return { format: 'csv', rows: [], issues: [{ row: 0, message: 'The file is empty.' }], unknownColumns: [] };
  const header = records[0].map((h) => h.trim().toLowerCase());
  const { issues, unknownColumns } = withKnownColumns(header);
  const rows: RawRow[] = [];
  records.slice(1).forEach((rec, idx) => {
    const row = idx + 1;
    if (rec.length > header.length) {
      issues.push({ row, message: `It has ${rec.length} values but the header has ${header.length} columns.` });
    }
    const out: RawRow = {};
    header.forEach((name, col) => {
      if (name) out[name] = rec[col] ?? '';
    });
    rows.push(out);
  });
  return { format: 'csv', rows, issues, unknownColumns };
}

function jsonlRows(text: string): ParsedFile {
  const issues: RowIssue[] = [];
  const rows: RawRow[] = [];
  const header = new Set<string>();
  text.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((line) => {
    if (line.trim() === '') return;
    const row = rows.length + 1;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      issues.push({ row, message: 'Not valid JSON.' });
      rows.push({});
      return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      issues.push({ row, message: 'Must be a JSON object.' });
      rows.push({});
      return;
    }
    const out: RawRow = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const name = k.trim().toLowerCase();
      header.add(name);
      out[name] = v === null || v === undefined ? '' : Array.isArray(v) ? v.map(String).join(';') : String(v);
    }
    rows.push(out);
  });
  if (rows.length === 0) issues.push({ row: 0, message: 'The file is empty.' });
  const known = new Set<string>(KNOWN_COLUMNS);
  return { format: 'jsonl', rows, issues, unknownColumns: [...header].filter((h) => !known.has(h)) };
}

/** Parse a CSV or JSONL file's text into raw rows, with file-level issues. */
export function parseBulkText(text: string, fileName?: string): ParsedFile {
  const parsed = detectFormat(text, fileName) === 'jsonl' ? jsonlRows(text) : csvRows(text);
  if (parsed.rows.length > MAX_ROWS) {
    return { ...parsed, rows: [], issues: [{ row: 0, message: `The file has ${parsed.rows.length} rows; the most one run posts is ${MAX_ROWS}. Split it into smaller files.` }] };
  }
  return parsed;
}

// ── Templates ────────────────────────────────────────────────────────────────

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_ -]+?)\s*\}\}/g;

/** Replace each `{{column}}` with that column's value (case-insensitive). */
export function fillTemplate(template: string, vars: RawRow): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const text = template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = vars[name.trim().toLowerCase()];
    if (value === undefined || value.trim() === '') {
      missing.add(name.trim());
      return whole;
    }
    return value;
  });
  return { text, missing: [...missing] };
}

/** The `{{column}}` names a template uses. */
export function templateVariables(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1].trim().toLowerCase()))];
}

/**
 * Rows built from a saved template: each row's variables fill the template's
 * brief (a row that brings its own `instructions` keeps them), and a row
 * with no reward or amount takes the template's suggested reward.
 */
export function applyTemplate(rows: RawRow[], template: { description: string; suggested_reward: string | null }): { rows: RawRow[]; issues: RowIssue[] } {
  const issues: RowIssue[] = [];
  const out = rows.map((raw, idx) => {
    const row = idx + 1;
    const next: RawRow = { ...raw };
    if (!raw.instructions?.trim()) {
      const { text, missing } = fillTemplate(template.description, raw);
      if (missing.length > 0) {
        issues.push({ row, message: `No value for ${missing.map((m) => `{{${m}}}`).join(', ')}.` });
      }
      next.instructions = text;
    }
    if (!raw.reward?.trim() && !raw.amount?.trim() && template.suggested_reward) next.reward = template.suggested_reward;
    return next;
  });
  return { rows: out, issues };
}

// ── Validation ───────────────────────────────────────────────────────────────

const CAPS = new Set<string>(AGENT_CAPABILITIES);

/** One row checked against the column rules; problems are plain sentences. */
export function validateRow(raw: RawRow, row: number, decimals: number, symbol: string): { value?: BulkRow; problems: string[] } {
  const problems: string[] = [];
  const get = (name: string) => (raw[name] ?? '').trim();

  if (get('instructions_file')) problems.push('instructions_file works in the CLI only; put the brief in an instructions column.');
  const instructions = get('instructions');
  if (!instructions) problems.push('The brief (instructions) is empty.');
  else if (instructions.length > MAX_BRIEF_CHARS) problems.push(`The brief is ${instructions.length.toLocaleString()} characters; the most is ${MAX_BRIEF_CHARS.toLocaleString()}.`);

  let amountRaw: bigint | undefined;
  const reward = get('reward');
  const amount = get('amount');
  if (reward && amount) problems.push('Give a reward or an amount, not both.');
  else if (!reward && !amount) problems.push(`Give a reward (e.g. 2.5 ${symbol}) or an amount in the smallest unit.`);
  else if (reward) {
    const places = reward.split('.')[1]?.length ?? 0;
    if (!/^\d+(\.\d+)?$/.test(reward)) problems.push(`The reward "${reward}" is not a number.`);
    else if (places > decimals) problems.push(`The reward has ${places} decimals; ${symbol} has ${decimals}.`);
    else amountRaw = parseUnits(reward, decimals);
  } else if (!/^\d+$/.test(amount)) problems.push(`The amount "${amount}" must be a whole number of the smallest unit.`);
  else amountRaw = BigInt(amount);
  if (amountRaw !== undefined && amountRaw <= 0n) problems.push('The reward must be more than zero.');

  let durationSeconds = DEFAULT_DURATION_SECONDS;
  const duration = get('duration');
  if (duration) {
    if (!/^\d+$/.test(duration)) problems.push(`The duration "${duration}" must be whole seconds.`);
    else {
      durationSeconds = Number(duration);
      if (durationSeconds < MIN_DURATION_SECONDS || durationSeconds > MAX_DURATION_SECONDS) {
        problems.push(`The duration must be between ${MIN_DURATION_SECONDS} seconds (1 hour) and ${MAX_DURATION_SECONDS} (90 days).`);
      }
    }
  }

  const privacyText = get('privacy').toLowerCase() || 'private';
  if (privacyText !== 'public' && privacyText !== 'private') problems.push(`Privacy must be public or private, not "${get('privacy')}".`);
  const verificationText = get('verification').toLowerCase() || 'auto';
  if (verificationText !== 'auto' && verificationText !== 'manual') problems.push(`Verification must be auto or manual, not "${get('verification')}".`);

  const zone = get('zone') || 'global';
  if (zone.length > 128) problems.push('The zone is longer than 128 characters.');

  const routingSummary = get('routing_summary');
  if (routingSummary.length > 500) problems.push('The routing summary is longer than 500 characters.');

  const capabilities = [...new Set(get('capabilities').split(';').map((c) => c.trim().toLowerCase()).filter(Boolean))];
  const badCaps = capabilities.filter((c) => !CAPS.has(c));
  if (badCaps.length > 0) problems.push(`Unknown capabilities: ${badCaps.join(', ')}.`);

  const target = get('target');
  if (target && !/^0x[0-9a-fA-F]{40}$/.test(target)) problems.push(`The target "${target}" is not a 0x wallet address.`);

  if (problems.length > 0 || amountRaw === undefined) return { problems };
  return {
    problems,
    value: {
      row,
      instructions,
      amountRaw,
      durationSeconds,
      privacy: privacyText as 'public' | 'private',
      verification: verificationText as 'auto' | 'manual',
      zone,
      ...(routingSummary ? { routingSummary } : {}),
      capabilities: capabilities as AgentCapability[],
      ...(target ? { target: target.toLowerCase() } : {}),
    },
  };
}

/** What identifies a row across reloads: its content, never its position. */
export async function rowFingerprint(row: BulkRow): Promise<string> {
  const parts = [
    row.instructions, row.amountRaw.toString(), row.durationSeconds, row.privacy, row.verification,
    row.zone, row.routingSummary ?? '', row.capabilities.join(';'), row.target ?? '',
  ];
  return sha256(toBytes(JSON.stringify(parts)));
}

export interface CheckedRows {
  rows: Array<BulkRow & { fingerprint: string }>;
  /** Per row: that row's problems, including being a duplicate. */
  issues: RowIssue[];
}

/** Every row checked, duplicates flagged (they would be one task twice). */
export async function checkRows(raw: RawRow[], decimals: number, symbol: string): Promise<CheckedRows> {
  const rows: CheckedRows['rows'] = [];
  const issues: RowIssue[] = [];
  const firstRowOf = new Map<string, number>();
  for (let i = 0; i < raw.length; i++) {
    const row = i + 1;
    const { value, problems } = validateRow(raw[i], row, decimals, symbol);
    for (const message of problems) issues.push({ row, message });
    if (!value) continue;
    const fingerprint = await rowFingerprint(value);
    const first = firstRowOf.get(fingerprint);
    if (first !== undefined) {
      issues.push({ row, message: `Same as row ${first}; remove the duplicate.` });
      continue;
    }
    firstRowOf.set(fingerprint, row);
    rows.push({ ...value, fingerprint });
  }
  return { rows, issues };
}

// ── Totals ───────────────────────────────────────────────────────────────────

export interface BulkTotals {
  count: number;
  totalRaw: bigint;
  publicCount: number;
  privateCount: number;
}

export function bulkTotals(rows: BulkRow[]): BulkTotals {
  return rows.reduce<BulkTotals>(
    (t, r) => ({
      count: t.count + 1,
      totalRaw: t.totalRaw + r.amountRaw,
      publicCount: t.publicCount + (r.privacy === 'public' ? 1 : 0),
      privateCount: t.privateCount + (r.privacy === 'private' ? 1 : 0),
    }),
    { count: 0, totalRaw: 0n, publicCount: 0, privateCount: 0 },
  );
}

/** How many transactions a run sends, and how many of them the wallet asks about. */
export function plannedTransactions(
  count: number,
  opts: { batch: { supported: boolean; maxBatch: number }; chunkSize: number; needsApproval: boolean; promptsPerTx: boolean },
): { transactions: number; walletPrompts: number; chunk: number } {
  const chunk = opts.batch.supported ? Math.max(1, Math.min(opts.chunkSize, opts.batch.maxBatch)) : 1;
  const funding = count === 0 ? 0 : Math.ceil(count / chunk);
  const transactions = funding + (opts.needsApproval && count > 0 ? 1 : 0);
  return { transactions, walletPrompts: opts.promptsPerTx ? transactions : 0, chunk };
}

// ── Files ────────────────────────────────────────────────────────────────────

export const EXAMPLE_CSV = [
  'instructions,reward,duration,privacy,verification,zone,routing_summary,capabilities',
  '"Summarise this article in five bullet points: https://example.com/post",0.5,86400,public,auto,global,,summarization',
  '"Translate the product description below into French, keeping the tone:\n""Light, warm and made to last.""",1.25,172800,private,auto,global,French translation of a short product text,translation',
  '"Find three competitors for a meal-kit startup in Lagos and list their prices",2,259200,public,manual,NG,,market_research;web_research',
].join('\n') + '\n';

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export interface ResultLine {
  row: number;
  status: string;
  taskHash?: string;
  taskId?: string | null;
  txHash?: string;
  error?: string;
}

/** The run's outcome as a CSV to keep: one line per row. */
export function resultsCsv(lines: ResultLine[]): string {
  const out = ['row,status,task_hash,task_id,tx_hash,error'];
  for (const l of lines) {
    out.push([String(l.row), l.status, l.taskHash ?? '', l.taskId ?? '', l.txHash ?? '', l.error ?? ''].map(csvCell).join(','));
  }
  return out.join('\n') + '\n';
}

/** The first line of a brief, for a table cell. */
export function briefTitle(instructions: string, max = 90): string {
  const first = instructions.split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? '';
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}
