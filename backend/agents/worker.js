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
import { createHash, randomBytes, createECDH, createDecipheriv, hkdfSync } from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname as pathDirname, join as pathJoin } from 'path';
import { runInNewContext } from 'vm';
import { ethers } from 'ethers';

// ── ECIES + AES decrypt helpers — byte-compatible with backend/src/services/crypto.ts
// and frontend/src/lib/crypto.ts. Used to unwrap the AES key the poster wrapped
// to our pubkey at task-creation time, then decrypt the brief blob from 0G Storage.
const ECIES_PUBKEY_LENGTH = 65;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const ECIES_HKDF_INFO = 'BlindMarket-ECIES-v1';

function aesGcmDecrypt(blob, key) {
  if (blob.length < IV_LENGTH + TAG_LENGTH) throw new Error('AES blob too short');
  const iv = blob.subarray(0, IV_LENGTH);
  const tag = blob.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ct = blob.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function eciesDecryptK1(blob, privKeyHex) {
  if (blob.length < ECIES_PUBKEY_LENGTH + IV_LENGTH + TAG_LENGTH) {
    throw new Error('ECIES blob too short');
  }
  const ephPub = blob.subarray(0, ECIES_PUBKEY_LENGTH);
  const aesBlob = blob.subarray(ECIES_PUBKEY_LENGTH);
  const ecdh = createECDH('secp256k1');
  const clean = privKeyHex.startsWith('0x') ? privKeyHex.slice(2) : privKeyHex;
  ecdh.setPrivateKey(Buffer.from(clean, 'hex'));
  const shared = ecdh.computeSecret(ephPub);
  const aesKey = Buffer.from(hkdfSync('sha256', shared, '', ECIES_HKDF_INFO, KEY_LENGTH));
  return aesGcmDecrypt(aesBlob, aesKey);
}

const AGENT_ID = process.env.AGENT_ID ?? 'unknown';
const AGENT_NAME = process.env.AGENT_NAME ?? 'Agent';
const AGENT_INSTRUCTIONS = process.env.AGENT_INSTRUCTIONS ?? '';
const AGENT_PROVIDER = (process.env.AGENT_PROVIDER ?? 'openai').toLowerCase();
const AGENT_MODEL = process.env.AGENT_MODEL ?? 'gpt-4o-mini';
const AGENT_API_KEY = process.env.AGENT_API_KEY ?? '';
const AGENT_PLATFORM_TOKEN = process.env.AGENT_PLATFORM_TOKEN ?? '';
const AGENT_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY ?? '';
// Uncompressed secp256k1 hex (130 chars, leading 04, no 0x prefix). Sent to
// /a2a/register so posters can wrap the AES key to it at task creation. Empty
// string when missing — register schema treats it as optional and the executor
// just won't be able to decrypt new encrypted-flow tasks until reconfigured.
const AGENT_PUBLIC_KEY = process.env.AGENT_PUBLIC_KEY ?? '';
const OG_RPC_URL = process.env.OG_RPC_URL ?? 'https://evmrpc-testnet.0g.ai';
const OG_CHAIN_ID = Number(process.env.OG_CHAIN_ID ?? 16602);
const AGENT_TOOLS_RAW = process.env.AGENT_TOOLS ?? '[]';
const AGENT_CAPABILITIES_RAW = process.env.AGENT_CAPABILITIES ?? '[]';
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3001';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 30_000);

// ── Logging helpers ──────────────────────────────────────────────────────

function nowStamp() {
  return new Date().toISOString().slice(0, 19) + 'Z';
}

const COLORED = !!process.stdout.isTTY;
const ANSI_DIM   = COLORED ? '\x1b[2m'  : '';
const ANSI_CYAN  = COLORED ? '\x1b[36m' : '';
const ANSI_RESET = COLORED ? '\x1b[0m'  : '';

function log(msg) {
  console.log(
    `${ANSI_DIM}${nowStamp()} [agent:${ANSI_CYAN}${AGENT_ID.slice(0, 8)}${ANSI_RESET}${ANSI_DIM}]${ANSI_RESET} ${msg}`
  );
}

let agentCapabilities = [];
try {
  const parsed = JSON.parse(AGENT_CAPABILITIES_RAW);
  if (Array.isArray(parsed) && parsed.length > 0) agentCapabilities = parsed;
} catch {}
if (agentCapabilities.length === 0) agentCapabilities = ['data_processing'];

let signerWallet = null;
if (AGENT_PRIVATE_KEY) {
  try {
    const provider = new ethers.JsonRpcProvider(OG_RPC_URL, OG_CHAIN_ID);
    signerWallet = new ethers.Wallet(
      AGENT_PRIVATE_KEY.startsWith('0x') ? AGENT_PRIVATE_KEY : `0x${AGENT_PRIVATE_KEY}`,
      provider,
    );
  } catch (e) {
    console.error(`[agent:${(process.env.AGENT_ID ?? '').slice(0, 8)}] failed to init signer: ${e.message}`);
  }
}

let escrowIface = null;
try {
  const abiPath = pathJoin(
    pathDirname(fileURLToPath(import.meta.url)),
    '..',
    'src',
    'abi',
    'BlindEscrow.json',
  );
  escrowIface = new ethers.Interface(JSON.parse(readFileSync(abiPath, 'utf-8')));
} catch (e) {
  console.warn(`[agent] could not load BlindEscrow ABI for revert decoding: ${e.message}`);
}

const TASK_STATUS = ['Funded', 'Assigned', 'Submitted', 'Verified', 'Completed', 'Cancelled', 'Disputed'];

function decodeEscrowRevert(err) {
  if (!escrowIface) return null;
  const data = err?.data ?? err?.info?.error?.data ?? err?.error?.data;
  if (typeof data !== 'string' || !data.startsWith('0x') || data.length < 10) return null;
  try {
    const parsed = escrowIface.parseError(data);
    if (!parsed) return null;
    return { name: parsed.name, args: parsed.args };
  } catch {
    return null;
  }
}

function formatRevert(err) {
  const decoded = decodeEscrowRevert(err);
  if (!decoded) return err.shortMessage ?? err.message ?? String(err);
  if (decoded.name === 'InvalidStatus') {
    const cur = TASK_STATUS[Number(decoded.args[0])] ?? `enum=${decoded.args[0]}`;
    const req = TASK_STATUS[Number(decoded.args[1])] ?? `enum=${decoded.args[1]}`;
    return `InvalidStatus(current=${cur}, required=${req})`;
  }
  return `${decoded.name}()`;
}

function isTransientAssignmentRevert(err) {
  const decoded = decodeEscrowRevert(err);
  if (!decoded) return false;
  if (decoded.name === 'NotWorker') return true;
  if (decoded.name === 'InvalidStatus') {
    const cur = Number(decoded.args[0]);
    return cur === 0; // Funded — assignment not yet recorded on chain
  }
  return false;
}

const appliedTasks = new Set();
const bidPlacedTasks = new Set();

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

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeout = 30000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(id);
  }
}

