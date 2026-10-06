import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { readFileSync } from 'fs';

/**
 * A task handed back while the escrow still names its agent (delta audit
 * 2026-10-06, gas-1), end to end on a real Postgres: /release's hand-back
 * (gasSponsorAccept.markHandedBack), the store's SQL, the reservation sweep
 * and the relay. The chain, the escrow reads and the A2A state are fakes.
 * Runs when TEST_DATABASE_URL names a disposable database, like
 * gasSponsorStore.test.ts; skipped otherwise.
 */

const url = process.env.TEST_DATABASE_URL ?? '';

const agentKey = ethers.Wallet.createRandom().privateKey;
const AGENT = new ethers.Wallet(agentKey).address;
const ESCROW = ethers.getAddress('0x' + 'e5'.repeat(20));
const DELEGATE = ethers.getAddress('0x' + 'de'.repeat(20));
const CHAIN_ID = 5042002;
const TASK_ID = 41n;
const TASK_HASH = '0x' + '7a'.repeat(32);
const RESULT = { output: 'the work' };
const EVIDENCE = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(RESULT)));
const GWEI = 10n ** 9n;
const DESIGNATOR = `0xef0100${DELEGATE.slice(2).toLowerCase()}`;
const caps = { perAgentDaily: 10, perUserDaily: 20, perPosterDaily: 10, hourlyBudgetWei: 10n ** 17n, dailyBudgetWei: 10n ** 18n, maxStrikes: 3 };

const cfg = vi.hoisted(() => ({ databaseUrl: '' }));
vi.mock('../config.js', () => ({ config: cfg }));
const pool = vi.hoisted(() => ({ current: null as import('pg').Pool | null }));
vi.mock('./neonDb.js', () => ({ getPool: async () => pool.current }));
const settings = vi.hoisted(() => ({ current: null as any }));
vi.mock('./gasSponsorConfig.js', async (orig) => ({
  ...(await orig<typeof import('./gasSponsorConfig.js')>()),
  runnableSettings: async () => ({ ok: true, settings: settings.current }),
  gasSponsorSettings: () => settings.current,
}));
vi.mock('./gasSponsorEligibility.js', () => ({
  agentEligibility: vi.fn(async () => ({ ok: true, ownerDid: 'did:privy:owner' })),
  taskEligibility: vi.fn(async () => ({ ok: true })),
}));

const chain = vi.hoisted(() => ({ task: null as any, code: '0x', mined: new Map<string, any>() }));
const ESCROW_IFACE = new ethers.Interface(JSON.parse(readFileSync(new URL('../abi/BlindEscrow.json', import.meta.url), 'utf-8')));
const ESCROW_EVENTS = new ethers.Interface(['event EvidenceSubmitted(uint256 indexed taskId, address indexed worker, bytes32 evidenceHash, uint8 attempt)']);
const provider = {
  send: vi.fn(async (method: string, params: any[]) => {
    if (method === 'eth_getCode') return chain.code;
    if (method === 'eth_estimateGas') return ethers.toQuantity(120_000n);
    if (method === 'eth_getTransactionCount') return '0x0';
    if (method === 'eth_sendRawTransaction') {
      const hash = ethers.keccak256(params[0]);
      const ev = ESCROW_EVENTS.encodeEventLog('EvidenceSubmitted', [TASK_ID, AGENT, EVIDENCE, 1]);
      chain.mined.set(hash, { blockNumber: 9, status: 1, gasUsed: 150_000n, gasPrice: 20n * GWEI, logs: [{ address: ESCROW, topics: ev.topics, data: ev.data }] });
      chain.code = DESIGNATOR;
      return hash;
    }
    throw new Error(`unexpected ${method}`);
  }),
  getFeeData: vi.fn(async () => ({ maxFeePerGas: 40n * GWEI, maxPriorityFeePerGas: 0n, gasPrice: 20n * GWEI })),
  getBlock: vi.fn(async () => ({ baseFeePerGas: 20n * GWEI })),
  getTransactionCount: vi.fn(async () => 0),
  getTransactionReceipt: vi.fn(async (hash: string) => chain.mined.get(hash) ?? null),
  getBalance: vi.fn(async () => 10n ** 19n),
};
vi.mock('./chainRuntime.js', () => ({ chainRuntime: () => ({ provider, escrow: { interface: ESCROW_IFACE } }) }));
vi.mock('./escrow.js', () => ({ getTaskOn: vi.fn(async () => chain.task), effectiveDeadlineOn: vi.fn(async () => null) }));
vi.mock('./a2aStore.js', () => ({
  getState: vi.fn(async () => ({ executorAddress: AGENT.toLowerCase(), assignTxHash: '0xassign', resultData: RESULT })),
}));
vi.mock('./taskChain.js', () => ({ resolveTaskByHash: vi.fn(async () => ({ taskId: String(TASK_ID), chain: 'arc' })) }));
vi.mock('./deployedAgentStore.js', () => ({ loadAgentByWallet: vi.fn(async () => null) }));
vi.mock('./analyticsService.js', () => ({ recordEvent: vi.fn(async () => {}) }));
vi.mock('@sentry/node', () => ({ captureMessage: vi.fn() }));

