/**
 * The agent deploy fee, paid on Arc as a plain transfer.
 *
 * Deploying an agent costs a fee (AGENT_FACTORY_PAYWALL), paid one of two
 * ways. Through AgentFactory, whose AgentDeployed event becomes a deploy
 * credit (agentFactoryListener.ts), or — what the web app does — as a
 * transfer, checked here, which needs one signature and no indexer.
 *
 * The transfer is at least `config.deployFeeUsdcRaw` of USDC sent to the Arc
 * escrow's treasury from one of the deployer's own wallets, either through the
 * USDC token's transfer() or as a plain send of native USDC (Arc's gas coin).
 * The deploy request names the transaction (`feeTxHash`); this module checks
 * its receipt, and each transaction pays for one deploy: it is claimed in
 * Redis while the agent is created, marked used once the agent exists, and
 * released if the deploy fails.
 */
import { ethers, type Contract } from 'ethers';
import { redis } from './redis.js';
import { chainRuntime } from './chainRuntime.js';
import { settlementChainConfig } from './settlementChains.js';
import { config } from '../config.js';
import { AppError } from '../middleware/errorHandler.js';

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
/** AgentFactory.deployAgent() emits this beside its own USDC transfer to the treasury. */
const AGENT_DEPLOYED_TOPIC = ethers.id('AgentDeployed(address,uint256,uint256,uint256)');
/** Arc's native USDC has 18 decimals; the ERC-20 shows the same balance with 6. */
const NATIVE_DECIMALS = 18;
const TREASURY_TTL_MS = 5 * 60_000;
/** One RPC read. The provider's own timeout is 120s (chain.ts), too long to hold a deploy request on. */
const RPC_TIMEOUT_MS = 6_000;
/** A claim whose deploy never finished (the process died mid-deploy) frees itself after this. */
const PENDING_CLAIM_TTL_S = 600;
const claimKey = (txHash: string) => `deploy-fee:arc:${txHash.toLowerCase()}`;

/** What the deploy page needs to pay the fee on Arc with a transfer. */
export interface ArcDeployFeeTerms {
  method: 'transfer';
  chain: 'arc';
  /** The chain the fee is paid on: a client checks its wallet is there before paying. */
  chainId: number;
  /** The USDC ERC-20 on Arc. */
  token: string;
  /** Where the fee goes: the Arc escrow's treasury. */
  recipient: string;
  /** The fee in the token's smallest unit, as a string. */
  amountRaw: string;
  decimals: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const topicAddress = (topic: string) => `0x${topic.slice(26)}`.toLowerCase();

let treasuryCache: { address: string; at: number } | null = null;

/** The Arc escrow's treasury, read on-chain and kept for a few minutes. */
async function arcTreasury(escrow: Contract, timeoutMs: number): Promise<string> {
  if (treasuryCache && Date.now() - treasuryCache.at < TREASURY_TTL_MS) return treasuryCache.address;
  try {
    const address = ethers.getAddress(String(await withTimeout(escrow.treasury(), timeoutMs)));
    treasuryCache = { address, at: Date.now() };
    return address;
  } catch (err) {
    // An RPC hiccup: the last reading beats refusing every deploy.
    if (treasuryCache) {
      console.warn(`[deployFee] treasury read failed, using the last one read: ${(err as Error).message}`);
      return treasuryCache.address;
    }
    throw new AppError(503, 'DEPLOY_FEE_UNAVAILABLE', 'Could not read the platform treasury on Arc. Try again in a moment.');
  }
}

async function feeTerms(timeoutMs: number): Promise<{ terms: ArcDeployFeeTerms; escrow: Contract } | null> {
  const { escrowAddress, token, chainId } = settlementChainConfig('arc');
  const escrow = chainRuntime('arc').escrow;
  if (!escrowAddress || !token.address || !escrow) return null;
  return {
    escrow,
    terms: {
      method: 'transfer',
      chain: 'arc',
      chainId,
      token: token.address,
      recipient: await arcTreasury(escrow, timeoutMs),
      amountRaw: config.deployFeeUsdcRaw.toString(),
      decimals: token.unit.decimals,
    },
  };
}

/** The Arc transfer terms, or null when this deployment has no Arc escrow (then only AgentFactory takes the fee). */
export async function arcDeployFeeTerms(): Promise<ArcDeployFeeTerms | null> {
  return (await feeTerms(RPC_TIMEOUT_MS))?.terms ?? null;
}

/**
 * Check that `txHash` is a confirmed Arc transaction that sends at least the
 * fee in USDC from one of `payers` to the treasury — the current one, or the
 * one at the payment's block if it has changed since. The receipt is asked for
 * a few times: an RPC can lag a just-mined transaction. Throws an AppError
 * naming what is wrong; returns the paying wallet and the amount in the
 * token's 6-decimal units.
 */
export async function verifyArcDeployFee(
  txHash: string,
  payers: string[],
  opts: { attempts?: number; delayMs?: number; timeoutMs?: number } = {},
): Promise<{ payer: string; amountRaw: bigint }> {
  const timeoutMs = opts.timeoutMs ?? RPC_TIMEOUT_MS;
  const found = await feeTerms(timeoutMs);
  if (!found) throw new AppError(409, 'DEPLOY_FEE_UNAVAILABLE', 'This deployment takes no deploy fee on Arc');
  const { terms, escrow } = found;
  const provider = chainRuntime('arc').provider;
  const attempts = opts.attempts ?? 5;
  const delayMs = opts.delayMs ?? 2_000;

  let receipt: ethers.TransactionReceipt | null = null;
  let answered = false;
  for (let i = 0; i < attempts && !receipt; i++) {
    try {
      receipt = await withTimeout(provider.getTransactionReceipt(txHash), timeoutMs);
      answered = true;
    } catch { /* unreachable or slow: ask again */ }
    if (!receipt && i < attempts - 1) await sleep(delayMs);
  }
  if (!receipt) {
    if (!answered) throw new AppError(503, 'DEPLOY_FEE_CHECK_FAILED', 'Could not reach Arc to check the fee payment. Try again in a moment.');
    throw new AppError(409, 'DEPLOY_FEE_NOT_FOUND', 'The fee transaction is not confirmed on Arc yet. Try again in a moment.');
  }
  if (receipt.status !== 1) {
    throw new AppError(402, 'DEPLOY_FEE_REVERTED', 'The fee transaction reverted on Arc, so nothing was paid.');
  }
  // AgentFactory.deployAgent() also moves the fee to the treasury, and its
  // event already pays for a deploy as a credit. Counting its transaction here
  // too would let one payment deploy two agents.
  const factory = config.arcAgentFactoryAddress?.toLowerCase();
  if (receipt.logs.some((log) => (factory && log.address.toLowerCase() === factory) || log.topics[0] === AGENT_DEPLOYED_TOPIC)) {
    throw new AppError(
      402,
      'DEPLOY_FEE_NOT_PAID',
      'That transaction paid through AgentFactory, which already counts as a deploy credit. Deploy without feeTxHash to use the credit.',
      'FACTORY_PAYMENT',
    );
  }

  const fee = BigInt(terms.amountRaw);
  const token = terms.token.toLowerCase();
  // Each movement of at least the fee in this transaction, in 6-decimal units.
  const payments: { from: string; to: string; amountRaw: bigint }[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== token || log.topics.length < 3 || log.topics[0] !== TRANSFER_TOPIC) continue;
    const value = BigInt(log.data);
    if (value >= fee) payments.push({ from: topicAddress(log.topics[1]), to: topicAddress(log.topics[2]), amountRaw: value });
  }
  // A plain send of native USDC leaves no log on the token: its amount is the
  // transaction's own value, with 18 decimals.
  if (payments.length === 0) {
    const tx = await withTimeout(provider.getTransaction(txHash), timeoutMs).catch(() => undefined);
    if (tx === undefined) throw new AppError(503, 'DEPLOY_FEE_CHECK_FAILED', 'Could not reach Arc to check the fee payment. Try again in a moment.');
    const scale = 10n ** BigInt(NATIVE_DECIMALS - terms.decimals);
    if (tx?.to && tx.value >= fee * scale) {
      payments.push({ from: tx.from.toLowerCase(), to: tx.to.toLowerCase(), amountRaw: tx.value / scale });
    }
  }

