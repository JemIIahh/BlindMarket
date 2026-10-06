# Agent gas funding

How BlindMarket pays its agents' gas on Arc without creating something people
can farm.

**Audit trail (2026-10-02).** Four independent, read-only adversarial reviews of
`origin/master` (c4433f1):
1. how money can leave an agent wallet;
2. fake accounts and repeat grants;
3. when to fund, and operations;
4. a red-team of the sponsored-transaction design below. It found 8 issues
   and confirmed the revision closes them. A second pass found 3 more (the
   emergency stop, the verifier stall, held reservations), and they are folded
   in below.

Arc figures were measured on Arc mainnet with `eth_call` / `eth_estimateGas`,
using state overrides where needed.

**Evidence labels:** **[src]** read in source, **[meas]** measured on Arc (simulation, not
a sent transaction), **[inf]** inferred.

## The problem

A new hosted agent can't take its first task.

- **Agents on Arc pay their own gas.** They use plain wallets, and Arc has no
  paymaster path (`aa: false`, `backend/src/services/settlementChains.ts`). [src]
- **The worker gates on balance.** Before taking a task it requires
  300,000 gas × `maxFeePerGas`, which is 0.012 USDC today (`preflightGas`,
  `backend/agents/worker.js`). A new agent holds 0, so it declines every offer
  without saying why. [src][meas]
- **Nothing funds agent gas today.** The only sponsorship is Privy's, and it
  covers web-app transactions only. [src]
- **The mainnet path has never run.** The Arc mainnet escrow holds 134 tasks
  (130 Funded, 4 Cancelled), and none has ever been assigned. [meas]

## Decision

**BlindMarket pays the gas by sponsoring the agent's escrow transaction. It never
sends the agent money.**

- Arc supports EIP-7702. An agent's wallet points at a small BlindMarket
  contract, and our relayer sends the agent's escrow call and pays for it.
- The escrow still sees the agent as the sender.
- No USDC lands in an agent wallet, so there is nothing to cash out.
- It needs no escrow upgrade and no Safe hand-off.

## Why not send agents gas money

The audits found that a cash grant can't be made safe:

| # | Hole | Evidence | Effect |
|---|---|---|---|
| 1 | **Owners can export their agent's private key.** Deploy encrypts the new key to an `ownerPublicKey` the caller supplies. `POST /agents/:id/export-key` returns it. | [src] `agents.ts:684-689`, `agentRunner.ts:357-360` | The owner sweeps the grant directly on Arc. Our withdraw reserve only limits our own route. |
| 2 | **Fake owners cost nothing.** | [src] Privy email/wallet login, no captcha in code, no lifetime count of agents per owner, a new wallet per deploy, 20 deploys/min. [meas] The deploy fee is off. | About 0.0196 USDC kept per fake agent, thousands per day. |
| 3 | **"Owner" is a wallet address, not a person.** | [src] The Privy user id is never stored (`auth.ts:125-128`). `sk_` keys, registration tokens and agent tokens can also call `/deploy`. | Per-owner caps multiply. |
| 4 | **Assignments can be manufactured.** A poster can pin any agent; the minimum reward is 1 unit; `claimTimeout` refunds the poster. | [src] `a2a.ts:1884-1901`, `tasks.ts:413`, `BlindEscrow.sol:718` | A fake assignment costs about 0.008 USDC. |
| 5 | **A brief can make an agent pay a stranger.** The brief can steer `delegate_to_agent`, which posts a paid sub-task from the agent's wallet. It keeps only 0.005 USDC back, and nothing stops the poster's other agent from taking the sub-task. | [src] `worker.js:372,376,1504-1509,3139-3141`, `a2a.ts:439-443` | Hits earnings today. **Fix regardless.** |
| 6 | **Caps double across servers.** Limits live in process memory, storage falls back to SQLite, and Redis is shared with testnet. | [src] `agentRunner.ts:156`, `rateLimit.ts:97`, `deployedAgentStore.ts:6-8` | A second stack pays twice. |
| 7 | **The gas gate sits above the withdraw reserve.** The gate needs 0.012; withdraw leaves 0.01. | [src][meas] | Agents stall after a full withdraw. **Fix regardless.** |

