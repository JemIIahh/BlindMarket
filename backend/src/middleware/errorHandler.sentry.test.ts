import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import * as Sentry from '@sentry/node';
import {
  AppError,
  agentFingerprint,
  globalErrorHandler,
  initSentry,
  routeTag,
  scrubText,
  serverlessErrorHandler,
} from './errorHandler.js';

/**
 * Probe, not a mock: the REAL Sentry SDK is initialised through the REAL
 * initSentry (fake DSN, in-memory transport), errors go through the REAL
 * globalErrorHandler behind a real express.json(), and the assertions run over
 * the serialized envelope — the bytes that would have left the process.
 */

const BEARER = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIweGFiYyIsInR5cCI6ImFnZW50In0.c2lnbmF0dXJlLXNpZ25hdHVyZQ';
const BODY_FRAGMENT = 'my secret brief text';
const PRIVATE_KEY = 'a3f1c29e8b7d4056a3f1c29e8b7d4056a3f1c29e8b7d4056a3f1c29e8b7d4056';
const PUBLIC_KEY = `04${'9b'.repeat(64)}`;
const RPC_KEY = 'Zk3vQ9pLm2Xr7TfWc5Nb8HsJd4Ye6Ua1';
const RPC_URL = `https://base-mainnet.g.alchemy.com/v2/${RPC_KEY}`;
const QUICKNODE_KEY = '0d5e1f7a9c3b4e6f8a2d1c0b9e8f7a6d5c4b3a29';
const WALLET = '0x52908400098527886E0F7030069857D2E4169EE7';
const TASK_HASH = `0x${'7c'.repeat(32)}`;
const WRAPPED_KEY_B64 = 'QmFzZTY0V3JhcHBlZEtleU1hdGVyaWFsVGhhdElzTG9uZ0Vub3VnaFRvQmVDYXVnaHRCeVRoZVNjcnViYmVyMTIzNDU2Nzg5MA==';

const SECRETS = [
  BEARER, BODY_FRAGMENT, PRIVATE_KEY, PUBLIC_KEY, RPC_KEY, QUICKNODE_KEY,
  WALLET, WALLET.toLowerCase(), WALLET.slice(2).toLowerCase(), TASK_HASH, WRAPPED_KEY_B64,
  'hunter2', 'apikey=', 'cookie-secret', 'x-custom-secret',
];

const sent: string[] = [];

function expectClean(serialized: string): void {
  const haystack = serialized.toLowerCase();
  for (const secret of SECRETS) {
    expect(haystack.includes(secret.toLowerCase()), `envelope leaked ${secret.slice(0, 24)}…`).toBe(false);
  }
}

/** Every event item in every envelope sent so far. */
function events(): any[] {
  const out: any[] = [];
  for (const raw of sent) {
    const [, items] = JSON.parse(raw) as [unknown, Array<[{ type: string }, unknown]>];
    for (const [header, payload] of items) if (header.type === 'event') out.push(payload);
  }
  return out;
}

function ethersServerError(): Error {
  // Shape and message format of ethers v6 makeError('…', 'SERVER_ERROR', info).
  const info = { requestUrl: RPC_URL, responseBody: `{"error":"bad key ${RPC_KEY}"}`, responseStatus: '401 Unauthorized' };
  const err = new Error(
    `server response 401 Unauthorized (request={  }, response={  }, error=null, info={ "requestUrl": "${info.requestUrl}", ` +
      `"responseBody": ${JSON.stringify(info.responseBody)}, "responseStatus": "${info.responseStatus}" }, code=SERVER_ERROR, version=6.13.0)`,
  );
  Object.assign(err, { code: 'SERVER_ERROR', info, request: { url: RPC_URL }, secretProp: PRIVATE_KEY });
  return err;
}

