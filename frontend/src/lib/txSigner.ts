import type { ethers } from 'ethers';
import type { UnsignedTx } from '../types/api';

export async function signAndSendTx(
  signer: ethers.JsonRpcSigner,
  unsignedTx: UnsignedTx,
  value?: bigint,
): Promise<ethers.TransactionReceipt | null> {
  const txResponse = await signer.sendTransaction({
    to: unsignedTx.to,
    data: unsignedTx.data,
    value: value ?? unsignedTx.value,
    gasLimit: unsignedTx.gasLimit ?? 500_000,
  });

  // Retry receipt fetch — 0G testnet RPC can be slow to index
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const receipt = await txResponse.provider.getTransactionReceipt(txResponse.hash);
      if (receipt) return receipt;
    } catch { /* keep retrying */ }
  }
  // Return null rather than throwing — tx was submitted, just not confirmed yet
  return null;
}
