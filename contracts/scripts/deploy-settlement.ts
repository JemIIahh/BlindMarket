/**
 * Deploy BlindEscrow as a USDC settlement escrow on Base or Arc.
 *
 * Only deploys BlindEscrow. TaskRegistry, BlindReputation, INFT and
 * ValidatorPool stay on 0G, where agents operate. No account-abstraction
 * deploy happens here on any chain. On Base that is the optional
 * deploy-aa.ts, which refuses Arc: Arc pays gas in USDC natively.
 *
 * Before any transaction it checks the chain's USDC ERC-20 (_settlement.ts):
 * the token has code, and it reports 6 decimals and symbol "USDC". After
 * `allowToken(token)` it checks that the escrow allows the token and does NOT
 * allow address(0). On Arc the native coin is 18-decimal USDC, so an
 * allowlisted address(0) would let a task escrow native units priced as
 * 6-decimal USDC. The record is written only once both checks pass.
 *
 * Writes (merges into) the chain's record in the DEPLOYMENT_SET, with the
 * escrow's block under `blocks.BlindEscrow`, and refuses to replace a live
 * BlindEscrow unless ALLOW_ESCROW_REPLACE=true.
 *
 * Usage:
 *   DEPLOYMENT_SET=staging npx hardhat run scripts/deploy-settlement.ts --network arc-testnet
 *   DEPLOYMENT_SET=staging npx hardhat run scripts/deploy-settlement.ts --network base-sepolia
 *   I_HAVE_READ_MAINNET_CHECKLIST=yes ARC_MAINNET_RPC_URL=https://... \
 *     npx hardhat run scripts/deploy-settlement.ts --network arc-mainnet
 */
import { ethers, network, upgrades } from "hardhat";
import { assertSafeNetwork } from "./_guard";
import * as path from "path";
import { deployBlock, preflightDeploy, writeDeployment, type RecordUpdate } from "./_deployments";
import { assertNotNative, SETTLEMENT_CHAINS, type SettlementChain } from "./_settlement";

const ERC20_ABI = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"];

type Provider = typeof ethers.provider;

/**
 * Throws unless `token` is a contract that reports 6 decimals and symbol
 * "USDC". Run before any transaction, so a wrong table entry costs nothing.
 */
export async function checkSettlementToken(token: string, provider: Provider = ethers.provider): Promise<void> {
  assertNotNative(token);
  if ((await provider.getCode(token)) === "0x") {
    throw new Error(`Settlement token ${token} has no code on this chain.`);
  }
  const erc20 = new ethers.Contract(token, ERC20_ABI, provider);
  const [decimals, symbol] = await Promise.all([erc20.decimals(), erc20.symbol()]);
  if (Number(decimals) !== 6) {
    throw new Error(`Settlement token ${token} reports ${decimals} decimals; the backend prices USDC in 6.`);
  }
  if (symbol !== "USDC") {
    throw new Error(`Settlement token ${token} reports symbol "${symbol}", not "USDC".`);
  }
}

interface Allowlist {
  allowedTokens(token: string): Promise<boolean>;
}

/** Throws unless the escrow allows `token` and does not allow address(0). */
export async function assertEscrowAllowlist(escrow: Allowlist, token: string): Promise<void> {
  const [tokenAllowed, nativeAllowed] = await Promise.all([
    escrow.allowedTokens(token),
    escrow.allowedTokens(ethers.ZeroAddress),
  ]);
  if (!tokenAllowed) throw new Error(`The escrow does not allow the settlement token ${token}.`);
  if (nativeAllowed) {
    throw new Error("The escrow allows address(0). A settlement escrow must allow only its USDC ERC-20.");
  }
}

export interface InvariantCheck {
  label: string;
  ok: boolean;
}

/**
 * The settlement invariants verify-deployment-config.ts enforces: the escrow
 * allows the chain's USDC ERC-20, does not allow address(0), and the token
 * passes checkSettlementToken. Empty on a chain `table` has no entry for (0G).
 */
