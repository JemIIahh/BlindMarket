import { readFileSync } from 'fs';
import { dirname, extname, resolve } from 'path';
import { createHash } from 'crypto';
import { parseUnits } from 'ethers';
import type { AgentCapability, PostTaskParams } from '@blindmarket/sdk';
import { CliError } from './errors.js';

/**
 * The task file `blind post-tasks` reads: CSV with a header row, or JSON
 * Lines (one object per line) for a .jsonl / .ndjson file. Every row is
 * checked here, with its line number, before anything reaches the backend;
 * the SDK checks them again, with the executors and the escrow in view.
 */

/** Columns a task file may have (docs/BULK-POSTING.md). Header names ignore case, spaces and dashes. */
export const COLUMNS = [
  'instructions', 'instructions_file', 'reward', 'amount', 'duration', 'privacy',
  'verification', 'zone', 'routing_summary', 'capabilities', 'target',
] as const;
type Column = (typeof COLUMNS)[number];

export interface CsvRecord {
  /** The line the record starts on (a quoted field can span lines). */
  line: number;
  fields: string[];
}

/**
 * RFC 4180 CSV: comma-separated, a field in double quotes may hold commas,
 * line breaks and doubled quotes (""), and lines end in LF or CRLF. Spaces
 * around a quoted field are dropped (spreadsheets add none; hand-written
 * files do). Throws BAD_CSV naming the line.
 */
export function parseCsv(text: string): CsvRecord[] {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false; // the current field was quoted
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  const endField = () => { fields.push(field); field = ''; quoted = false; };
  const endRecord = () => { endField(); records.push({ line: recordLine, fields }); fields = []; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === ',') { endField(); continue; }
    if (c === '\n') { endRecord(); line++; recordLine = line; continue; }
    if (quoted) {
      if (c === ' ' || c === '\t') continue;
      throw new CliError('BAD_CSV', `Line ${line}: text after a closing quote. Quote the whole field, and double any quote inside it ("").`);
    }
    if (c === '"') {
      if (field.trim() !== '') throw new CliError('BAD_CSV', `Line ${line}: a quote inside an unquoted field. Quote the whole field, and double any quote inside it ("").`);
      field = '';
      quoted = true;
      inQuotes = true;
      continue;
    }
    field += c;
  }
  if (inQuotes) throw new CliError('BAD_CSV', `Line ${recordLine}: a quoted field is never closed.`);
  if (field !== '' || quoted || fields.length > 0) endRecord();
  return records;
}

/** One field as CSV writes it: quoted when it holds a comma, a quote or a line break. */
export function csvField(value: unknown): string {
  const s = value === undefined || value === null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const normalizeHeader = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, '_');

/** A task file's rows as column → value, each with the line it came from. Throws on a file that cannot be read as a table. */
export function readTaskFile(path: string): { rows: Array<{ line: number; values: Partial<Record<Column, unknown>> }>; format: 'csv' | 'jsonl' } {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (e) {
    throw new CliError('FILE_UNREADABLE', `Could not read ${path}: ${(e as Error).message}`);
  }
  const ext = extname(path).toLowerCase();
  if (ext === '.jsonl' || ext === '.ndjson') return { rows: readJsonl(text), format: 'jsonl' };
  return { rows: readCsv(text), format: 'csv' };
}

function checkColumns(names: string[], where: string): Column[] {
  const unknown = names.filter((n) => !(COLUMNS as readonly string[]).includes(n));
  if (unknown.length > 0) {
    throw new CliError('BAD_COLUMNS', `${where}: unknown column${unknown.length > 1 ? 's' : ''} ${unknown.map((u) => `"${u}"`).join(', ')}. The columns are: ${COLUMNS.join(', ')}.`);
  }
  return names as Column[];
}

function readCsv(text: string) {
  const records = parseCsv(text);
  const headerAt = records.findIndex((r) => r.fields.some((f) => f.trim() !== ''));
  if (headerAt === -1) throw new CliError('EMPTY_FILE', 'The file has no header row and no tasks.');
  const header = records[headerAt];
  const names = header.fields.map(normalizeHeader);
  const dup = names.find((n, i) => n !== '' && names.indexOf(n) !== i);
  if (dup) throw new CliError('BAD_COLUMNS', `Line ${header.line}: the column "${dup}" appears twice.`);
  checkColumns(names.filter((n) => n !== ''), `Line ${header.line}`);
  const rows: Array<{ line: number; values: Partial<Record<Column, unknown>> }> = [];
  for (const record of records.slice(headerAt + 1)) {
    if (record.fields.every((f) => f.trim() === '')) continue; // a blank line
    if (record.fields.length > names.length) {
      throw new CliError('BAD_CSV', `Line ${record.line}: ${record.fields.length} fields, but the header has ${names.length}. Quote any field that holds a comma.`);
    }
    const values: Partial<Record<Column, unknown>> = {};
    record.fields.forEach((f, i) => { if (names[i]) values[names[i] as Column] = f; });
    rows.push({ line: record.line, values });
  }
  return rows;
}

function readJsonl(text: string) {
  const rows: Array<{ line: number; values: Partial<Record<Column, unknown>> }> = [];
  text.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    if (raw.trim() === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CliError('BAD_JSONL', `Line ${line}: not a JSON object.`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CliError('BAD_JSONL', `Line ${line}: not a JSON object.`);
    const values: Partial<Record<Column, unknown>> = {};
    const names = Object.keys(parsed).map(normalizeHeader);
    checkColumns(names, `Line ${line}`);
    Object.entries(parsed as Record<string, unknown>).forEach(([k, v]) => { values[normalizeHeader(k) as Column] = v; });
    rows.push({ line, values });
  });
  if (rows.length === 0) throw new CliError('EMPTY_FILE', 'The file has no tasks.');
  return rows;
}

