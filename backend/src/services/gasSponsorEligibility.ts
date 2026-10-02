/**
 * Who and what may have gas sponsored (docs/AGENT-GAS-FUNDING.md, "Who is
 * eligible" and "What gets sponsored"). Every rule is re-checked by the
 * backend at reservation and again before each send; a hint a worker saw is
 * never trusted.
 *
 * An agent qualifies when:
 *   - it is a hosted agent whose stored key derives its wallet_address;
 *   - a Privy-authenticated owner deployed it (the Privy user id is stored);
 *   - its key was never exported (agent_key_exports);
 *   - it and its Privy user have fewer strikes than the cap.
 * A task qualifies when:
 *   - its reward is at least GAS_SPONSOR_MIN_TASK_USDC in the settlement token;
 *   - if a verifier agent rules it, that verifier is a hosted agent whose owner
 *     turned verifying on, is running, and holds its gas gate at current fees.
 */
import { ethers } from 'ethers';
import type { A2ATaskMeta, DeployedAgent, OnChainTask } from '../types.js';
import { chainRuntime } from './chainRuntime.js';
import { loadAgentBySmartAccount, loadAgentByWallet } from './deployedAgentStore.js';
import { getTaskVerifierOn } from './escrow.js';
import { gasSponsorSettings, type GasSponsorSettings } from './gasSponsorConfig.js';
import { getControls, strikeCounts, usage, walletKeyExported } from './gasSponsorStore.js';

type Enabled = Extract<GasSponsorSettings, { enabled: true }>;

export type AgentIneligible = 'not_hosted' | 'key_mismatch' | 'no_privy_user' | 'key_exported' | 'strikes';
export type TaskIneligible = 'wrong_token' | 'below_minimum' | 'verifier_not_ready';

/** Whether a hosted agent's stored key derives the wallet it is recorded under. */
function keyDerivesWallet(agent: DeployedAgent): boolean {
  if (!agent.rawPrivateKey) return false;
  try {
    const k = agent.rawPrivateKey.startsWith('0x') ? agent.rawPrivateKey : `0x${agent.rawPrivateKey}`;
    return new ethers.Wallet(k).address.toLowerCase() === agent.walletAddress.toLowerCase();
  } catch {
    return false;
  }
}

export async function agentEligibility(
  settings: Enabled,
  agent: DeployedAgent | null,
): Promise<{ ok: true; ownerDid: string } | { ok: false; reason: AgentIneligible }> {
  if (!agent) return { ok: false, reason: 'not_hosted' };
  if (!keyDerivesWallet(agent)) return { ok: false, reason: 'key_mismatch' };
  if (!agent.privyUserId) return { ok: false, reason: 'no_privy_user' };
  if (await walletKeyExported(agent.walletAddress)) return { ok: false, reason: 'key_exported' };
  const strikes = await strikeCounts(settings.chainId, agent.walletAddress, agent.privyUserId);
  if (strikes.agent >= settings.caps.maxStrikes || strikes.owner >= settings.caps.maxStrikes) return { ok: false, reason: 'strikes' };
  return { ok: true, ownerDid: agent.privyUserId };
}

/** The gas gate a hosted worker applies, at current fees (worker.js preflightGas). */
async function gateWei(settings: Enabled): Promise<bigint | null> {
  const fee = await chainRuntime('arc').provider.getFeeData().catch(() => null);
  const perGas = fee?.maxFeePerGas ?? fee?.gasPrice ?? null;
  return perGas ? settings.chain.gas.workerTxGasLimit * perGas : null;
}

/** A per-task verifier agent that can rule: hosted, opted in, running, and holding its gas gate. */
export async function verifierCanRule(settings: Enabled, verifier: string): Promise<boolean> {
  const hosted = (await loadAgentByWallet(verifier)) ?? (await loadAgentBySmartAccount(verifier));
  if (!hosted || hosted.verifierEnabled !== true || hosted.status !== 'running') return false;
  const [gate, balance] = await Promise.all([
    gateWei(settings),
    chainRuntime('arc').provider.getBalance(verifier).catch(() => null),
  ]);
  return gate !== null && balance !== null && balance >= gate;
}

/**
 * `verifier: false` skips the verifier rule, for a release: that task's
 * verifier already failed to rule.
 */
