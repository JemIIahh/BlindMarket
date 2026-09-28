/**
 * Checks a batch of tasks against docs/TASK-AUTHORING-STANDARD.md before any
 * USDC is spent on it.
 *
 *   npx tsx scripts/lint-task-batch.ts ../docs/examples/task-batch.example.json
 *
 * The file is a JSON array of task objects (or `{ "tasks": [...] }`). Exits 1
 * when any task has an error; warnings are printed but don't fail the run.
 *
 * Why: auto-verification treats every `contains_keywords` entry as a hard gate
 * (services/autoVerify.ts, GATED). A keyword the brief never asks for — the
 * brief says "buy-and-hold", the keyword is "buy and hold" — means a correct
 * deliverable can score above the threshold and still never be paid. The
 * routes only check that criteria are well-formed, not that they fit the
 * brief, so that mismatch has to be caught here.
 */
import { readFileSync } from 'node:fs';
import { verificationCriteriaSchema } from '../src/services/verificationCriteriaSchema.js';
import { AGENT_CAPABILITIES } from '../src/types.js';

/** BlindEscrow MIN_DEADLINE / MAX_DEADLINE, as the SDK's normalizePost checks them. */
const MIN_DURATION = 3_600;
const MAX_DURATION = 90 * 86_400;
/** USDC, the settlement token on Base. */
const DECIMALS = 6;
/** POST /a2a/tasks/index routingSummary cap. */
const MAX_ROUTING_SUMMARY = 500;
/** A public brief longer than this is cut on the board (sdk posting.ts publicBrief slice). */
const MAX_PUBLIC_BRIEF = 4_000;
const TITLE_MAX = 100;
/** Reward band per task (docs/TASK-AUTHORING-STANDARD.md), in USDC base units. */
const MIN_REWARD_RAW = 250_000n;
const MAX_REWARD_RAW = 500_000n;

const STANDARD_FORBIDDEN = [
  'unable to complete',
  'I cannot complete',
  'as an AI language model',
  'service unavailable',
  'lorem ipsum',
];

const REQUIRED_KEYS = [
  'idempotencyKey', 'title', 'instructions', 'privacy', 'locationZone', 'requiredCapabilities',
  'amount', 'amountRaw', 'durationSeconds', 'verificationMode', 'verificationCriteria',
] as const;

const KEY_ORDER = [...REQUIRED_KEYS.slice(0, 4), 'routingSummary', ...REQUIRED_KEYS.slice(4)];

const IDEMPOTENCY_KEY = /^bm-[a-z0-9]+(?:-[a-z0-9]+)*-\d{3,}$/;

type Task = Record<string, unknown>;
interface Issue { level: 'error' | 'warn'; message: string }

function toRaw(amount: string): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!m || (m[2]?.length ?? 0) > DECIMALS) return null;
  return BigInt(m[1]) * 10n ** BigInt(DECIMALS) + BigInt((m[2] ?? '').padEnd(DECIMALS, '0') || '0');
}

