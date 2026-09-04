import { Router } from 'express';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { AGENT_CAPABILITIES, LLM_PROVIDER_MODELS, LLM_MODEL_IDS } from '../types.js';
import type { AuthRequest } from '../types.js';
import { requireAuth } from '../middleware/auth.js';
import {
  deployAgent, startAgent, pauseAgent, stopAgent, resumeAgent,
  getAgent, listAgents, getAgentLogs, subscribeAgentLogs, updateAgent,
  addAuthorizedOwner, getAgentStats,
} from '../services/agentRunner.js';
import * as reputationService from '../services/reputation.js';
import * as reputationDecay from '../services/reputationDecay.js';
import * as agentStore from '../services/agentStore.js';
import * as serviceStore from '../services/serviceStore.js';
import { isAgentOwner, stripAgentSecrets } from '../services/agentOwnership.js';
import * as skillStore from '../services/skillStore.js';
import * as agentEmbedding from '../services/agentEmbedding.js';
import { buildInstalledSkill, assertComposedSizeOk } from '../services/skillComposer.js';
import type { InstalledSkill, AgentCapability } from '../types.js';
import { redis } from '../services/redis.js';
import { ethers } from 'ethers';
import { provider, baseProvider } from '../services/chain.js';
import { config } from '../config.js';

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
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Owner authentication required' } });
    return null;
  }
  const agent = await getAgent(agentId);
  if (!agent) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Agent not found' } });
    return null;
  }

  // Check ALL linked wallets, not just the primary one — users often have
  // multiple wallets in the same Privy account (e.g. embedded + external).
  // Owner set = the original wagmi deploy wallet plus any signature-linked
  // wallets (authorizedOwners). The latter unlocks the common case where the
  // wallet captured at deploy isn't the Privy identity the JWT surfaces — the
  // user proves control of the owner wallet once via POST /:id/link-owner and
  // their Privy identity is added here.
  const isOwner = isAgentOwner(agent, [authed, ...(req.user?.addresses ?? [])]);

  if (!isOwner) {
    // JWT's first wallet entry isn't guaranteed to be the one used at deploy.
    // Truncated for log brevity; both are public blockchain addresses so no
    // privacy concern.
    const tr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
    res.status(403).json({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: `Only the agent owner can perform this action. You are signed in as ${tr(authed)} but this agent's owner is ${tr(agent.ownerAddress)}. Make sure the owner wallet is linked in your Privy account.`,
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

// Per-chain config for the withdraw endpoint. An agent's wallet is a plain
// EOA — the same address is valid on 0G and Base — so it can hold a balance
// on either (or both) depending on which chain its tasks settled on.
// Base's gasReserve/nativeGasMin are conservative starting estimates (ETH is
// priced very differently from the 0G token, and these haven't been
// calibrated against real observed Base gas costs yet) — same spirit as
// MAINNET-CHECKLIST.md §3.2's own admission that its 0G gas estimate needs
// recalibration. Recheck before Base mainnet launch.
const WITHDRAW_CHAINS = {
  '0g': {
    rpc: provider,
    nativeLabel: '0G',
    gasReserve: ethers.parseEther('0.001'),
    nativeGasMin: ethers.parseEther('0.0002'),
  },
  base: {
    rpc: baseProvider,
    nativeLabel: 'ETH',
    gasReserve: ethers.parseEther('0.0003'),
    nativeGasMin: ethers.parseEther('0.00005'),
  },
} as const;

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
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']),
    headers: z.array(z.object({
      // Accept both "name" (backend) and "key" (frontend) for backward compat
      name: z.string().min(1).optional(),
      key: z.string().min(1).optional(),
      value: z.string().min(1),
      isSensitive: z.boolean().default(false),
    })).optional().transform(arr => arr?.map(h => ({
      name: h.name ?? h.key ?? '',
      value: h.value,
      isSensitive: h.isSensitive,
    }))),
    queryParams: z.array(z.object({
      name: z.string().min(1),
      value: z.string().min(1),
    })).optional(),
    body: z.object({
      contentType: z.enum(['application/json', 'application/x-www-form-urlencoded']).default('application/json'),
      payload: z.string().optional(),
    }).optional(),
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
  z.object({
    type: z.literal('sandbox'),
    name: z.string().min(1),
    description: z.string().default(''),
    command: z.string().min(1),
    setup: z.string().optional(),
    timeout: z.number().int().min(1).max(600).optional(),
  }),
  z.object({
    type: z.literal('tool'),
    name: z.string().min(1),
    description: z.string().default(''),
    input_schema: z.object({
      type: z.literal('object'),
      properties: z.record(z.object({
        type: z.string().default('string'),
        description: z.string().optional(),
        enum: z.array(z.string()).optional(),
        default: z.unknown().optional(),
      })),
      required: z.array(z.string()).optional(),
    }),
    execution: z.object({
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
      url: z.string().min(1),
      param_mapping: z.record(z.string()),
    }),
    auth: z.object({
      type: z.enum(['query_param', 'header', 'bearer', 'none']),
      key_name: z.string().default(''),
      secret_ref: z.string().default(''),
    }),
  }),
]);

const DeploySchema = z.object({
  ownerAddress: z.string().min(1),
  ownerPublicKey: z.string()
    .regex(/^[0-9a-fA-F]{64,512}$/, 'Must be a hex-encoded public key (64-512 hex chars)')
    .transform(k => {
      // Normalize: strip leading 00 (Ed25519 flag byte) or 01 (secp256k1 flag byte)
      // 65 bytes (130 hex, starts with 04) = secp256k1 uncompressed → keep as-is
      // 33 bytes (66 hex, starts with 00) = Ed25519 with flag → strip 00
      // 34 bytes (68 hex, starts with 01) = secp256k1 with flag → strip 01
      // 32 bytes (64 hex) = raw Ed25519 → keep as-is
      if (k.length === 66 && k.startsWith('00')) return k.slice(2);
      if (k.length === 68 && k.startsWith('01')) return k.slice(2);
      return k;
    }),
  name: z.string().min(1).max(80),
  instructions: z.string().min(1),
  provider: z.enum(PROVIDERS),
  model: z.string().min(1),
  apiKey: z.string().optional().default(''),
  // An agent with no capabilities can never accept a task that declares
  // requiredCapabilities — the /a2a/accept handler 403s with CAPABILITY_MISMATCH.
  // Deploying with caps=[] produces an agent that looks "running" but is a no-op,
  // which is the worst UX. At least one capability is required AFTER unioning
  // in the installed skills' tags (checked in the handler), so an agent can be
  // deployed from skills alone.
  capabilities: z.array(z.enum(AGENT_CAPABILITIES as unknown as [string, ...string[]])).default([]),
  tools: z.array(ToolSchema).default([]),
  toolSecrets: z.record(z.string()).default({}),
  storageRef: z.string().optional(),
  // Skills to install at deploy — resolved to frozen snapshots SERVER-SIDE
  // (clients send slugs, never snapshots).
  skillSlugs: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/)).max(10).default([]),
});

