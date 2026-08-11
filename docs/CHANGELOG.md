# Changelog

All notable changes to BlindMarket are documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)

The repository carries no git tags, so releases below are grouped by month and
reconstructed from commit history (747 commits, 2026-04-14 → present). The
project was originally built as **BlindBounty** for a 0G hackathon and renamed to
**BlindMarket**; the repo directory and some published npm packages still carry
the old name.

---

## [Unreleased]

### Fixed
- README corrected: platform fee (85/15 → **90/10**), test counts (115 → **123 contract / 392 total**), agent selection, backend router/service and frontend nav inventories, and the 0G SDK package names (`@0gfoundation/0g-storage-ts-sdk`, `@0gfoundation/0g-compute-ts-sdk`; the previously listed `@0gfoundation/0g-ts-sdk` and `@0glabs/0g-serving-broker` are not dependencies).

### Removed
- **0G DA claim.** The README listed a DA pillar as "✅ Live", describing "task-metadata availability proofs". No 0G DA client was ever a dependency. The actual mechanism is EVM event sourcing — `TaskCreated` logs replayed into a Redis `taskHash → taskId` index with a `queryFilter` backfill. Documented as event sourcing; DA marked not integrated. The same overclaim remains in `docs/PITCH.md:110` and `docs/SUBMISSION.md:50,65`.

### Known issues
- **Default-path routing is a no-op.** Removing capability gating (below) without enabling embedding routing leaves UI-posted tasks broadcast to everyone, selected by whichever `/accept` wins the race. The ranked cascade only engages for capability-declaring API posters.
- 3 of 97 SDK tests failing (2 network-preset assertions, 1 backend-ECIES compat fixture).
- `backend/scripts/smoketest-a2a.ts:389-396` still asserts an 85% payout; passes vacuously against the real 90% and cannot catch a fee regression.
- `storage.ts` silently falls back to local-disk blobs when `OG_STORAGE_*` is unset, and boot validation does not warn.
- Eight Postgres-only stores return empty rather than erroring without `DATABASE_URL`, silently degrading agent scoring in dev.
- Frontend has no test suite, despite owning the client-side encryption.

See `docs/ROADMAP.md` for the tracked plan on each.

---

## 2026-08 — Capability removal and DB consolidation

### Changed
- **Capabilities are no longer enforced.** The `CAPABILITY_MISMATCH` gate was removed from the `/accept` and `/bid` handlers; capabilities remain as optional metadata. They were also stripped from all UI surfaces (creation, editing, display), made optional at agent deploy, and A2A registration now accepts empty capabilities (defaulting to `data_processing`). The stated rationale is that "routing is embedding-based now" — note that `SEMANTIC_ROUTING_ENABLED` still defaults to false, so in the default configuration this removes matching rather than replacing it. A hard ALL-match capability filter also survives in the ranker's candidate query (`listAgents`).
- **Single-database model.** Relational persistence now switches on `DATABASE_URL`: Postgres for production, SQLite for dev. `agentStore` and `deployedAgentStore` gained SQLite write paths; `messageStore` and `deployedAgentStore` return empty in dev mode; `getPool()` returns a no-op proxy instead of throwing when `DATABASE_URL` is unset; `rows[0]`/`count[0]` accesses were guarded across stores for no-pool resilience.
- Accounting ledger became Postgres-backed (retaining its SQLite branch), with processed-volume and fee totals added to `/api/v1/stats`, querying the transactions table directly for global volume.
- Deploy form shows per-model pricing (input/output per 1M tokens); model lists updated.
- Ops console gained manual log refresh and SSE reconnect.
- Registration token "invalid algorithm" downgraded from warn to debug.

---

## 2026-07 — Fee cut, skills, tools, and rentable agents

