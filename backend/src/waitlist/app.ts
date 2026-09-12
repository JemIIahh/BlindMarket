import express from 'express';
import helmet from 'helmet';
import { waitlistConfig } from './config.js';
import { waitlistRouter } from './router.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import type { ApiErrorResponse } from '../types.js';

/**
 * The whole waitlist service: the waitlist API and a health check — nothing
 * from the marketplace (no marketplace routes, config, database or chain
 * pollers). Runs as its own process via server.ts, so it deploys and scales
 * independently of the BlindMarket backend.
 */
export function createWaitlistApp(): express.Express {
  const app = express();
  app.set('trust proxy', waitlistConfig.trustProxy);
  app.use(helmet());

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/api/v1/waitlist', waitlistRouter);

  app.use((_req, res) => {
    const body: ApiErrorResponse = { success: false, error: { code: 'NOT_FOUND', message: 'Not found' } };
    res.status(404).json(body);
  });
  app.use(globalErrorHandler);
  return app;
}