export async function taskEligibility(
  settings: Enabled,
  taskId: bigint,
  task: Pick<OnChainTask, 'token' | 'amount'>,
  opts: { verifier?: boolean } = {},
): Promise<{ ok: true } | { ok: false; reason: TaskIneligible }> {
  if (!settings.chain.token.address || task.token.toLowerCase() !== settings.chain.token.address.toLowerCase()) {
    return { ok: false, reason: 'wrong_token' };
  }
  if (task.amount < settings.minTaskRaw) return { ok: false, reason: 'below_minimum' };
  if (opts.verifier === false) return { ok: true };
  const verifier = String(await getTaskVerifierOn('arc', Number(taskId)));
  if (verifier && !/^0x0{40}$/i.test(verifier) && !(await verifierCanRule(settings, verifier))) {
    return { ok: false, reason: 'verifier_not_ready' };
  }
  return { ok: true };
}

// ── The advisory hint on offers and broadcasts ───────────────────────────────

const HINT_TTL_MS = 15_000;
let budgetMemo: { at: number; chainId: number; open: boolean } | null = null;
const agentMemo = new Map<string, { at: number; ok: boolean }>();

/** Not paused or killed, and under both budgets right now. Cached for a few seconds. */
async function budgetLikelyOpen(settings: Enabled): Promise<boolean> {
  if (budgetMemo && budgetMemo.chainId === settings.chainId && Date.now() - budgetMemo.at < HINT_TTL_MS) return budgetMemo.open;
  let open = false;
  try {
    const [controls, used] = await Promise.all([getControls(settings.chainId), usage(settings.chainId)]);
    open = !controls.paused && !controls.killed
      && used.spentLastHourWei < settings.caps.hourlyBudgetWei
      && used.spentLastDayWei < settings.caps.dailyBudgetWei;
  } catch {
    open = false;
  }
  budgetMemo = { at: Date.now(), chainId: settings.chainId, open };
  return open;
}

async function agentLikelyEligible(settings: Enabled, wallet: string): Promise<boolean> {
  const key = `${settings.chainId}:${wallet.toLowerCase()}`;
  const memo = agentMemo.get(key);
  if (memo && Date.now() - memo.at < HINT_TTL_MS) return memo.ok;
  let ok = false;
  try {
    ok = (await agentEligibility(settings, await loadAgentByWallet(wallet))).ok;
  } catch {
    ok = false;
  }
  agentMemo.set(key, { at: Date.now(), ok });
  return ok;
}

/**
 * Whether a task offer or broadcast should carry `gasSponsored: true`:
 * sponsorship is on, the task is on Arc with a qualifying reward, the budget
 * is likely open, and (for an offer to one agent) that agent is likely
 * eligible. Advisory only: /accept reserves and checks everything again.
 */
export async function sponsorHint(meta: Pick<A2ATaskMeta, 'chain' | 'reward'>, agentWallet?: string): Promise<boolean> {
  try {
    const settings = gasSponsorSettings();
    if (!settings.enabled || meta.chain !== 'arc') return false;
    const reward = meta.reward;
    if (!reward || reward.unit.decimals !== settings.chain.token.unit.decimals || BigInt(reward.amount) < settings.minTaskRaw) return false;
    if (!(await budgetLikelyOpen(settings))) return false;
    return agentWallet ? await agentLikelyEligible(settings, agentWallet) : true;
  } catch {
    return false;
  }
}

/** Test hook. */
export function _resetSponsorHintCache(): void {
  budgetMemo = null;
  agentMemo.clear();
}

/**
 * What an agent's owner sees about sponsored gas (GET /agents/:id/gas-sponsorship):
 * 'sponsored' (Gas paid by BlindMarket), 'paused' (paused or stopped), or
 * 'not_eligible' with the reason; 'off' where sponsorship doesn't run here.
 */
export async function sponsorshipStatus(
  agent: DeployedAgent,
): Promise<{ state: 'off' | 'paused' | 'sponsored' } | { state: 'not_eligible'; reason: AgentIneligible }> {
  const settings = gasSponsorSettings();
  if (!settings.enabled) return { state: 'off' };
  const eligible = await agentEligibility(settings, agent);
  if (!eligible.ok) return { state: 'not_eligible', reason: eligible.reason };
  const controls = await getControls(settings.chainId);
  if (controls.paused || controls.killed) return { state: 'paused' };
  return { state: 'sponsored' };
}
