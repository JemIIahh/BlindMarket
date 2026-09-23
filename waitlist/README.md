# BlindMarket Waitlist — landing page

Single-page waitlist for [BlindMarket](https://blindmarket.xyz). Visitors do a few things on X, leave their X handle and email, and get a place in line they can improve by bringing in friends through a personal referral link. A public leaderboard shows the front of the line.

Static HTML/CSS/JS in one file (`index.html`), no build step. Serve this folder with any static host — opening `index.html` straight from disk can't sign anyone up, because a `file://` page sends `Origin: null` and the API rejects it.

## How the line works

- **Position** is a live rank: join order, moved up **10 places per point**, ties to whoever joined first. It shifts as others join and earn points.
- **X tasks** (self-reported): follow, like, repost — 1 pt each, required to submit — and an optional comment, 3 pts. Max 6 pts from tasks.
- **Referrals**: every signup gets a link like `https://waitlist.blindmarket.xyz/?ref=k7m2p9qa`. Each *new* signup made through it gives the referrer **+2 pts** (20 places), with no cap. The server credits it in the same statement that creates the signup, so it can't be claimed twice or sent from the browser; a repeat email never credits anyone.
- **Leaderboard**: the top 25 of that same line, showing X handle, referrals and points — never emails.

## Backend

Everything is served by the **standalone waitlist service** in [`backend/src/waitlist/`](../backend/src/waitlist/). It runs as its own server with its own small database, separate from the marketplace API, so it can go live (and be changed or restarted) without deploying or touching the marketplace. Settings, endpoints and deploy steps: [its README](../backend/src/waitlist/README.md).

The page stores the signup token in `localStorage` and never shows a spot the server didn't record — if the API can't be reached, it says so and the counters stay at "—". A `?ref=` code from the URL is kept in `localStorage` until the visitor joins.

The page picks its API from where it's served: on `localhost`/`127.0.0.1` it calls `http://localhost:3100`, anywhere else `https://waitlist-api.blindmarket.xyz`. The service only answers origins in `WAITLIST_CORS_ORIGIN`, which defaults to `https://waitlist.blindmarket.xyz` in production — **host the page there, or set that variable to wherever it does live**.

Fonts and the three.js hero load without blocking the page: if Google Fonts or cdnjs is slow or blocked, the form still works immediately with system fonts and a plain hero frame.

### Running locally

1. Start the waitlist service from `backend/`: `NODE_ENV=development WAITLIST_DATABASE_URL=postgres://…?sslmode=disable npm run start:waitlist` — any empty local Postgres works; it creates its own table.
2. From this folder: `python3 -m http.server 8791`, then open http://localhost:8791.

### Going live

1. Deploy the waitlist service as a new service with its own Postgres, reachable at `waitlist-api.blindmarket.xyz` — steps in [its README](../backend/src/waitlist/README.md).
2. Host this folder as a static site at `waitlist.blindmarket.xyz` (e.g. a static-site project whose root directory is `waitlist/`).
3. Add both DNS records.

Nothing about the BlindMarket app or its API changes.

## What's real vs. self-reported

- **Copy and product mechanics are accurate**, pulled from this repo: encrypted briefs, Base + 0G two-chain settlement, the Post → Accept → Verify → Settle lifecycle, the 90/10 payout split, and the real X handle (`@blindmarkt`) and domain (`blindmarket.xyz`).
- **Signups, positions, referral credit and the leaderboard are real** and scored server-side.
- **The X tasks and the X handle are self-reported.** Checking follows/likes or proving handle ownership needs X API credentials, so the page takes the visitor's word for it. The server only accepts task *names* and scores them itself, and only accepts handles in X's own format (1–15 letters, digits, underscores).
- **Emails aren't confirmed**, so a referral counts as soon as a new email signs up through the link. The per-IP limit (10 signups per 10 minutes) slows scripted fake signups but doesn't stop someone rotating IPs; adding email confirmation before crediting referrals is the fix if farming shows up.

## Stack

Vanilla HTML/CSS/JS. Fonts: Bungee (display), Manrope (text), JetBrains Mono (codes and numbers) from Google Fonts. Three.js (r128, cdnjs) drives the hero's wireframe/particle-cloud visual, which disperses as you scroll. No framework, no build tooling.


