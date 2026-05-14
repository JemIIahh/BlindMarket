/**
 * End-to-end smoke test of the agent-to-agent flow against the deployed
 * testnet contracts + running backend. Exercises every component of the
 * settlement bridge in order:
 *
 *   1. Read env (POSTER_PRIVATE_KEY, contracts/.env; JWT_SECRET, backend/.env)
 *   2. Generate a fresh throwaway agent wallet and fund it from the poster
 *   3. Mint platform JWTs for the poster and the agent locally using JWT_SECRET
 *   4. POST /api/v1/tasks (poster auth) — receive unsigned createTask tx
 *   5. Sign + broadcast createTask with poster wallet
 *   6. Poll Redis (via a backend probe) for the taskHash → taskId mapping
 *   7. POST /api/v1/a2a/register (agent auth) — agent declares capabilities
 *   8. POST /api/v1/a2a/tasks/:hash/accept (agent auth) — bridge fires
 *      marketplaceAssign in the background
 *   9. Poll BlindEscrow.getTask() until status == Assigned
 *  10. POST /api/v1/a2a/tasks/:hash/submit (agent auth) — receive unsigned
 *      submitEvidence tx
 *  11. Sign + broadcast submitEvidence with agent wallet
 *  12. POST /api/v1/a2a/tasks/:hash/finalize (agent auth) — backend runs
 *      autoVerify and fires settleVerification in the background
 *  13. Poll BlindEscrow.getTask() until status == Completed
 *
 * Run:
 *   cd backend
 *   npx tsx scripts/smoketest-a2a.ts
 *
 * The script is intentionally chatty; every phase logs what it's doing,
 * what it's waiting on, and the tx hashes / addresses involved. Exit code
 * is 0 on success, 1 on any failed phase.
 */

import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';
import { Wallet, JsonRpcProvider, Contract, parseUnits, formatUnits, formatEther, randomBytes, hexlify, type TransactionRequest } from 'ethers';
import jwt from 'jsonwebtoken';

// ESM dirname shim — package.json type:module means __dirname isn't defined.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Helpers ──────────────────────────────────────────────────────────────────

const log = (phase: string, msg: string) =>
  console.log(`\x1b[36m[${phase}]\x1b[0m ${msg}`);
