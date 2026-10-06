/**
 * Stand-in for `wagmi` in the docs-screenshot build. Exact-match alias
 * (scripts/docs-shots/vite.config.ts), so a subpath like `wagmi/chains`
 * would still resolve to the real package. Reports the demo user's embedded
 * wallet, connected on Arc. Module-level constants keep references stable.
 */
import { CHAIN_ID, EMBEDDED, walletClient } from './demoWallet';

const account = {
  address: EMBEDDED as `0x${string}`,
  addresses: [EMBEDDED as `0x${string}`],
  chainId: CHAIN_ID,
  chain: undefined,
  connector: undefined,
  isConnected: true,
  isConnecting: false,
  isDisconnected: false,
  isReconnecting: false,
  status: 'connected' as const,
};

// Native Arc balance (USDC is Arc's gas coin, 18 decimals).
const balance = {
  data: { value: 148_250_000_000_000_000_000n, decimals: 18, symbol: 'USDC', formatted: '148.25' },
  isLoading: false,
  isRefetching: false,
  refetch: async () => ({}),
};

const switchChain = {
  switchChain: () => {},
  switchChainAsync: async () => ({ id: CHAIN_ID }),
  chains: [],
  isPending: false,
};

const signMessage = {
  signMessage: () => {},
  signMessageAsync: async () => `0x${'ab'.repeat(65)}` as `0x${string}`,
  isPending: false,
};

const walletClientResult = { data: walletClient, isLoading: false, isSuccess: true };

export const useAccount = () => account;
export const useChainId = () => CHAIN_ID;
export const useSwitchChain = () => switchChain;
export const useBalance = (_args?: unknown) => balance;
export const useSignMessage = () => signMessage;
export const useWalletClient = () => walletClientResult;

/** Transport factory used by config/wagmi.ts; the stubbed createConfig ignores it. */
export const http = (_url?: string) => ({ type: 'http' });
