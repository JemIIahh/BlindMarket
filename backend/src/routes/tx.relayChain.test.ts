import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Which chain POST /tx/relay-tx has Privy sign on. The `chain` a client sends
 * is resolved through relayChains.ts; the fixed names must keep the chain ids
 * they have always meant, whatever this deployment settles on.
 */

const { sendTx, cfg } = vi.hoisted(() => ({
  sendTx: vi.fn(async (_walletId: string, _body: { caip2: string }) => ({ data: { hash: '0xabc' } })),
  cfg: {
    privyAppId: 'app', privyAppSecret: 'secret', privyAuthorizationKey: 'authkey',
    ogChainId: 16661, baseChainId: 84532,
  } as Record<string, unknown>,
}));

vi.mock('@privy-io/node', () => ({
  PrivyClient: class {
    wallets() { return { getWalletByAddress: async () => ({ id: 'wallet-id-1' }), _rpc: sendTx }; }
  },
  generateAuthorizationSignatures: vi.fn(async () => ['sig']),
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { address: WALLET };
    next();
  },
}));
vi.mock('../config.js', () => ({ config: cfg }));

const WALLET = '0x1111111111111111111111111111111111111111';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

const { txRouter } = await import('./tx.js');
const { globalErrorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
app.use('/api/v1/tx', txRouter);
app.use(globalErrorHandler);

const relay = (chain?: string) =>
  request(app)
    .post('/api/v1/tx/relay-tx')
    .send({ walletAddress: WALLET, to: USDC, data: '0x', ...(chain !== undefined ? { chain } : {}) });

beforeEach(() => {
  sendTx.mockClear();
  cfg.baseChainId = 84532;
});

describe('POST /tx/relay-tx chain names', () => {
  it.each([
    ['base', 'eip155:8453'],
    ['base-mainnet', 'eip155:8453'],
    ['base-sepolia', 'eip155:84532'],
  ])('signs %s on %s', async (chain, caip2) => {
    const res = await relay(chain);
    expect(res.status).toBe(200);
    expect(sendTx).toHaveBeenCalledTimes(1);
    expect(sendTx.mock.calls[0][1].caip2).toBe(caip2);
  });

  it("defaults to 'base', which is Base mainnet even when BASE_CHAIN_ID is Base Sepolia", async () => {
    const res = await relay();
    expect(res.status).toBe(200);
    expect(sendTx.mock.calls[0][1].caip2).toBe('eip155:8453');
  });

  it('refuses a chain it does not serve, listing the names it does', async () => {
    const res = await relay('arc');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'INVALID_CHAIN',
      message: 'Unsupported chain "arc". Supported: base, base-mainnet, base-sepolia',
    });
    expect(sendTx).not.toHaveBeenCalled();
  });

  it('refuses an inherited object key as a chain name', async () => {
    const res = await relay('constructor');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CHAIN');
    expect(sendTx).not.toHaveBeenCalled();
  });
});
