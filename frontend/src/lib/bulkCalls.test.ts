import { describe, expect, it } from 'vitest';
import { Interface, ZeroAddress } from 'ethers';
import { BULK_CALLS, TX_MISMATCH_MESSAGE, TxMismatchError, checkBulkCall, pinnedContracts, type ExpectedCall, type ExpectedTask } from './bulkCalls';
import { UserFacingError } from './friendlyError';
import { defaultSettlement } from '../config/settlement';

const BUILD = defaultSettlement().chains.arc;
const PINS = pinnedContracts('arc', { escrow: BUILD.escrow, token: BUILD.token.address });
const ATTACKER = '0x' + 'ad'.repeat(20);
const VERIFIER = '0x' + 'be'.repeat(20);
const HASH = (n: number) => '0x' + n.toString(16).padStart(64, '0');

const task = (n: number, over: Partial<ExpectedTask> = {}): ExpectedTask => ({
  taskHash: HASH(n), amount: BigInt(n) * 1_000_000n, locationZone: 'global', duration: 86_400n, ...over,
});

type Terms = { taskHash: string; amount: bigint; category?: string; locationZone: string; duration: bigint; verifier?: string };

// What an honest backend builds (backend/src/services/escrow.ts), with room to tamper.
function createTaskTx(t: Terms, over: Record<string, unknown> = {}) {
  const data = t.verifier
    ? BULK_CALLS.encodeFunctionData('createTaskWithVerifier', [t.taskHash, PINS.token, t.amount, t.category ?? 'general', t.locationZone, t.duration, t.verifier])
    : BULK_CALLS.encodeFunctionData('createTask', [t.taskHash, PINS.token, t.amount, t.category ?? 'general', t.locationZone, t.duration]);
  return { from: '0x' + '11'.repeat(20), to: PINS.escrow, data, ...over };
}

function createTasksTx(ts: Terms[], over: Record<string, unknown> = {}, token = PINS.token) {
  const data = BULK_CALLS.encodeFunctionData('createTasks', [
    token,
    ts.map((t) => [t.taskHash, t.amount, t.category ?? 'general', t.locationZone, t.duration, t.verifier ?? ZeroAddress]),
  ]);
  return { from: '0x' + '11'.repeat(20), to: PINS.escrow, data, gasLimit: 900_000, chainId: PINS.chainId, ...over };
}

function approveTx(spender: string, amount: bigint, over: Record<string, unknown> = {}) {
  return { from: '0x' + '11'.repeat(20), to: PINS.token, data: BULK_CALLS.encodeFunctionData('approve', [spender, amount]), ...over };
}

