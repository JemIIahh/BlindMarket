#!/usr/bin/env node
/**
 * scripts/rewind-submitted.ts
 *
 * Rewinds ONE task from off-chain 'submitted' back to 'accepted' so the
 * owning worker's resume path re-drives it (re-accept → fresh /submit →
 * broadcast → finalize).
 *
 * Usage: npx tsx scripts/rewind-submitted.ts <taskId>
 *
 * Only use for the dead state this heals: off-chain 'submitted' while the
 * escrow is still Assigned to the recorded executor (evidence never
 * broadcast — e.g. a local UserOp build failure between /submit and
 * broadcast). The script refuses anything else. Check
 * scripts/stuck-tasks.ts first.
 */
import 'dotenv/config';
import { rewindSubmittedTask } from '../src/services/stuckTasks.js';
import { redis, redisSub } from '../src/services/redis.js';
import { AppError } from '../src/middleware/errorHandler.js';

async function main() {
  const taskHash = process.argv[2];
  if (!taskHash) {
    console.error('usage: npx tsx scripts/rewind-submitted.ts <taskId>');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await rewindSubmittedTask(taskHash, 'operator-script');
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