## How sponsored transactions work

### Facts it rests on [meas]

- **Arc executes 7702 delegations.**
  - A type-4 authorization is accepted on mainnet (5042) and testnet (5042002).
  - An `eth_call` to a delegated wallet runs the delegate's code, and an
    authorization to a reverting target reverts.
  - All of this is simulation. A testnet send is still required.
- **A delegated wallet still receives ERC-20 USDC.** A transfer into a wallet
  delegated even to reverting code succeeds, so escrow payouts and refunds can't
  be blocked.
- **Native sends now run code.** One costs 21,220 gas, so a sender hard-coding a
  21,000 gas limit (some exchanges) bounces. Top-ups should use ERC-20 USDC.
  The web app's top-up already does.
- **Gas, with a minimal stand-in delegate:**
  - first sponsored `submitEvidence`, including the authorization: 150,891;
  - later `submitEvidence` calls: 125,693;
  - `marketplaceAssign`, which we already pay today: 92,712;
  - `createTask`: 268,876.
- **Fees.** The base fee is a flat 20 gwei over six days; ethers sets
  `maxFeePerGas` to 40 gwei. Blocks average 0.5 s and are final at once.
- **Nothing in our code depends on agents having no code.** [src]
  - The escrow has no `tx.origin` or code-size checks.
  - Every signature check is `ethers.verifyMessage`.
  - AA detection uses the stored smart-account address.
  - The only `getCode` call checks the escrow (`mcp/rent.ts:371`).

### The delegate contract: `BlindAgentDelegate`

It has no owner and no upgrade path.

- **One escrow, two calls.** The escrow address is fixed at deploy. The only
  calls allowed are `submitEvidence(taskId, evidenceHash)` and
  `releaseUnjudgedWork(taskId)`, never with value.
- **One delegate per escrow.** Each stack (`DEPLOYMENT_SET`) deploys its own;
  default and staging share Arc testnet. A UUPS upgrade of the escrow keeps
  the delegate valid; replacing the escrow makes it stale.
- **Signed by the wallet.** Each call needs an EIP-712 signature from the
  wallet itself (`address(this)`). It covers the escrow, arguments, nonce,
  deadline and chain id. The escrow is in the signed struct because two
  delegates on one chain share the wallet's nonce slot.
  - Type: `Call(uint8 kind,address escrow,uint256 taskId,bytes32 evidenceHash,uint256 nonce,uint256 deadline)`.
  - Domain: name `BlindAgentDelegate`, version `1`, the chain id, and
    verifyingContract = the agent's address.
- **Anyone can submit a signed call.** `execute` is permissionless; the
  signature is the authorization. If someone else lands it first, the relayer
  sees `InvalidNonce` and treats it as done when the task is already Submitted.
- **Collision-safe storage.** The nonce lives in an ERC-7201 namespaced slot.
- **`isValidSignature` (ERC-1271)** returns valid when the signer is the wallet,
  so third-party signature checks keep working.

### What gets sponsored

Two calls on a qualifying task, and nothing else:
- **the first `submitEvidence`.** The contract allows any `submitEvidence`, so
  "first" is relayer policy: it checks status Assigned and
  `submissionAttempts == 0` on-chain.
- **`releaseUnjudgedWork`**, once per task. The escrow allows it only after the
  poster has escalated an unjudged task with `claimTimeout`, and then only once
  the 14-day dispute window has passed (`BlindEscrow.sol:718-727, 856-860`).
  It lets an agent with an empty wallet collect its payout in that case without
  waiting on the admin. When the poster never escalates, this call can't help.
  The reservation's verifier check below is the real guard against a stalled
  verdict.

- **Not resubmits, and not verdicts.**
  - Verdicts aren't sponsored because sponsoring only passing verdicts would
    nudge verifier agents to pass.
  - Sponsoring all verdicts lets a self-dealer run three fail rounds per task.
    That costs us 643k gas against the attacker's 269k. [meas]
  - Per-task verifier agents are an owner opt-in and keep paying their own gas.
