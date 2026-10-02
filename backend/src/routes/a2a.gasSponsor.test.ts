import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/**
 * The routes of sponsored gas (docs/AGENT-GAS-FUNDING.md) on the REAL
 * a2aRouter:
 *   - /accept with sponsorGas reserves BEFORE the compare-and-set, answers
 *     409 GAS_SPONSOR_UNAVAILABLE without touching the task when it can't,
 *     keeps the reservation once assigned (or while assigning), and gives it
 *     back on any other failure;
 *   - /sponsored-call takes only the agent's own platform token (typ and the
 *     stored jti);
 *   - the feed carries the task-level gasSponsored hint.
 * The sponsorship services are mocked: their rules are their own tests.
 */

const AGENT = '0x4444444444444444444444444444444444444444';
const TASK = '0x' + 'ab'.repeat(32);

const auth = vi.hoisted(() => ({ user: null as any }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = auth.user ?? { address: req.headers['x-test-address'] || AGENT };
    next();
  },
}));

vi.mock('../services/a2aStore.js', () => ({
  getMeta: vi.fn(),
  getState: vi.fn(async () => null),
  tryAccept: vi.fn(async () => ({ ok: true, state: {} })),
  acquireAcceptLock: vi.fn(async () => true),
  releaseAcceptLock: vi.fn(async () => {}),
  logAcceptAttempt: vi.fn(async () => {}),
  getOffer: vi.fn(async () => undefined),
  clearOffer: vi.fn(async () => {}),
  clearCascade: vi.fn(async () => {}),
  startSettlementDeadline: vi.fn(async () => {}),
  clearSettlementDeadline: vi.fn(async () => {}),
  mergeWrappedKeys: vi.fn(async () => {}),
  updateState: vi.fn(async () => {}),
  tryReleaseAccepted: vi.fn(async () => ({ ok: true })),
  browseAgentTasks: vi.fn(async () => []),
  projectPublicEntry: (t: any) => t,
}));
vi.mock('../services/agentStore.js', () => ({ getAgent: vi.fn(async (address: string) => ({ address, capabilities: [], supportedChains: ['arc'], publicKey: '04' + 'ab'.repeat(64) })) }));
vi.mock('../services/keyCustodyService.js', () => ({ getKeyCustodyService: vi.fn(() => null), isKeyCustodyEnabled: vi.fn(() => false) }));
vi.mock('../services/redis.js', () => ({ redis: { set: vi.fn(), get: vi.fn(), exists: vi.fn(), pipeline: vi.fn() }, isAlive: vi.fn(async () => false) }));
const agents = vi.hoisted(() => new Map<string, any>());
vi.mock('../services/deployedAgentStore.js', () => ({
  loadAgentByWallet: vi.fn(async (w: string) => agents.get(w.toLowerCase()) ?? null),
  loadAgentBySmartAccount: vi.fn(async () => null),
}));
vi.mock('../services/socket.js', () => ({ emitTaskOffer: vi.fn(), emitTaskAvailable: vi.fn(), hasAgentSocket: vi.fn(() => false) }));
vi.mock('../services/chain.js', () => ({ provider: {}, baseProvider: {}, baseEscrow: null }));
vi.mock('../services/escrow.js', () => ({ getTaskOn: vi.fn(), getTask: vi.fn(), getTaskVerifierOn: vi.fn() }));
const settle = vi.hoisted(() => ({ result: { success: true, txHash: '0xassign', chain: 'arc' } as any }));
vi.mock('../services/a2aSettlement.js', () => ({
  settleAssignment: vi.fn(async () => settle.result),
  settleVerification: vi.fn(),
  resolveAssignee: vi.fn(async (a: string) => a),
}));
vi.mock('../services/notificationStore.js', () => ({ notifyLifecycle: vi.fn(async () => {}), notify: vi.fn(async () => null) }));
vi.mock('../services/bidsStore.js', () => ({ clearBids: vi.fn(async () => {}) }));
vi.mock('../services/semanticMatch.js', () => ({ recordShadowOutcome: vi.fn(async () => {}), recordMatchShadow: vi.fn(), semanticRoutingEligible: vi.fn(() => false) }));
vi.mock('../services/avatarStore.js', () => ({ withPosterAvatars: async (metas: any[]) => metas }));
vi.mock('../services/taskChain.js', async (orig) => ({
  ...(await orig<typeof import('../services/taskChain.js')>()),
  resolveTaskByHash: vi.fn(async () => ({ taskId: '41', chain: 'arc' })),
}));

