/**
 * Sending the client's own transactions: the deploy fee, escrow funding and
 * refunds. Everything here runs before, or right after, value moves, so each
 * check fails before anything is sent, and a hash is handed back the moment it
 * exists.
 */
import { ethers } from 'ethers';
import { ApiError } from './apiError.js';

/**
 * How long to wait for a receipt. Arc and Base confirm in seconds, so this
 * bounds a stuck RPC, not a slow chain. The transaction may still confirm
 * after it.
 */
export const DEFAULT_CONFIRM_TIMEOUT_MS = 180_000;

export interface SendOptions {
  /**
   * Called with the hash and nonce as soon as the transaction is broadcast,
   * before any wait, and again with the replacement's if the wallet re-prices
   * it. Persist them there: a crash from then on cannot lose them, and the
   * nonce tells later whether the transaction can still land (once the
   * sender's confirmed nonce passes it with no receipt, it never will). A
   * local key's signed raw transaction comes too: re-broadcast while its nonce
   * is unused, it can only land once, with this hash. A throwing callback does
   * not stop the send, which has already happened.
   */
  onSent?: (hash: string, nonce: number, raw?: string) => void | Promise<void>;
  timeoutMs?: number;
  nonce?: number;
  value?: bigint;
  gasLimit?: bigint;
  /** What the caller should do with the hash when the send could not be confirmed. */
  unconfirmedHint?: (hash: string) => string;
}

/** A transaction that was broadcast but not seen to confirm. It may still land. */
export class UnconfirmedTransactionError extends Error {
  constructor(public hash: string, message: string) {
    super(message);
    this.name = 'UnconfirmedTransactionError';
  }
}

async function notify(onSent: SendOptions['onSent'], hash: string, nonce: number, raw?: string): Promise<void> {
  if (!onSent) return;
  try {
    await onSent(hash, nonce, raw);
  } catch {
    // The transaction is out whatever the callback did; the caller still gets the hash.
  }
}

/**
 * Send a transaction and wait for it to confirm. Returns the hash that
 * confirmed: a sped-up transaction's replacement when the wallet re-priced it.
 * A revert or a cancel throws an Error saying nothing moved. A send that could
 * not be confirmed throws UnconfirmedTransactionError naming the hash.
 */
export async function sendAndWait(
  signer: ethers.Signer,
  tx: { to: string; data: string },
  opts: SendOptions = {},
): Promise<{ hash: string; nonce: number }> {
  const request = {
    to: tx.to,
    data: tx.data,
    ...(opts.value !== undefined ? { value: opts.value } : {}),
    ...(opts.nonce !== undefined ? { nonce: opts.nonce } : {}),
    ...(opts.gasLimit !== undefined ? { gasLimit: opts.gasLimit } : {}),
  };
  let sent: ethers.TransactionResponse;
  if (signsLocally(signer)) {
    // Signed, and its hash and nonce handed to onSent, before it leaves this
    // process: once the raw transaction is out, a lost reply cannot turn one
    // that may land into "nothing was sent".
    const populated = await signer.populateTransaction(request);
    const raw = await signer.signTransaction(populated);
    const hash = ethers.keccak256(raw);
    await notify(opts.onSent, hash, Number(populated.nonce), raw);
    try {
      sent = await signer.provider.broadcastTransaction(raw);
    } catch (err) {
      const hint = opts.unconfirmedHint ? ` ${opts.unconfirmedHint(hash)}` : '';
      throw new UnconfirmedTransactionError(
        hash,
        `Transaction ${hash} was signed and handed to the node, but no answer came back (${(err as Error).message}). It may still land.${hint}`,
      );
    }
  } else {
    // A wallet that signs out of reach (a browser extension) signs and sends in one step.
    sent = await signer.sendTransaction(request);
    await notify(opts.onSent, sent.hash, sent.nonce);
  }
  try {
    const receipt = await sent.wait(1, opts.timeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS);
    if (receipt && receipt.status === 0) throw new Error(`Transaction ${sent.hash} reverted, so nothing was paid.`);
    return { hash: sent.hash, nonce: sent.nonce };
  } catch (err) {
    if (ethers.isError(err, 'TRANSACTION_REPLACED')) {
      if (err.cancelled) throw new Error(`Transaction ${sent.hash} was cancelled or replaced in the wallet, so nothing was paid.`);
      const replacement = err.replacement;
      if (err.receipt && err.receipt.status === 0) throw new Error(`Transaction ${replacement.hash} reverted, so nothing was paid.`);
      await notify(opts.onSent, replacement.hash, replacement.nonce);
      return { hash: replacement.hash, nonce: replacement.nonce };
    }
    if (ethers.isError(err, 'CALL_EXCEPTION')) throw new Error(`Transaction ${sent.hash} reverted, so nothing was paid.`);
    if (err instanceof Error && err.message.startsWith(`Transaction ${sent.hash}`)) throw err;
    const hint = opts.unconfirmedHint ? ` ${opts.unconfirmedHint(sent.hash)}` : '';
    throw new UnconfirmedTransactionError(
      sent.hash,
      `Transaction ${sent.hash} was sent but not confirmed (${(err as Error).message}).${hint}`,
    );
  }
}

