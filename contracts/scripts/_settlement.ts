/**
 * Chains where BlindEscrow settles in a USDC ERC-20: Base and Arc.
 *
 * 0G is not here. It settles in its native coin (address(0)) and deploys
 * through deploy-testnet.ts / deploy-mainnet.ts.
 *
 * On Arc, USDC is also the native gas coin: 18 decimals natively and 6
 * through the ERC-20 at 0x3600…0000. It is ONE balance. The escrow must only
 * ever allowlist the ERC-20. A task funded as address(0) there would be
 * priced as 6-decimal USDC while escrowing 18-decimal native units, so every
 * amount would be off by 10^12. Nothing here returns address(0) as a
 * settlement token, on any chain.
 *
 * No hardhat import, so tests and other scripts can load this without a
 * network.
 */

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Arc's USDC ERC-20. Answered decimals() = 6 and symbol() = "USDC" on Arc
 *  Testnet (5042002, rpc.testnet.arc.io) and Arc Mainnet (5042,
 *  rpc.mainnet.arc.io), read-only, on 2026-09-18. deploy-settlement.ts checks
 *  both again before it deploys. */
export const ARC_USDC = "0x3600000000000000000000000000000000000000";

export const ARC_TESTNET_CHAIN_ID = 5042002;
export const ARC_MAINNET_CHAIN_ID = 5042;

export interface SettlementChain {
  chainId: number;
  label: string;
  /** The USDC ERC-20 the escrow allowlists. Never address(0). */
  token: string;
  /** The native coin that pays gas. */
  gasSymbol: "ETH" | "USDC";
  /** The native gas coin is the settlement token itself (Arc). */
  nativeIsSettlementToken: boolean;
  /** ERC-4337 infrastructure (deploy-aa.ts: USDCPaymaster,
   *  BlindAccountFactory) belongs on this chain. Arc pays gas in USDC
   *  already, so it gets none. */
  aa: boolean;
}

export const SETTLEMENT_CHAINS: Readonly<Record<number, SettlementChain>> = {
  8453: {
    chainId: 8453,
    label: "Base",
    token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    gasSymbol: "ETH",
    nativeIsSettlementToken: false,
    aa: true,
  },
  84532: {
    chainId: 84532,
    label: "Base Sepolia",
    token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    gasSymbol: "ETH",
    nativeIsSettlementToken: false,
    aa: true,
  },
  [ARC_TESTNET_CHAIN_ID]: {
    chainId: ARC_TESTNET_CHAIN_ID,
    label: "Arc Testnet",
    token: ARC_USDC,
    gasSymbol: "USDC",
    nativeIsSettlementToken: true,
    aa: false,
  },
  [ARC_MAINNET_CHAIN_ID]: {
    chainId: ARC_MAINNET_CHAIN_ID,
    label: "Arc Mainnet",
    token: ARC_USDC,
    gasSymbol: "USDC",
    nativeIsSettlementToken: true,
    aa: false,
  },
};

/** `token` if it is a well-formed, non-zero address. Throws otherwise. */
export function assertNotNative(token: string): string {
  if (typeof token !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(token)) {
    throw new Error(`Settlement token "${token}" is not an address.`);
  }
  if (token.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(
      "Refusing address(0) as a settlement token. The escrow must allowlist the USDC ERC-20, never the native coin " +
        "(on Arc the native coin is 18-decimal USDC, so a 6-decimal amount would be off by 10^12).",
    );
  }
  return token;
}

/** The chain's entry. Throws for a chain that does not settle in an ERC-20 here. */
export function settlementChainFor(chainId: number): SettlementChain {
  const chain = SETTLEMENT_CHAINS[chainId];
  if (!chain) {
    throw new Error(
      `chainId ${chainId} has no settlement token (known: ${Object.keys(SETTLEMENT_CHAINS).join(", ")}). ` +
        "0G settles in its native coin through deploy-testnet.ts / deploy-mainnet.ts.",
    );
  }
  return chain;
}

/** The USDC ERC-20 the escrow on `chainId` settles in. Never address(0). */
export function settlementTokenFor(chainId: number): string {
  return assertNotNative(settlementChainFor(chainId).token);
}

/** The native gas coin's symbol, for balance messages: ETH on Base, USDC on Arc, 0G elsewhere. */
export function gasSymbolFor(chainId: number): string {
  return SETTLEMENT_CHAINS[chainId]?.gasSymbol ?? "0G";
}

/** Throws on a chain that must not get ERC-4337 infrastructure (Arc). */
export function assertAaChain(chainId: number): void {
  const chain = SETTLEMENT_CHAINS[chainId];
  if (chain && !chain.aa) {
    throw new Error(
      `Refusing to deploy account-abstraction infrastructure on ${chain.label} (chainId ${chainId}). ` +
        "It pays gas in USDC natively, so it needs no USDCPaymaster or BlindAccountFactory.",
    );
  }
}
