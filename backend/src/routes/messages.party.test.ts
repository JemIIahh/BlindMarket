import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * C-04: POST /messages/send took any `to` with any taskId, so any signed-in
 * caller could plant text in an agent's task thread. Task-scoped messages are
 * now confined to the task's poster and executor (plus an agent's own owner).
 *
 * Run: npx vitest run src/routes/messages.party.test.ts
 */

const POSTER = '0x' + 'aa'.repeat(20);
const EXECUTOR = '0x' + 'bb'.repeat(20);
const OWNER = '0x' + 'cc'.repeat(20);
const STRANGER = '0x' + 'dd'.repeat(20);
const TASK = '0x' + 'ab'.repeat(32);

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { address: req.headers['x-test-address'], ownerAddress: req.headers['x-test-owner'] };
    next();
  },
}));

const getMeta = vi.fn();
const getState = vi.fn();
vi.mock('../services/a2aStore.js', () => ({
  getMeta: (...a: unknown[]) => getMeta(...a),
  getState: (...a: unknown[]) => getState(...a),
}));

const loadAgentByWallet = vi.fn();
vi.mock('../services/deployedAgentStore.js', () => ({
  loadAgentByWallet: (...a: unknown[]) => loadAgentByWallet(...a),
}));

const sendMessage = vi.fn(async (m: Record<string, unknown>) => ({ id: 1, ...m }));
vi.mock('../services/messageStore.js', () => ({ sendMessage: (m: Record<string, unknown>) => sendMessage(m) }));
vi.mock('../services/socket.js', () => ({ emit: vi.fn() }));
vi.mock('../services/webhookStore.js', () => ({ fireWebhooks: vi.fn(async () => {}) }));

import { messagesRouter } from './messages.js';
import { emit } from '../services/socket.js';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/messages', messagesRouter);
  return a;
}

const send = (from: string, body: Record<string, unknown>, owner?: string) => {
  const r = request(app()).post('/api/v1/messages/send').set('x-test-address', from);
  if (owner) r.set('x-test-owner', owner);
  return r.send({ body: 'hi', ...body });
};

beforeEach(() => {
  vi.clearAllMocks();
  getMeta.mockResolvedValue({ taskId: TASK, posterAddress: POSTER });
  getState.mockResolvedValue({ taskId: TASK, status: 'accepted', executorAddress: EXECUTOR });
  loadAgentByWallet.mockResolvedValue(null);
});

describe('POST /messages/send task-party check', () => {
  it('lets the poster and executor message each other', async () => {
    expect((await send(POSTER, { to: EXECUTOR, taskId: TASK })).status).toBe(200);
    expect((await send(EXECUTOR.toUpperCase().replace('0X', '0x'), { to: 'poster', taskId: TASK })).status).toBe(200);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('accepts `content` for the message text, as @blindmarket/sdk (and the MCP send_message tool) sends it', async () => {
    const res = await send(POSTER, { to: EXECUTOR, taskId: TASK, body: undefined, content: 'hello from the sdk' });
    expect(res.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ body: 'hello from the sdk' }));
  });

  it('403s a stranger writing into a task thread', async () => {
    const res = await send(STRANGER, { to: EXECUTOR, taskId: TASK });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_TASK_PARTY');
    expect((await send(STRANGER, { to: 'agent', taskId: TASK })).status).toBe(403);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('403s a party addressing someone outside the task', async () => {
    const res = await send(POSTER, { to: STRANGER, taskId: TASK });
    expect(res.status).toBe(403);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('403s a party messaging itself under the task', async () => {
    expect((await send(POSTER, { to: POSTER, taskId: TASK })).status).toBe(403);
  });

  it('404s an unknown task', async () => {
    getMeta.mockResolvedValue(undefined);
    getState.mockResolvedValue(undefined);
    expect((await send(POSTER, { to: EXECUTOR, taskId: TASK })).status).toBe(404);
  });

  it('keeps the owner shortcut working, with or without a taskId', async () => {
    expect((await send(EXECUTOR, { to: 'owner' }, OWNER)).status).toBe(200);
    expect((await send(EXECUTOR, { to: 'creator', taskId: TASK }, OWNER)).status).toBe(200);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ to: OWNER }));
  });

  it("lets an agent's owner reply on its task thread, but not someone else's owner", async () => {
    loadAgentByWallet.mockResolvedValue({ walletAddress: EXECUTOR, ownerAddress: OWNER });
    expect((await send(OWNER, { to: EXECUTOR, taskId: TASK })).status).toBe(200);
    expect((await send(STRANGER, { to: EXECUTOR, taskId: TASK })).status).toBe(403);
  });

  it('lets an owner reply to their own agent on a task it no longer holds (released → no executor)', async () => {
    getState.mockResolvedValue({ taskId: TASK, status: 'open' });
    loadAgentByWallet.mockResolvedValue({ walletAddress: EXECUTOR, ownerAddress: OWNER });
    expect((await send(OWNER, { to: EXECUTOR, taskId: TASK })).status).toBe(200);
    expect((await send(EXECUTOR, { to: OWNER, taskId: TASK })).status).toBe(200);
    expect((await send(STRANGER, { to: EXECUTOR, taskId: TASK })).status).toBe(403);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});

describe('POST /messages/send without a taskId', () => {
  const agentOf = (owner: string) => (wallet: string) =>
    wallet.toLowerCase() === EXECUTOR ? { walletAddress: EXECUTOR, ownerAddress: owner } : null;

  it('leaves direct messages between non-agent addresses alone', async () => {
    expect((await send(STRANGER, { to: POSTER })).status).toBe(200);
    expect(getMeta).not.toHaveBeenCalled();
  });

  it("403s anyone but the owner writing straight into an agent's inbox", async () => {
    loadAgentByWallet.mockImplementation(async (w: string) => agentOf(OWNER)(w));
    const res = await send(STRANGER, { to: EXECUTOR });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_AGENT_OWNER');
    // Another agent is no different from any other stranger.
    expect((await send(POSTER, { to: EXECUTOR.toUpperCase().replace('0X', '0x') })).status).toBe(403);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('lets the owner message their own agent, and the agent message its owner', async () => {
    loadAgentByWallet.mockImplementation(async (w: string) => agentOf(OWNER)(w));
    expect((await send(OWNER.toUpperCase().replace('0X', '0x'), { to: EXECUTOR })).status).toBe(200);
    expect((await send(EXECUTOR, { to: OWNER })).status).toBe(200);
    expect((await send(EXECUTOR, { to: 'owner' }, OWNER)).status).toBe(200);
    expect(sendMessage).toHaveBeenCalledTimes(3);
  });

  it('fails closed when the agent lookup is down', async () => {
    loadAgentByWallet.mockRejectedValue(new Error('db down'));
    const res = await send(STRANGER, { to: EXECUTOR });
    expect(res.status).toBe(503);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('POST /messages/send public-room ping (audit run 1, C26)', () => {
  it('announces a new message to the public platform room without who, to whom or which task', async () => {
    expect((await send(POSTER, { to: EXECUTOR, taskId: TASK })).status).toBe(200);
    expect(emit).toHaveBeenCalledWith('platform', 'message:new', {});
    const payload = JSON.stringify(vi.mocked(emit).mock.calls);
    expect(payload).not.toContain(POSTER.slice(2, 10));
    expect(payload).not.toContain(EXECUTOR.slice(2, 10));
    expect(payload).not.toContain(TASK.slice(2, 10));
  });
});
