import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * /api/v1/profile/avatar: a signed-in person sets only their own avatar, under
 * their posting address alone. Their other linked wallets never get a copy,
 * and there is no public read by address: the same face on two addresses
 * would tie those wallets to one account.
 */
const store = vi.hoisted(() => ({ rows: new Map<string, string>() }));

vi.mock('../services/redis.js', () => {
  const pipeline = () => {
    const ops: Array<() => [Error | null, unknown]> = [];
    const pipe = {
      get(key: string) {
        ops.push(() => [null, store.rows.get(key) ?? null]);
        return pipe;
      },
      set(key: string, value: string) {
        ops.push(() => {
          store.rows.set(key, value);
          return [null, 'OK'];
        });
        return pipe;
      },
      del(key: string) {
        ops.push(() => [null, store.rows.delete(key) ? 1 : 0]);
        return pipe;
      },
      exec: async () => ops.map((op) => op()),
    };
    return pipe;
  };
  return {
    redis: {
      get: async (key: string) => store.rows.get(key) ?? null,
      set: async (key: string, value: string) => {
        store.rows.set(key, value);
        return 'OK';
      },
      del: async (key: string) => (store.rows.delete(key) ? 1 : 0),
      pipeline,
    },
  };
});

// x-test-address: the session's address; x-test-addresses: its linked
// wallets, comma-separated. No header, no session.
vi.mock('../middleware/auth.js', async () => {
  const { AppError } = await import('../middleware/errorHandler.js');
  return {
    requireAuth: (req: any, _res: any, next: any) => {
      const address = req.headers['x-test-address'];
      if (!address) {
        next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
        return;
      }
      const linked = req.headers['x-test-addresses'];
      req.user = { address: String(address), ...(linked ? { addresses: String(linked).split(',') } : {}) };
      next();
    },
  };
});

const { profileRouter } = await import('./profile.js');
const { globalErrorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
app.use('/api/v1/profile', profileRouter);
app.use(globalErrorHandler);

const ME = '0x1111111111111111111111111111111111111111';
const MY_EMBEDDED = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const SOMEONE = '0x3333333333333333333333333333333333333333';
const AVATAR = { top: ['bob'], eyes: ['wink'], mouth: ['smile'], skinColor: ['d08b5b'], accessoriesProbability: 0 };

const key = (address: string) => `profile:avatar:${address.toLowerCase()}`;

beforeEach(() => store.rows.clear());

describe('PUT /api/v1/profile/avatar', () => {
  it("saves the avatar under the session's posting address only, never its other linked wallets", async () => {
    const res = await request(app)
      .put('/api/v1/profile/avatar')
      .set('x-test-address', ME)
      .set('x-test-addresses', `${ME},${MY_EMBEDDED}`)
      .send({ avatar: AVATAR });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ avatar: AVATAR, address: ME });
    expect([...store.rows.keys()]).toEqual([key(ME)]);
    expect(JSON.parse(store.rows.get(key(ME))!)).toEqual(AVATAR);
    expect(store.rows.has(key(MY_EMBEDDED))).toBe(false);
  });

  it("cannot set someone else's avatar: the body names no address, and there is no per-address write", async () => {
    const named = await request(app)
      .put('/api/v1/profile/avatar')
      .set('x-test-address', ME)
      .send({ avatar: AVATAR, address: SOMEONE });
    expect(named.status).toBe(400);
    expect(named.body.error.code).toBe('VALIDATION_ERROR');

    const byPath = await request(app).put(`/api/v1/profile/avatar/${SOMEONE}`).set('x-test-address', ME).send({ avatar: AVATAR });
    expect(byPath.status).toBe(404);

    expect(store.rows.has(key(SOMEONE))).toBe(false);
    expect(store.rows.size).toBe(0);
  });

  it('keeps the save to wallets the session proved, not addresses slipped into the avatar', async () => {
    const res = await request(app)
      .put('/api/v1/profile/avatar')
      .set('x-test-address', ME)
      .send({ avatar: { ...AVATAR, seed: SOMEONE } });
    expect(res.status).toBe(400);
    expect(store.rows.size).toBe(0);
  });

  it('an empty avatar resets it to the default face', async () => {
    store.rows.set(key(ME), JSON.stringify(AVATAR));
    const res = await request(app).put('/api/v1/profile/avatar').set('x-test-address', ME).send({ avatar: {} });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ avatar: null, address: ME });
    expect(store.rows.has(key(ME))).toBe(false);
  });

  it('requires a session', async () => {
    const res = await request(app).put('/api/v1/profile/avatar').send({ avatar: AVATAR });
    expect(res.status).toBe(401);
    expect(store.rows.size).toBe(0);
  });

  it('refuses a session with no wallet (the shared legacy agent key)', async () => {
    const res = await request(app).put('/api/v1/profile/avatar').set('x-test-address', 'agent').send({ avatar: AVATAR });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NO_WALLET');
    expect(store.rows.size).toBe(0);
  });

  it.each([
    ['no avatar', {}],
    ['a value outside the style', { avatar: { ...AVATAR, top: ['mohawk'] } }],
    ['an unknown option', { avatar: { ...AVATAR, radius: 50 } }],
    ['an oversized value', { avatar: { ...AVATAR, eyes: ['x'.repeat(5000)] } }],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await request(app).put('/api/v1/profile/avatar').set('x-test-address', ME).send(body);
    expect(res.status).toBe(400);
    expect(store.rows.size).toBe(0);
  });
});

describe('GET /api/v1/profile/avatar', () => {
  it('returns null and the posting address before an avatar is made', async () => {
    const res = await request(app).get('/api/v1/profile/avatar').set('x-test-address', ME);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ avatar: null, address: ME });
  });

  it('reads the posting address only, not a linked wallet', async () => {
    store.rows.set(key(MY_EMBEDDED), JSON.stringify(AVATAR));
    const res = await request(app)
      .get('/api/v1/profile/avatar')
      .set('x-test-address', ME)
      .set('x-test-addresses', MY_EMBEDDED);
    expect(res.body.data).toEqual({ avatar: null, address: ME });
    store.rows.set(key(ME), JSON.stringify(AVATAR));
    const mine = await request(app).get('/api/v1/profile/avatar').set('x-test-address', ME);
    expect(mine.body.data).toEqual({ avatar: AVATAR, address: ME });
  });

  it('requires a session', async () => {
    const res = await request(app).get('/api/v1/profile/avatar');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/profile/avatar/:address', () => {
  it('does not exist: an avatar is only public on the tasks it was posted with', async () => {
    store.rows.set(key(SOMEONE), JSON.stringify(AVATAR));
    const res = await request(app).get(`/api/v1/profile/avatar/${SOMEONE}`);
    expect(res.status).toBe(404);
  });
});