- **The task must have been assigned by our `marketplaceAssign`.** That is, the
  platform verifier sent it, and it matches our accept record. A poster's own
  `assignWorker` call assigns any address without its consent and never
  qualifies. [src] `BlindEscrow.sol:479`
- **The task amount must be at least 0.10 USDC.** On a pass, the 10% fee then
  covers the sponsored gas.
- **A task checked by a verifier agent qualifies only if that verifier can
  rule.** The poster picks the verifier on-chain, and the escrow doesn't check
  that it opted in (`BlindEscrow.sol:386-390`, `verifierDuty.ts:5-30`). So at
  reservation time the verifier must:
  - be a hosted agent whose owner turned on verifying;
  - be running;
  - hold at least the gas gate at current fees.

### Who is eligible

Every one of these must hold:

1. **A hosted agent.**
   - `deployed_agents.wallet_address` is derived from the stored platform key.
   - The agent was deployed by a Privy-authenticated owner, with the Privy user
     id stored.
   - The recipient never comes from a request.
2. **Its key has never been exported.**
   - Every `export-key` call is logged durably, and that wallet is ineligible
     for good.
   - So only the platform can sign for or re-point a sponsored wallet.
   - No first-party client calls `export-key` today, so ordinary owners keep
     sponsorship. [src]
3. **Its wallet is delegated to our delegate,** checked with `getCode` just
   before sending.

### The flow

1. **Reserve, then assign.**
   - In `/accept`, before `marketplaceAssign`, the backend atomically reserves
     this task's sponsor budget in Postgres (caps below).
   - Only then does the offer carry the hint `gasSponsored: true`, so the
     worker skips its balance gate.
   - If nothing can be reserved, the worker keeps today's behaviour and declines
     unless it can pay. A task is never assigned to an agent that can't submit.
   - A reservation is released at the first of: the submit lands (it is used),
     the task leaves Assigned, the task re-opens (`/release`), or **one hour
     after assignment**. A hosted run is
     capped at 600 s and its transaction wait at 300 s
     (`worker.js:362,365`). A task deadline can be 90 days, so waiting for it
     would let idle accepts hold the budget.
   - Each agent holds at most one reservation (the worker runs one task at a
     time), and each Privy user a few. An expired reservation is a strike
     against that agent and user; repeated strikes refuse them new
     reservations. A reservation already held is still served.
   - The worker hands back a task it can't finish (`/release`). When the
     escrow already names it, the route answers `ON_CHAIN_LOCKED` and the task
     stays its own. The reservation is kept, so a resume after a passing
     failure is still sponsored, and marked (`returned_at`): at its hour it is
     released without a strike. Only the worker holds an eligible agent's
     credentials, so an owner can't hand back to dodge a strike.
2. **Setup.**
   - The worker signs a 7702 authorization to `BlindAgentDelegate`.
   - The chain id is pinned to 5042 (5042002 on testnet), never 0. A chain-id-0
     authorization would also be valid on Base and other chains.
   - The nonce is read at `pending` just before signing.
   - The relayer rejects any authorization with another chain id or address.
   - It rides in the first sponsored transaction.
3. **Submit.**
   - The worker signs the call and posts it to
     `POST /api/v1/a2a/tasks/:id/sponsored-call`.
   - Auth accepts only the agent's platform token (`typ === 'agent-platform'`)
     whose `jti` matches the agent's stored token.
4. **Relay.** The relayer re-checks the export log; an owner could export the
   key between reservation and relay. It then re-checks on-chain state: worker
   equals wallet, status Assigned, the task was ours, and more than 60 s remain
   before the deadline. Then it:
   - simulates the exact transaction and refuses a raw estimate above the
     ceiling, `GAS_SPONSOR_MAX_GAS`, which defaults to 185k. That is the Arc
     testnet first submit (an estimate of 151,840, of which 150,659 was used)
     × 1.2. Later submits measured 108,559 on Arc testnet. A release measured
     94,599–133,599 locally and has not run on Arc;
   - sets the gas limit to estimate × 1.15;
   - caps `maxFeePerGas` at 100 gwei;
   - sends.
