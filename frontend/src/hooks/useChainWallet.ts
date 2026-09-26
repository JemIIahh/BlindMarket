import { useCallback, useEffect, useState } from 'react';
import { formatUnits } from 'viem';
import { ethers } from 'ethers';
import { useAccount, useBalance as useWagmiBalance } from 'wagmi';
import { usePrivy } from '@privy-io/react-auth';
import { ARC_CHAIN_ID, getNativeCurrency, getChainConfig, type SupportedChain } from '../config/constants';
import { useSettlement } from '../config/settlement';
import { useWallet } from '../context/WalletContext';
import { providerFor } from '../lib/txSigner';

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
  const usdcAddress = posting.token.address;
  const usdcChainId = posting.chainId;
  const address = forAddress !== undefined ? forAddress : (wagmiAddress || privyAddress);

  // Read via the read-only Arc provider (PublicNode) instead of wagmi's
  // wallet-bound provider: Privy's embedded wallet may not serve eth_call on
  // Arc mainnet, and the user's wallet might be on another chain. PublicNode
  // always answers, so the balance shows regardless of wallet state.
  const [formatted, setFormatted] = useState<string | null>(null);
  const [raw, setRaw] = useState<bigint | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    if (!address || !usdcAddress || !usdcChainId) {
      setFormatted(null);
      setRaw(null);
      return;
    }
    setRefreshing(true);
    try {
      const provider = providerFor('arc');
      const callData = new ethers.Interface(ERC20_ABI).encodeFunctionData('balanceOf', [address]);
      const result = await provider.call({ to: usdcAddress, data: callData });
      const decoded = new ethers.Interface(ERC20_ABI).decodeFunctionResult('balanceOf', result);
      const value = decoded[0] as bigint;
      setRaw(value);
      const balance = Number(value) / 1e6;
      setFormatted(
        balance > 0
          ? balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })
          : '0.00',
      );
    } catch {
      // Keep the previous value on transient RPC errors; null while never read.
      setFormatted((prev) => prev);
      setRaw((prev) => prev);
    } finally {
      setRefreshing(false);
    }
  }, [address, usdcAddress, usdcChainId]);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  return {
    raw,
    formatted,
    symbol: 'USDC',
    decimals: 6,
    refresh,
    refreshing,
  };
}