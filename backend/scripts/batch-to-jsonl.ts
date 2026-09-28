/**
 * Turns a batch written to docs/TASK-AUTHORING-STANDARD.md into the JSONL the
 * web "Post many" page (/tasks/bulk) and `blind post-tasks` read, optionally
 * giving every task the same deadline date.
 *
 *   npx tsx scripts/batch-to-jsonl.ts ../docs/examples/task-batch.example.json --deadline 2026-11-30
 *   npx tsx scripts/batch-to-jsonl.ts <batch.json> --deadline 2026-11-30 --json   # same batch, for SDK postTasks()
 *
 * Why a script: the page reads CSV or JSONL (frontend/src/lib/bulkRows.ts), so
 * a pasted JSON array is read as CSV, one row per line. And the escrow takes a
 * duration in seconds from the moment of posting, not a date
 * (BlindEscrow createTask `duration`), so a fixed date has to be turned into
 * seconds just before posting.
 *
 * The deadline is set to 12:00 UTC on the given day. That shows as that date
 * from UTC-11 to UTC+11, and leaves about half a day for the post to happen
 * after this runs. Run it again if you post later than that.
 *
 * Output goes to stdout. The CSV/JSONL columns carry no verification criteria:
 * tasks posted that way are checked for length 10 only (docs/BULK-POSTING.md).
 */
import { readFileSync } from 'node:fs';

/** BlindEscrow MIN_DEADLINE / MAX_DEADLINE. */
const MIN_DURATION = 3_600;
const MAX_DURATION = 90 * 86_400;

type Task = Record<string, unknown>;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function durationUntil(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`--deadline "${date}" must be a date like 2026-11-30`);
  const target = Date.parse(`${date}T12:00:00Z`);
  if (Number.isNaN(target)) fail(`--deadline "${date}" is not a real date`);
  const seconds = Math.floor((target - Date.now()) / 1000);
  if (seconds < MIN_DURATION || seconds > MAX_DURATION) {
    fail(`--deadline ${date} is ${Math.round(seconds / 86_400)} days away; the escrow allows 1 hour to 90 days from posting`);
  }
  return seconds;
}

function main(): void {
  const usage = 'usage: npx tsx scripts/batch-to-jsonl.ts <batch.json> [--deadline YYYY-MM-DD] [--json]';
  let file: string | undefined;
  let deadline: string | undefined;
  let asJson = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--deadline') deadline = args[++i] ?? fail(usage);
    else if (args[i] === '--json') asJson = true;
    else if (!file && !args[i].startsWith('--')) file = args[i];
    else fail(usage);
  }
  if (!file) fail(usage);

  const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const tasks = Array.isArray(data) ? data : (data as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) fail('The file must hold a JSON array of tasks, or { "tasks": [...] }.');

  const duration = deadline ? durationUntil(deadline) : undefined;

  if (asJson) {
    const out = (tasks as Task[]).map((t) => (duration ? { ...t, durationSeconds: duration } : t));
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else {
    for (const t of tasks as Task[]) {
      const caps = Array.isArray(t.requiredCapabilities) ? t.requiredCapabilities.join(';') : '';
      const row = {
        instructions: t.instructions,
        reward: t.amount,
        duration: duration ?? t.durationSeconds,
        privacy: t.privacy,
        verification: t.verificationMode,
        zone: t.locationZone,
        ...(typeof t.routingSummary === 'string' && t.routingSummary ? { routing_summary: t.routingSummary } : {}),
        ...(caps ? { capabilities: caps } : {}),
      };
      process.stdout.write(`${JSON.stringify(row)}\n`);
    }
  }

  if (deadline) {
    console.error(`${tasks.length} tasks, deadline ${deadline} 12:00 UTC (duration ${duration}s). Post within 11 hours so it stays on ${deadline}, or run this again.`);
  }
}

main();
