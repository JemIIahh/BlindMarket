import { Interface, JsonRpcProvider, isError, type ethers } from 'ethers';
import type { UnsignedTx } from '../types/api';
import { getAuthHeaders } from './api';
import { API_BASE_URL, BASE_CHAIN_ID, BASE_RPC_URL, ARC_CHAIN_ID, ARC_RPC_URL } from '../config/constants';
import { getSettlement, isSettlementChainKey, relayChainFor, type SettlementChainKey } from '../config/settlement';

export interface SentTx {
  hash: string;
  receipt: ethers.TransactionReceipt | null;
  userOp?: boolean;
}

/** Read-only Base provider — where the relay sends today. */
export const baseProvider = new JsonRpcProvider(BASE_RPC_URL, BASE_CHAIN_ID, { staticNetwork: true });

let arcProvider: JsonRpcProvider | null = null;
/** Read-only Arc provider — for direct-signed sends and receipt/allowance reads. */
function getArcProvider(): JsonRpcProvider {
  return (arcProvider ??= new JsonRpcProvider(ARC_RPC_URL, ARC_CHAIN_ID, { staticNetwork: true }));
}

const rpcProviders = new Map<string, JsonRpcProvider>();
/** Read-only provider for an arbitrary RPC URL (receipt polling after a
 *  relayed send on a non-settlement chain, e.g. a CCTP source chain). */
function providerForRpc(rpcUrl: string): JsonRpcProvider {
  let p = rpcProviders.get(rpcUrl);
  if (!p) {
    p = new JsonRpcProvider(rpcUrl);
    rpcProviders.set(rpcUrl, p);
  }
  return p;
}

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