function strip(agent: Awaited<ReturnType<typeof getAgent>>) {
  return stripAgentSecrets(agent);
}

// GET /api/v1/agents/providers
agentsRouter.get('/providers', (_req, res) => {
  res.json({
    success: true,
    data: {
      models: LLM_MODEL_IDS,     // flat string[] per provider (backward compat)
      pricing: LLM_PROVIDER_MODELS, // full ModelInfo[] with costs
    },
  });
});

// POST /api/v1/agents/deploy
agentsRouter.post('/deploy', async (req, res, next) => {
  try {
    const parsed = DeploySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, error: parsed.error.flatten() }); return; }
    console.log(`[deploy] ownerPublicKey length=${parsed.data.ownerPublicKey.length / 2} bytes, hex=${parsed.data.ownerPublicKey.slice(0, 8)}...`);

    // Resolve skill slugs → frozen snapshots (server-side only). Deploy is an
    // unauthenticated route, so only PUBLIC skills are installable here —
    // private drafts install via the authed POST /:id/skills after deploy.
    const { skillSlugs, ...deployParams } = parsed.data;
    const skills: InstalledSkill[] = [];
    // Dedupe: a crafted request could repeat a slug and duplicate its
    // [SKILL:] section in the composed prompt (the UI prevents this).
    for (const slug of [...new Set(skillSlugs)]) {
      const row = await skillStore.getSkillBySlug(slug);
      if (!row || !row.is_public) {
        res.status(404).json({ success: false, error: { code: 'SKILL_NOT_FOUND', message: `No public skill "${slug}"` } });
        return;
      }
      skills.push(buildInstalledSkill(row));
    }
    if (skills.length > 0) {
      assertComposedSizeOk(parsed.data.instructions, skills, parsed.data.tools as never);
    }
    // Union the skills' routing tags into the declared capabilities.
    const capabilities = [...new Set([
      ...parsed.data.capabilities,
      ...skills.flatMap((s) => s.capabilities),
    ])] as (typeof parsed.data.capabilities);

    const agent = await deployAgent({
      ...deployParams,
      capabilities,
      skills: skills.length ? skills : undefined,
    } as Parameters<typeof deployAgent>[0]);

    // Popularity counters — best-effort, never blocks the deploy.
    for (const s of skills) void skillStore.incrementInstallCount(s.skillId).catch(() => {});

    res.status(201).json({ success: true, data: strip(agent) });
  } catch (err) {
    // deployAgent can now throw (e.g. a bad ownerPublicKey that fails ECIES wrap);
    // surface it as a clean error instead of an unhandled promise rejection.
    next(err);
  }
});

