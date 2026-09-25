import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * The unsigned-tx builders announce nothing: no transaction exists yet, so a
 * dispute event or stats:update from them would be forged (security audit run
 * 1, C07).
 */

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { address: '0x1111111111111111111111111111111111111111' };
    next();
  },
}));
// validators.ts reads the pool address from the environment at import.
vi.hoisted(() => { process.env.VALIDATOR_POOL_ADDRESS = '0x00000000000000000000000000000000000000a1'; });
vi.mock('../services/chain.js', () => ({
  provider: {},
  buildUnsignedTx: vi.fn(async (_c: unknown, fn: string) => ({ to: '0xpool', data: `0x${fn}`, from: '0x1111' })),
}));
const { emitted } = vi.hoisted(() => ({ emitted: [] as string[] }));
vi.mock('../services/socket.js', () => ({
  rooms: new Proxy({}, { get: (_t, room) => (event: string) => { emitted.push(`${String(room)}:${event}`); } }),
}));

import { validatorsRouter } from './validators.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';

function post(path: string, body: Record<string, unknown>) {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/validators', validatorsRouter);
  a.use(globalErrorHandler);
  return request(a).post(`/api/v1/validators${path}`).send(body);
}

describe('validator tx builders', () => {
  it('/vote and /finalize return the unsigned tx and broadcast nothing', async () => {
    const vote = await post('/vote', { disputeId: '424242', vote: 1 });
    const finalize = await post('/finalize', { disputeId: '424242' });
    expect(vote.status).toBe(200);
    expect(finalize.status).toBe(200);
    expect(vote.body.data.unsignedTx.data).toBe('0xvote');
    expect(finalize.body.data.unsignedTx.data).toBe('0xfinalizeDispute');
    expect(emitted).toEqual([]);
  });
});
