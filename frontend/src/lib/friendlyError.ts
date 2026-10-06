/**
 * Turn anything a wallet, the chain, or the backend throws into words a
 * person can act on. ethers' raw dump ("user rejected action (action=
 * "sendTransaction", reason="rejected", info={ ... }, code=ACTION_REJECTED,
 * version=6.17.0)") used to reach the page as-is. The raw text is kept in
 * `details`, collapsed by <ErrorNotice>, for a support ticket.
 *
 * `message` never carries JSON, a stack trace or a long hex blob: long hex
 * is shortened, and text that still looks raw is swapped for a generic line.
 */

import { isChunkLoadError } from './chunkReload';

export type FriendlyErrorKind =
  | 'cancelled' | 'funds' | 'chain' | 'revert' | 'network' | 'server' | 'unknown'
  /** The wallet broadcast it, then the wait for it failed: it may still land. */
  | 'maybeSent'
  /** A lazy chunk of an older build failed to load: the page needs a reload. */
  | 'outdated';

export interface FriendlyError {
  kind: FriendlyErrorKind;
  title: string;
  message: string;
  /** The raw error text, when it says more than `message`. */
  details?: string;
  /** For 'maybeSent': the hash the wallet broadcast, to check or to finish from. */
  txHash?: string;
}

export interface FriendlyErrorOptions {
  /** Title for an error that isn't a recognised kind (default "Something went wrong"). */
  title?: string;
  /** Network the action targets, for "Switch your wallet to …" when the error names none (default Arc). */
  network?: string;
  /** The coin that pays the network fee, when it isn't USDC (a CCTP source chain's ETH). */
  gasToken?: string;
}

/**
 * An error the app worded for a person, which must reach the page as written:
 * "your payment is locked in escrow, don't post again" cannot turn into
 * "check your connection" because the failure it wraps was a fetch. The
 * wrapped cause goes to details.
 */
export class UserFacingError extends Error {
  readonly title?: string;
  readonly cause?: unknown;
  /** How the notice looks: 'maybeSent' for "still in progress, don't redo it"
   *  rather than a red failure. Defaults to 'unknown'. */
  readonly kind?: FriendlyErrorKind;
  constructor(message: string, opts: { title?: string; cause?: unknown; kind?: FriendlyErrorKind } = {}) {
    super(message);
    this.name = 'UserFacingError';
    this.title = opts.title;
    this.cause = opts.cause;
    this.kind = opts.kind;
  }
}

const DEFAULT_TITLE = 'Something went wrong';
const GENERIC_MESSAGE = 'Try again. If it keeps happening, send the details below to support.';
/** The same, where no details are shown. */
const GENERIC_SHORT = 'Try again in a moment.';
const MAX_DETAILS = 2000;

// ── What an error carries ────────────────────────────────────────────

interface Facts {
  codes: Array<string | number>;
  names: string[];
  texts: string[];
  revertData: string[];
  revertNames: string[];
  mined: boolean;
  /** A transaction hash the wallet had already broadcast when this was thrown. */
  sentHash?: string;
}

type Node = Record<string, unknown>;

