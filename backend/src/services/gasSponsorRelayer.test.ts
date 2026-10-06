import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { readFileSync } from 'fs';

/**
 * The sponsored-gas relayer (gasSponsorRelayer.ts): the single writer, every
 * pre-send check, the write-ahead send, success = the escrow event plus the
 * delegation still in place, cost accounting, recovery that re-broadcasts the
 * stored bytes, the reservation sweep and the automatic pause. The store, the
 * escrow reads and the chain are in-memory fakes; the claim and cap SQL run
 * on real Postgres in gasSponsorStore.test.ts.
 */

const agentKey = ethers.Wallet.createRandom().privateKey;
const AGENT = new ethers.Wallet(agentKey).address;
const sponsorKey = ethers.Wallet.createRandom().privateKey;
const SPONSOR = new ethers.Wallet(sponsorKey).address;
const ESCROW = ethers.getAddress('0x' + 'e5'.repeat(20));
const DELEGATE = ethers.getAddress('0x' + 'de'.repeat(20));
const CHAIN_ID = 5042002;
const TASK_ID = 41n;
const TASK_HASH = '0x' + '7a'.repeat(32);
const RESULT = { output: 'the work' };
const EVIDENCE = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(RESULT)));
const GWEI = 10n ** 9n;
const DESIGNATOR = `0xef0100${DELEGATE.slice(2).toLowerCase()}`;

const settings = vi.hoisted(() => ({ current: null as any }));
vi.mock('./gasSponsorConfig.js', async (orig) => ({
  ...(await orig<typeof import('./gasSponsorConfig.js')>()),
  runnableSettings: async () => (settings.current ? { ok: true, settings: settings.current } : { ok: false, reason: 'off' }),
  gasSponsorSettings: () => settings.current ?? { enabled: false, reason: 'off', misconfigured: false },
}));
const elig = vi.hoisted(() => ({ agent: { ok: true, ownerDid: 'did:privy:abc' } as any, task: { ok: true } as any }));
vi.mock('./gasSponsorEligibility.js', () => ({
  agentEligibility: vi.fn(async () => elig.agent),
  taskEligibility: vi.fn(async () => elig.task),
}));

type Res = { id: number; chainId: number; taskId: bigint; kind: 'submit' | 'release'; taskHash: string; agentWallet: string; ownerDid: string; poster: string;
  status: string; budgetWei: bigint; createdAt: Date; expiresAt: Date; txHash: string | null; gasUsed: bigint | null; costWei: bigint | null };
type Tx = { id: number; chainId: number; reservationId: number; sponsor: string; nonce: number; rawTx: string; txHash: string; withAuthorization: boolean;
  status: string; gasUsed?: bigint; costWei?: bigint };
const db = vi.hoisted(() => ({
  reservations: [] as any[], txs: [] as any[], controls: { paused: false, killed: false } as any, strikes: [] as any[], events: [] as string[],
  exported: new Set<string>(),
  usage: { spentLastHourWei: 0n, spentLastDayWei: 0n, callsLastDay: 0, failuresLastHour: 0, sendsLastHour: 0 },
  setControlsCalls: [] as any[],
}));
vi.mock('./gasSponsorStore.js', () => ({
  getControls: vi.fn(async () => db.controls),
  setControls: vi.fn(async (_c: number, change: any, reason: string, by: string) => {
    db.setControlsCalls.push({ change, reason, by });
    Object.assign(db.controls, change);
    return db.controls;
  }),
  getReservation: vi.fn(async (_c: number, taskId: bigint, kind: string) => db.reservations.find((r: Res) => r.taskId === taskId && r.kind === kind) ?? null),
  getReservationById: vi.fn(async (id: number) => db.reservations.find((r: Res) => r.id === id) ?? null),
  heldReservations: vi.fn(async () => db.reservations.filter((r: Res) => r.status === 'reserved')),
  closeReservation: vi.fn(async (id: number, status: string) => {
    const r = db.reservations.find((x: Res) => x.id === id);
    if (!r || r.status !== 'reserved') return false;
    r.status = status;
    if (status === 'expired') db.strikes.push(id);
    return true;
  }),
  markReservationUsed: vi.fn(async (id: number, txHash: string | null) => {
    const r = db.reservations.find((x: Res) => x.id === id);
    r.status = 'used';
    r.txHash = txHash;
  }),
  reserve: vi.fn(async (input: any) => {
    const r = { id: db.reservations.length + 1, ...input, agentWallet: input.agentWallet.toLowerCase(), status: 'reserved', createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000), txHash: null, gasUsed: null, costWei: null };
    db.reservations.push(r);
    return { ok: true, reservation: r, existing: false };
  }),
  nextStoredNonce: vi.fn(async () => (db.txs.length ? Math.max(...db.txs.map((t: Tx) => t.nonce)) + 1 : null)),
  recordSignedTx: vi.fn(async (tx: any) => {
    db.events.push(`signed:${tx.nonce}`);
    const row = { id: db.txs.length + 1, ...tx, status: 'signed', createdAt: new Date() };
    db.txs.push(row);
    return row;
  }),
  setTxStatus: vi.fn(async (hash: string, status: string) => { db.txs.find((t: Tx) => t.txHash === hash).status = status; }),
  settleTx: vi.fn(async (hash: string, status: string, gasUsed: bigint, costWei: bigint) => {
    const t = db.txs.find((x: Tx) => x.txHash === hash);
    if (t.costWei !== undefined) return;
    Object.assign(t, { status, gasUsed, costWei });
    const r = db.reservations.find((x: Res) => x.id === t.reservationId);
    r.gasUsed = (r.gasUsed ?? 0n) + gasUsed;
    r.costWei = (r.costWei ?? 0n) + costWei;
  }),
  setupAttempts: vi.fn(async () => db.txs.filter((t: Tx) => t.withAuthorization && t.status !== 'dropped' && t.status !== 'rejected').length),
  unsettledTxs: vi.fn(async () => db.txs.filter((t: Tx) => t.status === 'signed' || t.status === 'sent')),
  txsForReservation: vi.fn(async (id: number) => db.txs.filter((t: Tx) => t.reservationId === id)),
  usage: vi.fn(async () => db.usage),
  walletKeyExported: vi.fn(async (w: string) => db.exported.has(w.toLowerCase())),
}));