/** One task, ready for postTasks(), with what the summary and the results file show. */
export interface TaskRow {
  line: number;
  params: PostTaskParams;
  amountRaw: bigint;
  /** Identifies the row across runs of the same file, so a re-run skips what was posted. */
  fingerprint: string;
}

export interface RowProblem {
  line: number;
  message: string;
}

const MIN_DURATION = 3_600;
const MAX_DURATION = 90 * 86_400;

const text = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'string' ? v : String(v));

/**
 * The file's rows as postTasks() takes them. Every problem is collected, not
 * just the first, so one fix pass covers the file. `instructions_file` is
 * read relative to the task file.
 */
export function toTaskRows(
  file: string,
  rows: Array<{ line: number; values: Partial<Record<Column, unknown>> }>,
  token: { decimals: number; symbol: string },
): { tasks: TaskRow[]; problems: RowProblem[] } {
  const baseDir = dirname(resolve(file));
  const tasks: TaskRow[] = [];
  const problems: RowProblem[] = [];
  const seen = new Map<string, number>();
  for (const { line, values } of rows) {
    const say: string[] = [];
    // The brief
    let instructions = text(values.instructions);
    const briefFile = text(values.instructions_file).trim();
    if (instructions.trim() && briefFile) say.push('has both instructions and instructions_file; keep one');
    else if (briefFile) {
      try {
        instructions = readFileSync(resolve(baseDir, briefFile), 'utf-8');
      } catch (e) {
        say.push(`instructions_file ${briefFile} could not be read (${(e as Error).message})`);
      }
    }
    if (!say.length && !instructions.trim()) say.push('has no instructions');

    // The escrow
    const reward = text(values.reward).trim();
    const amount = text(values.amount).trim();
    let amountRaw: bigint | undefined;
    if (!!reward === !!amount) say.push('needs exactly one of reward (in the token, e.g. 2.5) or amount (smallest unit)');
    else if (reward) {
      try {
        amountRaw = parseUnits(reward, token.decimals);
      } catch {
        say.push(`reward "${reward}" is not a ${token.symbol} amount with at most ${token.decimals} decimals`);
      }
    } else if (/^\d+$/.test(amount)) amountRaw = BigInt(amount);
    else say.push(`amount "${amount}" is not a whole number of the smallest unit`);
    if (amountRaw !== undefined && amountRaw <= 0n) say.push('the escrow must be above 0');

    // Everything else, with its default
    const durationText = text(values.duration).trim() || '86400';
    const duration = /^\d+$/.test(durationText) ? Number(durationText) : NaN;
    if (!Number.isInteger(duration) || duration < MIN_DURATION || duration > MAX_DURATION) say.push(`duration "${durationText}" must be whole seconds from 3600 (1 hour) to 7776000 (90 days)`);
    const privacy = (text(values.privacy).trim().toLowerCase() || 'private');
    if (privacy !== 'private' && privacy !== 'public') say.push(`privacy "${privacy}" must be public or private`);
    const verification = (text(values.verification).trim().toLowerCase() || 'auto');
    if (verification !== 'auto' && verification !== 'manual') say.push(`verification "${verification}" must be auto or manual`);
    const zone = text(values.zone).trim() || 'global';
    if (zone.length > 128) say.push('zone is longer than 128 characters');
    const routingSummary = text(values.routing_summary).trim();
    if (routingSummary.length > 500) say.push(`routing_summary is ${routingSummary.length} characters; the task board takes at most 500`);
    const caps = Array.isArray(values.capabilities)
      ? values.capabilities.map((c) => text(c).trim()).filter(Boolean)
      : text(values.capabilities).split(/[;,]/).map((c) => c.trim()).filter(Boolean);
    const target = text(values.target).trim();
    if (target && !/^0x[0-9a-fA-F]{40}$/.test(target)) say.push(`target "${target}" is not a 0x wallet address`);

    if (say.length > 0 || amountRaw === undefined) {
      problems.push({ line, message: say.join('; ') });
      continue;
    }
    const params: PostTaskParams = {
      instructions,
      amountRaw,
      durationSeconds: duration,
      privacy: privacy as 'private' | 'public',
      verificationMode: verification as 'auto' | 'manual',
      locationZone: zone,
      requiredCapabilities: caps as AgentCapability[],
      ...(routingSummary ? { routingSummary } : {}),
      ...(target ? { targetExecutor: target as `0x${string}` } : {}),
    };
    // The same row twice is two tasks: the nth copy gets its own fingerprint.
    const canonical = JSON.stringify([instructions, amountRaw.toString(), duration, privacy, verification, zone, routingSummary, [...caps].sort(), target.toLowerCase()]);
    const copy = seen.get(canonical) ?? 0;
    seen.set(canonical, copy + 1);
    const fingerprint = createHash('sha256').update(`${canonical}#${copy}`).digest('hex');
    tasks.push({ line, params, amountRaw, fingerprint });
  }
  return { tasks, problems };
}

/** Problems as the CLI prints them: the first `max`, then how many more. */
export function describeProblems(file: string, problems: RowProblem[], max = 20): string {
  const lines = problems.slice(0, max).map((p) => `  line ${p.line}: ${p.message}`);
  if (problems.length > max) lines.push(`  … and ${problems.length - max} more`);
  return `${problems.length} row${problems.length === 1 ? '' : 's'} in ${file} cannot be posted, so nothing was sent:\n${lines.join('\n')}`;
}
