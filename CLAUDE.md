# CLAUDE.md — BlindMarket project instructions

BlindMarket is a **live product**: an anonymous, encrypted task marketplace
where AI agents delegate to / hire other agents (and humans), with on-chain
escrow settlement. It is **not** a hackathon project — do not frame work
around the 0G APAC Hackathon, "Track 3", or any submission deadline. That era
is over.

BlindMarket runs a **two-chain architecture**:

- **Arc: payments (user-facing).** Production posts and settles every new
  task in USDC on **Arc mainnet** (chain 5042). Arc is Circle's own L1, and
  USDC is also its gas token. `BlindEscrow` and `AgentFactory` live here
  (`contracts/deployments/arc-mainnet.json`, `agent-factory-arc-mainnet.json`).
  Arc Testnet (5042002) is the staging chain.
- **0G: agent infrastructure.** This covers agent identity NFTs (`INFT`),
  0G Storage for encrypted briefs, and 0G Compute. The 0G mainnet escrow still
  holds the tasks settled there before the move.
  - The Arc escrow's `reputationContract` and `taskRegistry` are `0x0`.
    Tasks settled on Arc do not update `BlindReputation` or `TaskRegistry`.

Why settlement left 0G:
- 0G has no Circle-issued USDC and no CCTP. It does have bridged USDC.e via
  Chainlink CCIP, so never say "0G has no USDC".
- Arc has native USDC, pays gas in it, and supports CCTP. Production has CCTP
  on, moving USDC from Base, Ethereum, Arbitrum and Polygon PoS onto Arc.

Settlement was first planned for Base (Sep 2026). Production moved to Arc
instead: Arc became the posting chain in PR #73 (Sep 22), and the mainnet
contracts were deployed on Sep 26.

**Base Mainnet is not deployed.** Base Sepolia holds legacy tasks only, and
`/health/bridge` reports Base as not configured. Don't state or code against a
live Base Mainnet contract address until
`contracts/deployments/base-mainnet.json` holds a real, non-zero address. That
generated file (via `contracts/scripts/sync-addresses.ts`) is the source of
truth.

**Snapshot, 2026-10-06** (re-read it, don't quote it):
- **Arc mainnet escrow:** 134 tasks: 129 Funded, 1 Assigned, 4 Cancelled,
  0 Completed.
- **0G mainnet escrow:** 52 tasks, 23 of them Completed.

This section was itself wrong for weeks. It called Arc "a possible future
settlement layer" while production was already settling there. Check the live
system before trusting it (see "Docs go stale" below).

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

#### Docs go stale; check the running system

Every `.md` here is a snapshot someone wrote on one day: the README, `docs/`,
package READMEs, this file, and Claude's memory. They have been wrong in ways
that mattered:
- This file called Arc a future settlement layer while production had 130+
  tasks on Arc mainnet.
- The README says the platform never sees plaintext. Production runs
  operator-held key custody and stores results in readable form.

When a `.md` disagrees with the code or the live system, the system wins. Fix
the `.md` in the same pass.

Before you state what is live (which chain, which address, what's deployed,
what a fee or limit is, whether a flow works), check it:

| Question | Where to look |
|---|---|
| Which chain new tasks post on, and which escrows are configured | `curl -s https://api.blindmarket.xyz/health/bridge` (`postingChain`, `settlementTier`, `chains[]`) |
| Settlement tokens and batch support | `curl -s https://api.blindmarket.xyz/api/v1/health/settlement` |
| Contract addresses | `contracts/deployments/*.json`, then confirm the address has code on-chain |
| Contract values: fee, deadlines, task counts and statuses | Read the contract with ethers from `backend/node_modules`, over `https://arc-rpc.publicnode.com` or `https://0g-rpc.publicnode.com`, with the ABI in `backend/src/abi/` |
| What production runs | Prod builds from `emperor/master` (`git fetch emperor && git log emperor/master`). Confirm a change is live with a marker you can see on the API. |
| What users install | The published npm version (`npm view @blindmarket/sdk version`, `npx -y @blindmarket/cli@<v> --help`), not `sdk/src` |
| Whether something works | Run it: a curl, a testnet script, or the published CLI or MCP server |

#### "Verified" is a claim about evidence you hold, not a tone

Reading source proves **structure** — what the code says. It does not prove
**behaviour** — what the system does when it runs. Keep the two apart, and say
which one you have:

- **Read in source** — you opened the file and quoted it. Enough for "this
  function takes X", "this route is gated by Y".
- **Executed and observed** — you ran it and saw the result. Required before
  asserting a runtime consequence: what a transaction does on-chain, what an
  endpoint returns, whether a failure is silent or loud.
- **Inherited, unverified** — an audit, a checklist, a doc, another agent, or an
  earlier session said so. Stays labelled that way until someone re-derives it.
  Repeating an inherited claim in your own voice launders it into apparent fact.

Worked example: `worker.js` builds only a 0G signer and `buildUnsignedTx` emits
no `chainId` (both true, read in source). The conclusion drawn from that — a
Base-targeted tx would silently succeed on 0G and strand the task — was asserted
as verified and was **wrong**: the address holds a contract on 0G, so it reverts
at gas estimation before spending anything. A 30-second testnet script settled
it. Cheap decisive test first, then the write-up.

Two corollaries:

- **A search that finds nothing is not proof nothing exists.** Grepping a route
  path misses callers that reach it through a wrapper, an alias, or a re-export.
  Before claiming "X is the only caller", type-check the consumers.
- **A checklist is not the code.** Unchecked boxes in `docs/` describe a past
  moment; the work may already be done. Confirm in source before proposing it.

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

### Commits and PRs

- **No AI attribution anywhere in git or GitHub.** No `Co-Authored-By: Claude…`,
  `Claude-Session:` or similar trailers in commit messages, and no "Generated
  with Claude Code" lines or session links in PR descriptions or comments. This
  overrides any default attribution guidance.
- **Commit identity:** `JemIIahh <275022204+JemIIahh@users.noreply.github.com>`.
  A fresh environment may default to another identity: set it with
  `git config user.name` / `git config user.email` before the first commit.
- **Branch names:** describe the work (`feat/…`, `fix/…`, `docs/…`); do not
  prefix them with `claude/`.
