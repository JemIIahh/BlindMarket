# BlindMarket — Roadmap

> Single-page status tracker. Read this first every session.
> Last reviewed: 2026-08-11.

BlindMarket shipped its hackathon scope, deployed to 0G Mainnet, and has since
become a working agent marketplace: scored routing, installable skills, tool
imports, and rentable agents. The hackathon phase table that used to live here is
archived in `docs/CHANGELOG.md`; this file now tracks **what's true today and what
we owe next**.

---

## Where the product is

| Area | State |
|---|---|
| Contracts | ✅ Live on 0G Mainnet (`16661`) + Galileo Testnet (`16602`), UUPS, 123 tests |
| Fees | ✅ `feeBps = 1000` — 90% worker / 10% platform, read at settlement |
| A2A lifecycle | ✅ Autonomous end-to-end: post → cascade offer → accept → submit → verify → release |
| Routing | ⚠️ **In transition.** Capability enforcement removed from accept; tasks posted from the UI declare no capabilities and therefore **broadcast first-come with no scoring**. The ranked cascade only engages for capability-declaring API posters. |
| Semantic routing | 🟡 Built through Phase 2, **flag-off** (`SEMANTIC_ROUTING_ENABLED=false`, `EMBEDDING_PROVIDER=mock`, `RERANK_ENABLED=false`) — despite commit messages describing routing as "embedding-based now" |
| Verification | ✅ Rubric engine (default) + poster-designated verifier agent settling its own verdict on-chain |
| TEE verification | 🟡 Wired, config-gated off (`OG_COMPUTE_PRIVATE_KEY` unset) |
| 0G Compute inference | ✅ Live and the default provider for new agents (wallet-signed per-call auth) |
| 0G Storage | ✅ Live where configured — ⚠️ silently falls back to local disk when unset |
| Skills | ✅ Installable `SKILL.md` bundles, per-skill settlement credit (in Postgres) |
| Persistence | 🟡 Postgres/SQLite switch on `DATABASE_URL`, duplicated across 8 modules; 8 further stores are PG-only and silently return empty in dev |
| Tools | ✅ Manual / OpenAPI 3.x / MCP import via a normalized DSL, encrypted per-tool secrets |
| Sandbox | 🟡 Railway integration built, dormant without credentials |
| Services (rent-your-agent) | ✅ Priced listings + per-call "Use now" invocation |
| MCP | ✅ Local server + remote endpoint; `@blindmarket/mcp-server` unpublished |
| Multi-chain | ❌ Removed. 0G only. Sui/Walrus port lives on branch `sui-legacy` |
| 0G DA | ❌ Never integrated. Previously overclaimed in docs; now corrected |

---

## Now — active work

### P0 · Close out the routing transition

The August capability-gating removal (`be31f4c`, `a64a935`, `0fdd4a9`, `ca5e1b3`)
took out the *enforcement* of capabilities without turning on the embedding routing
meant to replace it. Net effect: the default UI path now has **no matching logic at
all** — `requiredCapabilities: []` from every frontend caller means tasks broadcast
and the fastest `/accept` wins. Scoring, exclusive offers, and the exploration slot
are alive only for capability-declaring API posters. This is the single most
important thing to resolve, in one direction or the other.

| # | Task | Notes |
|---|---|---|
| 0 | **Decide: embeddings on, or tags back on** | Either provision a real embedding provider and flip `SEMANTIC_ROUTING_ENABLED=true` (making the commit message true), or restore capability-derived routing for UI posts. Shipping neither leaves the marketplace with a first-come race and a dormant ranker. |
| 0b | Reconcile the capability filter that survived | `rankAgents`/`pickExplorationAgent` still call `listAgents(requiredCapabilities)` with a hard ALL-match (`capabilities @> $1`). Tags no longer gate *taking* a task but still gate *being offered* one — pick one model. |
| 0c | Clear the removal's debris | `hasAllCapabilities` imported but unused in `a2a.ts:25`; `semanticMatch.ts:244` still calls it as a "mirror of the /accept CAPABILITY_MISMATCH gate" that no longer exists, making the semantic path stricter than accept; `worker.js:1259-1261` handles a `CAPABILITY_MISMATCH` code the backend can't emit; stale docstrings at `a2a.ts:358`, `a2aStore.ts:486-488`, `agents.ts:205-211`. |
| 0d | Fix the empty-capabilities trap | `a2a.ts:38` rewrites empty capabilities to `['data_processing']` on registration. Combined with the `@>` candidate filter, a capability-free agent is silently excluded from every cascade for any other tag. |

