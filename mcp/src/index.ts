#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BlindMarket } from '@blindmarket/sdk';
import type { AgentCapability, TaskContext } from '@blindmarket/sdk';
import { loadConfig } from './config.js';
import { registerMarketTools } from './tools.js';
import { registerRuntimeTools } from './runtime.js';
import { loadWallet, registerWalletTools } from './wallet.js';
import { registerRentTools } from './rent.js';
import type { Settlement } from './settlement.js';

const cfg = loadConfig();

const bb = new BlindMarket({ apiKey: cfg.apiKey, apiBase: cfg.apiBase });

// Version is read from package.json rather than hard-coded: this string is
// what every MCP client displays for the server, and it had drifted to 0.2.0
// while the package shipped as 0.3.1. Same drift class as the README test count
// and the SDK that was republished under an already-used version number.
// Guarded: an unhandled throw here exits before the transport is up, which is
// precisely the CONNECTION_CLOSED-with-no-explanation symptom this file was
// changed to remove. Verified by review — running dist/ with no sibling
// package.json produced an uncaught ENOENT, exit 1, and zero stdout. A normal
// install always ships package.json (npm includes it regardless of `files`),
// so this is a belt for an unusual layout, not an expected path.
let pkgVersion = '0.0.0-unknown';
try {
  pkgVersion = (JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
  ) as { version: string }).version;
} catch {
  console.error('[blindmarket-mcp] could not read package.json for the version string — continuing');
}

const server = new McpServer({
  name: 'BlindMarket MCP Server',
  version: pkgVersion,
});

// Tier-2 spending tools: local wallet + local encryption — trust-preserving
// rent/post through the CURRENT encrypted flow (see rent.ts). Registered even
// without a wallet so tools/list is stable; spends fail cleanly with NO_WALLET.
const walletCtx = loadWallet();

// Register all marketplace tools. They register first (tools/list order is
// unchanged), but register_as_executor/create_agent need rent.ts's settlement
// resolver, which is created just below — hence the late-bound getter.
let resolveSettlement: (() => Promise<Settlement>) | null = null;
registerMarketTools(server, bb, walletCtx, () => resolveSettlement!());

// rent.ts owns settlement discovery (which chain escrow settles on, and so
// whether the local wallet or the Privy relay pays); wallet_status reports it.
const { settlement } = registerRentTools(server, cfg, walletCtx);
resolveSettlement = settlement;
registerWalletTools(server, walletCtx, settlement);

// Executor runtime tools (runtime_start/stop/…) are GATED OFF by default.
// The three bugs this gate used to cite (wrappedKey parsed as a record, blob
// fetched by taskHash, submitEvidence never signed) were fixed long ago; what
// actually kept the SDK WorkerRuntime from ever completing a task was that it
// registered a compressed pubkey from a random wallet (rejected — and the
// executor is the API key's owner anyway), read GET /a2a/tasks entries as flat
// states instead of { meta, state } so it skipped every task, and waited for
// an 'assigned' status that does not exist instead of calling /accept. Those
// are fixed too, but only against stubbed backends — the loop has NOT been run
// end to end against a live one, and it signs locally (no Privy relay), so on
// Base the owner wallet needs its own key here plus ETH for gas. Hence still
// opt-in: BLINDMARKET_EXPERIMENTAL_RUNTIME=true, with BLINDMARKET_PRIVATE_KEY
// (the API key owner's) and an RPC for the settlement chain. The maintained
// path to EARN is a platform agent (backend/agents/worker.js) operated via the
// remote MCP endpoint's start_agent/stop_agent tools; one-off tasks go through
// accept_task → fetch_brief → complete_task.
const RUNTIME_TOOLS_ENABLED = process.env.BLINDMARKET_EXPERIMENTAL_RUNTIME === 'true';