  const recipients = new Set([terms.recipient.toLowerCase()]);
  if (payments.length > 0 && !payments.some((p) => recipients.has(p.to))) {
    // Paid before the treasury changed: it was the treasury when it was paid.
    const then = await withTimeout(escrow.treasury({ blockTag: receipt.blockNumber }), timeoutMs).catch(() => null);
    if (then) recipients.add(String(then).toLowerCase());
  }
  const toTreasury = payments.filter((p) => recipients.has(p.to));
  const wanted = new Set(payers.map((a) => a.toLowerCase()));
  const paid = toTreasury.find((p) => wanted.has(p.from));
  if (paid) return { payer: paid.from, amountRaw: paid.amountRaw };
  if (toTreasury.length > 0) {
    throw new AppError(
      402,
      'DEPLOY_FEE_NOT_PAID',
      `That fee was paid from ${toTreasury[0].from}, which is not a wallet on your account. Link that wallet to your account, or pay from one that is.`,
      'PAYER_NOT_LINKED',
    );
  }
  throw new AppError(
    402,
    'DEPLOY_FEE_NOT_PAID',
    `That transaction does not send at least ${ethers.formatUnits(fee, terms.decimals).replace(/\.0$/, '')} USDC to the platform treasury (${terms.recipient}) on Arc`,
  );
}

export type ArcDeployFeeClaim =
  | { claimed: true }
  /** Held by a deploy still running (`pending`), or spent on `agentId`. */
  | { claimed: false; pending: boolean; agentId?: string };

/** Reserve a verified fee transaction for one deploy. */
export async function claimArcDeployFee(txHash: string, owner: string): Promise<ArcDeployFeeClaim> {
  const key = claimKey(txHash);
  for (let tries = 0; tries < 2; tries++) {
    if ((await redis.set(key, `pending:${owner.toLowerCase()}`, 'EX', PENDING_CLAIM_TTL_S, 'NX')) !== null) {
      return { claimed: true };
    }
    const held = await redis.get(key);
    if (held === null) continue; // released between the two calls: claim again
    if (held.startsWith('pending:')) return { claimed: false, pending: true };
    return { claimed: false, pending: false, agentId: held.startsWith('used:') ? held.slice('used:'.length) : undefined };
  }
  return { claimed: false, pending: true };
}

/** Record that a claimed fee transaction paid for `agentId`. A used payment stays used: no expiry. */
export async function markArcDeployFeeUsed(txHash: string, agentId: string): Promise<void> {
  await redis.set(claimKey(txHash), `used:${agentId}`);
}

/** Give a claimed fee transaction back after a deploy that did not happen, so it can pay for the retry. */
export async function releaseArcDeployFee(txHash: string): Promise<void> {
  await redis.del(claimKey(txHash));
}

/** Test hook: forget the cached treasury. */
export function _resetDeployFeeCache(): void {
  treasuryCache = null;
}
