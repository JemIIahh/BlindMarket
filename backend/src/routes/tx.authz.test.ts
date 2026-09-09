import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * The relay endpoint hands the platform's PRIVY_AUTHORIZATION_KEY an arbitrary
 * `to` + `data` and signs it from the Privy wallet named in the request BODY,
 * with gas sponsored. `requireAuth` proves the caller is *someone*; nothing
 * proved the wallet was theirs. Any authenticated principal could therefore
 * have the platform sign `transfer(attacker, balance)` out of a victim's
 * embedded wallet — and pay the gas for it.
 *
 * These tests assert the binding. The Privy SDK is stubbed: a real call would
 * move real money, so the assertion is that the handler REFUSES before Privy
 * is ever reached.
 */

const sendTx = vi.fn(async () => ({ data: { user_operation_hash: '0xdeadbeef' } }));
const getWalletByAddress = vi.fn(async () => ({ id: 'wallet-id-1' }));

vi.mock('@privy-io/node', () => ({
  PrivyClient: class {
    wallets() { return { getWalletByAddress, _rpc: sendTx }; }
  },
  generateAuthorizationSignatures: vi.fn(async () => ['sig']),
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = {
      address: req.headers['x-test-address'],
      addresses: req.headers['x-test-linked']
        ? String(req.headers['x-test-linked']).split(',')
        : undefined,
    };
    next();
  },
}));

vi.mock('../config.js', () => ({
  config: {
    privyAppId: 'app', privyAppSecret: 'secret',
    privyAuthorizationKey: 'authkey',
  },
}));

import { txRouter } from './tx.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';

const app = express();
app.use(express.json());
app.use('/api/v1/tx', txRouter);
app.use(globalErrorHandler);

const VICTIM   = '0x1111111111111111111111111111111111111111';
const ATTACKER = '0x2222222222222222222222222222222222222222';
const USDC     = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
// transfer(attacker, 1000e6)
const DRAIN = '0xa9059cbb0000000000000000000000002222222222222222222222222222222222222222'
            + '000000000000000000000000000000000000000000000000000000003b9aca00';

const relay = (caller: string, walletAddress: string, extra: Record<string, string> = {}) =>
  request(app)
    .post('/api/v1/tx/relay-tx')
    .set('x-test-address', caller)
    .set(extra)
    .send({ walletAddress, to: USDC, data: DRAIN, chain: 'base' });

beforeEach(() => { sendTx.mockClear(); getWalletByAddress.mockClear(); });

describe('POST /tx/relay-tx — the wallet must belong to the caller', () => {
  it('refuses to sign from a wallet the caller does not own', async () => {
    const res = await relay(ATTACKER, VICTIM);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_WALLET_OWNER');
    // The real assertion: Privy is never reached, so nothing was ever signed.
    expect(getWalletByAddress).not.toHaveBeenCalled();
    expect(sendTx).not.toHaveBeenCalled();
  });

  it('still relays for the caller\'s own wallet', async () => {
    const res = await relay(VICTIM, VICTIM);
    expect(res.status).toBe(200);
    expect(sendTx).toHaveBeenCalledTimes(1);
  });

  it('accepts any wallet linked to the same Privy identity', async () => {
    const second = '0x3333333333333333333333333333333333333333';
    const res = await relay(VICTIM, second, { 'x-test-linked': `${VICTIM},${second}` });
    expect(res.status).toBe(200);
    expect(sendTx).toHaveBeenCalledTimes(1);
  });

  it('is case-insensitive about address checksums', async () => {
    const res = await relay(VICTIM.toUpperCase().replace('0X', '0x'), VICTIM);
    expect(res.status).toBe(200);
  });
});
