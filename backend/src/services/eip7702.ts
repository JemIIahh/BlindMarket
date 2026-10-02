/**
 * EIP-7702 (set-code transactions) for the gas-sponsorship relayer
 * (docs/AGENT-GAS-FUNDING.md).
 *
 * The backend pins ethers 6.13.1, which predates 7702 (type-4 transactions
 * and authorizations arrived in 6.14), so the two encodings it needs are
 * here, built from ethers' RLP, keccak and secp256k1 primitives:
 *
 *   authorization: sign keccak256(0x05 ‖ rlp([chainId, address, nonce]))
 *   transaction:   0x04 ‖ rlp([chainId, nonce, maxPriorityFeePerGas,
 *                  maxFeePerGas, gasLimit, to, value, data, accessList,
 *                  authorizationList, yParity, r, s])
 *
 * eip7702.test.ts checks both against vectors produced by ethers 6.17.
 */
import { ethers } from 'ethers';

export interface Authorization {
  chainId: bigint;
  address: string;
  nonce: bigint;
  yParity: number;
  r: string;
  s: string;
}

/** The code a wallet carries while it is delegated to `delegate`: 0xef0100 ‖ address. */
export function delegationDesignator(delegate: string): string {
  return `0xef0100${ethers.getAddress(delegate).slice(2).toLowerCase()}`;
}

/** True when `code` (eth_getCode of a wallet) delegates it to `delegate`. */
export function isDelegatedTo(code: string, delegate: string): boolean {
  return code.toLowerCase() === delegationDesignator(delegate);
}

/** An RLP integer: big-endian, no leading zeros, zero as the empty string. */
function rlpInt(value: bigint | number): Uint8Array {
  return ethers.toBeArray(BigInt(value));
}

/** The digest an authorization signs. */
export function authorizationHash(auth: { chainId: bigint; address: string; nonce: bigint }): string {
  return ethers.keccak256(
    ethers.concat(['0x05', ethers.encodeRlp([rlpInt(auth.chainId), ethers.getAddress(auth.address), rlpInt(auth.nonce)])]),
  );
}

export function signAuthorization(
  key: ethers.SigningKey,
  auth: { chainId: bigint; address: string; nonce: bigint },
): Authorization {
  const sig = key.sign(authorizationHash(auth));
  return { chainId: auth.chainId, address: ethers.getAddress(auth.address), nonce: auth.nonce, yParity: sig.yParity, r: sig.r, s: sig.s };
}

/** The address that signed `auth`, or null when the signature is malformed. */
export function authorizationSigner(auth: Authorization): string | null {
  try {
    if (auth.yParity !== 0 && auth.yParity !== 1) return null;
    return ethers.recoverAddress(authorizationHash(auth), ethers.Signature.from({ r: auth.r, s: auth.s, yParity: auth.yParity }));
  } catch {
    return null;
  }
}

/** An authorization as eth_estimateGas / eth_call take it in `authorizationList`. */
export function authorizationToRpc(auth: Authorization): Record<string, string> {
  return {
    chainId: ethers.toQuantity(auth.chainId),
    address: auth.address,
    nonce: ethers.toQuantity(auth.nonce),
    yParity: ethers.toQuantity(auth.yParity),
    r: ethers.toQuantity(auth.r),
    s: ethers.toQuantity(auth.s),
  };
}

export interface SetCodeTx {
  chainId: bigint;
  nonce: number;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  to: string;
  value?: bigint;
  data: string;
  authorizationList: Authorization[];
}

function payload(tx: SetCodeTx): ethers.RlpStructuredDataish[] {
  return [
    rlpInt(tx.chainId),
    rlpInt(tx.nonce),
    rlpInt(tx.maxPriorityFeePerGas),
    rlpInt(tx.maxFeePerGas),
    rlpInt(tx.gasLimit),
    ethers.getAddress(tx.to),
    rlpInt(tx.value ?? 0n),
    tx.data,
    [],
    tx.authorizationList.map((a) => [
      rlpInt(a.chainId),
      ethers.getAddress(a.address),
      rlpInt(a.nonce),
      rlpInt(a.yParity),
      rlpInt(BigInt(a.r)),
      rlpInt(BigInt(a.s)),
    ]),
  ];
}

/** Sign a type-4 transaction. Returns the raw transaction and its hash. */
export function signSetCodeTx(key: ethers.SigningKey, tx: SetCodeTx): { raw: string; hash: string } {
  const fields = payload(tx);
  const sig = key.sign(ethers.keccak256(ethers.concat(['0x04', ethers.encodeRlp(fields)])));
  const raw = ethers.concat(['0x04', ethers.encodeRlp([...fields, rlpInt(sig.yParity), rlpInt(BigInt(sig.r)), rlpInt(BigInt(sig.s))])]);
  return { raw, hash: ethers.keccak256(raw) };
}
