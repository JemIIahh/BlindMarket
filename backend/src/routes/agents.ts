import { Router } from 'express';
import { z } from 'zod';
import { AGENT_CAPABILITIES, LLM_PROVIDER_MODELS } from '../types.js';
import {
  deployAgent, startAgent, pauseAgent, stopAgent,
  getAgent, listAgents, getAgentLogs, subscribeAgentLogs, updateAgent,
} from '../services/agentRunner.js';
import { getDecayedReputation } from '../services/reputationDecay.js';

export const agentsRouter = Router();

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
  const enriched = rawAgents.map(a => {
    const s = strip(a);
    if (!s) return null;
    return {
      ...s,
      reputation: getDecayedReputation(a.walletAddress),
    };
  }).filter(Boolean);
  res.json({ success: true, data: enriched });
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
agentsRouter.post('/:id/export-key', async (req, res) => {
  const agent = await getAgent(req.params.id);
  if (!agent) { res.status(404).json({ success: false, error: 'Not found' }); return; }
  const { ownerAddress } = req.body as { ownerAddress?: string };
  if (!ownerAddress || ownerAddress.toLowerCase() !== agent.ownerAddress.toLowerCase()) {
    res.status(403).json({ success: false, error: 'Forbidden' }); return;
  }
  res.json({ success: true, data: { agentId: agent.id, walletAddress: agent.walletAddress, encryptedPrivateKey: agent.encryptedPrivateKey } });
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
  res.json({
    success: true,
    data: {
      ...strip(agent),
      reputation: getDecayedReputation(agent.walletAddress),
    }
  });
});

// POST /api/v1/agents/:id/start
agentsRouter.post('/:id/start', async (req, res) => {
  try {
    await startAgent(req.params.id);
    res.json({ success: true, data: strip(await getAgent(req.params.id)) });
  } catch (e: unknown) {
    res.status(400).json({
      success: false,
      error: { code: 'AGENT_ACTION_FAILED', message: (e as Error).message },
    });
  }
});

// POST /api/v1/agents/:id/pause
agentsRouter.post('/:id/pause', async (req, res) => {
  try {
    await pauseAgent(req.params.id);
    res.json({ success: true, data: strip(await getAgent(req.params.id)) });
  } catch (e: unknown) {
    res.status(400).json({
      success: false,
      error: { code: 'AGENT_ACTION_FAILED', message: (e as Error).message },
    });
  }
});

// POST /api/v1/agents/:id/stop
agentsRouter.post('/:id/stop', async (req, res) => {
  try {
    await stopAgent(req.params.id);
    res.json({ success: true, data: strip(await getAgent(req.params.id)) });
  } catch (e: unknown) {
    res.status(400).json({
      success: false,
      error: { code: 'AGENT_ACTION_FAILED', message: (e as Error).message },
    });
  }
});
