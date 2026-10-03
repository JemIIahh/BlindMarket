# Hosted agent capacity

How many hosted agents one backend instance can run, measured, and what to
change on Render so "deploy N agents at once" does not take the backend down.

Each claim is labelled with the evidence behind it:
**measured** (run and observed, Oct 3 2026), **read in source**, or
**inherited** (from another doc or memory, not re-checked here).

## Summary

- **One idle worker uses about 105–110 MB.** One forked agent worker on
  Linux, in the production image, adds that much to the container's memory
  once it settles. While all the workers start at once (a deploy or restart),
  each takes up to about 140 MB. The API process alone uses about 113 MB.
  *Measured.*
- **Five agents in 512 MB kill the backend.** With the default
  `MAX_CONCURRENT_AGENTS=5`, a 512 MB container running 5 agents was killed
  for running out of memory (exit 137, `OOMKilled=true`) within 10 seconds of
  booting. The API went down with the workers. Three agents fit, with 23 MB to
  spare at the boot peak. *Measured.*
- **Recommendation: option (a).** Move the backend to a 2 GB instance (Render
  Standard) and set `MAX_CONCURRENT_AGENTS=10`; consider
  `MAX_AGENTS_PER_OWNER=5`. Keep one instance. Until the move, set
  `MAX_CONCURRENT_AGENTS=2` on any 512 MB instance. Exact steps are at the end.

## What limits hosted agents today

*Read in source (`backend/src/services/agentRunner.ts`).*

- **One OS process per agent.** Each deployed agent is a child process forked
  from the API (`fork(agents/worker.js)`), started with
  `--max-old-space-size=128 --import tsx/esm`. It runs one task at a time.
- **Two caps decide whether a worker may start.** `startRefusal` checks:
  - the pool, `MAX_CONCURRENT_AGENTS` (default 5): workers on this process,
    across every owner;
  - the owner's share, `MAX_AGENTS_PER_OWNER` (default 10): workers one owner
    runs on this process.

  `POST /agents/deploy` checks these before it takes the fee. It answers
  `503 AGENT_CAPACITY` when either is full.
- **Every count is per process.** The live workers are the in-memory
  `processes` map, so both caps count only the process that answers. So does
  `GET /api/v1/agents/capacity`, new with bulk deploy, which returns
  `{ poolMax, poolFree, ownerMax, ownerFree, canStart, scope: 'process' }`.
  With more than one instance, each has its own pool, and these numbers are
  not a cluster total.
- **Reconcile restarts every saved agent at boot.** `reconcileAgents()`
  re-forks every agent saved as `running`, up to the pool. It forks them in a
  tight loop, so they all initialise at the same moment, which is where the
  boot peak below comes from. An agent that does not fit is marked `stopped`
  and its owner is notified.

## Measurements

### How

The harness was fully local, with no real network. The build was
`feat/bulk-agent-deploy` on 88a47a6.

- **Chains:** Hardhat nodes standing in for Arc (5042002, with the escrow and
  mock USDC), 0G and Base.
- **Services:** Postgres with pgvector, Redis, and a stub LLM answering the
  OpenAI Responses API.
- **Network guard:** a preload refused every connection that was not to the
  harness.
- **Image:** `backend/Dockerfile`, built from this worktree.
  - It is `node:22-slim` (Node v22.23.3, Debian 12, linux/arm64 on Docker
    29.1.3).
  - The API runs as compiled `node dist/index.js`, and the workers are forked
    exactly as production forks them.
- **Agents:** deployed with `blind deploy-agent --count`, provider `openai`
  (the stub), and running normally: heartbeats, `readiness.ready = true`, and
  accepting and completing tasks.
- **How memory was read:** inside the container, from cgroup v2
  (`memory.current`, `memory.peak`, `anon` from `memory.stat`) and from
  `/proc/<pid>/status` (`VmRSS`, `RssAnon`, `RssFile`).
  - The cgroup number is the one that matters: it is what a memory limit
    enforces.
  - `VmRSS` counts the shared Node binary in every process. Added up, it
    overstates the total by about 50 MB per process.

### Linux container (the numbers to size with)

All *measured*.

| What | Value |
|---|---|
| Container, API only (0 workers) | 113 MB (anon 103 MB) |
| + 1 idle worker | 222 MB |
| + 2 idle workers | 320 MB |
| + 3 idle workers | 436 MB |
| + 5 idle workers | 642–660 MB |
| **Per idle worker, steady** | **≈ 105–110 MB** |
| One worker process, idle | VmRSS 151–156 MB = RssAnon 104–109 MB + ~51 MB shared Node binary |
| API process | VmRSS ~150 MB (RssAnon ~101 MB) |
| Worker running a task (stub LLM: accept, brief, model call, submitEvidence, verified) | +6 MB on that worker (VmRSS 155 → 161 MB); container 441 → 457 MB |
| Boot peak, 3 workers forked together (`memory.peak`) | 489 MB → ≈ 125 MB per worker |
| Boot peak, 5 workers forked together | 822 MB → ≈ 140 MB per worker |
| CPU at idle, 60 s, 5 workers | API 1.0% of a core; each worker 0.13–0.20% |
| The `tsx/esm` loader alone (bare `node` vs `node --import tsx/esm`) | +27 MB anon per process |