// GET /api/v1/agents
agentsRouter.get('/', async (req, res) => {
  const owner = req.query.owner as string | undefined;
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20));
  const rawAgents = await listAgents(owner);
  const total = rawAgents.length;
  const start = (page - 1) * pageSize;
  const paged = rawAgents.slice(start, start + pageSize);
  const enriched = await Promise.all(paged.map(async a => {
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
  res.json({ success: true, data: enriched.filter(Boolean), total });
});

// GET /api/v1/agents/:id/logs/json — buffered log lines (for manual refresh)
//
// Owner-only — gated by requireAuth + authorizeOwner. The worker's stdout is
// captured verbatim into this buffer, so an ungated route here is an
// unauthenticated read of an agent's live activity. See authorizeOwner above.
agentsRouter.get('/:id/logs/json', requireAuth, async (req: AuthRequest, res) => {
  const agent = await authorizeOwner(req, res, req.params.id);
  if (!agent) return;
  const history = await getAgentLogs(req.params.id);
  res.json({ success: true, data: history });
});

// GET /api/v1/agents/:id/logs — SSE stream
//
// Owner-only — gated by requireAuth + authorizeOwner, checked BEFORE any SSE
// header is written/flushed so a 401/403 can still be sent as a clean JSON
// response instead of a broken event stream.
agentsRouter.get('/:id/logs', requireAuth, async (req: AuthRequest, res) => {
  const { id } = req.params;
  const agent = await authorizeOwner(req, res, id);
  if (!agent) return;
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
// Withdraws funds from the agent wallet to the owner. An agent's wallet is a
// plain EOA — the same address on every EVM chain — so it can independently
// hold a balance on 0G (agent infra) and Base (settlement), depending on
// which chain its tasks paid out on. This endpoint checks BOTH chains and
// sweeps whichever have a sweepable balance, rather than requiring the
// caller to know/pick a chain up front.
//
//   Body: { tokenAddress?: string }
//     - omitted / "0x0000...0000"  → sweeps native balance (0G and/or ETH)
//     - any ERC20 address          → sweeps that token balance on whichever
//                                     chain(s) it resolves as a real ERC20
//                                     with a nonzero balance
//
// Response: { data: { swept: [...], skipped: [...] } } — swept has one entry
// per chain actually withdrawn from (0, 1, or 2 entries); skipped explains
// why a chain was passed over (zero balance, insufficient gas, not an ERC20
// there). If swept is empty, responds 409 instead of an empty 200.
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
    // Treat missing or zero address as native sweep.
    const isNative = !rawToken || rawToken === '0x0000000000000000000000000000000000000000';
    if (!isNative && !/^0x[0-9a-fA-F]{40}$/.test(rawToken)) {
      res.status(400).json({ success: false, error: { code: 'BAD_TOKEN', message: 'tokenAddress must be a 0x-prefixed 20-byte hex string' } });
      return;
    }

    const pk = agent.rawPrivateKey.startsWith('0x') ? agent.rawPrivateKey : `0x${agent.rawPrivateKey}`;

    const swept: Array<{
      chain: 'base' | '0g'; txHash: string; asset: string; recipient: string; blockNumber?: number;
      amountSent?: string; amountRaw?: string; amountFormatted?: string; decimals?: number;
    }> = [];
    const skipped: Array<{ chain: 'base' | '0g'; reason: string }> = [];

    // Sequential, not parallel — simpler to reason about and log than two
    // in-flight sweep txs interleaving (nonce spaces are independent per
    // chain so parallel would be safe too, just noisier).
    for (const chain of ['0g', 'base'] as const) {
      const { rpc, nativeLabel, gasReserve, nativeGasMin } = WITHDRAW_CHAINS[chain];
      const wallet = new ethers.Wallet(pk, rpc);

      if (isNative) {
        // ── Native sweep (0G token or ETH depending on chain) ──────────
        const balance = await rpc.getBalance(wallet.address);
        if (balance <= gasReserve) {
          skipped.push({ chain, reason: `balance (${ethers.formatEther(balance)} ${nativeLabel}) is below the gas reserve required to sweep` });
          continue;
        }
        const sendAmount = balance - gasReserve;
        const tx = await wallet.sendTransaction({ to: agent.ownerAddress, value: sendAmount });
        const receipt = await tx.wait();
        swept.push({
          chain,
          txHash: tx.hash,
          asset: nativeLabel,
          amountSent: ethers.formatEther(sendAmount),
          recipient: agent.ownerAddress,
          blockNumber: receipt?.blockNumber,
        });
      } else {
        // ── ERC20 token sweep ──────────────────────────────────────────
        const tokenAddress = rawToken;
        const nativeBalance = await rpc.getBalance(wallet.address);
        if (nativeBalance < nativeGasMin) {
          skipped.push({ chain, reason: `insufficient native ${nativeLabel} to pay for the transfer tx (have ${ethers.formatEther(nativeBalance)}, need ≥${ethers.formatEther(nativeGasMin)}). Top up gas first.` });
          continue;
        }

        const token = new ethers.Contract(tokenAddress, ERC20_TRANSFER_ABI, wallet);
        let balance: bigint;
        try {
          balance = await token.balanceOf(wallet.address);
        } catch {
          skipped.push({ chain, reason: `${tokenAddress} does not appear to be an ERC20 token on this chain — balanceOf returned empty data` });
          continue;
        }
        if (balance === 0n) {
          skipped.push({ chain, reason: 'no balance of that token to withdraw on this chain' });
          continue;
        }

        const tx = await token.transfer(agent.ownerAddress, balance);
        const receipt = await tx.wait();

        let decimals = 6;
        try { decimals = Number(await token.decimals()); } catch {}
        const whole = balance / 10n ** BigInt(decimals);
        const frac = (balance % 10n ** BigInt(decimals)).toString().padStart(decimals, '0');

        swept.push({
          chain,
          txHash: tx.hash,
          asset: tokenAddress,
          amountRaw: balance.toString(),
          amountFormatted: `${whole}.${frac}`,
          decimals,
          recipient: agent.ownerAddress,
          blockNumber: receipt?.blockNumber,
        });
      }
    }

    if (swept.length === 0) {
      res.status(409).json({
        success: false,
        error: {
          code: isNative ? 'BALANCE_TOO_LOW' : 'ZERO_BALANCE',
          message: 'Nothing to withdraw on either chain.',
          skipped,
        },
      });
      return;
    }

    res.json({ success: true, data: { swept, skipped } });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: { code: 'WITHDRAW_FAILED', message: (err as Error).message },
    });
  }
});