// Register executor runtime tools (reads env config for the runtime)
const runtimeCfg = {
  apiKey: cfg.apiKey,
  apiBase: cfg.apiBase,
  // The executor IS the API key's owner wallet; the runtime decrypts and signs
  // with this key and refuses to start if it is not the owner's.
  privateKey: walletCtx?.wallet.privateKey,
  // The 0G RPC is the one the local wallet was loaded with (the SDK has no
  // fallback RPC); Base is declared only when explicitly configured.
  rpcUrls: { '0g': walletCtx?.rpcUrl, base: process.env.BLINDMARKET_BASE_RPC_URL, arc: process.env.BLINDMARKET_ARC_RPC_URL },
  displayName: process.env.BLINDMARKET_EXECUTOR_NAME ?? 'MCP Executor',
  capabilities: parseCapabilities(process.env.BLINDMARKET_EXECUTOR_CAPABILITIES),
  minReward: process.env.BLINDMARKET_EXECUTOR_MIN_REWARD,
  browseIntervalMs: parseInt(process.env.BLINDMARKET_BROWSE_INTERVAL_MS ?? '15000', 10),
  watchIntervalMs: parseInt(process.env.BLINDMARKET_WATCH_INTERVAL_MS ?? '5000', 10),
  maxConcurrentTasks: parseInt(process.env.BLINDMARKET_MAX_CONCURRENT_TASKS ?? '3', 10),
  executeTask: async (ctx: TaskContext) => {
    // Default: echo back the instructions as the result.
    // Override this by providing BLINDMARKET_EXECUTE_SCRIPT env pointing to a
    // script that receives task JSON on stdin and returns result JSON on stdout.
    const script = process.env.BLINDMARKET_EXECUTE_SCRIPT;
    if (script) {
      return runExternalScript(script, ctx);
    }
    return { output: ctx.instructions };
  },
};

const runtime = RUNTIME_TOOLS_ENABLED ? registerRuntimeTools(server, runtimeCfg).runtime : null;
if (RUNTIME_TOOLS_ENABLED) {
  console.error('[blindmarket-mcp] ⚠️  experimental runtime tools ENABLED — the WorkerRuntime accept/deliver loop is verified against stubbed backends only, signs submitEvidence locally with BLINDMARKET_PRIVATE_KEY (must be the API key owner), and an accept assigns on-chain irrevocably. Watch runtime_status.');
}

// ── Transport ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Boot sanity check: the sk_ key's owner wallet must equal the local funding
  // wallet, or /a2a/tasks/index rejects the post with NOT_TASK_AGENT after the
  // escrow is already funded. Warn loudly up front instead. (stderr only —
  // stdout belongs to the MCP transport.)
  if (walletCtx) {
    try {
      const res = await fetch(`${cfg.apiBase}/api/v1/api-keys/whoami`, {
        headers: { 'X-API-Key': cfg.apiKey },
      });
      const json: any = await res.json().catch(() => ({}));
      const owned: string[] = json?.data?.addresses ?? (json?.data?.address ? [json.data.address] : []);
      if (owned.length > 0) {
        const match = owned.some((a) => a.toLowerCase() === walletCtx.wallet.address.toLowerCase());
        if (!match) {
          console.error(
            `[blindmarket-mcp] ⚠️  WALLET MISMATCH: BLINDMARKET_API_KEY belongs to ${json.data.address}, ` +
            `but BLINDMARKET_PRIVATE_KEY is ${walletCtx.wallet.address}. ` +
            `Escrow funded from this wallet will be REJECTED at indexing (NOT_TASK_AGENT). ` +
            `Mint an API key while signed in with the funding wallet.`,
          );
        } else {
          console.error(`[blindmarket-mcp] wallet ${walletCtx.wallet.address} verified against API key owner`);
        }
      }
    } catch {
      // Older backend without /whoami, or offline — the NOT_TASK_AGENT error
      // message at spend time is the fallback diagnostic.
    }
  }

  // Auto-start runtime if configured
  if (runtime && process.env.BLINDMARKET_AUTO_START === 'true') {
    try {
      await runtime.start();
      console.error('[blindmarket-mcp] Executor runtime auto-started');
    } catch (err) {
      console.error('[blindmarket-mcp] Auto-start failed:', err);
    }
  }
}

main().catch((err) => {
  console.error('[blindmarket-mcp] Fatal:', err);
  process.exit(1);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseCapabilities(raw?: string): AgentCapability[] {
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()) as AgentCapability[];
}

async function runExternalScript(script: string, ctx: unknown): Promise<Record<string, unknown>> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const proc = spawn(script, [], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, TASK_CONTEXT: JSON.stringify(ctx) },
    });
    let output = '';
    proc.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Script exited ${code}`));
      try { resolve(JSON.parse(output)); }
      catch { resolve({ output }); }
    });
    proc.on('error', reject);
  });
}
