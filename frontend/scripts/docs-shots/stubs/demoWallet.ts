/**
 * The demo user's wallets for the docs screenshots: a Privy embedded wallet
 * and a linked MetaMask wallet, each with a tiny EIP-1193 provider that
 * answers the reads the app makes while rendering (chain id, accounts).
 * Nothing here signs or sends: a write throws, so a screenshot can never
 * depend on one.
 *
 * Every object is created once at module load. The app keys effects on these
 * references (WalletContext re-syncs when `wallet` changes), so they must be
 * stable across renders.
 */
import identity from '../fixtures/identity.json';

export const CHAIN_ID = identity.chainId;
export const EMBEDDED = identity.user.embedded;
export const EXTERNAL = identity.user.external;

type Listener = (...args: unknown[]) => void;

function makeProvider(address: string) {
  const listeners = new Map<string, Set<Listener>>();
  return {
    isDocsShots: true,
    async request({ method }: { method: string; params?: unknown[] }): Promise<unknown> {
      switch (method) {
        case 'eth_chainId':
          return `0x${CHAIN_ID.toString(16)}`;
        case 'net_version':
          return String(CHAIN_ID);
        case 'eth_accounts':
        case 'eth_requestAccounts':
          return [address];
        case 'eth_blockNumber':
          return '0x15b3a20';
        case 'wallet_switchEthereumChain':
        case 'wallet_addEthereumChain':
          return null;
        default:
          throw Object.assign(new Error(`docs-shots wallet: ${method} is not available in screenshots`), { code: 4200 });
      }
    },
    on(event: string, fn: Listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
    },
    removeListener(event: string, fn: Listener) {
      listeners.get(event)?.delete(fn);
    },
  };
}

export const embeddedProvider = makeProvider(EMBEDDED);
export const externalProvider = makeProvider(EXTERNAL);

const noop = async () => {};

function makeConnectedWallet(address: string, walletClientType: string, connectorType: string, provider: ReturnType<typeof makeProvider>) {
  return {
    address,
    type: 'ethereum' as const,
    chainId: `eip155:${CHAIN_ID}`,
    walletClientType,
    connectorType,
    imported: false,
    delegated: false,
    linked: true,
    meta: { name: walletClientType === 'privy' ? 'Privy Wallet' : 'MetaMask', icon: undefined, id: walletClientType },
    getEthereumProvider: async () => provider,
    switchChain: noop,
    isConnected: async () => true,
    loginOrLink: noop,
    unlink: noop,
    disconnect: () => {},
    sign: async () => '0x',
  };
}

export const embeddedWallet = makeConnectedWallet(EMBEDDED, 'privy', 'embedded', embeddedProvider);
export const externalWallet = makeConnectedWallet(EXTERNAL, 'metamask', 'injected', externalProvider);

/** What `useWallets().wallets` lists: the embedded wallet first, as Privy does. */
export const connectedWallets = [embeddedWallet, externalWallet];

/** wagmi's `useWalletClient().data`, enough for `new BrowserProvider(walletClient.transport)`. */
export const walletClient = {
  account: { address: EMBEDDED, type: 'json-rpc' as const },
  chain: { id: CHAIN_ID },
  transport: embeddedProvider,
  request: embeddedProvider.request,
  signMessage: async () => `0x${'ab'.repeat(65)}`,
};
