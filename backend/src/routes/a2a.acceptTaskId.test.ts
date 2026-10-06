import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * POST /a2a/tasks/:id/accept writes nothing to Redis for a task that doesn't
 * exist (delta audit 2026-10-06, accept-3). It used to append to a 24 h
 * accept-attempt stream under whatever `:id` the caller sent, before looking
 * the task up, so any signed-in caller could create keys of any name and
 * length at will; and the stream had no length cap. Runs the REAL a2aStore on
 * a Redis stand-in that records every command, under the real router.
 */

const fake = vi.hoisted(() => {
  const calls: Array<{ cmd: string; args: unknown[] }> = [];
  const record = (cmd: string) => (...args: unknown[]) => { calls.push({ cmd, args }); };
  const pipeline = () => {
    const pipe: Record<string, unknown> = {};
    for (const cmd of ['xadd', 'expire', 'set', 'sadd', 'srem', 'del', 'get', 'exists']) {
      pipe[cmd] = (...args: unknown[]) => { record(cmd)(...args); return pipe; };
    }
    pipe.exec = async () => [];
    return pipe;
  };
  return {
    calls,
    redis: {
      get: vi.fn(async (...args: unknown[]) => { record('get')(...args); return null; }),
      set: vi.fn(async (...args: unknown[]) => { record('set')(...args); return 'OK'; }),
      exists: vi.fn(async (...args: unknown[]) => { record('exists')(...args); return 0; }),
      eval: vi.fn(async (...args: unknown[]) => { record('eval')(...args); return 0; }),
      pipeline: vi.fn(pipeline),
    },
  };
});

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { address: '0xagent0000000000000000000000000000000001' };
    next();
  },
}));
vi.mock('../services/redis.js', () => ({ redis: fake.redis }));
vi.mock('../services/agentStore.js', () => ({ getAgent: vi.fn() }));
vi.mock('../services/keyCustodyService.js', () => ({
  getKeyCustodyService: vi.fn(() => null),
  isKeyCustodyEnabled: vi.fn(() => false),
}));
vi.mock('../services/a2aSettlement.js', () => ({ settleAssignment: vi.fn(), settleVerification: vi.fn() }));
vi.mock('../services/chain.js', () => ({ provider: {}, escrow: { interface: {}, getAddress: vi.fn() } }));
vi.mock('../services/escrow.js', () => ({ getTask: vi.fn(), feeBps: vi.fn(), getTaskVerifier: vi.fn() }));
vi.mock('../services/escrowEvents.js', () => ({ getTaskIdByHash: vi.fn(), getCachedTaskIdByHash: vi.fn(async () => null) }));
vi.mock('../services/autoVerify.js', () => ({ autoVerify: vi.fn() }));
vi.mock('../services/accountingService.js', () => ({}));
vi.mock('../services/reputation.js', () => ({}));
vi.mock('../services/reputationDecay.js', () => ({}));
vi.mock('../services/bidsStore.js', () => ({ clearBids: vi.fn(async () => undefined) }));
vi.mock('../services/socket.js', () => ({ emitTaskOffer: vi.fn(), emitTaskAvailable: vi.fn(), hasAgentSocket: vi.fn(() => false) }));

import { a2aRouter } from './a2a.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import { logAcceptAttempt } from '../services/a2aStore.js';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/a2a', a2aRouter);
  a.use(globalErrorHandler);
  return a;
}

const accept = (id: string) => request(app()).post(`/api/v1/a2a/tasks/${encodeURIComponent(id)}/accept`);
const WRITES = new Set(['xadd', 'expire', 'set', 'sadd', 'srem', 'del', 'eval']);
const writes = () => fake.calls.filter((c) => WRITES.has(c.cmd));

beforeEach(() => {
  fake.calls.length = 0;
});

describe('POST /accept: the task id (accept-3)', () => {
  it.each([
    ['a word', 'not-a-task'],
    ['a long string', 'x'.repeat(2000)],
    ['a short hash', '0x' + 'ab'.repeat(31)],
    ['a hash with no 0x', 'ab'.repeat(32)],
    ['a hash with a non-hex digit', '0x' + 'ab'.repeat(31) + 'zz'],
  ])('refuses %s with 400 before touching Redis', async (_label, id) => {
    const res = await accept(id);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(fake.calls).toEqual([]);
  });

  it('writes no key for a well-formed hash with no task behind it', async () => {
    const res = await accept('0x' + 'Ab'.repeat(32));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    // Only the meta lookups (lowercase key, then the legacy mixed-case one).
    expect(fake.calls.map((c) => c.cmd)).toEqual(['get', 'get']);
    expect(writes()).toEqual([]);
  });
});

describe('accept-attempt stream (accept-3)', () => {
  it('caps the stream at about 200 entries and keeps the 24 h expiry', async () => {
    await logAcceptAttempt('0x' + 'cd'.repeat(32), '0xagent', 'rejected_precheck');
    const xadd = fake.calls.find((c) => c.cmd === 'xadd')!;
    expect(xadd.args.slice(0, 5)).toEqual([`a2a:accept_attempts:0x${'cd'.repeat(32)}`, 'MAXLEN', '~', 200, '*']);
    expect(fake.calls.find((c) => c.cmd === 'expire')?.args).toEqual([`a2a:accept_attempts:0x${'cd'.repeat(32)}`, 86400]);
  });
});
