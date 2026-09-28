/**
 * How a bulk run signs (docs/BULK-POSTING.md).
 *
 * The poster confirms the whole run once, in the app. After that:
 * - the embedded (Privy) wallet sends each transaction through Privy's
 *   useSendTransaction with `showWalletUIs: false`, for this run only. The
 *   app-wide default (a Privy confirmation per transaction) is untouched;
 * - an external wallet keeps its own prompt per transaction (the page says
 *   so and suggests the CLI for large runs);
 * - a relayed chain goes through the backend relay as every other page does.
 *
 * A failed send says what it did, so a paid row is never shown as unpaid:
 * TxRevertedError for a mined receipt with status 0 (nothing was funded),
 * NotSentError for a failure before the wallet had the transaction. For any
 * other error, sentNothing() says whether it still can't have paid.
 */
import { Interface, type JsonRpcProvider, type TransactionReceipt, type ethers } from 'ethers';
import { TxMismatchError, checkBulkCall, type CheckedCall, type PinnedContracts } from './bulkCalls';
import { friendlyError } from './friendlyError';
import { RelayError, isDirectSigned, providerFor, signAndSendTx, type SentTx } from './txSigner';
import { getSettlement, type SettlementChainKey } from '../config/settlement';

/** A mined transaction whose receipt has status 0: it reverted, so it funded nothing. */
export class TxRevertedError extends RelayError {
  readonly hash?: string;
  constructor(hash?: string) {
    super('TX_REVERTED', `${hash ? `Transaction ${hash}` : 'The transaction'} reverted on-chain, so it had no effect (only its gas was spent).`);
    this.name = 'TxRevertedError';
    this.hash = hash;
  }
}

/** A send that failed before the wallet had the transaction (the gas
 *  estimate, the signer): nothing can have been paid. Keeps the cause's words. */
export class NotSentError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'NotSentError';
    this.cause = cause;
  }
}

async function beforeSending<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (e) {
    throw new NotSentError(e);
  }
}

// Failures that come before a transaction is broadcast, or from one that
// reverted: the poster refused it (ACTION_REJECTED, 4001), the wallet can't
// pay the fee (INSUFFICIENT_FUNDS), the wallet is on another chain
// (WRONG_CHAIN, 4902), or execution reverted (CALL_EXCEPTION, in the gas
// estimate or on-chain; a revert funds nothing). Codes and names only: text
// is not enough, since "network changed" also follows a broadcast.
const NOTHING_SENT_CODES = new Set<string | number>([
  'ACTION_REJECTED', 4001, 'INSUFFICIENT_FUNDS', 'insufficient_balance', 'WRONG_CHAIN', 4902, 'unsupported_chain_id', 'CALL_EXCEPTION', 'TX_REVERTED',
]);
const NOTHING_SENT_NAMES = new Set([
  'UserRejectedRequestError', 'InsufficientFundsError', 'ChainMismatchError', 'EstimateGasExecutionError', 'ContractFunctionRevertedError',
]);

/** Every code and name on an error and what it wraps (ethers `info`/`error`, viem `cause`). */
function codesAndNames(err: unknown): { codes: Array<string | number>; names: string[] } {
  const codes: Array<string | number> = [];
  const names: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 6 || !value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    const n = value as Record<string, unknown>;
    if (typeof n.code === 'string' || typeof n.code === 'number') codes.push(n.code);
    if (typeof n.name === 'string') names.push(n.name);
    for (const inner of [n.info, n.error, n.cause, n.data, n.originalError]) visit(inner, depth + 1);
  };
  visit(err, 0);
  return { codes, names };
}

/**
 * Whether a failed send, with no transaction hash to go on, can't have paid
 * anything: it failed before the wallet had it, the poster refused it, the
 * chain was wrong, the wallet couldn't pay the fee, or it reverted. Anything
 * else (a dropped connection, a wallet error nobody names) may have come after
 * the broadcast, and the row must then be treated as maybe paid.
 */
export function sentNothing(err: unknown): boolean {
  if (err instanceof NotSentError || err instanceof TxRevertedError || err instanceof TxMismatchError) return true;
  if (friendlyError(err).kind === 'cancelled') return true;
  const { codes, names } = codesAndNames(err);
  return codes.some((c) => NOTHING_SENT_CODES.has(c)) || names.some((n) => NOTHING_SENT_NAMES.has(n));
}

/** Privy's useSendTransaction().sendTransaction, as this module calls it. */
export type PrivySend = (
  input: { to: string; data: string; value?: bigint; chainId: number; gasLimit?: bigint },
  options: { uiOptions: { showWalletUIs: boolean }; address: string },
) => Promise<{ hash: `0x${string}` }>;

type ReceiptReader = Pick<JsonRpcProvider, 'getTransactionReceipt'>;
type ChainReader = ReceiptReader & Pick<JsonRpcProvider, 'estimateGas'>;

/** Head-room on an estimate: a createTasks batch costs ~200k gas per task. */
const GAS_BUFFER_PCT = 20n;

/**
 * The gas limit for a headless send: this transaction's own estimate, from
 * this app's RPC, plus a buffer. Never a limit the backend named (a checked
 * call carries only its target and calldata): one set too low reverts with
 * the gas spent, and on Arc gas is paid in USDC. Never a single task's limit
 * reused for a batch either. An estimate that reverts means the transaction
 * would fail: it throws here, before anything is broadcast.
 */