5. **Confirm.**
   - Success means the receipt holds the escrow's `EvidenceSubmitted` event for
     that task, and the wallet's code is still our designator afterwards.
   - A stale or foreign authorization silently does nothing: status 1, no event.
     [meas] So the relayer allows at most one setup retry per wallet.
   - If simulation reverts `InvalidNonce` and the task is already Submitted with
     this evidence, someone else landed the signed call. That counts as success.
6. **Fallback.** If anything is refused, the worker uses today's direct path and
   pays its own gas. The task was never assigned without a reservation, so
   nothing strands.

### Caps and accounting

- **Counters live in Postgres only.** Never Redis or SQLite.
- **Cost is counted as `gasUsed × effectiveGasPrice` from receipts,** reverts
  included.
- **Caps:**
  - per agent per day;
  - per Privy user per day;
  - per poster wallet per day;
  - a global budget per hour and per day, in USDC.
- **Two runtime controls,** stored in the database, flipped from a
  founder-gated route, applied without a restart:
  - **Pause** stops new reservations. Tasks already reserved still get their
    submit sponsored, so nothing strands. This is for budget or abuse.
  - **Kill** stops every send at once, including reserved ones, and accepts that
    those few tasks strand until their owners fund the wallet. This is for a
    delegate bug or a leaked sponsor key.

### What an attacker can still do

| Attack | Result |
|---|---|
| Export the key and drain gas money | Nothing to drain. Exporting the key also ends sponsorship for that wallet. |
| Make the relayer call something else | The delegate makes only two escrow calls, never with value. The relayer builds each one from on-chain state. |
| Re-point the wallet, then get relayed | Only possible with the key, and exported wallets are ineligible. Code is checked before sending, and success needs the escrow event. |
| Replay a signature or authorization | Nonce, deadline and chain id are pinned to Arc. |
| Self-post tasks so we pay submit gas | We pay the assign (92.7k) plus one submit (~126–151k), about 218–244k gas per task. The attacker pays `createTask` (269k) and locks at least 0.10 USDC until the task ends. That is roughly 1:1, and they keep nothing. Global caps bound it. |
| Accept and never submit, to hold the budget | Costs the attacker nothing, but each agent holds one reservation, which expires after an hour and counts as a strike. |
| Pin tasks an agent can't work (a brief it can't decrypt) so its owner is struck | The worker hands each one back, which marks its reservation: at its hour it is released without a strike. Strikes only refuse new reservations, never end a held one. |
| Use fake identities to beat caps | Per-user and per-poster caps slow it down; free signup means the global cap is the real bound. Spending the budget only pauses sponsorship. It can't strand tasks, because of the reservation. |
| Run a second stack with the key | The sender runs only when a `DEPLOYMENT_ID` is set (any value: Arc testnet staging may run it), Postgres is in use, and `backgroundWritesAllowed()` is true, meaning this stack owns its Redis. Within a stack, one process sends, holding a Postgres advisory lock keyed by chain id and sponsor address. Neither check stops a stack on its own Redis and its own database, so the sponsor key must never appear in another stack's env. [src] |

**Cost per sponsored task:** about 0.0025–0.006 USDC, depending on the delegate
and first-time setup. The 10% fee on a 0.10 USDC task is 0.01 USDC.

## Operations

- **Sponsor wallet.**
  - A fresh key generated offline.
  - At boot, assert it differs from the verifier, marketplace signer, treasury
    and admin.
  - The float is no more than two days of budget (about 2 USDC); that float is
    the worst case.
  - A copy of the key is held off-Render so the float can be swept as a hard
    stop.
  - The key is set in one stack's env only, never in another stack's
    (staging, a local harness): nothing in the code stops a second stack
    that has its own Redis and database from sending with it.
- **Sending.**
  - One writer, behind a Postgres advisory lock.
  - Serialized through `createSerialTxQueue`.
  - Write-ahead: the nonce and signed raw transaction are saved before
    broadcast. Recovery re-broadcasts the same raw transaction and never
    re-signs.
  - Receipts are polled, because Arc RPC replicas can lag.
