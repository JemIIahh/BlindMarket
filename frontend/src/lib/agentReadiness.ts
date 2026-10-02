import { formatEther } from 'ethers';
import type { GasSponsorship } from './agentGas';

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

/**
 * The agent's gas, as the page knows it: whether its wallet holds less than
 * one transaction's gas at current fees (the worker's gas gate), and whether
 * BlindMarket pays its gas.
 */
export interface GasState {
  low: boolean;
  /** The gate, formatted in `symbol`; null where it is unknown. */
  minLabel: string | null;
  symbol: string;
  sponsorship?: GasSponsorship | null;
}

export type ReadinessView =
  | { kind: 'ready'; sponsored?: true }
  | { kind: 'sponsored_only'; minLabel: string | null; symbol: string }
  | { kind: 'gas'; minLabel: string | null; symbol: string; sponsorshipPaused: boolean }
  | { kind: 'checking' }
  | { kind: 'fund'; address: string; send: string; holds: string; need: string }
  | { kind: 'blocked'; reason: string };

/**
 * What the owner's agent page shows for a running agent's report (none yet
 * reads as checking). A worker whose model check passed still takes no task
 * its wallet can't pay the gas for, unless BlindMarket pays it.
 */
export function readinessView(r: AgentReadiness | null | undefined, gas?: GasState): ReadinessView {
  if (!r || r.checking) return { kind: 'checking' };
  if (r.ready) {
    const sponsored = gas?.sponsorship?.state === 'sponsored';
    if (gas?.low) {
      return sponsored
        ? { kind: 'sponsored_only', minLabel: gas.minLabel, symbol: gas.symbol }
        : { kind: 'gas', minLabel: gas.minLabel, symbol: gas.symbol, sponsorshipPaused: gas.sponsorship?.state === 'paused' };
    }
    return sponsored ? { kind: 'ready', sponsored: true } : { kind: 'ready' };
  }
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
