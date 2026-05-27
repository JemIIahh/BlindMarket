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
import { createHash, randomBytes, createECDH, createCipheriv, createDecipheriv, hkdfSync } from 'crypto';
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

// ── Encrypt counterparts — byte-compatible with backend/src/services/crypto.ts
// and frontend/src/lib/crypto.ts. Used by delegate_to_agent to post an
// encrypted sub-task brief the chosen executor can decrypt with the helpers
// above. ──
function genAesKey() {
  return randomBytes(KEY_LENGTH);
}

function aesGcmEncrypt(plaintext, key) {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH });
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]); // [12 iv][16 tag][ciphertext]
}

function eciesEncryptK1(data, recipientPubKeyHex) {
  const ephemeral = createECDH('secp256k1');
  ephemeral.generateKeys();
  const shared = ephemeral.computeSecret(Buffer.from(recipientPubKeyHex, 'hex'));
  const derived = Buffer.from(hkdfSync('sha256', shared, '', ECIES_HKDF_INFO, KEY_LENGTH));
  const blob = aesGcmEncrypt(data, derived);
  return Buffer.concat([ephemeral.getPublicKey(), blob]); // [65 ephemeral pub][aes blob]
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
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

// Derive the uncompressed secp256k1 public key (130 hex chars, leading 04, no
// 0x prefix) from a private key hex. Used so the worker can always supply a
// pubkey at /a2a/register even when AGENT_PUBLIC_KEY isn't injected — the
// backend requires one. Returns '' if no/invalid key so the caller can surface
// a clear error instead of crashing. Format matches the backend ECIES and the
// keypair generated at deploy time (createECDH + uncompressed encoding).
function derivePublicKeyHex(privKeyHex) {
  if (!privKeyHex) return '';
  try {
    const clean = privKeyHex.startsWith('0x') ? privKeyHex.slice(2) : privKeyHex;
    const ecdh = createECDH('secp256k1');
    ecdh.setPrivateKey(Buffer.from(clean, 'hex'));
    return ecdh.getPublicKey('hex', 'uncompressed');
  } catch {
    return '';
  }
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
// /a2a/register so posters can wrap the AES key to it at task creation. The
// backend now REQUIRES this at registration — a pubkey-less executor can't be
// sent a wrapped brief and would spin on NEEDS_WRAP — so we never leave it
// empty: if AGENT_PUBLIC_KEY is unset we derive it from the private key the
// worker already holds. Same curve/format as the backend ECIES and the keypair
// generated at deploy time, so the derived value matches what posters wrap to.
const AGENT_PUBLIC_KEY = process.env.AGENT_PUBLIC_KEY || derivePublicKeyHex(AGENT_PRIVATE_KEY);
const OG_RPC_URL = process.env.OG_RPC_URL ?? 'https://evmrpc-testnet.0g.ai';
const OG_CHAIN_ID = Number(process.env.OG_CHAIN_ID ?? 16602);
const AGENT_TOOLS_RAW = process.env.AGENT_TOOLS ?? '[]';
const AGENT_CAPABILITIES_RAW = process.env.AGENT_CAPABILITIES ?? '[]';
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3001';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 30_000);
// Escrow reward (in 0G) for a sub-task posted via delegate_to_agent, funded
// from THIS agent's own wallet. Fixed default; ops can tune via env. The model
// cannot set it (keeps a weak LLM from over-paying out of the agent's balance).
const DELEGATE_REWARD_OG = process.env.DELEGATE_REWARD_OG ?? '0.0001';
// Native-0G headroom the agent insists on keeping after funding a sub-task, so
// it can still pay gas for its own submitEvidence on the task it's working.
const DELEGATE_GAS_RESERVE_OG = process.env.DELEGATE_GAS_RESERVE_OG ?? '0.005';

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
if (agentCapabilities.length === 0) {
  // Loud warning: an agent reaching this branch means upstream lost its
  // capabilities (a deploy/patch path serialized an empty array). The agent
  // will register as data_processing-only and silently fail to match any
  // task with a different requirement. If you're seeing this in logs, the
  // fix is at the source (agentRunner.updateAgent / deploy form), not here.
  console.warn(`${nowStamp()} [agent:${AGENT_ID.slice(0, 8)}] ⚠ AGENT_CAPABILITIES empty — falling back to ['data_processing']. This usually means the agent was edited via PATCH without resending capabilities. Pick caps on the EDIT tab and save.`);
  agentCapabilities = ['data_processing'];
}

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

  // Standard tool for A2A delegation. Description deliberately discourages
  // spurious use — weaker LLMs reach for "delegate" as a way to defer work
  // they should just do themselves, burning escrow and polluting the task
  // graph with no-op sub-tasks.
  tools.delegate_to_agent = tool({
    description: [
      'Post a real, paid sub-task to another agent on the marketplace.',
      'ONLY use when the current task requires a specialized capability you do not have.',
      'DO NOT use to rephrase, split, or defer work you can do yourself.',
      'Both arguments are REQUIRED — calling with empty or missing arguments is an error.',
      'Costs escrow funds. Prefer doing the task yourself unless delegation is necessary.',
    ].join(' '),
    inputSchema: z.object({
      taskDescription: z.string().min(20).describe('Concrete description of what the sub-agent should do. Must be at least 20 chars and specific enough that another agent could execute it without further context.'),
      requiredCapabilities: z.array(z.string()).min(1).describe('Non-empty list of capability tags the sub-agent must have (e.g., ["web_research"], ["image_analysis"]).'),
    }),
    execute: async (args) => {
      // Defensive validation — the Vercel AI SDK has been observed forwarding
      // tool calls with missing/empty args when the model (Groq, Gemini Flash)
      // skips required-field enforcement. Without this guard, destructuring
      // crashes or posts a malformed sub-task.
      const taskDescription = args?.taskDescription;
      const requiredCapabilities = args?.requiredCapabilities;
      if (typeof taskDescription !== 'string' || taskDescription.trim().length < 20) {
        return 'ERROR: delegate_to_agent requires `taskDescription` (string, ≥20 chars). You called it with missing or empty arguments. Either supply both required arguments or complete the task yourself without delegating.';
      }
      if (!Array.isArray(requiredCapabilities) || requiredCapabilities.length === 0) {
        return 'ERROR: delegate_to_agent requires `requiredCapabilities` (non-empty string array). Either supply at least one capability tag or complete the task yourself.';
      }
      if (!signerWallet) {
        return 'ERROR: cannot delegate — this agent has no signer (AGENT_PRIVATE_KEY unset), so it cannot fund a sub-task escrow. Complete the task yourself.';
      }

      // A delegated sub-task is a real, encrypted, escrow-funded marketplace
      // task (the executor receives work only via an encrypted brief, and the
      // accept→submit→verify→settle path is on-chain). This headlessly mirrors
      // the human PostTask flow: encrypt → 0G Storage → wrap to executors →
      // createTask (funded from THIS agent's wallet) → verified index → poll.
      const auth = { 'Authorization': `Bearer ${AGENT_PLATFORM_TOKEN}` };
      const jsonAuth = { 'Content-Type': 'application/json', ...auth };
      try {
        const NATIVE = '0x0000000000000000000000000000000000000000';
        const rewardWei = ethers.parseEther(String(DELEGATE_REWARD_OG));
        const reserveWei = ethers.parseEther(String(DELEGATE_GAS_RESERVE_OG));

        // Balance guard — don't post a sub-task we can't fund without starving
        // our own gas. Skip cleanly so the model just completes the task itself.
        const balance = await signerWallet.provider.getBalance(signerWallet.address);
        if (balance < rewardWei + reserveWei) {
          return `Delegation skipped: wallet balance ${ethers.formatEther(balance)} 0G is below reward ${DELEGATE_REWARD_OG} + gas reserve ${DELEGATE_GAS_RESERVE_OG} 0G. Complete the task yourself.`;
        }

        // 1. Encrypt the brief; taskHash = sha256(ciphertext) (same as PostTask).
        const aesKey = genAesKey();
        const ciphertext = aesGcmEncrypt(Buffer.from(taskDescription, 'utf8'), aesKey);
        const taskHash = '0x' + sha256Hex(ciphertext);

        // 2. Upload the encrypted blob to 0G Storage.
        const upRes = await fetchWithTimeout(`${BACKEND_URL}/api/v1/storage/upload`, {
          method: 'POST', headers: jsonAuth,
          body: JSON.stringify({ data: ciphertext.toString('base64') }),
        });
        if (!upRes.ok) return `Delegation failed: storage upload ${upRes.status}`;
        const rootHash = (await upRes.json()).data?.rootHash;
        if (!rootHash) return 'Delegation failed: storage upload returned no rootHash';

        // 3. Wrap the AES key to every matching executor registered right now.
        //    Agents that register later use the existing bid/NEEDS_WRAP path.
        const capsQS = encodeURIComponent(requiredCapabilities.join(','));
        const exRes = await fetchWithTimeout(`${BACKEND_URL}/api/v1/a2a/executors?capabilities=${capsQS}`, { headers: auth });
        const executors = exRes.ok ? ((await exRes.json()).data?.executors ?? []) : [];
        const wrappedKeys = {};
        for (const ex of executors) {
          if (!ex.publicKey) continue;
          try {
            wrappedKeys[ex.address.toLowerCase()] = eciesEncryptK1(aesKey, ex.publicKey).toString('hex');
          } catch (e) {
            log(`delegate: skip wrap for ${ex.address} (${e.message})`);
          }
        }
        if (Object.keys(wrappedKeys).length === 0) {
          log(`delegate: no matching executor registered for [${requiredCapabilities.join(',')}] — sub-task will sit until one registers`);
        }

        // 4. Build the createTask tx server-side, then sign + broadcast it from
        //    this agent's wallet (funds the escrow with native 0G).
        const buildRes = await fetchWithTimeout(`${BACKEND_URL}/api/v1/tasks`, {
          method: 'POST', headers: jsonAuth,
          body: JSON.stringify({
            taskHash, token: NATIVE, amount: rewardWei.toString(),
            category: 'delegated', locationZone: 'global', duration: '3600',
          }),
        });
        if (!buildRes.ok) return `Delegation failed: createTask build ${buildRes.status} ${(await buildRes.text()).slice(0, 120)}`;
        const unsignedTx = (await buildRes.json()).data?.unsignedTx;
        if (!unsignedTx) return 'Delegation failed: createTask returned no unsignedTx';

        const sent = await signerWallet.sendTransaction(unsignedTx);
        log(`delegate: createTask broadcast ${sent.hash} for sub-task ${taskHash.slice(0, 10)}…`);
        const receipt = await sent.wait();
        if (!receipt || receipt.status !== 1) return `Delegation failed: createTask tx reverted (${sent.hash})`;

        // 5. Verified meta write (re-parses the receipt + TaskCreated event).
        const idxRes = await fetchWithTimeout(`${BACKEND_URL}/api/v1/a2a/tasks/index`, {
          method: 'POST', headers: jsonAuth,
          body: JSON.stringify({
            txHash: receipt.hash, taskHash,
            verificationMode: 'auto', verificationCriteria: { min_length: 10 },
            requiredCapabilities, rootHash, wrappedKeys,
          }),
        });
        if (!idxRes.ok) return `Delegation failed: index ${idxRes.status} ${(await idxRes.text()).slice(0, 120)}`;
        log(`delegate: sub-task ${taskHash.slice(0, 10)}… posted (reward ${DELEGATE_REWARD_OG} 0G, wrapped to ${Object.keys(wrappedKeys).length} executor(s))`);

        // 6. Poll our own posted-tasks inbox for the outcome. We're the poster,
        //    so /tasks/posted carries this sub-task's state + resultData.
        const target = taskHash.toLowerCase();
        const maxWait = 120_000;
        const start = Date.now();
        while (Date.now() - start < maxWait) {
          await sleep(5000);

          // Late-bidder wrap loop — the agent-runtime equivalent of the
          // frontend's useBidWatcher. An agent that registered AFTER we posted
          // can't decrypt the brief (it wasn't in the post-time wrap), so it
          // hits NEEDS_WRAP and bids. We still hold the AES key, so we wrap it
          // to each new bidder ourselves — no platform custody, no human
          // browser. Best-effort: a failure here must not abort the wait.
          try {
            const bRes = await fetchWithTimeout(`${BACKEND_URL}/api/v1/a2a/tasks/${taskHash}/bids`, { headers: auth });
            if (bRes.ok) {
              const bd = (await bRes.json()).data ?? {};
              const alreadyWrapped = new Set((bd.wrapped ?? []).map((a) => a.toLowerCase()));
              const additions = {};
              for (const bid of (bd.bids ?? [])) {
                const addr = (bid.address ?? '').toLowerCase();
                if (!addr || !bid.publicKey || alreadyWrapped.has(addr)) continue;
                try {
                  additions[addr] = eciesEncryptK1(aesKey, bid.publicKey).toString('hex');
                } catch (e) {
                  log(`delegate: skip late-wrap for ${addr} (${e.message})`);
                }
              }
              if (Object.keys(additions).length > 0) {
                const wRes = await fetchWithTimeout(`${BACKEND_URL}/api/v1/a2a/tasks/${taskHash}/wrap-to`, {
                  method: 'POST', headers: jsonAuth, body: JSON.stringify({ wrappedKeys: additions }),
                });
                log(`delegate: wrapped ${Object.keys(additions).length} late bidder(s) on ${taskHash.slice(0, 10)}… (${wRes.ok ? 'ok' : wRes.status})`);
              }
            }
          } catch (e) {
            log(`delegate: late-bidder wrap poll error on ${taskHash.slice(0, 10)}…: ${e.message}`);
          }

          const pRes = await fetchWithTimeout(`${BACKEND_URL}/api/v1/a2a/tasks/posted`, { headers: auth });
          if (!pRes.ok) continue;
          const posted = (await pRes.json()).data?.tasks ?? [];
          const t = posted.find((x) => (x.meta?.taskId ?? '').toLowerCase() === target);
          if (!t) continue;
          if (t.state?.status === 'verified') {
            return `Sub-agent completed task ${taskHash.slice(0, 10)}…: ${JSON.stringify(t.state.resultData)}`;
          }
          if (t.state?.status === 'failed') {
            return `Sub-agent task ${taskHash.slice(0, 10)}… failed: ${JSON.stringify(t.state.verificationResult?.reasons ?? [])}`;
          }
        }
        return `Delegated sub-task ${taskHash.slice(0, 10)}… is posted and funded but no agent completed it within 120s. It stays open on the marketplace; the reward escrow remains locked until an agent completes it or the deadline passes.`;
      } catch (e) {
        return `Delegation error: ${e.message}`;
      }
    },
  });

  for (const t of agentTools) {
    // Sanitize tool name: Groq/OpenAI require ^[a-zA-Z0-9_]{1,64}$
    const safeName = t.name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64);
    
    if (t.type === 'http') {
      tools[safeName] = tool({
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
      tools[safeName] = tool({
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
      tools[safeName] = tool({
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

// Revert an accepted task back to 'open' on the backend so other agents
// (or this one on the next poll) can pick it up. Called whenever the worker
// fails to push the task forward — /submit retries exhausted, missing
// signer, or submitEvidence broadcast giving up. Without this, the task is
// stuck in Redis state 'accepted'/'submitted' while on-chain it's still
// Funded with no worker — invisible on the agent board, irrecoverable.
//
// Retries on 503 (e.g. ON_CHAIN_CHECK_FAILED when the RPC is briefly
// unreachable). Terminal non-503 errors are logged and abandoned — the
// poster can always rescue with a manual /release call.
async function releaseTask(taskHash) {
  const RELEASE_MAX_ATTEMPTS = 4;
  const RELEASE_RETRY_DELAY_MS = 8_000;
  for (let attempt = 1; attempt <= RELEASE_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetchWithTimeout(`${BACKEND_URL}/api/v1/a2a/tasks/${taskHash}/release`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${AGENT_PLATFORM_TOKEN}` },
      });
      if (res.ok) {
        log(`released ${taskHash.slice(0, 10)}… back to open`);
        appliedTasks.delete(taskHash);
        return;
      }
      const errText = await res.text().catch(() => '');
      if (res.status === 503 && attempt < RELEASE_MAX_ATTEMPTS) {
        log(`release attempt ${attempt}/${RELEASE_MAX_ATTEMPTS} for ${taskHash.slice(0, 10)}…: 503 — retrying in ${RELEASE_RETRY_DELAY_MS / 1000}s`);
        await sleep(RELEASE_RETRY_DELAY_MS);
        continue;
      }
      log(`release failed for ${taskHash.slice(0, 10)}… after ${attempt} attempt(s): ${res.status} ${errText.slice(0, 120)}`);
      return;
    } catch (e) {
      if (attempt < RELEASE_MAX_ATTEMPTS) {
        log(`release attempt ${attempt}/${RELEASE_MAX_ATTEMPTS} for ${taskHash.slice(0, 10)}…: network error ${e.message} — retrying in ${RELEASE_RETRY_DELAY_MS / 1000}s`);
        await sleep(RELEASE_RETRY_DELAY_MS);
        continue;
      }
      log(`release error for ${taskHash.slice(0, 10)}… after ${attempt} attempt(s): ${e.message}`);
      return;
    }
  }
}

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
      // Include the backend's message so the user can self-diagnose without
      // grepping source. For CAPABILITY_MISMATCH specifically, also surface
      // this agent's own caps so the gap is obvious — the most common
      // misread of these logs is "the matcher is broken" when the agent
      // simply doesn't have any of the task's required capabilities.
      const errMsg = err.error?.message ? ` — ${err.error.message}` : '';
      let extra = '';
      if (acceptRes.status === 403 && err.error?.code === 'CAPABILITY_MISMATCH') {
        extra = ` (this agent has: ${agentCapabilities.join(',')})`;
      }
      log(`accept failed for ${taskHash.slice(0, 10)}…: ${acceptRes.status} ${err.error?.code || ''}${errMsg}${extra}`);

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
        system: `[IDENTITY]\n${AGENT_INSTRUCTIONS}\n\n[CAPABILITIES]\nYou have access to tools. If you use a tool, you must synthesize the results into a final text summary for the user. Do not simply output the raw tool result.`,
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
    // Retry the /submit call on transient backend-side gates:
    //   - 503 NOT_INDEXED      → TaskCreated event hasn't been indexed yet
    //   - 503 NOT_ASSIGNED_YET → marketplaceAssign tx hasn't confirmed yet
    // Both heal on their own within tens of seconds; bailing immediately
    // discards the LLM result and strands the task in accepted-but-unsubmittable.
    const SUBMIT_API_MAX_ATTEMPTS = 6;
    const SUBMIT_API_RETRY_DELAY_MS = 8_000;
    let submitRes;
    for (let attempt = 1; attempt <= SUBMIT_API_MAX_ATTEMPTS; attempt++) {
      submitRes = await fetchWithTimeout(`${BACKEND_URL}/api/v1/a2a/tasks/${acceptedTaskHash}/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${AGENT_PLATFORM_TOKEN}`,
        },
        body: JSON.stringify({ resultData }),
      }, 60_000); // backend may poll up to ~20s waiting for assignment confirmation
      if (submitRes.ok) break;
      const errText = await submitRes.text();
      // BRIDGE_FAILED is terminal — settleAssignment died on the backend
      // (signer revert, bridge disabled, indexer lost the event). Retrying
      // /submit won't help; the on-chain task.worker will never move.
      // Release immediately so another /accept can re-fire the bridge from
      // scratch.
      if (submitRes.status === 503 && /BRIDGE_FAILED/.test(errText)) {
        log(`submit aborted for ${acceptedTaskHash.slice(0, 10)}…: backend reports BRIDGE_FAILED — ${errText.slice(0, 200)}`);
        await releaseTask(acceptedTaskHash);
        return;
      }
      const isTransient = submitRes.status === 503 && /NOT_INDEXED|NOT_ASSIGNED_YET/.test(errText);
      if (isTransient && attempt < SUBMIT_API_MAX_ATTEMPTS) {
        const code = /NOT_ASSIGNED_YET/.test(errText) ? 'NOT_ASSIGNED_YET' : 'NOT_INDEXED';
        log(`submit attempt ${attempt}/${SUBMIT_API_MAX_ATTEMPTS} for ${acceptedTaskHash.slice(0, 10)}…: 503 ${code} — retrying in ${SUBMIT_API_RETRY_DELAY_MS / 1000}s`);
        await sleep(SUBMIT_API_RETRY_DELAY_MS);
        continue;
      }
      log(`submit failed for ${acceptedTaskHash.slice(0, 10)}… after ${attempt} attempt(s): ${submitRes.status} ${errText.slice(0, 160)}`);
      await releaseTask(acceptedTaskHash);
      return;
    }
    if (!submitRes || !submitRes.ok) {
      await releaseTask(acceptedTaskHash);
      return;
    }
    const submitJson = await submitRes.json();
    const unsignedSubmitEvidence = submitJson.data?.unsignedSubmitEvidence;
    if (!unsignedSubmitEvidence) {
      log(`submit response missing unsignedSubmitEvidence for ${acceptedTaskHash.slice(0, 10)}…`);
      await releaseTask(acceptedTaskHash);
      return;
    }

    if (!signerWallet) {
      log(`cannot broadcast submitEvidence: signer not initialised (missing AGENT_PRIVATE_KEY)`);
      await releaseTask(acceptedTaskHash);
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
        await releaseTask(acceptedTaskHash);
        return;
      }
    }
    if (!broadcastOk) {
      await releaseTask(acceptedTaskHash);
      return;
    }

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
  // The backend requires a pubkey at registration. We derive it from the
  // private key when the env var is missing, so this should only ever be empty
  // if the worker was started with neither — in which case it can't decrypt
  // encrypted briefs anyway. Fail loudly instead of POSTing an invalid body.
  if (!AGENT_PUBLIC_KEY) {
    log('cannot register as A2A executor: no public key available (set AGENT_PUBLIC_KEY or AGENT_PRIVATE_KEY). Encrypted tasks require a pubkey to wrap the brief to.');
    return;
  }
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
        publicKey: AGENT_PUBLIC_KEY,
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
