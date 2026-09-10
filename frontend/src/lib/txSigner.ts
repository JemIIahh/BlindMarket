import type { ethers } from 'ethers';
import type { UnsignedTx } from '../types/api';
import { getAuthHeaders } from './api';
import { API_BASE_URL, BASE_CHAIN_ID } from '../config/constants';

export interface SentTx {
  hash: string;
  receipt: ethers.TransactionReceipt | null;
  userOp?: boolean;
}

export class RelayError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'RelayError';
  }
}

function getRelayChain(): string {
  if (BASE_CHAIN_ID === 8453) return 'base-mainnet';
  return 'base-sepolia';
}

/**
 * Relay a gas-sponsored transaction through the backend.
 * The server uses @privy-io/node to call Privy's RPC.
 */
export async function signAndSendTx(
  signer: ethers.JsonRpcSigner,
  unsignedTx: UnsignedTx,
  value?: bigint,
): Promise<SentTx> {
  const from = await signer.getAddress();
  const body = {
    walletAddress: from,
    to: unsignedTx.to,
    data: unsignedTx.data,
    value: value ? String(value) : undefined,
    chain: getRelayChain(),
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

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const receipt = await signer.provider.getTransactionReceipt(txHash);
      if (receipt) return { hash: txHash, receipt };
    } catch { /* keep retrying */ }
  }
  return { hash: txHash, receipt: null };
}
