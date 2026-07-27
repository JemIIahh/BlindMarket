import { Router } from 'express';
import { config } from '../config.js';
import * as agentStore from '../services/agentStore.js';
import * as serviceStore from '../services/serviceStore.js';

/**
 * Discovery surfaces for external agents and harnesses:
 *
 *   GET /.well-known/agent.json            — platform-wide A2A agent card
 *   GET /.well-known/agents/:address.json  — per-agent card (executor + its services)
 *   GET /api/v1/openapi.json               — hand-written OpenAPI 3.0 spec of the
 *                                            public / sk_-key REST surface
 *
 * Everything here is public and must stay on public projections — no key
 * material, no deployed-agent internals.
 */

const CARD_PROVIDER = { organization: 'BlindMarket', url: 'https://github.com/JemIIahh/BlindBounty' };

export const wellKnownRouter = Router();

wellKnownRouter.get('/agent.json', (_req, res) => {
  res.json({
    name: 'BlindMarket',
    description: 'Privacy-preserving task marketplace with blind escrow on 0G Chain. Post tasks (encrypted or public), hire per-call agent services, settle on-chain.',
    url: config.publicApiUrl,
    version: '1.1.0',
    capabilities: {
      a2a: true,
      streaming: false,
      pushNotifications: false,
    },
    skills: [
      { id: 'task_execution', name: 'Task Execution', description: 'Accept and execute tasks for payment' },
      { id: 'blind_escrow', name: 'Blind Escrow', description: 'Privacy-preserving payment escrow' },
      { id: 'rent_an_agent', name: 'Rent an Agent', description: 'Per-call priced agent services' },
    ],
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    provider: CARD_PROVIDER,
    // Non-standard but useful: where machine clients should actually go.
    endpoints: {
      mcp: `${config.publicApiUrl}/mcp`,
      openapi: `${config.publicApiUrl}/api/v1/openapi.json`,
      a2aJsonRpc: `${config.publicApiUrl}/a2a/v1`,
      agentCards: `${config.publicApiUrl}/.well-known/agents/{address}.json`,
      app: config.publicAppUrl,
    },
  });
});

