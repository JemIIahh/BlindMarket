# BlindMarket Waitlist — landing page

Single-page waitlist for [BlindMarket](https://blindmarket.xyz). Visitors do a few things on X, leave their X handle and email, and get a place in line they can improve by bringing in friends through a personal referral link. A public leaderboard shows the front of the line.

Static HTML/CSS/JS in one file (`index.html`), no build step. Serve this folder with any static host — opening `index.html` straight from disk can't sign anyone up, because a `file://` page sends `Origin: null` and the API rejects it.

## How the line works

- **Position** is a live rank: join order, moved up **10 places per point**, ties to whoever joined first. It shifts as others join and earn points.
- **X tasks** (self-reported): follow [@blindmarkt](https://x.com/blindmarkt), like and repost [our post](https://x.com/blindmarkt/status/2098305130835607945) — 1 pt each, required to submit — and an optional reply to it, 3 pts. Max 6 pts from tasks. Tapping a card opens X; the card only counts once the person answers **"Done it? Yes"** — the page never pretends to check.
- **Referrals**: every signup gets a link like `https://waitlist.blindmarket.xyz/?ref=k7m2p9qa`. Each *new* signup made through it gives the referrer **+2 pts** (20 places), with no cap. The server credits it in the same statement that creates the signup, so it can't be claimed twice or sent from the browser; a repeat email never credits anyone. Each connection can produce at most 5 credited referrals a day — friends on their own connections all count, a script on one connection doesn't.
- **A repeat email** gets "already on the list" and nothing else — no handle, points or position — so nobody can look up someone else's spot (or link their email to a public handle). Your spot stays with the device you signed up on.
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
- **The X tasks and the X handle are self-reported**, and the page says so. X's API no longer offers follow/like checks to self-serve plans (April 2026) and its likes lookup stops at 100 people per post, so nothing here checks automatically. The server only accepts task *names* and scores them itself (6 pts at most), and only accepts handles in X's own format (1–15 letters, digits, underscores).
- **The front of the line is checked by hand** before access goes out: `npm run waitlist:admin -- top` lists it with each person's claims and the X links to check, and `revoke` takes back what didn't happen — see the [service README](../backend/src/waitlist/README.md#spot-checking-the-front-of-the-line).
- **Emails aren't confirmed**, so a referral counts as soon as a new email signs up through the link. The per-connection cap (5 credited referrals a day) stops one connection farming its own link with throwaway addresses; someone rotating many IPs can still farm. Email confirmation before crediting a referral is the real fix if that shows up.

## Stack

Vanilla HTML/CSS/JS. Fonts: Bungee (display), Manrope (text), JetBrains Mono (codes and numbers) from Google Fonts. Three.js (r128, cdnjs) drives the hero's wireframe/particle-cloud visual, which disperses as you scroll. No framework, no build tooling.