function lintTask(t: Task): Issue[] {
  const out: Issue[] = [];
  const err = (message: string) => out.push({ level: 'error', message });
  const warn = (message: string) => out.push({ level: 'warn', message });

  for (const key of REQUIRED_KEYS) if (t[key] === undefined) err(`missing "${key}"`);
  const unknown = Object.keys(t).filter((k) => !KEY_ORDER.includes(k));
  if (unknown.length) err(`unknown fields: ${unknown.join(', ')}`);
  const order = Object.keys(t).filter((k) => KEY_ORDER.includes(k));
  const expected = KEY_ORDER.filter((k) => k in t);
  if (order.join() !== expected.join()) warn(`fields out of order; expected ${expected.join(', ')}`);

  const title = typeof t.title === 'string' ? t.title.trim() : '';
  const instructions = typeof t.instructions === 'string' ? t.instructions : '';
  const brief = instructions.toLowerCase();

  if (typeof t.idempotencyKey === 'string' && !IDEMPOTENCY_KEY.test(t.idempotencyKey)) {
    err(`idempotencyKey "${t.idempotencyKey}" should look like bm-<batch>-<NNN>, e.g. bm-seed-v3-035`);
  }

  if (!title) err('title is empty');
  else if (title.length > TITLE_MAX) err(`title is ${title.length} characters; the board treats more than ${TITLE_MAX} as a paragraph`);
  if (!instructions.trim()) err('instructions are empty');
  else if (title && !instructions.startsWith(`${title}\n\n`)) {
    err('instructions must start with the title, then a blank line ("<title>\\n\\n<brief>"): the board takes its title from the first line');
  }

  const privacy = t.privacy;
  if (privacy !== 'public' && privacy !== 'private') err(`privacy must be "public" or "private", not ${JSON.stringify(privacy)}`);
  if (t.routingSummary === null) err('routingSummary is null; omit the field instead (the MCP post_tasks schema refuses null)');
  const summary = typeof t.routingSummary === 'string' ? t.routingSummary : '';
  if (privacy === 'private') {
    if (!summary.trim()) err('a private task needs a routingSummary: it is all the board shows and all the matcher reads');
    else {
      if (summary.length > MAX_ROUTING_SUMMARY) err(`routingSummary is ${summary.length} characters; the most is ${MAX_ROUTING_SUMMARY}`);
      if (title && !summary.startsWith(`${title}\n\n`)) err('routingSummary must be "<title>\\n\\n<one public line>" so the card shows a title and a description');
      else if (summary.trim() === title) err('routingSummary is only the title; add a public one-line description after a blank line');
    }
  } else if (privacy === 'public') {
    if (summary) warn('a public task\'s card shows its brief, so routingSummary is not needed; omit it');
    if (instructions.length > MAX_PUBLIC_BRIEF) warn(`public brief is ${instructions.length} characters; the board shows the first ${MAX_PUBLIC_BRIEF}`);
  }

  if (typeof t.locationZone !== 'string' || !(t.locationZone === 'global' || /^[A-Z]{2}$/.test(t.locationZone))) {
    err(`locationZone must be "global" or a 2-letter country code, not ${JSON.stringify(t.locationZone)}`);
  }

  if (!Array.isArray(t.requiredCapabilities)) err('requiredCapabilities must be a list (use [] for none)');
  else {
    const bad = t.requiredCapabilities.filter((c) => !(AGENT_CAPABILITIES as readonly unknown[]).includes(c));
    if (bad.length) err(`unknown capabilities: ${bad.join(', ')}`);
  }

  if (typeof t.amount !== 'string' || typeof t.amountRaw !== 'string') err('amount and amountRaw must both be strings');
  else {
    const raw = toRaw(t.amount);
    if (raw === null) err(`amount "${t.amount}" is not a USDC amount with at most ${DECIMALS} decimals`);
    else if (!/^\d+$/.test(t.amountRaw)) err(`amountRaw "${t.amountRaw}" must be whole base units`);
    else if (BigInt(t.amountRaw) !== raw) err(`amount "${t.amount}" is ${raw} base units but amountRaw is "${t.amountRaw}"; amountRaw is what gets escrowed`);
    else if (raw < MIN_REWARD_RAW || raw > MAX_REWARD_RAW) err(`amount "${t.amount}" is outside the 0.25–0.5 USDC range per task`);
  }

  const d = t.durationSeconds;
  if (typeof d !== 'number' || !Number.isInteger(d) || d < MIN_DURATION || d > MAX_DURATION) {
    err(`durationSeconds must be a whole number from ${MIN_DURATION} to ${MAX_DURATION}`);
  }

  if (t.verificationMode !== 'auto' && t.verificationMode !== 'manual') {
    err(`verificationMode must be "auto" or "manual", not ${JSON.stringify(t.verificationMode)}`);
  }

  const parsed = verificationCriteriaSchema.safeParse(t.verificationCriteria);
  if (!parsed.success) {
    err(`verificationCriteria is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    return out;
  }
  const c = parsed.data;
  if (t.verificationMode === 'auto') {
    if (!c.min_length || c.min_length <= 0) err('auto verification needs a min_length');
    if (!c.contains_keywords?.length) warn('no contains_keywords: only length separates work from filler');
  }
  if (c.pass_threshold !== undefined && c.pass_threshold !== 60) warn(`pass_threshold is ${c.pass_threshold}; the standard is 60`);

  for (const k of c.contains_keywords ?? []) {
    if (!brief.includes(k.toLowerCase())) {
      err(`keyword "${k}" is not in the instructions. Every keyword is a hard gate: ask for it in the brief word for word, or drop it`);
    }
  }
  if ((c.contains_keywords?.length ?? 0) > 3) warn(`${c.contains_keywords!.length} keywords; each one is a gate, so keep to 3 or fewer`);

  const forbidden = c.forbidden_phrases ?? [];
  const missing = STANDARD_FORBIDDEN.filter((p) => !forbidden.includes(p));
  if (missing.length) warn(`forbidden_phrases is missing the standard entries: ${missing.join(', ')}`);
  for (const p of forbidden) {
    if (brief.includes(p.toLowerCase())) err(`forbidden phrase "${p}" appears in the brief, so an answer that echoes the brief fails`);
  }

  const wordCap = /\bunder (\d+) words\b|\b(\d+)-word\b|\bin (\d+) words\b/i.exec(instructions);
  if (wordCap && c.min_length) {
    const words = Number(wordCap[1] ?? wordCap[2] ?? wordCap[3]);
    // ~5 characters a word, and leave room: the floor must sit well under the cap.
    if (c.min_length > words * 3) err(`min_length ${c.min_length} characters is too close to the ${words}-word limit (at most ${words * 3})`);
  }
  if (c.expected_answer) warn('expected_answer fails any output that also shows other numbers (worked steps): use it only for one-line answers');

  return out;
}

function main(): void {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: npx tsx scripts/lint-task-batch.ts <tasks.json>');
    process.exit(2);
  }
  const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const tasks = Array.isArray(data) ? data : (data as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) {
    console.error('The file must hold a JSON array of tasks, or { "tasks": [...] }.');
    process.exit(2);
  }

  let errors = 0;
  let warnings = 0;
  const keys = new Map<string, number>();
  const publicBriefs = new Map<string, number>();
  tasks.forEach((task, i) => {
    const t = (task ?? {}) as Task;
    const issues = lintTask(t);
    if (typeof t.idempotencyKey === 'string') {
      const first = keys.get(t.idempotencyKey);
      if (first !== undefined) issues.push({ level: 'error', message: `idempotencyKey repeats task ${first}` });
      else keys.set(t.idempotencyKey, i);
    }
    if (t.privacy === 'public' && typeof t.instructions === 'string') {
      const first = publicBriefs.get(t.instructions);
      if (first !== undefined) issues.push({ level: 'error', message: `same public brief as task ${first}; the market lists a brief once` });
      else publicBriefs.set(t.instructions, i);
    }
    if (issues.length === 0) return;
    console.log(`\n[${i}] ${String(t.idempotencyKey ?? '?')} — ${String(t.title ?? '(no title)')}`);
    for (const issue of issues) {
      console.log(`  ${issue.level === 'error' ? 'ERROR' : 'warn '} ${issue.message}`);
      if (issue.level === 'error') errors++;
      else warnings++;
    }
  });

  const total = tasks.reduce((sum: bigint, t) => {
    const raw = (t as Task)?.amountRaw;
    return typeof raw === 'string' && /^\d+$/.test(raw) ? sum + BigInt(raw) : sum;
  }, 0n);
  const whole = total / 10n ** BigInt(DECIMALS);
  const frac = (total % 10n ** BigInt(DECIMALS)).toString().padStart(DECIMALS, '0').replace(/0+$/, '');
  console.log(`\n${tasks.length} tasks, ${whole}${frac ? `.${frac}` : ''} USDC in escrow, ${errors} errors, ${warnings} warnings`);
  process.exit(errors > 0 ? 1 : 0);
}

main();
