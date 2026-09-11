import { ethers } from 'ethers';
import type { ConnectedWallet } from '@privy-io/react-auth';
import type { UnsignedTx } from '../types/api';

/**
 * Sign and broadcast a transaction directly from a Privy wallet against its
 * OWN chain — no backend relay involved. Unlike txSigner.ts's
 * signAndSendTx() (hardcoded to Base + the gas-sponsored relay), this is for
 * CCTP Phase B's source-chain burn: the wallet may be on Ethereum, Ethereum
 * Sepolia, or any other CCTP-supported chain, paying that chain's own native
 * gas from its own balance — Circle's Forwarding Service gasless property
 * only covers the DESTINATION Base mint, not this source-chain call.
 */
export async function signAndSendDirect(
  wallet: ConnectedWallet,
  unsignedTx: UnsignedTx,
): Promise<{ hash: string; receipt: ethers.TransactionReceipt | null }> {
  const ethereumProvider = await wallet.getEthereumProvider();
  const browserProvider = new ethers.BrowserProvider(ethereumProvider);
  const signer = await browserProvider.getSigner();

  const tx = await signer.sendTransaction({
    to: unsignedTx.to,
    data: unsignedTx.data,
    value: unsignedTx.value ? BigInt(unsignedTx.value) : undefined,
  });

  let receipt: ethers.TransactionReceipt | null = null;
  try {
    receipt = await tx.wait();
  } catch {
    // Confirmation polling failing doesn't mean the tx failed — the caller
    // (CctpFundModal) still has tx.hash and moves on to /confirm, which
    // independently re-derives success from the chain's own receipt.
  }
  return { hash: tx.hash, receipt };
}
