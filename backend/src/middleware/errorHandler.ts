import { createHash } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import * as Sentry from '@sentry/node';
import type { ApiErrorResponse, AuthRequest } from '../types.js';

// ── Sentry scrub ────────────────────────────────────────────────────────────
// The platform never ships task plaintext, tokens or keys to a third party, and
// an exception MESSAGE is free text: body-parser quotes the request body, ethers
// embeds the RPC URL (API key in its path) and response body, and callers put
// bearer tokens and addresses in `cause` chains. Everything below runs in
// beforeSend over every string that reaches the event.
//
// backend/agents/worker.js and frontend/src/main.tsx cannot import this file and
// carry a copy each. The marked body is byte-identical in all three and
// errorHandler.sentry.test.ts fails when they drift; this copy is the one under
// test. No lookbehind: the frontend copy must parse on older Safari.
export function scrubText(input: unknown): string {
  let s = typeof input === 'string' ? input : String(input ?? '');
  // >>> sentry-scrub shared body — byte-identical in backend/agents/worker.js and frontend/src/main.tsx
  // A JSON parse error quotes the text it choked on — a request body, an LLM
  // reply, a decrypted brief. Nothing in it is worth keeping.
  if (/is not valid JSON|in JSON at position|Unexpected end of JSON|after JSON|JSON\.parse|Unexpected token .* JSON/i.test(s)) {
    return '[json parse error — detail redacted]';
  }
  // ethers v6 appends `(request={…}, info={ requestUrl, responseBody, … },
  // transaction={…}, code=X, version=…)`: RPC URLs, provider response bodies
  // and calldata. Only the short message and the code are kept.
  s = s.replace(/ \((?:[A-Za-z]+=[\s\S]*)?code=([A-Z_]+), version=[^)]*\)\s*$/, ' (code=$1)');
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');
  s = s.replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[jwt]');
  s = s.replace(/\b(?:sk|pk|rk|gsk|xai)[-_][A-Za-z0-9_-]{16,}/gi, '[key]');
  // URL → origin + first path segment. Userinfo, query, fragment and deeper
  // path go; so does a first segment long enough to be a key (…quiknode.pro/<key>/).
  s = s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#"'<>]*@)?([^\s/?#"'<>]+)([^\s"'<>]*)/gi, (_m, scheme, _userinfo, host, rest) => {
    const first = (/^\/([^/?#]*)/.exec(rest) || [])[1] || '';
    const keep = first && first.length < 16 ? `/${first}` : '';
    return `${scheme}${host}${keep}${rest.length > keep.length ? '/[…]' : ''}`;
  });
  // 32+ hex: API keys (32), addresses (40), tx hashes and private keys (64),
  // public keys (130), wrapped keys. A tx hash and a private key are
  // indistinguishable, so all of it goes; the length says which it was.
  s = s.replace(/(?:0x)?[0-9a-fA-F]{32,}/g, (m) => `[hex:${m.replace(/^0x/i, '').length}]`);
  // Long base64/base64url runs: wrapped keys, ciphertext, opaque tokens.
  s = s.replace(/[A-Za-z0-9+/_-]{64,}={0,2}/g, '[blob]');
  // Shorter opaque tokens (provider/RPC API keys are typically 32 chars): a
  // 32+ run with 4+ digits among mixed-case letters is not a word or identifier.
  s = s.replace(/[A-Za-z0-9_-]{32,}/g, (m) =>
    ((m.match(/[0-9]/g) || []).length >= 4 && /[a-z]/.test(m) && /[A-Z]/.test(m) ? '[token]' : m));
  return s.length > 300 ? `${s.slice(0, 300)}…[truncated]` : s;
  // <<< sentry-scrub shared body
}

/** beforeSend body, shared by initSentry and the tests. Mutates and returns. */
export function scrubEvent<T extends Sentry.ErrorEvent>(event: T): T {
  delete event.request;
  delete event.user;
  delete event.server_name;
  delete event.extra;
  if (typeof event.message === 'string') event.message = scrubText(event.message);
  // linkedErrorsIntegration appends every `cause` to this same list.
  for (const ex of event.exception?.values ?? []) {
    if (ex.value !== undefined) ex.value = scrubText(ex.value);
  }
  for (const crumb of event.breadcrumbs ?? []) {
    if (crumb.message !== undefined) crumb.message = scrubText(crumb.message);
    delete crumb.data;
  }
  return event;
}

// Fixed, public salt: the tag is a grouping key, not a secret. Eight hex of a
// salted hash cannot be read back as an address; someone holding a candidate
// address and this source could confirm a match, which is the accepted limit.
const AGENT_FINGERPRINT_SALT = 'blindmarket:sentry:agent:v1';

