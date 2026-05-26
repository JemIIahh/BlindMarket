# Mainnet Migration Checklist

**Status:** PRE-MIGRATION — DO NOT DEPLOY TO MAINNET UNTIL ALL ITEMS BELOW ARE GREEN.

This file is the gating contract between testnet and mainnet. Every step has a
reason; the reasons matter more than the steps because they let you adapt when
something doesn't fit the template. If you find yourself thinking "we'll skip
this for now," go re-read the corresponding **Why this matters** block first.

The deploy scripts in `contracts/scripts/` refuse to target a mainnet chainId
unless the env var `I_HAVE_READ_MAINNET_CHECKLIST=yes` is set, so you cannot
accidentally bypass this file. That guard is a forcing function, not a
permission system — anyone can flip it. The protection comes from the human
having to acknowledge they read this.

---

## 0. Threat model — read first

You are about to put real money in escrow on a public chain. The credible
threats are:

1. **Backend env leak** — `.env` files containing private keys end up in a
   public log, an exfiltrated container image, a compromised CI runner, a
   stolen laptop, or a rogue dependency reading the filesystem. Treat any
   key in any `.env` as one bad day away from being public.
2. **Admin key compromise** — whoever holds the admin key can replace the
   entire contract bytecode (UUPS upgrade), redirect the treasury, set fees
   to 100%, and lock everyone else out via `setVerifier`. There is no
   recovery if the admin key is stolen by a single attacker.
3. **Verifier key compromise** — whoever holds the verifier key can call
   `marketplaceAssign` and `completeVerification`, draining tasks-in-flight
   by colluding with workers or just by validating their own submissions.
   Recoverable: the admin can rotate the verifier with `setVerifier` in one
   tx.
4. **User phishing** — outside the scope of this contract but worth saying
   once.

Mitigations below are sized to these threats. The cheap ones (multisig
admin) are in the checklist. The expensive ones (formal audit, TEE
verification, bug bounty) are listed at the bottom for completeness.

---

## 1. Pre-deployment

### 1.1 Audit pass

- [ ] **Independent contract review** of all changes since last audit (or
      since deployment if no audit yet). At minimum a senior solidity
      engineer outside the team should read `BlindEscrow.sol`,
      `TaskRegistry.sol`, `BlindReputation.sol`, `INFT.sol`,
      `ValidatorPool.sol` line-by-line. A formal audit by a firm (Trail of
      Bits, Spearbit, OpenZeppelin) is the gold standard but expensive.

  **Why this matters:** the contract has admin-controllable upgrade,
  fee, and treasury surfaces. A subtle reentrancy or auth bug isn't
  recoverable on mainnet — you can patch via upgrade, but funds already
  drained are gone.

### 1.2 Storage-layout dry run

- [ ] Run `npx hardhat run scripts/upgrade-blind-escrow.ts --network 0g-testnet`
      one final time on testnet against the *exact* bytecode you intend to
      deploy to mainnet. The OZ plugin's storage-layout check catches
      incompatible upgrades. Verify the layout file
      (`.openzeppelin/unknown-16602.json`) matches what you expect.

  **Why this matters:** if you ever upgrade on mainnet and the storage
  layout shifts even by one slot, every existing task gets corrupt
  state. The plugin's check is the only thing standing between you and
  that scenario.

### 1.3 Test suite passes

- [ ] `cd contracts && npx hardhat test` — full green. **No skipped tests
      in CI.** If a test is currently `.skip`, decide whether to delete it
      or unblock it before mainnet.

### 1.4 Decide and document the fee schedule

- [ ] Lock in `feeBps` for mainnet launch. Current testnet uses 1500 (15%).
      Once a task is created at a fee, that's the fee for that task forever
      (the contract reads `feeBps` at creation, not settlement). Document
      the rationale.

  **Why this matters:** changing fees post-launch with active tasks is a
  reputational landmine — workers who agreed to one rate get a different
  rate at settlement. Get it right at launch.

### 1.5 Decide and document the token allowlist

- [ ] List the exact set of ERC-20s allowed for escrow on mainnet day 1.
      Each one needs an explicit `BlindEscrow.allowToken(addr)` post-deploy.
      For mainnet, recommend starting with one stablecoin (USDC or USDT).
      Avoid rebasing tokens or fee-on-transfer tokens — the escrow assumes
      `transferFrom(from, to, n)` deposits exactly `n`.

  **Why this matters:** a fee-on-transfer or rebasing token in escrow
  permanently breaks the accounting because the contract believes it
  holds `n` but the underlying balance is `<n`.

---

## 2. Multisig admin (REQUIRED for mainnet)

The contract has a 2-step admin transfer (`proposeAdmin` →
`acceptAdmin`) baked in (`BlindEscrow.sol:411-422`). Use it to migrate
admin from a single EOA to a Gnosis Safe **before** any user funds are
locked in escrow.

### 2.1 Deploy the Safe