/** A signer holding its own key, with a provider: its transactions can be signed, recorded, then broadcast. */
function signsLocally(signer: ethers.Signer): signer is ethers.BaseWallet & { provider: ethers.Provider } {
  return signer instanceof ethers.BaseWallet && !!signer.provider;
}

/**
 * Throw, before anything is sent, unless `signer` is connected to chain
 * `chainId`. A transaction signed on the wrong network can succeed there
 * (a USDC address with no code accepts any call) and pay nobody.
 */
export async function assertSignerChain(signer: ethers.Signer, chainId: number | bigint, what: string): Promise<void> {
  const provider = signer.provider;
  if (!provider) {
    throw new ApiError(400, `${what} happens on chain ${chainId}, but the signer has no provider to check its chain with. Nothing was sent.`, undefined, 'NO_RPC');
  }
  let actual: bigint;
  try {
    actual = (await provider.getNetwork()).chainId;
  } catch (err) {
    throw new ApiError(503, `${what}: could not read the signer's chain (${(err as Error).message}). Nothing was sent.`, undefined, 'RPC_UNREACHABLE');
  }
  if (actual !== BigInt(chainId)) {
    throw new ApiError(
      409,
      `${what} happens on chain ${chainId}, but the signer's RPC is on chain ${actual}. Nothing was sent. Point the signer at an RPC for chain ${chainId}.`,
      undefined,
      'WRONG_CHAIN',
    );
  }
}

const ERC20 = new ethers.Interface([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
]);

/** An ERC-20 read through the signer's provider. */
async function erc20Read(signer: ethers.Signer, token: string, fn: 'allowance' | 'balanceOf', args: unknown[]): Promise<bigint> {
  const provider = signer.provider;
  if (!provider) throw new ApiError(400, 'The signer has no provider to read the token with.', undefined, 'NO_RPC');
  const raw = await provider.call({ to: token, data: ERC20.encodeFunctionData(fn, args) });
  return ERC20.decodeFunctionResult(fn, raw)[0] as bigint;
}

// The escrow reads that bind an open task's on-chain id to its hash. getTask's
// tuple is read up to submissionAttempts: a later field (disputedAt) is ignored.
const ESCROW_READS = new ethers.Interface([
  'function getTask(uint256 taskId) view returns (tuple(address agent, address worker, address token, uint256 amount, bytes32 taskHash, bytes32 evidenceHash, uint8 status, string category, string locationZone, uint256 createdAt, uint256 deadline, uint8 submissionAttempts))',
  'function getOpenTask(uint256 taskId) view returns (tuple(bool open, uint8 mode, uint32 creatorWindow, uint8 closedBy))',
  'function submissionOf(uint256 taskId, address submitter) view returns (bytes32)',
]);

/**
 * What the escrow itself says about an open task, read over the signer's own
 * RPC rather than taken from the backend: its brief's hash, whether it takes
 * open submissions, and (with `submitter`) that wallet's evidence hash
 * (zero for none).
 */
export async function openTaskOnChain(signer: ethers.Signer, escrow: string, taskId: bigint, submitter?: string): Promise<{ taskHash: string; open: boolean; submission?: string }> {
  const provider = signer.provider;
  if (!provider) throw new ApiError(400, 'The signer has no provider to read the escrow with.', undefined, 'NO_RPC');
  const read = async (fn: string, args: unknown[]) => ESCROW_READS.decodeFunctionResult(fn, await provider.call({ to: escrow, data: ESCROW_READS.encodeFunctionData(fn, args) }))[0];
  const [task, open, submission] = await Promise.all([
    read('getTask', [taskId]),
    read('getOpenTask', [taskId]),
    submitter ? read('submissionOf', [taskId, submitter]) : Promise.resolve(undefined),
  ]);
  return { taskHash: String(task.taskHash), open: Boolean(open.open), ...(submission !== undefined ? { submission: String(submission) } : {}) };
}

export function tokenBalance(signer: ethers.Signer, token: string, owner: string): Promise<bigint> {
  return erc20Read(signer, token, 'balanceOf', [owner]);
}

/**
 * Make sure `spender` may pull `amount` of `token` from the signer: approve
 * exactly `amount` when the allowance is short. Returns the nonce the next
 * transaction should use when an approve was sent (an RPC can answer the
 * next nonce lookup from before the approve landed), else undefined.
 */
export async function ensureAllowance(
  signer: ethers.Signer,
  token: string,
  spender: string,
  amount: bigint,
  opts: Pick<SendOptions, 'timeoutMs'> = {},
): Promise<number | undefined> {
  const owner = await signer.getAddress();
  if ((await erc20Read(signer, token, 'allowance', [owner, spender])) >= amount) return undefined;
  const { nonce } = await sendAndWait(signer, { to: token, data: ERC20.encodeFunctionData('approve', [spender, amount]) }, opts);
  return nonce + 1;
}