const HEX_DATA = /^0x[0-9a-fA-F]{8,}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/** Walk the error and what it wraps (ethers `info.error`/`error`, viem `cause`, JSON-RPC `data`). */
function collect(err: unknown): Facts {
  const facts: Facts = { codes: [], names: [], texts: [], revertData: [], revertNames: [], mined: false };
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 6 || value === null || value === undefined || seen.has(value)) return;
    if (typeof value === 'string') {
      if (HEX_DATA.test(value)) facts.revertData.push(value);
      else facts.texts.push(value);
      return;
    }
    if (typeof value !== 'object') return;
    seen.add(value);
    const n = value as Node;
    if (typeof n.code === 'string' || typeof n.code === 'number') facts.codes.push(n.code);
    if (typeof n.privyErrorCode === 'string') facts.codes.push(n.privyErrorCode);
    if (typeof n.name === 'string') facts.names.push(n.name);
    for (const key of ['shortMessage', 'reason', 'message', 'details'] as const) {
      if (typeof n[key] === 'string' && n[key]) facts.texts.push(n[key] as string);
    }
    if (n.receipt) facts.mined = true;
    // ethers' JsonRpcSigner.sendTransaction rejects AFTER broadcasting when its
    // poll for the new tx fails (network changed, bad data, provider gone), and
    // says so by setting info.sendTransactionHash on the error it rethrows.
    if (!facts.sentHash && typeof n.sendTransactionHash === 'string' && TX_HASH.test(n.sendTransactionHash)) {
      facts.sentHash = n.sendTransactionHash;
    }
    const revert = n.revert as Node | null | undefined;
    if (revert && typeof revert.name === 'string') facts.revertNames.push(revert.name);
    if (typeof n.errorName === 'string') facts.revertNames.push(n.errorName);
    if (typeof n.data === 'string') {
      if (HEX_DATA.test(n.data)) facts.revertData.push(n.data);
    } else if (n.data && typeof n.data === 'object') {
      const d = n.data as Node;
      if (typeof d.errorName === 'string') facts.revertNames.push(d.errorName);
      visit(d, depth + 1);
    }
    visit(n.info, depth + 1);
    visit(n.error, depth + 1);
    visit(n.cause, depth + 1);
    visit(n.originalError, depth + 1);
  };
  visit(err, 0);
  // ethers prints revert data into its message: data="0x…"
  for (const t of facts.texts) {
    for (const m of t.matchAll(/data="(0x[0-9a-fA-F]{8,})"/g)) facts.revertData.push(m[1]);
  }
  // viem gave up waiting for a receipt of a tx it had sent; the hash is only in the text.
  if (!facts.sentHash && facts.names.some((n) => n === 'TransactionReceiptNotFoundError' || n === 'WaitForTransactionReceiptTimeoutError')) {
    for (const t of facts.texts) {
      const m = t.match(/hash "(0x[0-9a-fA-F]{64})"/);
      if (m) { facts.sentHash = m[1]; break; }
    }
  }
  return facts;
}

// ── Contract reverts, by selector ────────────────────────────────────

const TASK_STATUS = ['open', 'assigned', 'submitted', 'marked as failed', 'completed', 'cancelled', 'in dispute'];

/** BlindEscrow.OpenPhase, as words. */
const OPEN_PHASE = [
  'still taking submissions',
  "in the poster's review",
  "in its verifier's review",
  'in the backup review',
  'waiting for an admin',
  'closed',
];

interface RevertWords { title: string; message: string; kind?: FriendlyErrorKind }

const FUNDS: RevertWords = {
  kind: 'funds',
  title: 'Not enough USDC',
  message: 'You need a little more USDC to cover this and the network fee.',
};