/** Stable 8-hex tag for an address: groups errors per agent without naming it. */
export function agentFingerprint(address: string): string {
  return createHash('sha256').update(`${AGENT_FINGERPRINT_SALT}:${address.toLowerCase()}`).digest('hex').slice(0, 8);
}

/**
 * Error monitoring. No-op without a DSN: no init, no network, no warnings —
 * and every Sentry.capture* call below is inert until init has run.
 *
 * Errors only, and deliberately starved of request data: bodies can carry key
 * material, so the default integrations (http/console breadcrumbs, request
 * data, tracing) are all off and beforeSend drops whatever is left.
 */
export function initSentry(
  dsn: string,
  environment: string,
  /** Tests inject an in-memory transport; production uses the default. */
  transport?: Sentry.NodeOptions['transport'],
): void {
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment,
    release: process.env.RENDER_GIT_COMMIT || process.env.COMMIT_SHA || undefined,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    maxBreadcrumbs: 0,
    skipOpenTelemetrySetup: true,
    defaultIntegrations: false,
    integrations: [
      Sentry.inboundFiltersIntegration(),
      Sentry.dedupeIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.onUncaughtExceptionIntegration(),
      // 'strict' captures, flushes, then exits — same outcome as Node 22's
      // default for an unhandled rejection, which the app relies on.
      Sentry.onUnhandledRejectionIntegration({ mode: 'strict' }),
    ],
    beforeSend: (event) => scrubEvent(event),
    ...(transport ? { transport } : {}),
  });
}

/** Serverless (vercel.ts): the instance may freeze once the response is out. */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  try {
    await Sentry.flush(timeoutMs);
  } catch { /* reporting must never fail a request */ }
}

/**
 * Route PATTERN (`POST /api/v1/agents/:id`), never the concrete URL or its
 * query. req.baseUrl is already reset by the time the error handler runs, so
 * the (static) mount prefix is recovered by swapping the tail of the request
 * path for the matched pattern, segment for segment.
 *
 * That swap is only sound when the pattern is a plain string of literal and
 * `:param` segments — one pattern segment per URL segment. A wildcard (`*`,
 * `*splat`, `(.*)`), an optional group, a RegExp or an array of paths can match
 * any number of URL segments, and the arithmetic would then leave raw caller
 * input (ids, addresses, file paths) in the tag. Those report as unmatched.
 */
const PLAIN_SEGMENT = /^(?::[A-Za-z_][A-Za-z0-9_]*|[A-Za-z0-9._~-]+)$/;

export function routeTag(req: Request): string {
  const unmatched = `${req.method} (unmatched)`;
  const pattern: unknown = req.route?.path;
  if (typeof pattern !== 'string') return unmatched;
  const tail = pattern.split('/').filter(Boolean);
  if (!tail.every((seg) => PLAIN_SEGMENT.test(seg))) return unmatched;
  const segments = (req.originalUrl ?? '').split('?')[0].split('/').filter(Boolean);
  if (tail.length > segments.length) return unmatched;
  const mount = segments.slice(0, segments.length - tail.length);
  // The mount prefix is static app wiring (`/api/v1/agents`). If it does not
  // look like that — a param-bearing mount put caller input here — drop it.
  if (!mount.every((seg) => /^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(seg) && !/[0-9a-fA-F]{16,}/.test(seg))) {
    return `${req.method} (mount)/${tail.join('/')}`;
  }
  return `${req.method} /${[...mount, ...tail].join('/')}`;
}

/** Custom error with HTTP status and error code */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    /** Machine-readable sub-reason for clients that must branch within one code. */
    public reason?: string,
    /**
     * Structured detail for clients, sent as `error.details`: the per-row
     * errors of a batch route ({ errors: [{ index, code, message }] }).
     * Server-written text only: never a secret or the raw input.
     */
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * 4xx status of an http-errors error (body-parser, raw-body, express itself).
 * `expose === true` is what http-errors sets on its 4xx errors and is required:
 * a bare `status` is not enough, because upstream SDK errors (an LLM provider's
 * 401/429) carry one too, and those are OUR failure — they stay a captured 500
 * rather than telling the caller their own credentials were refused.
 */
function clientStatusOf(err: unknown): number | undefined {
  const e = err as { status?: unknown; statusCode?: unknown; expose?: unknown };
  if (e?.expose !== true) return undefined;
  const status = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : undefined;
  return status !== undefined && status >= 400 && status < 500 ? status : undefined;
}

