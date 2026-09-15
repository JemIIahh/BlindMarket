import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { ethers } from 'ethers';
import { usePrivy, useWallets, type ConnectedWallet, type LinkedAccountWithMetadata } from '@privy-io/react-auth';
import { OG_CHAIN_CONFIG, OG_CHAIN_ID, BASE_CHAIN_ID, BASE_CHAIN_CONFIG } from '../config/constants';

const HAS_PRIVY = !!import.meta.env.VITE_PRIVY_APP_ID;

/** EIP-3085 `wallet_addEthereumChain` parameter shape — same fields OG_CHAIN_CONFIG/BASE_CHAIN_CONFIG use. */
export interface AddEthereumChainParameter {
  chainId: string; // 0x-prefixed hex
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: readonly string[];
  blockExplorerUrls?: readonly string[];
}

/**
 * Switch a Privy wallet to an arbitrary chain, falling back to
 * `wallet_addEthereumChain` when the wallet doesn't recognize the chain yet
 * (EIP-3085, error code 4902). Extracted from PrivyWalletProvider's own
 * OG/Base switching below so Phase B's CCTP deposit flow (arbitrary source
 * chains — Ethereum, Ethereum Sepolia, ...) can reuse the exact same retry
 * logic instead of duplicating it.
 */
export async function switchWalletToChain(
  wallet: ConnectedWallet,
  targetChainId: number,
  chainConfig: AddEthereumChainParameter,
): Promise<void> {
  try {
    await wallet.switchChain(targetChainId);
  } catch (err: unknown) {
    const code = (err as { code?: number | string }).code;
    if (code === 4902 || code === 'UNSUPPORTED_CHAIN_ID' || String(code).includes('4902')) {
      const eth = await wallet.getEthereumProvider();
      await eth.request({ method: 'wallet_addEthereumChain', params: [chainConfig] });
      await wallet.switchChain(targetChainId);
    } else {
      throw err;
    }
  }
}

type WalletAccount = Extract<LinkedAccountWithMetadata, { type: 'wallet' }>;

function isEmbeddedWalletAccount(a: LinkedAccountWithMetadata): a is WalletAccount {
  return a.type === 'wallet' && a.chainType === 'ethereum'
    && (a.walletClientType === 'privy' || a.walletClientType === 'privy-v2');
}

interface WalletState {
  address: string | null;
  /** The Privy embedded (BlindMarket) wallet — what relay-tx signs from. */
  embeddedAddress: string | null;
  provider: ethers.BrowserProvider | null;
  signer: ethers.JsonRpcSigner | null;
  chainId: number | null;
  connecting: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  switchChain: (targetChainId?: number) => Promise<void>;
  isCorrectChain: boolean;
}

const WalletContext = createContext<WalletState | null>(null);

