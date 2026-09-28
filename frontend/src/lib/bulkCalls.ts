/**
 * The only transactions a bulk run signs, each checked before the wallet sees
 * it (docs/BULK-POSTING.md; the SDK checks the same in sdk/src/escrowCalls.ts).
 *
 * The embedded wallet sends a bulk run without a prompt per transaction, so a
 * transaction the backend built used to be signed as given, checked only for
 * its `to`: a bad or compromised answer could have had the page sign a
 * createTasks that puts the whole total into one task with a one-hour
 * deadline and someone else's verifier, or a cancelTask. The approval's
 * spender and token came from GET /health/settlement as well. Now:
 * - the escrow and token are the ones this build knows (pinnedContracts); a
 *   backend that names others gets no run at all;
 * - every transaction is decoded and must be exactly the call the run
 *   prepared: the target, the function, no value, and every argument of every
 *   task, in order (checkBulkCall);
 * - only its target and calldata go on to the wallet (CheckedCall). A gas
 *   limit, value, nonce or chain id the backend named is never used.
 */
import { Interface, ZeroAddress, getAddress, getBigInt, type BigNumberish, type Result } from 'ethers';
import { UserFacingError } from './friendlyError';
import { defaultSettlement, type SettlementChainKey, type SettlementSnapshot } from '../config/settlement';

