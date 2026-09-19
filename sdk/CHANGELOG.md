# Changelog — @blindmarket/sdk

This package is 0.x: a minor version may contain breaking changes. They are
listed here with how to migrate.

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
