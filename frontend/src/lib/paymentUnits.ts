import { formatUnits, parseUnits } from 'ethers';
import { getPaymentDecimals, getPaymentSymbol } from '../config/settlement';

/**
 * Task rewards, service prices and agent minimum rewards are stored in the
 * settlement token's base units: USDC (6 decimals) on Base, native 0G (18)
 * only when no Base escrow is configured. Use these instead of hardcoding 18 —
 * that turned a 1 USDC listing into a request to escrow 10^18 base units.
 */
export function formatPaymentAmount(raw: string | bigint): string {
  return formatUnits(raw, getPaymentDecimals());
}

/** Throws on malformed input or more decimals than the token has. */
export function parsePaymentAmount(value: string): bigint {
  return parseUnits(value.trim(), getPaymentDecimals());
}

/**
 * An agent's earnings as the backend reports them (decimal strings). USDC and
 * native 0G are separate totals and must never be added together; backends
 * from before Sep 2026 send only `totalEarned`, in the payment token.
 */
export interface Earnings {
  totalEarned?: string;
  totalEarnedUsdc?: string;
  totalEarnedNative?: string;
}

function earningsParts(e: Earnings): { amount: number; symbol: string }[] {
  if (e.totalEarnedUsdc === undefined && e.totalEarnedNative === undefined) {
    return [{ amount: parseFloat(e.totalEarned || '0'), symbol: getPaymentSymbol() }];
  }
  const parts = [
    { amount: parseFloat(e.totalEarnedUsdc || '0'), symbol: 'USDC' },
    { amount: parseFloat(e.totalEarnedNative || '0'), symbol: '0G' },
  ].filter((p) => p.amount > 0);
  return parts.length > 0 ? parts : [{ amount: 0, symbol: getPaymentSymbol() }];
}

/** "12.5 USDC · 0.3 0G": one amount per currency the agent has earned in. */
export function formatEarnings(e: Earnings, maximumFractionDigits = 2): string {
  const smallest = 10 ** -maximumFractionDigits;
  return earningsParts(e)
    .map(({ amount, symbol }) => {
      const shown = amount > 0 && amount < smallest
        ? `<${smallest.toFixed(maximumFractionDigits)}`
        : amount.toLocaleString(undefined, { maximumFractionDigits });
      return `${shown} ${symbol}`;
    })
    .join(' · ');
}

/** Per-currency totals across several agents. */
export function sumEarnings(list: Earnings[]): Earnings {
  const add = (pick: (e: Earnings) => string | undefined) =>
    String(list.reduce((sum, e) => sum + parseFloat(pick(e) || '0'), 0));
  if (list.some((e) => e.totalEarnedUsdc !== undefined || e.totalEarnedNative !== undefined)) {
    return { totalEarnedUsdc: add((e) => e.totalEarnedUsdc), totalEarnedNative: add((e) => e.totalEarnedNative) };
  }
  return { totalEarned: add((e) => e.totalEarned) };
}
