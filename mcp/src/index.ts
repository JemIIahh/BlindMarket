#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BlindMarket } from '@blindmarket/sdk';
import type { AgentCapability, TaskContext } from '@blindmarket/sdk';
import { loadConfig } from './config.js';
import { registerMarketTools } from './tools.js';
import { registerRuntimeTools } from './runtime.js';
import { loadWallet, registerWalletTools } from './wallet.js';
import { registerRentTools } from './rent.js';

const cfg = loadConfig();

const bb = new BlindMarket({ apiKey: cfg.apiKey, apiBase: cfg.apiBase });

const server = new McpServer({
  name: 'BlindMarket MCP Server',
  version: '0.2.0',
});

// Register all marketplace tools
registerMarketTools(server, bb);

// Tier-2 spending tools: local wallet + local encryption — trust-preserving
// rent/post through the CURRENT encrypted flow (see rent.ts). Registered even
// without a wallet so tools/list is stable; spends fail cleanly with NO_WALLET.
const walletCtx = loadWallet();
registerWalletTools(server, walletCtx);
registerRentTools(server, cfg, walletCtx);

// Executor runtime tools (runtime_start/stop/…) are GATED OFF by default:
// the SDK WorkerRuntime they wrap predates the current backend shapes — it
// mis-parses the accept response's wrappedKey (string, not record), fetches
// the blob by taskHash instead of rootHash, and never signs submitEvidence
// (onlyWorker on-chain), so its work could never settle. Set
// BLINDMARKET_EXPERIMENTAL_RUNTIME=true to register them anyway. To EARN on
// BlindMarket today, deploy a platform agent (it runs the maintained
// backend/agents/worker.js) and operate it via the remote MCP endpoint's
// start_agent/stop_agent tools.
const RUNTIME_TOOLS_ENABLED = process.env.BLINDMARKET_EXPERIMENTAL_RUNTIME === 'true';

// Register executor runtime tools (reads env config for the runtime)
const runtimeCfg = {
  apiKey: cfg.apiKey,
  apiBase: cfg.apiBase,
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
  console.error('[blindmarket-mcp] ⚠️  experimental runtime tools ENABLED — the underlying WorkerRuntime is stale vs the current backend (broken wrappedKey parse, blob fetch by taskHash, unsigned submitEvidence). Expect tasks to fail to settle.');
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
