import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sponsored-gas store (gasSponsorStore.ts) on a real Postgres: the caps
 * are SQL under an advisory lock, which a fake pool can't check. Runs when
 * TEST_DATABASE_URL names a disposable database (it creates the tables of
 * migration 43 and empties them); skipped otherwise — CI has no Postgres.
 *
 *   docker run -d --name gas-store-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55452:5432 postgres:16
 *   TEST_DATABASE_URL='postgres://postgres:pw@127.0.0.1:55452/postgres?sslmode=disable' npx vitest run src/services/gasSponsorStore.test.ts
 */

const url = process.env.TEST_DATABASE_URL ?? '';
const cfg = vi.hoisted(() => ({ databaseUrl: '' }));
vi.mock('../config.js', () => ({ config: cfg }));
const pool = vi.hoisted(() => ({ current: null as import('pg').Pool | null }));
vi.mock('./neonDb.js', () => ({ getPool: async () => pool.current }));

const { migrationSql } = await vi.importActual<typeof import('./neonDb.js')>('./neonDb.js');
const store = await import('./gasSponsorStore.js');

const CHAIN = 5042002;
const E = 10n ** 18n;
const caps = {
  perAgentDaily: 3,
  perUserDaily: 4,
  perPosterDaily: 5,
  hourlyBudgetWei: E / 10n, // 0.1
  dailyBudgetWei: E / 4n, // 0.25
  maxStrikes: 2,
};
const budget = E / 100n; // 0.01
let seq = 0;
const input = (o: Partial<Parameters<typeof store.reserve>[0]> = {}) => ({
  chainId: CHAIN,
  taskId: BigInt(++seq),
  kind: 'submit' as const,
  taskHash: '0x' + seq.toString(16).padStart(64, '0'),
  agentWallet: `0xa${seq.toString(16).padStart(39, '0')}`,
  ownerDid: `did:privy:user${seq}`,
  poster: `0xb${seq.toString(16).padStart(39, '0')}`,
  budgetWei: budget,
  ttlSeconds: 3600,
  ...o,
});

describe('gasSponsorStore without Postgres', () => {
  it('refuses to run on anything else', async () => {
    cfg.databaseUrl = '';
    await expect(store.reserve(input(), caps)).rejects.toBeInstanceOf(store.GasSponsorStoreUnavailable);
    await expect(store.walletKeyExported('0x' + '1'.repeat(40))).rejects.toBeInstanceOf(store.GasSponsorStoreUnavailable);
  });
});