const sponsor = vi.hoisted(() => ({
  enabled: true,
  reserve: vi.fn(),
  release: vi.fn(async () => {}),
  start: vi.fn(async () => {}),
  holds: vi.fn(async () => false),
  hint: vi.fn(async () => true),
  relay: vi.fn(),
}));
vi.mock('../services/gasSponsorConfig.js', () => ({ gasSponsorSettings: () => (sponsor.enabled ? { enabled: true } : { enabled: false }) }));
vi.mock('../services/gasSponsorEligibility.js', () => ({ sponsorHint: sponsor.hint }));
vi.mock('../services/gasSponsorAccept.js', () => ({
  reserveForAccept: sponsor.reserve,
  releaseAcceptReservation: sponsor.release,
  startReservationAfterAssign: sponsor.start,
  holdsReservation: sponsor.holds,
}));
vi.mock('../services/gasSponsorRelayer.js', () => ({ relaySponsoredCall: sponsor.relay }));

import { a2aRouter } from './a2a.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import * as a2aStore from '../services/a2aStore.js';
import { settleAssignment } from '../services/a2aSettlement.js';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/a2a', a2aRouter);
  a.use(globalErrorHandler);
  return a;
}
const accept = (body: Record<string, unknown> = { sponsorGas: true }) =>
  request(app()).post(`/api/v1/a2a/tasks/${TASK}/accept`).set('x-test-address', AGENT).send(body);
const RESERVATION = { id: 7 };

beforeEach(() => {
  vi.clearAllMocks();
  auth.user = null;
  agents.clear();
  sponsor.enabled = true;
  sponsor.reserve.mockResolvedValue(RESERVATION);
  settle.result = { success: true, txHash: '0xassign', chain: 'arc' };
  vi.mocked(a2aStore.getMeta).mockResolvedValue({ taskId: TASK, chain: 'arc', privacy: 'public', rootHash: '0xroot', requiredCapabilities: [], posterAddress: '0x' + '22'.repeat(20) } as any);
  vi.mocked(a2aStore.tryAccept).mockResolvedValue({ ok: true, state: {} } as any);
});

describe('/accept with sponsorGas', () => {
  it('reserves before the compare-and-set, keeps the reservation once assigned, and says so', async () => {
    const res = await accept();
    expect(res.status).toBe(200);
    expect(res.body.data.gasSponsored).toBe(true);
    expect(sponsor.reserve).toHaveBeenCalledWith(TASK, expect.objectContaining({ taskId: TASK }), AGENT);
    expect(sponsor.reserve.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(a2aStore.tryAccept).mock.invocationCallOrder[0]);
    expect(sponsor.start).toHaveBeenCalledWith(RESERVATION);
    expect(sponsor.release).not.toHaveBeenCalled();
  });

  it('answers 409 GAS_SPONSOR_UNAVAILABLE without touching the task when nothing can be reserved', async () => {
    sponsor.reserve.mockRejectedValue(new AppError(409, 'GAS_SPONSOR_UNAVAILABLE', 'no budget', 'daily_budget'));
    const res = await accept();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('GAS_SPONSOR_UNAVAILABLE');
    expect(a2aStore.tryAccept).not.toHaveBeenCalled();
    expect(settleAssignment).not.toHaveBeenCalled();
  });

  it('does not reserve for an accept that does not ask', async () => {
    const res = await accept({});
    expect(res.status).toBe(200);
    expect(res.body.data.gasSponsored).toBeUndefined();
    expect(sponsor.reserve).not.toHaveBeenCalled();
  });

  it('gives the reservation back when the compare-and-set is lost', async () => {
    vi.mocked(a2aStore.tryAccept).mockResolvedValue({ ok: false, currentStatus: 'accepted' } as any);
    const res = await accept();
    expect(res.status).toBe(409);
    expect(sponsor.release).toHaveBeenCalledWith(RESERVATION);
  });

  it('gives it back when the on-chain assignment fails, and keeps it while the assignment is still confirming', async () => {
    settle.result = { success: false, error: 'boom' };
    expect((await accept()).status).toBe(503);
    expect(sponsor.release).toHaveBeenCalledWith(RESERVATION);

    sponsor.release.mockClear();
    settle.result = { success: false, pending: true, txHash: '0xpending' };
    expect((await accept()).body.error.code).toBe('ASSIGNMENT_PENDING');
    expect(sponsor.release).not.toHaveBeenCalled();
  });

  it('reports a held reservation on a re-accept (resume)', async () => {
    vi.mocked(a2aStore.getState).mockResolvedValue({ status: 'accepted', executorAddress: AGENT } as any);
    sponsor.holds.mockResolvedValue(true);
    const res = await accept({});
    expect(res.status).toBe(200);
    expect(res.body.data.gasSponsored).toBe(true);
    expect(a2aStore.tryAccept).not.toHaveBeenCalled();
  });
});

