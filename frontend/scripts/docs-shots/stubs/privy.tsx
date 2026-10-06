/**
 * Stand-in for `@privy-io/react-auth` in the docs-screenshot build
 * (scripts/docs-shots/vite.config.ts aliases the package here). The real SDK
 * needs a live Privy app and a browser login, so signed-in pages can't render
 * headless with it. This one reports a demo user who is already signed in,
 * with an embedded wallet, a linked MetaMask wallet and an email.
 *
 * Only what the app imports is exported. Every value is a module-level
 * constant so React sees the same references on every render.
 */
import type { ReactNode } from 'react';
import identity from '../fixtures/identity.json';
import { EMBEDDED, EXTERNAL, connectedWallets } from './demoWallet';

const VERIFIED_AT = new Date('2026-06-02T09:14:00Z');

const embeddedAccount = {
  type: 'wallet' as const,
  address: EMBEDDED,
  chainType: 'ethereum' as const,
  chainId: `eip155:${identity.chainId}`,
  walletClientType: 'privy',
  walletClient: 'privy',
  connectorType: 'embedded',
  imported: false,
  delegated: false,
  walletIndex: 0,
  verifiedAt: VERIFIED_AT,
  firstVerifiedAt: VERIFIED_AT,
  latestVerifiedAt: VERIFIED_AT,
};

const externalAccount = {
  type: 'wallet' as const,
  address: EXTERNAL,
  chainType: 'ethereum' as const,
  chainId: 'eip155:8453',
  walletClientType: 'metamask',
  walletClient: 'unknown',
  connectorType: 'injected',
  imported: false,
  delegated: false,
  walletIndex: null,
  verifiedAt: VERIFIED_AT,
  firstVerifiedAt: VERIFIED_AT,
  latestVerifiedAt: VERIFIED_AT,
};

const emailAccount = {
  type: 'email' as const,
  address: identity.user.email,
  verifiedAt: VERIFIED_AT,
  firstVerifiedAt: VERIFIED_AT,
  latestVerifiedAt: VERIFIED_AT,
};

const user = {
  id: identity.user.privyId,
  createdAt: VERIFIED_AT,
  email: { address: identity.user.email },
  wallet: embeddedAccount,
  linkedAccounts: [emailAccount, embeddedAccount, externalAccount],
  mfaMethods: [],
  hasAcceptedTerms: true,
  isGuest: false,
};

// A JWT-shaped token. AuthContext reads only the `exp` claim (atob of the
// middle segment); the fixture API never checks it.
const TOKEN = [
  btoa(JSON.stringify({ alg: 'none', typ: 'JWT' })),
  btoa(JSON.stringify({ sub: identity.user.privyId, iss: 'docs-shots', exp: 4102444800 })),
  'docs-shots',
].join('.');

const noop = () => {};
const asyncNoop = async () => {};

const privyState = {
  ready: true,
  authenticated: true,
  user,
  login: noop,
  logout: asyncNoop,
  linkWallet: noop,
  connectWallet: noop,
  linkEmail: noop,
  getAccessToken: async () => TOKEN,
  exportWallet: asyncNoop,
  createWallet: asyncNoop,
};

const walletsState = { ready: true, wallets: connectedWallets };
const signersState = { addSigners: asyncNoop, removeSigners: asyncNoop };
const exportState = { exportWallet: asyncNoop };
const sendState = { sendTransaction: async () => ({ hash: `0x${'0'.repeat(64)}` }) };
const unlinkState = { unlink: asyncNoop };

export function PrivyProvider({ children }: { children: ReactNode; appId?: string; config?: unknown }) {
  return <>{children}</>;
}

export const usePrivy = () => privyState;
export const useWallets = () => walletsState;
export const useSigners = () => signersState;
export const useExportWallet = () => exportState;
export const useSendTransaction = () => sendState;
export const useUnlinkWallet = () => unlinkState;

export const getAccessToken = async () => TOKEN;
export const getIdentityToken = async () => TOKEN;

// Type-only names the app imports with `import { type … }`. esbuild drops
// those imports, but exporting the names keeps editors and tsc quiet.
export type ConnectedWallet = (typeof connectedWallets)[number];
export type LinkedAccountWithMetadata = (typeof user.linkedAccounts)[number];
