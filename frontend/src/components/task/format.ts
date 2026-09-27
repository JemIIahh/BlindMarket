import { formatUnits } from 'ethers';
import { briefPreview, splitBrief } from '../../lib/briefText';

/** A task's reward as the A2A meta carries it: base units plus the token. */
export interface TaskReward {
  amount: string;
  unit?: { symbol?: string; decimals?: number };
}

function toBaseUnits(amount: string | undefined): bigint | null {
  return amount && /^\d+$/.test(amount) ? BigInt(amount) : null;
}

function display(raw: bigint, decimals: number, symbol: string): string {
  const value = Number(formatUnits(raw, decimals));
  const shown = value.toLocaleString(undefined, {
    minimumFractionDigits: Math.min(2, decimals),
    maximumFractionDigits: Math.min(4, decimals),
  });
  return symbol ? `${shown} ${symbol}` : shown;
}

/** "2.50 USDC", or null when the reward is missing or malformed. */
export function formatReward(reward: TaskReward | undefined | null): string | null {
  const raw = toBaseUnits(reward?.amount);
  const decimals = reward?.unit?.decimals;
  if (raw === null || typeof decimals !== 'number' || decimals < 0) return null;
  return display(raw, decimals, reward?.unit?.symbol ?? '');
}

/** The rewards added up per token: "3.26 USDC", or "1.00 USDC · 0.50 0G". */
export function sumRewards(rewards: (TaskReward | undefined | null)[]): string | null {
  const totals = new Map<string, { raw: bigint; decimals: number; symbol: string }>();
  for (const reward of rewards) {
    const raw = toBaseUnits(reward?.amount);
    const decimals = reward?.unit?.decimals;
    if (raw === null || typeof decimals !== 'number' || decimals < 0) continue;
    const symbol = reward?.unit?.symbol ?? '';
    const key = `${symbol}:${decimals}`;
    const total = totals.get(key);
    totals.set(key, { raw: (total?.raw ?? 0n) + raw, decimals, symbol });
  }
  if (totals.size === 0) return null;
  return [...totals.values()].map((t) => display(t.raw, t.decimals, t.symbol)).join(' · ');
}

/**
 * Index of the one task whose reward stands out, for the highlighted card:
 * at least three tasks, all paid in the same token, and a single highest
 * reward that isn't shared by every task. -1 otherwise.
 */
export function topRewardIndex(rewards: (TaskReward | undefined | null)[]): number {
  if (rewards.length < 3) return -1;
  const units = new Set(rewards.map((r) => `${r?.unit?.symbol ?? ''}:${r?.unit?.decimals ?? ''}`));
  if (units.size !== 1) return -1;
  const amounts = rewards.map((r) => toBaseUnits(r?.amount));
  if (amounts.some((a) => a === null)) return -1;
  const values = amounts as bigint[];
  const max = values.reduce((a, b) => (b > a ? b : a));
  const atMax = values.filter((v) => v === max).length;
  return atMax === 1 ? values.indexOf(max) : -1;
}

export type DeadlineTone = 'normal' | 'soon' | 'ended';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "Ends in 5h" from a unix-seconds deadline; "soon" under a day. */
export function deadlineLabel(
  deadline: number | string | undefined | null,
  nowMs: number,
): { text: string; tone: DeadlineTone } | null {
  const seconds = Number(deadline);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const left = seconds * 1000 - nowMs;
  if (left <= 0) return { text: 'Ended', tone: 'ended' };
  if (left < HOUR) return { text: `Ends in ${Math.max(1, Math.floor(left / MINUTE))}m`, tone: 'soon' };
  if (left < 2 * DAY) return { text: `Ends in ${Math.floor(left / HOUR)}h`, tone: left < DAY ? 'soon' : 'normal' };
  if (left < 60 * DAY) return { text: `Ends in ${Math.floor(left / DAY)}d`, tone: 'normal' };
  return { text: `Ends in ${Math.floor(left / (30 * DAY))}mo`, tone: 'normal' };
}

const VERIFY: Record<string, { label: string; hint: string }> = {
  auto: { label: 'Auto check', hint: "Checked automatically against the poster's rules" },
  agent: { label: 'Agent review', hint: 'A verifier agent judges the work' },
  manual: { label: 'Poster review', hint: 'The poster approves the work' },
  oracle: { label: 'Oracle', hint: 'Checked by an oracle' },
};

/** How the work gets checked, in two words. */
export function verifyLabel(mode: string | undefined | null): { label: string; hint: string } | null {
  if (!mode) return null;
  return VERIFY[mode] ?? { label: mode.charAt(0).toUpperCase() + mode.slice(1), hint: `Verified by ${mode}` };
}

const SEALED_NOTE = 'Details are encrypted for the agent who takes it.';

/** The readable text of a browse row's meta. */
export interface CardTextSource {
  privacy?: 'public';
  publicBrief?: string;
  routingSummary?: string;
}

/** A card's title and description. A private task's brief is sealed, so it
 *  shows the routing summary the poster wrote for it. */
export function cardText(meta: CardTextSource): { title: string; description: string } {
  if (meta.privacy === 'public') {
    const { title, body } = splitBrief(meta.publicBrief);
    return { title: title || 'Public task', description: briefPreview(body) };
  }
  const { title, body } = splitBrief(meta.routingSummary);
  return { title: title || 'Private task', description: briefPreview(body) || SEALED_NOTE };
}
