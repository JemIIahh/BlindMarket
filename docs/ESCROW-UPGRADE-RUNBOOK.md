# BlindEscrow upgrade runbook (Sep 2026)

Ships the contract fixes that have been on master since July but were never
deployed. Written 2026-09-19 against master `4273066`. Every step below was
rehearsed on a local fork of the real chain first; results are under
[Rehearsal evidence](#rehearsal-evidence).

## Why

The live BlindEscrow implementation on **0G mainnet** and **Base Sepolia** is
older than master (checked with `eth_getCode` against master's build):

| Missing on-chain | What it is |
|---|---|
| `DISPUTE_WINDOW` / `DisputeWindowActive` (`31792c3`) | A disputed task can be frozen forever if the admin never resolves it. The fix lets the poster reclaim after 14 days. |
| `completeVerificationWithTEE` (`69d1335`, `09ea906`) | TEE settlement. A feature, not a risk. |

The upgrade is a same-address UUPS implementation swap. The proxy address, all
tasks, balances, admin, verifier, treasury, fee and token allowlist are kept.
**No backend, frontend, SDK or MCP release is needed**: their existing 12-field
`getTask` ABI reads the upgraded contract correctly (executed, 52/52 and 24/24
tasks).

Behaviour after the upgrade:

- Tasks disputed **before** the upgrade have `disputedAt == 0` and keep
  requiring `resolveDispute` by the admin. Nothing becomes claimable the
  moment the upgrade lands.
- Tasks disputed **after** it can be reclaimed by the poster through
  `claimTimeout` once 14 days have passed since `raiseDispute`.

## Decision recorded

`docs/MAINNET-CHECKLIST.md` wants the Safe to be admin before mainnet
contracts are touched. The product owner decided on 2026-09-19 to ship this
upgrade with the **current admin key** rather than wait, because the
frozen-escrow fix is unshipped. `I_HAVE_READ_MAINNET_CHECKLIST=yes` below
acknowledges that. The Safe migration stays on the checklist.

## Who signs what (read on-chain 2026-09-19)

| Chain | Escrow proxy | Admin | How |
|---|---|---|---|
| 0G mainnet (16661) | `0x3d0374963DaaD43e31d42373eb11156A8e8ce2Ff` | EOA `0x2f8b1177c83623a560B26B38dE984e154b123D75` (2.83 0G) | one script |
| Base Sepolia (84532) | `0xCca5ab873158b888158AD9Dc36fb4Ee683eFbEBf` | **Safe v1.4.1** `0xD5D79c5D069a421330e369Ca0E73f595c244AdD8`, 1-of-1, owner `0xEEF3836a9De7C6dA2f2CedB8cC603c8F1162fF95` | deploy, then a Safe transaction |

The Base Sepolia owner key `0xEEF3…` is not recorded anywhere in the repo.
Whoever holds it signs Part 2 below.

## Before you start

```bash
git checkout master && git pull
cd contracts && npm ci
npm test                      # 183 passing
npm run check-addresses       # in sync
```

Do Base Sepolia first: it is a testnet and exercises the same implementation.

## A. Base Sepolia (admin is a Safe)

**Part 1 — deploy the implementation.** Any funded Base Sepolia key; no admin
rights needed; the proxy is not changed.

```bash
cd contracts
PRIVATE_KEY=<any funded key> npx hardhat run scripts/prepare-escrow-upgrade.ts --network base-sepolia
```

It checks the storage layout, deploys, verifies the deployed bytecode, and
prints a Safe transaction: `to` (the proxy), `value: 0`, and `data`
(`upgradeToAndCall(<impl>, 0x)`).

**Part 2 — the Safe executes it.** In the Safe app (Base Sepolia, Safe
`0xD5D7…AdD8`): New transaction → Transaction Builder → paste `to`, value `0`,
and the `data` as custom hex. Sign with `0xEEF3…` and execute.

**Part 3 — verify (read-only).**

```bash
VERIFY=1 npx hardhat run scripts/prepare-escrow-upgrade.ts --network base-sepolia
# ✓ VERIFIED — the proxy runs the compiled BlindEscrow.
```

Before Part 2 this command fails with `NOT UPGRADED`, which is how you know it
is measuring the right thing.

## B. 0G mainnet (admin is a key)

```bash
cd contracts
# read-only pre-flight
npx hardhat run scripts/validate-escrow-upgrade.ts --network 0g-mainnet      # ✓ SAFE

I_HAVE_READ_MAINNET_CHECKLIST=yes PRIVATE_KEY=<0x2f8b… admin key> \
  npx hardhat run scripts/upgrade-blind-escrow.ts --network 0g-mainnet
# ✓ Upgraded & VERIFIED — the proxy now runs the compiled BlindEscrow.
```

The script refuses on an incompatible layout and fails loudly if the live code
is not byte-equivalent to the build afterwards. Do not keep
`I_HAVE_READ_MAINNET_CHECKLIST` in `contracts/.env`.

## After both

1. `curl https://api.blindmarket.xyz/health/bridge` — `verifierMatches: true`
   and no `escrowReadError`, for both chains.
2. Commit the changed `contracts/.openzeppelin/*.json` manifests (the new
   implementation addresses) in a PR. No address file changes: the proxy
   addresses are the same, so `npm run check-addresses` stays in sync.
3. Post one small task end to end on Base Sepolia (post → accept → verify →
   settle) and confirm the 90/10 split.

## Rollback

The previous implementations stay on-chain. The admin (key on 0G, Safe on
Base) calls `upgradeToAndCall(<old impl>, 0x)` on the proxy:

- 0G mainnet old implementation: `0x7792E8667De7f0f3e64764c42DE122408f685Bf9`
- Base Sepolia old implementation: `0x95bC46828c85De09dE45bA1c5Df3d534298eD577`

The new code only appends `disputedAt` to the task struct, which the old code
ignores, so rolling back does not corrupt tasks.

## Not in this runbook, on purpose

- **ValidatorPool** (0G mainnet, lacks `MAX_VOTERS`): dormant — 0 validators,
  no disputes ever opened, and BlindEscrow does not call it. A redeploy needs a
  stake-token decision first (`redeploy-validator-pool.ts` refuses to guess on
  mainnet). No funds at risk while it is unused.
- **INFT** (0G mainnet, differs from master): it is not upgradeable, so the fix
  means a fresh contract, and the **35+ agent NFTs already minted would be
  orphaned**. The authorization feature the fix protects is not read by
  anything in production. Decide on a migration before redeploying.
- **Base Mainnet / Arc**: nothing is deployed there
  (`contracts/deployments/base-mainnet.json` holds zero addresses).

## Rehearsal evidence

Executed 2026-09-19 on anvil forks of the live chains, running the repo's real
scripts from a scratch copy of master:

- **0G mainnet fork** (block 44767586): `upgrade-blind-escrow.ts` → "Upgraded &
  VERIFIED". All 52 tasks decoded field by field before and after: every
  pre-existing field identical, `disputedAt` 0 on all. Escrow balance
  (2.2054 0G), verifier, treasury, feeBps, nextTaskId, paused and the native
  token allowlist unchanged. `DISPUTE_WINDOW()` returns 1209600. On the fork
  only, admin was first handed to a test key (the real admin key was not used).
- **Base Sepolia fork** (block 47039359): `VERIFY=1` failed before
  ("NOT UPGRADED"); Part 1 deployed and printed the Safe transaction; the same
  data from a non-admin reverted `NotAdmin`; sent as the Safe it succeeded;
  `VERIFY=1` passed; re-running Part 1 reported "Already current". 24/24 tasks
  and all settings unchanged.
- The apps' existing 12-field `getTask` ABI decoded the upgraded contract's
  responses identically on both forks.

Not rehearsed: the Safe app's signing UI itself (the fork sent the transaction
as the Safe), and real-network gas cost.
