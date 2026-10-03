# Hosted agent capacity

How many hosted agents the backend can run, measured. This covers what to set
on the production host, a VPS that runs the backend Docker image, so that
deploying many agents never runs it out of memory.

Each claim is labelled with the evidence behind it:

- **measured:** run and observed, Oct 3 2026;
- **read in source:** taken from the code;
- **inherited:** from the founders, another doc or memory, not re-checked
  here;
- **estimate:** a number to plan with, not a measurement.

## Summary

- **Memory per worker.** These are container memory figures for the
  production image, on Linux. *Measured.*
  - The API alone uses about 113 MB.
  - Each idle agent worker adds about 105–110 MB.
  - While reconcile starts every saved agent together, each worker takes up
    to about 140 MB.
  - A task added about 6 MB to its worker. That was with a stub model, so a
    real one will add more.
  - A runaway worker is bounded at about 225 MB by its heap cap. *Computed
    from the measured heap split, not observed.*
- **CPU is not what limits it.** *Measured.*
  - An idle worker uses about 0.2% of a core.
  - Starting a worker costs about 3 CPU-seconds.
  - On 8 vCPUs, memory runs out long before CPU does.
- **The production VPS:** 8 vCPU, 16 GB RAM, 320 GB disk, NYC *(inherited,
  from the founders)*.
  - Start at `MAX_CONCURRENT_AGENTS=50`. That fits even if every worker grew
    to its heap cap (45 if Postgres also runs on the box).
  - The measured ceiling is about 80, with the OS, Docker, Redis, the
    indexer, the API and a 2 GB reserve kept free.
  - To go past 50, set the cap to 100 and let the new memory check stop
    starts at whatever the box can really hold.
- **A new memory check refuses starts that would run out of RAM.**
  `startRefusal` now refuses to start a worker when free memory, less one
  worker, would fall below `AGENT_MEMORY_RESERVE_MB`. It reads the
  container's cgroup limit when one binds, and the host's free memory
  otherwise.
  - *Measured on the image:* the same setup that was killed for running out of
    memory before (512 MB, 5 saved agents) now starts 2 agents. It refuses 3
    with "The server is low on memory — stop an agent or try again later",
    and stays up.
  - **Workers are now killed before the API.** Each worker is marked as the
    OOM killer's first choice, so if memory runs out anyway, the kernel ends
    a worker instead of the API. *Measured:* worker `oom_score` 1011 against
    the API's 678.

## What limits hosted agents

*Read in source (`backend/src/services/agentRunner.ts`,
`memoryHeadroom.ts`).*

- **One process per agent.** Each deployed agent is a child process forked
  from the API (`agents/worker.js`), started with
  `--max-old-space-size=128 --import tsx/esm`. It runs one task at a time.
- **Three checks before a worker starts.** `POST /agents/deploy` runs
  `startRefusal` before taking the fee, and answers `503 AGENT_CAPACITY` if
  any of these is full:
  - `MAX_CONCURRENT_AGENTS` (default 5): a hard cap on workers in this
    process, across all owners.
  - `MAX_AGENTS_PER_OWNER` (default 10): workers one owner runs in this
    process.
  - **Memory:** free memory, less 150 MB per worker started in the last
    30 s (their memory may not show yet), less one more worker (150 MB),
    must stay at or above `AGENT_MEMORY_RESERVE_MB`.
    - The default reserve is an eighth of the box or of the container's
      limit, clamped between 64 and 2048 MB: 2048 MB on 16 GB, 128 MB on
      1 GB, 64 MB on 512 MB.
    - Free memory means `memory.max − (memory.current − inactive_file)`
      under a cgroup v2 limit, the same way `docker stats` counts it, never
      more than the host has. Without a limit it is `os.freemem()`, which on
      Linux is MemAvailable.
    - On a non-Linux dev machine nothing is measured and memory refuses
      nothing, because macOS `os.freemem()` leaves out reclaimable memory.
- **What `GET /api/v1/agents/capacity` reports.** It returns
  `{ poolMax, poolFree, ownerMax, ownerFree, memory, canStart, scope: 'process' }`.
  - `memory` is `{ availableMb, reserveMb, workerMb, slotsFree, source }`,
    or null where memory is not measured.
  - `canStart` is false when any of the three checks is full.
  - The web form, CLI, SDK and MCP server count all three before a bulk
    deploy pays anything.
- **Every count is per process.** All of this is for the process that
  answers. Workers live in its in-memory map, so another backend instance has
  its own pool.
- **Reconcile restarts saved agents at boot.** `reconcileAgents()` re-forks
  every agent saved as `running`, in one loop, so they all start at once.
  That is where the boot peak comes from.
  - An agent that is refused (pool, owner share or memory) is marked
    `stopped`, and its owner is notified.