const { migrationSql } = await vi.importActual<typeof import('./neonDb.js')>('./neonDb.js');
const store = await import('./gasSponsorStore.js');
const relayer = await import('./gasSponsorRelayer.js');
const { markHandedBack } = await import('./gasSponsorAccept.js');
const { CALL_TYPES, callDomain, DelegateKind } = await import('./blindAgentDelegate.js');
const { signAuthorization } = await import('./eip7702.js');

async function holdSubmit() {
  const out = await store.reserve(
    { chainId: CHAIN_ID, taskId: TASK_ID, kind: 'submit', taskHash: TASK_HASH, agentWallet: AGENT, ownerDid: 'did:privy:owner', poster: '0x' + 'b0'.repeat(20), budgetWei: 10n ** 16n, ttlSeconds: 3600 },
    caps,
  );
  if (!out.ok) throw new Error(out.refusal);
  return out.reservation;
}
const pastItsHour = (id: number) => pool.current!.query(`UPDATE gas_sponsor_reservations SET expires_at = NOW() - interval '1 second' WHERE id = $1`, [id]);

describe.skipIf(!url)('a task handed back while the escrow names the agent, on Postgres (delta audit 2026-10-06, gas-1)', () => {
  beforeAll(async () => {
    const pg = (await import('pg')).default;
    pool.current = new pg.Pool({ connectionString: url, ssl: /[?&]sslmode=disable\b/.test(url) ? false : { rejectUnauthorized: false } });
    await pool.current.query(migrationSql(43)!);
    await pool.current.query(migrationSql(44)!);
  });
  afterAll(async () => {
    await relayer._resetGasSponsorRelayer();
    await pool.current?.end();
  });
  beforeEach(async () => {
    cfg.databaseUrl = url;
    await relayer._resetGasSponsorRelayer();
    await pool.current!.query('TRUNCATE gas_sponsor_txs, gas_sponsor_strikes, gas_sponsor_reservations, agent_key_exports, gas_sponsor_controls RESTART IDENTITY CASCADE');
    settings.current = {
      enabled: true, chain: { key: 'arc', chainId: CHAIN_ID }, chainId: CHAIN_ID, escrow: ESCROW, delegate: DELEGATE,
      sponsor: ethers.Wallet.createRandom(), maxGas: 200_000n, maxFeeWei: 100n * GWEI, minTaskRaw: 100_000n, caps, maxFailuresPerHour: 5, stuckMs: 600_000,
    };
    chain.task = { agent: '0x' + 'b0'.repeat(20), worker: AGENT, token: '0x' + '36'.repeat(20), amount: 1_000_000n, taskHash: TASK_HASH,
      evidenceHash: ethers.ZeroHash, status: 1, createdAt: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 86_400), submissionAttempts: 0 };
    chain.code = '0x';
    chain.mined.clear();
  });

  it('the attack: a pinned task whose brief the agent cannot decrypt is handed back, and its hour ends released with no strike', async () => {
    const r = await holdSubmit();
    await markHandedBack(TASK_HASH, AGENT); // /release answered ON_CHAIN_LOCKED
    expect(await store.getReservationById(r.id)).toMatchObject({ status: 'reserved', returnedAt: expect.any(Date) });
    await pastItsHour(r.id);
    await relayer.sweepReservations(settings.current);
    expect((await store.getReservationById(r.id))?.status).toBe('released');
    expect(await store.strikeCounts(CHAIN_ID, AGENT, 'did:privy:owner')).toEqual({ agent: 0, owner: 0 });
  });

  it('a passing failure: the resume after the hand-back is still sponsored, on the same reservation', async () => {
    expect(await relayer.acquireSponsorWriter(settings.current)).toBe(true);
    const r = await holdSubmit();
    await markHandedBack(TASK_HASH, AGENT);
    const call = { kind: DelegateKind.SubmitEvidence, taskId: TASK_ID, evidenceHash: EVIDENCE, nonce: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) };
    const signer = new ethers.Wallet(agentKey);
    const signature = await signer.signTypedData(callDomain(CHAIN_ID, AGENT), CALL_TYPES, { ...call, escrow: ESCROW });
    const authorization = signAuthorization(new ethers.SigningKey(agentKey), { chainId: BigInt(CHAIN_ID), address: DELEGATE, nonce: 0n });
    const result = await relayer.relaySponsoredCall({
      agent: { walletAddress: AGENT } as any, kind: 'submit', taskId: TASK_ID, evidenceHash: EVIDENCE, nonce: call.nonce, deadline: call.deadline, signature, authorization,
    });
    expect(result).toMatchObject({ ok: true });
    const [tx] = await store.txsForReservation(r.id);
    expect(tx).toMatchObject({ status: 'confirmed' });
    expect(await store.getReservationById(r.id)).toMatchObject({ status: 'used', txHash: tx.txHash });
    const { rows } = await pool.current!.query('SELECT COUNT(*)::int AS n FROM gas_sponsor_reservations');
    expect(rows[0].n).toBe(1);
  });

  it('an idle holder that never hands back is still struck', async () => {
    const r = await holdSubmit();
    await pastItsHour(r.id);
    await relayer.sweepReservations(settings.current);
    expect((await store.getReservationById(r.id))?.status).toBe('expired');
    expect(await store.strikeCounts(CHAIN_ID, AGENT, 'did:privy:owner')).toEqual({ agent: 1, owner: 1 });
  });
});
