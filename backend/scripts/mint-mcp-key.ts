/**
 * Mint a BlindMarket sk_ API key directly, bypassing the web UI.
 *
 * Why this exists: the Settings → Create key dialog hangs forever on
 * "CREATING…". Root cause is in frontend/src/lib/api.ts — authedPost awaits
 * getAuthHeaders(), which awaits Privy's getAccessToken(). When that promise
 * never settles the fetch is never issued, so Settings.tsx's
 * `finally { setCreating(false) }` never runs and the button stays stuck.
 * A request that actually fired would have failed fast and reset the button.
 *
 * This replicates services/apiKeyStore.ts createApiKey() exactly:
 *   raw    = 'sk_' + 32 random bytes, hex
 *   prefix = raw.slice(0,8) + '...'
 *   hash   = sha256(raw), hex        <- only the hash is stored
 *
 * The key is bound to the PRIVY EMBEDDED wallet. That matters: relay-tx signs
 * only from Privy embedded wallets, and lookupApiKey rebuilds the caller as
 * exactly one address — the key's owner — so a key bound to an external
 * wallet (OKX/MetaMask) can never relay.
 *
 * Run:  npx tsx backend/scripts/mint-mcp-key.ts
 *
 * Writes straight to Postgres with no auth, so it is a dev/operator tool, not
 * something to expose. DATABASE_URL defaults to the local docker Postgres.
 */
import { randomBytes, createHash } from 'node:crypto';
import pg from 'pg';

// Privy wallet created specifically for the MCP, owned by the "BlindMarket"
// key quorum (suudng3hc1dw6r2ednr37jgy) — the quorum holding the key in
// PRIVY_AUTHORIZATION_KEY. That match is what relay-tx needs: a wallet owned
// by any other quorum fails with "No valid authorization keys or user signing
// keys available", which is what the user's login wallet did.
//
// Deliberately NOT a personal wallet: an sk_ key is unrestricted authority
// over whatever wallet it is bound to (relay-tx does not consult the key's
// capabilities), so it gets a wallet of its own.
//
// Override with: OWNER=0x... npx tsx backend/scripts/mint-mcp-key.ts
const OWNER = process.env.OWNER ?? '0x86406368be315f02Fb36b319afF646341c0190c4';
const DB = process.env.DATABASE_URL ?? 'postgres://postgres:dev@localhost:55432/blindmarket?sslmode=disable';
const NAME = process.env.KEY_NAME ?? 'MCP Server';

if (!/^0x[0-9a-fA-F]{40}$/.test(OWNER)) {
  console.error('OWNER must be a 0x address');
  process.exit(1);
}

const raw = 'sk_' + randomBytes(32).toString('hex');
const prefix = raw.slice(0, 8) + '...';
const hash = createHash('sha256').update(raw, 'utf-8').digest('hex');

const pool = new pg.Pool({ connectionString: DB, ssl: false, connectionTimeoutMillis: 8000 });
try {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO api_keys (owner_address, name, key_prefix, key_hash, capabilities, agent_address)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [OWNER.toLowerCase(), NAME, prefix, hash, [], null],
  );

  console.log('');
  console.log('  Key created.  id=' + rows[0].id + '  owner=' + OWNER);
  console.log('');
  console.log('  Add this line to backend/.env — it is shown once:');
  console.log('');
  console.log('  BLINDMARKET_API_KEY=' + raw);
  console.log('');
} catch (e) {
  console.error('Failed: ' + e.message);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