- **Monitoring.**
  - `/health/bridge` shows the sponsor balance, calls today and budget left.
  - Failures go to Sentry, and each call is recorded with
    `recordEvent('gas_sponsored')`.
  - Sponsorship pauses itself and alerts when the hourly spend or failure rate
    exceeds its limit, or the balance falls below one day of budget.
- **Users see the state.** The agent page shows "Gas paid by BlindMarket",
  "Gas sponsorship paused", or "Not eligible (key exported)".

## Fixes that ship regardless

1. **Delegation guard.**
   - `delegate_to_agent` becomes an owner opt-in, off by default. This is the
     real fix.
   - `/accept` also refuses a sub-task executor with the same owner as the
     posting agent, though a second owner address gets around that.
   - Delegation keeps at least one transaction's gas.
2. **Gas gate sized to real use.**
   - On Arc the preflight budget becomes 200k gas. The largest worker
     transaction is 154,491.
   - The withdraw reserve becomes dynamic: max(0.01 USDC, gate at current fees ×
     1.1). A fixed reserve falls below the gate whenever the base fee passes
     ~25 gwei.
3. **Truthful agent page.** The real per-task cost, and the sponsorship state
   once it exists.
4. **Privy user id stored at deploy.** It only raises the cost of fake
   identities: Privy accounts are free, so it limits nothing on its own.

## Validation before mainnet

Each step must be **executed and observed**:

1. **Local Hardhat (Prague).**
   - Delegate unit tests: the wrong signer, function, value, chain id, a replay,
     an expired deadline, and a re-pointed wallet are all refused.
   - The ERC-1271 check works.
   - A stale authorization is detected as a no-op.
2. **Arc testnet, real sends.** Done 2026-10-02 with delegate
   `0x4AFf5FE7f19779EEfBA8515fB1BaE84A8F3a20B6`:
   - A fresh agent wallet held 0 gas. A sponsored first submit carried the
     authorization: 150,659 gas at 21.5 gwei, about 0.0032 USDC. The task was
     Submitted with matching evidence, and the wallet's code became
     `0xef0100‖delegate`.
   - A later sponsored submit used 108,559 gas at 24.5 gwei, about
     0.0027 USDC. The agent's balance was still 0.
   - An ERC-20 USDC transfer into the delegated wallet arrived, and the
     native balance reflects the same USDC. A native send with gas estimation
     arrived (21,072 gas); one capped at 21,000 gas reverted, as expected.
   - Not run on Arc yet: settlement payout via the escrow, withdraw, and a
     CCTP mint into a delegated wallet. These were covered locally; the
     ERC-20 credit above is the same mechanism a payout uses.
   - Mainnet delegate: `0xF7b7C2e21385e59080862c7031ed568B561753a0`, bound to
     escrow `0xd2B8…30C4`. Its code size, `ESCROW()`, domain and typehash
     were checked on-chain.
3. **Full hosted-agent E2E on the local harness.** An agent with a zero balance
   takes, submits and settles a task, with its balance at zero throughout.
   - Caps are exercised.
   - A refused reservation leaves the task for the next agent.
   - A reservation expires after an hour and records a strike.
   - Pause still honours a held reservation; kill stops it.
   - An export between reservation and relay is refused.
   - An agent-verified task whose verifier can't rule is not reserved.
   - A sponsored `releaseUnjudgedWork` after the poster's escalation and the
     window pays the worker.

## Rollout

1. Fixes 1–4 ship first. They don't depend on sponsorship.
2. Andrew deploys `BlindAgentDelegate` on Arc testnet, then mainnet. It needs no
   admin role.
3. Turn sponsorship on, testnet first, then mainnet with small caps:
   - 1 USDC/day global;
   - 20 calls per Privy user per day;
   - 10 per poster per day.
4. Review spend and abuse signals after two weeks before raising caps.

## Rejected: a one-time cash grant

Rejected for the reasons in the table above. Even sized to one transaction and
sent just in time, each grant is worth about its size to anyone who exports the
key. Use it only if 7702 fails testnet validation, and then only as capped
marketing spend.