export async function settlementInvariants(
  escrow: Allowlist,
  chainId: number,
  opts: { provider?: Provider; table?: Readonly<Record<number, Pick<SettlementChain, "token">>> } = {},
): Promise<InvariantCheck[]> {
  const chain = (opts.table ?? SETTLEMENT_CHAINS)[chainId];
  if (!chain) return [];
  const token = assertNotNative(chain.token);
  const [tokenAllowed, nativeAllowed] = await Promise.all([
    escrow.allowedTokens(token),
    escrow.allowedTokens(ethers.ZeroAddress),
  ]);
  let tokenError: string | undefined;
  try {
    await checkSettlementToken(token, opts.provider);
  } catch (e) {
    tokenError = (e as Error).message;
  }
  return [
    { label: "escrow allows the settlement token", ok: tokenAllowed === true },
    { label: "escrow does not allow address(0)", ok: nativeAllowed === false },
    { label: `token reports 6 decimals and symbol USDC${tokenError ? ` (${tokenError})` : ""}`, ok: tokenError === undefined },
  ];
}

/**
 * Poll until the escrow reports `token` allowed. A public RPC can answer a
 * read from before the allowToken receipt (Base Sepolia does), and a stale
 * `false` would abort a correct deploy. Only this read is retried: a stale
 * node cannot make address(0) look allowed.
 */
export async function waitForTokenAllowed(
  escrow: Allowlist,
  token: string,
  opts: { tries?: number; delayMs?: number } = {},
): Promise<boolean> {
  const tries = opts.tries ?? 10;
  for (let i = 0; i < tries; i++) {
    if (await escrow.allowedTokens(token)) return true;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, opts.delayMs ?? 2_000));
  }
  return false;
}

export interface DeployedEscrow {
  address: string;
  block: number;
}

/**
 * Deploy the BlindEscrow proxy (treasury and verifier are the deployer until
 * rotated), allowlist `token`, and check the allowlist. On a failed check the
 * error names the deployed escrow, which is then NOT recorded. `wait` tunes
 * the poll for the allowToken write to show (waitForTokenAllowed).
 */
export async function deployEscrow(
  token: string,
  deployer: { address: string },
  wait: { tries?: number; delayMs?: number } = {},
): Promise<DeployedEscrow> {
  assertNotNative(token);
  const startBlock = await ethers.provider.getBlockNumber();
  const BlindEscrow = await ethers.getContractFactory("BlindEscrow");
  const escrow = await upgrades.deployProxy(BlindEscrow, [deployer.address, deployer.address], { kind: "uups" });
  await escrow.waitForDeployment();
  const address = await escrow.getAddress();
  const block = await deployBlock(escrow, startBlock);
  console.log("BlindEscrow:", address, `(block ${block})`);

  await (await (escrow as any).allowToken(token)).wait();
  try {
    await waitForTokenAllowed(escrow as unknown as Allowlist, token, wait);
    await assertEscrowAllowlist(escrow as unknown as Allowlist, token);
  } catch (err) {
    throw new Error(
      `BlindEscrow ${address} (block ${block}) was deployed but is NOT recorded: ${(err as Error).message}`,
    );
  }
  return { address, block };
}

const NOTES = {
  base: "BlindEscrow only — agent infra stays on 0G. Verifier must be rotated to marketplace signer.",
  arc:
    "BlindEscrow only — agent infra stays on 0G. Settles in the USDC ERC-20 (6 decimals); native USDC (address(0)) " +
    "must never be allowlisted. No account-abstraction contracts on Arc. Verifier must be rotated to marketplace signer.",
};

/** The record update for a settlement deploy. `network` is the record's own file name (e.g. "arc-testnet"). */
export function settlementRecord(
  chain: SettlementChain,
  deployer: string,
  escrow: DeployedEscrow,
  timestamp: string,
  network: string,
): RecordUpdate {
  return {
    network,
    chainId: chain.chainId,
    deployer,
    timestamp,
    note: chain.nativeIsSettlementToken ? NOTES.arc : NOTES.base,
    contracts: { BlindEscrow: escrow.address, USDC: chain.token },
    blocks: { BlindEscrow: escrow.block },
  };
}

/** The steps runSettlementDeploy wires together; tests inject a token table and record paths. */
export interface SettlementDeploySteps {
  table: Readonly<Record<number, SettlementChain>>;
  preflight: typeof preflightDeploy;
  checkToken: typeof checkSettlementToken;
  deploy: typeof deployEscrow;
  write: typeof writeDeployment;
}

const DEFAULT_STEPS: SettlementDeploySteps = {
  table: SETTLEMENT_CHAINS,
  preflight: preflightDeploy,
  checkToken: checkSettlementToken,
  deploy: deployEscrow,
  write: writeDeployment,
};

