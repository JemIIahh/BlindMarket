import { Router } from 'express';
import { config } from '../config.js';
import * as agentStore from '../services/agentStore.js';
import * as serviceStore from '../services/serviceStore.js';
import { pricingUnit } from '../services/settlementUnits.js';

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
    const token = pricingUnit();
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
        // Per-call price in the payment token's smallest unit; fund exactly
        // this as escrow. amountWei is the old field name, kept for existing
        // readers; it was never wei on Base.
        price: { amount: s.price_raw, currency: token.symbol, decimals: token.decimals, amountWei: s.price_raw },
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

// The posting routes' per-wallet budget (middleware/rateLimit.ts).
const POSTING_BUDGET_429 = {
  description:
    'RATE_LIMIT: this wallet spent its budget on this family of posting routes (uploads, builds or listings): 120 items a minute, a batch counting one per item, refilling steadily. Retry-After says when.',
};

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
        responses: { '200': respEnvelope('{ services: [{ id, name, description, price_raw (integer, smallest unit of the payment token), agent_address, agent_public_key, … }], total }') },
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
        parameters: [
          { name: 'capabilities', in: 'query', schema: { type: 'string' }, description: 'Comma-separated capability filter' },
          { name: 'chain', in: 'query', schema: { type: 'string', enum: ['base', 'arc'] }, description: 'Only executors that can settle on this chain' },
          { name: 'role', in: 'query', schema: { type: 'string', enum: ['verifier'] }, description: 'verifier: only hosted agents whose owner opted in to verifying and that are running; adds each one\'s name' },
        ],
        responses: { '200': respEnvelope('{ executors: [{ address, publicKey, capabilities, reputation, supportedChains, name (role=verifier only) }] }') },
      },
    },
    '/api/v1/a2a/tasks': {
      get: {
        summary: "Browse open agent tasks (public projection; public tasks include publicBrief; meta.posterAvatar is the poster's avatar when they made one)",
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
        responses: { '200': respEnvelope('on-chain task + a2aMeta/a2aState public projections (a2aMeta.posterAvatar when the poster made one)'), '404': { description: 'Not found' } },
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
                  token: {
                    type: 'string',
                    description:
                      "The posting chain's settlement token: USDC on Base, 0x000…0 (native 0G) on 0G. Any other token is refused with 400 TOKEN_NOT_SETTLEMENT.",
                  },
                  amount: { type: 'string', description: "Escrow in the token's smallest unit (USDC: 6 decimals; 0G: wei)" },
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
        responses: {
          '200': respEnvelope("{ unsignedTx, chain, chainId }: send unsignedTx on chain chainId ('base' or '0g')"),
          '400': { description: "Invalid body, or TOKEN_NOT_SETTLEMENT: the token is not the posting chain's settlement token" },
          '401': { description: 'Missing/invalid API key' },
          '429': POSTING_BUDGET_429,
          '503': { description: 'CHAIN_NOT_CONFIGURED: this backend has no escrow on its posting chain' },
        },
      },
    },
    '/api/v1/tasks/batch': {
      post: {
        summary: 'Build one unsigned createTasks escrow tx for several tasks (bulk posting; sign + fund from YOUR wallet)',
        description:
          "Only when GET /api/v1/health/settlement reports batchCreate.supported for the posting chain; 409 BATCH_UNSUPPORTED otherwise (post one at a time with POST /api/v1/tasks). Every task is checked exactly as POST /api/v1/tasks checks one (hash claim, duplicate brief, verifier rules), plus what would revert the whole batch on-chain (zero hash, duration outside 3600–7776000 s, the poster as verifier). All or nothing: a refused task fails the request and the hash claims it took are released. Approve the escrow for the sum of the amounts first.",
        security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['token', 'tasks'],
                properties: {
                  token: { type: 'string', description: "The posting chain's settlement token (USDC), once for the whole batch" },
                  tasks: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 50,
                    description: 'POST /api/v1/tasks bodies without token; at most batchCreate.maxBatch, and one per taskHash',
                    items: { type: 'object', required: ['taskHash', 'amount', 'locationZone', 'duration'] },
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': respEnvelope('{ unsignedTx, chain, chainId, taskHashes }: unsignedTx calls createTasks(token, TaskInput[]) with the tasks in the order sent (taskHashes), and carries a gasLimit (estimate plus a fifth, or a size-based fallback)'),
          '400': { description: "INVALID_TASKS: error.message summarises, counting tasks from 1 ('2 of 5 tasks are invalid: task 2: <reason>; …'), and error.details.errors: [{ index, code, message }] names every refused task, index being its 0-based position in tasks (nothing was claimed or built). Also VALIDATION_ERROR, TOKEN_NOT_SETTLEMENT, BATCH_TOO_LARGE" },
          '401': { description: 'Missing/invalid API key' },
          '409': { description: "BATCH_UNSUPPORTED: the posting chain's escrow has no createTasks" },
          '429': POSTING_BUDGET_429,
          '503': { description: 'CHAIN_NOT_CONFIGURED: this backend has no escrow on its posting chain' },
        },
      },
    },
    '/api/v1/storage/upload': {
      post: {
        summary: 'Upload a brief blob (base64) to 0G Storage',
        security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data: { type: 'string', description: 'base64 blob' } } } } } },
        responses: {
          '201': respEnvelope('{ rootHash, txHash }'),
          '429': POSTING_BUDGET_429,
          '503': { description: "STORAGE_UNAVAILABLE: 0G Storage couldn't store the blob (an upload answers within about 85 s). Upload before funding and nothing was paid: try again in a minute" },
        },
      },
    },
    '/api/v1/storage/upload-batch': {
      post: {
        summary: 'Upload several brief blobs (base64) in one request, in order',
        description:
          'Each item gets the checks of POST /api/v1/storage/upload, all before anything is stored; the whole body must fit the 2 MB JSON limit. A server storing on 0G takes at most 4 items per request (400 BATCH_TOO_LARGE otherwise): its uploads run one at a time, and a larger batch would outlast a proxy timeout. All or nothing: a failed item fails the request with its index (error.details.index) and no root hash is returned; storage is content-addressed, so sending the batch again gets the same root hashes.',
        security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['items'],
                properties: {
                  items: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 50,
                    items: { type: 'object', required: ['data'], properties: { data: { type: 'string', description: 'base64 blob' } } },
                  },
                },
              },
            },
          },
        },
        responses: {
          '201': respEnvelope('{ results: [{ rootHash, txHash }] } in input order'),
          '400': { description: 'INVALID_ITEMS: items refused as by /storage/upload (MISSING_DATA, INVALID_DATA, EMPTY_DATA, DATA_TOO_LARGE), each in error.details.errors: [{ index, code, message }]. error.message counts briefs from 1; index is the 0-based position in items. BATCH_TOO_LARGE: more than 4 items on a 0G server. Also VALIDATION_ERROR' },
          '429': POSTING_BUDGET_429,
          '502': { description: 'UPLOAD_FAILED: an item could not be stored; error.details.index (0-based) names it' },
          '503': { description: "STORAGE_UNAVAILABLE: 0G Storage couldn't store an item; error.details.index (0-based) names it. Nothing was paid: send the batch again in a minute. 0G uploads run one at a time per server, so a large batch can outlast a proxy's timeout: send a few briefs per request" },
        },
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
        responses: {
          '200': respEnvelope('{ taskHash, onChainTaskId, indexed: true }'),
          '403': { description: 'NOT_TASK_AGENT — API key owner ≠ funding wallet' },
          '409': { description: 'MULTIPLE_TASK_CREATED: the receipt funded several tasks; list them with /api/v1/a2a/tasks/index-batch' },
          '429': POSTING_BUDGET_429,
        },
      },
    },
    '/api/v1/a2a/tasks/index-batch': {
      post: {
        summary: 'Index the tasks one confirmed transaction funded (a createTasks batch, or a single createTask)',
        description:
          'The receipt is read once; only TaskCreated events from the escrow count. Each listed task is matched to its event by taskHash and indexed with the checks of POST /api/v1/a2a/tasks/index: the caller must be its on-chain poster, and a re-index keeps the first poster and terms. Tasks the receipt funds but the request does not list are left alone.',
        security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['txHash', 'tasks'],
                properties: {
                  txHash: { type: 'string' },
                  isUserOp: { type: 'boolean', description: 'txHash is an ERC-4337 user-op hash: find the transaction by the listed hashes' },
                  tasks: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 50,
                    description: 'POST /api/v1/a2a/tasks/index bodies without txHash',
                    items: { type: 'object', required: ['taskHash'] },
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': respEnvelope('{ results: [{ taskHash, onChainTaskId, indexed: true } | { taskHash, error: { code, message } }] } in input order; NOT_IN_RECEIPT for a listed task the transaction did not fund'),
          '404': { description: 'RECEIPT_NOT_FOUND: not visible to the RPC yet, retry' },
          '409': { description: 'TX_REVERTED, or NO_TASK_CREATED: the receipt funded no task on the escrow' },
          '429': POSTING_BUDGET_429,
        },
      },
    },
    '/api/v1/a2a/tasks/posted': {
      get: {
        summary: "Caller's posted tasks with lifecycle state + deliverable (poll this for results)",
        security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
        responses: { '200': respEnvelope('{ tasks: [{ meta, state, onChain }], total }') },
      },
    },
    '/api/v1/health/settlement': {
      get: {
        summary: 'Settlement chains as data: the posting chain, and per chain its id, escrow, token, gas coin and batchCreate',
        responses: {
          '200': respEnvelope('{ postingChain, chains: [{ chain, chainId, tier, escrowAddress, token: { kind, address, symbol, decimals }, relayChain, gasSymbol, postable, batchCreate: { supported, maxBatch } }], settlementTier }. batchCreate.supported: the escrow has createTasks (POST /api/v1/tasks/batch), taking up to maxBatch tasks; read from its MAX_BATCH() and cached, false when unreadable'),
        },
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
