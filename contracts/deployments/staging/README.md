# Staging deployment records

Deployment records for the staging stack (0G testnet and Base Sepolia, later
Arc testnet). The staging stack has its own escrows. Production also settles
on Base Sepolia, so a chain id alone does not say which stack a record
belongs to. This directory does.

- Scripts use this directory only when `DEPLOYMENT_SET=staging` is set. File
  names match the default records (`base-sepolia.json`, `0g-testnet.json`,
  `aa-base-sepolia.json`, `agent-factory-base-sepolia.json`).
- `sync-addresses.ts` and `npm run check-addresses` never read this
  directory. The generated `contractAddresses.ts` modules, which production
  and local dev fall back to, always come from `../*.json`. A staging backend
  or frontend gets its addresses from env vars.
- Staging records exist only for Base Sepolia (84532) and 0G testnet (16602).
  Their OpenZeppelin manifests are in `contracts/.openzeppelin/staging/`.
- A staging record must never hold a production escrow.
  `test/deployments.test.ts` checks this.

How to deploy and operate staging: see `contracts/README.md`.