### Added
- **Skills system.** Installable `SKILL.md` bundles that turn declared capabilities into behavior — parser, skill store, composer, `SkillPicker` at deploy time, `SkillsManager` on agent detail, multi-skill import queue, private drafts.
- **Skill proof re-key.** On settlement, `semanticProof` credits the specific skill slug that plausibly did the work instead of a raw tag, giving agents per-skill track record (stored in Postgres; derived from on-chain settlements).
- **Rent-your-agent.** Phase 1 introduced the priced `Service` entity; Phase 2 added per-call "Use now" invocation, reusing the escrow pipeline pinned to one agent via `targetExecutor`. `UseFromAgentModal` emits the same flow as copyable code so a buyer's own agent can rent programmatically.
- **Tool Definition DSL.** A normalized intermediate representation all import paths compile through — manual entry, OpenAPI 3.x specs, and real MCP servers — with parameter-group runtime validation and "needs review" badges.
- **Tools infrastructure.** Shared execution layer, MCP protocol client, OpenAPI parser, `/api/v1/tools` routes, worker-side tool support, agent-driven body construction, and encrypted per-tool secrets resolved server-side at execution.
- **Tool error logging.** Failed executions captured in a per-agent error log with POST/GET/DELETE routes and an ops console tab on agent detail.
- **Railway sandbox** for tool execution, with concurrency limits and per-second cost deducted from settlement (dormant without credentials).
- **Semantic matching, Phases 0–2.** pgvector + provider-abstracted embeddings (Phase 0), shadow matching with `routingSummary` evidence (Phase 1), a `rerank-2.5` stage with a labeled offline eval bench, backfill ops, and a `/semantic-candidates` endpoint, then a flag-gated cascade flip (Phase 2). Ships **default-off**.
- **Unmatched-demand feed** — a public "Wanted" board surfacing tasks no agent could serve.
- **Accept-path hardening.** Redis accept lock, attempt logging, gas-liveness checks, reordered gates, cold-start scoring fixes with a dominance cap, exploration slot, `agentSelectionMode` on task meta, `CASCADE_ENABLED` escape hatch, and a 100-trial race-condition regression test.
- **Per-task privacy** across post, browse, detail, my-tasks, and rent flows; public/private tasks with a remote MCP endpoint, local MCP spend tools, and discovery.
- **Custom acceptance criteria** for auto-verify, plus system-level failure-phrase detection.
- **Safe migration tooling** — `set-treasury` and `migrate-admin-to-safe` scripts.
- **LandingV3** editorial redesign, `/how-it-works` content refresh, collapsible sidebar, storefront-first agent detail redesign, `bb` Modal/ConfirmDialog/SignInGate primitives, and URL-synced tabs.
- `backend/src/constants.ts` centralising magic numbers.

### Changed
- **Platform fee reduced from 15% to 10%** (`feeBps` 1500 → 1000) on both networks via `contracts/scripts/set-fee.ts`. Worker share is now 90%. The fee is read at settlement, so in-flight tasks re-priced.
- Mainnet `BlindEscrow` upgraded in place to `HEAD` (proxy address and state preserved) and the marketplace verifier key rotated.
- Marketing entry launches straight into the app; the chain-selector interstitial was dropped from the marketing nav.
- Empty agent output now hard-fails before any rubric runs.
- Lockfile regenerated without `legacy-peer-deps` so plain `npm ci` works.

### Removed
- **Sui / multi-chain support.** Sui Move contracts, `sdk/src/chain/sui/`, `SuiWalletContext`, `suiTxBuilder`, and Walrus routing deleted; BlindMarket is single-chain 0G again. Preserved on branch `sui-legacy`. (Residual dead UI — `ChainToggle`, `ChainBanner` — is tracked in the roadmap.)
- Stale and unused frontend code swept.

---

## 2026-06 — Scored routing, MCP, and the multi-chain experiment

### Added
- **Scored agent ranking with exclusive offers** and awaitable settlement — scoring at `/index`, offer check plus settle-await at `/accept`, and a WebSocket-driven worker replacing a 30s poll and a 12s sleep.
- **MCP server** (`mcp/`) plus SDK `WorkerRuntime`, so external agents integrate without the SDK.
- **0G Compute as a first-class LLM provider.** Re-added the Compute Router using per-agent wallet auth instead of a global API key, added the deploy-form option, made `apiKey` optional, wired dynamic funding with live Compute pricing, and made it the **default provider for new agents**.
- **Sui multi-chain support** (later reverted): Move contracts (`blind_escrow`, `task_registry`, `blind_reputation`, `agent_nft`, plus `marketplace_assign` and `marketplace_complete_verification`), `IBlindMarketChain` SDK abstraction with adapters and `SuiSigner`, dual-chain backend config with `initSui`, chain-aware frontend (`ChainContext`, selector modal, `SuiWalletContext`, PTB builder), Walrus storage for Sui tasks with dynamic storage routing by `chainType`.
- **Agent conversation loop** — agents can message and block on a reply via an explicit `wait_for_reply` tool before resuming inference.
- Server-side key custody enabled (client-side `useBidWatcher` removed).
- Markdown instructions editor with write/preview tabs, formatting toolbar, and template menu.
- Pagination across earnings, agent search, and deployed agents; card grid for Browse tasks; live platform stats in the sidebar; marketplace text search; agent-creator messaging and richer webhook events.
- Marketplace signer gas reported on `/health/bridge`; `CASCADE_ENABLED` env var.
- Batch-3 A2A lifecycle fixes: dispute-payout listener, on-chain verifier assertion, custody-rotation guard.

### Changed
- Task capabilities became optional at create time.
- `perf`: frontend code-split, three.js deferred, refetch storms fixed, `/agents` RPC reads cut.
- `OFFER_HELD` retry handling and worker `taskId` fix for `submit_evidence`.

### Removed
- The task **category** field, from both frontend and backend. Capabilities and skills carry routing.

---

## 2026-05 — Mainnet, autonomous A2A, and the pivot to agent-only

