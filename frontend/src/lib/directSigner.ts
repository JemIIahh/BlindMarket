import { ethers } from 'ethers';
import type { ConnectedWallet } from '@privy-io/react-auth';
import type { UnsignedTx } from '../types/api';

/** The chain a direct send must happen on, plus a read-only RPC for it. */
export interface DirectSendChain {
  chainId: number;
  rpcUrl: string;
  label: string;
}

const RECEIPT_TIMEOUT_MS = 180_000;

/**
 * Sign and broadcast a transaction directly from a Privy wallet against its
 * OWN chain — no backend relay involved. Unlike txSigner.ts's
 * signAndSendTx() (hardcoded to Base + the gas-sponsored relay), this is for
 * CCTP Phase B's source-chain burn: the wallet may be on Ethereum, Ethereum
 * Sepolia, or any other CCTP-supported chain, paying that chain's own native
 * gas from its own balance — Circle's Forwarding Service gasless property
 * only covers the DESTINATION Base mint, not this source-chain call.
 *
 * Only `eth_sendTransaction` goes through the wallet. Everything else is kept
 * off it on purpose: an ethers JsonRpcSigner first sends `eth_blockNumber`
 * and `eth_estimateGas` through the wallet, then polls receipts through it,
 * and Privy races every wallet request against a 2-minute timer. A wallet
 * that stalls on those network reads (a queued/pending request, an
 * unreachable RPC) failed with "Wallet timeout" on `eth_blockNumber` before
 * the user ever saw a signing prompt. The wallet fills in gas and nonce
 * itself for `eth_sendTransaction`; the receipt is read from our own RPC.
 */
export async function signAndSendDirect(
  wallet: ConnectedWallet,
  unsignedTx: UnsignedTx,
  chain: DirectSendChain,
): Promise<{ hash: string; receipt: ethers.TransactionReceipt | null }> {
  const eth = await wallet.getEthereumProvider();

  // eth_chainId is answered from the wallet's own state (no RPC round-trip).
  // Privy's switchChain returns early when its cached chain id already
  // matches, so confirm the wallet really is on the source chain before it
  // signs calldata meant for that chain.
  const walletChainId = Number(await eth.request({ method: 'eth_chainId' }));
  if (walletChainId !== chain.chainId) {
    throw new Error(`Your wallet is on chain ${walletChainId}, not ${chain.label} (${chain.chainId}). Switch networks in your wallet and try again.`);
  }

  let hash: string;
  try {
    hash = (await eth.request({
      method: 'eth_sendTransaction',
      params: [{
        from: wallet.address,
        to: unsignedTx.to,
        data: unsignedTx.data,
        ...(unsignedTx.value ? { value: ethers.toQuantity(BigInt(unsignedTx.value)) } : {}),
      }],
    })) as string;
  } catch (err) {
    throw toWalletError(err);
  }

  const reader = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true });
  reader.pollingInterval = 2_000;
  let receipt: ethers.TransactionReceipt | null = null;
  try {
    receipt = await reader.waitForTransaction(hash, 1, RECEIPT_TIMEOUT_MS);
  } catch {
    // Not seeing the receipt doesn't mean the tx failed — callers that need
    // certainty re-derive it (CctpFundModal's /confirm reads the chain itself).
  }
  return { hash, receipt };
}

function toWalletError(err: unknown): Error {
  const e = err as { code?: number | string; message?: string };
  const message = e?.message ?? String(err);
  if (e?.code === 4001 || /user (rejected|denied)/i.test(message)) {
    return new Error('You rejected the request in your wallet.');
  }
  if (/wallet timeout/i.test(message)) {
    return new Error('Your wallet didn\'t respond. Open it, approve or reject any pending requests, and try again.');
  }
  return err instanceof Error ? err : new Error(message);
}
