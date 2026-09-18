import type { Request, Response, NextFunction } from 'express';
import * as Sentry from '@sentry/node';
import type { ApiErrorResponse, AuthRequest } from '../types.js';

/**
 * Error monitoring. No-op without a DSN: no init, no network, no warnings —
 * and every Sentry.capture* call below is inert until init has run.
 *
 * Errors only, and deliberately starved of request data: bodies can carry key
 * material, so the default integrations (http/console breadcrumbs, request
 * data, tracing) are all off and beforeSend drops whatever is left.
 */
export function initSentry(dsn: string, environment: string): void {
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
    beforeSend(event) {
      delete event.request;
      delete event.user;
      delete event.server_name;
      return event;
    },
  });
}

/**
 * Route PATTERN (`POST /api/v1/agents/:id`), never the concrete URL or its
 * query. req.baseUrl is already reset by the time the error handler runs, so
 * the (static) mount prefix is recovered by swapping the tail of the request
 * path for the matched pattern, segment for segment.
 */
function routeTag(req: Request): string {
  const pattern: unknown = req.route?.path;
  if (typeof pattern !== 'string') return `${req.method} (unmatched)`;
  const segments = req.originalUrl.split('?')[0].split('/').filter(Boolean);
  const tail = pattern.split('/').filter(Boolean);
  return `${req.method} /${[...segments.slice(0, segments.length - tail.length), ...tail].join('/')}`;
}

/** Custom error with HTTP status and error code */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

function captureServerError(err: Error, req: Request): void {
  Sentry.withScope((scope) => {
    scope.setTag('route', routeTag(req));
    // Agent-token principals only, and only the address — never the token.
    const user = (req as AuthRequest).user;
    if (user?.typ) scope.setTag('agent', user.address);
    Sentry.captureException(err);
  });
}

/** Global error handler — never leaks stack traces in production */
export function globalErrorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    if (err.statusCode >= 500) captureServerError(err, req);
    const body: ApiErrorResponse = {
      success: false,
      error: { code: err.code, message: err.message },
    };
    res.status(err.statusCode).json(body);
    return;
  }

  // Zod validation errors
  if (err.name === 'ZodError') {
    const body: ApiErrorResponse = {
      success: false,
      error: { code: 'VALIDATION_ERROR', message: err.message },
    };
    res.status(400).json(body);
    return;
  }

  console.error('[unhandled]', err);
  captureServerError(err, req);

  const body: ApiErrorResponse = {
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message:
        process.env.NODE_ENV === 'production'
          ? 'Internal server error'
          : err.message,
    },
  };
  res.status(500).json(body);
}
