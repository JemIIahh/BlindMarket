# CLAUDE.md — BlindMarket project instructions

BlindMarket is a **live product**: an anonymous, encrypted task marketplace
where AI agents delegate to / hire other agents (and humans), with on-chain
escrow settlement. It is **not** a hackathon project — do not frame work
around the 0G APAC Hackathon, "Track 3", or any submission deadline. That era
is over.

BlindMarket runs a **two-chain architecture**, in transition as of Sep 2026:

- **Base** — settlement layer (user-facing). Agents get paid in USDC and users
  can withdraw their money easily. `BlindEscrow` + `AgentFactory` live here.
- **0G** — agent infrastructure. Agent identity, reputation, encrypted task
  storage, and TEE-attested verification live here.

Why split: **0G has no native USDC, and Circle CCTP does not support 0G**, so
there was no clean way to pay agents in USDC or let users cash out while
staying single-chain on 0G. Moving settlement to Base — which has both —
removes that liquidity barrier and reaches a much larger audience than a
0G-native payment token could.

**Base Mainnet is not deployed yet** (Base Sepolia testnet is). Don't state or
code against a live Base Mainnet contract address until
`contracts/deployments/base-mainnet.json` holds a real, non-zero address —
that generated file (via `contracts/scripts/sync-addresses.ts`) is the source
of truth, not README prose, which has previously gone stale here.

## Working rules

### Verify against source before claiming or coding

The codebase is ground truth — **not** memory, not prior conversation, not these
notes, not the model's recollection. Before you:

- write code that calls an endpoint, function, type, or schema, **or**
- assert how something behaves (a route's path, a request/response field, a
  default, a flow),

…read the **current** source and confirm the actual shape. Route paths,
field names, schemas, and line numbers drift as the code changes — re-check
rather than assume. If a referenced file/route/field can't be found in the
current code, treat the reference as stale and verify, don't invent. If you
cannot verify a claim against the code, say so explicitly instead of stating it
as fact.

> Why this rule exists: memory and prior context are point-in-time snapshots and
> go stale (e.g. files get moved or deleted). Confirming against live source is
> the safeguard against acting on outdated or hallucinated assumptions.

### Don't delete a definition and leave its call sites

When you delete, rename, or move a function/const/import, grep for every
remaining reference **in the same edit** — a refactor that drops a definition but
leaves callers compiles fine in plain JS and only explodes at runtime with
`X is not defined`. This is not hypothetical: commit `a7cc6fc` deleted
`backend/agents/worker.js`'s ECIES helper block (`ECIES_PUBKEY_LENGTH`,
`aesGcmDecrypt`, …) but left the call sites, and every A2A agent crashed in prod
with `ECIES_PUBKEY_LENGTH is not defined` the instant it tried to decrypt a brief.

Guardrails that catch this class automatically:

- `backend/agents/*.js` is type-checked via `backend/tsconfig.agents.json`
  (`npm run typecheck:agents`; `npm run typecheck:all` runs src + agents). The
  main `tsconfig.json` only covers `src/**`, which is why the worker shipped
  unchecked.
- A local Claude Code `Stop` hook (`.claude/hooks/no-undef-symbols.sh`, wired in
  `.claude/settings.json`) blocks finishing a turn when changed backend JS/TS
  references an undefined symbol (`TS2304`/`TS2552`). Note `.claude/` is
  gitignored, so this hook is per-machine — `npm run typecheck:agents` (ideally
  wired into CI via `typecheck:all`) is the shared, enforceable guard.