const chain = vi.hoisted(() => ({
  task: null as any, deadline: null as bigint | null, state: null as any,
  // What a fresh eth_call of getTask sees, when it differs from the first read.
  taskAfter: null as any, escalated: true,
  code: '0x', estimate: 120_000n, estimateError: null as any, baseFee: 20n * 10n ** 9n,
  sponsorNonce: 0, latestNonce: 0, mined: new Map<string, { status: number; logs: any[]; gasUsed: bigint; gasPrice: bigint }>(),
  sent: [] as string[], broadcastError: null as any, balance: 10n ** 19n, knownTx: new Set<string>(),
  onBroadcast: null as null | ((raw: string, hash: string) => void),
  // Reads of a transaction (receipt, by hash) fail with this: an RPC outage.
  txReadError: null as any,
}));
const ESCROW_IFACE = new ethers.Interface(JSON.parse(readFileSync(new URL('../abi/BlindEscrow.json', import.meta.url), 'utf-8')));
function ethCall(data: string): string {
  const fn = ESCROW_IFACE.parseTransaction({ data })!;
  if (fn.name === 'unjudgedEscalation') return ESCROW_IFACE.encodeFunctionResult(fn.name, [chain.escalated]);
  const t = chain.taskAfter ?? chain.task;
  return ESCROW_IFACE.encodeFunctionResult('getTask', [[
    t.agent.length === 42 ? t.agent : ethers.ZeroAddress, t.worker, t.token, t.amount, t.taskHash, t.evidenceHash, t.status,
    '', '', t.createdAt, t.deadline, t.submissionAttempts,
  ]]);
}
const provider = {
  // ethers answers a repeat getCode within 250 ms from its cache: the relayer must read code with eth_getCode.
  getCode: vi.fn(async () => { throw new Error('read code with eth_getCode, not the cached getCode'); }),
  send: vi.fn(async (method: string, params: any[]) => {
    if (method === 'eth_getCode') return chain.code;
    if (method === 'eth_call') return ethCall(params[0].data);
    if (method === 'eth_getTransactionCount') return ethers.toQuantity(chain.latestNonce);
    if (method === 'eth_getTransactionByHash') {
      if (chain.txReadError) throw chain.txReadError;
      return chain.knownTx.has(params[0]) ? { hash: params[0], blockNumber: '0x9' } : null;
    }
    if (method === 'eth_estimateGas') {
      if (chain.estimateError) throw chain.estimateError;
      return ethers.toQuantity(chain.estimate);
    }
    if (method === 'eth_sendRawTransaction') {
      if (chain.broadcastError) throw chain.broadcastError;
      const raw = params[0] as string;
      const hash = ethers.keccak256(raw);
      db.events.push('broadcast');
      chain.sent.push(raw);
      chain.onBroadcast?.(raw, hash);
      return hash;
    }
    throw new Error(`unexpected ${method}`);
  }),
  getFeeData: vi.fn(async () => ({ maxFeePerGas: 2n * chain.baseFee, maxPriorityFeePerGas: 0n, gasPrice: chain.baseFee })),
  getBlock: vi.fn(async () => ({ baseFeePerGas: chain.baseFee })),
  getTransactionCount: vi.fn(async (_a: string, tag: string) => (tag === 'latest' ? chain.latestNonce : chain.sponsorNonce)),
  getTransactionReceipt: vi.fn(async (hash: string) => {
    if (chain.txReadError) throw chain.txReadError;
    const r = chain.mined.get(hash);
    return r ? { blockNumber: 9, ...r } : null;
  }),
  getTransaction: vi.fn(async (hash: string) => (chain.knownTx.has(hash) ? { hash, blockNumber: 9 } : null)),
  getBalance: vi.fn(async () => chain.balance),
};
vi.mock('./chainRuntime.js', () => ({ chainRuntime: () => ({ provider, escrow: { interface: ESCROW_IFACE } }) }));
vi.mock('./escrow.js', () => ({
  getTaskOn: vi.fn(async () => chain.task),
  effectiveDeadlineOn: vi.fn(async () => chain.deadline),
}));
vi.mock('./a2aStore.js', () => ({ getState: vi.fn(async () => chain.state) }));
type FakeClient = { released: unknown[]; listeners: Record<string, Array<(err: Error) => void>> };
const lock = vi.hoisted(() => ({ held: false, clients: [] as FakeClient[] }));
vi.mock('./neonDb.js', () => ({
  getPool: async () => ({
    connect: async () => {
      const client = {
        released: [] as unknown[],
        listeners: {} as Record<string, Array<(err: Error) => void>>,
        query: async (sql: string) => {
          if (/pg_try_advisory_lock/.test(sql)) {
            const got = !lock.held;
            lock.held = true;
            return { rows: [{ locked: got }] };
          }
          if (/pg_advisory_unlock/.test(sql)) lock.held = false;
          return { rows: [] };
        },
        release: (err?: Error) => { client.released.push(err ?? null); },
        on: (event: string, fn: (err: Error) => void) => { (client.listeners[event] ??= []).push(fn); },
      };
      lock.clients.push(client);
      return client;
    },
  }),
}));
const recordEvent = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./analyticsService.js', () => ({ recordEvent }));
vi.mock('@sentry/node', () => ({ captureMessage: vi.fn() }));

const relayer = await import('./gasSponsorRelayer.js');
const { CALL_TYPES, callDomain, DelegateKind } = await import('./blindAgentDelegate.js');
const { signAuthorization } = await import('./eip7702.js');

const agentWallet = new ethers.Wallet(agentKey);
const ESCROW_EVENTS = new ethers.Interface(['event EvidenceSubmitted(uint256 indexed taskId, address indexed worker, bytes32 evidenceHash, uint8 attempt)']);
const evidenceLog = (taskId = TASK_ID, worker = AGENT) => {
  const ev = ESCROW_EVENTS.encodeEventLog('EvidenceSubmitted', [taskId, worker, EVIDENCE, 1]);
  return { address: ESCROW, topics: ev.topics, data: ev.data };
};

function baseSettings() {
  return {
    enabled: true, chain: { key: 'arc', chainId: CHAIN_ID, gas: { workerTxGasLimit: 200_000n }, token: { address: '0x3600000000000000000000000000000000000000', unit: { decimals: 6 } } },
    chainId: CHAIN_ID, escrow: ESCROW, delegate: DELEGATE, sponsor: new ethers.Wallet(sponsorKey), maxGas: 200_000n, maxFeeWei: 100n * GWEI,
    minTaskRaw: 100_000n, caps: { perAgentDaily: 10, perUserDaily: 20, perPosterDaily: 10, hourlyBudgetWei: 10n ** 17n, dailyBudgetWei: 10n ** 18n, maxStrikes: 3 },
    maxFailuresPerHour: 5, stuckMs: 600_000,
  };
}

async function sign(o: Partial<{ kind: number; taskId: bigint; evidenceHash: string; nonce: bigint; deadline: bigint; key: string }> = {}) {
  const call = { kind: DelegateKind.SubmitEvidence, taskId: TASK_ID, evidenceHash: EVIDENCE, nonce: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 600), ...o };
  const signer = o.key ? new ethers.Wallet(o.key) : agentWallet;
  const signature = await signer.signTypedData(callDomain(CHAIN_ID, AGENT), CALL_TYPES, { ...call, escrow: ESCROW });
  return { call, signature };
}

async function input(o: Partial<{ kind: 'submit' | 'release'; authorization: any; signKey: string; nonce: bigint; taskId: bigint }> = {}) {
  const kind = o.kind ?? 'submit';
  const { call, signature } = await sign({
    kind: kind === 'submit' ? DelegateKind.SubmitEvidence : DelegateKind.ReleaseUnjudgedWork,
    taskId: o.taskId ?? TASK_ID,
    evidenceHash: kind === 'submit' ? EVIDENCE : ethers.ZeroHash,
    nonce: o.nonce ?? 0n,
    ...(o.signKey ? { key: o.signKey } : {}),
  });
  return {
    agent: { walletAddress: AGENT } as any,
    kind, taskId: call.taskId, evidenceHash: call.evidenceHash, nonce: call.nonce, deadline: call.deadline, signature,
    ...(o.authorization ? { authorization: o.authorization } : {}),
  };
}

