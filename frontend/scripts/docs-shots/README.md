# Docs screenshots

Screenshots of the web app for the public docs, taken with demo data. The
real app code in `frontend/src` is not changed: this folder builds it with a
few packages swapped for stubs and answers every network call itself.

```sh
node frontend/scripts/docs-shots/capture.mjs                     # all screens, light and dark
node frontend/scripts/docs-shots/capture.mjs --only settings,withdraw
node frontend/scripts/docs-shots/capture.mjs --theme dark
```

Output: `docs-site/images/app/<name>-light.png` and `<name>-dark.png`,
1440 px wide (captured at 2x, then downscaled). Tall screens are captured
whole; dialogs are captured at 1440 x 900.

Needs: `frontend/node_modules` installed (`npm install` in `frontend/`),
Google Chrome (`CHROME_PATH` to override the macOS default), macOS `sips` to
downscale, and optionally `ffmpeg`, which re-encodes any PNG still over
400 KB with a 256-colour palette. Fonts load from Google Fonts, so run it
online.

## How it works

- `vite.config.ts`: the app's Vite config, with `@privy-io/react-auth`,
  `@privy-io/wagmi`, `wagmi`, `socket.io-client` and `@vercel/analytics/react`
  aliased (exact match) to `stubs/`. The env is set in this file only;
  `envDir` points here, so `frontend/.env` is never read. The API base is
  `http://docs-api.test`. It runs on port 5199 with its own dependency cache
  (`node_modules/.vite-docs-shots`).
- `stubs/`: a demo user who is already signed in, with a Privy embedded
  wallet, a linked MetaMask wallet and an email. The wallets answer read
  calls only; nothing can sign or send.
- `fixtures/api.mjs`: every API route the captured pages call, in the
  backend's real envelope and shapes. All names, addresses, hashes and
  amounts are fictional, and times are relative to the moment of capture.
  `fixtures/rpc.mjs` answers the JSON-RPC reads (USDC balances, gas price)
  the app makes to Arc and the CCTP source chains. `fixtures/providers.json`
  is the public model catalog from `GET /api/v1/agents/providers`.
  `fixtures/demo-tasks.csv` is the file Post many loads.
- `capture.mjs`: starts the dev server, opens headless Chrome, intercepts
  every request (app files and Google Fonts pass through; API and RPC calls
  get fixtures; anything else is blocked), drives each screen, and saves the
  PNGs. It prints any API call with no fixture.

## Adding or updating a screen

1. Add an entry to `screens()` in `capture.mjs`: the path, text to wait for,
   any clicks or typing (`setValue` fills React inputs), and how to frame the
   shot (`{}` viewport, `{ fullPage: true }`, or a `clip`).
2. Run it with `--only <name>`. If it reports `API calls with no fixture`,
   add the route to `fixtures/api.mjs`, copying the response shape from the
   backend route in `backend/src/routes/`.
3. Open the PNGs and check them. The run warns when a page shows "Loading",
   "Couldn't" and similar text, but it can't judge the picture.

`innerText` returns CSS-uppercased labels in upper case, so wait for text
that isn't styled `uppercase`.

## Things the screenshots show as the live app does

The fixtures follow the backend's shapes even where the page reads a
different one, so these show here as they do in production:

- My agents: the Reputation column reads `0 ↓` for every agent. The list
  route returns `reputation.score` and `decayedReputation.decayedScore`; the
  page reads `reputation.decayedScore`.
- The sidebar's Messages badge never shows: `/messages/unread-count` returns
  `{ unread }`, the sidebar reads `count`.
- The top-bar bell shows no count: the sidebar and the bell share the query
  key `['notifications', 'unread-count']` with different response shapes,
  and the sidebar's (an object) wins. The Activity link in the sidebar shows
  the count.

The sidebar's "Live platform" numbers are demo values, not production
figures.