/* ── Privy-based provider ───────────────────────────────────────── */
function PrivyWalletProvider({ children }: { children: ReactNode }) {
  const { login, logout: privyLogout, connectWallet, authenticated, ready, user } = usePrivy();
  const { wallets } = useWallets();
  const [provider, setProvider] = useState<ethers.BrowserProvider | null>(null);
  const [signer, setSigner] = useState<ethers.JsonRpcSigner | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting] = useState(false);

  // Only treat a wallet as "connected" when Privy says we're authenticated.
  // Without this gate, Privy's useWallets() can surface a page-level injected
  // MetaMask even before the user completes the Privy login flow — causing
  // the TopBar to render "disconnect/address" instead of "connect_wallet",
  // and clicks to silently hit /sessions/logout (400, nothing to destroy).
  //
  // Prefer the Privy embedded wallet (walletClientType === 'privy') over any
  // injected wallet (MetaMask, etc.) — the embedded wallet is the one Privy
  // manages server-side for gas sponsorship.
  const rawWallet = wallets.find(w => w.walletClientType === 'privy') ?? wallets[0] ?? null;
  const wallet = authenticated ? rawWallet : null;
  const address = wallet?.address ?? null;
  const isCorrectChain = chainId === OG_CHAIN_ID || chainId === BASE_CHAIN_ID;
  // Read from linked accounts so it's known before the embedded wallet's iframe connects.
  const embeddedAddress = authenticated
    ? user?.linkedAccounts.find(isEmbeddedWalletAccount)?.address ?? null
    : null;

  const switchedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    async function sync() {
      if (!wallet) { setProvider(null); setSigner(null); setChainId(null); return; }
      try {
        const ethereumProvider = await wallet.getEthereumProvider();
        const bp = new ethers.BrowserProvider(ethereumProvider);
        const s = await bp.getSigner();
        const network = await bp.getNetwork();
        if (!cancelled) {
          setProvider(bp); setSigner(s); setChainId(Number(network.chainId));
          // Auto-switch to Base (settlement chain) if on an unsupported chain.
          // Already on 0G or Base? Leave it — both are valid.
          const cid = Number(network.chainId);
          if (cid !== OG_CHAIN_ID && cid !== BASE_CHAIN_ID && !switchedRef.current) {
            switchedRef.current = true;
            try {
              await wallet.switchChain(BASE_CHAIN_ID);
            } catch {
              try {
                const eth = await wallet.getEthereumProvider();
                await eth.request({ method: 'wallet_addEthereumChain', params: [BASE_CHAIN_CONFIG] });
                await wallet.switchChain(BASE_CHAIN_ID);
              } catch { /* chain add also failed — user will see the banner */ }
              switchedRef.current = false;
            }
          }
        }
      } catch (err) { console.error('Failed to sync wallet provider:', err); }
    }
    sync();
    return () => { cancelled = true; };
  }, [wallet, wallet?.chainId]);

  const switchChain = useCallback(async (targetChainId: number = BASE_CHAIN_ID) => {
    if (!wallet) return;
    const chainConfig = targetChainId === OG_CHAIN_ID ? OG_CHAIN_CONFIG : BASE_CHAIN_CONFIG;
    try {
      await switchWalletToChain(wallet, targetChainId, chainConfig);
    } catch (err) {
      console.error('Failed to switch chain:', err);
    }
  }, [wallet]);

  /**
   * Connect flow. Three states we must handle cleanly:
   *   (a) not authenticated — open the full Privy login modal (wallet/email/google/twitter)
   *   (b) authenticated, session cached, no wallet yet — this is the silent-no-op bug
   *       scenario. Open Privy's wallet picker directly via connectWallet().
   *   (c) authenticated + wallet already linked — nothing to do.
   */
  const connect = useCallback(async () => {
    if (!authenticated) {
      login();
    } else if (!wallet) {
      connectWallet();
    }
  }, [authenticated, wallet, login, connectWallet]);

  /**
   * Disconnect fully. Always clears local wallet/signer state. If Privy's
   * backend returns 400 (no session to destroy — happens when the local
   * state is stale but the server-side session already expired), we log
   * and move on rather than surface the error: from the user's perspective
   * disconnect still succeeded, and the next Connect will re-open the modal.
   */
  const disconnect = useCallback(async () => {
    setProvider(null);
    setSigner(null);
    setChainId(null);
    try {
      await privyLogout();
    } catch (err) {
      console.warn('[BlindMarket/Privy] logout rejected by server (likely stale session):', err);
    }
    // Belt-and-suspenders: wipe any Privy tokens Vite dev HMR might be holding.
    if (typeof window !== 'undefined') {
      try {
        for (let i = window.localStorage.length - 1; i >= 0; i--) {
          const k = window.localStorage.key(i);
          if (k && k.startsWith('privy:')) window.localStorage.removeItem(k);
        }
      } catch { /* ignore */ }
    }
  }, [privyLogout]);

  // Diagnostic — confirms Privy is mounted with the expected config at
  // runtime. Opt-in and dev-only, since it prints the Privy user id + wallet
  // address on every state change: localStorage.setItem('bb.debug.privy', '1')
  // then reload.
  useEffect(() => {
    if (!ready || !import.meta.env.DEV) return;
    try {
      if (window.localStorage.getItem('bb.debug.privy') !== '1') return;
    } catch {
      return;
    }
    console.log('[BlindMarket/Privy]', {
      ready,
      authenticated,
      userId: user?.id,
      walletCount: wallets.length,
      address,
      chainId,
    });
  }, [ready, authenticated, user?.id, wallets.length, address, chainId]);

  return (
    <WalletContext.Provider value={{ address, embeddedAddress, provider, signer, chainId, connecting: connecting || !ready, connect, disconnect, switchChain, isCorrectChain }}>
      {children}
    </WalletContext.Provider>
  );
}