## Measurements

### How

The harness was fully local, with no real network.

- **Image:** built from `backend/Dockerfile` on `feat/bulk-agent-deploy`:
  `node:22-slim`, Node v22.23.3, Debian 12, linux/arm64 under Docker 29.1.3.
  - The API runs as `node dist/index.js`, and workers are forked exactly as
    in production.
- **Chains:** Hardhat nodes standing in for Arc (with the escrow and mock
  USDC), 0G and Base.
- **Services:** Postgres with pgvector, Redis, and a stub LLM answering the
  OpenAI Responses API.
- **Network guard:** a preload refused every connection outside the harness.
  It logged 0 refusals.
- **Agents:** deployed with `blind deploy-agent --count`. They registered,
  passed the model check, and accepted, delivered and settled tasks.
- **How memory was read:** inside the container.
  - cgroup v2 `memory.current`, `memory.peak`, and `anon` from
    `memory.stat`: what a memory limit enforces.
  - `/proc/<pid>/status` (`VmRSS`, `RssAnon`, `RssFile`) per process.
    `VmRSS` counts the shared Node binary in every process, about 50 MB
    each, so added up it overstates the total.
- **How CPU was read:** `utime + stime` from `/proc/<pid>/stat`.

### Memory

| What | Value |
|---|---|
| Container, API only (0 workers) | 113 MB (anon 103 MB) |
| + 1 / 2 / 3 / 5 idle workers | 222 / 320 / 436 / 639–660 MB |
| **Per idle worker** | **≈ 105–110 MB** |
| One idle worker process | VmRSS 151–158 MB = RssAnon 104–109 MB + ~51 MB shared Node binary |
| API process | VmRSS ~150 MB (RssAnon ~101 MB) |
| Boot peak, 3 / 5 workers started together (`memory.peak`) | 489 / 822 MB → **≈ 125–140 MB per worker** |
| Worker during a task (stub model) | +6 MB (VmRSS 155 → 161 MB) |
| Three tasks posted at once, 5 workers | container max 677 MB |
| Worker's dependencies loaded (`process.memoryUsage()` in the image) | heap used 43 MB, heap total 72 MB, RssAnon 121 MB; V8 heap limit 176 MB |
| Worst case per worker (heap at its limit) | ≈ 49 MB outside the heap + 176 MB heap ≈ **225 MB**. *Computed, not observed.* Past it, V8 ends that worker and agentRunner restarts it |
| The `tsx/esm` loader alone (bare `node` vs `node --import tsx/esm`) | +27 MB anon per process |

### CPU

| What | Value |
|---|---|
| Idle, 60 s, 5 workers | API 1.0% of a core; each worker 0.13–0.2% |
| Three tasks posted at once, 40 s, 5 workers | API 2.1%; the worker that ran a task 0.8%; others 0.35–0.4% |
| Starting one worker (cumulative CPU at ~280 s, less idle use) | ≈ 2.5–3.2 CPU-seconds |

The stub model answers at once. A real model call is mostly waiting on the
network, so its CPU cost is small; parsing large responses costs more.
*Not measured:* the CPU cost of real model calls.

### Under a container memory limit

These boot with `docker run --memory=X --memory-swap=X`, with the agents
re-forked by reconcile. *Measured.*

| Build | Limit | Pool | Saved agents | Result |
|---|---|---|---|---|
| Before the memory check | 512 MB | 5 | 5 | **Killed for out-of-memory within 10 s** (exit 137): the whole container, API included |
| Before the memory check | 512 MB | 3 | 3 | Up. Steady 412 MB, boot peak 489 MB |
| Before the memory check | 1 GB | 5 | 5 | Up. Steady ~640 MB, boot peak 822 MB |
| **With the memory check** | 512 MB | 5 | 5 | **Up.** 2 started, 3 refused ("The server is low on memory — stop an agent or try again later"); boot peak 381 MB, `oom_kill` 0 |

With the memory check on, while memory was short:

- `/agents/capacity` returned `memory: { availableMb: 186, reserveMb: 64, slotsFree: 0, source: 'cgroup' }`
  and `canStart: false`.
- `blind deploy-agent --count 1` was refused up front: "the server's memory
  allows 0 more".
- A single deploy was refused before the fee.
- Nothing was paid: the owner's balance and nonce did not change.

### macOS, native (not used for sizing)

On macOS (Node v22.22.2, run directly with `tsx`), an idle worker shows about
49 MB RSS. macOS compresses and drops pages, so the Linux container numbers
above are about twice as high. The old "~50 MB per worker" comment in
`agentRunner.ts` came from figures like this.

## The 16 GB VPS

**What else runs on the box:**

