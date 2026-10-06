/**
 * Deploy fees paid on Arc that no deploy has used yet, per owner, kept in
 * localStorage so a failed deploy (a closed tab included) never makes the
 * next attempt pay again. The backend takes each payment for one deploy only.
 *
 * Every tab of an owner shares them, so each is an entry `{hash, runId, at}`:
 * the deploy run that paid it, or took it from an earlier attempt, holds it
 * while it runs and says so every FEE_HEARTBEAT_MS. A run is offered only
 * the fees no live run holds, clears only the fee it consumed, and frees the
 * rest when it ends. One slot per owner used to be shared by every tab: a
 * second tab's payment overwrote the first's, a run that finished cleared
 * the other tab's, and a second run could be handed a fee still in use.
 */

export type FeeStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface PendingFee {
  hash: string;
  /** The run holding it, or null when it is free for the next run. */
  runId: string | null;
  /** When it was paid, or when the run holding it last said it was alive (ms). */
  at: number;
}

/**
 * A hold not refreshed for this long is a run whose tab closed: its fees are
 * free again. Browsers run a hidden tab's timers about once a minute.
 */
export const FEE_HOLD_MS = 5 * 60_000;
/** How often a run refreshes its holds. */
export const FEE_HEARTBEAT_MS = 30_000;

const listKey = (owner: string) => `bb.deployFees.${owner.toLowerCase()}`;
/** The one hash per owner pages kept before the list: still read, so a fee one saved is used. */
const legacyKey = (owner: string) => `bb.deployFeeTx.${owner.toLowerCase()}`;
const isHash = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function read(storage: FeeStorage, owner: string): PendingFee[] {
  let list: PendingFee[] = [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(listKey(owner)) ?? '[]');
    if (Array.isArray(parsed)) {
      list = parsed
        .filter((f) => isHash(f?.hash))
        .map((f) => ({ hash: f.hash, runId: typeof f.runId === 'string' ? f.runId : null, at: Number(f.at) || 0 }));
    }
  } catch { /* unreadable: start empty */ }
  const legacy = storage.getItem(legacyKey(owner));
  if (isHash(legacy) && !list.some((f) => same(f.hash, legacy))) list.push({ hash: legacy, runId: null, at: 0 });
  return list;
}

function write(storage: FeeStorage, owner: string, list: PendingFee[]): void {
  storage.setItem(listKey(owner), JSON.stringify(list));
}

const held = (f: PendingFee, now: number) => f.runId !== null && now - f.at < FEE_HOLD_MS;

/** The fees no live run holds, oldest first. */
export function freeFees(storage: FeeStorage, owner: string, now: number): PendingFee[] {
  return read(storage, owner).filter((f) => !held(f, now));
}

/** Take a fee no live run holds, for `runId` to hold until it ends. Null when there is none. */
export function claimFee(storage: FeeStorage, owner: string, runId: string, now: number): string | null {
  const list = read(storage, owner);
  const free = list.find((f) => !held(f, now));
  if (!free) return null;
  free.runId = runId;
  free.at = now;
  write(storage, owner, list);
  return free.hash;
}

/** `runId` paid `hash` and holds it. Saved the moment the wallet broadcasts it. */
export function addFee(storage: FeeStorage, owner: string, hash: string, runId: string, now: number): void {
  write(storage, owner, [...read(storage, owner).filter((f) => !same(f.hash, hash)), { hash, runId, at: now }]);
}

/** Forget `hash` and nothing else: a deploy consumed it, or it can never pay for one. */
export function dropFee(storage: FeeStorage, owner: string, hash: string): void {
  write(storage, owner, read(storage, owner).filter((f) => !same(f.hash, hash)));
  const legacy = storage.getItem(legacyKey(owner));
  if (legacy && same(legacy, hash)) storage.removeItem(legacyKey(owner));
}

/** `runId` is still running: refresh its holds. */
export function touchFees(storage: FeeStorage, owner: string, runId: string, now: number): void {
  const list = read(storage, owner);
  if (!list.some((f) => f.runId === runId)) return;
  write(storage, owner, list.map((f) => (f.runId === runId ? { ...f, at: now } : f)));
}

/** `runId` ended: the fees it holds that no deploy used are free for the next run. */
export function releaseFees(storage: FeeStorage, owner: string, runId: string): void {
  const list = read(storage, owner);
  if (!list.some((f) => f.runId === runId)) return;
  write(storage, owner, list.map((f) => (f.runId === runId ? { ...f, runId: null } : f)));
}

/** localStorage, or a store that keeps nothing where the browser blocks it (a failed deploy then needs a new payment). */
export const browserFeeStorage: FeeStorage = {
  getItem: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  setItem: (k, v) => { try { localStorage.setItem(k, v); } catch { /* blocked */ } },
  removeItem: (k) => { try { localStorage.removeItem(k); } catch { /* blocked */ } },
};