function app(handler = globalErrorHandler) {
  const a = express();
  a.use(express.json());
  const agent = (req: any, _res: any, next: any) => {
    req.user = { address: WALLET, typ: 'agent' };
    next();
  };
  const api = express.Router();
  api.post('/cause/:id', agent, () => {
    const cause = new Error(`upstream refused Authorization: Bearer ${BEARER} for ${WALLET}`);
    throw Object.assign(new Error(`settlement failed for task ${TASK_HASH} signer key ${PRIVATE_KEY}`), { cause });
  });
  api.post('/rpc', () => { throw ethersServerError(); });
  api.post('/keys', () => {
    throw new AppError(
      503,
      'BRIDGE_FAILED',
      `rewrap failed pub=${PUBLIC_KEY} wrapped=${WRAPPED_KEY_B64} via https://user:hunter2@rpc.internal/path/deep?apikey=abc ` +
        `and https://quaint-cool.base.quiknode.pro/${QUICKNODE_KEY}/`,
    );
  });
  api.post('/parse', () => { JSON.parse(`{"brief": ${BODY_FRAGMENT}`); });
  api.post('/upstream-401', () => { throw Object.assign(new Error('provider said no'), { status: 401 }); });
  api.post('/client', () => { throw new AppError(409, 'NOT_OPEN', `not open for ${WALLET}`); });
  api.post('/files/*', () => { throw new Error('wildcard boom'); });
  api.post('/echo', (req, res) => { res.json({ ok: true, body: req.body }); });
  a.use('/api/v1/probe', api);
  a.use(handler);
  return a;
}

const post = (path: string, a = app()) =>
  request(a)
    .post(path)
    .set('Authorization', `Bearer ${BEARER}`)
    .set('Cookie', 'session=cookie-secret')
    .set('X-Custom-Secret', 'x-custom-secret');

beforeAll(() => {
  initSentry('https://public@o0.ingest.sentry.invalid/1', 'test', () => ({
    send: async (envelope) => {
      sent.push(JSON.stringify(envelope));
      return { statusCode: 200 };
    },
    flush: async () => true,
  }));
});

beforeEach(() => { sent.length = 0; });

afterAll(async () => { await Sentry.close(500); });

describe('Sentry envelope probe (real SDK, real handler, in-memory transport)', () => {
  it('scrubs the exception message AND its cause chain; tags a fingerprint, not the address', async () => {
    const res = await post(`/api/v1/probe/cause/${TASK_HASH}?token=${BEARER}`).send({ brief: BODY_FRAGMENT, key: PRIVATE_KEY });
    expect(res.status).toBe(500);
    await Sentry.flush(1000);

    expect(sent.length).toBeGreaterThan(0);
    for (const raw of sent) expectClean(raw);

    const [event] = events();
    // linkedErrorsIntegration put the cause in the same list — both scrubbed.
    expect(event.exception.values).toHaveLength(2);
    const values = event.exception.values.map((v: any) => v.value).join(' | ');
    expect(values).toContain('Bearer [redacted]');
    expect(values).toContain('[hex:64]');
    expect(values).toContain('[hex:40]');
    expect(event.tags.agent).toBe(agentFingerprint(WALLET));
    expect(event.tags.agent).toMatch(/^[0-9a-f]{8}$/);
    expect(event.tags.route).toBe('POST /api/v1/probe/cause/:id');
    expect(event.request).toBeUndefined();
    expect(event.user).toBeUndefined();
  });

  it('ethers SERVER_ERROR: the RPC URL is cut to origin + first segment, custom props never ship', async () => {
    await post('/api/v1/probe/rpc').send({});
    await Sentry.flush(1000);

    expect(sent.length).toBeGreaterThan(0);
    for (const raw of sent) expectClean(raw);
    // The whole ethers detail block goes; short message + code stay.
    expect(events()[0].exception.values[0].value).toBe('server response 401 Unauthorized (code=SERVER_ERROR)');
  });

  it('captured AppError 5xx: public key, base64 wrapped key, URL userinfo/query and a key-as-first-segment are gone', async () => {
    const res = await post('/api/v1/probe/keys').send({});
    expect(res.status).toBe(503);
    await Sentry.flush(1000);

    expect(sent.length).toBeGreaterThan(0);
    for (const raw of sent) expectClean(raw);
    const value: string = events()[0].exception.values[0].value;
    expect(value).toContain('[hex:130]');
    expect(value).toContain('[blob]');
    expect(value).toContain('https://rpc.internal/path/[…]');
    expect(value).toContain('https://quaint-cool.base.quiknode.pro/[…]');
  });

  it('a server-side JSON.parse failure is captured with the quoted fragment redacted', async () => {
    const res = await post('/api/v1/probe/parse').send({});
    expect(res.status).toBe(500);
    await Sentry.flush(1000);

    expect(sent.length).toBeGreaterThan(0);
    for (const raw of sent) expectClean(raw);
    expect(events()[0].exception.values[0].value).toBe('[json parse error — detail redacted]');
  });

  it('malformed request JSON → 400 INVALID_JSON, body not echoed, NOTHING captured', async () => {
    const res = await post('/api/v1/probe/echo').set('Content-Type', 'application/json').send(BODY_FRAGMENT);
    await Sentry.flush(1000);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
    expect(JSON.stringify(res.body)).not.toContain(BODY_FRAGMENT);
    expect(sent).toHaveLength(0);
  });

  it('oversized body → 413, not captured', async () => {
    const res = await post('/api/v1/probe/echo').send({ blob: 'x'.repeat(200 * 1024) });
    await Sentry.flush(1000);

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(sent).toHaveLength(0);
  });

  it('AppError 4xx is not captured', async () => {
    const res = await post('/api/v1/probe/client').send({});
    await Sentry.flush(1000);

    expect(res.status).toBe(409);
    expect(sent).toHaveLength(0);
  });

  it('a bare upstream `status: 401` is OUR failure: stays a captured 500, not a 401 to the caller', async () => {
    const res = await post('/api/v1/probe/upstream-401').send({});
    await Sentry.flush(1000);

    expect(res.status).toBe(500);
    expect(events()).toHaveLength(1);
  });

  it('wildcard route: the tag carries no raw path segment', async () => {
    await post(`/api/v1/probe/files/${WALLET}/${PRIVATE_KEY}`).send({});
    await Sentry.flush(1000);

    expect(sent.length).toBeGreaterThan(0);
    for (const raw of sent) expectClean(raw);
    expect(events()[0].tags.route).toBe('POST (unmatched)');
  });

  it('serverless handler flushes BEFORE it responds', async () => {
    const res = await post('/api/v1/probe/rpc', app(serverlessErrorHandler)).send({});

    // No Sentry.flush() here: the event must already be out when the response lands.
    expect(res.status).toBe(500);
    expect(events()).toHaveLength(1);
    for (const raw of sent) expectClean(raw);
  });
});