// ── Owner-link (signature-gated recovery) ─────────────────────────────────
//
// Recovers the "deployed with one wallet, authenticated as another" lock-out:
// agents bind ownership to the wagmi-connected wallet captured at deploy
// (DeployAgentForm), but start/stop/withdraw authorize against the Privy JWT
// identity (authorizeOwner). When those differ — e.g. the user logged into
// Privy with an embedded/email wallet but deployed while an external wallet
// was the active wagmi connector — the owner is 403'd off their own agent.
//
// This flow lets the AUTHENTICATED caller add their current Privy identity to
// the agent's authorizedOwners allowlist, but ONLY after proving control of
// the ORIGINAL owner wallet by signing a server-issued, single-use,
// agent-scoped nonce. Requiring a signature recovered to the recorded
// ownerAddress (not merely any authed wallet) is what stops this from being an
// agent-takeover vector.

const LINK_NONCE_TTL_S = 10 * 60; // 10 minutes
const linkNonceKey = (agentId: string, nonce: string) => `agent:linkowner:${agentId}:${nonce}`;
const buildLinkMessage = (authedAddr: string, agentId: string, nonce: string) =>
  `BlindMarket: authorize wallet ${authedAddr.toLowerCase()} to manage agent ${agentId}.\n\n` +
  `Sign with the agent's current owner wallet to confirm. Nonce: ${nonce}`;

