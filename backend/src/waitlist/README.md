# Waitlist service

The API behind the BlindMarket waitlist landing page ([blindmarket-waitlist](https://github.com/JemIIahh/blindmarket-waitlist)): signups, positions, referrals and the public leaderboard.

It lives in this repo but runs as **its own process with its own database**. The marketplace (`src/index.ts`) never imports anything from `src/waitlist/`, and the waitlist never loads the marketplace's config, database, Redis or chain pollers — `app.test.ts` fails if it ever does. Deploying, restarting or breaking one can't affect the other.

## Run it

```sh
cd backend
WAITLIST_DATABASE_URL=postgres://user:pass@host:5432/waitlist npm run start:waitlist
```

On start it connects, creates its one table if needed (`db.ts`), then listens. It refuses to start without a database.

## Settings

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `WAITLIST_DATABASE_URL` | yes | — | Any Postgres 12+, no extensions needed. TLS is used by default; add `?sslmode=disable` for a database without TLS (local, or a host's private network). |
| `NODE_ENV` | in production | `development` | Set to `production` when deployed. `development` also accepts any `localhost` page origin. |
| `WAITLIST_CORS_ORIGIN` | no | `https://waitlist.blindmarket.xyz` in production | Comma-separated origins allowed to call the API — wherever the landing page is served. |
| `PORT` | no | `3100` | Most hosts inject this. |
| `WAITLIST_TRUST_PROXY` | no | `1` | Proxy hops in front of the service. Leave at `1` on Railway / Render / Fly / Heroku-style hosts; rate limits are per visitor only if this matches. |

Every name is `WAITLIST_`-prefixed on purpose: the service can't pick up the marketplace's `DATABASE_URL` by accident.

## Endpoints

| | |
| --- | --- |
| `GET /health` | `{ ok: true }` — use as the host's health check |
| `GET /api/v1/waitlist/stats` | `{ total }` (cached 10s) |
| `GET /api/v1/waitlist/leaderboard` | top 25: `{ rank, handle, points, referrals }` — never emails (cached 10s) |
| `POST /api/v1/waitlist/join` | `{ email, xHandle, tasks?, ref? }` → 201 with a one-time token, or 200 `alreadyJoined` |
| `GET /api/v1/waitlist/me` | `Authorization: Bearer <token>` → position, points, referral code and count |
| `POST /api/v1/waitlist/me/tasks` | `Authorization: Bearer <token>`, `{ task }` — e.g. the comment bonus |

Limits per visitor IP: 10 signups / 10 min, 60 `/me` reads / min, 300 cached reads / min. Bodies over 4 kB are refused.

## Deploy (a new service — the marketplace deploy is untouched)

1. **Database** — create a small Postgres for the waitlist (a new one, not the marketplace's). Copy its connection URL.
2. **Service** — create a new service from this repo, root directory `backend`, then either:
   - **Docker:** Dockerfile path `Dockerfile.waitlist` (it only ever starts the waitlist), or
   - **Buildpack:** install `npm ci`, start command `npm run start:waitlist`.

   Don't reuse the marketplace's `Dockerfile` — that one starts the marketplace.
3. **Variables** — `WAITLIST_DATABASE_URL=<url from step 1>`, `NODE_ENV=production`, and `WAITLIST_CORS_ORIGIN` if the page won't be at `https://waitlist.blindmarket.xyz`.
4. **Health check** — path `/health`.
5. **Domain** — give the service `waitlist-api.blindmarket.xyz` (the landing page calls `https://waitlist-api.blindmarket.xyz/api/v1/waitlist`), and add the DNS record the host asks for.
6. **Check** — `curl https://waitlist-api.blindmarket.xyz/health` → `{"ok":true}`, then open the page and sign up once.

## Tests

`npx vitest run src/waitlist` — route tests (`router.test.ts`) and whole-service tests (`app.test.ts`: health, only-waitlist routes, CORS, per-visitor limits behind a proxy, and tripwires on marketplace imports). The ranking and referral SQL is exercised against a real Postgres separately.
