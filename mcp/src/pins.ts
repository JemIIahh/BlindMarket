/**
 * The escrow and settlement token of each deployment this server funds, by
 * chain id. post_task, post_tasks and rent_service approve and fund only
 * these: the addresses otherwise come from the backend's settlement answer,
 * and an approve to whatever "escrow" it named would hand that address the
 * wallet's USDC (security review). The same pins as the SDK's
 * SETTLEMENT_PINS (sdk/src/settlementPins.ts), kept here so this server does
 * not need a newer SDK to publish; they follow contracts/deployments/arc-*.json.
 *
 * A custom or local deployment is trusted with BLINDMARKET_TRUSTED_ESCROWS,
 * as in the CLI: comma-separated `chainId:escrow:token` entries (the zero
 * address as the token for a native-coin escrow such as 0G's).
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

export interface PinError extends Error { code?: string }

/** BLINDMARKET_TRUSTED_ESCROWS, parsed; throws BAD_TRUSTED_ESCROWS on an entry that is not chainId:escrow:token. */
export function trustedEscrows(env: NodeJS.ProcessEnv = process.env): SettlementPin[] {
  const raw = env.BLINDMARKET_TRUSTED_ESCROWS?.trim();
  if (!raw) return [];
  return raw.split(',').map((entry) => {
    const m = /^\s*(\d+):(0x[0-9a-fA-F]{40}):(0x[0-9a-fA-F]{40})\s*$/.exec(entry);
    if (!m) {
      const e: PinError = new Error(`BLINDMARKET_TRUSTED_ESCROWS entry "${entry.trim()}" is not chainId:escrow:token (e.g. 5042002:0x…:0x…).`);
      e.code = 'BAD_TRUSTED_ESCROWS';
      throw e;
    }
    return { chainId: Number(m[1]), escrow: m[2], token: m[3] };
  });
}

/** Whether `escrow` and `token` on `chainId` are a pinned deployment, or one the environment trusts. */
export function isPinnedSettlement(chainId: number, escrow: string, token: string, trusted: readonly SettlementPin[]): boolean {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  return [...SETTLEMENT_PINS, ...trusted].some((p) => p.chainId === chainId && same(p.escrow, escrow) && same(p.token, token));
}
