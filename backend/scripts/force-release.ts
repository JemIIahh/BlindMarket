#!/usr/bin/env node
/**
 * scripts/force-release.ts
 *
 * Frees ONE stuck task back to 'open' so agents can pick it up again.
 *
 * Usage: npx tsx scripts/force-release.ts <taskId>
 *
 * Refuses (like POST /a2a/tasks/:id/release) when the escrow has moved past
 * Funded — a task with an on-chain worker is OWNED, not stuck: restarting
 * that worker is the fix, not releasing. Check scripts/stuck-tasks.ts first
 * and only release 'safe-to-release' rows.
 */
import 'dotenv/config';
import { forceReleaseTask } from '../src/services/stuckTasks.js';
import { redis, redisSub } from '../src/services/redis.js';
import { AppError } from '../src/middleware/errorHandler.js';

async function main() {
  const taskHash = process.argv[2];
  if (!taskHash) {
    console.error('usage: npx tsx scripts/force-release.ts <taskId>');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await forceReleaseTask(taskHash, 'operator-script');
    console.log(JSON.stringify(result));
  } catch (e) {
    if (e instanceof AppError) {
      console.error(`refused: [${e.code}] ${e.message}`);
    } else {
      console.error(`failed: ${(e as Error).message}`);
    }
    process.exitCode = 1;
  }
}

main().finally(() => {
  redis.disconnect();
  redisSub.disconnect();
});
