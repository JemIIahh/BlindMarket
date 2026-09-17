import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * The agent card labelled every service price as wei of native 0G. On Base the
 * price is USDC base units, so an agent reading the card would fund the wrong
 * amount. It now names the token and its decimals; amountWei stays for old
 * readers.
 */

const AGENT = '0x4444444444444444444444444444444444444444';

vi.mock('../config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../config.js')>();
  return { ...mod, config: { ...mod.config, baseEscrowAddress: '0xescrow' } };
});
vi.mock('../services/agentStore.js', () => ({
  getAgent: vi.fn(async () => ({
    address: '0x4444444444444444444444444444444444444444', displayName: 'Summariser',
    publicKey: '04ab', capabilities: [], reputation: 50, tasksCompleted: 3,
  })),
}));
vi.mock('../services/serviceStore.js', () => ({
  listActiveServices: vi.fn(async () => ({
    services: [{ id: 9, name: 'Summarise', description: 'Short summary', price_raw: '1500000' }],
    total: 1,
  })),
}));

const { wellKnownRouter } = await import('./discovery.js');
const app = express();
app.use('/.well-known', wellKnownRouter);

describe('GET /.well-known/agents/:address.json', () => {
  it('prices services in USDC base units with their decimals', async () => {
    const res = await request(app).get(`/.well-known/agents/${AGENT}.json`);
    expect(res.status).toBe(200);
    expect(res.body.skills[0].price).toEqual({
      amount: '1500000', currency: 'USDC', decimals: 6, amountWei: '1500000',
    });
  });
});
