# Trust Closeout — founder-executed steps (items 1 & 7)

The code items (2–6) of the closeout ship in the backend batch. These two need
you: they involve key ceremonies and billing that Claude can't (and shouldn't)
perform. Goal: break the single hot EOA that today holds **admin + verifier +
custody** into separate, least-privilege roles, and stop the API from napping.

Current state (verified June 2026): `BlindEscrow` is a UUPS proxy with a 2-step
admin transfer (`proposeAdmin`/`acceptAdmin`), an admin-only `setVerifier`, and
`_authorizeUpgrade` gated `onlyAdmin`. So we can rotate the verifier and move
admin to a Safe **without redeploying** — no migration, no downtime.

## Item 1a — Isolate the verifier signer (do this FIRST; lowest risk)

The marketplace backend calls `marketplaceAssign` / `completeVerification` as
`verifier`. Today that's the deployer key. Give it its own key so a backend
compromise can't touch admin or upgrades.

```bash
cd contracts
# 1. Generate a fresh signer (prints address + private key; writes nothing on-chain)
npx hardhat run scripts/generate-marketplace-signer.ts
# 2. Fund the new address with a little 0G for gas (assignment/verdict txs)
#    — send from any wallet; ~1 0G is plenty to start.
# 3. Rotate the on-chain verifier role to it (admin key in contracts/.env signs this)
MARKETPLACE_SIGNER_ADDRESS=0x<new> npx hardhat run scripts/rotate-verifier.ts --network 0g-mainnet
```

Then set `MARKETPLACE_SIGNER_PRIVATE_KEY=0x<new>` in the **backend** env (Render)
and redeploy. Verify: `escrow.verifier()` returns the new address, and a test
task still settles. Keep the new private key out of the contracts repo `.env`
(that one stays the *admin* key, used only for ceremonies).

> Order matters: rotate the verifier **before** moving admin to the Safe — once
> admin is a multisig, `setVerifier` needs a multisig tx, which is slower. Do the
> easy single-key rotation now.

## Item 1b — Move admin to a Safe multisig

`admin` controls upgrades, `setVerifier`, `setTreasury`, `resolveDispute`,
`pause`. A single hot key here is the catastrophic-loss vector our own
MAINNET-CHECKLIST forbids.

1. Deploy a **Safe** on 0G mainnet (chainId 16661). If the Safe UI doesn't
   support 0G, deploy the Safe contracts via their CLI / a script and use the
   Safe Transaction Service or a local Safe frontend pointed at the 0G RPC.
   Start 2-of-3 with keys you control on separate devices/backups.
2. From the **current admin** key, propose the transfer:
   ```bash
   cd contracts
   # one-liner via hardhat console, or a tiny script:
   #   escrow.proposeAdmin("0x<safe>")
   ```
3. From the **Safe**, call `acceptAdmin()` (the 2-step design means the Safe must
   actively accept — this is what prevents locking yourself out by fat-fingering
   the address).
4. Verify `escrow.admin()` == Safe, `escrow.pendingAdmin()` == 0x0.

After this, the deployer key holds **no** standing privilege. Document the Safe
address and signer set in `deployments/0g-mainnet.json`.

> A `propose-admin.ts` helper to mirror `rotate-verifier.ts` is worth adding
> before step 2 — ask Claude to write it (reads admin from `.env`, calls
> `proposeAdmin`, re-reads `pendingAdmin` to confirm). Kept out of this batch
> because it's founder-run, not part of the backend deploy.

## Item 7 — Always-on hosting + uptime alerting

**Diagnosed 2026-08-11. Root cause: the backend is on a Render _Free_ web service.**

Measured against production:

| Probe | Result |
|---|---|
| First request after idle | no first byte within **90s** (TCP connect succeeded at 8.3s) |
| Later cold wake, timed to completion | **73.5s** to a 200, then **0.76s** warm on the next request |
| 8 requests once warm | **200** in 0.73–1.16s, `{"status":"ok"}` |
| Backend boot, locally | **1.54s** to listening; `/health` answers in 5ms |

Note the second row: the service spun down *again* roughly an hour after being
woken, which is the 15-minute idle timer doing exactly what it is documented to
do. It is not intermittent and it will not "settle down".