describe('/sponsored-call', () => {
  const platformToken = jwt.sign({ address: AGENT, ownerAddress: '0xowner', jti: 'jti-current', typ: 'agent-platform' }, 'x');
  const body = {
    kind: 'submit',
    evidenceHash: '0x' + '11'.repeat(32),
    nonce: '0',
    deadline: '9999999999',
    signature: '0x' + '22'.repeat(65),
  };
  const call = (b: Record<string, unknown> = body) => request(app()).post(`/api/v1/a2a/tasks/${TASK}/sponsored-call`).send(b);

  beforeEach(() => {
    agents.set(AGENT.toLowerCase(), { id: 'agent-1', walletAddress: AGENT, platformToken });
    sponsor.relay.mockResolvedValue({ ok: true, txHash: '0x' + '33'.repeat(32) });
  });

  it("relays for the agent's own current platform token", async () => {
    auth.user = { address: AGENT, typ: 'agent-platform', jti: 'jti-current' };
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ txHash: '0x' + '33'.repeat(32), landedElsewhere: false });
    expect(sponsor.relay).toHaveBeenCalledWith(expect.objectContaining({ kind: 'submit', taskId: 41n, nonce: 0n, deadline: 9999999999n }));
  });

  it.each([
    ['a device-flow registration token', { address: AGENT, typ: 'agent-registration', jti: 'jti-current' }],
    ['a replaced (or revoked) platform token', { address: AGENT, typ: 'agent-platform', jti: 'jti-old' }],
    ['a Privy session', { address: AGENT }],
    ['an address that is not a hosted agent', { address: '0x' + '55'.repeat(20), typ: 'agent-platform', jti: 'jti-current' }],
  ])('refuses %s', async (_name, user) => {
    auth.user = user;
    const res = await call();
    expect(res.status).toBe(403);
    expect(sponsor.relay).not.toHaveBeenCalled();
  });

  it('passes a refusal through, so the worker falls back to its own gas', async () => {
    auth.user = { address: AGENT, typ: 'agent-platform', jti: 'jti-current' };
    sponsor.relay.mockResolvedValue({ ok: false, status: 409, code: 'NOT_DELEGATED', message: 'sign an authorization' });
    const res = await call();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_DELEGATED');
  });

  it('validates the body, and passes a 7702 authorization through', async () => {
    auth.user = { address: AGENT, typ: 'agent-platform', jti: 'jti-current' };
    expect((await call({ ...body, evidenceHash: undefined })).status).toBe(400);
    expect((await call({ ...body, signature: '0x12' })).status).toBe(400);
    const authorization = { chainId: '5042002', address: '0x' + 'de'.repeat(20), nonce: '0', yParity: 1, r: '0x' + '01'.repeat(32), s: '0x' + '02'.repeat(32) };
    expect((await call({ ...body, authorization })).status).toBe(200);
    expect(sponsor.relay).toHaveBeenLastCalledWith(expect.objectContaining({ authorization: expect.objectContaining({ chainId: 5042002n, yParity: 1 }) }));
  });
});

describe('the feed hint', () => {
  it('marks tasks sponsorship would likely pay for', async () => {
    vi.mocked(a2aStore.browseAgentTasks).mockResolvedValue([
      { meta: { taskId: 'a', chain: 'arc' }, state: {} },
      { meta: { taskId: 'b', chain: 'arc' }, state: {} },
    ] as any);
    sponsor.hint.mockImplementation(async (meta: any) => meta.taskId === 'a');
    const res = await request(app()).get('/api/v1/a2a/tasks');
    expect(res.body.data.tasks.map((t: any) => t.meta.gasSponsored)).toEqual([true, undefined]);
  });

  it('carries no hint while sponsorship is off', async () => {
    sponsor.enabled = false;
    vi.mocked(a2aStore.browseAgentTasks).mockResolvedValue([{ meta: { taskId: 'a', chain: 'arc' }, state: {} }] as any);
    const res = await request(app()).get('/api/v1/a2a/tasks');
    expect(res.body.data.tasks[0].meta.gasSponsored).toBeUndefined();
    expect(sponsor.hint).not.toHaveBeenCalled();
  });
});
