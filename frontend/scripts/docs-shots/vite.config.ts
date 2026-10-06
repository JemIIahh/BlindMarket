/**
 * Vite config for the docs-screenshot build of the web app.
 *
 * The app's own config (frontend/vite.config.ts) with three changes, none of
 * which touch frontend/src:
 *  - `@privy-io/react-auth`, `@privy-io/wagmi`, `wagmi`, `socket.io-client`
 *    and `@vercel/analytics/react` resolve to the stubs in ./stubs (exact-match
 *    aliases, so subpaths still reach the real packages);
 *  - the env is set here and nowhere else: envDir points at this folder, which
 *    has no .env files, so frontend/.env (real app ids, RPC URLs) never loads;
 *  - the API lives at a fake origin that capture.mjs answers from ./fixtures.
 *
 * Run through capture.mjs, or by hand from frontend/:
 *   npx vite --config scripts/docs-shots/vite.config.ts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import appConfig from '../../vite.config';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(here, '../..');

export const DOCS_API_ORIGIN = 'http://docs-api.test';
export const DOCS_SHOTS_PORT = Number(process.env.DOCS_SHOTS_PORT || 5199);

// Vite reads VITE_* from process.env as well as .env files; with envDir here
// (no .env files), these are the only values the build sees.
const env: Record<string, string> = {
  VITE_API_URL: DOCS_API_ORIGIN,
  VITE_PRIVY_APP_ID: 'docs-shots-demo',
  // Production settles on Arc mainnet (GET /health/settlement): chain 5042.
  VITE_NETWORK: 'mainnet',
  VITE_ACTIVE_CHAIN: 'arc',
  VITE_FOUNDER_ADDRESSES: '',
  VITE_SENTRY_DSN: '',
};
for (const [key, value] of Object.entries(env)) process.env[key] = value;

const stub = (file: string) => path.join(here, 'stubs', file);

export default defineConfig({
  plugins: appConfig.plugins,
  root: frontend,
  envDir: here,
  // Its own dependency cache, so the app's `npm run dev` cache is never rebuilt.
  cacheDir: path.join(frontend, 'node_modules/.vite-docs-shots'),
  resolve: {
    alias: [
      { find: /^@privy-io\/react-auth$/, replacement: stub('privy.tsx') },
      { find: /^@privy-io\/wagmi$/, replacement: stub('privy-wagmi.tsx') },
      { find: /^wagmi$/, replacement: stub('wagmi.ts') },
      { find: /^socket\.io-client$/, replacement: stub('socket-io.ts') },
      { find: /^@vercel\/analytics\/react$/, replacement: stub('vercel-analytics.tsx') },
    ],
  },
  server: {
    host: '127.0.0.1',
    port: DOCS_SHOTS_PORT,
    strictPort: true,
    // No proxy: every API call goes to DOCS_API_ORIGIN and is answered by capture.mjs.
    proxy: {},
    hmr: false,
  },
  logLevel: 'warn',
});