describe('scrubText', () => {
  it('redacts every body-parser / V8 JSON error shape wholesale', () => {
    for (const msg of [
      `Unexpected token 'm', "${BODY_FRAGMENT}" is not valid JSON`,
      `Unexpected token m in JSON at position 0`,
      `Expected ',' or '}' after property value in JSON at position 20 (line 1 column 21)`,
      'Unexpected end of JSON input',
      `Unexpected non-whitespace character after JSON at position 4`,
      `Unterminated string in JSON at position 12`,
    ]) expect(scrubText(msg)).toBe('[json parse error — detail redacted]');
  });

  it('keeps ordinary messages readable', () => {
    expect(scrubText('Bridge disabled for base: signer not configured')).toBe('Bridge disabled for base: signer not configured');
    expect(scrubText('task 42 is on-chain status 3 (not Funded)')).toBe('task 42 is on-chain status 3 (not Funded)');
    expect(scrubText('GET https://evmrpc.0g.ai failed')).toBe('GET https://evmrpc.0g.ai failed');
    expect(scrubText('GET https://evmrpc.0g.ai/ failed')).toBe('GET https://evmrpc.0g.ai/[…] failed');
  });

  it('redacts bearer tokens, bare JWTs, provider keys, and hex of address length and up', () => {
    expect(scrubText(`Authorization: bearer abc.def-ghi`)).toBe('Authorization: Bearer [redacted]');
    expect(scrubText(`token ${BEARER} expired`)).toBe('token [jwt] expired');
    expect(scrubText('Incorrect API key provided: sk-proj-abcdefghijklmnop1234')).toBe('Incorrect API key provided: [key]');
    expect(scrubText(`key_${PRIVATE_KEY}`)).toBe('key_[hex:64]');
    expect(scrubText(`worker ${WALLET} refused`)).toBe('worker [hex:40] refused');
    expect(scrubText('selector 0x24663556 NotVerifier')).toBe('selector 0x24663556 NotVerifier');
  });

  it('cuts an RPC URL to origin + first segment, and catches a bare 32-char API key', () => {
    expect(scrubText(`could not reach ${RPC_URL}`)).toBe('could not reach https://base-mainnet.g.alchemy.com/v2/[…]');
    expect(scrubText(`{"error":"bad key ${RPC_KEY}"}`)).toBe('{"error":"bad key [token]"}');
    expect(scrubText('a2aExpirySweepGasLivenessReconcileBroadcastAssignment')).toBe('a2aExpirySweepGasLivenessReconcileBroadcastAssignment');
  });

  it('strips websocket and userinfo URLs too, and caps length', () => {
    expect(scrubText(`wss://u:p@ws.example.com/socket/abc?k=1`)).toBe('wss://ws.example.com/socket/[…]');
    const long = scrubText('x '.repeat(1000));
    expect(long.length).toBeLessThan(330);
    expect(long.endsWith('…[truncated]')).toBe(true);
  });

  it('tolerates non-strings', () => {
    expect(scrubText(undefined)).toBe('');
    expect(scrubText(404)).toBe('404');
  });
});

