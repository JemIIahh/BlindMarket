import { Router } from 'express';
import { z } from 'zod';
import { AGENT_CAPABILITIES, LLM_PROVIDER_MODELS } from '../types.js';
import type { AuthRequest } from '../types.js';
import { requireAuth } from '../middleware/auth.js';
import {
  deployAgent, startAgent, pauseAgent, stopAgent,
  getAgent, listAgents, getAgentLogs, subscribeAgentLogs, updateAgent,
} from '../services/agentRunner.js';
import * as reputationService from '../services/reputation.js';
import * as reputationDecay from '../services/reputationDecay.js';
import * as agentStore from '../services/agentStore.js';
import { ethers } from 'ethers';
import { provider } from '../services/chain.js';

/**
 * Owner-only guard for any agent endpoint that touches funds, keys, or
 * state changes. Compares the authenticated wallet (from requireAuth) to the
 * agent record's owner — no more "ownerAddress in req.body" plaintext claims.
 *
 * Returns the agent record on success, or null after writing a 401/403/404
 * response. Routes should bail immediately when null is returned.
 */
async function authorizeOwner(req: AuthRequest, res: import('express').Response, agentId: string) {
  const authed = req.user?.address;
  if (!authed || authed === 'agent') {
    // 'agent' is the shared platform API key — never the human owner.
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Owner authentication required' } });
    return null;
  }
  const agent = await getAgent(agentId);
  if (!agent) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Agent not found' } });
    return null;
  }
  if (authed.toLowerCase() !== agent.ownerAddress.toLowerCase()) {
    // Surface both addresses so the user can immediately see whether their
    // session resolved to a different wallet than the one that deployed the
    // agent. Common cause: Privy users with multiple linked wallets — the
    // JWT's first wallet entry isn't guaranteed to be the one used at deploy.
    // Truncated for log brevity; both are public blockchain addresses so no
    // privacy concern.
    const tr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
    res.status(403).json({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: `Only the agent owner can perform this action. You are signed in as ${tr(authed)} but this agent's owner is ${tr(agent.ownerAddress)}. If those are both yours, re-link wallets in Privy or sign in with the wallet that originally deployed the agent.`,
        details: {
          authenticatedAs: authed,
          agentOwner: agent.ownerAddress,
        },
      },
    });
    return null;
  }
  return agent;
}

const ERC20_TRANSFER_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
];

export const agentsRouter = Router();

/**
 * 0G raw units (18 decimals) → decimal string.
 */
function formatNativeDecimal(raw: string): string {
  const n = BigInt(raw);
  const whole = (n / 1_000_000_000_000_000_000n).toString();
  const frac = (n % 1_000_000_000_000_000_000n).toString().padStart(18, '0').slice(0, 6);
  return `${whole}.${frac}`;
}

/**
 * Merge the on-chain-executor stats (kept in agentStore keyed by walletAddress)
 * onto a stripped DeployedAgent record. tasksCompleted + totalEarned only live
 * in the executor record.
 */
async function withExecutorStats<T extends { walletAddress?: string }>(stripped: T) {
  if (!stripped.walletAddress) return { ...stripped, tasksCompleted: 0, totalEarned: '0' };
  const exec = await agentStore.getAgent(stripped.walletAddress);
  return {
    ...stripped,
    tasksCompleted: exec?.tasksCompleted ?? 0,
    totalEarned: formatNativeDecimal(exec?.totalEarnedRaw ?? '0'),
  };
}

const PROVIDERS = Object.keys(LLM_PROVIDER_MODELS) as [string, ...string[]];

const ToolSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('http'),
    name: z.string().min(1),
    description: z.string().default(''),
    url: z.string().url(),
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
    headers: z.record(z.string()).optional(),
    bodyTemplate: z.string().optional(),
  }),
  z.object({
    type: z.literal('mcp'),
    name: z.string().min(1),
    description: z.string().default(''),
    endpointUrl: z.string().url(),
    toolName: z.string().min(1),
  }),
  z.object({
    type: z.literal('js'),
    name: z.string().min(1),
    description: z.string().default(''),
    code: z.string().min(1),
  }),
]);