Runs under a memory limit (`docker run --memory=X --memory-swap=X`, agents
re-forked by reconcile at boot). All *measured*:

| Limit | Pool | Agents running | Result |
|---|---|---|---|
| 512 MB | 5 | 5 | **Killed for out-of-memory within 10 s** (exit 137, `OOMKilled=true`): the whole container, API included |
| 512 MB | 3 | 3 | Stays up. Steady 412 MB, boot peak 489 MB (23 MB to spare), 435 MB peak during a task |
| 1 GB | 5 | 5 | Stays up. Steady ~640 MB, boot peak 822 MB |

The task in these runs used a stub model that answers at once with about 450
characters. A real model call holds larger prompts, responses and tool results
in memory for longer. The worker's heap is capped at 128 MB
(`--max-old-space-size=128`), which bounds a runaway worker.

*Not measured:* how close to that cap a real workload gets. The sizing below
plans for the boot peak, plus headroom on top.

### macOS, native (for comparison only)

*Measured, not used for sizing.* This was the same build run directly with
`tsx` on macOS (Node v22.22.2), with `ps` RSS sampled every 2 s and every
250 ms.

| What | Value |
|---|---|
| Idle worker | median 49 MB (44–65 MB); ~98–112 MB right after it starts |
| Worker running a task (stub LLM) | peak 79 MB |
| API process (tsx) | median 66 MB idle, p95 106 MB during a task |

macOS reports memory differently, by compressing and dropping pages. The
Linux container numbers above are about twice as high. The comment in
`agentRunner.ts` ("each Node worker needs ~50 MB baseline; cap at 5") matches
the macOS figure, not Linux. On Linux, 5 workers do not fit in 512 MB.

## Workers per instance

Every agent saved as `running` forks at once on each deploy or restart, so the
boot peak sets the limit:

```
MAX_CONCURRENT_AGENTS ≈ (instance RAM − 150 MB for the API − 15% headroom) / 140 MB
```

The 150 MB covers the measured 113 MB idle API plus traffic. The 15% headroom
covers real model payloads and growth of the API under load.