Render spins a Free web service down after **15 minutes** without inbound traffic
(HTTP *or* WebSocket messages), and spin-up "takes about one minute" —
<https://render.com/docs/free#spinning-down-on-idle>. This is *not* the earlier
`hibernate-wake-error` class and it is *not* an application fault: `index.ts`
binds the port before running any init work (escrow poller, expiry sweep, agent
reconcile, bridge verification all run inside the `listen` callback), and boot is
1.5s. The whole delay is instance spin-up. A visitor — or a 0G reviewer — hitting
`www.blindmarket.xyz` on a cold instance sees an app whose every API call hangs.

### The fix (only you can do this — it's billing)

1. Render Dashboard → the backend service → **Settings → Instance Type** →
   change **Free → Starter** ($7/mo, 512 MB / 0.5 CPU). This alone removes
   spin-down. Consider **Standard** (2 GB / 1 CPU) instead: this service *forks
   agent worker processes*, and Free/Starter give 0.1 / 0.5 CPU respectively.
2. Same page → **Health Check Path** → `/health`. It's dependency-free (no DB,
   Redis, or RPC — see `backend/src/routes/health.ts:15`), so it answers during
   startup and Render will restart a crashed boot instead of serving 503s.
3. Confirm `OG_COMPUTE_PRIVATE_KEY` is set. After the fail-closed change (item 6)
   auto-verification **refuses** to settle without it rather than auto-passing —
   correct, but you want to know.

### Interim mitigation — a stopgap, NOT closure of this item

`.github/workflows/uptime.yml` pings `/health` every ~10 minutes, so the
15-minute idle timer normally never fires, and fails the run (→ GitHub emails you)
when the API doesn't serve a healthy 200 across three attempts. That buys back the
visitor experience and gives you the external monitor, at zero cost on a public
repo. **It does not close either half of this item, because it cannot: the two
changes that actually resolve it are dashboard-only and no repo artifact can
assert them.** Keep this item open until the Done criteria below are verified by
hand. Limits, honestly:

- Actions cron is best-effort and can be delayed several minutes, so a cold start
  can still slip through.
- GitHub disables scheduled workflows in repos with 60 days of no activity.
- Staying warm 24/7 consumes **~720–744 of the workspace's 750 monthly Free
  instance hours** (24 h × 30–31 days; spun-down time is what's normally free).
  In a 31-day month that leaves roughly **6 hours of headroom**, and exhausting
  the pool suspends *every* Free service in the workspace until the next month.
  So on Free this stopgap can cause a longer outage than the cold start it
  prevents — a second Free service in the workspace, or a few redeploys, tips it
  over. If the paid upgrade is going to be delayed, narrow the cron to a daily
  active window instead (`cron: '*/10 6-23 * * *'`, ~450 h/month).

### Free-tier landmines specific to this backend

- **Deployed agents die on every spin-down.** Forked workers are in-process
  children; `reconcileAgents()` re-forks them on boot, but nothing executes while
  the instance is down. An agent marketplace cannot run on a spin-down instance.
- **Suspension risk.** Render may suspend a Free service that "initiates an
  uncommonly high volume of traffic over the public internet." This backend polls
  0G RPC every 5s, uploads to 0G Storage, calls embedding/rerank providers, and
  forks agents that call LLM APIs. That profile is squarely in scope.
- **No shell access** on Free, so no `ssh`/dashboard shell when you need to debug
  a live incident.
- **Ephemeral filesystem.** Not currently biting us — prod has `DATABASE_URL`
  (Neon), verified 2026-08-11 via `/api/v1/stats` returning 58 agents / 33 users
  / 25 completed tasks across restarts. But the Aug 5 SQLite fallback would lose
  everything on each spin-down if `DATABASE_URL` were ever unset in prod.

## Done criteria

- `escrow.verifier()` = isolated signer; backend uses it; a task settles end-to-end.
- `escrow.admin()` = Safe multisig; deployer key has no standing role.
- Instance type is paid and Health Check Path = `/health`. Neither is provable from
  this repo, so verify by hand and record it: paste the Render settings (or a
  screenshot) plus the date into this doc.
- Spin-down is gone, verified deliberately rather than by watching 144 runs a day:
  leave the service untouched for >20 minutes (temporarily disable the `uptime`
  workflow), then run `gh workflow run uptime` and confirm the step summary says
  **"Cold start observed: no"**. Measured on Free 2026-08-11 for contrast: the wake
  probe took **73.5s** while the warm probe answered in 0.76s.
- The `uptime` workflow is green on its normal schedule.

