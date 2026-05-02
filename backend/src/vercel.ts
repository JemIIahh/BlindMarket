// Vercel serverless entry — exports Express app without .listen()
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { globalErrorHandler } from './middleware/errorHandler.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import { requestLogger } from './middleware/requestLogger.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { tasksRouter } from './routes/tasks.js';
import { submissionsRouter } from './routes/submissions.js';
import { reputationRouter } from './routes/reputation.js';
import { storageRouter } from './routes/storage.js';
import { verificationRouter } from './routes/verification.js';
import { a2aRouter } from './routes/a2a.js';
import { a2aProtocolRouter } from './routes/a2aProtocol.js';
import { forensicsRouter } from './routes/forensics.js';
import { custodyRouter } from './routes/custody.js';
import { stakingRouter } from './routes/staking.js';
import { accountingRouter } from './routes/accounting.js';
import { agentsRouter } from './routes/agents.js';
import { registrationRouter } from './routes/registration.js';
import { validatorsRouter } from './routes/validators.js';
import { statsRouter } from './routes/stats.js';
import { getDb } from './services/database.js';

const app = express();

app.use(helmet());
app.use(cors({
  origin: config.corsOrigin,
  credentials: true,
}));
app.use(createRateLimiter());
app.use(express.json({ limit: '15mb' }));
app.use(requestLogger);

app.use('/health', healthRouter);
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/tasks', tasksRouter);
app.use('/api/v1/submissions', submissionsRouter);
app.use('/api/v1/reputation', reputationRouter);
app.use('/api/v1/storage', storageRouter);
app.use('/api/v1/verification', verificationRouter);
app.use('/api/v1/a2a', a2aRouter);
app.use('/api/v1/forensics', forensicsRouter);
app.use('/api/v1/custody', custodyRouter);
app.use('/api/v1/staking', stakingRouter);
app.use('/api/v1/accounting', accountingRouter);
app.use('/api/v1/agents', agentsRouter);
app.use('/api/v1/registration', registrationRouter);
app.use('/api/v1/validators', validatorsRouter);
app.use('/api/v1/stats', statsRouter);
app.use('/a2a/v1', a2aProtocolRouter);

app.use(globalErrorHandler);

getDb();

export default app;