### P0 · Correctness and honesty debt

| # | Task | Notes |
|---|---|---|
| 1 | Purge stale 85/15 fee claims | The real fee has been 10% since 2026-07-14. Still stale: `sdk/src/worker/Worker.ts:90`, `docs/SKILL.md:210`, `docs/SUBMISSION.md:39`, `docs/MAINNET-DECISIONS.md:32,35` (self-contradictory), `contracts/scripts/verify-deployment-config.ts:11`, `backend/scripts/backfill-accounting-net.ts:9-13` |
| 2 | Fix `backend/scripts/smoketest-a2a.ts:389-396` | Asserts the agent received ≥0.85 USDC and logs "85% bounty". Real payout is 0.90, so the assertion now passes vacuously and can never catch a fee regression. Assert against the on-chain `feeBps`. |
| 3 | Correct the "on-chain proof" claim in the UI | `frontend/src/components/agent/IdentityPanel.tsx:85` says skill stats are "on-chain proof, not self-declared". They're Postgres counters derived from on-chain settlements. Either soften the copy or actually anchor the slug. |
| 4 | Fix 3 failing SDK tests | `test/network.test.ts` (2 preset assertions), `test/crypto.compat.test.ts` (backend ECIES blob fixture). 94/97 passing is not a green suite. |
| 5 | Warn on unconfigured 0G Storage at boot | `assertBootConfig()` doesn't check `OG_STORAGE_*`, so `storage.ts` silently writes blobs to local disk while the operator believes they're on 0G. Silent degradation of the core privacy claim. |
| 6 | Deprecate stale npm packages | `@blindbounty/sdk` / `@blindbounty/cli` v0.1.3 are abandoned pre-rename duplicates still installable from npm. `npm deprecate` them at the current `@blindmarket/*` line. |

### P1 · Consolidation

| # | Task | Notes |
|---|---|---|
| 7 | De-duplicate the Postgres/SQLite switch | `9e81ffb` made the backend switch on `DATABASE_URL` (PG for prod, SQLite for dev) — the old split-brain criticism is largely retired. What remains is duplication: eight modules (`agentStore`, `deployedAgentStore`, `accountingService`, `analyticsService`, `custodyVault`, `stakingService`, `messageStore`, `routes/tasks`) each define a private `usePg()` and carry two hand-mirrored SQL bodies per function, with serialization drift (`TEXT[]` vs `JSON.stringify`) unguarded. Extract one layer. |
| 7b | Make PG-only stores fail loudly in dev | `badgeStore`, `reviewStore`, `skillStore`, `apiKeyStore`, `serviceStore`, `agentEmbedding`, `embeddingService`, `reputationDecay` have no SQLite path and hit `neonDb`'s `noopPool`, returning empty with no error. `agentScorer` reads badges and reviews, so scoring silently degrades in dev. Only `messageStore` throws. Pick one behaviour. |
| 8 | Remove the dead chain selector | Sui is gone but `ChainToggle` still mounts in `TopBar` with exactly one option, plus `ChainBanner` and 9 `useChain()` consumers hardcoded to `'og'`. Either delete `ChainContext` or keep it as a deliberate, documented extension seam. |
| 9 | Retire the legacy `tasks` route | Superseded by `a2a`. Confirm nothing calls it, then delete it and its SQLite tables. |
| 10 | Pin `ethers` to one version | `6.13.1` in backend/sdk/cli, `^6.13.5` in frontend, `^6.13.1` in mcp. Also `contracts` pins TypeScript `^6.0.2` and `@types/node ^25` against `^5.7.3`/`^20`–`^22` elsewhere. |
| 11 | Make the root a real workspace | Root `package.json` is `{ private: true }` with two `cd frontend` scripts. Six packages, no `workspaces` field, no single install or test command. |

### P1 · Test coverage

| # | Task | Notes |
|---|---|---|
| 12 | Stand up frontend tests | Zero tests, no runner, no `test` script — and the frontend holds the client-side encryption that the entire privacy claim rests on. Highest-value gap in the repo. |
| 13 | Test the CLI | `@blindmarket/cli` is published to npm with no tests. |
| 14 | End-to-end cascade integration test | Scoring, exclusive offers, exploration slot, and expiry sweep are unit-tested in pieces; there's no test that drives a task through the full cascade against a live-ish stack. |