const CLIENT_ERROR_CODES: Record<string, { code: string; message: string }> = {
  'entity.parse.failed': { code: 'INVALID_JSON', message: 'Request body is not valid JSON' },
  'entity.too.large': { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' },
  'encoding.unsupported': { code: 'UNSUPPORTED_ENCODING', message: 'Unsupported content encoding' },
  'charset.unsupported': { code: 'UNSUPPORTED_CHARSET', message: 'Unsupported charset' },
  'request.aborted': { code: 'REQUEST_ABORTED', message: 'Request aborted' },
  'request.size.invalid': { code: 'BAD_REQUEST', message: 'Request size did not match Content-Length' },
};

function captureServerError(err: Error, req: Request): void {
  Sentry.withScope((scope) => {
    scope.setTag('route', routeTag(req));
    // Agent-token principals only, and only a fingerprint of the address —
    // never the address, never the token.
    const user = (req as AuthRequest).user;
    if (user?.typ && typeof user.address === 'string') scope.setTag('agent', agentFingerprint(user.address));
    Sentry.captureException(err);
  });
}

/**
 * An error message with infrastructure detail removed: ethers' shortMessage
 * (or the first line), without the request/response/info tail, with RPC URLs
 * masked. For upstream failures whose text is useful to the caller.
 */
export function safeErrorMessage(e: unknown): string {
  const err = (e ?? {}) as { message?: string; code?: string; shortMessage?: string };
  const base = String(err.shortMessage || err.message || e).split('\n')[0];
  const stripped = base
    .replace(/\s*\((?:request|response|info|transaction)=[\s\S]*$/, '')
    .replace(/https?:\/\/\S+/g, '<rpc>')
    .replace(/wss?:\/\/\S+/g, '<rpc>');
  return err.code && !stripped.includes(err.code) ? `${stripped} [${err.code}]` : stripped;
}

/**
 * The message a catch-all 5xx may show: an ethers error's short message, or in
 * production a generic string. Raw error text reached callers from several
 * handlers, including RPC request URLs and database hosts (security audit run
 * 1, C23). Log the original server-side before calling this.
 */
export function clientErrorMessage(e: unknown, fallback = 'Internal server error'): string {
  if (typeof (e as { shortMessage?: unknown } | null)?.shortMessage === 'string') return safeErrorMessage(e);
  return process.env.NODE_ENV === 'production' ? fallback : safeErrorMessage(e);
}

type Outcome = { status: number; body: ApiErrorResponse; capture: boolean };

/** Decide the response and whether Sentry hears about it. No side effects. */
function classify(err: Error): Outcome {
  if (err instanceof AppError) {
    return {
      status: err.statusCode,
      body: {
        success: false,
        error: {
          code: err.code,
          message: err.message,
          ...(err.reason ? { reason: err.reason } : {}),
          ...(err.details ? { details: err.details } : {}),
        },
      },
      capture: err.statusCode >= 500,
    };
  }

  // Zod validation errors
  if (err.name === 'ZodError') {
    return { status: 400, body: { success: false, error: { code: 'VALIDATION_ERROR', message: err.message } }, capture: false };
  }

  // The client's fault (malformed JSON, oversized body, aborted upload, …): a
  // 4xx, never captured — an unauthenticated caller must not be able to push
  // body fragments into Sentry or burn its quota. The library message is NOT
  // echoed: body-parser's quotes the body.
  const clientStatus = clientStatusOf(err);
  const type = (err as { type?: unknown }).type;
  const known = typeof type === 'string' ? CLIENT_ERROR_CODES[type] : undefined;
  if (clientStatus !== undefined || known) {
    return {
      status: clientStatus ?? 400,
      body: { success: false, error: known ?? { code: 'BAD_REQUEST', message: 'Bad request' } },
      capture: false,
    };
  }

  return {
    status: 500,
    body: {
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
      },
    },
    capture: true,
  };
}

function report(err: Error, req: Request, outcome: Outcome): void {
  if (!(err instanceof AppError) && outcome.status >= 500) console.error('[unhandled]', err);
  if (outcome.capture) captureServerError(err, req);
}

/** Global error handler — never leaks stack traces in production */
export function globalErrorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const outcome = classify(err);
  report(err, req, outcome);
  res.status(outcome.status).json(outcome.body);
}

/**
 * Same handler for a serverless entry: flush before responding, because the
 * platform may freeze the instance as soon as the response is written and the
 * queued event would be lost. Bounded, and only when something was captured.
 */
export function serverlessErrorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const outcome = classify(err);
  report(err, req, outcome);
  const respond = () => { res.status(outcome.status).json(outcome.body); };
  if (!outcome.capture) return respond();
  void flushSentry(2000).then(respond, respond);
}
