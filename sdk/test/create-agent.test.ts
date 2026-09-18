import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { BlindMarket } from '../src/index.js';
import { AgentCap } from '../src/types.js';

/**
 * createAgent() must find an owner mismatch BEFORE POST /a2a/register: that
 * route upserts `publicKey` over the API key owner's executor record, so a
 * check made afterwards has already redirected the owner's briefs.
 * GET /api/v1/api-keys/whoami answers { address, addresses }
 * (backend/src/routes/apiKeys.ts).
 */

const PRIVATE_KEY = `0x${'1'.repeat(64)}`;
const KEY_ADDRESS = new ethers.Wallet(PRIVATE_KEY).address;
const OTHER = '0x00000000000000000000000000000000000000e1';

const ok = (data: unknown) => ({ status: 200, json: async () => ({ success: true, data }) }) as unknown as Response;

function stub(whoami: () => Response | Promise<Response>, registeredAs = KEY_ADDRESS) {
  const fn = vi.fn(async (url: string | URL, _init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/api/v1/api-keys/whoami')) return whoami();
    if (u.endsWith('/api/v1/a2a/register')) return ok({ agent: { address: registeredAs, displayName: 'a', capabilities: [] } });
    throw new Error(`unhandled fetch ${u}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const registers = (fn: ReturnType<typeof stub>) => fn.mock.calls.filter((c) => String(c[0]).includes('/a2a/register'));
const params = { displayName: 'a', capabilities: [AgentCap.DATA_PROCESSING] };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('BlindMarket.createAgent — owner check', () => {
  it("refuses a key that is not the API key's owner WITHOUT calling /register", async () => {
    const fn = stub(() => ok({ address: OTHER, addresses: [OTHER] }));
    const bb = new BlindMarket({ apiKey: 'k' });
    await expect(bb.createAgent({ ...params, privateKey: PRIVATE_KEY })).rejects.toMatchObject({
      status: 409,
      code: 'OWNER_MISMATCH',
      message: expect.stringContaining('Nothing was registered'),
    });
    expect(registers(fn)).toHaveLength(0);
  });

  it('refuses the legacy shared AGENT_API_KEY principal ("agent"), which is no wallet', async () => {
    const fn = stub(() => ok({ address: 'agent', addresses: ['agent'] }));
    const bb = new BlindMarket({ apiKey: 'k', executor: { privateKey: PRIVATE_KEY, rpcUrls: {} } });
    await expect(bb.createAgent(params)).rejects.toMatchObject({ code: 'OWNER_MISMATCH' });
    expect(registers(fn)).toHaveLength(0);
  });

  it("registers the key's uncompressed public key when it is the owner's (any address casing)", async () => {
    const fn = stub(() => ok({ address: KEY_ADDRESS.toLowerCase() }));
    const bb = new BlindMarket({ apiKey: 'k' });
    const { wallet } = await bb.createAgent({ ...params, privateKey: PRIVATE_KEY });
    expect(wallet.address).toBe(KEY_ADDRESS);
    const calls = registers(fn);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0][1]?.body)).publicKey).toMatch(/^04[0-9a-f]{128}$/);
    // whoami first, register second.
    expect(String(fn.mock.calls[0][0])).toContain('/api-keys/whoami');
  });

  it('does not register when whoami fails for a reason other than "no such route"', async () => {
    const fn = stub(() => ({ status: 401, json: async () => ({ success: false, error: { code: 'UNAUTHORIZED', message: 'bad key' } }) }) as unknown as Response);
    const bb = new BlindMarket({ apiKey: 'k' });
    await expect(bb.createAgent({ ...params, privateKey: PRIVATE_KEY })).rejects.toMatchObject({ status: 401 });
    expect(registers(fn)).toHaveLength(0);
  });

  it('a backend without whoami (HTML 404) falls back to the check after registering', async () => {
    const html404 = () => ({ status: 404, json: async () => { throw new SyntaxError('Unexpected token <'); } }) as unknown as Response;
    const fn = stub(html404, OTHER);
    const bb = new BlindMarket({ apiKey: 'k' });
    await expect(bb.createAgent({ ...params, privateKey: PRIVATE_KEY })).rejects.toMatchObject({ code: 'OWNER_MISMATCH' });
    expect(registers(fn)).toHaveLength(1);

    const fn2 = stub(html404, KEY_ADDRESS);
    await expect(bb.createAgent({ ...params, privateKey: PRIVATE_KEY })).resolves.toMatchObject({ wallet: { address: KEY_ADDRESS } });
    expect(registers(fn2)).toHaveLength(1);
  });

  it('without a key makes no owner claim, so it does not call whoami', async () => {
    const fn = stub(() => { throw new Error('whoami must not be called'); }, OTHER);
    const bb = new BlindMarket({ apiKey: 'k' });
    const { wallet } = await bb.createAgent(params);
    expect(wallet.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(registers(fn)).toHaveLength(1);
  });
});
