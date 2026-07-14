# Rent Your Agent — build path & Phase 1 scope

Full teardown + strategy: **[`rent-your-agent.html`](./rent-your-agent.html)** (okx.ai rental-model
teardown → BlindMarket build path). This doc is the tracked companion + the concrete Phase 1 scope.

## Thesis (from the report)
BlindMarket has the **task / bounty** model (post a task → an agent accepts, executes, settles).
okx.ai has the **rental / service** model — a persistent, listable agent you **"use now"** per call.
The object we lack is a **Service entity**. Strategy: *"build the door, not okx.ai's house"* — a thin
service + invoke layer on infra we already have, with **confidential invocation** as the differentiator
okx structurally can't match.

## What already exists (the foundation — we are not starting from zero)
`DeployedAgent` (`backend/src/types.ts:392`) + `backend/src/routes/agents.ts` already give us:
- Owned agents — `ownerAddress` / `authorizedOwners` (+ signature-gated `link-owner`).
- `capabilities`, `minReward` (per-task bounty floor), `tools`, full lifecycle (deploy/start/stop/pause/restart/resume).
- On-chain identity — `walletAddress`, `publicKey`, iNFT `inftTokenId`.
- Earnings — `tasksCompleted` / `totalEarned` (computed in `agents.ts` from executions/reputation).

So agents are **already hireable per-task** via the A2A flow. What's missing is the **service listing +
direct-invoke** surface — the "rent" UX.

## The 4 phases (front-loaded on cheap wins)
1. **The Service entity** — a persistent, listable, rentable service object. ← *scoped below*
2. **Per-use invocation + settlement** — the "use now" handshake.
3. **Payment channels** — the real primitive (streaming / per-call payment).
4. **Confidential invocation** — private per-call execution (the moat vs okx).

## Phase 1 scope — "The Service entity"
**Goal:** an owner can **publish a deployed agent as a rentable service**, and anyone can **browse** the
directory. No invocation yet (that's Phase 2) — Phase 1 is data-model + read surfaces on existing code.

**Data model** — new nullable columns on the agents table (default unlisted; extend `DeployedAgent`):
- `listed: boolean` — published as a rentable service.
- `serviceTitle`, `serviceDescription` — listing copy.
- `pricePerCall?: string` (wei) — rent price, **distinct from `minReward`** (the per-task bounty floor).
  Phase 1 displays it; enforcement is Phase 2.
- Reuse `capabilities` for category/filter tags (no new field).

**Backend:**
- `POST /agents/:id/list` (`requireAuth + authorizeOwner`) — set listing fields, `listed=true`.
- `POST /agents/:id/unlist` — `listed=false`.
- `GET /services` — public directory of `listed` agents.
- `GET /services/:id` — public service detail.
- ⚠ Public surfaces MUST go through the **audited public projection** (`projectPublicMeta` /
  `strip()`), never the raw record — do not re-introduce the `platformToken` / key-material leak
  fixed in `5cfabb7`. Add the service fields + `tasksCompleted`/`totalEarned`/reputation to that projection.

**Frontend:**
- **"Rent an agent"** browse page — grid of listed services; filter by capability; show price + reputation + earnings.
- Owner **"List my agent"** toggle in agent management (title / description / price form).
- Service detail page — Phase 1 shows info + a disabled "Use now" button (wired in Phase 2).

**Deferred (explicit):** invocation/settlement (P2), payment channels (P3), confidential invocation (P4).

**Effort:** ~1 schema migration + 3–4 routes + 2 frontend pages. **No new contracts.** The bounty/escrow
rail already settles; Phase 1 only adds the listing/discovery layer.

## Status
- ✅ Report written (delivered as an artifact, now preserved here).
- ✅ **Phase 1 shipped** — `agent_services` table (migration 12) + owner CRUD + public browse/detail + an
  AgentDetail "Services" tab + a browse "From" column. Live on mainnet.
- ✅ **Phase 2 built** — "Use now" per-call invocation reusing the escrow rail: a `targetExecutor` pin +
  `NOT_TARGET_EXECUTOR` accept gate, instant auto-verify, atomic `sold_count`, a `UseServiceModal`, and the
  Services-form link-owner recovery. No new migration. Pending: live e2e after deploy.
- Overlaps with `docs/VISION-2.md` (confidential outcome market) — Phase 4 (confidential invocation) is
  where the two converge; keep them aligned.

## Follow-ups
- ✅ **Services-form link-owner recovery** — shipped in Phase 2 (one-click "Link this wallet & retry" on a 403).
- **Phases 3–4** remain: payment channels (kill per-call gas) → confidential invocation (seal input+output).
- Optional hardening: worker-side "treat NOT_TARGET as touched" to cut poll churn; a dedicated authed
  single-task result read (Use-now polls `/tasks/posted` today).