const auth = (o: Partial<{ chainId: bigint; address: string; key: string; nonce: bigint }> = {}) =>
  signAuthorization(new ethers.SigningKey(o.key ?? agentKey), { chainId: o.chainId ?? BigInt(CHAIN_ID), address: o.address ?? DELEGATE, nonce: o.nonce ?? 0n });

function holdReservation(o: Partial<Res> = {}): Res {
  const r: Res = {
    id: db.reservations.length + 1, chainId: CHAIN_ID, taskId: TASK_ID, kind: 'submit', taskHash: TASK_HASH, agentWallet: AGENT.toLowerCase(),
    ownerDid: 'did:privy:abc', poster: '0xposter', status: 'reserved', budgetWei: 10n ** 16n, createdAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000),
    txHash: null, gasUsed: null, costWei: null, ...o,
  };
  db.reservations.push(r);
  return r;
}

beforeEach(async () => {
  await relayer._resetGasSponsorRelayer();
  lock.held = false;
  lock.clients.length = 0;
  settings.current = baseSettings();
  elig.agent = { ok: true, ownerDid: 'did:privy:abc' };
  elig.task = { ok: true };
  db.reservations.length = 0;
  db.txs.length = 0;
  db.strikes.length = 0;
  db.events.length = 0;
  db.setControlsCalls.length = 0;
  db.exported.clear();
  db.controls = { paused: false, killed: false };
  db.usage = { spentLastHourWei: 0n, spentLastDayWei: 0n, callsLastDay: 0, failuresLastHour: 0, sendsLastHour: 0 };
  Object.assign(chain, {
    task: { agent: '0xposter', worker: AGENT, token: '0x3600000000000000000000000000000000000000', amount: 1_000_000n, taskHash: TASK_HASH,
      evidenceHash: ethers.ZeroHash, status: 1, createdAt: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 86_400), submissionAttempts: 0 },
    deadline: null, state: { executorAddress: AGENT.toLowerCase(), assignTxHash: '0xassign', resultData: RESULT }, taskAfter: null, escalated: true,
    code: '0x', estimate: 120_000n, estimateError: null, baseFee: 20n * GWEI, sponsorNonce: 3, latestNonce: 3, sent: [], broadcastError: null,
    balance: 10n ** 19n, onBroadcast: null, txReadError: null,
  });
  chain.mined.clear();
  chain.knownTx.clear();
  // A broadcast mines with the escrow's event, unless a test says otherwise.
  chain.onBroadcast = (_raw, hash) => {
    chain.mined.set(hash, { status: 1, logs: [evidenceLog()], gasUsed: 150_000n, gasPrice: 20n * GWEI });
    chain.code = DESIGNATOR;
  };
  vi.clearAllMocks();
});

const writer = async () => expect(await relayer.acquireSponsorWriter(settings.current)).toBe(true);

describe('the single writer', () => {
  it('sends only from the process holding the lock', async () => {
    holdReservation();
    expect(await relayer.relaySponsoredCall(await input({ authorization: auth() }))).toMatchObject({ ok: false, code: 'GAS_SPONSOR_OFF' });
    await writer();
    expect(await relayer.acquireSponsorWriter(settings.current)).toBe(true); // re-entrant here
    lock.held = true;
    await relayer.releaseSponsorWriter();
    expect(lock.held).toBe(false);
  });

  it('gives the pool slot back when the writer connection drops (delta audit 2026-10-06, ops-1)', async () => {
    await writer();
    const client = lock.clients.at(-1)!;
    const dropped = new Error('Connection terminated unexpectedly');
    client.listeners.error.forEach((fn) => fn(dropped));
    expect(relayer.isSponsorWriter()).toBe(false);
    // Released with the error, which makes the pool destroy the client.
    expect(client.released).toEqual([dropped]);
    // A later error on it is not ours to release again (the pool throws on a double release).
    client.listeners.error.forEach((fn) => fn(dropped));
    expect(client.released).toEqual([dropped]);
    // Postgres freed the lock with the connection; the next tick takes it on a fresh one.
    lock.held = false;
    await writer();
    expect(lock.clients).toHaveLength(2);
  });

  it('refuses when sponsorship is off', async () => {
    settings.current = null;
    expect(await relayer.relaySponsoredCall(await input())).toMatchObject({ ok: false, code: 'GAS_SPONSOR_OFF' });
  });
});