describe('routeTag', () => {
  const req = (method: string, originalUrl: string, path?: unknown) =>
    ({ method, originalUrl, route: path === undefined ? undefined : { path } }) as any;

  it('emits the pattern with its static mount', () => {
    expect(routeTag(req('POST', '/api/v1/agents/abc123?x=1', '/:id'))).toBe('POST /api/v1/agents/:id');
    expect(routeTag(req('GET', '/health', '/'))).toBe('GET /health');
  });

  it('never emits raw segments for wildcard, regex, array or over-long patterns', () => {
    expect(routeTag(req('GET', `/api/v1/files/${WALLET}/x`, '/*splat'))).toBe('GET (unmatched)');
    expect(routeTag(req('GET', `/api/v1/files/${WALLET}`, '*'))).toBe('GET (unmatched)');
    expect(routeTag(req('GET', `/api/v1/files/${WALLET}`, '/{:opt}'))).toBe('GET (unmatched)');
    expect(routeTag(req('GET', `/api/v1/files/${WALLET}`, /files/))).toBe('GET (unmatched)');
    expect(routeTag(req('GET', `/api/v1/files/${WALLET}`, ['/a', '/b']))).toBe('GET (unmatched)');
    expect(routeTag(req('GET', '/x', '/a/b/c'))).toBe('GET (unmatched)');
    expect(routeTag(req('GET', `/nope/${WALLET}`))).toBe('GET (unmatched)');
  });

  it('drops a mount prefix that carries caller input', () => {
    expect(routeTag(req('GET', `/api/v1/agents/${WALLET}/services/9`, '/services/:sid'))).toBe('GET (mount)/services/:sid');
  });
});

describe('agentFingerprint', () => {
  it('is stable, case-insensitive, 8 hex, and not a prefix of the address', () => {
    expect(agentFingerprint(WALLET)).toBe(agentFingerprint(WALLET.toLowerCase()));
    expect(agentFingerprint(WALLET)).toMatch(/^[0-9a-f]{8}$/);
    expect(WALLET.toLowerCase()).not.toContain(agentFingerprint(WALLET));
    expect(agentFingerprint(WALLET)).not.toBe(agentFingerprint(`${WALLET.slice(0, -1)}8`));
  });
});

describe('the three scrubText copies', () => {
  const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
  const sharedBody = (file: string) => {
    const m = /\/\/ >>> sentry-scrub shared body[\s\S]*?\/\/ <<< sentry-scrub shared body/.exec(readFileSync(file, 'utf8'));
    expect(m, `${file} has no marked scrub body`).not.toBeNull();
    return m![0];
  };
  const backend = sharedBody(here('./errorHandler.ts'));

  it('worker.js carries the same body', () => {
    expect(sharedBody(here('../../agents/worker.js'))).toBe(backend);
  });

  // The backend image ships without frontend/; everywhere else this runs.
  const frontendMain = here('../../../frontend/src/main.tsx');
  it.skipIf(!existsSync(frontendMain))('frontend main.tsx carries the same body', () => {
    expect(sharedBody(frontendMain)).toBe(backend);
  });
});