// POST /api/v1/agents/:id/link-owner/challenge
// The authenticated caller (the wallet to be authorized) requests a nonce and
// the exact message the CURRENT owner wallet must sign.
agentsRouter.post('/:id/link-owner/challenge', requireAuth, async (req: AuthRequest, res) => {
  const authed = req.user?.address;
  if (!authed || authed === 'agent') {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Owner authentication required' } });
    return;
  }
  const agent = await getAgent(req.params.id);
  if (!agent) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Agent not found' } });
    return;
  }
  const nonce = randomBytes(16).toString('hex');
  // Bind the nonce to the requesting identity so a challenge issued to one
  // wallet can't be completed by another.
  await redis.set(linkNonceKey(agent.id, nonce), authed.toLowerCase(), 'EX', LINK_NONCE_TTL_S);
  res.json({
    success: true,
    data: {
      nonce,
      message: buildLinkMessage(authed, agent.id, nonce),
      ownerAddress: agent.ownerAddress,
      authorizeAddress: authed,
    },
  });
});

// POST /api/v1/agents/:id/link-owner
// Body: { nonce, signature }. The signature must recover to the agent's
// CURRENT ownerAddress (proof of control of the deploy wallet). On success the
// authenticated caller's address is appended to authorizedOwners.
agentsRouter.post('/:id/link-owner', requireAuth, async (req: AuthRequest, res) => {
  const authed = req.user?.address;
  if (!authed || authed === 'agent') {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Owner authentication required' } });
    return;
  }
  const agent = await getAgent(req.params.id);
  if (!agent) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Agent not found' } });
    return;
  }
  const { nonce, signature } = (req.body ?? {}) as { nonce?: string; signature?: string };
  if (!nonce || !signature) {
    res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'nonce and signature required' } });
    return;
  }
  const nKey = linkNonceKey(agent.id, nonce);
  const boundTo = await redis.get(nKey);
  if (!boundTo) {
    res.status(400).json({ success: false, error: { code: 'NONCE_INVALID', message: 'Challenge expired or already used — request a new one' } });
    return;
  }
  if (boundTo.toLowerCase() !== authed.toLowerCase()) {
    res.status(403).json({ success: false, error: { code: 'NONCE_MISMATCH', message: 'This challenge was issued to a different wallet' } });
    return;
  }
  let recovered: string;
  try {
    recovered = ethers.verifyMessage(buildLinkMessage(authed, agent.id, nonce), signature).toLowerCase();
  } catch (err) {
    console.error('[agents] link-owner EVM verify error:', err);
    res.status(400).json({ success: false, error: { code: 'BAD_SIGNATURE', message: 'Signature could not be verified' } });
    return;
  }
  if (recovered !== agent.ownerAddress.toLowerCase()) {
    const tr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
    res.status(403).json({
      success: false,
      error: {
        code: 'NOT_OWNER_SIGNATURE',
        message: `Signature must come from the current owner wallet ${tr(agent.ownerAddress)} — you signed with ${tr(recovered)}. Switch your active wallet to the owner wallet and try again.`,
      },
    });
    return;
  }
  // Single-use: consume the nonce now that it has been validated.
  await redis.del(nKey);
  const updated = await addAuthorizedOwner(agent.id, authed);
  console.log(`[agents] link-owner: ${authed.toLowerCase()} authorized on ${agent.id} (proven by owner ${agent.ownerAddress.toLowerCase()})`);
  res.json({
    success: true,
    data: { authorizedOwners: updated?.authorizedOwners ?? [], authorizedAddress: authed.toLowerCase() },
  });
});