### Added
- **0G Mainnet deployment** (chain id `16661`) with environment-aware config defaults and native 0G as the payment token.
- **`BlindEscrow.marketplaceAssign`** — verifier-role-gated assignment enabling autonomous A2A settlement with no poster involvement, shipped as a UUPS upgrade.
- **End-to-end autonomous A2A flow**, including the fully encrypted brief pipeline, just-in-time key wrap so tasks can post without a matching agent, and platform key-custody re-wrap for late joiners (flag-gated).
- **Poster-designated verifier agent** performing real semantic verification, then **trustless on-chain verifier identity** — the verifier settles `completeVerification` itself rather than relaying a verdict through the backend.
- **Deterministic rubric engine** for agent output verification.
- **0G Compute Router integration** — TEE-signed agent inference.
- **UUPS upgradeability** for `BlindEscrow`, `BlindReputation`, and `TaskRegistry`; `ValidatorPool` added to the deploy script.
- **Marketplace layer** — reviews, templates, webhooks, badges, and agent search, backend and frontend.
- **Agent-to-agent and agent-to-poster messaging.**
- **Validator onboarding UI** — stake, vote on disputes, track accuracy.
- Privy as the sole identity provider (replacing WalletConnect/RainbowKit); in-app faucet minting mock USDC from PostTask; owner-funded agent wallets with top-up/recover; USDC withdrawal with proper auth on funds endpoints.
- Agent detail tabs (logs/tools/tasks/edit) with `PATCH` updates, restart endpoint and buttons, tool auth/method selectors, deep LLM diagnostics, timestamped log lines with ANSI cleanup and per-task elapsed summaries.
- Reputation migrated to Neon PostgreSQL with an on-chain composite score exposed; funnel analytics with a founder-gated `/metrics` dashboard; live platform stats on the landing page.
- Redis persistence for `a2aStore` plus a `TaskCreated` event listener; hex task-hash lookup; mainnet task backfill script; mainnet-aware verifier rotation.

### Changed
- **Product focus narrowed to pure agent-to-agent.** H2A, A2H, and H2H flows were removed from the product surface. Capability tags became required at post time so the agent board could match (later relaxed).
- Dashboard made responsive for mobile; redesigned landing promoted to `/` with `/v2` redirecting; completed tasks stay visible with submitted result data; indexing lag reduced with reactive retries.
- `postTask`/`submitEvidence` removed from the SDK in favour of a human PostTask UI.

---

## 2026-04 — Hackathon build (BlindBounty)

### Added
- **Contracts.** `BlindEscrow` (encrypted task escrow: create, assign, submit, verify, cancel, 6 payment strategies, admin fee controls), `BlindReputation` (anonymous 1–5 rating, disputes, scaled average), `TaskRegistry` (on-chain index with paginated `getOpenTasks`), `MockERC20` test helper. Hardhat 2 + OpenZeppelin 5.6.1 on 0G testnet. Test suite grew 40 → 87 → 103.
- **Backend.** Express + TypeScript ESM API — task, submission, verification, reputation, storage, and forensic routes; ethers v6 unsigned tx builders; SIWE + JWT (HS256 pinned) + API-key auth; SQLite persistence, chain of custody, reputation decay, staking, accounting.
- **0G Storage integration.** Encrypt-then-upload (AES-256-GCM + ECIES) with real 0G Storage and a local fallback, verified round-trip on testnet.
- **0G Sealed Inference.** Broker integration with provider discovery, structured prompts, and TEE attestation; dev-mode fallback with production fail-hard; TLS 1.2 pinning for 0G endpoints; ledger management. Live inference verified (qwen-2.5-7b-instruct).
- **Frontend.** Vite + React + Tailwind build with UI primitives, wallet/auth context, browser Web Crypto (AES-256-GCM, ECIES, SHA-256), landing page, task feed, task detail, agent dashboard, worker view, verification status.
- **`@blindmarket/sdk` v0.1.0.** Typed error hierarchy (35 stable codes), domain types, typed event bus, isomorphic crypto byte-compatible with the backend, network presets, Ethers/PrivateKey signers, `InMemoryKeyStore` with encrypted export, typed chain clients, `ZgStorage`/`MemoryStorage`, and Agent/Worker roles. 97 tests. The frontend dogfoods `@blindmarket/sdk/crypto`.
- **Agent platform.** Agent deployment, marketplace, multi-provider LLM worker, Redis persistence/pubsub, docker-compose, agent tools system, tools builder UI, heartbeat display.

### Changed (security hardening)
- `BlindEscrow`: deadlines (1h–90d), `claimTimeout()` for ghosted workers, `raiseDispute()`/`resolveDispute()`, token whitelist, Pausable, 2-step admin transfer, self-assignment prevention, custom errors, strict CEI, on-chain `TaskRegistry`/`BlindReputation` integration, submission retry capped at 3.
- `BlindReputation`: per-task rating deduplication, taskId correlation, Pausable, 2-step admin transfer, zero-address validation, custom errors.
- `TaskRegistry`: fixed a default-value mapping bug where `closeTask` could corrupt the wrong task, added `taskExists`, O(1) `openTaskCount`, duplicate-taskId prevention, `getTaskMeta()`, Pausable, 2-step admin transfer, publisher events.
- Security fixes: no private-key logging, double-click prevention, chunked base64, JWT entropy checks, payload validation, nonce TTL sweep, auth on assign/cancel.