const ok = (msg: string) => console.log(`\x1b[32m  ✓\x1b[0m ${msg}`);
const warn = (msg: string) => console.log(`\x1b[33m  !\x1b[0m ${msg}`);
const fail = (msg: string): never => {
  console.error(`\x1b[31m  ✗\x1b[0m ${msg}`);
  process.exit(1);
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Mint an HS256 JWT in the shape verifyRegistrationToken expects (must carry
// both `address` and `ownerAddress` claims).
function mintPlatformJWT(jwtSecret: string, address: string): string {
  return jwt.sign(
    { address, ownerAddress: address, agentName: 'smoketest' },
    jwtSecret,
    { algorithm: 'HS256', expiresIn: '1h' },
  );
}

// ── Pre-flight: env + wallets ────────────────────────────────────────────────

// Load contracts/.env (POSTER_PRIVATE_KEY) + backend/.env (JWT_SECRET, RPC, etc.)
const backendEnvPath = resolve(__dirname, '../.env');
const contractsEnvPath = resolve(__dirname, '../../contracts/.env');
if (existsSync(contractsEnvPath)) dotenvConfig({ path: contractsEnvPath, override: false });
if (existsSync(backendEnvPath)) dotenvConfig({ path: backendEnvPath, override: false });

const POSTER_PRIVATE_KEY = process.env.POSTER_PRIVATE_KEY;
const JWT_SECRET = process.env.JWT_SECRET;
const OG_RPC_URL = process.env.OG_RPC_URL ?? 'https://evmrpc-testnet.0g.ai';
const OG_CHAIN_ID = Number(process.env.OG_CHAIN_ID ?? 16602);
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3001';

if (!POSTER_PRIVATE_KEY) fail('POSTER_PRIVATE_KEY missing — set it in contracts/.env');
if (!JWT_SECRET) fail('JWT_SECRET missing — must be in backend/.env');

// Contract addresses from the deployments file (source of truth)
const deployments = JSON.parse(
  readFileSync(resolve(__dirname, '../../contracts/deployments/0g-testnet.json'), 'utf-8'),
);
const BLIND_ESCROW_ADDRESS = deployments.contracts.BlindEscrow as string;
const USDC_ADDRESS = deployments.contracts.MockERC20 as string;

// Minimal ABIs — just what this script calls. The Task struct order MUST match
// BlindEscrow.sol:45 exactly — getting it wrong silently decodes other fields
// (e.g. evidenceHash bytes appearing as a uint8 status). Source-of-truth order:
// agent, worker, token, amount, taskHash, evidenceHash, status, category,
// locationZone, createdAt, deadline, submissionAttempts.
const ESCROW_ABI = [
  'function getTask(uint256 taskId) view returns (tuple(address agent, address worker, address token, uint256 amount, bytes32 taskHash, bytes32 evidenceHash, uint8 status, string category, string locationZone, uint256 createdAt, uint256 deadline, uint8 submissionAttempts))',
  'function nextTaskId() view returns (uint256)',
];
const USDC_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function mint(address,uint256) external',
  'function decimals() view returns (uint8)',
];

// Status enum from BlindEscrow.sol:35 — order matters (these are uint8 indices
// on the contract). Don't reorder unless you're matching the contract change.
//   0 Funded · 1 Assigned · 2 Submitted · 3 Verified(failed/retryable)
//   4 Completed · 5 Cancelled · 6 Disputed
const STATUS = ['Funded', 'Assigned', 'Submitted', 'Verified', 'Completed', 'Cancelled', 'Disputed'];

async function main() {
  log('init', `RPC: ${OG_RPC_URL} chainId=${OG_CHAIN_ID}`);
  log('init', `Backend: ${BACKEND_URL}`);
  log('init', `Escrow: ${BLIND_ESCROW_ADDRESS}`);
  log('init', `USDC: ${USDC_ADDRESS}`);

  const provider = new JsonRpcProvider(OG_RPC_URL, OG_CHAIN_ID, {
    batchMaxCount: 1,
    staticNetwork: true,
  });

  const poster = new Wallet(POSTER_PRIVATE_KEY!, provider);
  ok(`poster wallet: ${poster.address}`);

  // Backend health
  log('preflight', 'checking backend health...');
  try {
    const res = await fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) fail(`backend /health returned ${res.status}`);
    ok('backend is up');
  } catch (e) {
    fail(`backend unreachable: ${(e as Error).message}`);
  }

  // Balances
  const usdc = new Contract(USDC_ADDRESS, USDC_ABI, provider);
  const escrow = new Contract(BLIND_ESCROW_ADDRESS, ESCROW_ABI, provider);
  const usdcDecimals = Number(await usdc.decimals());
  const aogiBal = await provider.getBalance(poster.address);
  const usdcBal = await usdc.balanceOf(poster.address);
  ok(`poster AOGI: ${formatEther(aogiBal)} · USDC: ${formatUnits(usdcBal, usdcDecimals)}`);

  const taskAmount = parseUnits('1', usdcDecimals); // 1 USDC bounty
  const fundAgent = parseUnits('0.02', 18);          // 0.02 AOGI to throwaway agent
  if (aogiBal < parseUnits('0.005', 18)) {
    fail(`poster AOGI too low — need ≥ 0.005 to cover gas + agent funding (have ${formatEther(aogiBal)})`);
  }
  if (usdcBal < taskAmount) {
    log('preflight', `minting ${formatUnits(taskAmount, usdcDecimals)} USDC to poster`);
    const usdcMinter = new Contract(USDC_ADDRESS, USDC_ABI, poster);
    const tx = await usdcMinter.mint(poster.address, taskAmount);
    await tx.wait();
    ok(`mint confirmed: ${tx.hash}`);
  }

  // Generate throwaway agent
  log('agent-setup', 'generating throwaway agent wallet...');
  const agent = Wallet.createRandom(provider);
  ok(`agent address: ${agent.address}`);

  // Fund agent
  log('agent-setup', `funding agent with ${formatEther(fundAgent)} AOGI from poster...`);
  const fundTx = await poster.sendTransaction({ to: agent.address, value: fundAgent });
  ok(`fund tx broadcast: ${fundTx.hash}`);
  await fundTx.wait();
  const agentBal = await provider.getBalance(agent.address);
  ok(`agent AOGI: ${formatEther(agentBal)}`);

  // Mint platform JWTs
  const posterJWT = mintPlatformJWT(JWT_SECRET!, poster.address);
  const agentJWT = mintPlatformJWT(JWT_SECRET!, agent.address);
  ok('platform JWTs minted (HS256 against JWT_SECRET)');

  // ── Phase: Post task ────────────────────────────────────────────────────
  log('post', 'POST /api/v1/tasks (poster auth) ...');

  // Approve escrow to spend USDC (skipped if allowance already covers)
  const allowance = await usdc.allowance(poster.address, BLIND_ESCROW_ADDRESS);
  if (allowance < taskAmount) {
    const usdcAsPoster = new Contract(USDC_ADDRESS, USDC_ABI, poster);
    log('post', `approving ${formatUnits(taskAmount, usdcDecimals)} USDC to escrow...`);
    const approveTx = await usdcAsPoster.approve(BLIND_ESCROW_ADDRESS, taskAmount);
    await approveTx.wait();
    ok(`approve confirmed: ${approveTx.hash}`);
  } else {
    ok(`allowance sufficient: ${formatUnits(allowance, usdcDecimals)} USDC`);
  }

  // Random taskHash so each run is unique
  const taskHash = hexlify(randomBytes(32));
  const duration = '3600'; // 1 hour minimum

  const createBody = {
    taskHash,
    token: USDC_ADDRESS,
    amount: taskAmount.toString(),
    category: 'smoketest',
    locationZone: 'global',
    duration,
    targetExecutorType: 'agent',
    verificationMode: 'auto',
    verificationCriteria: { min_length: 10 },
  };
  const createRes = await fetch(`${BACKEND_URL}/api/v1/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${posterJWT}`,
    },
    body: JSON.stringify(createBody),
  });
  if (!createRes.ok) {
    const txt = await createRes.text();
    fail(`POST /api/v1/tasks failed: ${createRes.status} ${txt.slice(0, 400)}`);
  }
  const createJson = await createRes.json();
  const unsignedCreate: TransactionRequest = createJson.data.unsignedTx;
  ok('backend returned unsigned createTask tx + mirrored task into a2aStore');

  // Sign + broadcast
  log('post', 'signing + broadcasting createTask...');
  const createSent = await poster.sendTransaction(unsignedCreate);
  ok(`createTask broadcast: ${createSent.hash}`);
  const createReceipt = await createSent.wait();
  ok(`createTask confirmed: block=${createReceipt?.blockNumber} status=${createReceipt?.status}`);

  // ── Phase: Wait for hash→id mapping ─────────────────────────────────────
  log('event-listener', `waiting for /a2a/tasks to surface taskHash=${taskHash.slice(0, 10)}…`);
  let onChainTaskId: string | null = null;
  const indexDeadline = Date.now() + 90_000;
  while (Date.now() < indexDeadline) {
    // The /a2a/tasks endpoint returns tasks whose meta exists AND state=open.
    // We use it as a proxy for "backend can resolve this task" — but the
    // hash→id mapping is what the bridge needs. We can also probe via
    // BlindEscrow.nextTaskId() to confirm the task is on chain. The escrow
    // event listener should populate the mapping within one tick (~30s).
    const res = await fetch(`${BACKEND_URL}/api/v1/a2a/tasks`, {
      headers: { 'Authorization': `Bearer ${agentJWT}` },
    });
    if (res.ok) {
      const json = await res.json();
      const found = (json.data?.tasks ?? []).find((t: any) => t.meta?.taskId?.toLowerCase() === taskHash.toLowerCase());
      if (found) {
        // The task is browseable, meaning meta is in a2aStore. The hash2id
        // mapping is populated by the event listener separately; the
        // /accept handler waits for it on the backend side anyway.
        ok(`task surfaced in /a2a/tasks`);
        break;
      }
    }
    process.stdout.write('.');
    await sleep(3000);
  }
  process.stdout.write('\n');

  // ── Phase: agent register ───────────────────────────────────────────────
  log('agent-register', 'POST /api/v1/a2a/register (agent auth) ...');
  const registerRes = await fetch(`${BACKEND_URL}/api/v1/a2a/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${agentJWT}`,
    },
    body: JSON.stringify({
      displayName: 'smoketest-agent',
      capabilities: ['data_processing'],
    }),
  });
  if (!registerRes.ok) {
    const txt = await registerRes.text();
    fail(`/a2a/register failed: ${registerRes.status} ${txt.slice(0, 200)}`);
  }
  ok('agent registered as A2A executor');

  // ── Phase: agent accept ─────────────────────────────────────────────────
  log('agent-accept', `POST /api/v1/a2a/tasks/${taskHash.slice(0, 12)}…/accept`);
  const acceptRes = await fetch(`${BACKEND_URL}/api/v1/a2a/tasks/${taskHash}/accept`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${agentJWT}`,
    },
  });
  if (!acceptRes.ok) {
    const txt = await acceptRes.text();
    fail(`/a2a/accept failed: ${acceptRes.status} ${txt.slice(0, 200)}`);
  }
  ok('accept recorded — bridge will fire marketplaceAssign');

  // Look up on-chain taskId. nextTaskId() returns the next id to be issued,
  // so our task is nextTaskId-1 (we just created it).
  const nextId = await escrow.nextTaskId();
  onChainTaskId = (nextId - 1n).toString();
  log('agent-accept', `on-chain taskId: ${onChainTaskId}`);

  // ── Phase: Wait for marketplaceAssign ───────────────────────────────────
  log('bridge', 'polling BlindEscrow.getTask until status=Assigned...');
  const assignDeadline = Date.now() + 120_000;
  while (Date.now() < assignDeadline) {
    const t = await escrow.getTask(onChainTaskId);
    const statusName = STATUS[Number(t.status)] ?? `unknown(${t.status})`;
    if (statusName === 'Assigned') {
      ok(`on-chain status: Assigned · worker=${t.worker}`);
      if (t.worker.toLowerCase() !== agent.address.toLowerCase()) {
        warn(`worker (${t.worker}) ≠ our agent (${agent.address}) — someone else accepted first?`);
      }
      break;
    }
    process.stdout.write(`.`);
    await sleep(3000);
  }
  process.stdout.write('\n');

  // ── Phase: agent submit ─────────────────────────────────────────────────
  log('agent-submit', 'POST /api/v1/a2a/tasks/.../submit');
  const resultData = { output: 'Acknowledged. Smoke test result from throwaway agent.' };
  const submitRes = await fetch(`${BACKEND_URL}/api/v1/a2a/tasks/${taskHash}/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${agentJWT}`,
    },
    body: JSON.stringify({ resultData }),
  });
  if (!submitRes.ok) {
    const txt = await submitRes.text();
    fail(`/a2a/submit failed: ${submitRes.status} ${txt.slice(0, 200)}`);
  }
  const submitJson = await submitRes.json();
  const unsignedSubmitEvidence: TransactionRequest = submitJson.data.unsignedSubmitEvidence;
  if (!unsignedSubmitEvidence) fail('backend did not return unsignedSubmitEvidence');
  ok(`backend returned unsigned submitEvidence — evidenceHash=${submitJson.data.evidenceHash}`);

  log('agent-submit', 'signing + broadcasting submitEvidence with agent wallet...');
  const submitSent = await agent.sendTransaction(unsignedSubmitEvidence);
  ok(`submitEvidence broadcast: ${submitSent.hash}`);
  const submitReceipt = await submitSent.wait();
  ok(`submitEvidence confirmed: block=${submitReceipt?.blockNumber} status=${submitReceipt?.status}`);

  // ── Phase: agent finalize ───────────────────────────────────────────────
  log('agent-finalize', 'POST /api/v1/a2a/tasks/.../finalize');
  const finalizeRes = await fetch(`${BACKEND_URL}/api/v1/a2a/tasks/${taskHash}/finalize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${agentJWT}`,
    },
  });
  if (!finalizeRes.ok) {
    const txt = await finalizeRes.text();
    fail(`/a2a/finalize failed: ${finalizeRes.status} ${txt.slice(0, 200)}`);
  }
  const finalizeJson = await finalizeRes.json();
  ok(`finalize result: ${JSON.stringify(finalizeJson.data)}`);

  // ── Phase: Wait for on-chain completeVerification ───────────────────────
  log('bridge', 'polling BlindEscrow.getTask until status=Completed...');
  const completeDeadline = Date.now() + 120_000;
  let finalStatus = '';
  while (Date.now() < completeDeadline) {
    const t = await escrow.getTask(onChainTaskId);
    finalStatus = STATUS[Number(t.status)] ?? `unknown(${t.status})`;
    if (finalStatus === 'Completed' || finalStatus === 'Cancelled') {
      break;
    }
    process.stdout.write(`.`);
    await sleep(3000);
  }
  process.stdout.write('\n');

  // ── Final verification ──────────────────────────────────────────────────
  const finalUsdc = await usdc.balanceOf(agent.address);
  const finalAgentBal = await provider.getBalance(agent.address);
  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Smoke test summary');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  on-chain status: ${finalStatus}`);
  console.log(`  taskId: ${onChainTaskId} · taskHash: ${taskHash.slice(0, 18)}…`);
  console.log(`  agent address: ${agent.address}`);
  console.log(`  agent USDC after: ${formatUnits(finalUsdc, usdcDecimals)} (expected ≥ 0.85)`);
  console.log(`  agent AOGI after: ${formatEther(finalAgentBal)}`);
  console.log('');
  if (finalStatus === 'Completed' && finalUsdc >= (taskAmount * 85n) / 100n) {
    console.log('\x1b[32m  PASSED · escrow released, agent received 85% bounty\x1b[0m');
    process.exit(0);
  } else {
    console.log(`\x1b[31m  FAILED · expected Completed + ≥0.85 USDC to agent\x1b[0m`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\x1b[31m[fatal]\x1b[0m', e);
  process.exit(1);
});
