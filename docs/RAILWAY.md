# Deploying the backend on Railway

The backend deploys to Railway from `backend/Dockerfile` (the same image
`docker-compose.yml` builds). Two config-as-code files sit next to it:

| File | Service | Starts |
|---|---|---|
| `backend/railway.json` | `api` | `node dist/index.js`, health-checked on `/health` |
| `backend/railway.indexer.json` | `indexer` (optional) | `node dist/indexer.js`, no HTTP |

Everything the image needs is under `backend/`. Nothing outside it is read at
build or run time, because contract addresses are compiled into
`src/contractAddresses.ts`.

## 1. Create the `api` service

1. In a Railway project, add a new service and pick this GitHub repo.
2. Open the service's **Settings**:
   - **Root Directory:** `/backend`
   - **Config file path:** `/backend/railway.json`. Railway doesn't resolve
     the config file relative to the root directory, so give the full path
     from the repo root.
   - **Branch:** the branch production deploys from.
3. Under **Networking**, generate a domain. Later, add the custom domain
   `api.blindmarket.xyz` and point its DNS CNAME at the target Railway shows
   (see step 5).

You don't need to set `PORT`. Railway injects it, and `config.port` reads it
(`src/config.ts`, default `3001`).

## 2. Environment variables

Copy the production values from the current host. `backend/.env.example` lists
every variable with notes. The ones a boot depends on:

| Variable | Notes |
|---|---|
| `NODE_ENV` | `production`. The Dockerfile doesn't set it. Without it the stack boots on testnet defaults. |
| `PRIVY_APP_ID` | The only hard `required()` var. Boot throws without it. |
| `REDIS_URL` | See step 3. |
| `DATABASE_URL` | Postgres (Neon today). If unset, the backend falls back to SQLite under `/app/data`. |
| `CORS_ORIGIN`, `FRONTEND_URL` | The web app's origin(s). |
| `PUBLIC_API_URL`, `PUBLIC_APP_URL` | Production defaults to `api.blindmarket.xyz` / `blindmarket.xyz` when unset. |
| `MARKETPLACE_SIGNER_PRIVATE_KEY`, `BASE_MARKETPLACE_SIGNER_PRIVATE_KEY`, … | The chain keys and RPC URLs, same as the current deploy. |
| `SENTRY_DSN` | Optional. |

Store keys as Railway **sealed** variables where you can.

## 3. Redis and Postgres

**Easiest cutover: keep the existing Redis Cloud and Neon.** Set the same
`REDIS_URL` and `DATABASE_URL` the current host uses. That moves only compute
and needs no data migration.

**Or use Railway-managed instances:** add the Redis / Postgres templates to
the project and reference them:

```
REDIS_URL=${{Redis.REDIS_URL}}?family=0
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

- `?family=0` lets ioredis resolve the IPv6-only `*.railway.internal`
  hostnames that older Railway environments use. ioredis reads options from
  the URL query string.
- `services/neonDb.ts` connects with TLS unless the URL carries
  `sslmode=disable`. If the private Postgres refuses TLS, append
  `?sslmode=disable` (traffic stays on Railway's private network).
- Moving data off Redis Cloud and Neon is a separate job: Redis state
  (`npm run migrate:redis` exists for Redis → Redis), plus a Postgres
  dump/restore. Plan it before you switch the URLs.

**Volume:** with `DATABASE_URL` set, the stores this was checked against
(`creditLedger.ts` and others) take the Postgres path, so a volume is optional.
If you run without `DATABASE_URL`, mount a volume at `/app/data`, or the SQLite
file is lost on every deploy.

## 4. Optional: a separate indexer

By default (`RUN_MODE` unset = `all`), one `api` service serves HTTP and runs
the chain indexers. To split them, as `docker-compose.yml` does:

1. Duplicate the `api` service and name it `indexer`. Set its config file path
   to `/backend/railway.indexer.json` and remove its public domain.
2. Set `RUN_MODE=indexer` on `indexer` and `RUN_MODE=api` on `api`. Both need
   the same variables, including the same `REDIS_URL` and `DEPLOYMENT_ID`.
3. Keep `indexer` at **one replica**.

`indexer.ts` exits immediately unless `RUN_MODE=indexer`, so a misconfigured
indexer fails loudly rather than double-polling.

## 5. Cutting over from the current host

- **Don't run two production backends against the same Redis and Postgres at
  once.** Both would carry `DEPLOYMENT_ID=production`, and the identity check
  (`services/deploymentIdentity.ts`) is designed to let a production stack
  take its Redis back. Two of them would each run the background writers and
  agent reconcile. This is inferred from the code, not observed. Bring Railway
  up on its generated domain first (`GET /health`, `GET /health/bridge`), then
  stop the old service, then move DNS.
- After the move, `.github/workflows/uptime.yml` (the Render keep-warm ping)
  is no longer needed for cold starts. Railway services don't sleep unless
  serverless/app sleeping is enabled. Keep the workflow as an external
  monitor, and update its comments.
- Each deploy fully replaces the container, so hosted agents (forked
  `agents/worker.js` processes) restart, just as with
  `docker compose up --force-recreate`.

## What was checked

- `npm ci` + `tsc` + the Dockerfile's copy steps build `dist/` cleanly.
  `node dist/index.js` with an injected `PORT` binds it and `GET /health`
  returns 200. `node dist/indexer.js` with `RUN_MODE=indexer` starts its three
  loops and stops cleanly on SIGTERM. This was run locally on Node 22, not on
  Railway.
- The full `docker build` could not be run in the sandbox it was written in
  (no access to Debian's apt mirror). Railway's first build is its first real
  run.
- The Railway config keys and the monorepo behaviour above come from Railway's
  documented config-as-code format. They weren't checked against the live docs
  at the time of writing.