- **Redis, inherited.** The repo's `docker-compose.yml` runs Redis
  (`redis:7-alpine`), the `api` container (`RUN_MODE=api`, where the agents
  run) and an `indexer` container from the same image (`RUN_MODE=indexer`).
  None of them has a memory limit *(read in source)*. Whether production uses
  this file is not recorded.
- **Postgres is not in the compose file.** Production used a managed Neon
  database as of Sep 2026 *(inherited)*. If Postgres runs on the box, keep the
  extra amount shown below.

**Kept free, before any worker:**

| What | MB |
|---|---|
| Memory the kernel reports on a "16 GB" machine (check with `free -m`) | ~16,000 *(estimate)* |
| OS, Docker daemon, reverse proxy | 1,000 *(estimate)* |
| Redis, if local | 512 *(estimate; grows with data)* |
| Indexer container | 256 *(estimate; the API alone measured 113)* |
| API process under load | 512 *(estimate; idle measured 113)* |
| The memory check's reserve (`AGENT_MEMORY_RESERVE_MB`, default on 16 GB) | 2,048 |
| **Left for workers** | **≈ 11,670** (≈ 10,170 if Postgres runs here too: keep another 1,500) |

**Workers that fit in that:**

| Planning per worker | Workers | With local Postgres |
|---|---|---|
| Boot peak, 140 MB (measured) | **≈ 83** | ≈ 72 |
| Idle, 110 MB (measured) | ≈ 106 | ≈ 92 |
| Every worker at its heap cap, 225 MB (computed) | ≈ 51 | ≈ 45 |

**CPU on 8 vCPU:**

- 80 idle workers use about 0.15 of a core.
- Restarting all 80 costs about 240 CPU-seconds, roughly 30 s of all
  8 cores.
- A burst of concurrent tasks adds little. Memory, not CPU, is the limit.

**Recommendation:**

- **Start at `MAX_CONCURRENT_AGENTS=50`.** It fits even if every worker grew
  to its heap cap. If Postgres also runs on the box, start at 45.
- **The measured ceiling is about 80** (72 if Postgres runs on the box).
- **To run past 50, set `MAX_CONCURRENT_AGENTS=100`.** Keep
  `AGENT_MEMORY_RESERVE_MB=2048`. The memory check then stops starts wherever
  free memory really runs out, at about 80 by these numbers. If a worker
  grows after it starts and memory still runs out, the kernel ends a worker,
  not the API. agentRunner restarts it only if memory allows.
- **Set `MAX_AGENTS_PER_OWNER` to the most agents one wallet should run.**
  - The default 10 stops one wallet at 10. If the founders run 50 or more
    agents from one wallet, set it to at least that, for example 60.
  - The same limit then applies to every owner. With `MAX_CONCURRENT_AGENTS`
    at 100, two owners could fill the box.

### Container memory limit

If the backend container runs with a memory limit, it must allow the ceiling.
The limit can come from `docker run --memory`, compose `mem_limit`, or
`deploy.resources.limits.memory`.

- For 80 workers, the container needs about 12 GB (80 × 140 MB at the boot
  peak, plus the API), plus the 2 GB reserve: 14 GB, or no limit.
- A limit that is too low does not crash anything now: the memory check reads
  it and simply starts fewer agents. But it caps the fleet.
- The repo's compose file sets no limit *(read in source)*.

### Steps for the founders

1. **Add the settings.** Put these in the backend container's environment.
   With the repo's compose file, that is `backend/.env`, the `api` service's
   `env_file`:

   ```
   MAX_CONCURRENT_AGENTS=50
   MAX_AGENTS_PER_OWNER=60
   AGENT_MEMORY_RESERVE_MB=2048
   ```

2. **Recreate the container.** `docker compose restart` and `docker restart`
   do **not** read a changed environment. Recreate it instead:

   ```
   docker compose up -d --force-recreate api
   ```

   If it was started with `docker run`, remove it (`docker rm -f <name>`)
   and run it again with `-e MAX_CONCURRENT_AGENTS=50` and so on.
   - The indexer does not need these settings.
   - Recreating stops every running agent. Reconcile brings back as many as
     the caps and memory allow, within about a minute. Memory peaks at about
     140 MB per agent while they start.
3. **Check:**

   ```
   docker compose exec api printenv MAX_CONCURRENT_AGENTS
   curl -s -H "Authorization: Bearer <an owner's token>" https://api.blindmarket.xyz/api/v1/agents/capacity
   ```

   `poolMax` should read 50, and `memory.reserveMb` 2048. `memory.source`
   says whether a container limit (`cgroup`) or the host (`os`) is what
   binds.
4. **Later, to grow past 50:** set `MAX_CONCURRENT_AGENTS=100`, recreate the
   container again, and watch `memory.slotsFree`. It shows how many more the
   box can hold.