- [ ] Deploy a Gnosis Safe on the target mainnet (0G mainnet has Safe
      deployed; check https://safe.global for status). Configure as
      **N-of-M** with M ≥ 3 and N ≥ 2. Recommended: 2-of-3 for a small
      team (founder + cofounder + cold backup), 3-of-5 for larger teams.
      Each signer should be on different infrastructure (different
      laptops, different jurisdictions, ideally hardware wallets).

  **Why this matters:** Option 1 (single deployer key as admin) is what
  you're running on testnet today. On mainnet that's catastrophic if the
  key leaks. Multisig means even with a leaked key, the attacker needs
  to compromise multiple humans to do admin actions.

### 2.2 Transfer admin to the Safe

- [ ] Current deployer EOA calls `escrow.proposeAdmin(<safeAddress>)`.
- [ ] Safe (via the Safe UI) executes `escrow.acceptAdmin()`.
- [ ] Verify on chain: `escrow.admin()` returns the Safe address.
- [ ] Repeat for `BlindReputation`, `TaskRegistry`, `INFT`, `ValidatorPool`
      if they have separate admin slots.

  **Why this matters:** until `acceptAdmin()` is executed by the Safe,
  the deployer EOA is still admin. The 2-step pattern is intentional
  (prevents accidentally locking out access by transferring to a wrong
  address); make sure step 2 actually happens.

### 2.3 Burn or cold-store the deployer EOA

- [ ] Once admin is the Safe, the deployer EOA has no on-chain role. Move
      any remaining funds off it and store the key offline. **Do not delete
      it** — you may need it for emergency recovery if `acceptAdmin` was
      botched (you should have verified in 2.2 it wasn't). Cold storage
      (paper, hardware wallet, encrypted offline) is appropriate.

---

## 3. Marketplace signer (verifier role)

This is the hot key the backend uses to call `marketplaceAssign` and
`completeVerification`. It must be isolated from any other role.

### 3.1 Generate a fresh key

- [ ] On a clean machine (not a laptop with browser cookies, ideally a
      dedicated VM or hardware wallet exporting raw key material once):
      `cd contracts && npx hardhat run scripts/generate-marketplace-signer.ts`
      Generates a random EOA, writes the private key to `backend/.env` as
      `MARKETPLACE_SIGNER_PRIVATE_KEY`. **Never commit `.env`.**

  **Why this matters:** reusing an existing wallet (your MetaMask, the
  deployer key) means a backend leak gives the attacker that wallet's
  other holdings + identity, not just the verifier role. Fresh key =
  bounded blast radius.

### 3.2 Fund it

- [ ] Send native gas token to the new address. Estimate: 0.01 native per
      ~50 settlement txs (rough; calibrate on testnet before mainnet).
      Refill before it gets to ~5x the per-tx cost.

### 3.3 Set verifier on the contract

- [ ] Safe (the new admin) executes `escrow.setVerifier(<marketplaceSignerAddress>)`.
      Verify with the verify script:
      `npx hardhat run scripts/verify-upgrade.ts --network 0g-mainnet`.

  **Why this matters:** until this is executed, the verifier is whoever
  it was at deploy time (probably the deployer). Settlement won't work
  until rotation.

### 3.4 Backend env wiring

- [ ] `MARKETPLACE_SIGNER_PRIVATE_KEY` set in mainnet backend's secret
      store (not a `.env` file in plain text on the production host —
      use Vercel secrets, AWS Secrets Manager, or equivalent).
- [ ] Backend's chainId/RPC env vars point at mainnet, not testnet.
- [ ] Backend's contract addresses env vars point at the mainnet
      deployment file.

  **Why this matters:** a misconfig where the backend signs with a mainnet
  key but talks to a testnet RPC (or vice versa) creates "wrong-chain"
  signed txs that leak the key's nonce sequence and waste gas.

### 3.5 Rotate readiness

- [ ] Document the rotation runbook: if the marketplace signer is suspected
      compromised, the Safe calls `setVerifier(<newAddr>)`. Practice this
      once on testnet before mainnet so you know how long it takes
      end-to-end (ETA: ~10 minutes including new key generation, funding,
      and Safe approvals).

  **Why this matters:** when you discover a leak at 3am, you don't want
  to be reading docs.

---

## 4. Operational hardening

### 4.1 Monitoring

- [ ] On-chain alerting for: any tx from the marketplace signer that
      isn't `marketplaceAssign` or `completeVerification`; any admin tx
      from the Safe; any `setVerifier` call. Use Tenderly, Forta, or a
      simple polling script.

### 4.2 Escrow caps

- [ ] Decide on a reasonable per-task amount cap for launch. The contract
      doesn't enforce one. You can enforce off-chain in the UI / backend
      until volume justifies an on-chain cap (which would require a
      contract upgrade).

### 4.3 Pause readiness

- [ ] Verify the Safe knows how to call `escrow.pause()` and `unpause()`.
      Practice once on testnet.

  **Why this matters:** if a critical bug is reported, pause is your
  only legal-time-zero recovery before an upgrade.

### 4.4 Rate limiting in backend

- [ ] Confirm `middleware/rateLimit.ts` settings are appropriate for
      mainnet traffic patterns. Testnet defaults are usually too generous.

---

## 5. Post-deployment verification

Run all of these against the live mainnet contract before announcing:

- [ ] `escrow.admin()` returns the Safe address (not an EOA)
- [ ] `escrow.verifier()` returns the marketplace signer address
- [ ] `escrow.treasury()` returns the intended treasury address
- [ ] `escrow.feeBps()` returns the documented launch fee
- [ ] `escrow.paused()` returns `false` (intentionally; if you want to
      launch paused, document that)
- [ ] Token allowlist contains exactly the documented set
- [ ] A test task completes end-to-end on mainnet with a small amount
      (e.g., $1 USDC) before opening to real users

---

## 5b. Agent-wallet custody — REQUIRED before serious mainnet usage

The hackathon backend currently holds `rawPrivateKey` in cleartext for every
deployed agent, and uses that key to sign sweep / payout / submitEvidence
transactions on the agent's behalf. This is a **custodial** design — convenient
for the demo, but it concentrates risk in the backend DB. Before mainnet you
should walk this back to a non-custodial model.

### 5b.1 Endpoint authorization (DONE for the funds endpoints, NOT for the rest)

- [x] `POST /agents/:id/withdraw` — JWT-gated, verifies `req.user.address`
      matches `agent.ownerAddress`. Refuses while agent is running. Handles
      both native 0G (empty body) and ERC20 tokens (pass tokenAddress).
- [x] `POST /agents/:id/export-key` — JWT-gated.
- [ ] `POST /agents/:id/start | pause | stop` — still trust `req.body.ownerAddress`
      as a plaintext claim. Not fund-moving but trivially griefable. Apply the
      same `requireAuth + authorizeOwner` pattern before mainnet.
- [ ] `PATCH /agents/:id` — same flaw, same fix.

  **Why this matters:** without auth, anyone on the internet who can name an
  agent ID (visible in `/agents` listings) can start/stop/edit it. Funds aren't
  directly at risk because the proceeds go to the stored owner, but operations
  can be disrupted.

### 5b.2 Drop `rawPrivateKey` from the schema

- [ ] Backend should keep only `encryptedPrivateKey` (passphrase-protected, owner
      holds the passphrase). Sweep and submitEvidence endpoints should take the
      passphrase per-request, decrypt in-memory, sign, and discard. Never
      persist the unencrypted form.

  **Why this matters:** today, a DB compromise or backend `.env` leak hands
  every agent's funds to the attacker. Encrypted-at-rest with passphrase the
  backend doesn't store means a DB leak is recoverable.

### 5b.3 Move agent funds into a smart contract (preferred long-term)

- [ ] Replace the EOA agent wallet model with an `AgentVault` contract per agent:
      - `executeOp(...)` callable by the agent's runtime key (for submitEvidence)
      - `withdraw(...)` callable only by the owner with an EIP-712 signature
      - Owner can rotate the runtime key without losing accumulated USDC

  **Why this matters:** today the chain has no notion of "owner controls these
  funds." It just sees a wallet whose key the backend happens to hold. A vault
  contract makes ownership cryptographically enforced rather than custodially
  trusted.

### 5b.4 Signed authorization for all fund-moving actions

- [ ] Before mainnet, replace the "JWT proves identity" pattern with EIP-712
      signed authorization on the wallet side for every withdrawal-class action.
      Owner signs `{action, agentId, nonce, deadline}` → backend verifies on
      `recoverSigner` → executes. Protects against compromised JWTs / cookies.

### 5b.5 Time delay for large withdrawals

- [ ] When `AgentVault` is in place, add a challenge-period delay (1–24h) for
      withdrawals above a configurable threshold. Gives the owner time to
      detect and cancel a malicious sweep if their session token is compromised.

  **Why this matters:** without a delay, a single compromised JWT drains
  everything instantly. A delay buys time for human-in-the-loop intervention.

---

## 6. Out of scope for this checklist (but worth doing)

These are real money-protection measures that aren't free, listed for
when you have budget:

- **Formal audit** (~$30k–$100k for a contract this size, depending on
  firm and turnaround). Required for serious institutional usage.
- **Bug bounty program** on Immunefi or HackenProof. ~$10k+ pool.
- **Timelock on admin actions** — wraps the Safe so even multisig admin
  actions take effect only after a 24-72h delay, giving users time to
  exit if a malicious upgrade is queued. Requires deploying a
  TimelockController contract; ~1 day of work.
- **TEE-attested verification** — the contract was originally designed
  to support 0G Sealed Inference as the verifier. Currently the
  marketplace signer is a regular hot key; integrating Sealed Inference
  attestation would let verification happen in a TEE rather than
  trusting the marketplace operator. Substantial work.

---

## Acknowledgment

Before deploying to mainnet, set the env var that unlocks the deploy
script's mainnet path:

```bash
export I_HAVE_READ_MAINNET_CHECKLIST=yes
```

Setting this is your acknowledgment that every box above is checked.
The script will refuse otherwise. Don't lie to it.