/** A read-only provider for the chain a transaction targets: Arc or Base. */
export function providerFor(chain?: string | null): JsonRpcProvider {
  if (chain === 'arc') return getArcProvider();
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

function revertedError(hash: string): RelayError {
  return new RelayError('TX_REVERTED', `Transaction ${hash} reverted on-chain, so it had no effect (only its gas was spent).`);
}

/**
 * Wait for a directly-signed transaction. ethers v6's wait() throws
 * CALL_EXCEPTION on a reverted receipt; swallowing that made a revert look
 * like "not mined yet" and cancel/timeout reported success. A revert throws
 * TX_REVERTED; any other wait failure (replaced, RPC hiccup) stays a null
 * receipt, which callers treat as unconfirmed.
 */
async function waitDirect(res: ethers.TransactionResponse): Promise<ethers.TransactionReceipt | null> {
  let receipt: ethers.TransactionReceipt | null;
  try {
    receipt = await res.wait();
  } catch (err) {
    if (isError(err, 'CALL_EXCEPTION')) throw revertedError(res.hash);
    return null;
  }
  if (receipt && receipt.status === 0) throw revertedError(res.hash);
  return receipt;
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

/** Whether a tx on `chain` is signed and sent from the wallet (no relay serves it). */
export function isDirectSigned(chain: string | null | undefined): chain is SettlementChainKey {
  return !!chain && isSettlementChainKey(chain) && !relayChainFor(chain);
}

/**
 * Refuse when a tx on `chain` would be signed by the wallet itself (Arc) but
 * the wallet sits on another network: the escrow's address has no code there
 * (a no-op send, or worse). No-op for relayed chains, where the wallet's
 * network does not matter. Callers run it before their own reads so a
 * wrong-chain wallet gets this message, not a decode error.
 */
export async function assertWalletOnChain(signer: ethers.JsonRpcSigner, chain: string | null | undefined): Promise<void> {
  if (!isDirectSigned(chain)) return;
  const targetChainId = getSettlement().chains[chain].chainId;
  const network = await signer.provider.getNetwork();
  if (Number(network.chainId) !== targetChainId) {
    throw new RelayError('WRONG_CHAIN', `Your wallet is on chain ${Number(network.chainId)}, not ${chain} (${targetChainId}). Switch to ${chain} and try again.`);
  }
}

/**
 * Relay a gas-sponsored transaction through the backend.
 * The server uses @privy-io/node to call Privy's RPC.
 */
export async function signAndSendTx(
  signer: ethers.JsonRpcSigner,
  unsignedTx: UnsignedTx,
  value?: bigint,
  opts: { chain?: string | null; relay?: string; rpcUrl?: string } = {},
): Promise<SentTx> {
  // Arc has no relay (relayCaip2 null): sign and broadcast from the wallet's
  // own balance instead. USDC is the native gas coin on Arc, so the wallet
  // pays its own gas and nothing goes through the backend relay.
  //
  // `relay` names the backend relay chain explicitly (e.g. a CCTP source
  // chain from GET /api/v1/cctp/config `relayChain`) and skips the
  // settlement-table derivation, which only knows base/arc. `rpcUrl` gives
  // receipt polling a reader on that chain.
  const named = opts.chain ?? null;
  if (!opts.relay && isDirectSigned(named)) {
    await assertWalletOnChain(signer, named);
    const from = await signer.getAddress();
    const res = await signer.sendTransaction({
      from,
      to: unsignedTx.to,
      data: unsignedTx.data,
      ...(value !== undefined && value !== 0n ? { value } : {}),
    });
    return { hash: res.hash, receipt: await waitDirect(res) };
  }

  const from = await signer.getAddress();
  const body = {
    walletAddress: from,
    to: unsignedTx.to,
    data: unsignedTx.data,
    value: value ? String(value) : undefined,
    chain: opts.relay ?? relayChainNameFor(opts.chain),
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
  const provider = opts.rpcUrl ? providerForRpc(opts.rpcUrl) : providerFor(opts.chain);
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (receipt) {
        if (receipt.status === 0) throw revertedError(txHash);
        return { hash: txHash, receipt };
      }
    } catch (err) {
      if (err instanceof RelayError) throw err;
      /* keep retrying */
    }
  }
  return { hash: txHash, receipt: null };
}

/**
 * Send a payment the wallet signs itself (on a chain with no relay, Arc) and
 * give its hash to `onSent` as soon as the wallet has broadcast it, before
 * any wait. A caller that saves the hash keeps proof of the payment if the tab
 * closes or the wallet errors while it confirms. A sped-up transaction is
 * followed to its replacement, whose hash `onSent` gets too. Throws
 * TX_REVERTED or TX_CANCELLED when nothing was paid; a payment that could not
 * be followed to confirmation comes back with a null receipt.
 */
export async function sendDirectPayment(
  signer: ethers.JsonRpcSigner,
  tx: { to: string; data: string },
  chain: SettlementChainKey,
  onSent: (hash: string) => void,
): Promise<SentTx> {
  if (!isDirectSigned(chain)) throw new RelayError('NOT_DIRECT', `Transactions on ${chain} are relayed, not signed by the wallet.`);
  await assertWalletOnChain(signer, chain);
  // A replacement of this transaction is searched for from this block on.
  const startBlock = await signer.provider.getBlockNumber();
  const hash = await signer.sendUncheckedTransaction({ to: tx.to, data: tx.data });
  onSent(hash);

  // The wallet's node has the transaction first; ask it until it does.
  let sent: ethers.TransactionResponse | null = null;
  for (let i = 0; i < 15 && !sent; i++) {
    sent = await signer.provider.getTransaction(hash).catch(() => null);
    if (!sent) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!sent) return { hash, receipt: null };

  try {
    const receipt = await sent.replaceableTransaction(startBlock).wait();
    if (receipt && receipt.status === 0) throw revertedError(hash);
    return { hash, receipt };
  } catch (err) {
    if (err instanceof RelayError) throw err;
    if (isError(err, 'TRANSACTION_REPLACED')) {
      // ethers sets `cancelled` for a cancel and for a replacement that is a
      // different transaction; a speed-up is the same payment, re-priced.
      if (err.cancelled) {
        throw new RelayError('TX_CANCELLED', `Transaction ${hash} was cancelled or replaced in the wallet, so this payment was not made.`);
      }
      onSent(err.replacement.hash);
      if (err.receipt.status === 0) throw revertedError(err.replacement.hash);
      return { hash: err.replacement.hash, receipt: err.receipt };
    }
    if (isError(err, 'CALL_EXCEPTION')) throw revertedError(hash);
    return { hash, receipt: null };
  }
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