const DeploySchema = z.object({
  ownerAddress: z.string().min(1),
  ownerPublicKey: z.string().regex(/^04[0-9a-fA-F]{128}$/, 'Must be uncompressed secp256k1 pubkey (04 + 128 hex chars)'),
  name: z.string().min(1).max(80),
  instructions: z.string().min(1),
  provider: z.enum(PROVIDERS),
  model: z.string().min(1),
  apiKey: z.string().min(1),
  // An agent with no capabilities can never accept a task that declares
  // requiredCapabilities — the /a2a/accept handler 403s with CAPABILITY_MISMATCH.
  // Deploying with caps=[] produces an agent that looks "running" but is a no-op,
  // which is the worst UX. Require at least one declared capability up front.
  capabilities: z.array(z.string()).min(1, 'Agent must declare at least one capability'),
  tools: z.array(ToolSchema).default([]),
  storageRef: z.string().optional(),
});

function strip(agent: Awaited<ReturnType<typeof getAgent>>) {
  if (!agent) return null;
  const { encryptedPrivateKey: _a, encryptedApiKey: _b, apiKey: _c, rawPrivateKey: _d, ...safe } = agent;
  return safe;
}

// GET /api/v1/agents/providers
agentsRouter.get('/providers', (_req, res) => {
  res.json({ success: true, data: LLM_PROVIDER_MODELS });
});

// POST /api/v1/agents/deploy
agentsRouter.post('/deploy', async (req, res) => {
  const parsed = DeploySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: parsed.error.flatten() }); return; }
  const agent = await deployAgent(parsed.data as Parameters<typeof deployAgent>[0]);
  res.status(201).json({ success: true, data: strip(agent) });
});

// GET /api/v1/agents
agentsRouter.get('/', async (req, res) => {
  const owner = req.query.owner as string | undefined;
  const rawAgents = await listAgents(owner);
  const enriched = await Promise.all(rawAgents.map(async a => {
    const s = strip(a);
    if (!s) return null;
    const [onChain, decayed] = await Promise.all([
      reputationService.getReputationWithScore(a.walletAddress).catch(() => null),
      reputationDecay.getDecayedReputation(a.walletAddress).catch(() => ({
        address: a.walletAddress, rawScore: 0, decayedScore: 0, decayFactor: 1, daysSinceLastTask: null, tasksCompleted: 0, disputes: 0,
      })),
    ]);
    return {
      ...(await withExecutorStats(s)),
      reputation: onChain ?? { address: a.walletAddress, tasksCompleted: 0, avgScore: 0, disputes: 0, disputeRatio: 0, score: 0 },
      decayedReputation: decayed,
    };
  }));
  res.json({ success: true, data: enriched.filter(Boolean) });
});

// GET /api/v1/agents/:id/logs — SSE stream
agentsRouter.get('/:id/logs', async (req, res) => {
  const { id } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send buffered history first
  const history = await getAgentLogs(id);
  history.forEach(line => res.write(`data: ${JSON.stringify(line)}\n\n`));

  // Stream live via Redis pub/sub
  const unsub = await subscribeAgentLogs(id, line => res.write(`data: ${JSON.stringify(line)}\n\n`));
  req.on('close', () => unsub());
});

// GET /api/v1/agents/:id/wallet
agentsRouter.get('/:id/wallet', async (req, res) => {
  const agent = await getAgent(req.params.id);
  if (!agent) { res.status(404).json({ success: false, error: 'Not found' }); return; }
  res.json({ success: true, data: { walletAddress: agent.walletAddress, publicKey: agent.publicKey } });
});

// POST /api/v1/agents/:id/export-key
//
// Returns the encrypted private key for owner backup. Owner-only — gated by
// requireAuth + authorizeOwner instead of the previous plaintext body claim.
agentsRouter.post('/:id/export-key', requireAuth, async (req: AuthRequest, res) => {
  const agent = await authorizeOwner(req, res, req.params.id);
  if (!agent) return;
  res.json({ success: true, data: { agentId: agent.id, walletAddress: agent.walletAddress, encryptedPrivateKey: agent.encryptedPrivateKey } });
});

