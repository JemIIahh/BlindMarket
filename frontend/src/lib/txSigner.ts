import { Interface, JsonRpcProvider, type ethers } from 'ethers';
import type { UnsignedTx } from '../types/api';
import { getAuthHeaders } from './api';
import { API_BASE_URL, BASE_CHAIN_ID, BASE_RPC_URL } from '../config/constants';
import { getSettlement, isSettlementChainKey, relayChainFor, type SettlementChainKey } from '../config/settlement';

export interface SentTx {
  hash: string;
  receipt: ethers.TransactionReceipt | null;
  userOp?: boolean;
}

/** Read-only Base provider — where the relay sends today. */
export const baseProvider = new JsonRpcProvider(BASE_RPC_URL, BASE_CHAIN_ID, { staticNetwork: true });

/**
 * The chain a relayed transaction actually goes to. A caller that names the
 * chain (the backend's `chain` for a task's tx) gets exactly that chain, or
 * an error when the relay does not serve it: a 0G task's cancel used to be
 * relayed onto Base with the 0G escrow's address as `to` — a no-op there,
 * gas paid by the platform, task left funded. An unhinted caller gets the
 * posting chain when the relay serves it, else Base, the only chain the
 * relay served before the backend named any. The relay name and the
 * receipt/allowance provider both derive from this, so they cannot disagree.
 */
export function relayedChainKey(chain?: string | null): SettlementChainKey {
  if (chain !== undefined && chain !== null) {
    if (!isSettlementChainKey(chain) || !relayChainFor(chain)) {
      throw new RelayError('NO_RELAY', `Transactions on ${chain} are not relayed here, and this app cannot send them yet. Use the BlindMarket MCP (cancel_task / claim_timeout) with a wallet funded on ${chain}.`);
    }
    return chain;
  }
  const posting = getSettlement().postingChain;
  return relayChainFor(posting) ? posting : 'base';
}

/** A read-only provider for the chain a transaction is relayed on (relayedChainKey). */
export function providerFor(_chain?: string | null): JsonRpcProvider {
  // The relay only serves Base today (Arc's relayCaip2 is null), so every
  // relayed transaction reads back on Base.
  return baseProvider;
}

export class RelayError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'RelayError';
  }
}

/** What this file sent before it asked the backend: Base, by the build's chain id. */
function legacyRelayChain(): string {
  if (BASE_CHAIN_ID === 8453) return 'base-mainnet';
  return 'base-sepolia';
}

/**
 * The `chain` name to relay on. A caller that got the chain from the backend
 * (POST /tasks returns it) passes it; otherwise the posting chain. Falls back
 * to the build's Base name for a backend that reports no relay chain.
 */
export function relayChainNameFor(chain?: string | null): string {
  return relayChainFor(relayedChainKey(chain)) ?? legacyRelayChain();
}

/**
 * Relay a gas-sponsored transaction through the backend.
 * The server uses @privy-io/node to call Privy's RPC.
 */
export async function signAndSendTx(
  signer: ethers.JsonRpcSigner,
  unsignedTx: UnsignedTx,
  value?: bigint,
  opts: { chain?: string | null } = {},
): Promise<SentTx> {
  const from = await signer.getAddress();
  const body = {
    walletAddress: from,
    to: unsignedTx.to,
    data: unsignedTx.data,
    value: value ? String(value) : undefined,
    chain: relayChainNameFor(opts.chain),
    asset: 'usdc',
    // Let the backend negotiate gas: user-pays (USDC) → app-pays → wallet-pays,
    // advancing only on Privy's exact refusal for each rung. Without this the
    // web app hard-coded user-pays with no fallback, so on any chain where
    // Privy has no USDC gas configured every transaction failed — and enabling
    // app-pays sponsorship in the dashboard could not help it.
    gas: 'auto',
  };

  const res = await fetch(`${API_BASE_URL}/api/v1/tx/relay-tx`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...await getAuthHeaders(),
    },
    body: JSON.stringify(body),
  });

  const json = await res.json();
  if (!res.ok || !json.success) {
    const code = json.error?.code || 'RELAY_FAILED';
    const msg = json.error?.message || json.error || `Relay failed (${res.status})`;
    throw new RelayError(code, msg);
  }

  const txHash: string = json.data?.hash || '';
  if (!txHash) {
    throw new RelayError('NO_HASH', 'Relay returned empty tx hash');
  }

  const isUserOp = json.data?.isUserOp === true;
  console.log(`[txSigner] relay success hash=${txHash} userOp=${isUserOp}`);

  if (isUserOp) {
    return { hash: txHash, receipt: null, userOp: true };
  }

  // Poll the chain the tx was relayed on, not signer.provider — the signer
  // may be sitting on another chain.
  const provider = providerFor(opts.chain);
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (receipt) return { hash: txHash, receipt };
    } catch { /* keep retrying */ }
  }
  return { hash: txHash, receipt: null };
}

const ERC20 = new Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

/**
 * Make sure `spender` (the escrow) may pull `amount` of `token` from the
 * signer: createTask funds itself with transferFrom, so an ERC-20 payment
 * needs an approval first and no native value. Reads go to the settlement
 * chain (`chain`, else the posting chain) because the wallet may be connected
 * to another chain, and it waits until the allowance is visible there, since
 * a sponsored approve can land as a user-op with no receipt.
 */
export async function ensureBaseAllowance(
  signer: ethers.JsonRpcSigner,
  token: string,
  spender: string,
  amount: bigint,
  chain?: string | null,
): Promise<void> {
  const owner = await signer.getAddress();
  const provider = providerFor(chain);
  const readAllowance = async (): Promise<bigint> => {
    const raw = await provider.call({ to: token, data: ERC20.encodeFunctionData('allowance', [owner, spender]) });
    return ERC20.decodeFunctionResult('allowance', raw)[0] as bigint;
  };
  if ((await readAllowance()) >= amount) return;

  await signAndSendTx(signer, {
    from: owner,
    to: token,
    data: ERC20.encodeFunctionData('approve', [spender, amount]),
  }, undefined, { chain });
  for (let i = 0; i < 20; i++) {
    try {
      if ((await readAllowance()) >= amount) return;
    } catch { /* RPC hiccup; keep waiting */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new RelayError('APPROVAL_PENDING', 'The USDC approval has not confirmed yet. Wait a minute and try again.');
}