export const BULK_CALLS = new Interface([
  'function createTask(bytes32 taskHash, address token, uint256 amount, string category, string locationZone, uint256 duration)',
  'function createTaskWithVerifier(bytes32 taskHash, address token, uint256 amount, string category, string locationZone, uint256 duration, address verifierAgent)',
  'function createTasks(address token, tuple(bytes32 taskHash, uint256 amount, string category, string locationZone, uint256 duration, address verifierAgent)[] tasks)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

/** The category the backend gives every task it builds (backend/src/routes/tasks.ts). */
export const TASK_CATEGORY = 'general';

export const TX_MISMATCH_MESSAGE = "The backend built a transaction that doesn't match these tasks. Nothing was sent.";

/** A transaction that is not exactly the call the run prepared. Nothing was sent. */
export class TxMismatchError extends UserFacingError {
  readonly code = 'TX_MISMATCH';
  /** What differed, for the console and a support ticket (the notice's details). */
  readonly detail: string;
  constructor(detail: string) {
    super(TX_MISMATCH_MESSAGE, { cause: new Error(detail) });
    this.name = 'TxMismatchError';
    this.detail = detail;
  }
}

function refuse(detail: string): never {
  throw new TxMismatchError(detail);
}

/** The escrow a run pays into and the token it pays in, on the chain it posts on. */
export interface PinnedContracts {
  chain: SettlementChainKey;
  chainId: number;
  escrow: string;
  token: string;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const sameAddress = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * The escrow and token this build pays on `chain`: the build-time table
 * (config/constants.ts, through defaultSettlement), never the backend's
 * answer. `named` is what the app is showing now (the settlement snapshot,
 * which GET /health/settlement overwrites). When it names another escrow or
 * token the run is refused before anything is signed, rather than approving
 * or paying an address this build never knew.
 */
export function pinnedContracts(
  chain: SettlementChainKey,
  named: { escrow: string; token: string },
  built: SettlementSnapshot = defaultSettlement(),
): PinnedContracts {
  const own = built.chains[chain];
  if (!ADDRESS.test(own.escrow) || !ADDRESS.test(own.token.address)) {
    throw new UserFacingError('This app has no escrow to post on right now. Nothing was sent.');
  }
  if (!sameAddress(named.escrow, own.escrow) || !sameAddress(named.token, own.token.address)) {
    throw new UserFacingError(
      'The backend names a different escrow or payment token than this app was built with, so this run was not started. Nothing was sent. Reload the page and try again; if it keeps happening, send the details below to support.',
      { cause: new Error(`${chain}: backend escrow ${named.escrow || 'none'}, token ${named.token || 'none'}; this app escrow ${own.escrow}, token ${own.token.address}`) },
    );
  }
  return { chain, chainId: own.chainId, escrow: getAddress(own.escrow.toLowerCase()), token: getAddress(own.token.address.toLowerCase()) };
}

/** One task as the escrow call must create it: what the run asked the backend to build. */
export interface ExpectedTask {
  taskHash: string;
  amount: bigint;
  locationZone: string;
  duration: bigint;
  /** The verifier committed on-chain, if any (address(0) in createTasks when none). */
  verifier?: string;
}

export type ExpectedCall =
  /** approve(escrow, amount) on the token. */
  | { fn: 'approve'; amount: bigint }
  /** createTask, or createTaskWithVerifier when the task commits a verifier. */
  | { fn: 'createTask'; task: ExpectedTask }
  /** createTasks(token, tasks): exactly these tasks, in this order. */
  | { fn: 'createTasks'; tasks: readonly ExpectedTask[] };

declare const checked: unique symbol;

/** A transaction checkBulkCall passed, cut down to its target and calldata:
 *  the only thing the bulk signer (lib/bulkWallet) sends. */
export type CheckedCall = { readonly to: string; readonly data: string } & { readonly [checked]: true };

function commitsVerifier(task: ExpectedTask): boolean {
  return !!task.verifier && task.verifier.toLowerCase() !== ZeroAddress;
}

/** What differs between a decoded task and the expected one, or null. */
function taskDiff(got: { taskHash: unknown; amount: unknown; category: unknown; locationZone: unknown; duration: unknown; verifier: unknown }, want: ExpectedTask): string | null {
  if (typeof got.taskHash !== 'string' || got.taskHash.toLowerCase() !== want.taskHash.toLowerCase()) return `taskHash ${String(got.taskHash)}, not ${want.taskHash}`;
  if (got.amount !== want.amount) return `amount ${String(got.amount)}, not ${want.amount}`;
  if (got.category !== TASK_CATEGORY) return `category ${JSON.stringify(got.category)}, not "${TASK_CATEGORY}"`;
  if (got.locationZone !== want.locationZone) return `zone ${JSON.stringify(got.locationZone)}, not ${JSON.stringify(want.locationZone)}`;
  if (got.duration !== want.duration) return `duration ${String(got.duration)}, not ${want.duration}`;
  const verifier = commitsVerifier(want) ? want.verifier! : ZeroAddress;
  if (!sameAddress(got.verifier, verifier)) return `verifier ${String(got.verifier)}, not ${verifier}`;
  return null;
}

/** The call `data` makes, when it is one of BULK_CALLS in canonical ABI encoding; else null. */
function decodeCall(data: string): { name: string; args: Result } | null {
  try {
    const fn = BULK_CALLS.getFunction(data.slice(0, 10));
    if (!fn) return null;
    const args = BULK_CALLS.decodeFunctionData(fn, data);
    // Canonical encoding only: nothing may ride along after the arguments.
    return BULK_CALLS.encodeFunctionData(fn, args).toLowerCase() === data ? { name: fn.name, args } : null;
  } catch {
    return null;
  }
}

function valueIsZero(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  try {
    return getBigInt(value as BigNumberish) === 0n;
  } catch {
    return false;
  }
}

/**
 * Check that a transaction is exactly `expect` on the pinned contracts, and
 * return the only fields the wallet will sign. `built` is the backend's build
 * answer (its `chain` and `chainId`, when named, must be the run's), or a
 * transaction the app built itself. Throws TxMismatchError, with nothing
 * sent, for another chain, target, function, value or any other argument.
 */
export function checkBulkCall(
  built: { unsignedTx: unknown; chain?: unknown; chainId?: unknown },
  expect: ExpectedCall,
  pins: PinnedContracts,
): CheckedCall {
  const tx = (built.unsignedTx !== null && typeof built.unsignedTx === 'object' ? built.unsignedTx : {}) as {
    to?: unknown; data?: unknown; value?: unknown; chainId?: unknown;
  };
  if (built.chain !== undefined && built.chain !== null && built.chain !== pins.chain) refuse(`built for ${String(built.chain)}, not ${pins.chain}`);
  for (const id of [built.chainId, tx.chainId]) {
    if (id !== undefined && id !== null && Number(id) !== pins.chainId) refuse(`built for chain ${String(id)}, not ${pins.chainId}`);
  }
  const target = expect.fn === 'approve' ? pins.token : pins.escrow;
  if (!sameAddress(tx.to, target)) refuse(`sent to ${String(tx.to)}, not ${target}`);
  if (!valueIsZero(tx.value)) refuse(`carries a value of ${String(tx.value)}`);

  const data = typeof tx.data === 'string' ? tx.data.toLowerCase() : '';
  const call = decodeCall(data);
  if (!call) refuse(`calls ${data.length >= 10 ? data.slice(0, 10) : 'nothing'}, which is not an approve or a createTask/createTasks in canonical encoding`);
  const fn = expect.fn === 'createTask' && commitsVerifier(expect.task) ? 'createTaskWithVerifier' : expect.fn;
  if (call.name !== fn) refuse(`calls ${call.name}, not ${fn}`);

  const a = call.args;
  if (expect.fn === 'approve') {
    if (!sameAddress(a[0], pins.escrow)) refuse(`approves ${String(a[0])}, not the escrow ${pins.escrow}`);
    if (a[1] !== expect.amount) refuse(`approves ${String(a[1])}, not ${expect.amount}`);
  } else if (expect.fn === 'createTask') {
    if (!sameAddress(a[1], pins.token)) refuse(`pays in ${String(a[1])}, not ${pins.token}`);
    const diff = taskDiff({ taskHash: a[0], amount: a[2], category: a[3], locationZone: a[4], duration: a[5], verifier: call.name === 'createTaskWithVerifier' ? a[6] : ZeroAddress }, expect.task);
    if (diff) refuse(`createTask: ${diff}`);
  } else {
    if (!sameAddress(a[0], pins.token)) refuse(`pays in ${String(a[0])}, not ${pins.token}`);
    const tasks = a[1] as Result;
    if (tasks.length !== expect.tasks.length) refuse(`creates ${tasks.length} tasks, not ${expect.tasks.length}`);
    expect.tasks.forEach((want, i) => {
      const t = tasks[i] as Result;
      const diff = taskDiff({ taskHash: t[0], amount: t[1], category: t[2], locationZone: t[3], duration: t[4], verifier: t[5] }, want);
      if (diff) refuse(`createTasks task ${i + 1}: ${diff}`);
    });
  }
  return { to: getAddress(target.toLowerCase()), data } as CheckedCall;
}