describe('a sponsored first submit', () => {
  it('stores the signed bytes, then sends a type-4 transaction carrying the authorization, and closes the reservation as used', async () => {
    await writer();
    const r = holdReservation();
    const result = await relayer.relaySponsoredCall(await input({ authorization: auth() }));
    expect(result).toMatchObject({ ok: true });
    expect(db.events).toEqual(['signed:3', 'broadcast']);
    const raw = chain.sent[0];
    expect(raw.startsWith('0x04')).toBe(true);
    const fields = ethers.decodeRlp(ethers.dataSlice(raw, 1)) as any[];
    expect(BigInt(fields[0])).toBe(BigInt(CHAIN_ID)); // chain id
    expect(BigInt(fields[1])).toBe(3n); // the sponsor's nonce
    expect(BigInt(fields[3])).toBe(40n * GWEI); // maxFeePerGas, under the cap
    expect(BigInt(fields[4])).toBe((120_000n * 115n + 99n) / 100n); // estimate × 1.15
    expect(ethers.getAddress(fields[5])).toBe(AGENT); // sent to the agent's own wallet
    expect(fields[9]).toHaveLength(1); // the authorization rides along
    expect(r.status).toBe('used');
    expect(r.txHash).toBe(ethers.keccak256(raw));
    expect(r.costWei).toBe(150_000n * 20n * GWEI);
    expect(db.txs[0]).toMatchObject({ status: 'confirmed', withAuthorization: true });
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'gas_sponsored', props: expect.objectContaining({ outcome: 'confirmed', kind: 'submit' }) }));
    // The delegation is checked as of the receipt's block, read from the node.
    expect(provider.send).toHaveBeenCalledWith('eth_getCode', [AGENT, '0x9']);
  });

  it('sends a plain type-2 transaction once the wallet is delegated, dropping a redundant authorization', async () => {
    await writer();
    holdReservation();
    chain.code = DESIGNATOR;
    expect(await relayer.relaySponsoredCall(await input({ authorization: auth() }))).toMatchObject({ ok: true });
    expect(chain.sent[0].startsWith('0x02')).toBe(true);
    expect(ethers.Transaction.from(chain.sent[0]).to).toBe(AGENT);
  });

  it('caps maxFeePerGas and never reuses a stored nonce when the RPC lags', async () => {
    await writer();
    holdReservation();
    chain.baseFee = 90n * GWEI; // ethers' maxFee would be 180 gwei
    db.txs.push({ id: 99, chainId: CHAIN_ID, reservationId: 0, sponsor: SPONSOR, nonce: 7, rawTx: '0x', txHash: '0xold', withAuthorization: false, status: 'confirmed', costWei: 0n });
    expect(await relayer.relaySponsoredCall(await input({ authorization: auth() }))).toMatchObject({ ok: true });
    const fields = ethers.decodeRlp(ethers.dataSlice(chain.sent[0], 1)) as any[];
    expect(BigInt(fields[1])).toBe(8n);
    expect(BigInt(fields[3])).toBe(100n * GWEI);
  });

  it('counts a successful receipt without the escrow event as a no-op, keeps the reservation, and records the cost', async () => {
    await writer();
    const r = holdReservation();
    chain.onBroadcast = (_raw, hash) => chain.mined.set(hash, { status: 1, logs: [], gasUsed: 30_000n, gasPrice: 20n * GWEI });
    expect(await relayer.relaySponsoredCall(await input({ authorization: auth() }))).toMatchObject({ ok: false, code: 'SETUP_NOOP' });
    expect(r.status).toBe('reserved');
    expect(r.costWei).toBe(30_000n * 20n * GWEI);
    expect(db.txs[0].status).toBe('noop');
  });

  it('counts a receipt whose wallet lost its delegation as a no-op', async () => {
    await writer();
    holdReservation();
    chain.onBroadcast = (_raw, hash) => chain.mined.set(hash, { status: 1, logs: [evidenceLog()], gasUsed: 30_000n, gasPrice: 20n * GWEI });
    chain.code = '0x';
    expect(await relayer.relaySponsoredCall(await input({ authorization: auth() }))).toMatchObject({ ok: false, code: 'SETUP_NOOP' });
  });

  it('records a revert and its cost', async () => {
    await writer();
    const r = holdReservation();
    chain.onBroadcast = (_raw, hash) => chain.mined.set(hash, { status: 0, logs: [], gasUsed: 50_000n, gasPrice: 20n * GWEI });
    expect(await relayer.relaySponsoredCall(await input({ authorization: auth() }))).toMatchObject({ ok: false, code: 'REVERTED' });
    expect(db.txs[0].status).toBe('reverted');
    expect(r.costWei).toBe(50_000n * 20n * GWEI);
  });

  it('keeps the signed bytes when the broadcast does not go through, and answers pending', async () => {
    await writer();
    holdReservation();
    chain.broadcastError = new Error('timeout');
    expect(await relayer.relaySponsoredCall(await input({ authorization: auth() })))
      .toMatchObject({ ok: false, status: 202, code: 'PENDING', txHash: db.txs[0]?.txHash });
    expect(db.txs[0].status).toBe('signed');
  });

  it('a repeat while our transaction is out waits for it instead of sending another', async () => {
    await writer();
    holdReservation();
    chain.broadcastError = new Error('timeout');
    await relayer.relaySponsoredCall(await input({ authorization: auth() }));
    chain.broadcastError = null;
    // recover() re-sent the stored bytes and they mined.
    chain.mined.set(db.txs[0].txHash, { status: 1, logs: [evidenceLog()], gasUsed: 150_000n, gasPrice: 20n * GWEI });
    chain.code = DESIGNATOR;
    expect(await relayer.relaySponsoredCall(await input({ authorization: auth() }))).toEqual({ ok: true, txHash: db.txs[0].txHash });
    expect(db.txs).toHaveLength(1);
    expect(db.reservations[0].status).toBe('used');
  });

  it('a repeat after our transaction landed answers with it', async () => {
    await writer();
    holdReservation();
    const first = await relayer.relaySponsoredCall(await input({ authorization: auth() }));
    Object.assign(chain.task, { status: 2, evidenceHash: EVIDENCE, submissionAttempts: 1 });
    expect(await relayer.relaySponsoredCall(await input({ nonce: 1n }))).toEqual(first);
    expect(chain.sent).toHaveLength(1);
  });
});

describe('what is checked before anything is sent', () => {
  beforeEach(async () => {
    await writer();
  });

  const refused = async (code: string, inp?: Awaited<ReturnType<typeof input>>) => {
    expect(await relayer.relaySponsoredCall(inp ?? (await input({ authorization: auth() })))).toMatchObject({ ok: false, code });
    expect(chain.sent).toEqual([]);
    expect(db.txs).toEqual([]);
  };

  it('kill stops every send, reserved ones included', async () => {
    holdReservation();
    db.controls = { paused: false, killed: true };
    await refused('GAS_SPONSOR_KILLED');
  });

  it('pause does not stop a reserved submit', async () => {
    holdReservation();
    db.controls = { paused: true, killed: false };
    expect(await relayer.relaySponsoredCall(await input({ authorization: auth() }))).toMatchObject({ ok: true });
  });

  it('an export between reservation and relay is refused, and ends the reservation', async () => {
    const r = holdReservation();
    elig.agent = { ok: false, reason: 'key_exported' };
    await refused('GAS_SPONSOR_INELIGIBLE');
    expect(r.status).toBe('released');
  });

  it('refuses a task the escrow does not assign to this wallet', async () => {
    holdReservation();
    chain.task.worker = '0x' + '99'.repeat(20);
    await refused('NOT_WORKER');
  });

  it('refuses without a held reservation', async () => {
    await refused('NO_RESERVATION');
    holdReservation({ agentWallet: '0x' + '98'.repeat(20) });
    await refused('NO_RESERVATION');
  });

  it('refuses anything but the first submit of an Assigned task', async () => {
    holdReservation();
    chain.task.submissionAttempts = 1;
    await refused('NOT_FIRST_SUBMIT');
  });

  it('refuses within a minute of the deadline', async () => {
    holdReservation();
    chain.deadline = BigInt(Math.floor(Date.now() / 1000) + 59);
    await refused('TOO_CLOSE_TO_DEADLINE');
  });

  it('refuses a task not assigned through our /accept', async () => {
    holdReservation();
    chain.state = { executorAddress: AGENT.toLowerCase(), resultData: RESULT };
    await refused('NOT_OURS');
  });

  it('refuses evidence other than the result submitted for the task', async () => {
    holdReservation();
    chain.state = { ...chain.state, resultData: { output: 'something else' } };
    await refused('EVIDENCE_MISMATCH');
  });

  it("refuses a call not signed by the agent's wallet", async () => {
    holdReservation();
    await refused('BAD_SIGNATURE', await input({ authorization: auth(), signKey: ethers.Wallet.createRandom().privateKey }));
  });

  it('refuses an authorization for another chain, another contract, or another signer', async () => {
    holdReservation();
    await refused('BAD_AUTHORIZATION', await input({ authorization: auth({ chainId: 0n }) }));
    await refused('BAD_AUTHORIZATION', await input({ authorization: auth({ chainId: 5042n }) }));
    await refused('BAD_AUTHORIZATION', await input({ authorization: auth({ address: '0x' + '11'.repeat(20) }) }));
    await refused('BAD_AUTHORIZATION', await input({ authorization: auth({ key: ethers.Wallet.createRandom().privateKey }) }));
  });

  it('refuses an undelegated wallet with no authorization', async () => {
    holdReservation();
    await refused('NOT_DELEGATED', await input());
  });

  it('allows one setup retry per wallet, then refuses', async () => {
    holdReservation();
    db.txs.push(
      { id: 90, chainId: CHAIN_ID, reservationId: 1, sponsor: SPONSOR, nonce: 1, rawTx: '0x', txHash: '0x1', withAuthorization: true, status: 'noop', costWei: 0n },
      { id: 91, chainId: CHAIN_ID, reservationId: 1, sponsor: SPONSOR, nonce: 2, rawTx: '0x', txHash: '0x2', withAuthorization: true, status: 'noop', costWei: 0n },
    );
    expect(await relayer.relaySponsoredCall(await input({ authorization: auth() }))).toMatchObject({ ok: false, code: 'SETUP_LIMIT' });
    expect(chain.sent).toEqual([]);
  });

  it('refuses a call whose simulation reverts', async () => {
    holdReservation();
    chain.estimateError = Object.assign(new Error('execution reverted'), { data: '0x' });
    await refused('SIMULATION_REVERTED');
  });

  it("treats InvalidNonce on a task already Submitted with this evidence as someone else's landing", async () => {
    const r = holdReservation();
    const iface = new ethers.Interface(['error InvalidNonce(uint256 current)']);
    chain.estimateError = Object.assign(new Error('execution reverted'), { data: iface.encodeErrorResult('InvalidNonce', [1n]) });
    // Read fresh after the revert: the same signed call landed meanwhile.
    chain.taskAfter = { ...chain.task, status: 2, evidenceHash: EVIDENCE };
    expect(await relayer.relaySponsoredCall(await input({ authorization: auth() }))).toEqual({ ok: true, txHash: null, landedElsewhere: true });
    expect(r.status).toBe('used');
    expect(chain.sent).toEqual([]);
  });

  it('refuses an estimate above the gas ceiling, and a base fee above the fee cap', async () => {
    holdReservation();
    chain.estimate = 200_001n;
    await refused('GAS_TOO_HIGH');
    chain.estimate = 120_000n;
    chain.baseFee = 101n * GWEI;
    await refused('FEES_TOO_HIGH');
  });
});

