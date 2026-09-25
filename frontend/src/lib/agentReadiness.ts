import { formatEther } from 'ethers';

/**
 * What an agent's worker last reported about taking tasks
 * (GET /api/v1/agents/:id/readiness, owner-only). The worker takes a task only
 * after a check that its model answers. A 0g-compute agent pays for each model
 * call from a 0G Compute account, which it opens with 0G from its own wallet.
 */
export interface AgentReadiness {
  ready: boolean;
  /** Just started: the first model check has not finished. */
  checking?: boolean;
  reason: string | null;
  /** A 0g-compute agent that can't open its 0G Compute account yet. Wei. */
  fund?: { chain: '0g'; address: string; holdsWei: string; needWei: string; shortfallWei: string };
  reportedAt: string;
}

/** The least a 0G Compute account opens with (the contract's minimum). */
export const OG_COMPUTE_ACCOUNT_0G = '3';
/** What a 0g-compute agent's wallet needs on the 0G chain before its first task: the account plus gas (backend/agents/worker.js). */
export const OG_COMPUTE_START_0G = '3.1';

const SHOWN_DECIMALS = 4n;
const STEP = 10n ** (18n - SHOWN_DECIMALS);

/** A wei amount in 0G, to at most 4 decimals. `up` rounds up, for an amount someone must send. */
export function format0g(wei: string | bigint, up = false): string {
  const w = BigInt(wei);
  const steps = up ? (w + STEP - 1n) / STEP : w / STEP;
  const s = formatEther(steps * STEP);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

export type ReadinessView =
  | { kind: 'ready' }
  | { kind: 'checking' }
  | { kind: 'fund'; address: string; send: string; holds: string; need: string }
  | { kind: 'blocked'; reason: string };

/** What the owner's agent page shows for a running agent's report (none yet reads as checking). */
export function readinessView(r: AgentReadiness | null | undefined): ReadinessView {
  if (!r || r.checking) return { kind: 'checking' };
  if (r.ready) return { kind: 'ready' };
  if (r.fund) {
    return {
      kind: 'fund',
      address: r.fund.address,
      send: format0g(r.fund.shortfallWei, true),
      holds: format0g(r.fund.holdsWei),
      need: format0g(r.fund.needWei, true),
    };
  }
  const reason = (r.reason ?? '').trim() || 'its model check has not passed';
  return { kind: 'blocked', reason: reason.charAt(0).toUpperCase() + reason.slice(1).replace(/\.+$/, '') + '.' };
}