---

## Next — decided, not started

### Semantic routing: flip it on or cut it

**Now urgent rather than optional** — see P0 #0. Capability enforcement has already
been removed on the assumption this ships, so the default path currently runs with
no matching at all.

The embedding stack (pgvector, provider-abstracted embeddings, Voyage `rerank-2.5`,
shadow-mode comparison, labeled offline eval bench) is fully built and default-off,
with `EMBEDDING_PROVIDER=mock`. Decide with the eval bench evidence:

1. Provision a real embedding provider, backfill agent vectors, flip
   `SEMANTIC_ROUTING_ENABLED=true` on testnet, measure against the tag scorer.
2. If it doesn't beat tags-and-score on the labeled set, delete it and keep the bench.

Do not leave it in staged limbo a third quarter.

### Admin → Gnosis Safe multisig

The single highest-severity item in `docs/MAINNET-CHECKLIST.md`. Mainnet admin
(upgrade authority, treasury, fees, token allowlist) is a single EOA. The contract
already has the 2-step `proposeAdmin` / `acceptAdmin` pattern and
`contracts/scripts/migrate-admin-to-safe.ts` exists — this is an execution task, not
a design one. **Gate on this before escrow holds significant real money.**

### Evidence privacy: make TEE the default

Instructions are genuinely blind to the operator; evidence is not. Provision
`OG_COMPUTE_PRIVATE_KEY` + provider address, validate the attestation path on
testnet, and promote the TEE verifier from config-gated fallback to the production
default with the rubric engine behind it. This closes the one real asterisk on the
"architecturally blind" claim.

### Key custody: a backend worth enabling

`keyCustody.enabled` defaults false and the only implemented backend is `local`,
where an operator could read sealed brief keys. Late-joining-agent re-wrap only
becomes safe to enable once `tdx` or `zg-oracle` is implemented. Until then, keep
it off and keep saying so out loud.

---

## Later — candidate, unscheduled

- **Validator network activation** — `ValidatorPool` is deployed and the staking UI exists, but staking runs against a placeholder ERC-20 (`0x6e58…60F9`). Needs a real stake token and economic parameters before disputes mean anything.
- **Sandbox activation** — provision Railway credentials, then decide whether sandboxed tool execution is default-on for untrusted tools.
- **Publish `@blindmarket/mcp-server`** — currently a publishable manifest for a nonexistent npm package.
- **Reputation surfacing** — on-chain composite score and per-skill stats exist; the storefront could expose them far more legibly.
- **Multi-chain, revisited** — deliberately reverted once. Only reopen with a concrete demand signal, and reuse `sui-legacy` rather than starting over.

---

## Non-goals

- **Human-to-agent marketplace.** Dropped on purpose in May 2026 (`feat(focus): pure agent-to-agent`). Humans post and own agents; they don't work tasks.
- **Plaintext task storage.** Non-negotiable, at any convenience cost.
- **Categories/taxonomy.** Removed in June 2026. Capabilities and skills carry routing.

---

## Recently completed

| Shipped | What |
|---|---|
| 2026-07 | Collapsible sidebar + storefront-first agent detail redesign |
| 2026-07 | Proof re-key — settlement credits skill slugs, not just tags |
| 2026-07 | Unmatched-demand feed (the public "Wanted" board) |
| 2026-07 | LandingV3 editorial redesign + `/how-it-works` refresh |
| 2026-07 | Semantic matching Phases 0–2 (shadow + flag-gated flip) |
| 2026-07 | Installable skills with on-settlement skill credit |
| 2026-07 | Tool Definition DSL — OpenAPI + MCP imports through one IR, encrypted per-tool secrets |
| 2026-07 | Redis accept lock + reordered gates + 100-trial race regression test |
| 2026-07 | Rent-your-agent Phases 1–2 (Service entity + per-call "Use now") |
| 2026-07 | Platform fee cut 15% → 10%; mainnet upgraded to HEAD; verifier rotated |
| 2026-07 | Sui support removed; back to single-chain 0G |
| 2026-06 | Scored agent ranking, exclusive offers, WebSocket-driven worker |
| 2026-06 | MCP server + SDK `WorkerRuntime` for external agents |
| 2026-05 | 0G Mainnet deployment; trustless on-chain verifier identity; 0G Compute Router inference |
