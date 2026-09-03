import { useCallback } from 'react';
import { useAccount, useBalance as useWagmiBalance, useReadContract } from 'wagmi';
import { usePrivy } from '@privy-io/react-auth';
import { OG_CHAIN_ID, BASE_CHAIN_ID, BASE_USDC_ADDRESS, getNativeCurrency, getChainConfig } from '../config/constants';
import { useWallet } from '../context/WalletContext';

export function useChainAddress(): string | undefined {
  const { address: evmAddress } = useWallet();
  return evmAddress ?? undefined;
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

export function useChainBalance(chain: 'og' | 'base' = 'og') {
  const { address: evmAddress } = useAccount();
  const chainId = chain === 'base' ? BASE_CHAIN_ID : OG_CHAIN_ID;
  const { data: wagmiBal } = useWagmiBalance({ address: evmAddress, chainId });
  const native = getNativeCurrency(chain);

  return {
    value: wagmiBal?.value,
    decimals: native.decimals,
    symbol: native.symbol,
    formatted: wagmiBal ? wagmiBal.formatted : undefined,
  };
}

export function useChainIsCorrectChain(): boolean {
  const { chainId } = useWallet();
  return chainId === OG_CHAIN_ID || chainId === BASE_CHAIN_ID;
}

export function useChainExplorerUrl(chain: 'og' | 'base' = 'og'): string {
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

export function useUsdcBalance() {
  const { address: wagmiAddress } = useAccount();
  const { address: privyAddress } = useWallet();
  // Privy embedded wallet may not sync with wagmi's useAccount immediately
  const address = wagmiAddress || privyAddress;
  const { data: rawBalance, refetch, isRefetching } = useReadContract({
    address: BASE_USDC_ADDRESS as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: BASE_CHAIN_ID,
    query: { enabled: !!address, refetchInterval: 10_000 },
  });

  const balance = rawBalance != null ? Number(rawBalance) / 1e6 : 0;

  return {
    raw: rawBalance,
    formatted: balance > 0 ? balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : '0.00',
    symbol: 'USDC',
    decimals: 6,
    refresh: refetch,
    refreshing: isRefetching,
  };
}