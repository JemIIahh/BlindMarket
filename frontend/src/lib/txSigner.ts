import type { ethers } from 'ethers';
import type { UnsignedTx } from '../types/api';
import { getAccessToken } from '@privy-io/react-auth';

export interface SentTx {
  hash: string;
  receipt: ethers.TransactionReceipt | null;
}

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
 * Send a gas-sponsored transaction directly through Privy's API from the browser.
 * No backend relay needed — the frontend signs the request via useAuthorizationSignature
 * and calls Privy directly. sponsor_options is included in the signed body.
 */
export async function sendSponsoredTx(
  signer: ethers.JsonRpcSigner,
  _unsignedTx: UnsignedTx,
  _value: bigint | undefined,
  _chainId: number,
  walletAddress: string,
  authorizationSignature: string,
  privyRpcBody: ReturnType<typeof buildPrivyRpcBody>,
): Promise<SentTx> {
  const privyAppId = import.meta.env.VITE_PRIVY_APP_ID;

  const accessToken = await getAccessToken();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'privy-app-id': privyAppId,
    'privy-authorization-signature': authorizationSignature,
  };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  const privyRes = await fetch(`https://api.privy.io/v1/wallets/${walletAddress}/rpc`, {
    method: 'POST',
    headers,
    body: JSON.stringify(privyRpcBody),
  });

  const privyBody = await privyRes.json();

  if (!privyRes.ok) {
    const errMsg = privyBody?.message || privyBody?.error || `Privy API ${privyRes.status}`;
    throw new Error(errMsg);
  }

  const txHash: string = privyBody?.data?.hash || privyBody?.hash || '';
  console.log(`[sendSponsoredTx] tx hash=${txHash} chain=${privyRpcBody.caip2}`);

  if (!txHash) throw new Error('No transaction hash returned from Privy');

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
