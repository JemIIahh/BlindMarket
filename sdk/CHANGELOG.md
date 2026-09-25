# Changelog — @blindmarket/sdk

This package is 0.x: a minor version may contain breaking changes. They are
listed here with how to migrate.

## 0.8.1

### Behaviour changes

- **`WorkerRuntime` accepts a task only where its RPC is on the backend's
  network.** Before each `/accept` it checks that its RPC for the task's chain
  answers the chain id `GET /health/settlement` lists for that chain. A chain
  keeps its key when the backend moves it to another network (Arc Testnet
  5042002, Arc mainnet 5042). A runtime still on the old network used to accept,
  which assigns the task on-chain for good, and then fail `submitEvidence` with
  `WRONG_CHAIN`. On a mismatch it now leaves the task alone while it stays
  listed (`task_failed`, "not accepted: …"). A chain it cannot check, because
  the RPC or the backend cannot be read or the chain is not listed, holds
  nothing back: `deliverResult()` checks again before it signs.

## 0.8.0

### Breaking / behaviour changes

- **Escrow calls are verified before signing (C41).** `sdk/src/escrowCalls.ts`
  decodes the backend-built tx before anything is signed and checks it is
  exactly the expected function (`createTask`, `cancelTask`/`claimTimeout`,
  `submitEvidence`) with the expected arguments, canonical calldata with no
  trailing bytes, targeting the escrow from `/health/settlement` for the named
  chain, carrying no value (except a native `createTask` where value must equal
  the computed amount), and — for `/submit` — an evidence hash equal to
  `keccak256(JSON.stringify(resultData))`. Only `{ to, data }` is signed.
  Anything else fails with `ESCROW_MISMATCH`, `TX_MISMATCH`, `CHAIN_MISMATCH`
  or `CHAIN_UNKNOWN` before any signature.
- **`deliverResult` reads `/health/settlement` first** to resolve the escrow.
- **`WorkerRuntime` applies `minReward` when picking tasks (C40).** Browse
  skips listings whose reward is missing, malformed, not 6-decimal USDC, or
  below the floor. Values of 10^12 or more are treated as legacy 18-decimal
  and divided down. Unset, `''` or `'0'` means no floor. Requires the backend
  `/accept` gate from #89 (403 `BELOW_MIN_REWARD`); a runtime with `minReward`
  set claims nothing until listings carry `meta.reward`, so deploy the backend
  first.
- **`start()` validates `minReward`.** A non-whole-number floor throws.
- **Timeout-claim escalation (C18).** After the escrow upgrade, `claimTimeout`
  on a Submitted task sends delivered work for review instead of refunding.
  `RefundResult.outcome` reports `'escalate'` (from `POST /tasks/:id/timeout`).
- **`list_open_tasks` / `listTasks()` list the legacy 0G registry** and point
  to `browse_a2a_tasks`. `fetch_brief` no longer says a `rootHash` comes from
  `list_open_tasks`.

## 0.7.0

### Changes

**`postTask()` posts a task end to end on the posting chain.** Before, the SDK
only built an unsigned `createTask`, leaving the approve, the send, the index
and the chain to the caller. Nobody could post from the SDK on Arc,
production's posting chain. `postTask(params, opts)` does the whole post from
the API key owner's wallet:

- encrypts the brief (or posts it `privacy: 'public'`) and wraps its key to
  the posting chain's executors
- uploads it, and approves the escrow for the amount
- funds the escrow and lists the task (`/a2a/tasks/index`)

It checks everything before anything is sent: the signer is the API key's
own wallet, its RPC is on the posting chain, the wallet holds the amount, and
the backend built the tx for the escrow it advertises. The funding hash and
the full listing body go to `onFunded` as soon as it is sent. An error after funding carries it
(`err.txHash`) and the listing body (`err.body.indexParams`), and the new
`indexTask()` finishes the listing without paying again.

**`reviewResult(taskHash, { passed, reasons })`** approves or rejects the
result of a task you posted with `verificationMode: 'manual'`.

**Refunds are signed and sent for you.** `cancelAndRefund(taskId)` and
`reclaimAfterTimeout(taskId)` check the signer is on the task's chain first.
`getSettlement()` returns where tasks are posted and in what token.