// PATCH /api/v1/agents/:id
//
// Owner-only edit (instructions / model / tools / capabilities). Hardened from
// the previous plaintext `body.ownerAddress` claim — which anyone could satisfy
// with the agent's (public) owner address — to requireAuth + authorizeOwner,
// matching start/stop/withdraw. This also makes it honor the authorizedOwners
// allowlist so a signature-linked wallet can edit too.
agentsRouter.patch('/:id', requireAuth, async (req: AuthRequest, res) => {
  const agent = await authorizeOwner(req, res, req.params.id);
  if (!agent) return;
  const { instructions, model, tools, capabilities, minReward } = req.body as {
    instructions?: string; model?: string; tools?: object[]; capabilities?: string[]; minReward?: string;
  };
  const updated = await updateAgent(req.params.id, { instructions, model, tools: tools as any, capabilities: capabilities as any, minReward });
  // Semantic matching (Phase 0): instructions/capabilities changed — re-embed.
  if (updated) agentEmbedding.recomputeForWalletBestEffort(updated.walletAddress);
  res.json({ success: true, data: strip(updated) });
});

// ── Agent Services (rent-your-agent Phase 1) ────────────────────────────────
// Owner-managed CRUD for an agent's priced service listings. Public browse/detail
// live on the marketplace router. Every route is owner-gated via authorizeOwner;
// mutations are additionally guarded by agent_address in the store so the owner of
// one agent can't touch another agent's services (cross-agent tamper → 404).

const serviceSchema = z.object({
  name: z.string().min(5).max(60),
  description: z.string().max(2000).optional().default(''),
  priceRaw: z.string().regex(/^\d+$/, 'priceRaw must be a wei integer string'),
  serviceType: z.enum(['api', 'a2a']),
  active: z.boolean().optional().default(true),
});
// No defaults here — an absent field in a PATCH must stay undefined (skipped),
// not get reset to a default.
const serviceUpdateSchema = z.object({
  name: z.string().min(5).max(60).optional(),
  description: z.string().max(2000).optional(),
  priceRaw: z.string().regex(/^\d+$/, 'priceRaw must be a wei integer string').optional(),
  serviceType: z.enum(['api', 'a2a']).optional(),
  active: z.boolean().optional(),
});

function parseServiceId(req: AuthRequest, res: import('express').Response): number | null {
  const id = Number(req.params.serviceId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'Invalid service id' } });
    return null;
  }
  return id;
}

// GET /api/v1/agents/:id/services — owner view (all, including inactive)
agentsRouter.get('/:id/services', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const agent = await authorizeOwner(req, res, req.params.id);
    if (!agent) return;
    res.json({ success: true, data: await serviceStore.listOwnerServices(agent.walletAddress) });
  } catch (err) { next(err); }
});