/* ── Direct MetaMask provider (no Privy) ────────────────────────── */
function DirectWalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [provider, setProvider] = useState<ethers.BrowserProvider | null>(null);
  const [signer, setSigner] = useState<ethers.JsonRpcSigner | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);

  const isCorrectChain = chainId === OG_CHAIN_ID || chainId === BASE_CHAIN_ID;

  const switchChain = useCallback(async (targetChainId: number = BASE_CHAIN_ID) => {
    const eth = window.ethereum;
    if (!eth) return;
    const chainConfig = targetChainId === OG_CHAIN_ID ? OG_CHAIN_CONFIG : BASE_CHAIN_CONFIG;
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainConfig.chainId }] });
      const cid = await eth.request({ method: 'eth_chainId' });
      setChainId(Number(cid));
    } catch (err: unknown) {
      const code = (err as { code?: number }).code;
      if (code === 4902) {
        try { await eth.request({ method: 'wallet_addEthereumChain', params: [chainConfig] }); }
        catch (addErr) { console.error('Failed to add chain:', addErr); }
      } else { console.error('Failed to switch chain:', err); }
    }
  }, []);

  const connect = useCallback(async () => {
    const eth = window.ethereum;
    if (!eth) { alert('No wallet detected. Please install MetaMask or another EVM wallet.'); return; }
    setConnecting(true);
    try {
      const bp = new ethers.BrowserProvider(eth);
      await bp.send('eth_requestAccounts', []);
      const s = await bp.getSigner();
      const addr = await s.getAddress();
      const network = await bp.getNetwork();
      setProvider(bp); setSigner(s); setAddress(addr); setChainId(Number(network.chainId));
      if (Number(network.chainId) !== OG_CHAIN_ID) await switchChain();
    } catch (err: unknown) {
      const code = (err as { code?: string | number }).code;
      if (code !== 4001 && code !== 'ACTION_REJECTED') {
        console.error('Wallet connection failed:', err);
        alert('Wallet connection failed. Check the console for details.');
      }
    } finally { setConnecting(false); }
  }, [switchChain]);

  const disconnect = useCallback(() => {
    setAddress(null); setProvider(null); setSigner(null); setChainId(null);
    localStorage.removeItem('bb_jwt');
  }, []);

  useEffect(() => {
    const eth = window.ethereum;
    if (!eth) return;
    const onAccounts = (accounts: string[]) => { if (accounts.length === 0) disconnect(); else { setAddress(accounts[0]); localStorage.removeItem('bb_jwt'); } };
    const onChain = (cid: string) => setChainId(Number(cid));
    eth.on('accountsChanged', onAccounts);
    eth.on('chainChanged', onChain);
    return () => { eth?.removeListener('accountsChanged', onAccounts); eth?.removeListener('chainChanged', onChain); };
  }, [disconnect]);

  return (
    <WalletContext.Provider value={{ address, embeddedAddress: null, provider, signer, chainId, connecting, connect, disconnect, switchChain, isCorrectChain }}>
      {children}
    </WalletContext.Provider>
  );
}

/* ── Export: pick provider based on config ───────────────────────── */
export function WalletProvider({ children }: { children: ReactNode }) {
  if (HAS_PRIVY) return <PrivyWalletProvider>{children}</PrivyWalletProvider>;
  return <DirectWalletProvider>{children}</DirectWalletProvider>;
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within WalletProvider');
  return ctx;
}

// Window.ethereum type — skip if already declared by Privy or another lib
declare global {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Window {
    ethereum?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  }
}