**`deployAgent()` can pay the deploy fee.** Deploying a hosted agent costs
1 USDC on Arc on production, and `deployAgent()` only posted, so every SDK
deploy was refused with `NO_DEPLOY_CREDIT`.
`deployAgent(params, { payFee: true })` now pays it from the API key owner's
wallet: the configured `executor` (set `rpcUrls.arc`) or `opts.payer`.

- **An unspent AgentFactory credit pays first.** Otherwise nothing is paid
  until the request, the payer's wallet, the payer's chain (the terms'
  `chainId`), and the fee against `maxFeeRaw` (default 1 USDC) have all been
  checked.
- **The hash is handed back.** It goes to `onFeePaid` as soon as it is sent,
  and onto any error after that as `err.feeTxHash`. Pass it back as
  `params.feeTxHash` and nothing is paid twice.
- **A retry returns your agent.** If the payment already created one of your
  agents, you get that agent back with `alreadyDeployed: true`.

New `getDeployFee()` returns what the backend charges. New `validateDeploy()`
runs the deploy's checks with nothing paid or saved.

**`ApiError` carries `reason`** (e.g. `PAYER_NOT_LINKED`), and `feeTxHash` /
`txHash` when an error comes after a payment. It is the same class, and its
constructor is unchanged.

**Breaking:** without `payFee` or `feeTxHash`, a backend that charges now
answers `DEPLOY_FEE_REQUIRED` (402) with the price, instead of
`NO_DEPLOY_CREDIT`. An unspent AgentFactory credit still deploys without
paying. Code that matched `NO_DEPLOY_CREDIT` should match
`DEPLOY_FEE_REQUIRED`.

### Fixes

**`DeployAgentParams` matches the backend.**
- `provider` includes `'0g-compute'`.
- `apiKey` is optional (not needed for `0g-compute`).
- `skillSlugs`, `toolSecrets` and `feeTxHash` are accepted.
- `ownerAddress` is optional and ignored. The backend never read it; the owner
  is the API key's wallet.
- The `deploy_agent` tool follows, and never pays: it takes `feeTxHash`.

**`CreateTaskTx` gains `chain` and `chainId`.** `cancelTask()` and
`claimTimeout()` are typed with them too. The backend always returned them.

**`uploadBlob()` takes base64**, as the backend reads it. The parameter was
typed `Hex`, and a hex string uploaded the wrong bytes.

## 0.6.4

### Fixes

**`WorkerRuntime` can take tasks on Arc.** Production posts new tasks on Arc
(Arc Testnet, chain 5042002) since backend #73, but `SETTLEMENT_CHAINS` was
`['0g', 'base']`, so a runtime never declared Arc and threw on any task whose
`chain` was `'arc'`. `SETTLEMENT_CHAINS` is now `['0g', 'base', 'arc']` and
`A2APublicTaskMeta.chain` includes `'arc'`. To claim Arc tasks set
`rpcUrls.arc`; a runtime without it keeps declaring only the chains it has an
RPC for, and says so at start. The README examples and the "no RPC
configured" error now name `rpcUrls.arc` first.

## 0.6.3

### Fixes

**A scheduled NEEDS_WRAP re-try is no longer refused by its own back-off.**
`WorkerRuntime` re-tries a task that is waiting for its key to be wrapped on a
timer. A timer can fire up to a millisecond before `Date.now()` reaches the
back-off it was set for, and the re-try then counted as too early: nothing
re-tried the task until the next browse (by default up to 15 s later). Nothing was lost,
it was only late. No API change.

### Documentation

The `supportedChains` doc comments (`RegisterExecutorInput`,
`ExecutorProfile`, `WorkerRuntime`, the `register_as_executor` tool, README) now
say what newer backends do with the list: they leave the executor out of
offers and refuse bids and `/accept` (409 `CHAIN_UNSUPPORTED`) for tasks on
chains it did not declare. Older backends only store it. No backend filters
browse results by it, so `WorkerRuntime` still checks a task's chain itself.

## 0.6.0

### Breaking changes

**`createTask(params)` takes `CreateTaskRequest`.** The old shape
(`agent` / `category` / `deadline`) was rejected by the backend with 400, so it
never worked. `taskHash` and `duration` are now required; `agent`, `category`
and `deadline` are gone.

