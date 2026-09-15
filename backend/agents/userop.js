/**
 * userop.js - ERC-4337 v0.7 UserOperation builder.
 *
 * Builds signed UserOps for BlindAccount.execute() and submits them to a
 * v0.7 bundler (Pimlico). Uses only ethers v6 which the worker already has.
 *
 * Two representations are in play:
 *   - internal: UNPACKED fields (callGasLimit, maxFeePerGas, paymaster +
 *     its gas limits as separate values). This is what Pimlico's JSON-RPC
 *     API validates against — it rejects the packed struct keys
 *     (accountGasLimits, gasFees, paymasterAndData, initCode).
 *   - hashing: the EntryPoint's getUserOpHash packs them
 *     (accountGasLimits, gasFees, paymasterAndData) before hashing, so
 *     hashUserOp derives the packed blobs on the fly from the unpacked
 *     fields. Both representations always describe the same op.
 *
 * UserOp hash (v0.7):
 *   hash(op) = keccak256(abi.encode(
 *     sender, nonce,
 *     keccak256(initCode), keccak256(callData),
 *     accountGasLimits, preVerificationGas, gasFees,
 *     keccak256(paymasterAndData)
 *   ))
 *   getUserOpHash = keccak256(abi.encode(hash(op), entryPoint, chainId))
 */
import { ethers } from 'ethers';

// ABI used to encode BlindAccount.execute(to, value, data)
const BlindAccountExecuteAbi = ['function execute(address to, uint256 value, bytes data)'];

// EntryPoint v0.7 view for nonce lookup
const EntryPointAbi = [
  'function getNonce(address sender, uint192 key) view returns (uint256)',
];

// ── encode callData ──────────────────────────────────────────────────────────

/**
 * Encode BlindAccount.execute(target, value, data) as callData for a UserOp.
 */
export function encodeExecuteCallData(target, value, data) {
  const iface = new ethers.Interface(BlindAccountExecuteAbi);
  return iface.encodeFunctionData('execute', [target, value, data]);
}

// ── build UserOperation (v0.7, unpacked) ─────────────────────────────────────

/**
 * Build a v0.7 UserOperation for a single execute call.
 *
 * Gas defaults are intentionally generous; a real deployment should call the
 * bundler's estimate endpoint to fill them precisely.
 *
 * @param {Object} params
 * @param {string} params.sender        - BlindAccount address
 * @param {bigint} params.nonce         - EntryPoint nonce for this account
 * @param {string} params.callData      - encoded execute() callData
 * @param {Object} [params.gasLimits]   - { callGasLimit, verificationGasLimit, preVerificationGas }
 * @param {Object} [params.fees]        - { maxFeePerGas, maxPriorityFeePerGas }
 * @param {Object} [params.paymaster]   - { address, verificationGasLimit, postOpGasLimit, data }
 *                                        (omit when no paymaster sponsors the op)
 */
export function buildUserOp(opts) {
  const sender = opts.sender;
  const nonce = opts.nonce;
  const callData = opts.callData;
  const gasLimits = opts.gasLimits ?? {};
  const fees = opts.fees ?? {};
  const {
    callGasLimit = 200_000,
    verificationGasLimit = 500_000,
    preVerificationGas = 100_000,
  } = gasLimits;

  const {
    maxFeePerGas = 100_000_000,           // 0.1 gwei default (Base Sepolia is cheap;
    maxPriorityFeePerGas = 10_000_000,    // 0.01 gwei — keeps the paymaster's USDC
  } = fees;                               // charge (~0.27 USDC/op) near a 1-USDC top-up

  const pm = opts.paymaster ?? null;
  const paymaster = pm
    ? {
        address: pm.address,
        verificationGasLimit: BigInt(pm.verificationGasLimit ?? pm.validationGasLimit ?? 100_000),
        postOpGasLimit: BigInt(pm.postOpGasLimit ?? 50_000),
        data: pm.data ?? '0x',
      }
    : null;

  return {
    sender,
    nonce: BigInt(nonce),
    callData,
    callGasLimit: BigInt(callGasLimit),
    verificationGasLimit: BigInt(verificationGasLimit),
    preVerificationGas: BigInt(preVerificationGas),
    maxFeePerGas: BigInt(maxFeePerGas),
    maxPriorityFeePerGas: BigInt(maxPriorityFeePerGas),
    paymaster,
    signature: '0x',
  };
}

// ── sign ─────────────────────────────────────────────────────────────────────

/**
 * Sign a UserOperation with the agent's EOA key.
 *
 * @param {Object} userOp     - built user op (with signature='0x')
 * @param {string} entryPoint - EntryPoint v0.7 address
 * @param {number} chainId    - target chain id
 * @param {string} privateKey - agent's EOA private key (hex, with or without 0x)
 * @returns {Object}          - the same op with the 65-byte signature attached
 */
export function signUserOp(userOp, entryPoint, chainId, privateKey) {
  const hash = hashUserOp(userOp);
  // EntryPoint v0.7: getUserOpHash = keccak256(abi.encode(hash, entryPoint, chainId))
  const opHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'address', 'uint256'],
      [hash, entryPoint, chainId],
    ),
  );

  const key = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const wallet = new ethers.Wallet(key);
  // Sign the raw digest, not the Ethereum Signed Message prefix.
  const sig = wallet.signingKey.sign(ethers.getBytes(opHash));
  return { ...userOp, signature: sig.serialized };
}

// ── submit to bundler ──────────────────────────────────────────────────────────

/**
 * Submit a signed UserOp to a v0.7 bundler via eth_sendUserOperation.
 *
 * @param {Object} userOp       - signed UserOp
 * @param {string} bundlerUrl   - bundler JSON-RPC URL
 * @param {string} apiKey       - optional API key (sent as Bearer token)
 * @param {string} entryPoint   - EntryPoint v0.7 address
 * @returns {Promise<string>}   - UserOp hash from the bundler
 */
