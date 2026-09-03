import type { ethers } from 'ethers';
import type { UnsignedTx } from '../types/api';
import { API_BASE_URL } from '../config/constants';

export interface SentTx {
  hash: string;
  receipt: ethers.TransactionReceipt | null;
}

/**
 * Builds the Privy RPC request body for eth_sendTransaction with sponsorship.
 */
export function buildPrivyRpcBody(
  unsignedTx: UnsignedTx,
  value: bigint | undefined,
  chainId: number,
) {
  const caip2 = `eip155:${chainId}`;
  const transaction: Record<string, string> = { to: unsignedTx.to };
  if (unsignedTx.data && unsignedTx.data !== '0x') transaction.data = unsignedTx.data;
  if (value != null) transaction.value = `0x${value.toString(16)}`;

  return {
    method: 'eth_sendTransaction' as const,
    caip2,
    chain_type: 'ethereum' as const,
    sponsor: true as const,
    sponsor_options: { asset: 'usdc' as const },
    params: { transaction },
  };
}

/**
 * Build the full Privy authorization request input for useAuthorizationSignature.
 */
export function buildAuthRequestInput(
  privyRpcBody: ReturnType<typeof buildPrivyRpcBody>,
  walletAddress: string,
  privyAppId: string,
) {
  return {
    version: 1 as const,
    method: 'POST' as const,
    url: `https://api.privy.io/v1/wallets/${walletAddress}/rpc`,
    body: privyRpcBody,
    headers: {
      'privy-app-id': privyAppId,
    },
  };
}

/**
 * Relays a transaction through the backend to Privy's REST API with
 * sponsor_options for "user_pays" gas sponsorship.
 */
export async function sendSponsoredTx(
  signer: ethers.JsonRpcSigner,
  unsignedTx: UnsignedTx,
  value: bigint | undefined,
  chainId: number,
  walletAddress: string,
  authorizationSignature: string,
  privyRpcBody: ReturnType<typeof buildPrivyRpcBody>,
): Promise<SentTx> {
  const res = await fetch(`${API_BASE_URL}/api/v1/tx/send-sponsored`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      to: unsignedTx.to,
      data: unsignedTx.data || '0x',
      value: value != null ? `0x${value.toString(16)}` : undefined,
      chainId,
      walletAddress,
      authorizationSignature,
      privyRpcBody,
    }),
  });

  const json = await res.json();
  if (!json.success) {
    throw new Error(json.error?.message || `Sponsored tx failed: ${res.status}`);
  }

  const txHash: string = json.data.hash;

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const receipt = await signer.provider.getTransactionReceipt(txHash);
      if (receipt) return { hash: txHash, receipt };
    } catch { /* keep retrying */ }
  }
  return { hash: txHash, receipt: null };
}

/**
 * Send a transaction via signer (no sponsorship — used for 0G chain).
 */
export async function signAndSendTx(
  signer: ethers.JsonRpcSigner,
  unsignedTx: UnsignedTx,
  value?: bigint,
): Promise<SentTx> {
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
