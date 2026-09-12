import { pathToFileURL } from 'node:url';
import { WAITLIST_TASKS, listFrontOfLine, revokeTasks, type FrontOfLineRow, type WaitlistTask } from './store.js';
import { closeWaitlistPool } from './db.js';

/**
 * Waitlist admin — spot-check the front of the line before access goes out.
 *
 *   npm run waitlist:admin -- top [N] [--csv]       the first N in line (default 50)
 *   npm run waitlist:admin -- revoke <id> <task…>   take back tasks that didn't check out
 *
 * Uses the same WAITLIST_DATABASE_URL as the service. The checks themselves are
 * done by hand on X while logged in as @blindmarkt — X only shows a post's likes
 * to its author — using the followers list and the post's likes, reposts and
 * replies. Output includes emails: keep exports internal.
 */

export const X_ACCOUNT = 'blindmarkt';
/** The post the landing page asks people to like, repost and reply to — keep in sync with waitlist/index.html. */
export const X_POST_ID = '2098305130835607945';

export const CHECK_LINKS = {
  followers: `https://x.com/${X_ACCOUNT}/followers`,
  likes: `https://x.com/${X_ACCOUNT}/status/${X_POST_ID}/likes`,
  reposts: `https://x.com/${X_ACCOUNT}/status/${X_POST_ID}/retweets`,
  replies: `https://x.com/${X_ACCOUNT}/status/${X_POST_ID}`,
};

const USAGE = `usage:
  npm run waitlist:admin -- top [N] [--csv]       the first N in line (default 50)
  npm run waitlist:admin -- revoke <id> <task…>   tasks: ${WAITLIST_TASKS.join(', ')}`;

export type AdminCommand =
  | { kind: 'top'; limit: number; csv: boolean }
  | { kind: 'revoke'; id: number; tasks: WaitlistTask[] };

export function parseAdminArgs(argv: string[]): AdminCommand {
  const [cmd, ...rest] = argv;
  if (cmd === 'top') {
    const csv = rest.includes('--csv');
    const n = rest.find((a) => a !== '--csv');
    const limit = n === undefined ? 50 : Number(n);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error(`top: N must be a whole number from 1 to 10000, got "${n}"`);
    }
    return { kind: 'top', limit, csv };
  }
  if (cmd === 'revoke') {
    const [idArg, ...taskArgs] = rest;
    const id = Number(idArg);
    if (!Number.isInteger(id) || id < 1) {
      throw new Error(`revoke: <id> must be a signup id (the "id" column of top), got "${idArg ?? ''}"`);
    }
    if (!taskArgs.length) throw new Error(`revoke: name at least one task (${WAITLIST_TASKS.join(', ')})`);
    const unknown = taskArgs.filter((t) => !(WAITLIST_TASKS as readonly string[]).includes(t));
    if (unknown.length) throw new Error(`revoke: unknown task(s) ${unknown.join(', ')} — use ${WAITLIST_TASKS.join(', ')}`);
    return { kind: 'revoke', id, tasks: [...new Set(taskArgs)] as WaitlistTask[] };
  }
  throw new Error(USAGE);
}

function csvField(value: string | number): string {
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One row per signup, one column per task ("yes" = claimed) — ready to tick off in a spreadsheet. */
export function toCsv(rows: FrontOfLineRow[]): string {
  const header = ['position', 'id', 'handle', 'profile', 'email', ...WAITLIST_TASKS, 'task_points', 'referrals', 'points', 'joined_at'];
  const lines = rows.map((r) => [
    r.position,
    r.id,
    r.handle ? `@${r.handle}` : '',
    r.handle ? `https://x.com/${r.handle}` : '',
    r.email,
    ...WAITLIST_TASKS.map((t) => (r.tasks.includes(t) ? 'yes' : '')),
    r.taskPoints,
    r.referrals,
    r.points,
    r.joinedAt.toISOString(),
  ].map(csvField).join(','));
  return [header.join(','), ...lines].join('\n') + '\n';
}

/** A readable table plus the links to check against. */
export function formatTop(rows: FrontOfLineRow[]): string {
  const claimed = (tasks: WaitlistTask[]) =>
    WAITLIST_TASKS.map((t) => (tasks.includes(t) ? t[0].toUpperCase() : '·')).join(' ');
  const table = [
    ['pos', 'id', 'handle', 'claimed (F L R C)', 'task pts', 'refs', 'points', 'email'],
    ...rows.map((r) => [
      `#${r.position}`, String(r.id), r.handle ? `@${r.handle}` : '(none)', claimed(r.tasks),
      String(r.taskPoints), String(r.referrals), String(r.points), r.email,
    ]),
  ];
  const widths = table[0].map((_, c) => Math.max(...table.map((row) => row[c].length)));
  const body = table.map((row) => row.map((cell, c) => cell.padEnd(widths[c])).join('  ').trimEnd()).join('\n');
  return [
    `Front of the line — ${rows.length} signup${rows.length === 1 ? '' : 's'}. Check each claim on X, logged in as @${X_ACCOUNT}:`,
    `  follows  ${CHECK_LINKS.followers}`,
    `  likes    ${CHECK_LINKS.likes}`,
    `  reposts  ${CHECK_LINKS.reposts}`,
    `  replies  ${CHECK_LINKS.replies}`,
    `Take back what didn't check out:  npm run waitlist:admin -- revoke <id> <task…>`,
    '',
    body,
  ].join('\n');
}

async function main(): Promise<void> {
  const cmd = parseAdminArgs(process.argv.slice(2));
  if (cmd.kind === 'top') {
    const rows = await listFrontOfLine(cmd.limit);
    process.stdout.write(cmd.csv ? toCsv(rows) : `${formatTop(rows)}\n`);
    return;
  }
  const result = await revokeTasks(cmd.id, cmd.tasks);
  if (!result) throw new Error(`revoke: no signup with id ${cmd.id}`);
  const notClaimed = cmd.tasks.filter((t) => !result.before.includes(t));
  console.log(`signup ${cmd.id}: tasks [${result.before.join(', ')}] → [${result.after.join(', ')}], task points now ${result.taskPoints}`);
  if (notClaimed.length) console.log(`  (not claimed, nothing to take back: ${notClaimed.join(', ')})`);
  console.log('  The public leaderboard catches up within 10 seconds.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
    .catch((err: Error) => {
      console.error(err.message);
      process.exitCode = 1;
    })
    .finally(() => closeWaitlistPool());
}
