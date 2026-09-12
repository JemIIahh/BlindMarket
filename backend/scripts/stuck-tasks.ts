#!/usr/bin/env node
/**
 * scripts/stuck-tasks.ts
 *
 * Operator diagnostic for "cooked" tasks: lists every task sitting in a
 * non-terminal, non-open off-chain state with a verdict per task.
 *
 * Usage: npx tsx scripts/stuck-tasks.ts
 *
 * Verdicts:
 *   safe-to-release   — on-chain still Funded: force-release will free it.
 *   owned-on-chain    — a worker IS assigned on-chain: do NOT release; the
 *                       owner must drive it (restart that agent instead).
 *   unmapped          — never indexed from a TaskCreated event (re-index).
 *   chain-unreachable — RPC failed this run; retry later.
 */
import 'dotenv/config';
import { diagnoseStuckTasks } from '../src/services/stuckTasks.js';
import { redis, redisSub } from '../src/services/redis.js';

function ageStr(ageMs: number | null): string {
  if (ageMs == null) return 'unknown age';
  const s = Math.floor(ageMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

const ONCHAIN = ['Funded', 'Assigned', 'Submitted', 'Verified', 'Completed', 'Cancelled', 'Disputed'];

async function main() {
  const tasks = await diagnoseStuckTasks();
  if (tasks.length === 0) {
    console.log('No stuck tasks — nothing in accepted/in_progress/submitted.');
    return;
  }

  for (const t of tasks) {
    const agent = t.agent ? `${t.agent.name} (${t.agent.status})` : '(no deployed agent for executor)';
    const onChain =
      t.onChainStatus == null
        ? '?'
        : `${ONCHAIN[t.onChainStatus] ?? t.onChainStatus}(${t.onChainStatus})`;
    const rewindHint =
      t.verdict === 'owned-on-chain' &&
      t.status === 'submitted' &&
      t.onChainStatus === 1 &&
      ((t.onChainWorker ?? '').toLowerCase() === (t.executorAddress ?? '').toLowerCase() ||
        ((t.onChainWorker ?? '').toLowerCase() === (t.submitterAddress ?? '').toLowerCase()))
        ? `\n  action:    evidence never landed — rewind with: npx tsx scripts/rewind-submitted.ts ${t.taskId}`
        : '';
    console.log(
      `${t.taskId}\n` +
        `  off-chain: ${t.status} | age ${ageStr(t.ageMs)} | chain ${t.chain ?? '?'}${t.onChainId ? ` id ${t.onChainId}` : ''}\n` +
        `  executor:  ${t.executorAddress ?? '?'} | agent: ${agent}${t.submitterAddress && t.submitterAddress.toLowerCase() !== (t.executorAddress ?? '').toLowerCase() ? `\n  submitter: ${t.submitterAddress} (smart account)` : ''}\n` +
        `  on-chain:  ${onChain}${t.onChainWorker ? ` worker ${t.onChainWorker}` : ''}\n` +
        `  verdict:   ${t.verdict}${rewindHint}`,
    );
  }

  const counts: Record<string, number> = {};
  for (const t of tasks) counts[t.verdict] = (counts[t.verdict] ?? 0) + 1;
  console.log(`\nTotal: ${tasks.length} — ${JSON.stringify(counts)}`);
  console.log('Free safe-to-release tasks with: npx tsx scripts/force-release.ts <taskId>');
}

main()
  .catch((e) => {
    console.error(`failed: ${(e as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    redis.disconnect();
    redisSub.disconnect();
  });
