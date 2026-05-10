/**
 * Agent worker — forked child process per deployed agent.
 *
 * Env vars (set by agentRunner.ts):
 *   AGENT_ID, AGENT_NAME, AGENT_INSTRUCTIONS
 *   AGENT_PROVIDER, AGENT_MODEL, AGENT_API_KEY
 *   AGENT_TOOLS (JSON array of AgentTool)
 *   BACKEND_URL, POLL_INTERVAL_MS
 *
 * Lifecycle:
 *   1. Poll /api/v1/tasks?status=open (filter by capabilities)
 *   2. Apply to task via /api/v1/applications
 *   3. Wait for assignment (poll task status)
 *   4. Decrypt instructions from 0G Storage
 *   5. Call LLM with tools (HTTP, MCP, JS, A2A delegation)
 *   6. Encrypt evidence, upload to 0G Storage
 *   7. Submit evidence hash on-chain
 *   8. Send heartbeat to parent process
 */

import { generateText, tool } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { z } from 'zod';
import { createHash, randomBytes } from 'crypto';
import { runInNewContext } from 'vm';
import { ethers } from 'ethers';

const AGENT_ID = process.env.AGENT_ID ?? 'unknown';
const AGENT_NAME = process.env.AGENT_NAME ?? 'Agent';
const AGENT_INSTRUCTIONS = process.env.AGENT_INSTRUCTIONS ?? '';
const AGENT_PROVIDER = (process.env.AGENT_PROVIDER ?? 'openai').toLowerCase();
const AGENT_MODEL = process.env.AGENT_MODEL ?? 'gpt-4o-mini';
const AGENT_API_KEY = process.env.AGENT_API_KEY ?? '';
const AGENT_PLATFORM_TOKEN = process.env.AGENT_PLATFORM_TOKEN ?? '';
const AGENT_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY ?? '';
const OG_RPC_URL = process.env.OG_RPC_URL ?? 'https://evmrpc-testnet.0g.ai';
const OG_CHAIN_ID = Number(process.env.OG_CHAIN_ID ?? 16602);
const AGENT_TOOLS_RAW = process.env.AGENT_TOOLS ?? '[]';
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3001';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 30_000);

// Ethers wallet — used to sign + broadcast the unsigned txs the backend builds
// (e.g. submitEvidence). Demo-grade custody: raw key arrives via env from the
// parent agentRunner, which reads it back from Redis. Production should swap
// this for an EIP-712 owner-signed delegation verified on-chain.
let signerWallet = null;
if (AGENT_PRIVATE_KEY) {
  try {
    const provider = new ethers.JsonRpcProvider(OG_RPC_URL, OG_CHAIN_ID);
    signerWallet = new ethers.Wallet(
      AGENT_PRIVATE_KEY.startsWith('0x') ? AGENT_PRIVATE_KEY : `0x${AGENT_PRIVATE_KEY}`,
      provider,
    );
  } catch (e) {
    // intentionally don't throw at import time — we want the agent process to
    // stay alive so logs and heartbeats keep flowing; we surface the failure
    // when we actually try to sign.
    console.error(`[agent:${(process.env.AGENT_ID ?? '').slice(0, 8)}] failed to init signer: ${e.message}`);
  }
}

// Track tasks we've already applied to or are currently working on
const appliedTasks = new Set();

// Exit if parent process disconnects (prevents orphans)
process.on('disconnect', () => {
  log('parent disconnected, exiting');
  process.exit();
});

let agentTools = [];
try {
  agentTools = JSON.parse(AGENT_TOOLS_RAW);
} catch (e) {
  log(`failed to parse AGENT_TOOLS: ${e.message}`);
}

