/**
 * Extensive A2A smoke battery. Runs multiple scenarios concurrently against
 * the live testnet contracts + running backend, exercising the agent-to-agent
 * flow from several angles:
 *
 *   • happy-pass        — auto-verify passes, escrow releases to agent
 *   • happy-pass-long   — same shape with a longer result, sanity check
 *   • criteria-fail     — resultData fails contains_keywords; chain reaches
 *                         "Verified" (failed-but-retryable) without releasing
 *                         to the agent. Demonstrates the failure branch.
 *   • capability-block  — agent declares only ['data_processing'] but task
 *                         requires ['code_execution'] — /accept must 403 the
 *                         agent before any on-chain assignment happens.
 *
 * Each scenario uses its OWN throwaway executor wallet so concurrency works
 * cleanly. They share a single poster wallet (POSTER_PRIVATE_KEY) — same
 * network actor pattern as A2A, scripted because we don't have an
 * autonomous-posting tool in worker.js yet.
 *
 * Run:
 *   cd backend
 *   npx tsx scripts/smoketest-a2a-extensive.ts
 */

import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';
import {
  Wallet, JsonRpcProvider, Contract,
  parseUnits, formatUnits, formatEther,
  randomBytes, hexlify,
  type TransactionRequest,
} from 'ethers';
import jwt from 'jsonwebtoken';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Color logging ────────────────────────────────────────────────────────────

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const log = (scenario: string, msg: string) =>
  console.log(`${c.dim('[')}${c.cyan(scenario.padEnd(18))}${c.dim(']')} ${msg}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Env + addresses ──────────────────────────────────────────────────────────

const contractsEnvPath = resolve(__dirname, '../../contracts/.env');
const backendEnvPath = resolve(__dirname, '../.env');
if (existsSync(contractsEnvPath)) dotenvConfig({ path: contractsEnvPath, override: false });
if (existsSync(backendEnvPath)) dotenvConfig({ path: backendEnvPath, override: false });

const POSTER_PRIVATE_KEY = process.env.POSTER_PRIVATE_KEY;
const JWT_SECRET = process.env.JWT_SECRET;
const OG_RPC_URL = process.env.OG_RPC_URL ?? 'https://evmrpc-testnet.0g.ai';
const OG_CHAIN_ID = Number(process.env.OG_CHAIN_ID ?? 16602);
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3001';
if (!POSTER_PRIVATE_KEY) { console.error('POSTER_PRIVATE_KEY missing'); process.exit(1); }
if (!JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(1); }

const deployments = JSON.parse(
  readFileSync(resolve(__dirname, '../../contracts/deployments/0g-testnet.json'), 'utf-8'),
);
const BLIND_ESCROW_ADDRESS = deployments.contracts.BlindEscrow as string;
const USDC_ADDRESS = deployments.contracts.MockERC20 as string;

// Task struct matches BlindEscrow.sol:45 exactly — order is load-bearing.
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
// Enum order from BlindEscrow.sol:35: Funded, Assigned, Submitted,
// Verified (failed-but-retryable), Completed (passed), Cancelled, Disputed.
const STATUS = ['Funded', 'Assigned', 'Submitted', 'Verified', 'Completed', 'Cancelled', 'Disputed'];

// ── Scenarios ────────────────────────────────────────────────────────────────

type ExpectedTerminal = 'Completed' | 'Verified' | 'AcceptRejected';

interface Scenario {
  name: string;
  bountyUsdc: string;
  /** Capabilities the EXECUTOR declares at /a2a/register */
  executorCapabilities: string[];
  /** Capabilities the TASK requires. Mismatch with executorCapabilities → 403. */
  requiredCapabilities: string[];
  /** Auto-verify criteria written to a2aStore. */
  criteria: Record<string, unknown>;
  /** The result the executor submits. */
  resultData: Record<string, unknown>;
  /** Where the scenario should end up. */
  expect: ExpectedTerminal;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'happy-short',
    bountyUsdc: '1',
    executorCapabilities: ['data_processing'],
    requiredCapabilities: ['data_processing'],
    criteria: { min_length: 10 },
    resultData: { output: 'Long enough acknowledgement string.' },
    expect: 'Completed',
  },
  {
    name: 'happy-long',
    bountyUsdc: '0.5',
    executorCapabilities: ['text_analysis'],
    requiredCapabilities: ['text_analysis'],
    criteria: { min_length: 40 },
    resultData: { output: 'A longer result for the second scenario, well above the forty-character minimum.' },
    expect: 'Completed',
  },
  {
    name: 'criteria-fail',
    bountyUsdc: '0.5',
    executorCapabilities: ['data_processing'],
    requiredCapabilities: ['data_processing'],
    criteria: { contains_keywords: ['SPECIFIC_TOKEN_THAT_WONT_APPEAR'] },
    resultData: { output: 'Sufficiently long string but the keyword is absent on purpose.' },
    expect: 'Verified', // failed-but-retryable; status = Verified, escrow not released
  },
  {
    name: 'capability-block',
    bountyUsdc: '0.5',
    executorCapabilities: ['data_processing'],
    requiredCapabilities: ['code_execution'], // executor doesn't have this → 403 on /accept
    criteria: { min_length: 10 },
    resultData: { output: 'Should never get submitted because accept is rejected.' },
    expect: 'AcceptRejected',
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function mintJWT(address: string): string {
  return jwt.sign(
    { address, ownerAddress: address, agentName: 'extensive-smoketest' },
    JWT_SECRET!,
    { algorithm: 'HS256', expiresIn: '1h' },
  );
}

async function jsonPost(url: string, token: string, body: unknown): Promise<{ ok: boolean; status: number; data: any; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { }
  return { ok: res.ok, status: res.status, data, text };
}

// ── Single scenario run ──────────────────────────────────────────────────────

interface Result {
  scenario: string;
  ok: boolean;
  expected: ExpectedTerminal;
  actual: string;
  taskId?: string;
  taskHash?: string;
  payoutUsdc?: string;
  notes?: string;
  elapsedSec: number;
}

interface Bootstrapped {
  scenario: Scenario;
  executor: Wallet;
  executorJWT: string;
  taskHash: string;
  onChainId: string;
  t0: number;
}

/**
 * Poster-phase bootstrap — runs sequentially per scenario because all txs
 * sign from the SAME poster wallet and share its nonce. Doing this serially
 * up-front lets the agent-side execution run concurrently afterwards.
 */
async function bootstrapPosterSide(
  scenario: Scenario,
  poster: Wallet,
  posterJWT: string,
  usdcDecimals: number,
  escrow: Contract,
): Promise<Bootstrapped> {
  const name = scenario.name;
  const t0 = Date.now();

  // 1. Generate executor wallet
  const executor = Wallet.createRandom(poster.provider!);
  log(name, `executor: ${executor.address}`);

  // 2. Fund executor (small AOGI for its submitEvidence tx)
  const fundTx = await poster.sendTransaction({ to: executor.address, value: parseUnits('0.02', 18) });
  await fundTx.wait();
  log(name, `${c.green('✓')} funded executor with 0.02 AOGI`);

  // 3. POST /api/v1/tasks → unsigned createTask tx
  const taskHash = hexlify(randomBytes(32));
  const bountyWei = parseUnits(scenario.bountyUsdc, usdcDecimals);
  const createRes = await jsonPost(`${BACKEND_URL}/api/v1/tasks`, posterJWT, {
    taskHash,
    token: USDC_ADDRESS,
    amount: bountyWei.toString(),
    category: 'smoketest',
    locationZone: 'global',
    duration: '3600',
    targetExecutorType: 'agent',
    verificationMode: 'auto',
    verificationCriteria: scenario.criteria,
    requiredCapabilities: scenario.requiredCapabilities,
  });
  if (!createRes.ok) {
    throw new Error(`/api/v1/tasks ${createRes.status}: ${createRes.text.slice(0, 160)}`);
  }
  log(name, `${c.green('✓')} task created off-chain (bounty=${scenario.bountyUsdc} USDC)`);

  // 4. Sign + broadcast createTask
  const unsignedCreate: TransactionRequest = createRes.data.data.unsignedTx;
  const createSent = await poster.sendTransaction(unsignedCreate);
  const createReceipt = await createSent.wait();
  log(name, `${c.green('✓')} createTask confirmed (block=${createReceipt?.blockNumber})`);

  const onChainId = ((await escrow.nextTaskId()) - 1n).toString();
  log(name, `${c.green('✓')} on-chain taskId=${onChainId}`);

  return { scenario, executor, executorJWT: mintJWT(executor.address), taskHash, onChainId, t0 };
}

/**
 * Agent-side execution — runs concurrently across scenarios because each
 * scenario has its own executor wallet with its own nonce sequence.
 */
async function runAgentSide(
  bootstrap: Bootstrapped,
  escrow: Contract,
  usdc: Contract,
  usdcDecimals: number,
): Promise<Result> {
  const { scenario, executor, executorJWT, taskHash, onChainId, t0 } = bootstrap;
  const name = scenario.name;

  // 1. Wait for /a2a/tasks to surface the task (event listener mapped hash→id)
  const indexDeadline = Date.now() + 60_000;
  while (Date.now() < indexDeadline) {
    const browseRes = await fetch(`${BACKEND_URL}/api/v1/a2a/tasks`, {
      headers: { 'Authorization': `Bearer ${executorJWT}` },
    });
    if (browseRes.ok) {
      const j = await browseRes.json();
      const found = (j.data?.tasks ?? []).find((t: any) => t.meta?.taskId?.toLowerCase() === taskHash.toLowerCase());
      if (found) break;
    }
    await sleep(2000);
  }

  // 2. Register executor with its declared capabilities
  const regRes = await jsonPost(`${BACKEND_URL}/api/v1/a2a/register`, executorJWT, {
    displayName: `exec-${name}`,
    capabilities: scenario.executorCapabilities,
  });
  if (!regRes.ok) {
    return {
      scenario: name, ok: false, expected: scenario.expect, actual: 'register_failed',
      notes: `${regRes.status} ${regRes.text.slice(0, 160)}`, elapsedSec: (Date.now() - t0) / 1000
    };
  }
  log(name, `${c.green('✓')} executor registered (caps=[${scenario.executorCapabilities.join(',')}])`);

  // 6. Accept
  const acceptRes = await jsonPost(`${BACKEND_URL}/api/v1/a2a/tasks/${taskHash}/accept`, executorJWT, {});
  if (!acceptRes.ok) {
    // The capability-block scenario lands here intentionally. Distinguish:
    const isCapBlock = acceptRes.status === 403 && /CAPABILITY_MISMATCH|capabilities/i.test(acceptRes.text);
    if (scenario.expect === 'AcceptRejected' && isCapBlock) {
      log(name, `${c.green('✓')} accept rejected as expected: ${acceptRes.status}`);
      return {
        scenario: name, ok: true, expected: scenario.expect, actual: 'AcceptRejected',
        taskId: onChainId, taskHash, notes: 'capability gate blocked the accept (correct behavior)',
        elapsedSec: (Date.now() - t0) / 1000
      };
    }
    return {
      scenario: name, ok: false, expected: scenario.expect, actual: 'accept_failed',
      notes: `${acceptRes.status} ${acceptRes.text.slice(0, 160)}`, elapsedSec: (Date.now() - t0) / 1000
    };
  }
  log(name, `${c.green('✓')} accept recorded — bridge fires marketplaceAssign`);

  if (scenario.expect === 'AcceptRejected') {
    // We expected a rejection but accept succeeded — that's a regression on capability gating.
    return {
      scenario: name, ok: false, expected: scenario.expect, actual: 'AcceptSucceeded_butExpectedRejection',
      notes: 'capability gate didn\'t block the accept', taskId: onChainId, taskHash,
      elapsedSec: (Date.now() - t0) / 1000
    };
  }

  // 7. Wait for marketplaceAssign → status flips to Assigned
  const assignDeadline = Date.now() + 90_000;
  while (Date.now() < assignDeadline) {
    const t = await escrow.getTask(onChainId);
    if (STATUS[Number(t.status)] === 'Assigned') {
      log(name, `${c.green('✓')} on-chain Assigned`);
      break;
    }
    await sleep(3000);
  }

  // 8. Submit + sign + broadcast submitEvidence
  const submitRes = await jsonPost(`${BACKEND_URL}/api/v1/a2a/tasks/${taskHash}/submit`, executorJWT, {
    resultData: scenario.resultData,
  });
  if (!submitRes.ok) {
    return {
      scenario: name, ok: false, expected: scenario.expect, actual: 'submit_failed',
      notes: `${submitRes.status} ${submitRes.text.slice(0, 160)}`, elapsedSec: (Date.now() - t0) / 1000
    };
  }
  const unsignedSubmit: TransactionRequest = submitRes.data.data.unsignedSubmitEvidence;
  const submitSent = await executor.sendTransaction(unsignedSubmit);
  const submitReceipt = await submitSent.wait();
  log(name, `${c.green('✓')} submitEvidence confirmed: block=${submitReceipt?.blockNumber}`);

  // 9. Finalize — backend runs autoVerify + fires settleVerification
  const finalizeRes = await jsonPost(`${BACKEND_URL}/api/v1/a2a/tasks/${taskHash}/finalize`, executorJWT, {});
  if (!finalizeRes.ok) {
    return {
      scenario: name, ok: false, expected: scenario.expect, actual: 'finalize_failed',
      notes: `${finalizeRes.status} ${finalizeRes.text.slice(0, 160)}`, elapsedSec: (Date.now() - t0) / 1000
    };
  }
  log(name, `${c.green('✓')} finalize: ${JSON.stringify(finalizeRes.data?.data?.verificationResult ?? finalizeRes.data?.data)}`);

  // 10. Wait for terminal status on chain
  const completeDeadline = Date.now() + 120_000;
  let finalStatus = '';
  while (Date.now() < completeDeadline) {
    const t = await escrow.getTask(onChainId);
    finalStatus = STATUS[Number(t.status)] ?? `unknown(${t.status})`;
    if (finalStatus === 'Completed' || finalStatus === 'Verified' || finalStatus === 'Cancelled') break;
    await sleep(3000);
  }

  const finalUsdc = await usdc.balanceOf(executor.address);
  const payoutUsdc = formatUnits(finalUsdc, usdcDecimals);

  const ok = (finalStatus === scenario.expect);
  return {
    scenario: name,
    ok,
    expected: scenario.expect,
    actual: finalStatus,
    taskId: onChainId,
    taskHash,
    payoutUsdc,
    elapsedSec: (Date.now() - t0) / 1000,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(c.bold('\n═══ A2A extensive smoke battery ═══\n'));
  console.log(`  RPC:     ${OG_RPC_URL}`);
  console.log(`  Backend: ${BACKEND_URL}`);
  console.log(`  Escrow:  ${BLIND_ESCROW_ADDRESS}`);
  console.log(`  USDC:    ${USDC_ADDRESS}\n`);

  const provider = new JsonRpcProvider(OG_RPC_URL, OG_CHAIN_ID, {
    batchMaxCount: 1, staticNetwork: true,
  });
  const poster = new Wallet(POSTER_PRIVATE_KEY!, provider);
  const escrow = new Contract(BLIND_ESCROW_ADDRESS, ESCROW_ABI, provider);
  const usdc = new Contract(USDC_ADDRESS, USDC_ABI, provider);
  const usdcDecimals = Number(await usdc.decimals());

  // Pre-flight: backend up
  const health = await fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(5000) });
  if (!health.ok) { console.error(c.red(`backend /health returned ${health.status}`)); process.exit(1); }

  // Total bounty needed
  const totalBounty = SCENARIOS.reduce((sum, s) => sum + parseFloat(s.bountyUsdc), 0);
  const posterUsdc = parseFloat(formatUnits(await usdc.balanceOf(poster.address), usdcDecimals));
  const posterAogi = parseFloat(formatEther(await provider.getBalance(poster.address)));
  if (posterUsdc < totalBounty) {
    console.log(c.yellow(`  poster needs ${totalBounty} USDC, has ${posterUsdc} — minting…`));
    const usdcAsPoster = new Contract(USDC_ADDRESS, USDC_ABI, poster);
    const tx = await usdcAsPoster.mint(poster.address, parseUnits(String(totalBounty + 10), usdcDecimals));
    await tx.wait();
  }
  if (posterAogi < 0.005 * SCENARIOS.length) {
    console.error(c.red(`  poster needs at least ${0.005 * SCENARIOS.length} AOGI — has ${posterAogi}`));
    process.exit(1);
  }
  console.log(`  poster: ${poster.address} (${posterAogi.toFixed(3)} AOGI · ${posterUsdc.toFixed(2)} USDC)\n`);

  const posterJWT = mintJWT(poster.address);

  // One-time approval for the whole battery (covers total bounty + headroom)
  const totalBountyWei = SCENARIOS.reduce((sum, s) => sum + parseUnits(s.bountyUsdc, usdcDecimals), 0n);
  const allowance = await usdc.allowance(poster.address, BLIND_ESCROW_ADDRESS);
  if (allowance < totalBountyWei) {
    const usdcAsPoster = new Contract(USDC_ADDRESS, USDC_ABI, poster);
    const tx = await usdcAsPoster.approve(BLIND_ESCROW_ADDRESS, totalBountyWei + parseUnits('100', usdcDecimals));
    await tx.wait();
    console.log(`  ${c.green('✓')} approved USDC allowance for the battery\n`);
  }

  // ── Phase 1: bootstrap each scenario SEQUENTIALLY (poster signs from one
  //    wallet; nonce-sharing means we can't parallelize this side). ───────
  console.log(`Phase 1 · bootstrapping ${SCENARIOS.length} scenarios (sequential — poster side)…\n`);
  const bootstrapped: (Bootstrapped | { error: Error; scenario: Scenario })[] = [];
  for (const s of SCENARIOS) {
    try {
      bootstrapped.push(await bootstrapPosterSide(s, poster, posterJWT, usdcDecimals, escrow));
    } catch (e) {
      bootstrapped.push({ error: e as Error, scenario: s });
    }
  }

  // ── Phase 2: agent-side execution CONCURRENTLY (each scenario has its
  //    own executor wallet with its own nonce sequence). ──────────────────
  console.log(`\nPhase 2 · running agent-side flow concurrently…\n`);
  const results = await Promise.all(
    bootstrapped.map((b) => {
      if ('error' in b) {
        return Promise.resolve<Result>({
          scenario: b.scenario.name, ok: false, expected: b.scenario.expect, actual: 'bootstrap_failed',
          notes: b.error.message?.slice(0, 200), elapsedSec: 0,
        });
      }
      return runAgentSide(b, escrow, usdc, usdcDecimals).catch((e) => ({
        scenario: b.scenario.name, ok: false, expected: b.scenario.expect, actual: 'EXCEPTION',
        notes: (e as Error).message?.slice(0, 200), elapsedSec: (Date.now() - b.t0) / 1000,
      }) as Result);
    }),
  );

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log('\n');
  console.log(c.bold('═══════════════════════════════════════════════════════════════════'));
  console.log(c.bold('  Battery summary'));
  console.log(c.bold('═══════════════════════════════════════════════════════════════════'));
  console.log('');
  console.log('  scenario          expected         actual            payout    elapsed   verdict');
  console.log('  ' + '─'.repeat(83));
  for (const r of results) {
    const verdict = r.ok ? c.green('PASS') : c.red('FAIL');
    const elapsed = `${r.elapsedSec.toFixed(1)}s`.padStart(7);
    const payout = (r.payoutUsdc ?? '—').toString().padStart(6);
    const expected = r.expected.padEnd(16);
    const actual = r.actual.padEnd(16);
    console.log(`  ${r.scenario.padEnd(18)}${expected} ${actual} ${payout}   ${elapsed}   ${verdict}`);
    if (r.notes) console.log(c.dim(`    note: ${r.notes}`));
  }
  console.log('');
  const pass = results.filter((r) => r.ok).length;
  const total = results.length;
  const overall = pass === total ? c.green(c.bold(`  ${pass}/${total} PASSED · battery green`))
    : c.red(c.bold(`  ${pass}/${total} passed · battery has failures`));
  console.log(overall);
  console.log('');
  process.exit(pass === total ? 0 : 1);
}

main().catch((e) => { console.error(c.red('[fatal]'), e); process.exit(1); });