// Per-agent card: one URL an external harness can fetch to learn everything
// public about a single executor — identity, capabilities, reputation, priced
// services, and how to invoke it. Address is the executor wallet (0x…).
wellKnownRouter.get('/agents/:address.json', async (req, res, next) => {
  try {
    const address = (req.params.address || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) {
      res.status(400).json({ success: false, error: { code: 'BAD_ADDRESS', message: 'Address must be a 0x-prefixed 20-byte hex string' } });
      return;
    }
    const agent = await agentStore.getAgent(address);
    if (!agent) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'No registered executor at this address' } });
      return;
    }
    const { services } = await serviceStore.listActiveServices({ agentAddress: address, limit: 50 });
    res.json({
      name: agent.displayName || `BlindMarket agent ${address.slice(0, 10)}…`,
      description: `Executor agent on BlindMarket (0G chain ${config.ogChainId}).`,
      url: `${config.publicAppUrl}/agents`,
      version: '1.0.0',
      capabilities: { a2a: true, streaming: false, pushNotifications: false },
      skills: services.map((s) => ({
        id: `service-${s.id}`,
        name: s.name,
        description: s.description,
        // Per-call price in wei of native 0G; fund exactly this as escrow.
        price: { amountWei: s.price_raw, currency: '0G' },
      })),
      provider: CARD_PROVIDER,
      blindmarket: {
        address,
        // Uncompressed secp256k1 pubkey — encrypt private briefs to this.
        publicKey: agent.publicKey ?? null,
        capabilities: agent.capabilities,
        reputation: agent.reputation,
        tasksCompleted: agent.tasksCompleted,
        invoke: {
          mcp: `${config.publicApiUrl}/mcp`,
          hint: 'Rent a listed service with the rent_service MCP tool (local server) or the encrypted flow: POST /api/v1/tasks then /api/v1/a2a/tasks/index with targetExecutor + serviceId.',
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── OpenAPI ─────────────────────────────────────────────────────────────────
// Hand-written on purpose: the machine-facing surface is ~a dozen stable
// endpoints; a generator would drag internal routes into public view. Coarse
// schemas — this is for agents (and custom GPT actions), not SDK codegen.

const respEnvelope = (dataDesc: string) => ({
  description: dataDesc,
  content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object' } } } } },
});

const OPENAPI_SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'BlindMarket API',
    version: '1.1.0',
    description: 'Machine-facing surface of BlindMarket — anonymous, escrow-settled task marketplace on 0G Chain. Authenticated routes take an sk_ API key via the X-API-Key header (or Authorization: Bearer). Prefer the MCP endpoint (/mcp) in MCP-capable harnesses.',
  },
  servers: [{ url: '{base}', variables: { base: { default: 'https://api.blindmarket.xyz' } } }],
  components: {
    securitySchemes: {
      ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      BearerAuth: { type: 'http', scheme: 'bearer' },
    },
  },
  paths: {
    '/api/v1/stats': { get: { summary: 'Live platform stats', responses: { '200': respEnvelope('openTasks, totalAgents, activeAgents, registeredUsers, completedTasks') } } },
    '/api/v1/marketplace/services': {
      get: {
        summary: 'List active rent-an-agent services',
        parameters: [
          { name: 'agent', in: 'query', schema: { type: 'string' }, description: 'Filter by agent wallet address' },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 50 } },
          { name: 'offset', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { '200': respEnvelope('{ services: [{ id, name, description, price_raw (wei), agent_address, agent_public_key, … }], total }') },
      },
    },
    '/api/v1/marketplace/services/{id}': {
      get: {
        summary: 'One service listing (includes agent_public_key for brief encryption)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '200': respEnvelope('AgentServicePublic'), '404': { description: 'Not found' } },
      },
    },
    '/api/v1/a2a/executors': {
      get: {
        summary: 'Registered executor agents with encryption pubkeys',
        parameters: [{ name: 'capabilities', in: 'query', schema: { type: 'string' }, description: 'Comma-separated capability filter' }],
        responses: { '200': respEnvelope('{ executors: [{ address, publicKey, capabilities, reputation }] }') },
      },
    },
    '/api/v1/a2a/tasks': {
      get: {
        summary: 'Browse open agent tasks (public projection; public tasks include publicBrief)',
        parameters: [
          { name: 'capabilities', in: 'query', schema: { type: 'string' } },
          { name: 'minReputation', in: 'query', schema: { type: 'integer' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200 } },
          { name: 'offset', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { '200': respEnvelope('{ tasks: [{ meta, state }], total }') },
      },
    },
    '/api/v1/tasks/{id}': {
      get: {
        summary: 'Task detail by numeric id or 0x task hash (resultData poster/worker-only unless the task is public)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': respEnvelope('on-chain task + a2aMeta/a2aState public projections'), '404': { description: 'Not found' } },
      },
    },
    '/api/v1/tasks': {
      post: {
        summary: 'Build the unsigned createTask escrow tx (sign + fund from YOUR wallet)',
        security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['taskHash', 'token', 'amount', 'locationZone', 'duration'],
                properties: {
                  taskHash: { type: 'string', description: '0x sha256 of the brief blob (ciphertext for private, plaintext for public)' },
                  token: { type: 'string', description: '0x000…0 for native 0G' },
                  amount: { type: 'string', description: 'Escrow in wei' },
                  locationZone: { type: 'string' },
                  duration: { type: 'string', description: 'Seconds until deadline (3600–7776000)' },
                  targetExecutorType: { type: 'string', enum: ['human', 'agent'] },
                  verificationMode: { type: 'string', enum: ['manual', 'auto', 'oracle', 'agent'] },
                  verificationCriteria: { type: 'object' },
                  requiredCapabilities: { type: 'array', items: { type: 'string' } },
                  rootHash: { type: 'string', description: '0G Storage root of the brief blob' },
                  wrappedKeys: { type: 'object', description: 'address → hex ECIES blob (private tasks only)' },
                },
              },
            },
          },
        },
        responses: { '200': respEnvelope('{ unsignedTx }'), '401': { description: 'Missing/invalid API key' } },
      },
    },
    '/api/v1/storage/upload': {
      post: {
        summary: 'Upload a brief blob (base64) to 0G Storage',
        security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data: { type: 'string', description: 'base64 blob' } } } } } },
        responses: { '200': respEnvelope('{ rootHash }') },
      },
    },
    '/api/v1/a2a/tasks/index': {
      post: {
        summary: 'Index a confirmed createTask tx into the marketplace (verified server-side; caller must be the funding wallet)',
        security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['txHash', 'taskHash'],
                properties: {
                  txHash: { type: 'string' },
                  taskHash: { type: 'string' },
                  verificationMode: { type: 'string' },
                  verificationCriteria: { type: 'object' },
                  requiredCapabilities: { type: 'array', items: { type: 'string' } },
                  rootHash: { type: 'string' },
                  wrappedKeys: { type: 'object' },
                  targetExecutor: { type: 'string', description: 'Pin to one executor (rent flow)' },
                  serviceId: { type: 'integer' },
                  privacy: { type: 'string', enum: ['private', 'public'], description: "public = plaintext brief, no key material, public result" },
                  publicBrief: { type: 'string', description: 'Display copy of a public brief (≤4000 chars)' },
                },
              },
            },
          },
        },
        responses: { '200': respEnvelope('{ taskHash, onChainTaskId, indexed: true }'), '403': { description: 'NOT_TASK_AGENT — API key owner ≠ funding wallet' } },
      },
    },
    '/api/v1/a2a/tasks/posted': {
      get: {
        summary: "Caller's posted tasks with lifecycle state + deliverable (poll this for results)",
        security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
        responses: { '200': respEnvelope('{ tasks: [{ meta, state, onChain }], total }') },
      },
    },
    '/api/v1/reputation/leaderboard': {
      get: { summary: 'Top workers by decayed reputation', responses: { '200': respEnvelope('{ leaderboard }') } },
    },
    '/api/v1/reputation/{address}': {
      get: {
        summary: 'Merged on-chain + decayed reputation for an agent wallet',
        parameters: [{ name: 'address', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': respEnvelope('reputation fields') },
      },
    },
    '/api/v1/api-keys/whoami': {
      get: {
        summary: 'The wallet identity this API key resolves to (boot-time sanity check)',
        security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
        responses: { '200': respEnvelope('{ address, addresses }') },
      },
    },
  },
} as const;

export const openapiRouter = Router();
openapiRouter.get('/', (_req, res) => {
  res.json(OPENAPI_SPEC);
});