/** BlindEscrow / AgentFactory custom errors, plus the OpenZeppelin ones they inherit. */
const REVERTS: Record<string, RevertWords | ((data: string) => RevertWords)> = {
  NotAgent: { title: 'Not your task', message: 'Only the wallet that posted this task can do this.' },
  NotWorker: { title: 'Not your task', message: 'Only the agent working on this task can do this.' },
  NotVerifier: { title: 'Not the verifier', message: "Only this task's verifier can do this." },
  NotAdmin: { title: 'Not allowed', message: 'Only the marketplace admin can do this.' },
  OwnableUnauthorizedAccount: { title: 'Not allowed', message: "Your wallet isn't allowed to do this." },
  InvalidStatus: (data) => {
    const status = TASK_STATUS[Number.parseInt(data.slice(10, 74), 16)];
    return {
      title: 'Task has moved on',
      message: status
        ? `This task is already ${status}, so this can't be done now. Refresh to see its latest state.`
        : "This task's state has changed, so this can't be done now. Refresh to see its latest state.",
    };
  },
  SelfAssignment: { title: 'Not allowed', message: "A task's poster can't also work on it or verify it." },
  DeadlineReached: { title: 'Deadline passed', message: "This task's deadline has passed, so this can't be done any more." },
  DeadlineNotReached: { title: 'Too early', message: "The deadline hasn't passed yet. Try again once it has." },
  DisputeWindowActive: { title: 'Too early', message: 'The dispute window is still open. Try again once it closes.' },
  AppealWindowActive: { title: 'Too early', message: "The worker's appeal window is still open. Try again once it closes." },
  EscalatedForAdjudication: { title: 'Waiting on a ruling', message: 'This task is waiting for an admin to rule on it.' },
  NotEscalated: { title: 'Not escalated', message: "This task hasn't been sent for a ruling." },
  MaxSubmissionAttemptsReached: { title: 'No attempts left', message: 'This task has used all of its submission attempts.' },
  InvalidPickWindow: { title: 'Review window out of range', message: 'Pick a review window between 1 hour and 7 days and try again.' },
  NotOpenTask: { title: 'Not an open task', message: "This task doesn't take open submissions." },
  OpenTaskUnsupported: { title: 'Open task', message: "Agents submit to this task directly, so it can't be assigned to one." },
  AlreadySubmitted: { title: 'Already submitted', message: 'This wallet has already submitted to this task.' },
  HasSubmissions: { title: 'Has submissions', message: "Agents have already submitted to this task, so it can't be cancelled." },
  NoSubmission: { title: 'No submission', message: "That wallet hasn't submitted to this task." },
  WrongPhase: (data) => {
    const phase = OPEN_PHASE[Number.parseInt(data.slice(10, 74), 16)];
    return {
      title: 'Not now',
      message: phase
        ? `This task is ${phase}, so this can't be done now. Refresh to see its latest state.`
        : "This task's state has changed, so this can't be done now. Refresh to see its latest state.",
    };
  },
  TokenNotAllowed: { title: 'Token not accepted', message: "This token can't be used for payment here. Pay in USDC." },
  InvalidDeadline: { title: 'Deadline out of range', message: 'Pick a deadline inside the allowed range and try again.' },
  ZeroAmount: { title: 'Amount missing', message: "The payment amount is missing or doesn't match. Check it and try again." },
  EmptyHash: { title: 'Request incomplete', message: 'Part of this request was missing. Reload the page and try again.' },
  InvalidTEESignature: { title: 'Verification rejected', message: "The verifier's signature was not accepted." },
  TEESignerNotSet: { title: 'Verification unavailable', message: "Signed verification isn't set up on this marketplace yet." },
  EnforcedPause: { title: 'Marketplace paused', message: 'Payments are paused for maintenance. Try again later.' },
  AgentFundingNotSupported: { title: 'Not supported', message: "An agent can't be funded while it deploys. Deploy it first, then fund it." },
  ERC20InsufficientBalance: FUNDS,
  InsufficientUSDC: FUNDS,
  ERC20InsufficientAllowance: { title: 'Approval needed', message: "The USDC approval hasn't gone through yet. Wait a minute and try again." },
  SafeERC20FailedOperation: { kind: 'funds', title: "Payment didn't go through", message: 'The USDC transfer failed. Check your balance and try again.' },
};

/** Revert selector (first 4 bytes of the data) → error name. Each comment is
 *  the signature it hashes; friendlyError.test.ts recomputes them all. */