describe('what is checked again at the front of the queue', () => {
  // The first relay's transaction holds the queue until it mines; a second
  // call, for another task, passes its checks meanwhile and waits behind it.
  const NEXT = TASK_ID + 1n;
  async function behindAnother(change: () => void) {
    await writer();
    holdReservation();
    holdReservation({ taskId: NEXT, taskHash: '0x' + '7b'.repeat(32) });
    let release!: () => void;
    const first = relayer.relaySponsoredCall(await input({ authorization: auth() }));
    chain.onBroadcast = (_raw, hash) => {
      const mined = { status: 1, logs: [evidenceLog()], gasUsed: 150_000n, gasPrice: 20n * GWEI };
      chain.code = DESIGNATOR;
      // Mine only when the test says so.
      new Promise<void>((r) => { release = r; }).then(() => chain.mined.set(hash, mined));
    };
    await vi.waitFor(() => expect(chain.sent).toHaveLength(1));
    const second = relayer.relaySponsoredCall(await input({ nonce: 1n, taskId: NEXT }));
    await new Promise((r) => setTimeout(r, 20));
    change();
    release();
    return { first: await first, second: await second };
  }

  it('the kill switch stops a call already waiting', async () => {
    const { second } = await behindAnother(() => { db.controls.killed = true; });
    expect(second).toMatchObject({ ok: false, code: 'GAS_SPONSOR_KILLED' });
    expect(chain.sent).toHaveLength(1);
  });

  it('an export while waiting ends the reservation', async () => {
    const { second } = await behindAnother(() => { db.exported.add(AGENT.toLowerCase()); });
    expect(second).toMatchObject({ ok: false, code: 'GAS_SPONSOR_INELIGIBLE' });
    expect(db.reservations.map((r: Res) => r.status)).toEqual(['used', 'released']);
    expect(chain.sent).toHaveLength(1);
  });

  it('a call that would now revert is not sent', async () => {
    const { second } = await behindAnother(() => {
      chain.estimateError = Object.assign(new Error('execution reverted'), { data: '0x' });
    });
    expect(second).toMatchObject({ ok: false, code: 'SIMULATION_REVERTED' });
    expect(chain.sent).toHaveLength(1);
  });
});

describe('a repeat of a call that queued behind it (delta audit 2026-10-06, gas-4)', () => {
  // A worker whose request timed out (120 s) asks again while its first call
  // still waits in the queue: both pass the entry check, as nothing is
  // recorded for the reservation yet, and both queue.
  const NEXT = TASK_ID + 1n;
  async function twiceBehindAnother(o: { landsAtOnce?: boolean; beforeTheyRun?: () => void } = {}) {
    await writer();
    holdReservation();
    const r = holdReservation({ taskId: NEXT, taskHash: '0x' + '7b'.repeat(32) });
    let mineFirst!: () => void;
    chain.onBroadcast = (_raw, hash) => {
      chain.onBroadcast = null; // only the first send mines, when the test says so
      chain.code = DESIGNATOR;
      new Promise<void>((res) => { mineFirst = res; }).then(() => {
        chain.mined.set(hash, { status: 1, logs: [evidenceLog()], gasUsed: 150_000n, gasPrice: 20n * GWEI });
      });
    };
    const first = relayer.relaySponsoredCall(await input({ authorization: auth() }));
    await vi.waitFor(() => expect(chain.sent).toHaveLength(1));
    relayer._setReceiptTimeout(50);
    // This reservation's call: never mined in these tests, or mined at once.
    if (o.landsAtOnce) {
      chain.onBroadcast = (_raw, hash) => chain.mined.set(hash, { status: 1, logs: [evidenceLog(NEXT)], gasUsed: 150_000n, gasPrice: 20n * GWEI });
    }
    const a = relayer.relaySponsoredCall(await input({ nonce: 1n, taskId: NEXT }));
    const b = relayer.relaySponsoredCall(await input({ nonce: 1n, taskId: NEXT }));
    await new Promise((res) => setTimeout(res, 20));
    o.beforeTheyRun?.();
    mineFirst();
    const out = { first: await first, a: await a, b: await b, reservation: r };
    relayer._setReceiptTimeout(60_000);
    return out;
  }

  it('settles on the transaction already out for the reservation instead of sending a second', async () => {
    const { a, b, reservation } = await twiceBehindAnother();
    expect(chain.sent).toHaveLength(2); // the other task's, and one for this reservation
    const ours = db.txs.filter((t: Tx) => t.reservationId === reservation.id);
    expect(ours).toHaveLength(1);
    expect(a).toMatchObject({ ok: false, code: 'PENDING', txHash: ours[0].txHash });
    expect(b).toMatchObject({ ok: false, code: 'PENDING', txHash: ours[0].txHash });
  });

  it('answers with the landed call once the reservation is used', async () => {
    const { a, b, reservation } = await twiceBehindAnother({ landsAtOnce: true });
    const ours = db.txs.filter((t: Tx) => t.reservationId === reservation.id);
    expect(ours).toHaveLength(1);
    expect(a).toEqual({ ok: true, txHash: ours[0].txHash });
    expect(b).toEqual({ ok: true, txHash: ours[0].txHash });
    expect(chain.sent).toHaveLength(2);
  });

  it('sends nothing for a reservation closed while the call waited', async () => {
    // Handed back, say, or swept.
    const { a, b, reservation } = await twiceBehindAnother({ beforeTheyRun: () => { db.reservations.find((x: Res) => x.taskId === NEXT)!.status = 'released'; } });
    expect(a).toMatchObject({ ok: false, code: 'NO_RESERVATION' });
    expect(b).toMatchObject({ ok: false, code: 'NO_RESERVATION' });
    expect(chain.sent).toHaveLength(1);
    expect(db.txs.filter((t: Tx) => t.reservationId === reservation.id)).toEqual([]);
  });
});