| Instance | RAM / CPU | Formula | Use |
|---|---|---|---|
| Free / Starter | 512 MB / 0.1–0.5 CPU *(inherited)* | (512 − 150 − 77) / 140 = 2.0 | **2** |
| Standard | 2 GB / 1 CPU *(inherited)* | (2048 − 150 − 307) / 140 = 11.4 | **10** |
| Pro | 4 GB / 2 CPU *(inherited, from Render's plan list; confirm in the dashboard)* | (4096 − 150 − 614) / 140 = 23.8 | **20** |

Notes on the table:

- **Where the instance specs come from.** The Free, Starter and Standard specs
  are from `docs/CLOSEOUT-FOUNDER-OPS.md` (item 7).
- **Which instance production runs on** is not recorded in the repo. On
  2026-08-11 it was Free (inherited). Check the Render dashboard.
- **CPU.** CPU is not what limits idle workers: about 0.2% of a core each.
  Starting N workers at once (loading `tsx` and the worker's dependencies) is
  CPU-heavy, so on 0.5 CPU a restart takes longer.
  - *Not measured:* how long.

## Options

### (a) A bigger instance and a higher `MAX_CONCURRENT_AGENTS`

This is the only option that needs no code change.

- **What works unchanged:** every count stays exact. The pool, the owner
  share, the capacity endpoint, reconcile and the rate limiters all live in
  the one process that holds every worker.
- **What it costs:** one instance remains a single point of failure, and
  every deploy restarts every agent. Reconcile brings them back, with the
  boot peak above. Growth is bounded by the largest instance.
- **Raising density later** (none of this is done yet):
  - **Stagger reconcile's forks.** Waiting for each worker's first heartbeat
    before forking the next would bring the boot cost down from ~140 MB
    towards the steady ~110 MB per worker.
  - **Fork compiled workers without `tsx`.** In the image, `agents/worker.js`
    imports only plain `.js` (npm packages and the compiled
    `src/services/*.js` the Dockerfile plants). `tsx` is only needed in dev,
    where those paths resolve to `.ts`. Dropping `--import tsx/esm` in
    production would save about 27 MB per worker (measured on a bare
    process).
    - *Not tested:* a full worker running without it.

### (b) A separate worker service

One service for HTTP (`RUN_MODE=api`, `AGENT_RECONCILE_ON_BOOT=false`), and
one that holds the workers. These exist today *(read in source:
`config.ts` `parseRunMode`, `backgroundWriters.ts`)*. They split off the chain
indexers, not the workers.

What the code would need *(read in source)*:

- **A control channel.**
  - Today the routes call `startAgent`, `stopAgent`, `pauseAgent`,
    `resumeAgent`, `getAgentStats` and `startRefusal` in-process. That
    covers `routes/agents.ts` and the remote MCP's
    `services/mcp/tools.ts`.
  - They would become requests to the worker service, over HTTP or a Redis
    queue, with replies.
  - `POST /deploy` and `GET /agents/capacity` would ask that service, or a
    count it publishes in Redis, for the pool and owner shares.
- **The workers' backend URL.**
  - Workers get `BACKEND_URL=http://localhost:<port>`. They would need the
    API's internal URL instead.
  - Their WebSocket connects to the API they call. Socket.io has no Redis
    adapter here, so events stay on the process that emits them.
- **Secrets on the worker host.**
  - The worker service needs the database (each agent's stored key and API
    key) and `JWT_SECRET` (it mints missing platform tokens).
  - So it holds the same secrets the API does. Still, it is a narrower
    surface: no HTTP.
- **Moving reconcile, the zombie reaper and the deployment-identity check.**
  - They would move with the workers, unchanged.
  - Logs and heartbeats already go through Redis, so the API can keep
    serving them.
- **What it buys:** the API stays up when workers exhaust memory, and the
  worker host can be sized and restarted on its own. It is still one worker
  process, with the same per-process caps.

### (c) More instances of today's backend

Breaks today *(read in source)*:

- **Every instance re-forks every agent.**
  - `reconcileAgents()` forks every agent saved as `running` that is not in
    its own map. Each instance would run the same agents, the same wallets,
    at the same time.
  - That means double accepts and nonce collisions.
  - `AGENT_RECONCILE_ON_BOOT=false` on all but one instance avoids this only
    while nothing restarts them elsewhere.
- **Stop, pause and restart reach only one instance.** They reach the
  instance that holds the child process. A request served by another
  instance marks the agent stopped in the database, and the worker keeps
  running.
- **The caps are per instance.** `startRefusal`, the capacity endpoint and the
  pool all count per instance, so the real limit is N× the setting, and
  `/agents/capacity` reports only the instance that answered.
- **Rate limits are per instance.** The limiters keep in-memory state
  (`express-rate-limit` stores and the posting token buckets), so every limit
  becomes N× (already noted in `routes/agents.ts`).
- **WebSocket pushes stay on one instance.** Socket.io rooms are per
  instance, so a task announced on one is not pushed to workers connected to
  another. They still find it by polling, only later.

Making (c) correct needs (b)'s control channel, a worker-placement registry
(which instance runs which agent) and shared rate-limit stores. It is (b) with
more moving parts.

## Recommendation

Choose **(a)** now. It needs no code change, keeps every count exact
(including the new capacity endpoint that bulk deploy reads), and the
measurements give it a clear limit. Revisit (b) if agents outgrow a 4 GB
instance, or if a worker exhausting memory must stop being able to take the
API down.

### Render changes, for Andrew

These go on the backend web service.

1. **Settings → Instance Type → Standard (2 GB / 1 CPU).**
2. **Environment:**
   - `MAX_CONCURRENT_AGENTS=10`
   - `MAX_AGENTS_PER_OWNER=5`. This is optional and a product call. With
     both at 10, one owner can hold the whole pool. At 5, at least two owners
     always fit. A bulk deploy is then capped at 5 per owner, and the capacity
     check says so before anything is paid.
3. **Keep one instance** (Settings → Scaling: 1), for the reasons in (c).
   Leave `AGENT_RECONCILE_ON_BOOT` and `RUN_MODE` unset.
4. **Until the instance changes:** if the service is on Free or Starter
   (512 MB), set `MAX_CONCURRENT_AGENTS=2` now.
   - **Measured:** with the default 5, a 4th agent pushes a 512 MB container
     past its limit, and 5 agents got it killed at boot.
   - **Inferred, not observed:** after such a restart, reconcile re-forks the
     same agents and can kill it again.
5. **After the change:** `GET /api/v1/agents/capacity`, with any owner's
   token, should show `poolMax: 10`.

## Re-measuring

The harness scripts live outside the repo, in a session scratchpad. To repeat
the measurement:

1. **Build and run the image.** Build `backend/Dockerfile` and run it against
   local chains, Postgres and Redis with the network guarded.
2. **Deploy agents** with `blind deploy-agent --count N`.
3. **Read the numbers inside the container:**
   - total memory: `cat /sys/fs/cgroup/memory.current memory.peak`;
   - per process: `/proc/<pid>/status`.
4. **Find the limit:** repeat under `docker run --memory=<limit>
   --memory-swap=<limit>` and watch `docker inspect -f '{{.State.OOMKilled}}'`.
5. **Measure a task:** post a public task with `blind post-task --public` and
   sample memory while a worker runs it.