### Small hosts (generic)

A 512 MB host or container fits the API and two workers. Before the memory
check, the default `MAX_CONCURRENT_AGENTS=5` got such a container killed for
running out of memory, API included. With the check, the 3rd agent is refused
instead. On a small host, set `MAX_CONCURRENT_AGENTS=2` anyway, so owners see
"server full" rather than "low on memory".

## Options for more agents

### (a) More RAM on the same host

This needs no code change, and every count stays exact. The pool, the owner
share, the memory check, the capacity endpoint, reconcile and the rate
limiters all live in the one process that holds every worker.

- **What one more GB buys:** about 7 workers at the boot peak, or about 4 if
  planning for every worker at its heap cap.
- **What it costs:** one host stays a single point of failure, and every
  deploy of the backend restarts every agent.
- **Raising density later** (neither is done yet):
  - **Stagger reconcile's forks.** Waiting for each worker's first
    heartbeat before forking the next would bring the boot cost down from
    ~140 MB towards ~110 MB per worker.
  - **Fork compiled workers without `tsx`.** In the image,
    `agents/worker.js` imports only plain `.js`, so dropping
    `--import tsx/esm` there would save about 27 MB per worker (measured on
    a bare process).
    - *Not tested:* a full worker running without it.

### (b) A separate worker container or host

One container for HTTP, and one that holds the workers. The compose file
already splits off the chain indexers this way (`RUN_MODE=api` and
`indexer`, `AGENT_RECONCILE_ON_BOOT`), but not the workers.

What the code would need *(read in source)*:

- **A control channel.**
  - Today the routes call `startAgent`, `stopAgent`, `pauseAgent`,
    `resumeAgent`, `getAgentStats` and `startRefusal` in-process. That
    covers `routes/agents.ts` and the remote MCP's `services/mcp/tools.ts`.
  - They would become requests to the worker service, over HTTP or a Redis
    queue, with replies.
  - `POST /deploy` and `/agents/capacity` would ask that service for its
    pool, owner shares and memory.
- **The workers' backend URL.**
  - Workers get `BACKEND_URL=http://localhost:<port>`. They would need the
    API's internal URL instead.
  - Socket.io has no Redis adapter here, so WebSocket pushes stay on the
    process that emits them.
- **Secrets on the worker host.** The worker service needs the database
  (each agent's stored key and API key) and `JWT_SECRET` (it mints missing
  platform tokens).
- **Moving reconcile, the zombie reaper and the deployment-identity check.**
  They would move with the workers. Logs and heartbeats already go through
  Redis.
- **What it buys:** the API is isolated from worker memory entirely, and the
  workers can live on another, bigger host. It is still one worker process
  per host, with the same per-process caps.

### (c) More instances of today's backend

Breaks today *(read in source)*:

- **Every instance re-forks every agent.**
  - `reconcileAgents()` forks every agent saved as `running` that is not in
    its own map. Each instance would run the same agents, the same wallets,
    at the same time.
  - That means double accepts and nonce collisions.
- **Stop, pause and restart reach only one instance.** They reach the
  instance that holds the child process. Elsewhere they only mark the agent
  stopped in the database, and its worker keeps running.
- **The caps and the memory check are per instance.** The pool, the owner
  share and `/agents/capacity` count only the instance that answers.
  - Two instances on one host each see the host's free memory, so starts on
    both at the same moment can race.
- **Rate limits are per instance.** The limiters keep in-memory state, so
  every limit becomes N×.
- **WebSocket pushes stay on one instance.** Socket.io rooms are per
  instance, so a task announced on one is not pushed to workers connected to
  another.

Making (c) correct needs (b)'s control channel, a placement registry (which
instance runs which agent) and shared rate-limit stores.

**Recommendation: (a).** The 16 GB VPS holds about 80 agents by measurement.
The memory check and the worker-first OOM order keep a mistake from taking the
API down. Plan (b) when the fleet outgrows one host.

## Re-measuring

The harness scripts live outside the repo. To repeat the measurement:

1. **Build and run the image.** Build `backend/Dockerfile` and run it with
   the network guarded against local chains, Postgres and Redis.
2. **Deploy agents** with `blind deploy-agent --count N`.
3. **Read the numbers inside the container:**
   - total memory: `/sys/fs/cgroup/memory.current` and `memory.peak`;
   - per process: `/proc/<pid>/status`, `oom_score` and `oom_score_adj`.
4. **Find the limit:** repeat under `docker run --memory=<limit>
   --memory-swap=<limit>` and watch `docker inspect -f '{{.State.OOMKilled}}'`.
5. **Watch the memory check:** see what `/api/v1/agents/capacity` reports
   for `memory`.