describe('a sponsored releaseUnjudgedWork', () => {
  it('reserves its own budget and sends, once the task is disputed and escalated', async () => {
    await writer();
    chain.task.status = 6;
    chain.onBroadcast = (_raw, hash) => {
      const iface = new ethers.Interface(['event UnjudgedWorkReleased(uint256 indexed taskId, uint256 workerPayout, uint256 platformFee)']);
      const ev = iface.encodeEventLog('UnjudgedWorkReleased', [TASK_ID, 900_000n, 100_000n]);
      chain.mined.set(hash, { status: 1, logs: [{ address: ESCROW, topics: ev.topics, data: ev.data }], gasUsed: 133_599n, gasPrice: 20n * GWEI });
      chain.code = DESIGNATOR;
    };
    expect(await relayer.relaySponsoredCall(await input({ kind: 'release', authorization: auth() }))).toMatchObject({ ok: true });
    expect(db.reservations[0]).toMatchObject({ kind: 'release', status: 'used' });
  });

  it('refuses a task that is not awaiting an unjudged release, or that the poster never escalated', async () => {
    await writer();
    expect(await relayer.relaySponsoredCall(await input({ kind: 'release', authorization: auth() }))).toMatchObject({ ok: false, code: 'NOT_RELEASABLE' });
    chain.task.status = 6; // Disputed, but by a dispute rather than the poster's claimTimeout
    chain.escalated = false;
    expect(await relayer.relaySponsoredCall(await input({ kind: 'release', authorization: auth() }))).toMatchObject({ ok: false, code: 'NOT_RELEASABLE' });
    expect(chain.sent).toEqual([]);
  });

  it('reserves nothing for a call that is refused before sending', async () => {
    await writer();
    chain.task.status = 6;
    await expect(relayer.relaySponsoredCall(await input({ kind: 'release', authorization: auth(), signKey: ethers.Wallet.createRandom().privateKey })))
      .resolves.toMatchObject({ ok: false, code: 'BAD_SIGNATURE' });
    chain.estimateError = Object.assign(new Error('execution reverted'), { data: '0x' });
    await expect(relayer.relaySponsoredCall(await input({ kind: 'release', authorization: auth() })))
      .resolves.toMatchObject({ ok: false, code: 'SIMULATION_REVERTED' });
    expect(db.reservations).toEqual([]);
  });
});

describe('a call that is out (pending blocks fallback)', () => {
  const sendOut = async () => {
    await writer();
    const r = holdReservation();
    chain.broadcastError = new Error('timeout');
    await relayer.relaySponsoredCall(await input({ authorization: auth() }));
    chain.broadcastError = null;
    return r;
  };

  it('is pending while our transaction may still land, even once sponsorship is killed', async () => {
    relayer._setReceiptTimeout(50);
    await sendOut();
    expect(await relayer.sponsoredCallStatus(AGENT, TASK_ID, 'submit')).toEqual({ status: 'pending', txHash: db.txs[0].txHash });
    db.controls.killed = true;
    // A repeat answers with the call already out rather than refusing as killed.
    expect(await relayer.relaySponsoredCall(await input({ authorization: auth() }))).toMatchObject({ ok: false, code: 'PENDING', txHash: db.txs[0].txHash });
    expect(new Set(chain.sent).size).toBe(0);
    relayer._setReceiptTimeout(60_000);
  });

  it('is confirmed once it lands, and failed for good once the task moved on without it', async () => {
    await sendOut();
    chain.mined.set(db.txs[0].txHash, { status: 1, logs: [evidenceLog()], gasUsed: 150_000n, gasPrice: 20n * GWEI });
    chain.code = DESIGNATOR;
    expect(await relayer.sponsoredCallStatus(AGENT, TASK_ID, 'submit')).toEqual({ status: 'confirmed', txHash: db.txs[0].txHash });

    db.reservations.length = 0;
    db.txs.length = 0;
    chain.mined.clear();
    await sendOut();
    chain.taskAfter = { ...chain.task, status: 5 }; // the poster reclaimed it
    expect(await relayer.sponsoredCallStatus(AGENT, TASK_ID, 'submit')).toMatchObject({ status: 'failed', reason: 'task_moved' });
  });

  it('counts the same call landed by someone else as confirmed', async () => {
    await sendOut();
    chain.taskAfter = { ...chain.task, status: 2, evidenceHash: EVIDENCE };
    expect(await relayer.sponsoredCallStatus(AGENT, TASK_ID, 'submit')).toEqual({ status: 'confirmed', txHash: null });
    expect(db.reservations[0].status).toBe('used');
  });

  it('is none for another agent, or before anything was sent', async () => {
    await sendOut();
    expect(await relayer.sponsoredCallStatus('0x' + '12'.repeat(20), TASK_ID, 'submit')).toEqual({ status: 'none' });
    expect(await relayer.sponsoredCallStatus(AGENT, TASK_ID, 'release')).toEqual({ status: 'none' });
  });

  it('counts our reverted transaction as success when the same call landed first (a lost race)', async () => {
    await writer();
    const r = holdReservation();
    chain.onBroadcast = (_raw, hash) => {
      chain.mined.set(hash, { status: 0, logs: [], gasUsed: 40_000n, gasPrice: 20n * GWEI });
      chain.taskAfter = { ...chain.task, status: 2, evidenceHash: EVIDENCE };
    };
    expect(await relayer.relaySponsoredCall(await input({ authorization: auth() }))).toEqual({ ok: true, txHash: null, landedElsewhere: true });
    expect(r.status).toBe('used');
    expect(r.costWei).toBe(40_000n * 20n * GWEI); // our revert still costs, and counts
  });
});

describe('a first broadcast the node refuses', () => {
  it('"nonce too low" on fresh bytes means the key signs elsewhere: kill, and nothing is pending', async () => {
    await writer();
    holdReservation();
    chain.broadcastError = Object.assign(new Error('nonce too low'), { code: 'NONCE_EXPIRED' });
    expect(await relayer.relaySponsoredCall(await input({ authorization: auth() }))).toMatchObject({ ok: false, code: 'NOT_SENT' });
    expect(db.txs[0].status).toBe('dropped');
    expect(db.controls.killed).toBe(true);
  });

  it('an error it does not recognise keeps the bytes and answers pending, without a pause (delta audit 2026-10-06, ops-2)', async () => {
    await writer();
    holdReservation();
    chain.broadcastError = Object.assign(new Error('could not coalesce error'), { code: 'UNKNOWN_ERROR' });
    expect(await relayer.relaySponsoredCall(await input({ authorization: auth() }))).toMatchObject({ ok: false, code: 'PENDING' });
    expect(db.txs[0].status).toBe('signed');
    expect(db.controls).toMatchObject({ paused: false, killed: false });
  });

  it('an outright rejection pauses, and the call is final', async () => {
    await writer();
    holdReservation();
    chain.broadcastError = Object.assign(new Error('insufficient funds for gas * price + value'), { code: 'INSUFFICIENT_FUNDS' });
    expect(await relayer.relaySponsoredCall(await input({ authorization: auth() }))).toMatchObject({ ok: false, code: 'NOT_SENT' });
    expect(db.txs[0].status).toBe('rejected');
    expect(db.controls).toMatchObject({ paused: true, killed: false });
    expect(await relayer.sponsoredCallStatus(AGENT, TASK_ID, 'submit')).toMatchObject({ status: 'failed', reason: 'rejected' });
  });
});