export const REVERT_SELECTORS: Record<string, string> = {
  '0x0d9ab13f': 'NotAgent', // NotAgent()
  '0xfb55adaf': 'NotWorker', // NotWorker()
  '0x24663556': 'NotVerifier', // NotVerifier()
  '0x7bfa4b9f': 'NotAdmin', // NotAdmin()
  '0x118cdaa7': 'OwnableUnauthorizedAccount', // OwnableUnauthorizedAccount(address)
  '0xf924664d': 'InvalidStatus', // InvalidStatus(uint8,uint8)
  '0xd004f0f8': 'SelfAssignment', // SelfAssignment()
  '0xb08ce5b3': 'DeadlineReached', // DeadlineReached()
  '0x66ec4ee6': 'DeadlineNotReached', // DeadlineNotReached()
  '0xe52e798f': 'DisputeWindowActive', // DisputeWindowActive()
  '0x2e4ade70': 'AppealWindowActive', // AppealWindowActive()
  '0xf402cb4c': 'EscalatedForAdjudication', // EscalatedForAdjudication()
  '0x7834bcba': 'NotEscalated', // NotEscalated()
  '0x6e041295': 'MaxSubmissionAttemptsReached', // MaxSubmissionAttemptsReached()
  '0xc0cfac98': 'InvalidPickWindow', // InvalidPickWindow()
  '0x6c8a0fce': 'NotOpenTask', // NotOpenTask()
  '0x2e25e010': 'OpenTaskUnsupported', // OpenTaskUnsupported()
  '0x9fbfc589': 'AlreadySubmitted', // AlreadySubmitted()
  '0x4826444b': 'HasSubmissions', // HasSubmissions()
  '0x64db9073': 'NoSubmission', // NoSubmission()
  '0x96fe8cdd': 'WrongPhase', // WrongPhase(uint8)
  '0xa29c4986': 'TokenNotAllowed', // TokenNotAllowed()
  '0x769d11e4': 'InvalidDeadline', // InvalidDeadline()
  '0x1f2a2005': 'ZeroAmount', // ZeroAmount()
  '0x70df377c': 'EmptyHash', // EmptyHash()
  '0x4c0f9589': 'InvalidTEESignature', // InvalidTEESignature()
  '0x41437f70': 'TEESignerNotSet', // TEESignerNotSet()
  '0xd93c0665': 'EnforcedPause', // EnforcedPause()
  '0xce0c4a61': 'AgentFundingNotSupported', // AgentFundingNotSupported()
  '0xe450d38c': 'ERC20InsufficientBalance', // ERC20InsufficientBalance(address,uint256,uint256)
  '0xfe7e4c35': 'InsufficientUSDC', // InsufficientUSDC()
  '0xfb8f41b2': 'ERC20InsufficientAllowance', // ERC20InsufficientAllowance(address,uint256,uint256)
  '0x5274afe7': 'SafeERC20FailedOperation', // SafeERC20FailedOperation(address)
};

function revertNameForData(data: string): string | undefined {
  return REVERT_SELECTORS[data.slice(0, 10).toLowerCase()];
}

/** The words for a known revert: by name (when an ABI decoded it) or by selector (raw data). */
function knownRevert(facts: Facts): RevertWords | undefined {
  const fromData = facts.revertData
    .map((data) => ({ data, name: revertNameForData(data) }))
    .find((x) => x.name);
  const byName = facts.revertNames.find((name) => name in REVERTS) ?? knownNameInText(facts.texts);
  const name = fromData?.name ?? byName;
  if (!name) return undefined;
  const words = REVERTS[name];
  return typeof words === 'function' ? words(fromData?.data ?? '') : words;
}