export async function gasLimitFor(reader: Pick<JsonRpcProvider, 'estimateGas'>, call: { to: string; data: string }, from: string): Promise<bigint> {
  const estimate = await reader.estimateGas({ from, to: call.to, data: call.data });
  return estimate + (estimate * GAS_BUFFER_PCT) / 100n;
}

/**
 * Poll for a receipt. Reverted: throws TxRevertedError (nothing was funded).
 * Not seen within the wait: null, which callers treat as unconfirmed.
 */
export async function waitForReceipt(
  provider: ReceiptReader,
  hash: string,
  { tries = 40, intervalMs = 3000 }: { tries?: number; intervalMs?: number } = {},
): Promise<TransactionReceipt | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const receipt = await provider.getTransactionReceipt(hash);
      if (receipt) {
        if (receipt.status === 0) throw new TxRevertedError(hash);
        return receipt;
      }
    } catch (err) {
      if (err instanceof RelayError) throw err;
      /* RPC hiccup: keep polling */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

export interface BulkSigner {
  /** True when this run sends without a wallet prompt per transaction. */
  headless: boolean;
  /** Send a call lib/bulkCalls checked: its target and calldata, nothing else. */
  send: (call: CheckedCall, onBroadcast: (hash: string) => void) => Promise<SentTx>;
}

/**
 * The run's sender. Headless only for the embedded wallet on a chain it signs
 * directly (Arc); relayed chains never prompt anyway, and an external wallet
 * always prompts.
 */
export function bulkSigner(opts: {
  chain: SettlementChainKey;
  /** The address that pays: the connected signer. */
  from: string;
  embeddedAddress: string | null;
  privySend: PrivySend | null;
  getSigner: () => Promise<ethers.JsonRpcSigner>;
  provider?: ChainReader;
}): BulkSigner {
  const embedded = !!opts.embeddedAddress && opts.embeddedAddress.toLowerCase() === opts.from.toLowerCase();
  const headless = embedded && !!opts.privySend && isDirectSigned(opts.chain);
  if (headless) {
    const chainId = getSettlement().chains[opts.chain].chainId;
    const reader = opts.provider ?? providerFor(opts.chain);
    return {
      headless: true,
      send: async (call, onBroadcast) => {
        const gasLimit = await beforeSending(() => gasLimitFor(reader, call, opts.embeddedAddress!));
        const { hash } = await opts.privySend!(
          { to: call.to, data: call.data, chainId, gasLimit },
          { uiOptions: { showWalletUIs: false }, address: opts.embeddedAddress! },
        );
        onBroadcast(hash);
        return { hash, receipt: await waitForReceipt(reader, hash) };
      },
    };
  }
  return {
    headless: !isDirectSigned(opts.chain),
    send: async (call, onBroadcast) => {
      const signer = await beforeSending(opts.getSigner);
      let sent: SentTx;
      try {
        sent = await signAndSendTx(signer, { from: opts.from, to: call.to, data: call.data }, undefined, { chain: opts.chain });
      } catch (e) {
        // txSigner says TX_REVERTED only for a mined receipt with status 0.
        if (e instanceof RelayError && e.code === 'TX_REVERTED') throw new TxRevertedError(e.message.match(/0x[0-9a-fA-F]{64}/)?.[0]);
        throw e;
      }
      onBroadcast(sent.hash);
      return sent;
    },
  };
}

const ERC20 = new Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

type CallReader = Pick<JsonRpcProvider, 'call'>;

export async function readAllowance(provider: CallReader, token: string, owner: string, spender: string): Promise<bigint> {
  const raw = await provider.call({ to: token, data: ERC20.encodeFunctionData('allowance', [owner, spender]) });
  return ERC20.decodeFunctionResult('allowance', raw)[0] as bigint;
}

/**
 * Let the escrow pull `total` in one approval (approve sets the allowance, it
 * does not add to it), then wait until the chain shows it: the first funding
 * transaction would otherwise revert. No-op when the allowance already covers
 * it. The spender and token are the run's pinned escrow and token, never an
 * address the backend named, and the approval is checked like any other call.
 */
export async function ensureTotalAllowance(opts: {
  signer: Pick<BulkSigner, 'send'>;
  provider: CallReader;
  pins: PinnedContracts;
  owner: string;
  total: bigint;
  waitTries?: number;
  waitMs?: number;
}): Promise<void> {
  const { provider, pins, owner, total } = opts;
  if ((await readAllowance(provider, pins.token, owner, pins.escrow)) >= total) return;
  const approve = { from: owner, to: pins.token, data: ERC20.encodeFunctionData('approve', [pins.escrow, total]) };
  await opts.signer.send(checkBulkCall({ unsignedTx: approve }, { fn: 'approve', amount: total }, pins), () => {});
  for (let i = 0; i < (opts.waitTries ?? 20); i++) {
    try {
      if ((await readAllowance(provider, pins.token, owner, pins.escrow)) >= total) return;
    } catch { /* RPC hiccup: keep waiting */ }
    await new Promise((r) => setTimeout(r, opts.waitMs ?? 3000));
  }
  throw new RelayError('APPROVAL_PENDING', 'The USDC approval has not confirmed yet. Wait a minute and resume the run.');
}
