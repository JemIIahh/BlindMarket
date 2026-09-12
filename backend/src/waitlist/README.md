# Waitlist service

The API behind the BlindMarket waitlist landing page ([`waitlist/`](../../../waitlist/) at the repo root): signups, positions, referrals and the public leaderboard.

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
| `WAITLIST_DATABASE_URL` | yes | — | Any Postgres 12+, no extensions needed. `sslmode` in the URL means what it means for `psql`: unset or `require` → TLS without certificate verification (works with managed hosts' private CAs); `verify-full` → TLS with verification; `disable` → no TLS (local, or a host's private network). |
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
| `POST /api/v1/waitlist/join` | `{ email, xHandle, tasks?, ref? }` → 201 with the standing and a one-time token, or 200 `{ alreadyJoined: true }` — nothing about an existing signup (no handle, points or position) without its token |
| `GET /api/v1/waitlist/me` | `Authorization: Bearer <token>` → position, points, referral code and count |
| `POST /api/v1/waitlist/me/tasks` | `Authorization: Bearer <token>`, `{ task }` — e.g. the comment bonus |

Limits per visitor IP: 10 signups / 10 min, 60 `/me` reads / min, 300 cached reads / min, and at most 5 **credited referrals** per connection per day (IPv6: per /64) — signups past that still go through, they just credit nobody. Bodies over 4 kB are refused.

A database connection dropped while idle (restart, failover) is logged and replaced on the next query; it doesn't take the service down.

## Deploy (a new service — the marketplace deploy is untouched)

1. **Database** — create a small Postgres for the waitlist (a new one, not the marketplace's). Copy its connection URL.
2. **Service** — create a new service from this repo, root directory `backend`, then either:
   - **Docker:** Dockerfile path `Dockerfile.waitlist` (it only ever starts the waitlist), or
   - **Buildpack:** install `npm ci`, start command `npm run start:waitlist`.

   Don't reuse the marketplace's `Dockerfile` — that one starts the marketplace.
3. **Variables** — `WAITLIST_DATABASE_URL=<url from step 1>`, `NODE_ENV=production`, and `WAITLIST_CORS_ORIGIN` if the page won't be at `https://waitlist.blindmarket.xyz`.
4. **Health check** — path `/health`.
5. **Domain** — give the service `waitlist-api.blindmarket.xyz` (the landing page calls `https://waitlist-api.blindmarket.xyz/api/v1/waitlist`), and add the DNS record the host asks for.
6. **Page** — host the repo's [`waitlist/`](../../../waitlist/) folder as a static site at `waitlist.blindmarket.xyz` (root directory `waitlist`, no build step).
7. **Check** — `curl https://waitlist-api.blindmarket.xyz/health` → `{"ok":true}`, then open the page and sign up once.

## Spot-checking the front of the line

X tasks are self-reported (the page asks "Done it? Yes" — nothing checks X), so before an access wave goes out, check the front of the line by hand:

```sh
cd backend
WAITLIST_DATABASE_URL=… npm run waitlist:admin -- top 50          # readable table
WAITLIST_DATABASE_URL=… npm run waitlist:admin -- top 50 --csv    # spreadsheet: one "yes" column per claimed task
```

The output lists the X pages to check against. Open them **logged in as @blindmarkt** — X only shows a post's likes to its author:

- follows — `https://x.com/blindmarkt/followers`
- likes — `https://x.com/blindmarkt/status/2098305130835607945/likes`
- reposts — `https://x.com/blindmarkt/status/2098305130835607945/retweets`
- replies — the post itself

For anyone whose claim doesn't check out, take those tasks back by signup id (the `id` column):

```sh
WAITLIST_DATABASE_URL=… npm run waitlist:admin -- revoke 42 like repost
```

Task points are recomputed from what's left (referral credit is untouched) and the public leaderboard catches up within 10 seconds. The export contains emails — keep it internal. If the post the page links to ever changes, update it in both `waitlist/index.html` and `X_POST_ID` in `admin.ts`.

## Tests

`npx vitest run src/waitlist` — route tests (`router.test.ts`) and whole-service tests (`app.test.ts`: health, only-waitlist routes, CORS, per-visitor limits behind a proxy, and tripwires on marketplace imports), the TLS settings (`db.test.ts`) and the admin tool's parsing and exports (`admin.test.ts`). The ranking and referral SQL is exercised against a real Postgres separately.