/** A known error name in revert text (a backend or viem message that quotes it). */
function knownNameInText(texts: string[]): string | undefined {
  for (const t of texts) {
    if (!/revert/i.test(t)) continue;
    const m = t.match(/\b([A-Z][A-Za-z0-9]+)\(/g) ?? [];
    for (const hit of m) {
      const name = hit.slice(0, -1);
      if (name in REVERTS) return name;
    }
    for (const name of Object.keys(REVERTS)) {
      if (new RegExp(`\\b${name}\\b`).test(t)) return name;
    }
  }
  return undefined;
}

// ── Text rules ───────────────────────────────────────────────────────

const CANCELLED_TEXT = /user rejected|user denied|rejected the request|user cancel+ed|cancel+ed by (the )?user|user closed|user exited|exited_(auth|link|update)_flow|user_exited|denied (transaction|message) signature/i;
const FUNDS_TEXT = /insufficient funds|insufficient balance|insufficient_balance/i;
const ERC20_BALANCE_TEXT = /exceeds balance/i;
const CHAIN_TEXT = /wallet is on chain \d+|does not match the target chain|network changed|unrecognized chain|chain ?id mismatch|unsupported_chain_id/i;
const NETWORK_TEXT = /failed to fetch|networkerror when attempting to fetch|^load failed$|fetch failed|network request failed|could not detect network|ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|socket hang up/i;

/** ethers/viem/RPC filler that says nothing to a person. */
const FILLER_TEXT = /could not coalesce error|^unknown error$|unknown rpc error|internal json-rpc error|missing revert data|^execution reverted$/i;

/** Marks of text that was never meant for a person. */
const RAW_TEXT = /[{}]|\bversion=\d|\bcode=[A-Z_]{3,}|\(action="|^\s*at\s|\n\s*at\s|Version: viem@|Request Arguments:|<\/?[a-zA-Z][^>]*>|\\n/m;

/** Hashes, keys and calldata (64+ hex) shortened; a 40-hex address stays
 *  whole, since a message like "Send USDC to 0x…" must stay usable. */
function shortenHex(text: string): string {
  return text.replace(/0x[0-9a-fA-F]{64,}/g, (h) => `${h.slice(0, 6)}…${h.slice(-4)}`);
}

function isClean(text: string): boolean {
  return text.length > 0 && text.length <= 600 && !RAW_TEXT.test(text);
}

/** The network the error asks for, else the caller's, else Arc. */
function targetNetwork(texts: string[], fallback?: string): string {
  const pretty = (label: string) => {
    const known: Record<string, string> = { arc: 'Arc', base: 'Base', '0g': '0G' };
    const trimmed = label.trim();
    return known[trimmed.toLowerCase()] ?? trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  };
  for (const t of texts) {
    const ours = t.match(/, not ([A-Za-z0-9][\w .-]*?) \(\d+\)/);
    if (ours) return pretty(ours[1]);
    const viem = t.match(/target chain for the transaction \(id: \d+ [–-] ([^)]+)\)/);
    if (viem) return pretty(viem[1]);
  }
  return fallback ?? 'Arc';
}

/**
 * A backend VALIDATION_ERROR from a zod parse carries the issues as a JSON
 * array (ZodError.message). "field: message" for up to three of them, or null
 * when the message is plain text (it then reads as-is below).
 */
function validationIssues(err: unknown): string | null {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (!e || e.code !== 'VALIDATION_ERROR' || typeof e.message !== 'string' || !e.message.trim().startsWith('[')) return null;
  let issues: unknown;
  try { issues = JSON.parse(e.message); } catch { return null; }
  if (!Array.isArray(issues)) return null;
  const lines = issues
    .filter((i): i is { path?: unknown; message: string } => !!i && typeof i === 'object' && typeof (i as { message?: unknown }).message === 'string')
    .map((i) => {
      const path = Array.isArray(i.path) ? i.path.filter((p) => typeof p === 'string' || typeof p === 'number').join('.') : '';
      return shortenHex(path ? `${path}: ${i.message}` : i.message);
    })
    .filter(isClean);
  if (lines.length === 0) return null;
  const shown = lines.slice(0, 3).join('; ');
  return lines.length > 3 ? `${shown} (and ${lines.length - 3} more)` : shown;
}

function rawDetails(err: unknown): string | undefined {
  if (err === null || err === undefined) return undefined;
  let text: string;
  if (typeof err === 'string') text = err;
  else if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    text = code !== undefined && !err.message.includes(String(code)) ? `${String(code)}: ${err.message}` : err.message;
  } else {
    try { text = JSON.stringify(err) ?? String(err); } catch { text = String(err); }
  }
  text = text.trim();
  if (!text) return undefined;
  return text.length > MAX_DETAILS ? `${text.slice(0, MAX_DETAILS)}…` : text;
}

// ── The mapping ──────────────────────────────────────────────────────