// POST /api/v1/agents/:id/withdraw
//
// Withdraws funds from the agent wallet to the owner. Handles both native 0G
// and ERC20 tokens in one endpoint.
//
//   Body: { tokenAddress?: string }
//     - omitted / "0x0000...0000"  → sweeps native 0G (gas reserve kept)
//     - any ERC20 address          → sweeps that token balance
//
// Authorization: requireAuth + authorizeOwner (must match agent.ownerAddress).
// Refuses while the agent is running to avoid racing with in-flight txs.
agentsRouter.post('/:id/withdraw', requireAuth, async (req: AuthRequest, res) => {
  try {
    const agent = await authorizeOwner(req, res, req.params.id);
    if (!agent) return;

    if (agent.status === 'running') {
      res.status(409).json({ success: false, error: { code: 'AGENT_RUNNING', message: 'Stop the agent before withdrawing — sweeping a running agent can race with in-flight settlement transactions' } });
      return;
    }
    if (!agent.rawPrivateKey) {
      res.status(409).json({ success: false, error: { code: 'NO_KEY', message: 'Agent has no raw private key on record; cannot sign withdrawal' } });
      return;
    }

    const rawToken = (req.body as { tokenAddress?: string })?.tokenAddress?.trim() || '';
    // Treat missing or zero address as native 0G sweep.
    const isNative = !rawToken || rawToken === '0x0000000000000000000000000000000000000000';

    const wallet = new ethers.Wallet(
      agent.rawPrivateKey.startsWith('0x') ? agent.rawPrivateKey : `0x${agent.rawPrivateKey}`,
      provider,
    );

    if (isNative) {
      // ── Native 0G sweep ──────────────────────────────────────────────
      const balance = await provider.getBalance(wallet.address);
      const GAS_RESERVE = ethers.parseEther('0.001');
      if (balance <= GAS_RESERVE) {
        res.status(409).json({
          success: false,
          error: {
            code: 'BALANCE_TOO_LOW',
            message: `Agent wallet balance (${ethers.formatEther(balance)} 0G) is below the gas reserve required to sweep`,
          },
        });
        return;
      }
      const sendAmount = balance - GAS_RESERVE;
      const tx = await wallet.sendTransaction({ to: agent.ownerAddress, value: sendAmount });
      const receipt = await tx.wait();
      res.json({
        success: true,
        data: {
          txHash: tx.hash,
          asset: '0G',
          amountSent: ethers.formatEther(sendAmount),
          recipient: agent.ownerAddress,
          blockNumber: receipt?.blockNumber,
        },
      });
    } else {
      // ── ERC20 token sweep ────────────────────────────────────────────
      const tokenAddress = rawToken;
      if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
        res.status(400).json({ success: false, error: { code: 'BAD_TOKEN', message: 'tokenAddress must be a 0x-prefixed 20-byte hex string' } });
        return;
      }

      const token = new ethers.Contract(tokenAddress, ERC20_TRANSFER_ABI, wallet);

      const nativeBalance = await provider.getBalance(wallet.address);
      const NATIVE_GAS_MIN = ethers.parseEther('0.0002');
      if (nativeBalance < NATIVE_GAS_MIN) {
        res.status(409).json({ success: false, error: { code: 'NO_GAS', message: `Agent wallet has insufficient native 0G to pay for the transfer tx (have ${ethers.formatEther(nativeBalance)}, need ≥0.0002). Top up gas first.` } });
        return;
      }

      let balance: bigint;
      try {
        balance = await token.balanceOf(wallet.address);
      } catch {
        res.status(400).json({
          success: false,
          error: {
            code: 'NOT_ERC20',
            message: `The address ${tokenAddress} does not appear to be an ERC20 token — balanceOf returned empty data.`,
          },
        });
        return;
      }
      if (balance === 0n) {
        res.status(409).json({ success: false, error: { code: 'ZERO_BALANCE', message: 'Agent wallet has no balance of that token to withdraw' } });
        return;
      }

      const tx = await token.transfer(agent.ownerAddress, balance);
      const receipt = await tx.wait();

      let decimals = 6;
      try { decimals = Number(await token.decimals()); } catch {}
      const whole = balance / 10n ** BigInt(decimals);
      const frac = (balance % 10n ** BigInt(decimals)).toString().padStart(decimals, '0');

      res.json({
        success: true,
        data: {
          txHash: tx.hash,
          asset: tokenAddress,
          amountRaw: balance.toString(),
          amountFormatted: `${whole}.${frac}`,
          decimals,
          recipient: agent.ownerAddress,
          blockNumber: receipt?.blockNumber,
        },
      });
    }
  } catch (err) {
    res.status(500).json({
      success: false,
      error: { code: 'WITHDRAW_FAILED', message: (err as Error).message },
    });
  }
});