describe('classifyBroadcastError', () => {
  it.each([
    [new Error('already known'), 'known'],
    [Object.assign(new Error('x'), { code: 'NONCE_EXPIRED' }), 'nonce_low'],
    [new Error('nonce too low: next nonce 9, tx nonce 3'), 'nonce_low'],
    [new Error('replacement transaction underpriced'), 'transient'],
    [new Error('max fee per gas less than block base fee'), 'transient'],
    [Object.assign(new Error('request timeout'), { code: 'TIMEOUT' }), 'transient'],
    [new TypeError('fetch failed'), 'transient'],
    [Object.assign(new Error('insufficient funds'), { code: 'INSUFFICIENT_FUNDS' }), 'rejected'],
    [new Error('invalid sender'), 'rejected'],
    [new Error('intrinsic gas too low'), 'rejected'],
    [new Error('max priority fee per gas higher than max fee per gas'), 'rejected'],
    // Unrecognised: maybe in a pool, so the stored bytes are kept and re-sent (delta audit 2026-10-06, ops-2).
    [Object.assign(new Error('could not coalesce error'), { code: 'UNKNOWN_ERROR' }), 'transient'],
    [new Error('internal error'), 'transient'],
  ])('%s → %s', (err, kind) => {
    expect(relayer.classifyBroadcastError(err)).toBe(kind);
  });
});

describe('recovery', () => {
  it('re-broadcasts the stored bytes and never signs again', async () => {
    await writer();
    holdReservation();
    chain.broadcastError = new Error('timeout');
    await relayer.relaySponsoredCall(await input({ authorization: auth() }));
    const stored = db.txs[0].rawTx;
    chain.broadcastError = null;
    chain.onBroadcast = null;
    const signTx = vi.spyOn(ethers.Wallet.prototype, 'signTransaction');
    await relayer.recoverSponsorTxs(settings.current);
    expect(signTx).not.toHaveBeenCalled();
    expect(chain.sent).toEqual([stored]);
    expect(db.txs[0].status).toBe('sent');
  });

  it('runs on every writer tick, not only when the lock is first taken', async () => {
    holdReservation();
    chain.broadcastError = new Error('timeout');
    await writer();
    await relayer.relaySponsoredCall(await input({ authorization: auth() }));
    chain.broadcastError = null;
    chain.onBroadcast = null;
    await relayer.gasSponsorTick(); // already the writer
    await relayer.gasSponsorTick();
    expect(chain.sent).toHaveLength(2);
    expect(new Set(chain.sent).size).toBe(1);
  });

  it('settles a stored transaction that did land', async () => {
    await writer();
    const r = holdReservation();
    chain.broadcastError = new Error('timeout');
    await relayer.relaySponsoredCall(await input({ authorization: auth() }));
    chain.mined.set(db.txs[0].txHash, { status: 1, logs: [evidenceLog()], gasUsed: 150_000n, gasPrice: 20n * GWEI });
    chain.code = DESIGNATOR;
    await relayer.recoverSponsorTxs(settings.current);
    expect(db.txs[0].status).toBe('confirmed');
    expect(r.status).toBe('used');
  });

  it('kills sponsorship when a stored nonce went to a transaction that is not ours, and sends nothing', async () => {
    await writer();
    holdReservation();
    chain.broadcastError = new Error('timeout');
    await relayer.relaySponsoredCall(await input({ authorization: auth() }));
    chain.broadcastError = null;
    chain.latestNonce = 9;
    const t0 = Date.now();
    await relayer.recoverSponsorTxs(settings.current, t0);
    // One look is not enough: a lagging replica may not have our transaction yet.
    expect(db.txs[0].status).toBe('signed');
    expect(db.controls.killed).toBe(false);
    await relayer.recoverSponsorTxs(settings.current, t0 + 30_000);
    expect(db.txs[0].status).toBe('dropped');
    expect(db.controls).toMatchObject({ killed: true });
    expect(db.setControlsCalls.at(-1).reason).toMatch(new RegExp(`nonce 3 was used by a transaction that is not ${db.txs[0].txHash}`));
    expect(chain.sent).toEqual([]);
  });

  it('leaves a passed nonce alone when our transaction did land there', async () => {
    await writer();
    holdReservation();
    chain.broadcastError = new Error('timeout');
    await relayer.relaySponsoredCall(await input({ authorization: auth() }));
    chain.latestNonce = 9;
    chain.knownTx.add(db.txs[0].txHash);
    await relayer.recoverSponsorTxs(settings.current, Date.now());
    await relayer.recoverSponsorTxs(settings.current, Date.now() + 60_000);
    expect(db.txs[0].status).toBe('signed');
    expect(db.controls.killed).toBe(false);
  });

  it('pauses, and alerts with the nonce and hash, when a stored transaction has not landed in time', async () => {
    await writer();
    holdReservation();
    chain.broadcastError = new Error('timeout');
    await relayer.relaySponsoredCall(await input({ authorization: auth() }));
    chain.broadcastError = null;
    chain.onBroadcast = null; // accepted, never mined
    await relayer.recoverSponsorTxs(settings.current, Date.now() + 9 * 60_000);
    expect(db.controls.paused).toBe(false);
    await relayer.recoverSponsorTxs(settings.current, Date.now() + 10 * 60_000 + 1);
    expect(db.controls.paused).toBe(true);
    expect(db.setControlsCalls.at(-1).reason).toMatch(new RegExp(`${db.txs[0].txHash} \\(nonce 3\\) has not landed in 10 minutes`));
    const report = await relayer.gasSponsorReport();
    expect(report).toMatchObject({ lastTrip: { action: 'paused', nonce: 3, txHash: db.txs[0].txHash }, oldestPendingTx: { nonce: 3, txHash: db.txs[0].txHash } });
    expect(chain.sent).toHaveLength(2); // the same bytes, twice
    expect(new Set(chain.sent).size).toBe(1);
  });

  it('pauses on a non-transient rejection, and frees the nonce', async () => {
    await writer();
    holdReservation();
    chain.broadcastError = new Error('timeout');
    await relayer.relaySponsoredCall(await input({ authorization: auth() }));
    chain.broadcastError = Object.assign(new Error('invalid sender'), { code: 'UNKNOWN_ERROR' });
    await relayer.recoverSponsorTxs(settings.current);
    expect(db.txs[0].status).toBe('rejected');
    expect(db.controls).toMatchObject({ paused: true, killed: false });
  });

  it('skips a transaction it cannot read this tick, and never counts a failed read as "not found" (delta audit 2026-10-06, ops-2)', async () => {
    await writer();
    holdReservation();
    chain.broadcastError = new Error('timeout');
    await relayer.relaySponsoredCall(await input({ authorization: auth() }));
    chain.broadcastError = null;
    chain.latestNonce = 9; // the chain is past our nonce
    chain.txReadError = Object.assign(new Error('server response 503'), { code: 'SERVER_ERROR' });
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) await relayer.recoverSponsorTxs(settings.current, t0 + i * 30_000);
    expect(db.txs[0].status).toBe('signed');
    expect(db.controls.killed).toBe(false);
    // Reads answer again: two answers of "not found", far enough apart, are still needed.
    chain.txReadError = null;
    await relayer.recoverSponsorTxs(settings.current, t0 + 90_000);
    expect(db.controls.killed).toBe(false);
    await relayer.recoverSponsorTxs(settings.current, t0 + 120_000);
    expect(db.txs[0].status).toBe('dropped');
    expect(db.controls.killed).toBe(true);
  });

  it('reads "nonce too low" at a nonce the chain has not passed as our own pooled transaction, not a lost one', async () => {
    await writer();
    holdReservation();
    chain.broadcastError = new Error('timeout');
    await relayer.relaySponsoredCall(await input({ authorization: auth() }));
    // Hardhat, automining, answers a re-send of a pooled transaction this way.
    chain.broadcastError = Object.assign(new Error('Nonce too low. Expected nonce to be 4 but got 3.'), { code: 'NONCE_EXPIRED' });
    const t0 = Date.now();
    await relayer.recoverSponsorTxs(settings.current, t0);
    await relayer.recoverSponsorTxs(settings.current, t0 + 30_000);
    expect(db.txs[0].status).toBe('sent');
    expect(db.controls.killed).toBe(false);
  });
});

