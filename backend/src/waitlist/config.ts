/**
 * Settings for the standalone waitlist service (src/waitlist/server.ts).
 *
 * Deliberately NOT the marketplace's config.ts: that one loads backend/.env
 * and requires marketplace secrets at import time. Every variable here is
 * WAITLIST_-prefixed, so this service can never pick up the marketplace's
 * DATABASE_URL by accident — its data lives in its own database.
 */
const IS_PROD = process.env.NODE_ENV === 'production';

function list(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

export const waitlistConfig = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3100', 10),
  databaseUrl: process.env.WAITLIST_DATABASE_URL || '',
  // Origins allowed to call the API — the landing page's host. Development also
  // allows any localhost port (see router.ts).
  corsOrigin: list(process.env.WAITLIST_CORS_ORIGIN || (IS_PROD ? 'https://waitlist.blindmarket.xyz' : '')),
  // Proxy hops in front of the service (the host's load balancer). The per-IP
  // rate limits key on the client address Express derives from this: 0 behind
  // a proxy would rate-limit every visitor as one IP.
  trustProxy: parseInt(process.env.WAITLIST_TRUST_PROXY || '1', 10),
};
