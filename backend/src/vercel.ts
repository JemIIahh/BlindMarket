// Vercel serverless entry — exports Express app without .listen()
// Must precede every router: forwards async handler errors to next(err)
// instead of crashing the process (see middleware/asyncErrors.ts).
import './middleware/asyncErrors.js';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { serverlessErrorHandler, initSentry } from './middleware/errorHandler.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import { requestLogger } from './middleware/requestLogger.js';
import { healthRouter } from './routes/health.js';
import { tasksRouter } from './routes/tasks.js';
import { submissionsRouter } from './routes/submissions.js';
import { reputationRouter } from './routes/reputation.js';
import { storageRouter } from './routes/storage.js';
import { verificationRouter } from './routes/verification.js';
import { a2aRouter } from './routes/a2a.js';
import { a2aProtocolRouter } from './routes/a2aProtocol.js';
import { forensicsRouter } from './routes/forensics.js';
import { custodyRouter } from './routes/custody.js';
import { accountingRouter } from './routes/accounting.js';
import { agentsRouter } from './routes/agents.js';
import { registrationRouter } from './routes/registration.js';
import { validatorsRouter } from './routes/validators.js';
import { statsRouter } from './routes/stats.js';
import { analyticsRouter } from './routes/analytics.js';
import { txRouter } from './routes/tx.js';
import { profileRouter } from './routes/profile.js';
import { getDb } from './services/database.js';

// No-op without SENTRY_DSN.
initSentry(config.sentryDsn, config.sentryEnvironment);

const app = express();
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({
  origin: config.corsOrigin,
  credentials: true,
}));
app.use(createRateLimiter());
app.use(express.json({ limit: '15mb' }));
app.use(requestLogger);

app.use('/health', healthRouter);
// Also under /api/v1: the web app reads /api/v1/health/settlement (and
// every other client path is /api/v1/*). Mounted only at /health, that
// request 404'd, the app fell back to its build-time table, and posted
// in Base USDC to a backend that escrows on Arc (TOKEN_NOT_SETTLEMENT).
app.use('/api/v1/health', healthRouter);
app.use('/api/v1/tasks', tasksRouter);
app.use('/api/v1/submissions', submissionsRouter);
app.use('/api/v1/reputation', reputationRouter);
app.use('/api/v1/storage', storageRouter);
app.use('/api/v1/verification', verificationRouter);
app.use('/api/v1/a2a', a2aRouter);
app.use('/api/v1/forensics', forensicsRouter);
app.use('/api/v1/custody', custodyRouter);
// /api/v1/staking is unmounted: no client uses it, and it bound a stake to the
// caller instead of the task's executor, taking the reward from the request body
// (security audit run 1, C33). routes/staking.ts stays for a redesign.
app.use('/api/v1/accounting', accountingRouter);
app.use('/api/v1/agents', agentsRouter);
app.use('/api/v1/registration', registrationRouter);
app.use('/api/v1/validators', validatorsRouter);
app.use('/api/v1/stats', statsRouter);
app.use('/api/v1/analytics', analyticsRouter);
app.use('/api/v1/tx', txRouter);
app.use('/api/v1/profile', profileRouter);
app.use('/a2a/v1', a2aProtocolRouter);

// Flushes Sentry before responding — a serverless instance can freeze the
// moment the response is out, losing the queued event.
app.use(serverlessErrorHandler);

// Initialize database: SQLite when no DATABASE_URL (dev), PostgreSQL otherwise (prod)
if (!config.databaseUrl) {
  getDb();
} else {
  console.log('[db] DATABASE_URL set — using PostgreSQL');
}

export default app;