describe('the reservation sweep', () => {
  it('expires a reservation held an hour after assignment without a submit, as a strike', async () => {
    await writer();
    const r = holdReservation({ expiresAt: new Date(Date.now() - 1) });
    await relayer.sweepReservations(settings.current);
    expect(r.status).toBe('expired');
    expect(db.strikes).toEqual([r.id]);
  });

  it('releases one whose task left Assigned (a direct submit), or went to another executor', async () => {
    const a = holdReservation();
    chain.task.status = 2;
    await relayer.sweepReservations(settings.current);
    expect(a.status).toBe('released');
    chain.task.status = 1;
    const b = holdReservation({ taskId: 42n });
    chain.state = { executorAddress: '0x' + '97'.repeat(20) };
    await relayer.sweepReservations(settings.current);
    expect(b.status).toBe('released');
    expect(db.strikes).toEqual([]);
  });

  it('releases without a strike an hour lost to our side: sponsorship killed, or a transaction of ours that failed', async () => {
    const a = holdReservation({ expiresAt: new Date(Date.now() - 1) });
    db.controls.killed = true;
    await relayer.sweepReservations(settings.current);
    expect(a.status).toBe('released');
    db.controls.killed = false;
    const b = holdReservation({ taskId: 42n, expiresAt: new Date(Date.now() - 1) });
    db.txs.push({ id: 7, chainId: CHAIN_ID, reservationId: b.id, sponsor: SPONSOR, nonce: 3, rawTx: '0x', txHash: '0xfailed', withAuthorization: false, status: 'reverted' });
    await relayer.sweepReservations(settings.current);
    expect(b.status).toBe('released');
    expect(db.strikes).toEqual([]);
  });

  it('keeps a reservation past its hour while our transaction for it is still out', async () => {
    const r = holdReservation({ expiresAt: new Date(Date.now() - 1) });
    db.txs.push({ id: 8, chainId: CHAIN_ID, reservationId: r.id, sponsor: SPONSOR, nonce: 3, rawTx: '0x', txHash: '0xout', withAuthorization: false, status: 'sent' });
    await relayer.sweepReservations(settings.current);
    expect(r.status).toBe('reserved');
    expect(db.strikes).toEqual([]);
  });

  it('leaves a reservation within its hour alone', async () => {
    const r = holdReservation();
    await relayer.sweepReservations(settings.current);
    expect(r.status).toBe('reserved');
  });
});

describe('what /health/bridge and a relay reply repeat of an RPC failure (delta audit 2026-10-06, gas-2)', () => {
  const rpcError = (code: string, short: string) => Object.assign(
    new Error(`${short} (request={ }, response={ }, error=null, info={ "requestUrl": "https://arc.example/v2/SECRET-KEY" }, code=${code}, version=6.13.1)`),
    { shortMessage: short, code },
  );
  const leaks = (v: unknown) => /SECRET-KEY|requestUrl|https?:/.test(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));

  it('a report that fails says why without the request', async () => {
    const usage = (await import('./gasSponsorStore.js')).usage as unknown as ReturnType<typeof vi.fn>;
    usage.mockRejectedValueOnce(rpcError('SERVER_ERROR', 'server response 503 Service Unavailable'));
    const report = await relayer.gasSponsorReport();
    expect(report).toMatchObject({ enabled: false, reason: 'status unavailable: server response 503 Service Unavailable [SERVER_ERROR]' });
    expect(leaks(report)).toBe(false);
  });

  it('a breaker trip on a rejected broadcast keeps the request out of the reason it shows', async () => {
    await writer();
    holdReservation();
    chain.broadcastError = rpcError('INSUFFICIENT_FUNDS', 'insufficient funds for intrinsic transaction cost');
    expect(await relayer.relaySponsoredCall(await input({ authorization: auth() }))).toMatchObject({ ok: false, code: 'NOT_SENT' });
    const report = await relayer.gasSponsorReport();
    expect(report.lastTrip?.reason).toMatch(/insufficient funds for intrinsic transaction cost \[INSUFFICIENT_FUNDS\]$/);
    expect(db.setControlsCalls.at(-1).reason).toMatch(/insufficient funds/);
    expect(leaks(report)).toBe(false);
    expect(leaks(db.setControlsCalls)).toBe(false);
  });

  it('a call that could not be prepared says why without the request', async () => {
    await writer();
    holdReservation();
    provider.getTransactionCount.mockRejectedValueOnce(rpcError('TIMEOUT', 'request timeout'));
    const result = await relayer.relaySponsoredCall(await input({ authorization: auth() }));
    expect(result).toMatchObject({ ok: false, code: 'NOT_SENT', message: 'Not sent: request timeout [TIMEOUT]' });
  });
});

describe('automatic pause', () => {
  it('pauses when sends fail too often, the hour overspent, or the sponsor holds less than a day of budget', async () => {
    db.usage.failuresLastHour = 5;
    expect(await relayer.maybeAutoPause(settings.current)).toMatch(/5 sponsored sends failed/);
    expect(db.setControlsCalls[0]).toMatchObject({ change: { paused: true }, by: 'auto' });

    db.controls = { paused: false, killed: false };
    db.usage.failuresLastHour = 0;
    db.usage.spentLastHourWei = 10n ** 17n + 1n;
    expect(await relayer.maybeAutoPause(settings.current)).toMatch(/spent more than its budget/);

    db.controls = { paused: false, killed: false };
    db.usage.spentLastHourWei = 0n;
    chain.balance = 10n ** 18n - 1n;
    expect(await relayer.maybeAutoPause(settings.current)).toMatch(/less than one day of budget/);
  });

  it('does nothing when healthy, or already paused', async () => {
    expect(await relayer.maybeAutoPause(settings.current)).toBeNull();
    db.controls = { paused: true, killed: false };
    db.usage.failuresLastHour = 50;
    expect(await relayer.maybeAutoPause(settings.current)).toBeNull();
    expect(db.setControlsCalls).toEqual([]);
  });
});
