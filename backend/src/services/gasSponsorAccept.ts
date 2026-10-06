/**
 * The /accept side of sponsored gas (docs/AGENT-GAS-FUNDING.md, "Reserve,
 * then assign"). A worker that took a task on a gasSponsored hint asks
 * /accept to reserve; the reservation is made, with every eligibility rule and
 * cap, BEFORE the accept's compare-and-set and marketplaceAssign. If nothing
 * can be reserved the caller gets 409 GAS_SPONSOR_UNAVAILABLE and the task is
 * untouched, so a task is never assigned to an agent that can't submit.
 */
import { AppError } from '../middleware/errorHandler.js';
import type { A2ATaskMeta } from '../types.js';
import { TaskStatus } from '../types.js';
import { loadAgentByWallet } from './deployedAgentStore.js';
import { getTaskOn } from './escrow.js';
import { resolveTaskByHash } from './taskChain.js';
import { RESERVATION_TTL_SECONDS, gasSponsorSettings, runnableSettings } from './gasSponsorConfig.js';
import { agentEligibility, taskEligibility } from './gasSponsorEligibility.js';
import {
  closeReservation, getReservation, markReservationReturned, reserve, startReservationClock, txsForReservation, type Reservation,
} from './gasSponsorStore.js';
import { isSponsorWriter, reservationBudgetWei } from './gasSponsorRelayer.js';

const unavailable = (reason: string, message: string) =>
  new AppError(409, 'GAS_SPONSOR_UNAVAILABLE', `Sponsored gas is not available for this task: ${message}. Accept it without sponsorGas if you can pay your own gas.`, reason);

/** Reserve the sponsor budget for `executor`'s submit of `taskHash`, or throw 409 GAS_SPONSOR_UNAVAILABLE. */
export async function reserveForAccept(taskHash: string, meta: A2ATaskMeta, executor: string): Promise<Reservation> {
  const run = await runnableSettings('gas sponsor reserve');
  if (!run.ok) throw unavailable('off', run.reason);
  const settings = run.settings;
  // The writer sends the reserved call; reserving where nothing can send it
  // would assign a task nobody can submit.
  if (!isSponsorWriter()) throw unavailable('off', 'this backend process is not the sponsor writer');
  if (meta.chain !== 'arc') throw unavailable('chain', 'only Arc tasks are sponsored');

  const resolved = await resolveTaskByHash(taskHash);
  if (!resolved || resolved.chain !== 'arc') throw unavailable('not_indexed', 'the task is not indexed on Arc yet');
  const taskId = BigInt(resolved.taskId);
  const task = await getTaskOn('arc', Number(taskId));
  if (task.status !== TaskStatus.Funded) throw unavailable('not_open', 'the task is not open on-chain');

  const agent = await loadAgentByWallet(executor);
  const agentOk = await agentEligibility(settings, agent);
  if (!agentOk.ok) throw unavailable(agentOk.reason, `this agent is not eligible (${agentOk.reason})`);
  const taskOk = await taskEligibility(settings, taskId, task);
  if (!taskOk.ok) throw unavailable(taskOk.reason, `the task does not qualify (${taskOk.reason})`);

  const outcome = await reserve(
    {
      chainId: settings.chainId, taskId, kind: 'submit', taskHash, agentWallet: executor, ownerDid: agentOk.ownerDid,
      poster: task.agent, budgetWei: await reservationBudgetWei(settings), ttlSeconds: RESERVATION_TTL_SECONDS,
    },
    settings.caps,
  );
  if (!outcome.ok) throw unavailable(outcome.refusal, `no sponsor budget (${outcome.refusal})`);
  return outcome.reservation;
}

/** The accept failed after reserving: give the budget back. Never throws. */
export async function releaseAcceptReservation(reservation: Reservation): Promise<void> {
  await closeReservation(reservation.id, 'released').catch((e) =>
    console.error(`[gasSponsor] could not release reservation ${reservation.id}: ${(e as Error).message}`),
  );
}

/** The assignment confirmed: the reservation's hour starts now. Never throws. */
export async function startReservationAfterAssign(reservation: Reservation): Promise<void> {
  await startReservationClock(reservation.id, RESERVATION_TTL_SECONDS).catch(() => {});
}

/** Whether `executor` holds a sponsored-submit reservation for `taskHash` (a re-accept on resume). */
export async function holdsReservation(taskHash: string, executor: string): Promise<boolean> {
  try {
    const settings = gasSponsorSettings();
    if (!settings.enabled) return false;
    const resolved = await resolveTaskByHash(taskHash);
    if (!resolved || resolved.chain !== 'arc') return false;
    const r = await getReservation(settings.chainId, BigInt(resolved.taskId), 'submit');
    return r?.status === 'reserved' && r.agentWallet === executor.toLowerCase();
  } catch {
    return false;
  }
}

/** The submit reservation `executor` holds for `taskHash`, if it holds one. */
async function heldSubmit(taskHash: string, executor: string): Promise<Reservation | null> {
  const settings = gasSponsorSettings();
  if (!settings.enabled) return null;
  const resolved = await resolveTaskByHash(taskHash);
  if (!resolved || resolved.chain !== 'arc') return null;
  const r = await getReservation(settings.chainId, BigInt(resolved.taskId), 'submit');
  return r?.status === 'reserved' && r.agentWallet === executor.toLowerCase() ? r : null;
}

/**
 * `executor` handed back `taskHash` while the escrow still names it as
 * worker (POST /release refused ON_CHAIN_LOCKED). The worker does this on a
 * failure, often a passing one it resumes from, so the reservation stays
 * held and a resume is still sponsored; it is only marked, and at its hour
 * the sweep releases it without a strike. Otherwise a poster pinning tasks
 * the agent can't work (a brief it can't decrypt) turned each into a strike
 * against the owner, and three ended sponsorship for the owner's whole
 * fleet. Only the worker holds an eligible agent's credentials, so an owner
 * can't call /release to dodge a strike. Never throws.
 */
export async function markHandedBack(taskHash: string, executor: string): Promise<void> {
  try {
    const r = await heldSubmit(taskHash, executor);
    if (r) await markReservationReturned(r.id);
  } catch (e) {
    console.error(`[gasSponsor] could not mark the reservation for ${taskHash} as handed back: ${(e as Error).message}`);
  }
}

/**
 * `taskHash` re-opened (POST /release) with `executor` no longer on it: give
 * back the submit reservation that executor held. Otherwise it held the
 * task's row for its hour, and the next taker's reservation was refused as
 * taken. Left alone while a transaction of ours for it is out. Never throws.
 */
export async function releaseOnReopen(taskHash: string, executor: string): Promise<void> {
  try {
    const r = await heldSubmit(taskHash, executor);
    if (!r) return;
    if ((await txsForReservation(r.id)).some((t) => t.status === 'signed' || t.status === 'sent')) return;
    await closeReservation(r.id, 'released');
  } catch (e) {
    console.error(`[gasSponsor] could not give back the reservation for ${taskHash}: ${(e as Error).message}`);
  }
}