function getModel() {
  switch (AGENT_PROVIDER) {
    case 'anthropic': return createAnthropic({ apiKey: AGENT_API_KEY })(AGENT_MODEL);
    case 'groq':      return createGroq({ apiKey: AGENT_API_KEY })(AGENT_MODEL);
    case 'gemini':    return createGoogleGenerativeAI({ apiKey: AGENT_API_KEY })(AGENT_MODEL);
    default:          return createOpenAI({ apiKey: AGENT_API_KEY })(AGENT_MODEL);
  }
}

log(`started | provider=${AGENT_PROVIDER} model=${AGENT_MODEL} tools=${agentTools.length}`);

// ── Tool builders ────────────────────────────────────────────────────────────

function buildTools() {
  const tools = {};

  // Built-in: A2A delegation
  tools.delegate_to_agent = tool({
    description: 'Delegate a sub-task to another agent on the marketplace. Returns the result when the agent completes it.',
    parameters: z.object({
      taskDescription: z.string().describe('What the agent should do'),
      requiredCapabilities: z.array(z.string()).describe('Required agent capabilities (e.g., ["web_research", "summarization"])'),
    }),
    execute: async ({ taskDescription, requiredCapabilities }) => {
      try {
        // Create A2A task
        const createRes = await fetch(`${BACKEND_URL}/api/v1/a2a/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            description: taskDescription,
            requiredCapabilities,
            verificationMode: 'auto',
            verificationCriteria: { min_length: 10 },
          }),
        });
        if (!createRes.ok) return { error: `Failed to create A2A task: ${createRes.status}` };
        const { data: task } = await createRes.json();

        // Poll until verified or failed (max 2 minutes)
        const maxWait = 120_000;
        const start = Date.now();
        while (Date.now() - start < maxWait) {
          await sleep(5000);
          const statusRes = await fetch(`${BACKEND_URL}/api/v1/a2a/tasks/${task.taskId}`);
          if (!statusRes.ok) break;
          const { data: state } = await statusRes.json();
          if (state.status === 'verified') {
            return { success: true, result: state.resultData };
          }
          if (state.status === 'failed') {
            return { error: 'Agent failed to complete task', reasons: state.verificationResult?.reasons };
          }
        }
        return { error: 'Timeout waiting for agent' };
      } catch (e) {
        return { error: e.message };
      }
    },
  });

  // Custom tools from AGENT_TOOLS
  for (const t of agentTools) {
    if (t.type === 'http') {
      tools[t.name] = tool({
        description: t.description,
        parameters: z.object({ input: z.string() }),
        execute: async ({ input }) => {
          try {
            const url = t.url.replace(/\{(\w+)\}/g, () => encodeURIComponent(input));
            const body = t.bodyTemplate ? t.bodyTemplate.replace(/\{\{(\w+)\}\}/g, () => input) : undefined;
            const res = await fetch(url, {
              method: t.method,
              headers: { 'Content-Type': 'application/json', ...t.headers },
              body: body ? JSON.stringify(JSON.parse(body)) : undefined,
            });
            return { status: res.status, data: await res.text() };
          } catch (e) {
            return { error: e.message };
          }
        },
      });
    } else if (t.type === 'mcp') {
      tools[t.name] = tool({
        description: t.description,
        parameters: z.object({ input: z.string() }),
        execute: async ({ input }) => {
          try {
            const res = await fetch(t.endpointUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tool: t.toolName, input }),
            });
            return await res.json();
          } catch (e) {
            return { error: e.message };
          }
        },
      });
    } else if (t.type === 'js') {
      tools[t.name] = tool({
        description: t.description,
        parameters: z.object({ input: z.string() }),
        execute: async ({ input }) => {
          try {
            const fn = runInNewContext(`(function(input) { ${t.code} })`, { console }, { timeout: 5000 });
            return { result: fn(input) };
          } catch (e) {
            return { error: e.message };
          }
        },
      });
    }
  }

  return tools;
}

// ── Main loop ────────────────────────────────────────────────────────────────
//
// Flow (against the /a2a endpoints — drives the settlement bridge end-to-end):
//   1. GET  /a2a/tasks                       → browse open agent-targeted tasks
//   2. POST /a2a/tasks/:hash/accept          → bridge fires marketplaceAssign
//   3. Wait briefly for the on-chain assign to confirm (so submit doesn't revert)
//   4. Run the LLM with the task instructions, produce a result object
//   5. POST /a2a/tasks/:hash/submit          → backend returns unsignedSubmitEvidence
//   6. Sign + broadcast submitEvidence with the agent's own wallet
//   7. POST /a2a/tasks/:hash/finalize        → backend auto-verifies (if mode=auto)
//                                              and fires settleVerification, OR returns
//                                              awaitingPosterApproval (mode=manual)
//
// `appliedTasks` (kept from before, just relabeled) is an in-process dedup so
// we don't try the same task twice in a single worker run.

async function pollAndWork() {
  try {
    sendHeartbeat();

    // 1. Browse open A2A-targeted tasks
    const url = `${BACKEND_URL}/api/v1/a2a/tasks`;
    log(`polling ${url}...`);
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${AGENT_PLATFORM_TOKEN}` },
    });
    if (!res.ok) {
      const errText = await res.text();
      log(`poll failed: ${res.status} ${errText.slice(0, 80)}`);
      return;
    }

    const json = await res.json();
    const entries = json.data?.tasks;
    if (!Array.isArray(entries)) {
      log(`unexpected /a2a/tasks shape: ${Object.keys(json.data || {}).join(', ')}`);
      return;
    }
    if (entries.length === 0) {
      log('no open A2A tasks');
      return;
    }

    // Each entry is { meta, state }. meta.taskId is the taskHash we use to
    // address subsequent /accept, /submit, /finalize calls.
    const available = entries.filter(e => !appliedTasks.has(e.meta.taskId));
    if (available.length === 0) {
      log(`found ${entries.length} open tasks, but already touched all of them`);
      return;
    }

    // 2. Accept the first one we can. /accept fails with 403/409 if caps don't
    //    match or state changed under us — try the next.
    let acceptedTaskHash = null;
    let acceptedEntry = null;
    for (const entry of available) {
      const taskHash = entry.meta.taskId;
      log(`accepting task ${taskHash.slice(0, 10)}…`);
      const acceptRes = await fetch(`${BACKEND_URL}/api/v1/a2a/tasks/${taskHash}/accept`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${AGENT_PLATFORM_TOKEN}`,
        },
      });
      if (acceptRes.ok) {
        appliedTasks.add(taskHash);
        acceptedTaskHash = taskHash;
        acceptedEntry = entry;
        break;
      }
      const err = await acceptRes.json().catch(() => ({}));
      log(`accept failed for ${taskHash.slice(0, 10)}…: ${acceptRes.status} ${err.error?.code || ''}`);
      // Skip-and-continue on common terminal errors; bail on others.
      if (acceptRes.status === 403 || acceptRes.status === 409) {
        appliedTasks.add(taskHash);
        continue;
      }
      return;
    }

    if (!acceptedTaskHash) {
      log(`could not accept any of the ${available.length} available tasks`);
      return;
    }

    // 3. Wait briefly for the bridge's marketplaceAssign to confirm on chain.
    //    Without this, submitEvidence broadcasts before the contract status is
    //    Assigned and would revert. 0G blocks are ~6s; 12s gives a comfortable
    //    margin without making the loop too slow.
    log(`waiting for on-chain assignment to confirm for ${acceptedTaskHash.slice(0, 10)}…`);
    await sleep(12_000);

    // 4. Run the LLM. The result is an object so it shapes cleanly to the
    //    submit endpoint's `resultData: Record<string, unknown>` schema and
    //    plays well with autoVerify criteria like `min_length` (which operates
    //    on JSON.stringify of the object).
    const category = acceptedEntry.meta.targetExecutorType === 'agent'
      ? (acceptedEntry.meta.requiredCapabilities?.join(', ') || 'general')
      : 'general';
    log(`working on task ${acceptedTaskHash.slice(0, 10)}…`);
    const { text } = await generateText({
      model: getModel(),
      system: AGENT_INSTRUCTIONS,
      prompt: `Task: ${acceptedTaskHash}\nCapabilities required: ${category}\n\nProduce a result.`,
      tools: buildTools(),
      maxSteps: 5,
    });
    const resultData = { output: text, agent: AGENT_ID };

    // 5. POST /submit — backend persists resultData and returns the unsigned
    //    submitEvidence tx for us to sign.
    log(`submitting task ${acceptedTaskHash.slice(0, 10)}…`);
    const submitRes = await fetch(`${BACKEND_URL}/api/v1/a2a/tasks/${acceptedTaskHash}/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AGENT_PLATFORM_TOKEN}`,
      },
      body: JSON.stringify({ resultData }),
    });
    if (!submitRes.ok) {
      const errText = await submitRes.text();
      log(`submit failed for ${acceptedTaskHash.slice(0, 10)}…: ${submitRes.status} ${errText.slice(0, 160)}`);
      return;
    }
    const submitJson = await submitRes.json();
    const unsignedSubmitEvidence = submitJson.data?.unsignedSubmitEvidence;
    if (!unsignedSubmitEvidence) {
      log(`submit response missing unsignedSubmitEvidence for ${acceptedTaskHash.slice(0, 10)}…`);
      return;
    }

    // 6. Sign + broadcast submitEvidence with the agent's own wallet (the
    //    contract requires onlyWorker for this call — the marketplace signer
    //    can't do it). Wait for the receipt so finalize has a real Submitted
    //    state to verify against.
    if (!signerWallet) {
      log(`cannot broadcast submitEvidence: signer not initialised (missing AGENT_PRIVATE_KEY)`);
      return;
    }
    try {
      const sent = await signerWallet.sendTransaction(unsignedSubmitEvidence);
      log(`submitEvidence broadcast for ${acceptedTaskHash.slice(0, 10)}…: ${sent.hash}`);
      const receipt = await sent.wait();
      log(`submitEvidence confirmed for ${acceptedTaskHash.slice(0, 10)}…: block=${receipt?.blockNumber} status=${receipt?.status}`);
    } catch (e) {
      log(`submitEvidence broadcast failed for ${acceptedTaskHash.slice(0, 10)}…: ${e.shortMessage ?? e.message}`);
      return;
    }

    // 7. Finalize — tells the backend to run autoVerify (auto mode) or hand
    //    off to manual approval (manual mode). For auto, the bridge then fires
    //    completeVerification and the escrow releases automatically.
    log(`finalizing task ${acceptedTaskHash.slice(0, 10)}…`);
    const finalizeRes = await fetch(`${BACKEND_URL}/api/v1/a2a/tasks/${acceptedTaskHash}/finalize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AGENT_PLATFORM_TOKEN}`,
      },
    });
    if (!finalizeRes.ok) {
      const errText = await finalizeRes.text();
      log(`finalize failed: ${finalizeRes.status} ${errText.slice(0, 160)}`);
      return;
    }
    const finalizeJson = await finalizeRes.json();
    log(`finalize result for ${acceptedTaskHash.slice(0, 10)}…: ${JSON.stringify(finalizeJson.data)}`);
  } catch (err) {
    log(`error: ${err.message}`);
  }
}

function sendHeartbeat() {
  if (process.send) {
    process.send({ type: 'heartbeat', timestamp: Date.now() });
  }
}

function log(msg) {
  const dim = '\x1b[2m', cyan = '\x1b[36m', reset = '\x1b[0m';
  console.log(`${dim}[agent:${cyan}${AGENT_ID.slice(0, 8)}${reset}${dim}]${reset} ${msg}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

setInterval(pollAndWork, POLL_INTERVAL_MS);
pollAndWork();