// POST /api/v1/agents/:id/services
agentsRouter.post('/:id/services', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const agent = await authorizeOwner(req, res, req.params.id);
    if (!agent) return;
    const data = serviceSchema.parse(req.body);
    const service = await serviceStore.createService({
      agentAddress: agent.walletAddress,
      ownerAddress: agent.ownerAddress, // canonical owner, never from the body
      name: data.name,
      description: data.description,
      priceRaw: data.priceRaw,
      serviceType: data.serviceType,
      active: data.active,
    });
    res.status(201).json({ success: true, data: service });
  } catch (err) { next(err); }
});

// PATCH /api/v1/agents/:id/services/:serviceId
agentsRouter.patch('/:id/services/:serviceId', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const agent = await authorizeOwner(req, res, req.params.id);
    if (!agent) return;
    const serviceId = parseServiceId(req, res);
    if (serviceId === null) return;
    const patch = serviceUpdateSchema.parse(req.body);
    const updated = await serviceStore.updateService(serviceId, agent.walletAddress, {
      name: patch.name,
      description: patch.description,
      price_raw: patch.priceRaw,
      service_type: patch.serviceType,
      active: patch.active,
    });
    if (!updated) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Service not found for this agent' } });
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
});

// DELETE /api/v1/agents/:id/services/:serviceId
agentsRouter.delete('/:id/services/:serviceId', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const agent = await authorizeOwner(req, res, req.params.id);
    if (!agent) return;
    const serviceId = parseServiceId(req, res);
    if (serviceId === null) return;
    const ok = await serviceStore.deleteService(serviceId, agent.walletAddress);
    if (!ok) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Service not found for this agent' } });
      return;
    }
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

// ── Skills (install/remove — Phase 1 of the skills system) ──────────────────
// Deliberately NOT part of the generic PATCH: a stale client resending the
// whole form could silently wipe skills (the documented PATCH hazard in
// agentRunner.updateAgent). Dedicated verbs keep installs additive/auditable.

// POST /api/v1/agents/:id/skills  { slug } — install one skill (snapshot).
agentsRouter.post('/:id/skills', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const agent = await authorizeOwner(req, res, req.params.id);
    if (!agent) return;
    const { slug } = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/) }).parse(req.body);
    const row = await skillStore.getSkillBySlug(slug);
    // Private drafts are installable by their author only; 404 (not 403) so
    // draft existence isn't probeable.
    const callerAddrs = [req.user?.address, ...(req.user?.addresses ?? [])]
      .filter((a): a is string => typeof a === 'string').map((a) => a.toLowerCase());
    if (!row || (!row.is_public && !callerAddrs.includes(row.author_address))) {
      res.status(404).json({ success: false, error: { code: 'SKILL_NOT_FOUND', message: `No installable skill "${slug}"` } });
      return;
    }
    if (agent.skills?.some((s) => s.slug === row.slug)) {
      res.status(409).json({ success: false, error: { code: 'ALREADY_INSTALLED', message: 'This skill is already installed — remove it first to update to a newer version' } });
      return;
    }
    const snapshot = buildInstalledSkill(row);
    // Post-deploy install has no channel to collect this skill's secrets (only
    // the deploy form's SkillPicker does). Installing a secret-bearing skill
    // here would ship tools whose auth resolves to nothing — silent upstream
    // 401s with no fix but redeploy. Refuse loudly until a secrets endpoint
    // lands (tracked follow-up); such skills can still be added at deploy time.
    if (snapshot.secretRefs.length > 0) {
      res.status(400).json({
        success: false,
        error: {
          code: 'SKILL_NEEDS_SECRETS',
          message: `"${row.slug}" needs secrets (${snapshot.secretRefs.join(', ')}) that can only be provided when deploying an agent. Install it via the deploy form, or redeploy with it selected.`,
        },
      });
      return;
    }
    const skills: InstalledSkill[] = [...(agent.skills ?? []), snapshot];
    assertComposedSizeOk(agent.instructions, skills, agent.tools);
    const capabilities = [...new Set([...(agent.capabilities ?? []), ...snapshot.capabilities])] as AgentCapability[];
    const updated = await updateAgent(agent.id, { skills, capabilities });
    void skillStore.incrementInstallCount(row.id).catch(() => {});
    // Semantic matching (Phase 0): the agent's doc changed — re-embed.
    agentEmbedding.recomputeForWalletBestEffort(agent.walletAddress);
    res.json({
      success: true,
      data: {
        agent: strip(updated),
        // A running worker keeps its spawn-time composition — the new skill
        // takes effect on the next (re)start.
        requiresRestart: agent.status === 'running',
      },
    });
  } catch (err) { next(err); }
});

