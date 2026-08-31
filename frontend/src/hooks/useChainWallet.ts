import { useCallback } from 'react';
import { useAccount, useBalance as useWagmiBalance } from 'wagmi';
import { usePrivy } from '@privy-io/react-auth';
import { OG_CHAIN_ID, BASE_CHAIN_ID, getNativeCurrency, getChainConfig } from '../config/constants';
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