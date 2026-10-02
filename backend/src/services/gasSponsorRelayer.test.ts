import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';

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
    const row = { id: db.txs.length + 1, ...tx, status: 'signed' };
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
  setupAttempts: vi.fn(async () => db.txs.filter((t: Tx) => t.withAuthorization && t.status !== 'dropped').length),
  unsettledTxs: vi.fn(async () => db.txs.filter((t: Tx) => t.status === 'signed' || t.status === 'sent')),
  txsForReservation: vi.fn(async (id: number) => db.txs.filter((t: Tx) => t.reservationId === id)),
  usage: vi.fn(async () => db.usage),
  walletKeyExported: vi.fn(async (w: string) => db.exported.has(w.toLowerCase())),
}));

const chain = vi.hoisted(() => ({
  task: null as any, deadline: null as bigint | null, state: null as any,
  code: '0x', estimate: 120_000n, estimateError: null as any, baseFee: 20n * 10n ** 9n,
  sponsorNonce: 0, latestNonce: 0, mined: new Map<string, { status: number; logs: any[]; gasUsed: bigint; gasPrice: bigint }>(),
  sent: [] as string[], broadcastError: null as any, balance: 10n ** 19n, knownTx: new Set<string>(),
  onBroadcast: null as null | ((raw: string, hash: string) => void),
}));
const provider = {
  getCode: vi.fn(async () => chain.code),
  send: vi.fn(async (method: string, params: any[]) => {
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
  getTransactionReceipt: vi.fn(async (hash: string) => chain.mined.get(hash) ?? null),
  getTransaction: vi.fn(async (hash: string) => (chain.knownTx.has(hash) ? { hash, blockNumber: 9 } : null)),
  getBalance: vi.fn(async () => chain.balance),
};
vi.mock('./chainRuntime.js', () => ({ chainRuntime: () => ({ provider }) }));
vi.mock('./escrow.js', () => ({
  getTaskOn: vi.fn(async () => chain.task),
  effectiveDeadlineOn: vi.fn(async () => chain.deadline),
}));
vi.mock('./a2aStore.js', () => ({ getState: vi.fn(async () => chain.state) }));
const lock = vi.hoisted(() => ({ held: false }));
vi.mock('./neonDb.js', () => ({
  getPool: async () => ({
    connect: async () => ({
      query: async (sql: string) => {
        if (/pg_try_advisory_lock/.test(sql)) {
          const got = !lock.held;
          lock.held = true;
          return { rows: [{ locked: got }] };
        }
        if (/pg_advisory_unlock/.test(sql)) lock.held = false;
        return { rows: [] };
      },
      release: () => {},
      on: () => {},
    }),
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
    maxFailuresPerHour: 5,
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
    deadline: null, state: { executorAddress: AGENT.toLowerCase(), assignTxHash: '0xassign', resultData: RESULT },
    code: '0x', estimate: 120_000n, estimateError: null, baseFee: 20n * GWEI, sponsorNonce: 3, latestNonce: 3, sent: [], broadcastError: null,
    balance: 10n ** 19n, onBroadcast: null,
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

  it('keeps the signed bytes when the broadcast fails', async () => {
    await writer();
    holdReservation();
    chain.broadcastError = new Error('timeout');
    expect(await relayer.relaySponsoredCall(await input({ authorization: auth() }))).toMatchObject({ ok: false, code: 'BROADCAST_FAILED' });
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
    const getTask = (await import('./escrow.js')).getTaskOn as any;
    getTask.mockImplementationOnce(async () => chain.task).mockImplementationOnce(async () => ({ ...chain.task, status: 2, evidenceHash: EVIDENCE }));
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

  it('refuses a task that is not awaiting an unjudged release', async () => {
    await writer();
    expect(await relayer.relaySponsoredCall(await input({ kind: 'release', authorization: auth() }))).toMatchObject({ ok: false, code: 'NOT_RELEASABLE' });
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

  it('marks one whose nonce went to another transaction as dropped, and sends nothing', async () => {
    await writer();
    holdReservation();
    chain.broadcastError = new Error('timeout');
    await relayer.relaySponsoredCall(await input({ authorization: auth() }));
    chain.broadcastError = null;
    chain.latestNonce = 9;
    await relayer.recoverSponsorTxs(settings.current);
    expect(db.txs[0].status).toBe('dropped');
    expect(chain.sent).toEqual([]);
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

  it('leaves a reservation within its hour alone', async () => {
    const r = holdReservation();
    await relayer.sweepReservations(settings.current);
    expect(r.status).toBe('reserved');
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
