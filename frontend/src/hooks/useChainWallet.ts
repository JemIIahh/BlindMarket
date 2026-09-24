import { useCallback } from 'react';
import { formatUnits } from 'viem';
import { useAccount, useBalance as useWagmiBalance, useReadContract } from 'wagmi';
import { usePrivy } from '@privy-io/react-auth';
import { ARC_CHAIN_ID, getNativeCurrency, getChainConfig, type SupportedChain } from '../config/constants';
import { useSettlement } from '../config/settlement';
import { useWallet } from '../context/WalletContext';

export function useChainAddress(): string | undefined {
  const { address: evmAddress } = useWallet();
  return evmAddress ?? undefined;
}

/**
 * Every wallet on the signed-in account (the embedded one and any linked
 * external ones), lowercased, comma-separated: the `owner` for listing their
 * agents. An agent is owned by whichever wallet the backend resolved at
 * deploy, which on Arc can be an external wallet while `useChainAddress()` is
 * the embedded one. Empty string when signed out.
 */
export function useOwnerAddresses(): string {
  const { address, embeddedAddress, externalAddresses } = useWallet();
  return [...new Set([address, embeddedAddress, ...externalAddresses].filter((a): a is string => !!a).map((a) => a.toLowerCase()))].join(',');
}

/**
 * The wallets on the signed-in account (the embedded one and any linked
 * external ones): the only ones the backend counts a payment from. Unlike
 * useOwnerAddresses this leaves out a connected wallet that isn't linked.
 */
export function useAccountWallets(): string[] {
  const { embeddedAddress, externalAddresses } = useWallet();
  return [embeddedAddress, ...externalAddresses].filter((a): a is string => !!a).map((a) => a.toLowerCase());
}

export function useChainIsConnected(): boolean {
  const { address: evmAddress } = useWallet();
  return !!evmAddress;
}

export function useChainConnect() {
  const { login: evmLogin } = usePrivy();
  return useCallback(() => {
    evmLogin();
  }, [evmLogin]);
}

export function useChainDisconnect() {
  const { logout: evmLogout } = usePrivy();
  return useCallback(() => {
    evmLogout();
  }, [evmLogout]);
}

export function useChainBalance(chain: SupportedChain = 'arc') {
  const { address: evmAddress } = useAccount();
  const chainId = ARC_CHAIN_ID;
  const { data: wagmiBal, refetch, isRefetching } = useWagmiBalance({ address: evmAddress, chainId });
  const native = getNativeCurrency(chain);

  const formatted = wagmiBal?.value
    ? `${formatUnits(wagmiBal.value, native.decimals)} ${native.symbol}`
    : undefined;

  return {
    value: wagmiBal?.value,
    decimals: native.decimals,
    symbol: native.symbol,
    formatted,
    refresh: refetch,
    refreshing: isRefetching,
  };
}

export function useChainIsCorrectChain(): boolean {
  const { chainId } = useWallet();
  return chainId === ARC_CHAIN_ID;
}

export function useChainExplorerUrl(chain: SupportedChain = 'arc'): string {
  const config = getChainConfig(chain);
  return config.blockExplorerUrls[0];
}

const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/** Pass an address (or null) to read that wallet instead of the connected one. */
export function useUsdcBalance(forAddress?: string | null) {
  const { address: wagmiAddress } = useAccount();
  const { address: privyAddress } = useWallet();
  const settlement = useSettlement();
  const posting = settlement.chains[settlement.postingChain];
  // The posting chain's settlement token (USDC on Arc and Base) and its chain
  // id — the balance is read there, not hardcoded to Base.
  const usdcAddress = posting.token.address;
  const usdcChainId = posting.chainId;
  // Privy embedded wallet may not sync with wagmi's useAccount immediately
  const address = forAddress !== undefined ? forAddress : (wagmiAddress || privyAddress);
  const { data: rawBalance, refetch, isRefetching } = useReadContract({
    address: usdcAddress as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: address ? [address as `0x${string}`] : undefined,
    chainId: usdcChainId,
    query: { enabled: !!address && !!usdcAddress, refetchInterval: 10_000 },
  });

  // Unknown (still loading or read failed) must never render as zero — a
  // failed read displayed as 0.00 sent users hunting a missing balance that
  // was there all along. Callers show `formatted ?? '…'` while unknown.
  const balance = rawBalance != null ? Number(rawBalance) / 1e6 : null;

  return {
    raw: rawBalance,
    formatted: balance == null ? null : balance > 0 ? balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : '0.00',
    symbol: 'USDC',
    decimals: 6,
    refresh: refetch,
    refreshing: isRefetching,
  };
}