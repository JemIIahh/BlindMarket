# contracts

Solidity contracts, deploy and ops scripts, and the deployment records
(`deployments/*.json`) that `npm run sync-addresses` turns into the backend and
frontend address modules.

```bash
npm test                 # hardhat tests
npm run check-addresses  # generated address modules match deployments/*.json
```

## Deployment sets and staging

Production uses 0G mainnet (agent infra), **Arc testnet** (where every new
task is escrowed, since #73) and **Base Sepolia** (tasks posted before that).
The staging stack uses 0G testnet plus Base Sepolia, with its **own** escrows;
it has no Arc escrow of its own (the one it deployed became production's, see
Arc below). Two stacks can share chains 84532, 16602 and 5042002, so a script
cannot tell them apart by chain id.
`DEPLOYMENT_SET` picks the records it reads and writes:

| `DEPLOYMENT_SET` | records                           | OpenZeppelin manifests    | chains                     |
| ---------------- | --------------------------------- | ------------------------- | -------------------------- |
| unset            | `deployments/<file>.json`         | `.openzeppelin/`          | all (production, local dev) |
| `staging`        | `deployments/staging/<file>.json` | `.openzeppelin/staging/`  | 84532, 16602, 5042002      |

Generated address modules always come from the unset (default) records.

The guards (in `scripts/_deployments.ts` and `scripts/_manifest-dir.ts`):

- Every script that reads or writes a record prints the set, the record and
  the escrow it resolved before it acts.
- A set refuses chains it does not list. A chain that more than one set
  lists (today 84532, 16602 and 5042002) is shared: there, a script that sends
  transactions refuses to run unless `EXPECTED_ESCROW` equals the escrow it
  resolved. This applies to both sets, including production's Base Sepolia
  escrow. Read-only scripts only print it.
- `hardhat.config.ts` imports `_manifest-dir.ts` first. With
  `DEPLOYMENT_SET=staging` it sets `MANIFEST_DEFAULT_DIR=.openzeppelin/staging`
  before the OpenZeppelin plugin reads it. Scripts refuse a run whose manifest
  directory is not the set's, including a run started outside `contracts/`.
- Deploy scripts merge into the existing record instead of replacing it. They
  refuse to replace a live `BlindEscrow` unless `ALLOW_ESCROW_REPLACE=true`
  AND `EXPECTED_ESCROW` names the escrow being replaced, on every chain. They record the escrow's deployment block under
  `blocks.BlindEscrow`. `sync-addresses` reads only `contracts`.
- `sync-addresses` / `check-addresses` ignore `DEPLOYMENT_SET` and never read
  `deployments/staging/`.

Pass these variables on the command line, one run at a time. Hardhat refuses
to start if `contracts/.env` sets `DEPLOYMENT_SET`, `EXPECTED_ESCROW`,
`ALLOW_ESCROW_REPLACE`, `MANIFEST_DEFAULT_DIR` or
`I_HAVE_READ_MAINNET_CHECKLIST` (even `=no` — delete the line the old
template shipped), because that file is loaded into every run.

### Deploy staging

```bash
cd contracts
# 1. Base Sepolia escrow -> deployments/staging/base-sepolia.json.
#    Note the printed BlindEscrow address and block.
DEPLOYMENT_SET=staging npx hardhat run scripts/deploy-base.ts --network base-sepolia
export STAGING_BASE_ESCROW=0x...

# 2. Optional Base companions for that stack (the escrow names the stack)
DEPLOYMENT_SET=staging EXPECTED_ESCROW=$STAGING_BASE_ESCROW \
  npx hardhat run scripts/deploy-agent-factory.ts --network base-sepolia
DEPLOYMENT_SET=staging EXPECTED_ESCROW=$STAGING_BASE_ESCROW \
  npx hardhat run scripts/deploy-aa.ts --network base-sepolia

# 3. 0G testnet stack -> deployments/staging/0g-testnet.json
DEPLOYMENT_SET=staging npx hardhat run scripts/deploy-testnet.ts --network 0g-testnet
export STAGING_OG_ESCROW=0x...
```

If step 1 or 3 says the record `already holds BlindEscrow`, you forgot
`DEPLOYMENT_SET=staging` or staging is already deployed. Stop and check. Don't
reach for `ALLOW_ESCROW_REPLACE`.

### Arc

Arc (Circle's L1) settles in USDC, which is also its gas coin: 18 decimals
natively, 6 through the ERC-20 at `0x3600000000000000000000000000000000000000`.
They are one balance. The escrow must only ever allowlist the ERC-20.

| hardhat network | chain id | RPC                                                     | record             |
| --------------- | -------- | ------------------------------------------------------- | ------------------ |
| `arc-testnet`   | 5042002  | `ARC_TESTNET_RPC_URL`, default `https://arc-testnet-rpc.publicnode.com` | `arc-testnet.json` |
| `arc-mainnet`   | 5042     | `ARC_MAINNET_RPC_URL`, **no default**                    | `arc-mainnet.json` |

`scripts/deploy-settlement.ts` deploys a USDC settlement escrow on Base or Arc
(`deploy-base.ts` is now a wrapper for it that only runs on Base). Its token
table is `scripts/_settlement.ts`. It:

- refuses `address(0)` as the settlement token on every chain;
- before any transaction, checks that the token has code and reports 6
  decimals and symbol `USDC`;
- calls `allowToken(token)`, then checks that the escrow allows the token and
  does **not** allow `address(0)`, and writes the record only if both hold;
- records `blocks.BlindEscrow` and merges into an existing record;
- deploys no account-abstraction contracts. `deploy-aa.ts` and
  `redeploy-blindaccount-factory.ts` refuse both Arc chain ids: Arc needs no
  USDCPaymaster.

Arc testnet's default escrow is the one production posts on,
`deployments/arc-testnet.json`. It was deployed with `DEPLOYMENT_SET=staging`
and moved to the default records (with its `.openzeppelin/unknown-5042002.json`
manifest) once production adopted it, so default-set commands such as
`rotate-verifier.ts --network arc-testnet` find it. A deploy that forgets
`DEPLOYMENT_SET=staging` now meets the `already holds BlindEscrow` refusal. A
staging Arc escrow of its own goes to `deployments/staging/arc-testnet.json`
with the command below.

`verify-deployment-config.ts` enforces the same allowlist and token checks on
Base and Arc, with no `EXPECTED_*` needed. `_guard.ts` treats Arc testnet as a
testnet; Arc mainnet needs `I_HAVE_READ_MAINNET_CHECKLIST=yes`.

```bash
DEPLOYMENT_SET=staging npx hardhat run scripts/deploy-settlement.ts --network arc-testnet
```

`sync-addresses` emits `arc` / `arcTestnet` only once `arc-mainnet.json` /
`arc-testnet.json` exist in the default records, and `DEPLOYMENT_BLOCKS` only
once a default record has a `blocks` entry for a contract it emits. The web
app falls back to the generated Arc escrow and USDC when `VITE_ARC_ESCROW_ADDRESS`
/ `VITE_ARC_USDC_ADDRESS` are unset. The backend never does: it reads Arc only
from `ARC_ESCROW_ADDRESS`, so a local or staging backend cannot pick up
production's escrow by default.

### Operate staging

Use a staging-only marketplace signer. Never use production's.

```bash
DEPLOYMENT_SET=staging EXPECTED_ESCROW=$STAGING_BASE_ESCROW MARKETPLACE_SIGNER_ADDRESS=0x... \
  npx hardhat run scripts/rotate-verifier.ts --network base-sepolia
DEPLOYMENT_SET=staging EXPECTED_ESCROW=$STAGING_OG_ESCROW MARKETPLACE_SIGNER_ADDRESS=0x... \
  npx hardhat run scripts/rotate-verifier.ts --network 0g-testnet

# read-only check
DEPLOYMENT_SET=staging EXPECTED_ESCROW=$STAGING_BASE_ESCROW EXPECTED_VERIFIER=0x... \
  npx hardhat run scripts/verify-deployment-config.ts --network base-sepolia
```

`set-fee.ts`, `set-treasury.ts`, `migrate-admin-to-safe.ts`,
`upgrade-blind-escrow.ts`, `fix-whitelist.ts` and the `redeploy-*.ts` scripts
take the same `DEPLOYMENT_SET` + `EXPECTED_ESCROW` pair. For production on Base
Sepolia, leave `DEPLOYMENT_SET` unset and pass
`EXPECTED_ESCROW=<production escrow>`.

`/health/bridge` and the backend boot banner print the `rotate-verifier`
command with `EXPECTED_ESCROW=<that backend's escrow>`, and with
`DEPLOYMENT_SET` when the backend sets it.

Staging proxies are recorded in `.openzeppelin/staging/`. Commit the files a
staging deploy writes there. `upgrade-blind-escrow.ts` needs them later.

### Staging backend env

In `backend/src/config.ts`, `optional()` treats an **unset or empty** value as
missing and falls back to the generated addresses, which are production's.
With `NODE_ENV=production`, the chain defaults are 0G mainnet and Base
**mainnet** (8453). So the staging backend sets:

- `DEPLOYMENT_SET=staging`
- `OG_CHAIN_ID=16602`, `BASE_CHAIN_ID=84532`, `OG_RPC_URL`, and
  `ALLOW_NONMAINNET_PROD=true` (production boot otherwise refuses a
  non-mainnet 0G chain)
- from `deployments/staging/0g-testnet.json`: `BLIND_ESCROW_ADDRESS`,
  `TASK_REGISTRY_ADDRESS`, `BLIND_REPUTATION_ADDRESS`, `INFT_ADDRESS`,
  `VALIDATOR_POOL_ADDRESS`, and `ESCROW_DEPLOYMENT_BLOCK` (its
  `blocks.BlindEscrow`)
- from `deployments/staging/base-sepolia.json`: `BASE_ESCROW_ADDRESS` and
  `BASE_ESCROW_DEPLOYMENT_BLOCK`
- `AGENT_FACTORY_ADDRESS` (+ `AGENT_FACTORY_DEPLOYMENT_BLOCK`),
  `USDC_PAYMASTER_ADDRESS`, `BLIND_ACCOUNT_FACTORY_ADDRESS` and
  `ENTRY_POINT_ADDRESS` from the staging `agent-factory-`/`aa-` records
- `MARKETPLACE_SIGNER_PRIVATE_KEY` and `BASE_MARKETPLACE_SIGNER_PRIVATE_KEY`:
  staging-only keys
- `PUBLIC_API_URL` and `PUBLIC_APP_URL`: the staging API and app. Unset, they
  default to production's, and the discovery endpoints (`/.well-known/agent.json`
  and friends) send the agents that find staging to production.
- `REDIS_URL` and `DATABASE_URL`: staging's own. Never copy production's: two
  backends on one Redis take each other's tasks (the escrow fingerprint in
  `/health/bridge` only reports it).

Set every contract address that staging does not deploy to
`0x0000000000000000000000000000000000000000`. An empty value falls back to
production's contract. With `DEPLOYMENT_SET` set, the backend refuses to boot
unless each of the addresses above, `OG_RPC_URL`, `PUBLIC_API_URL` and
`PUBLIC_APP_URL` is present (zero counts), neither URL is production's, and
the chain ids are 16602, 84532 and 5042002 (Arc testnet).

The staging frontend needs `VITE_OG_CHAIN_ID=16602`, `VITE_BASE_CHAIN_ID=84532`
and the `VITE_*_ADDRESS` overrides (`VITE_BLIND_ESCROW_ADDRESS`,
`VITE_TASK_REGISTRY_ADDRESS`, `VITE_BLIND_REPUTATION_ADDRESS`,
`VITE_BASE_ESCROW_ADDRESS`, `VITE_ARC_ESCROW_ADDRESS`,
`VITE_ARC_AGENT_FACTORY_ADDRESS`). An empty override also falls back to
production: without `VITE_ARC_ESCROW_ADDRESS` a staging frontend posts to
production's Arc escrow. The deploy form pays the AgentFactory the staging
backend names in its deploy-fee terms, which wins over the frontend's own.