/**
 * The whole deploy. `only` restricts it to some chain ids (deploy-base.ts
 * passes Base's). The order is the point: the token is checked and the
 * record's guards run BEFORE the first transaction, and the record is
 * written only after the allowlist check passed.
 */
export async function runSettlementDeploy(
  opts: { only?: readonly number[]; script?: string; steps?: Partial<SettlementDeploySteps> } = {},
): Promise<void> {
  const steps: SettlementDeploySteps = { ...DEFAULT_STEPS, ...(opts.steps ?? {}) };
  await assertSafeNetwork();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (opts.only && !opts.only.includes(chainId)) {
    throw new Error(
      `${opts.script ?? "This script"} deploys on chainId ${opts.only.join(" or ")} only, not ${chainId}. ` +
        "Use scripts/deploy-settlement.ts.",
    );
  }
  const chain = steps.table[chainId];
  if (!chain) {
    throw new Error(
      `chainId ${chainId} has no settlement token (known: ${Object.keys(steps.table).join(", ")}). ` +
        "0G settles in its native coin through deploy-testnet.ts / deploy-mainnet.ts.",
    );
  }
  const token = assertNotNative(chain.token);

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  const balance = await ethers.provider.getBalance(deployer.address);
  // Arc's native balance is USDC with 18 decimals, so formatEther reads it too.
  console.log("Balance:", ethers.formatEther(balance), chain.gasSymbol);
  if (balance === 0n) {
    throw new Error(`Deployer has 0 ${chain.gasSymbol}. Fund it with ${chain.gasSymbol} on ${chain.label}.`);
  }
  console.log("Chain:", chain.label, `(chainId: ${chainId}, hardhat network: ${network.name})`);
  console.log("Settlement token:", token);
  await steps.checkToken(token);
  console.log("Settlement token checked: 6 decimals, symbol USDC.");

  const target = steps.preflight({ chainId, deploysEscrow: true });

  console.log("\n--- Deploying BlindEscrow ---");
  const escrow = await steps.deploy(token, deployer);
  console.log(`Allowlisted ${token}; address(0) is not allowlisted.`);

  const deployment = steps.write(
    target.file,
    settlementRecord(chain, deployer.address, escrow, new Date().toISOString(), path.basename(target.file, ".json")),
  );
  console.log("\nDeployment saved to:", target.file, `(set ${target.set})`);

  console.log("\n=== DEPLOYMENT SUMMARY ===");
  console.log(JSON.stringify(deployment.contracts, null, 2));

  const remaining = await ethers.provider.getBalance(deployer.address);
  console.log("\nRemaining balance:", ethers.formatEther(remaining), chain.gasSymbol);

  console.log("\n--- Next steps ---");
  const setEnv = target.set === "default" ? "" : `DEPLOYMENT_SET=${target.set} `;
  if (chain.nativeIsSettlementToken) {
    // generate-marketplace-signer.ts writes the 0G signer's key name into
    // backend/.env, which is not what an Arc escrow needs.
    console.log(`1. Signer: create a key used only by this ${chain.label} escrow (set "${target.set}").`);
    console.log("   Arc is not a backend settlement chain yet, so no backend env var takes it.");
  } else if (target.set === "default") {
    console.log("1. Generate marketplace signer:  npx hardhat run scripts/generate-marketplace-signer.ts --network", network.name);
  } else {
    // generate-marketplace-signer.ts writes backend/.env, which is not the
    // staging backend's environment and may hold production keys.
    console.log(`1. Signer: create a key used only by set "${target.set}" and set it as`);
    console.log(`   BASE_MARKETPLACE_SIGNER_PRIVATE_KEY in that stack's backend env (not backend/.env).`);
  }
  console.log(`2. Rotate verifier:              ${setEnv}EXPECTED_ESCROW=${escrow.address} MARKETPLACE_SIGNER_ADDRESS=0x... npx hardhat run scripts/rotate-verifier.ts --network`, network.name);
  if (chain.nativeIsSettlementToken) {
    console.log(`3. Backend: nothing to set yet. The record holds blocks.BlindEscrow=${escrow.block}.`);
    console.log("   No account-abstraction deploy on Arc: deploy-aa.ts refuses it.");
  } else {
    console.log(`3. Backend env:                  BASE_ESCROW_ADDRESS=${escrow.address} BASE_ESCROW_DEPLOYMENT_BLOCK=${escrow.block}`);
  }
}

if (require.main === module) {
  runSettlementDeploy().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
