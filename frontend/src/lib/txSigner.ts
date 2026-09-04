import type { ethers } from 'ethers';
import type { UnsignedTx } from '../types/api';

export interface SentTx {
  hash: string;
  receipt: ethers.TransactionReceipt | null;
}

/**
 * Send a transaction via Privy's useSendTransaction with gas sponsorship.
 * Requires "app pays" mode in Privy dashboard (sponsor: true without sponsor_options).
 */
export async function signAndSendTx(
  signer: ethers.JsonRpcSigner,
  unsignedTx: UnsignedTx,
  value?: bigint,
  sendFn?: (input: any, options?: any) => Promise<{ hash: string }>,
): Promise<SentTx> {
  if (sendFn) {
    const tx = await sendFn(
      { to: unsignedTx.to, data: unsignedTx.data, value, gasLimit: 1_000_000 },
      { sponsor: true },
    );

    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const receipt = await signer.provider.getTransactionReceipt(tx.hash);
        if (receipt) return { hash: tx.hash, receipt };
      } catch { /* keep retrying */ }
    }
    return { hash: tx.hash, receipt: null };
  }

  const txResponse = await signer.sendTransaction({
    to: unsignedTx.to,
    data: unsignedTx.data,
    value: value,
    gasLimit: 1_000_000,
  });

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const receipt = await txResponse.provider.getTransactionReceipt(txResponse.hash);
      if (receipt) return { hash: txResponse.hash, receipt };
    } catch { /* keep retrying */ }
  }
  return { hash: txResponse.hash, receipt: null };
}