```ts
// before (always 400)
await bb.createTask({ agent, amount, token, category, locationZone, deadline });
// after
await bb.createTask({
  taskHash,            // bytes32: sha256 of the encrypted brief
  token, amount, locationZone,
  duration: '86400',   // seconds, as a string; deadline = now + duration
  targetExecutorType: 'agent',
  verificationMode: 'auto',
  verificationCriteria: { min_length: 40 },
});
```

**`browseA2ATasks()` and `getPostedTasks()` return `{ tasks: A2ATaskEntry[]; total? }`.**
Entries are `{ meta, state }`, which is what the backend has always sent; the
old `A2ATaskState[]` type made `task.taskId` / `task.status` read `undefined`.

```ts
// before                          // after
tasks[0].taskId                    tasks[0].state.taskId
tasks[0].status                    tasks[0].state.status
                                   tasks[0].meta.chain   // settlement chain
```

**`getExecutions()` returns `{ executions: A2ATaskEntry[]; total }`**, not
`{ tasks }`. Rename the destructured field and read ids from `entry.state`.

**`createBlindMarketTools(bb)` / `tools(bb)` omit `submit_result` unless the
client has a signer.** The tool now performs the whole delivery (submit → sign
`submitEvidence` → finalize); without a key it could only strand tasks.
Construct the client with `new BlindMarket({ apiKey, executor: { privateKey, rpcUrls } })`
to get it back. When it is omitted a one-time `console.warn` says so.
`createA2ATools()` / `createTaskTools()` are affected the same way.

**`WorkerRuntime` requires a key.** `start()` throws unless `privateKey` (the
wallet that owns the API key) or `existingPrivateKey` is set. A keyless runtime
used to register a random wallet's public key over the owner's on every start,
accept tasks (assigned on-chain, irrevocably) and then fail to sign their
delivery. To only read tasks, call `bb.browseA2ATasks()`.

**`WorkerRuntime` has no default RPC.** `rpcUrl` used to default to 0G
*testnet* while `apiBase` defaults to *production*. `start()` now throws unless
`rpcUrl` (0G) and/or `rpcUrls.base` is set; pass the RPC of the network your
backend settles on. `rpcUrl` is 0G only and never stands in for Base.

**`WorkerRuntime` restore mode checks the key.** With `existingPrivateKey`,
`start()` throws if the key's address is not the executor the API key resolves
to. `existingAddress` is now an optional cross-check and `existingPublicKey` is
ignored (both are derived from the key), so `existingPrivateKey` alone is enough.

**`createAgent({ privateKey })` verifies ownership before registering.** It
calls the new `bb.whoami()` (`GET /api/v1/api-keys/whoami`) and throws
`ApiError` 409 `OWNER_MISMATCH` without touching `/register` when the key is
not the API key's owner. Previously the check ran after `/register` had already
replaced the owner's public key. A legacy shared `AGENT_API_KEY` (principal
`"agent"`, not a wallet) is refused the same way. On a backend without the
whoami route the old after-the-fact check still runs.

### Added

- `deliverResult()`, `rebroadcast()`, `BlindMarketConfig.executor`, `bb.canSign`.
- `bb.whoami()`.
- `supportedChains` on `registerExecutor()` / `createAgent()`, and
  `WorkerRuntime.declaredChains`. **It is a declaration only**: the backend
  stores it and does not filter offers or `/accept` by it. `WorkerRuntime`
  enforces it client-side (browse skips other chains; a post-accept check
  fails the task before the handler runs).
- `WorkerRuntimeConfig.assignmentPendingTimeoutMs` (default 3 min).
- `ApiError.code` carries the backend error code.

### Fixed — `WorkerRuntime` accept handling

- `503 ASSIGNMENT_PENDING` is re-tried (the backend keeps the task for the
  caller) instead of marking the execution failed and holding the task forever.
  If it never confirms, the slot is freed and the accept is re-tried from the
  browse loop with back-off, at most 6 rounds.
- `503 REWRAP_FAILED` / `SETTLEMENT_FAILED` (the backend released the task)
  no longer leave a dead entry in `executions`; the task can be claimed again
  after a per-task exponential back-off.
- `403 NEEDS_WRAP` no longer holds a concurrency slot for `wrapTimeoutMs`.
  After a timeout the task is backed off exponentially instead of being picked
  up again by the next browse, which let three unwrappable tasks starve a
  runtime indefinitely. A brief sealed to a rotated custody key is skipped at
  once.
