import { waitlistConfig } from './config.js';
import { createWaitlistApp } from './app.js';
import { getWaitlistPool, closeWaitlistPool } from './db.js';

/**
 * Entry point for the standalone waitlist service:
 *
 *   WAITLIST_DATABASE_URL=postgres://… npm run start:waitlist
 *
 * See src/waitlist/README.md for the full list of settings.
 */
async function main(): Promise<void> {
  // A signup must never look recorded when it wasn't — no database, no service.
  if (!waitlistConfig.databaseUrl) {
    console.error('[waitlist] WAITLIST_DATABASE_URL is not set — refusing to start without a database');
    process.exit(1);
  }

  // Connect and migrate before taking traffic, so no visitor waits on (or
  // trips over) schema setup. A failure here exits, and the host restarts us.
  await getWaitlistPool();

  const server = createWaitlistApp().listen(waitlistConfig.port, () => {
    console.log(`BlindMarket waitlist listening on port ${waitlistConfig.port} (${waitlistConfig.nodeEnv})`);
  });

  const shutdown = (signal: string) => {
    console.log(`[waitlist] ${signal} — finishing in-flight requests`);
    server.close(() => {
      void closeWaitlistPool().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[waitlist] failed to start:', err);
  process.exit(1);
});