describe.skipIf(!url)('gasSponsorStore on Postgres', () => {
  beforeAll(async () => {
    const pg = (await import('pg')).default;
    pool.current = new pg.Pool({ connectionString: url, ssl: /[?&]sslmode=disable\b/.test(url) ? false : { rejectUnauthorized: false } });
    await pool.current.query(migrationSql(43)!);
  });
  afterAll(async () => {
    await pool.current?.end();
  });
  beforeEach(async () => {
    cfg.databaseUrl = url;
    await pool.current!.query('TRUNCATE gas_sponsor_txs, gas_sponsor_strikes, gas_sponsor_reservations, agent_key_exports, gas_sponsor_controls RESTART IDENTITY CASCADE');
  });

  const reserveOk = async (o: Partial<Parameters<typeof store.reserve>[0]> = {}) => {
    const out = await store.reserve(input(o), caps);
    if (!out.ok) throw new Error(`refused: ${out.refusal}`);
    return out.reservation;
  };

  it('reserves once per task and kind, and hands the holder its own reservation back', async () => {
    const r = await reserveOk({ taskId: 7n, agentWallet: '0x' + '1'.repeat(40) });
    expect(r).toMatchObject({ status: 'reserved', kind: 'submit', taskId: 7n, budgetWei: budget });
    expect(r.expiresAt.getTime() - Date.now()).toBeGreaterThan(3_500_000);
    const again = await store.reserve(input({ taskId: 7n, agentWallet: '0x' + '1'.repeat(40) }), caps);
    expect(again).toMatchObject({ ok: true, existing: true, reservation: { id: r.id } });
    expect(await store.reserve(input({ taskId: 7n }), caps)).toEqual({ ok: false, refusal: 'taken' });
    // A release is its own kind.
    expect((await store.reserve(input({ taskId: 7n, kind: 'release' }), caps)).ok).toBe(true);
  });

  it('lets another agent take a task whose reservation was given back before anything was sent', async () => {
    const r = await reserveOk({ taskId: 8n });
    await store.closeReservation(r.id, 'released');
    const other = await reserveOk({ taskId: 8n, agentWallet: '0x' + '2'.repeat(40) });
    expect(other.id).toBe(r.id);
    expect(other.agentWallet).toBe('0x' + '2'.repeat(40));
    // Not one that expired (a strike) or was used.
    await store.closeReservation(other.id, 'expired');
    expect(await store.reserve(input({ taskId: 8n }), caps)).toEqual({ ok: false, refusal: 'taken' });
  });

  it('holds one reservation per agent at a time', async () => {
    const wallet = '0x' + '3'.repeat(40);
    const r = await reserveOk({ agentWallet: wallet });
    expect(await store.reserve(input({ agentWallet: wallet }), caps)).toEqual({ ok: false, refusal: 'agent_held' });
    await store.markReservationUsed(r.id, '0x' + 'ab'.repeat(32));
    expect((await store.reserve(input({ agentWallet: wallet }), caps)).ok).toBe(true);
  });

  it('caps sponsored tasks per agent, per Privy user and per poster in 24 hours', async () => {
    const wallet = '0x' + '4'.repeat(40);
    for (let i = 0; i < caps.perAgentDaily; i++) {
      const r = await reserveOk({ agentWallet: wallet });
      await store.markReservationUsed(r.id, null);
    }
    expect(await store.reserve(input({ agentWallet: wallet }), caps)).toEqual({ ok: false, refusal: 'agent_daily' });

    for (let i = 0; i < caps.perUserDaily; i++) await reserveOk({ ownerDid: 'did:privy:same', agentWallet: `0x${'5'.repeat(39)}${i}` });
    expect(await store.reserve(input({ ownerDid: 'did:privy:same' }), caps)).toEqual({ ok: false, refusal: 'user_daily' });

    for (let i = 0; i < caps.perPosterDaily; i++) await reserveOk({ poster: '0x' + 'c'.repeat(40), agentWallet: `0x${'6'.repeat(39)}${i}` });
    expect(await store.reserve(input({ poster: '0x' + 'c'.repeat(40) }), caps)).toEqual({ ok: false, refusal: 'poster_daily' });
  });

  it('caps global spend per hour and per day, counting held budgets and real costs', async () => {
    const hourly = { ...caps, perAgentDaily: 99, perUserDaily: 99, perPosterDaily: 99 };
    for (let i = 0; i < 10; i++) expect((await store.reserve(input(), hourly)).ok).toBe(true); // 10 × 0.01 = the 0.1 hourly budget
    expect(await store.reserve(input(), hourly)).toEqual({ ok: false, refusal: 'hourly_budget' });
    // Settled reservations count what they cost, not their budget.
    await pool.current!.query(`UPDATE gas_sponsor_reservations SET status = 'used', cost_wei = 1000`);
    expect((await store.reserve(input(), hourly)).ok).toBe(true);
    // The day: push the last hour's reservations back an hour and fill the rest.
    await pool.current!.query(`UPDATE gas_sponsor_reservations SET status = 'used', cost_wei = $1, created_at = NOW() - interval '2 hours'`, [(E / 40n).toString()]);
    expect(await store.reserve(input(), hourly)).toEqual({ ok: false, refusal: 'daily_budget' }); // 11 × 0.025 > 0.25
  });

  it('refuses while paused or killed', async () => {
    await store.setControls(CHAIN, { paused: true }, 'budget review', '0xfounder');
    expect(await store.reserve(input(), caps)).toEqual({ ok: false, refusal: 'paused' });
    await store.setControls(CHAIN, { paused: false, killed: true }, 'leaked key', '0xfounder');
    expect(await store.reserve(input(), caps)).toEqual({ ok: false, refusal: 'paused' });
    expect(await store.getControls(CHAIN)).toMatchObject({ paused: false, killed: true, reason: 'leaked key', updatedBy: '0xfounder' });
    expect(await store.getControls(CHAIN + 1)).toMatchObject({ paused: false, killed: false });
  });

  it('records a strike for an expired reservation, and strikes end sponsorship for that agent and user', async () => {
    const wallet = '0x' + '7'.repeat(40);
    for (let i = 0; i < caps.maxStrikes; i++) {
      const r = await reserveOk({ agentWallet: wallet, ownerDid: 'did:privy:striker' });
      expect(await store.closeReservation(r.id, 'expired')).toBe(true);
      expect(await store.closeReservation(r.id, 'expired')).toBe(false);
    }
    expect(await store.strikeCounts(CHAIN, wallet, 'did:privy:striker')).toEqual({ agent: 2, owner: 2 });
    expect(await store.reserve(input({ agentWallet: wallet }), caps)).toEqual({ ok: false, refusal: 'strikes' });
    expect(await store.reserve(input({ ownerDid: 'did:privy:striker' }), caps)).toEqual({ ok: false, refusal: 'strikes' });
  });

  it('cannot pass a cap with concurrent reservations', async () => {
    const wallet = '0x' + '8'.repeat(40);
    const outcomes = await Promise.all(Array.from({ length: 12 }, () => store.reserve(input({ agentWallet: wallet }), caps)));
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1); // one held per agent
    const poster = '0x' + 'd'.repeat(40);
    const many = await Promise.all(Array.from({ length: 12 }, (_, i) => store.reserve(input({ poster, agentWallet: `0x${'9'.repeat(38)}${String(i).padStart(2, '0')}` }), caps)));
    expect(many.filter((o) => o.ok)).toHaveLength(caps.perPosterDaily);
  });

  it('stores signed transactions write-ahead, settles their cost onto the reservation, and finds unsettled ones', async () => {
    const r = await reserveOk();
    const sponsor = '0x' + 'e'.repeat(40);
    expect(await store.nextStoredNonce(CHAIN, sponsor)).toBeNull();
    await store.recordSignedTx({ chainId: CHAIN, reservationId: r.id, sponsor, nonce: 4, rawTx: '0x04aa', txHash: '0x' + '01'.repeat(32), withAuthorization: true });
    await store.recordSignedTx({ chainId: CHAIN, reservationId: r.id, sponsor, nonce: 5, rawTx: '0x02bb', txHash: '0x' + '02'.repeat(32), withAuthorization: false });
    expect(await store.nextStoredNonce(CHAIN, sponsor)).toBe(6);
    await expect(store.recordSignedTx({ chainId: CHAIN, reservationId: r.id, sponsor, nonce: 5, rawTx: '0x', txHash: '0x' + '03'.repeat(32), withAuthorization: false }))
      .rejects.toThrow();
    expect((await store.unsettledTxs(CHAIN, sponsor)).map((t) => t.nonce)).toEqual([4, 5]);
    expect(await store.setupAttempts(CHAIN, r.agentWallet)).toBe(1);

    await store.settleTx('0x' + '01'.repeat(32), 'noop', 150_000n, 3_000_000_000_000_000n);
    await store.settleTx('0x' + '01'.repeat(32), 'noop', 150_000n, 3_000_000_000_000_000n); // once only
    await store.settleTx('0x' + '02'.repeat(32), 'confirmed', 100_000n, 2_000_000_000_000_000n);
    await store.markReservationUsed(r.id, '0x' + '02'.repeat(32));
    const after = (await store.getReservationById(r.id))!;
    expect(after).toMatchObject({ status: 'used', gasUsed: 250_000n, costWei: 5_000_000_000_000_000n, txHash: '0x' + '02'.repeat(32) });
    expect(await store.unsettledTxs(CHAIN, sponsor)).toEqual([]);
    expect((await store.usage(CHAIN)).failuresLastHour).toBe(1);
  });

  it('frees the nonce of a transaction the node rejected outright, and only that one', async () => {
    const r = await reserveOk();
    const sponsor = '0x' + 'd'.repeat(40);
    await store.recordSignedTx({ chainId: CHAIN, reservationId: r.id, sponsor, nonce: 7, rawTx: '0x02aa', txHash: '0x' + '07'.repeat(32), withAuthorization: false });
    const [stored] = await store.unsettledTxs(CHAIN, sponsor);
    expect(stored.createdAt).toBeInstanceOf(Date);
    await store.setTxStatus('0x' + '07'.repeat(32), 'rejected');
    expect(await store.nextStoredNonce(CHAIN, sponsor)).toBeNull();
    await store.recordSignedTx({ chainId: CHAIN, reservationId: r.id, sponsor, nonce: 7, rawTx: '0x02bb', txHash: '0x' + '17'.repeat(32), withAuthorization: false });
    expect(await store.nextStoredNonce(CHAIN, sponsor)).toBe(8);
    // A dropped transaction's nonce was used on-chain: it stays taken.
    await store.setTxStatus('0x' + '17'.repeat(32), 'dropped');
    await expect(store.recordSignedTx({ chainId: CHAIN, reservationId: r.id, sponsor, nonce: 7, rawTx: '0x02cc', txHash: '0x' + '27'.repeat(32), withAuthorization: false }))
      .rejects.toThrow();
    expect((await store.usage(CHAIN)).failuresLastHour).toBe(2);
  });

  it('logs key exports for good', async () => {
    const wallet = '0x' + 'F'.repeat(40);
    expect(await store.walletKeyExported(wallet)).toBe(false);
    await store.recordKeyExport('agent-1', wallet, '0xOWNER');
    expect(await store.walletKeyExported(wallet.toLowerCase())).toBe(true);
  });
});