// PATCH /api/v1/agents/:id
agentsRouter.patch('/:id', async (req, res) => {
  const agent = await getAgent(req.params.id);
  if (!agent) { res.status(404).json({ success: false, error: 'Not found' }); return; }
  const { ownerAddress, instructions, model, tools, capabilities } = req.body as {
    ownerAddress?: string; instructions?: string; model?: string; tools?: object[]; capabilities?: string[];
  };
  if (!ownerAddress || ownerAddress.toLowerCase() !== agent.ownerAddress.toLowerCase()) {
    res.status(403).json({ success: false, error: 'Forbidden' }); return;
  }
  const updated = await updateAgent(req.params.id, { instructions, model, tools: tools as any, capabilities: capabilities as any });
  res.json({ success: true, data: strip(updated) });
});

// GET /api/v1/agents/:id
agentsRouter.get('/:id', async (req, res) => {
  const agent = await getAgent(req.params.id);
  if (!agent) { res.status(404).json({ success: false, error: 'Not found' }); return; }
  const stripped = strip(agent)!;
  const [onChain, decayed] = await Promise.all([
    reputationService.getReputationWithScore(agent.walletAddress).catch(() => null),
    reputationDecay.getDecayedReputation(agent.walletAddress).catch(() => ({
      address: agent.walletAddress, rawScore: 0, decayedScore: 0, decayFactor: 1, daysSinceLastTask: null, tasksCompleted: 0, disputes: 0,
    })),
  ]);
  res.json({
    success: true,
    data: {
      ...(await withExecutorStats(stripped)),
      reputation: onChain ?? { address: agent.walletAddress, tasksCompleted: 0, avgScore: 0, disputes: 0, disputeRatio: 0, score: 0 },
      decayedReputation: decayed,
    }
  });
});

// Build the same enriched DTO the GET /:id endpoint returns. Used by
// start/pause/stop so their action responses don't drop tasksCompleted +
// totalEarned (the frontend's setAgent overwrites cached state with the
// action response — without enrichment the earnings display resets to $0
// even though Redis is fine; refreshing the page would restore it).
async function buildActionResponse(id: string) {
  const stripped = strip(await getAgent(id));
  if (!stripped) return null;
  return await withExecutorStats(stripped);
}

// POST /api/v1/agents/:id/start
agentsRouter.post('/:id/start', requireAuth, async (req: AuthRequest, res) => {
  try {
    const agent = await authorizeOwner(req, res, req.params.id);
    if (!agent) return;
    await startAgent(req.params.id);
    res.json({ success: true, data: await buildActionResponse(req.params.id) });
  } catch (e: unknown) {
    res.status(400).json({
      success: false,
      error: { code: 'AGENT_ACTION_FAILED', message: (e as Error).message },
    });
  }
});

// POST /api/v1/agents/:id/pause
agentsRouter.post('/:id/pause', requireAuth, async (req: AuthRequest, res) => {
  try {
    const agent = await authorizeOwner(req, res, req.params.id);
    if (!agent) return;
    await pauseAgent(req.params.id);
    res.json({ success: true, data: await buildActionResponse(req.params.id) });
  } catch (e: unknown) {
    res.status(400).json({
      success: false,
      error: { code: 'AGENT_ACTION_FAILED', message: (e as Error).message },
    });
  }
});

// POST /api/v1/agents/:id/stop
agentsRouter.post('/:id/stop', requireAuth, async (req: AuthRequest, res) => {
  try {
    const agent = await authorizeOwner(req, res, req.params.id);
    if (!agent) return;
    await stopAgent(req.params.id);
    res.json({ success: true, data: await buildActionResponse(req.params.id) });
  } catch (e: unknown) {
    res.status(400).json({
      success: false,
      error: { code: 'AGENT_ACTION_FAILED', message: (e as Error).message },
    });
  }
});
