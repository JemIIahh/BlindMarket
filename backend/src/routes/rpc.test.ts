import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * routes/rpc.ts — same-origin JSON-RPC read proxy. Exists because privacy
 * extensions block public RPC hosts (net::ERR_BLOCKED_BY_CLIENT), silently
 * breaking every balance read in the app. Strictly reads: anything that
 * signs, sends, or mines must fail closed here.
 */

const { send } = vi.hoisted(() => ({
  send: vi.fn(async (method: string, _params: unknown[]) => {
    if (method === 'eth_chainId') return '0x4cef52';
    if (method === 'eth_call') throw new Error('kaboom');
    return '0x1';
  }),
}));

vi.mock('../services/chain.js', () => ({
  arcProvider: { send },
  baseProvider: { send },
}));

vi.mock('../services/cctpChains.js', () => ({
  isSupportedCctpChain: vi.fn((k: string) => k === 'base-sepolia'),
  getCctpChain: vi.fn(() => ({ rpc: { send } })),
}));

import { rpcRouter } from './rpc.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/rpc', rpcRouter);
  a.use(globalErrorHandler);
  return a;
}

const call = (method: string, params: unknown[] = []) => ({ jsonrpc: '2.0', id: 1, method, params });

beforeEach(() => {
  send.mockClear();
});

describe('POST /api/v1/rpc/:chain', () => {
  it('forwards reads and envelopes the result', async () => {
    const res = await request(app()).post('/api/v1/rpc/arc').send(call('eth_chainId'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ jsonrpc: '2.0', id: 1, result: '0x4cef52' });
    expect(send).toHaveBeenCalledWith('eth_chainId', []);
  });

  it('routes cctp chains to their providers', async () => {
    const res = await request(app()).post('/api/v1/rpc/base-sepolia').send(call('eth_blockNumber'));
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('0x1');
  });

  it.each([
    'eth_sendRawTransaction',
    'eth_sendTransaction',
    'eth_sign',
    'eth_signTransaction',
    'personal_sign',
  ])('refuses the writing method %s', async (method) => {
    const res = await request(app()).post('/api/v1/rpc/arc').send(call(method));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('RPC_METHOD_FORBIDDEN');
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses unknown chains', async () => {
    const res = await request(app()).post('/api/v1/rpc/nope').send(call('eth_chainId'));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('RPC_UNKNOWN_CHAIN');
  });

  it('envelopes upstream errors instead of throwing', async () => {
    const res = await request(app()).post('/api/v1/rpc/arc').send(call('eth_call', [{}, 'latest']));
    expect(res.status).toBe(200);
    expect(res.body.error.code).toBe(-32000);
  });

  it('serves batches and caps their size', async () => {
    const res = await request(app()).post('/api/v1/rpc/arc')
      .send([call('eth_chainId'), call('eth_sendRawTransaction')]);
    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual({ jsonrpc: '2.0', id: 1, result: '0x4cef52' });
    expect(res.body[1]).toMatchObject({ error: { code: 'RPC_METHOD_FORBIDDEN' } });

    const big = await request(app()).post('/api/v1/rpc/arc')
      .send(Array.from({ length: 26 }, () => call('eth_chainId')));
    expect(big.status).toBe(400);
  });
});