export async function submitUserOp(userOp, bundlerUrl, apiKey, entryPoint) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const packed = toRpcUserOp(userOp);
  const res = await fetch(bundlerUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'eth_sendUserOperation',
      params: [packed, entryPoint],
    }),
  });

  const json = await res.json().catch(() => ({}));
  if (json.error) {
    throw new Error(`Bundler error: ${json.error.message ?? JSON.stringify(json.error)}`);
  }
  if (json.result == null) {
    throw new Error(`Bundler returned no result: ${JSON.stringify(json)}`);
  }
  return json.result;
}

/**
 * Estimate UserOp gas via the bundler (pimlico_estimateUserOperationGas).
 *
 * @param {Object} userOp       - unsigned UserOp
 * @param {string} bundlerUrl   - bundler JSON-RPC URL
 * @param {string} apiKey       - optional API key
 * @param {string} entryPoint   - EntryPoint v0.7 address
 * @returns {Promise<Object>}   - { callGasLimit, verificationGasLimit, preVerificationGas, ... }
 */
export async function estimateUserOpGas(userOp, bundlerUrl, apiKey, entryPoint) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetch(bundlerUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'eth_estimateUserOperationGas',
      params: [toRpcUserOp(userOp), entryPoint],
    }),
  });

  const json = await res.json().catch(() => ({}));
  if (json.error) {
    throw new Error(`Estimate error: ${json.error.message ?? JSON.stringify(json.error)}`);
  }
  return json.result;
}

/**
 * Fetch the current EntryPoint nonce for a smart account.
 *
 * @param {string} entryPoint - EntryPoint address
 * @param {string} sender     - smart account address
 * @param {string} rpcUrl     - Base RPC URL
 * @param {number} key        - nonce key (default 0)
 * @returns {Promise<bigint>}
 */
export async function getSmartAccountNonce(entryPoint, sender, rpcUrl, key = 0) {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const ep = new ethers.Contract(entryPoint, EntryPointAbi, provider);
  return BigInt(await ep.getNonce(sender, BigInt(key)));
}

/**
 * Build paymasterAndData for a v0.7 paymaster.
 *
 * @param {string} paymaster           - paymaster address
 * @param {number} validationGasLimit  - gas for paymaster validation
 * @param {number} postOpGasLimit      - gas for paymaster postOp
 * @param {string} paymasterData       - extra paymaster data (default empty)
 * @returns {string}                   - encoded paymasterAndData
 */
export function buildPaymasterAndData(
  paymaster,
  validationGasLimit = 100_000,
  postOpGasLimit = 50_000,
  paymasterData = '0x',
) {
  return (
    paymaster.toLowerCase() +
    stripHexPrefix(ethers.zeroPadValue(ethers.toBeHex(BigInt(validationGasLimit)), 16)) +
    stripHexPrefix(ethers.zeroPadValue(ethers.toBeHex(BigInt(postOpGasLimit)), 16)) +
    stripHexPrefix(paymasterData)
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function hashUserOp(userOp) {
  // The EntryPoint hashes the PACKED form — derive it here from the unpacked
  // fields so the two representations can never disagree.
  const accountGasLimits = packGasLimits(userOp.verificationGasLimit, userOp.callGasLimit);
  const gasFees = packGasLimits(userOp.maxPriorityFeePerGas, userOp.maxFeePerGas);
  const paymasterAndData = packPaymaster(userOp.paymaster);
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      [
        'address',
        'uint256',
        'bytes32',
        'bytes32',
        'bytes32',
        'uint256',
        'bytes32',
        'bytes32',
      ],
      [
        userOp.sender,
        userOp.nonce,
        ethers.keccak256('0x'),
        ethers.keccak256(userOp.callData),
        accountGasLimits,
        userOp.preVerificationGas,
        gasFees,
        ethers.keccak256(paymasterAndData),
      ],
    ),
  );
}

function packGasLimits(high, low) {
  const high128 = BigInt.asUintN(128, BigInt(high));
  const low128 = BigInt.asUintN(128, BigInt(low));
  return ethers.zeroPadValue(ethers.toBeHex((high128 << 128n) | low128), 32);
}

function packPaymaster(pm) {
  if (!pm) return '0x';
  return buildPaymasterAndData(pm.address, pm.verificationGasLimit, pm.postOpGasLimit, pm.data);
}

function toRpcUserOp(userOp) {
  // Pimlico validates the UNPACKED v0.7 shape: separate fee/gas fields and
  // paymaster components. It rejects the packed struct keys
  // (initCode, accountGasLimits, gasFees, paymasterAndData).
  const out = {
    sender: userOp.sender,
    nonce: toHex(userOp.nonce),
    callData: userOp.callData,
    callGasLimit: toHex(userOp.callGasLimit),
    verificationGasLimit: toHex(userOp.verificationGasLimit),
    preVerificationGas: toHex(userOp.preVerificationGas),
    maxFeePerGas: toHex(userOp.maxFeePerGas),
    maxPriorityFeePerGas: toHex(userOp.maxPriorityFeePerGas),
    signature: userOp.signature,
  };
  if (userOp.paymaster) {
    out.paymaster = userOp.paymaster.address;
    out.paymasterVerificationGasLimit = toHex(userOp.paymaster.verificationGasLimit);
    out.paymasterPostOpGasLimit = toHex(userOp.paymaster.postOpGasLimit);
    out.paymasterData = userOp.paymaster.data;
  }
  return out;
}

function toHex(value) {
  return ethers.toBeHex(BigInt(value));
}

function stripHexPrefix(value) {
  return value.startsWith('0x') ? value.slice(2) : value;
}
