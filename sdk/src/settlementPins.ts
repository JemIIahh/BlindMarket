/**
 * The escrow and settlement token of each deployment this SDK funds, by chain
 * id. postTask() and postTasks() approve and fund only these: otherwise both
 * addresses come from the backend's /health/settlement, and postTasks()
 * approves a whole run at once, so a backend that named another "escrow"
 * would be handed that approval (security review). A custom or local
 * deployment is added through BlindMarketConfig.trustedEscrows.
 *
 * Separate from network/presets.ts, which pins the 0G contracts of the
 * low-level API per SDK version (its testnet entries deliberately point at
 * an older deployment). These follow contracts/deployments/arc-*.json.
 */
export interface SettlementPin {
  chainId: number;
  escrow: string;
  token: string;
}

export const SETTLEMENT_PINS: readonly SettlementPin[] = Object.freeze([
  // Arc mainnet
  { chainId: 5042, escrow: '0xd2B819B57a9568Cb6bFc98C687F9a851EC8330C4', token: '0x3600000000000000000000000000000000000000' },
  // Arc Testnet
  { chainId: 5042002, escrow: '0xaBf70843E0380F1e749d2b85C30dD6820Ff5C731', token: '0x3600000000000000000000000000000000000000' },
]);

/** Whether `escrow` and `token` on `chainId` are a pinned deployment, or one the caller trusts. */
export function isPinnedSettlement(chainId: number, escrow: string, token: string, trusted: readonly SettlementPin[] = []): boolean {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  return [...SETTLEMENT_PINS, ...trusted].some((p) => p.chainId === chainId && same(p.escrow, escrow) && same(p.token, token));
}