export function friendlyError(err: unknown, opts: FriendlyErrorOptions = {}): FriendlyError {
  const fallbackTitle = opts.title ?? DEFAULT_TITLE;
  if (err instanceof UserFacingError) {
    const cause = err.cause === undefined ? undefined : rawDetails(err.cause);
    const f: FriendlyError = { kind: err.kind ?? 'unknown', title: err.title ?? fallbackTitle, message: err.message };
    return cause ? { ...f, details: cause } : f;
  }
  const facts = collect(err);
  const has = (...codes: Array<string | number>) => facts.codes.some((c) => codes.includes(c));
  const named = (...names: string[]) => facts.names.some((n) => names.includes(n));
  const text = (re: RegExp) => facts.texts.some((t) => re.test(t));
  const details = rawDetails(err);
  const withDetails = (f: Omit<FriendlyError, 'details'>): FriendlyError => (details ? { ...f, details } : f);

  // Broadcast, then the wait failed: whatever else the error says (a network
  // change, bad data), the payment may land, so it must never read as "nothing
  // was sent, try again". Checked first for that reason.
  if (facts.sentHash) {
    return {
      kind: 'maybeSent',
      title: 'It may have gone through',
      message: "Your wallet sent it, but we couldn't confirm it. Check your balance or the task list before trying again.",
      details: [`Transaction ${facts.sentHash}`, details].filter(Boolean).join('\n'),
      txHash: facts.sentHash,
    };
  }
  // A chunk of the build this tab loaded is gone (a deploy since) or didn't
  // download: retrying in place fails the same way.
  if (isChunkLoadError(err)) {
    return withDetails({ kind: 'outdated', title: 'A new version is out', message: 'Reload the page to continue. Nothing was sent.' });
  }
  const issues = validationIssues(err);
  if (issues) return withDetails({ kind: 'server', title: 'Check the form', message: issues });

  // A cancel in the wallet is the user's choice, not a failure: no details.
  if (has('TX_CANCELLED')) {
    return { kind: 'cancelled', title: 'Cancelled in your wallet', message: "The transaction was cancelled or replaced, so this payment wasn't made." };
  }
  if (has('ACTION_REJECTED', 4001) || named('UserRejectedRequestError') || text(CANCELLED_TEXT)
    || facts.codes.some((c) => typeof c === 'string' && /exited/.test(c))) {
    return { kind: 'cancelled', title: 'Cancelled in your wallet', message: 'Nothing was sent.' };
  }

  const revert = knownRevert(facts);
  if (revert?.kind === 'funds' || text(ERC20_BALANCE_TEXT)) {
    const words = revert?.kind === 'funds' ? revert : FUNDS;
    return withDetails({ kind: 'funds', title: words.title, message: words.message });
  }
  // Short of the coin that pays gas: USDC on Arc, the native coin elsewhere.
  if (has('INSUFFICIENT_FUNDS', 'insufficient_balance') || named('InsufficientFundsError') || text(FUNDS_TEXT)) {
    const coin = opts.gasToken;
    return withDetails(coin && coin.toUpperCase() !== 'USDC'
      ? { kind: 'funds', title: `Not enough ${coin}`, message: `You need a little ${coin}${opts.network ? ` on ${opts.network}` : ''} to pay the network fee.` }
      : { kind: 'funds', title: FUNDS.title, message: FUNDS.message });
  }

  if (has('WRONG_CHAIN', 4902, 'unsupported_chain_id') || named('ChainMismatchError') || text(CHAIN_TEXT)) {
    return withDetails({ kind: 'chain', title: 'Wrong network', message: `Switch your wallet to ${targetNetwork(facts.texts, opts.network)} and try again.` });
  }

  if (revert) return withDetails({ kind: revert.kind ?? 'revert', title: revert.title, message: revert.message });
  if (has('CALL_EXCEPTION', 'TX_REVERTED') || named('ContractFunctionRevertedError') || text(/execution reverted/i)) {
    if (facts.mined || has('TX_REVERTED')) {
      return withDetails({ kind: 'revert', title: 'Transaction failed', message: 'It was rejected on-chain, so nothing changed. Only the network fee was spent.' });
    }
    const reason = facts.texts
      .map((t) => t.match(/reverted with reason string '([^']+)'|execution reverted: "?([^"]+?)"?$/))
      .map((m) => m?.[1] ?? m?.[2])
      .find((r): r is string => !!r && isClean(r) && !/unknown custom error/i.test(r));
    return withDetails({
      kind: 'revert',
      title: 'Transaction would fail',
      message: reason
        ? `The contract refused it ("${shortenHex(reason)}"), so nothing was sent.`
        : 'The contract refused this transaction, so nothing was sent.',
    });
  }

  if (has('transaction_failure')) {
    return withDetails({ kind: 'revert', title: 'Transaction failed', message: "It didn't go through, so nothing changed. Try again." });
  }

  if (has('TIMEOUT') && named('ApiError')) {
    return withDetails({ kind: 'network', title: "The server didn't answer", message: 'It may be starting up. Try again in a moment.' });
  }
  if (has('NETWORK_ERROR', 'SERVER_ERROR', 'TIMEOUT', -32005, 'client_request_timeout') || named('AbortError', 'TimeoutError', 'HttpRequestError') || text(NETWORK_TEXT)) {
    return withDetails({ kind: 'network', title: "Couldn't reach the network", message: 'Check your connection and try again.' });
  }
  // A contract read that came back empty: usually the wallet is on another network.
  if (has('BAD_DATA')) {
    return withDetails({ kind: 'network', title: "Couldn't read from the network", message: `Check that your wallet is on ${targetNetwork(facts.texts, opts.network)} and try again.` });
  }

  if (has(-32002)) {
    return withDetails({ kind: 'unknown', title: 'Check your wallet', message: 'A request is already waiting in your wallet. Open it to approve or reject it.' });
  }
  if (has(4100, 4900, 4901)) {
    return withDetails({ kind: 'unknown', title: 'Wallet not connected', message: 'Reconnect your wallet and try again.' });
  }
  if (has('NONCE_EXPIRED')) {
    return withDetails({ kind: 'unknown', title: 'Already sent', message: 'This transaction was already sent. Refresh before trying again.' });
  }
  if (has('REPLACEMENT_UNDERPRICED')) {
    return withDetails({ kind: 'unknown', title: 'Transaction pending', message: 'An earlier transaction is still pending. Wait for it to confirm, then try again.' });
  }

  // Backend errors speak for themselves unless the text is raw.
  const status = err && typeof err === 'object' ? (err as { status?: unknown }).status : undefined;
  if (status === 429 || has('too_many_requests', 'RATE_LIMITED')) {
    return withDetails({ kind: 'server', title: 'Too many requests', message: 'Wait a minute and try again.' });
  }
  if (named('ApiError')) {
    if (has('EMPTY_RESPONSE', 'PARSE_ERROR')) {
      return withDetails({ kind: 'server', title: 'The server had a problem', message: 'Try again in a moment.' });
    }
  }

  const candidate = (facts.texts.find((t) => t.trim() && !FILLER_TEXT.test(t.trim())) ?? '').trim();
  const cleaned = shortenHex(candidate);
  if (isClean(cleaned)) {
    const f: FriendlyError = { kind: typeof status === 'number' && status >= 500 ? 'server' : 'unknown', title: fallbackTitle, message: cleaned };
    // Details only when they add something: a shortened hex, or a longer raw
    // message behind a short one. A backend error code alone is not worth it.
    const rawMessage = typeof err === 'string' ? err : (err as { message?: unknown } | null)?.message;
    const addsSomething = cleaned !== candidate || (typeof rawMessage === 'string' && rawMessage.trim() !== candidate);
    return details && addsSomething ? { ...f, details } : f;
  }
  if (typeof status === 'number' && status >= 500) {
    return withDetails({ kind: 'server', title: 'The server had a problem', message: 'Try again in a moment.' });
  }
  return withDetails({ kind: 'unknown', title: fallbackTitle, message: details ? GENERIC_MESSAGE : GENERIC_SHORT });
}

/** Just the words, for a spot that shows one line of text. */
export function friendlyErrorText(err: unknown, opts?: FriendlyErrorOptions): string {
  const f = friendlyError(err, opts);
  const message = f.message === GENERIC_MESSAGE ? GENERIC_SHORT : f.message;
  return f.kind === 'unknown' && f.title === (opts?.title ?? DEFAULT_TITLE) && message !== GENERIC_SHORT
    ? message
    : `${f.title}. ${message}`;
}