// ── Tool builders ────────────────────────────────────────────────────────────

function buildTools() {
  const tools = {};

  tools.delegate_to_agent = tool({
    description: 'Delegate a sub-task to another agent on the marketplace. Returns the result when the agent completes it.',
    inputSchema: z.object({
      taskDescription: z.string().describe('What the agent should do'),
      requiredCapabilities: z.array(z.string()).describe('Required agent capabilities (e.g., ["web_research", "summarization"])'),
    }),
    execute: async ({ taskDescription, requiredCapabilities }) => {
      try {
        const createRes = await fetchWithTimeout(`${BACKEND_URL}/api/v1/a2a/tasks`, {
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

        const maxWait = 120_000;
        const start = Date.now();
        while (Date.now() - start < maxWait) {
          await sleep(5000);
          const statusRes = await fetchWithTimeout(`${BACKEND_URL}/api/v1/a2a/tasks/${task.taskId}`);
          if (!statusRes.ok) break;
          const { data: state } = await statusRes.json();
          if (state.status === 'verified') {
            return state.resultData;
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

  for (const t of agentTools) {
    if (t.type === 'http') {
      tools[t.name] = tool({
        description: t.description,
        inputSchema: z.object({ input: z.string() }),
        execute: async ({ input }) => {
          try {
            const url = t.url.replace(/\{(\w+)\}/g, () => encodeURIComponent(input));
            const body = t.bodyTemplate ? t.bodyTemplate.replace(/\{\{(\w+)\}\}/g, () => input) : undefined;
            const res = await fetchWithTimeout(url, {
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
        inputSchema: z.object({ input: z.string() }),
        execute: async ({ input }) => {
          try {
            const res = await fetchWithTimeout(t.endpointUrl, {
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
        inputSchema: z.object({ input: z.string() }),
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

async function pollAndWork() {
  try {
    sendHeartbeat();

    const url = `${BACKEND_URL}/api/v1/a2a/tasks`;
    log(`polling ${url}...`);
    const res = await fetchWithTimeout(url, {
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

    const available = entries.filter(e => !appliedTasks.has(e.meta.taskId));
    if (available.length === 0) {
      log(`found ${entries.length} open tasks, but already touched all of them`);
      return;
    }

    let acceptedTaskHash = null;
    let acceptedEntry = null;
    let acceptedRootHash = null;
    let acceptedWrappedKey = null;

    for (const entry of available) {
      const taskHash = entry.meta.taskId;
      log(`accepting task ${taskHash.slice(0, 10)}…`);
      const acceptRes = await fetchWithTimeout(`${BACKEND_URL}/api/v1/a2a/tasks/${taskHash}/accept`, {
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
        try {
          const acceptJson = await acceptRes.json();
          acceptedRootHash = acceptJson.data?.rootHash ?? null;
          acceptedWrappedKey = acceptJson.data?.wrappedKey ?? null;
        } catch {
          // Non-JSON response body; treat as no brief available.
        }
        break;
      }
      const err = await acceptRes.json().catch(() => ({}));
      log(`accept failed for ${taskHash.slice(0, 10)}…: ${acceptRes.status} ${err.error?.code || ''}`);

      if (acceptRes.status === 403 && err.error?.code === 'NEEDS_WRAP') {
        if (!bidPlacedTasks.has(taskHash)) {
          try {
            const bidRes = await fetchWithTimeout(`${BACKEND_URL}/api/v1/a2a/tasks/${taskHash}/bid`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${AGENT_PLATFORM_TOKEN}`,
              },
            });
            if (bidRes.ok) {
              bidPlacedTasks.add(taskHash);
              log(`bid registered on ${taskHash.slice(0, 10)}… — awaiting wrap`);
            } else {
              const bidErr = await bidRes.json().catch(() => ({}));
              log(`bid failed for ${taskHash.slice(0, 10)}…: ${bidRes.status} ${bidErr.error?.code || ''}`);
              if (bidRes.status === 403 || bidRes.status === 400) {
                appliedTasks.add(taskHash);
              }
            }
          } catch (bidErr) {
            log(`bid network error for ${taskHash.slice(0, 10)}…: ${bidErr.message || bidErr}`);
          }
        }
        continue;
      }

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

    const taskStartedAt = Date.now();

    log(`waiting for on-chain assignment to confirm for ${acceptedTaskHash.slice(0, 10)}…`);
    await sleep(12_000);

    let briefPlaintext = null;
    if (acceptedRootHash && acceptedWrappedKey && AGENT_PRIVATE_KEY) {
      try {
        const wrappedBytes = Buffer.from(acceptedWrappedKey, 'hex');
        const aesKey = eciesDecryptK1(wrappedBytes, AGENT_PRIVATE_KEY);
        log(`unwrapped AES key for ${acceptedTaskHash.slice(0, 10)}… (${aesKey.length} bytes)`);

        const dlRes = await fetchWithTimeout(`${BACKEND_URL}/api/v1/storage/${acceptedRootHash}`, {
          headers: { 'Authorization': `Bearer ${AGENT_PLATFORM_TOKEN}` },
        });
        if (!dlRes.ok) {
          throw new Error(`storage download ${dlRes.status}`);
        }
        const dlJson = await dlRes.json();
        const b64 = dlJson.data?.blob;
        if (!b64) throw new Error('storage response missing blob');
        const ciphertext = Buffer.from(b64, 'base64');
        const plaintext = aesGcmDecrypt(ciphertext, aesKey);
        briefPlaintext = plaintext.toString('utf8');
        log(`decrypted brief for ${acceptedTaskHash.slice(0, 10)}… (${briefPlaintext.length} chars)`);
      } catch (e) {
        log(`brief decrypt failed for ${acceptedTaskHash.slice(0, 10)}…: ${e.message}`);
        return;
      }
    } else {
      log(`no encrypted brief on accept (rootHash=${!!acceptedRootHash} wrappedKey=${!!acceptedWrappedKey}); skipping`);
      return;
    }

    log(`working on task ${acceptedTaskHash.slice(0, 10)}…`);
    log(`LLM prompt: "${briefPlaintext.slice(0, 200)}${briefPlaintext.length > 200 ? '…' : ''}"`);
    const llmStartedAt = Date.now();
    
    let text = '';
    let llmElapsed = '0.0';
    let toolCalls = [];

    try {
      const result = await generateText({
        model: getModel(),
        system: `${AGENT_INSTRUCTIONS}\n\nCRITICAL: You must act as the primary summarization agent. If you use tools (like delegate_to_agent), you MUST incorporate the tool result into your final answer. After all tool interactions are complete, you are required to generate a final, structured summary in the requested format. Do not return empty text or end prematurely.`,
        prompt: briefPlaintext,
        tools: buildTools(),
        maxSteps: 10,
      });
      
      text = result.text;
      llmElapsed = ((Date.now() - llmStartedAt) / 1000).toFixed(1);
      toolCalls = result.toolCalls || [];
      
      log(`LLM finished for ${acceptedTaskHash.slice(0, 10)}… in ${llmElapsed}s (${text.length} chars)`);
      log(`LLM finish reason: ${result.finishReason}`);
      
      if (toolCalls.length > 0) {
        log(`LLM made ${toolCalls.length} tool call(s): ${toolCalls.map(tc => {
            if (!tc) return 'null-tool-call';
            const name = tc.toolName || 'unknown-tool';
            const args = tc.args ? JSON.stringify(tc.args) : 'no-args';
            const argsPreview = args.length > 50 ? args.slice(0, 50) + '…' : args;
            return `${name}(${argsPreview})`;
        }).join(', ')}`);
      }

      if (result.toolResults && result.toolResults.length > 0) {
        log(`LLM received ${result.toolResults.length} tool result(s).`);
        for (const tr of result.toolResults) {
            if (tr.isError) {
                log(`ERROR in tool ${tr.toolName}: ${JSON.stringify(tr.result)}`);
            }
        }
      }

      if (text.length === 0 && toolCalls.length === 0) {
        log(`WARNING: LLM returned an empty string with no tool calls. Final result object: ${JSON.stringify({
          finishReason: result.finishReason,
          usage: result.usage,
          hasToolCalls: toolCalls.length > 0,
          hasToolResults: (result.toolResults || []).length > 0
        })}`);
      } else if (text.length === 0 && toolCalls.length > 0) {
         log(`LLM finished with tool calls, but no text output yet. This is expected if more steps are needed.`);
      } else {
        log(`LLM response: "${text.slice(0, 200)}${text.length > 200 ? '…' : ''}"`);
      }
    } catch (llmErr) {
      log(`LLM ERROR for ${acceptedTaskHash.slice(0, 10)}…: ${llmErr.message}`);
      if (llmErr.stack) log(`LLM Stack: ${llmErr.stack.split('\n').slice(0, 3).join(' | ')}`);
      text = `Error during LLM execution: ${llmErr.message}`;
    }
    
    // Ensure we don't submit a completely empty string which might be
    // misinterpreted as a bug or missing data in the UI.
    const finalOutput = text.trim() || `Task completed by agent ${AGENT_ID} (no text output generated by model).`;
    const resultData = { output: finalOutput, agent: AGENT_ID };

    log(`submitting task ${acceptedTaskHash.slice(0, 10)}…`);
    const submitRes = await fetchWithTimeout(`${BACKEND_URL}/api/v1/a2a/tasks/${acceptedTaskHash}/submit`, {
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

    if (!signerWallet) {
      log(`cannot broadcast submitEvidence: signer not initialised (missing AGENT_PRIVATE_KEY)`);
      return;
    }
    const MAX_SUBMIT_ATTEMPTS = 3;
    const RETRY_DELAY_MS = 6_000;
    let broadcastOk = false;
    for (let attempt = 1; attempt <= MAX_SUBMIT_ATTEMPTS; attempt++) {
      try {
        const sent = await signerWallet.sendTransaction(unsignedSubmitEvidence);
        log(`submitEvidence broadcast for ${acceptedTaskHash.slice(0, 10)}…: ${sent.hash}`);
        const receipt = await sent.wait();
        log(`submitEvidence confirmed for ${acceptedTaskHash.slice(0, 10)}…: block=${receipt?.blockNumber} status=${receipt?.status}`);
        broadcastOk = true;
        break;
      } catch (e) {
        const label = formatRevert(e);
        if (isTransientAssignmentRevert(e) && attempt < MAX_SUBMIT_ATTEMPTS) {
          log(`submitEvidence attempt ${attempt}/${MAX_SUBMIT_ATTEMPTS} for ${acceptedTaskHash.slice(0, 10)}…: ${label} — on-chain assignment not confirmed yet, retrying in ${RETRY_DELAY_MS / 1000}s`);
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        log(`submitEvidence broadcast failed for ${acceptedTaskHash.slice(0, 10)}… after ${attempt} attempt(s): ${label}`);
        return;
      }
    }
    if (!broadcastOk) return;

    log(`finalizing task ${acceptedTaskHash.slice(0, 10)}…`);
    const finalizeRes = await fetchWithTimeout(`${BACKEND_URL}/api/v1/a2a/tasks/${acceptedTaskHash}/finalize`, {
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

    const totalElapsed = ((Date.now() - taskStartedAt) / 1000).toFixed(1);
    log(`task ${acceptedTaskHash.slice(0, 10)}… done in ${totalElapsed}s (LLM ${llmElapsed}s)`);
  } catch (err) {
    log(`error: ${err.message}`);
  }
}

function sendHeartbeat() {
  if (process.send) {
    process.send({ type: 'heartbeat', timestamp: Date.now() });
  }
}

async function ensureRegisteredAsA2AExecutor() {
  try {
    const res = await fetchWithTimeout(`${BACKEND_URL}/api/v1/a2a/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AGENT_PLATFORM_TOKEN}`,
      },
      body: JSON.stringify({
        displayName: AGENT_NAME,
        capabilities: agentCapabilities,
        ...(AGENT_PUBLIC_KEY ? { publicKey: AGENT_PUBLIC_KEY } : {}),
      }),
    });
    if (res.ok) {
      log(`registered as A2A executor (caps=${agentCapabilities.join(',')})`);
    } else {
      const errText = await res.text();
      log(`a2a register failed: ${res.status} ${errText.slice(0, 120)}`);
    }
  } catch (e) {
    log(`a2a register error: ${e.message}`);
  }
}

(async () => {
  await ensureRegisteredAsA2AExecutor();
  setInterval(pollAndWork, POLL_INTERVAL_MS);
  pollAndWork();
})();