// DELETE /api/v1/agents/:id/skills/:slug — remove an installed skill.
// Capabilities are NOT auto-shrunk: they may have been declared manually and
// removing routing tags behind the owner's back could strand matching.
agentsRouter.delete('/:id/skills/:slug', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const agent = await authorizeOwner(req, res, req.params.id);
    if (!agent) return;
    const before = agent.skills ?? [];
    const skills = before.filter((s) => s.slug !== req.params.slug);
    if (skills.length === before.length) {
      res.status(404).json({ success: false, error: { code: 'NOT_INSTALLED', message: 'This skill is not installed on the agent' } });
      return;
    }
    const updated = await updateAgent(agent.id, { skills });
    // Semantic matching (Phase 0): removing a skill changes the agent's doc.
    agentEmbedding.recomputeForWalletBestEffort(agent.walletAddress);
    res.json({
      success: true,
      data: { agent: strip(updated), requiresRestart: agent.status === 'running' },
    });
  } catch (err) { next(err); }
});

// GET /api/v1/agents/:id
agentsRouter.get('/:id', async (req, res) => {
  // The marketplace links agents by WALLET ADDRESS while MyAgents links by
  // agent id — resolve both, or every Browse-agents click 404s for visitors.
  let agent = await getAgent(req.params.id);
  if (!agent && /^0x[0-9a-fA-F]{40}$/.test(req.params.id)) {
    const needle = req.params.id.toLowerCase();
    agent = (await listAgents()).find((a) => a.walletAddress?.toLowerCase() === needle);
  }
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

// POST /api/v1/agents/:id/restart
// Convenience: stop then start in one call. Same auth as stop/start.
agentsRouter.post('/:id/restart', requireAuth, async (req: AuthRequest, res) => {
  try {
    const agent = await authorizeOwner(req, res, req.params.id);
    if (!agent) return;
    await stopAgent(req.params.id);
    await startAgent(req.params.id);
    res.json({ success: true, data: await buildActionResponse(req.params.id) });
  } catch (e: unknown) {
    res.status(400).json({
      success: false,
      error: { code: 'AGENT_ACTION_FAILED', message: (e as Error).message },
    });
  }
});

// GET /api/v1/agents/:id/stats
// Live CPU + RSS data from the OS for a running agent. No auth — visible to
// anyone who can view the agent detail page (the frontend chart component).
agentsRouter.get('/:id/stats', async (req, res) => {
  try {
    const stats = await getAgentStats(req.params.id);
    if (!stats) {
      res.status(404).json({ error: 'Agent not running or not found' });
      return;
    }
    res.json({ success: true, data: stats });
  } catch (e: unknown) {
    res.status(500).json({
      success: false,
      error: { code: 'STATS_FAILED', message: (e as Error).message },
    });
  }
});

// POST /api/v1/agents/:id/resume
// Send SIGCONT to a paused agent. Owner-only, like pause/stop/start/restart.
agentsRouter.post('/:id/resume', requireAuth, async (req: AuthRequest, res) => {
  try {
    const agent = await authorizeOwner(req, res, req.params.id);
    if (!agent) return;
    await resumeAgent(req.params.id);
    res.json({ success: true, data: await buildActionResponse(req.params.id) });
  } catch (e: unknown) {
    res.status(400).json({
      success: false,
      error: { code: 'AGENT_ACTION_FAILED', message: (e as Error).message },
    });
  }
});