/** The check refuses with the plain message; returns what differed. */
function refusal(built: { unsignedTx: unknown; chain?: unknown; chainId?: unknown }, want: ExpectedCall): string {
  let caught: unknown;
  try {
    checkBulkCall(built, want, PINS);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(TxMismatchError);
  expect((caught as Error).message).toBe(TX_MISMATCH_MESSAGE);
  return (caught as TxMismatchError).detail;
}

describe('pinnedContracts', () => {
  it("returns this build's escrow and token for the chain, whatever the letter case the app shows", () => {
    const pins = pinnedContracts('arc', { escrow: BUILD.escrow.toUpperCase().replace('0X', '0x'), token: BUILD.token.address.toLowerCase() });
    expect(pins).toEqual({ chain: 'arc', chainId: BUILD.chainId, escrow: PINS.escrow, token: PINS.token });
    expect(pins.escrow.toLowerCase()).toBe(BUILD.escrow.toLowerCase());
  });

  it('refuses the run when the backend names another escrow, before anything is signed', () => {
    expect(() => pinnedContracts('arc', { escrow: ATTACKER, token: BUILD.token.address })).toThrow(UserFacingError);
    expect(() => pinnedContracts('arc', { escrow: ATTACKER, token: BUILD.token.address })).toThrow(/different escrow or payment token.*Nothing was sent/);
  });

  it('refuses the run when the backend names another token', () => {
    expect(() => pinnedContracts('arc', { escrow: BUILD.escrow, token: ATTACKER })).toThrow(/different escrow or payment token/);
  });

  it('refuses the run when this build knows no escrow on that chain', () => {
    const built = defaultSettlement();
    built.chains.arc = { ...built.chains.arc, escrow: '' };
    expect(() => pinnedContracts('arc', { escrow: ATTACKER, token: BUILD.token.address }, built)).toThrow('no escrow to post on');
  });
});

describe('checkBulkCall: createTask', () => {
  const t1 = task(1);
  const expect1: ExpectedCall = { fn: 'createTask', task: t1 };

  it('passes an honest build and keeps only its target and calldata', () => {
    const tx = createTaskTx(t1, { gasLimit: 16_000_000, value: '0' });
    const call = checkBulkCall({ unsignedTx: tx, chain: 'arc', chainId: PINS.chainId }, expect1, PINS);
    expect(call).toEqual({ to: PINS.escrow, data: tx.data });
  });

  it('refuses a tampered amount', () => {
    expect(refusal({ unsignedTx: createTaskTx({ ...t1, amount: 999_000_000n }) }, expect1)).toMatch(/amount/);
  });

  it('refuses a tampered duration (a one-hour deadline)', () => {
    expect(refusal({ unsignedTx: createTaskTx({ ...t1, duration: 3_600n }) }, expect1)).toMatch(/duration/);
  });

  it('refuses another task hash, zone or category', () => {
    expect(refusal({ unsignedTx: createTaskTx({ ...t1, taskHash: HASH(9) }) }, expect1)).toMatch(/taskHash/);
    expect(refusal({ unsignedTx: createTaskTx({ ...t1, locationZone: 'NG' }) }, expect1)).toMatch(/zone/);
    expect(refusal({ unsignedTx: createTaskTx({ ...t1, category: 'other' }) }, expect1)).toMatch(/category/);
  });

  it('refuses a verifier on a task that commits none', () => {
    expect(refusal({ unsignedTx: createTaskTx({ ...t1, verifier: ATTACKER }) }, expect1)).toMatch(/createTaskWithVerifier, not createTask/);
  });

  it('takes createTaskWithVerifier only with the verifier the task commits', () => {
    const withVerifier: ExpectedCall = { fn: 'createTask', task: { ...t1, verifier: VERIFIER } };
    expect(checkBulkCall({ unsignedTx: createTaskTx({ ...t1, verifier: VERIFIER }) }, withVerifier, PINS).to).toBe(PINS.escrow);
    expect(refusal({ unsignedTx: createTaskTx({ ...t1, verifier: ATTACKER }) }, withVerifier)).toMatch(/verifier/);
  });

  it('refuses another target, even with the right calldata', () => {
    expect(refusal({ unsignedTx: createTaskTx(t1, { to: ATTACKER }) }, expect1)).toMatch(/sent to/);
  });

  it('refuses another token in the call', () => {
    const tx = createTaskTx(t1);
    const data = BULK_CALLS.encodeFunctionData('createTask', [t1.taskHash, ATTACKER, t1.amount, 'general', 'global', t1.duration]);
    expect(refusal({ unsignedTx: { ...tx, data } }, expect1)).toMatch(/pays in/);
  });

  it('refuses a value', () => {
    expect(refusal({ unsignedTx: createTaskTx(t1, { value: '1' }) }, expect1)).toMatch(/value/);
    expect(refusal({ unsignedTx: createTaskTx(t1, { value: 'lots' }) }, expect1)).toMatch(/value/);
  });

  it('refuses a cancelTask, or anything else the escrow has', () => {
    const cancel = new Interface(['function cancelTask(uint256 taskId)']).encodeFunctionData('cancelTask', [7n]);
    expect(refusal({ unsignedTx: createTaskTx(t1, { data: cancel }) }, expect1)).toMatch(/not an approve or a createTask/);
    expect(refusal({ unsignedTx: createTaskTx(t1, { data: '0x' }) }, expect1)).toMatch(/nothing/);
  });

  it('refuses calldata with bytes riding along after the arguments', () => {
    const tx = createTaskTx(t1);
    refusal({ unsignedTx: { ...tx, data: tx.data + 'deadbeef' } }, expect1);
  });

  it('refuses a build for another chain', () => {
    expect(refusal({ unsignedTx: createTaskTx(t1), chain: 'base' }, expect1)).toMatch(/built for base/);
    expect(refusal({ unsignedTx: createTaskTx(t1), chainId: 1 }, expect1)).toMatch(/chain 1/);
    expect(refusal({ unsignedTx: createTaskTx(t1, { chainId: 8453 }) }, expect1)).toMatch(/chain 8453/);
  });

  it('refuses a createTasks where one createTask was asked for', () => {
    expect(refusal({ unsignedTx: createTasksTx([t1]) }, expect1)).toMatch(/createTasks, not createTask/);
  });
});

describe('checkBulkCall: createTasks', () => {
  const rows = [task(1), task(2), task(3)];
  const expectRows: ExpectedCall = { fn: 'createTasks', tasks: rows };

  it('passes an honest batch and drops its gas limit and chain id', () => {
    const tx = createTasksTx(rows);
    expect(checkBulkCall({ unsignedTx: tx, chain: 'arc', chainId: PINS.chainId }, expectRows, PINS)).toEqual({ to: PINS.escrow, data: tx.data });
  });

  it('refuses the whole total put into one task, with a one-hour deadline and an attacker verifier', () => {
    const total = rows.reduce((s, r) => s + r.amount, 0n);
    const drained = [{ ...rows[0], amount: total, duration: 3_600n, verifier: ATTACKER }, { ...rows[1], amount: 1n }, { ...rows[2], amount: 1n }];
    expect(refusal({ unsignedTx: createTasksTx(drained) }, expectRows)).toMatch(/task 1: amount/);
  });

  it('refuses one tampered amount, duration or verifier anywhere in the batch', () => {
    expect(refusal({ unsignedTx: createTasksTx([rows[0], rows[1], { ...rows[2], amount: 1n }]) }, expectRows)).toMatch(/task 3: amount/);
    expect(refusal({ unsignedTx: createTasksTx([rows[0], { ...rows[1], duration: 3_600n }, rows[2]]) }, expectRows)).toMatch(/task 2: duration/);
    expect(refusal({ unsignedTx: createTasksTx([rows[0], { ...rows[1], verifier: ATTACKER }, rows[2]]) }, expectRows)).toMatch(/task 2: verifier/);
  });

  it('refuses an extra task, a missing one, or the same tasks in another order', () => {
    expect(refusal({ unsignedTx: createTasksTx([...rows, task(4)]) }, expectRows)).toMatch(/creates 4 tasks, not 3/);
    expect(refusal({ unsignedTx: createTasksTx(rows.slice(0, 2)) }, expectRows)).toMatch(/creates 2 tasks, not 3/);
    expect(refusal({ unsignedTx: createTasksTx([rows[1], rows[0], rows[2]]) }, expectRows)).toMatch(/task 1: taskHash/);
  });

  it('refuses another token for the batch', () => {
    expect(refusal({ unsignedTx: createTasksTx(rows, {}, ATTACKER) }, expectRows)).toMatch(/pays in/);
  });

  it('refuses another target or a value', () => {
    expect(refusal({ unsignedTx: createTasksTx(rows, { to: PINS.token }) }, expectRows)).toMatch(/sent to/);
    expect(refusal({ unsignedTx: createTasksTx(rows, { value: '0x01' }) }, expectRows)).toMatch(/value/);
  });

  it('refuses a single createTask where a batch was asked for', () => {
    expect(refusal({ unsignedTx: createTaskTx(rows[0]) }, expectRows)).toMatch(/createTask, not createTasks/);
  });
});

describe('checkBulkCall: approve', () => {
  const total = 6_000_000n;

  it('passes approve(escrow, total) on the token', () => {
    const tx = approveTx(PINS.escrow, total);
    expect(checkBulkCall({ unsignedTx: tx }, { fn: 'approve', amount: total }, PINS)).toEqual({ to: PINS.token, data: tx.data });
  });

  it('refuses another spender', () => {
    expect(refusal({ unsignedTx: approveTx(ATTACKER, total) }, { fn: 'approve', amount: total })).toMatch(/approves 0x/i);
  });

  it('refuses another amount', () => {
    expect(refusal({ unsignedTx: approveTx(PINS.escrow, 2n ** 256n - 1n) }, { fn: 'approve', amount: total })).toMatch(/approves \d+, not 6000000/);
  });

  it('refuses an approval on another token', () => {
    expect(refusal({ unsignedTx: approveTx(PINS.escrow, total, { to: ATTACKER }) }, { fn: 'approve', amount: total })).toMatch(/sent to/);
  });

  it('refuses a value on the approval', () => {
    expect(refusal({ unsignedTx: approveTx(PINS.escrow, total, { value: 5n }) }, { fn: 'approve', amount: total })).toMatch(/value/);
  });
});
