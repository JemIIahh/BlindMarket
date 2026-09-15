#!/usr/bin/env node
/**
 * scripts/debug-finalize.ts
 *
 * Walks POST /a2a/tasks/:id/finalize's exact steps for one task and prints
 * where it throws (the worker only sees "500 INTERNAL_ERROR").
 *
 * Usage: npx tsx scripts/debug-finalize.ts <taskId>
 * Read-only: never mutates state, never touches the bridge.
 */
import 'dotenv/config';
import * as a2aStore from '../src/services/a2aStore.js';
import { resolveTaskByHash } from '../src/services/taskChain.js';
import * as escrowService from '../src/services/escrow.js';
import { autoVerify } from '../src/services/autoVerify.js';
import { redis, redisSub } from '../src/services/redis.js';

async function main() {
  const taskHash = process.argv[2];
  if (!taskHash) {
    console.error('usage: npx tsx scripts/debug-finalize.ts <taskId>');
    process.exitCode = 2;
    return;
  }

  const meta = await a2aStore.getMeta(taskHash);
  console.log('meta:', meta ? `found (verificationMode=${meta.verificationMode}, chain=${meta.chain ?? '?'}, hasCriteria=${!!meta.verificationCriteria})` : 'MISSING');
  if (!meta) return;

  const state = await a2aStore.getState(taskHash);
  console.log('state:', state ? `status=${state.status} executor=${state.executorAddress} hasResultData=${!!state.resultData} submissionRound=${state.submissionRound ?? '?'}` : 'MISSING');
  if (!state) return;

  if (meta.verificationMode === 'agent') {
    console.log('branch: agent-verify');
    console.log('verifierAddress:', meta.verifierAddress ?? 'MISSING');
    try {
      const r = await resolveTaskByHash(taskHash);
      console.log('resolve:', r ? `${r.chain} id ${r.taskId}` : 'null');
      if (r) {
        const t = await escrowService.getTaskOn(r.chain, Number(r.taskId));
        console.log(`on-chain: status=${t.status} attempts=${t.submissionAttempts} worker=${t.worker}`);
      }
    } catch (e) {
      console.log(`THROWS HERE: ${(e as Error).message}`);
    }
    return;
  }

  if (meta.verificationMode !== 'auto' || !meta.verificationCriteria) {
    console.log('branch: manual (would 200 awaitingPosterApproval — not the 500)');
    return;
  }

  console.log('branch: auto');
  try {
    const vr = autoVerify(state.resultData, meta.verificationCriteria);
    console.log(`autoVerify: passed=${vr.passed} score=${vr.score}`);
  } catch (e) {
    console.log(`THROWS IN autoVerify: ${(e as Error).stack ?? (e as Error).message}`);
    return;
  }
  try {
    const r = await resolveTaskByHash(taskHash);
    console.log('resolve:', r ? `${r.chain} id ${r.taskId}` : 'null');
    if (!r) return;
    const t = await escrowService.getTaskOn(r.chain, Number(r.taskId));
    console.log(`on-chain: status=${t.status} attempts=${t.submissionAttempts} worker=${t.worker} amount=${t.amount}`);
  } catch (e) {
    console.log(`THROWS HERE: ${(e as Error).stack ?? (e as Error).message}`);
  }
}

main()
  .catch((e) => {
    console.error(`failed: ${(e as Error).stack ?? (e as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    redis.disconnect();
    redisSub.disconnect();
  });
