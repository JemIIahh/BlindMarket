import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../../config.js';
import type { AuthUser, AgentCapability, DeployedAgent } from '../../types.js';
import { AGENT_CAPABILITIES } from '../../types.js';
import * as registryService from '../registry.js';
import * as escrowService from '../escrow.js';
import * as a2aStore from '../a2aStore.js';
import * as serviceStore from '../serviceStore.js';
import * as agentStore from '../agentStore.js';
import * as reputationService from '../reputation.js';
import * as reputationDecay from '../reputationDecay.js';
import { redis } from '../redis.js';
import { loadAllAgents } from '../deployedAgentStore.js';
import { getAgent as getDeployedAgent, startAgent, stopAgent, getAgentLogs } from '../agentRunner.js';
import { isAgentOwner, stripAgentSecrets } from '../agentOwnership.js';
import { canViewerSeeResult } from '../resultVisibility.js';
import { getTokenDecimals } from '../chain.js';

/**
 * Tier-1 remote MCP tool surface (see docs/AGENT-READY.md).
 *
 * Every tool here is either a public read (routed through the same
 * projectPublic* projections as the unauthenticated REST surfaces — key
 * material must NEVER appear in tool output, which lands verbatim in some
 * third-party LLM's context window) or an owner-gated action that reuses the
 * exact ownership predicate the REST routes use (isAgentOwner).
 *
 * A fresh McpServer is built per request (stateless Streamable HTTP), so the
 * auth context is closed over per instance — cheap, and it keeps per-user
 * state out of module scope.
 */

const bigintReplacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, bigintReplacer, 2) }] };
}

function fail(code: string, message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: { code, message } }) }],
  };
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: true };

export function buildMcpServer(user: AuthUser): McpServer {
  const server = new McpServer({ name: 'BlindMarket', version: '1.0.0' });

  // The legacy shared AGENT_API_KEY resolves to the literal principal 'agent'
  // — it has no wallet, so "my"-scoped and owner-gated tools must refuse it.
  const allAddresses = [user.address, user.ownerAddress, ...(user.addresses ?? [])]
    .filter((a): a is string => typeof a === 'string' && a.startsWith('0x'));
  const hasWallet = allAddresses.length > 0;

  /** Shared owner gate for agent lifecycle tools — same predicate as REST authorizeOwner. */
  async function ownedAgent(agentId: string): Promise<{ ok: false; error: ReturnType<typeof fail> } | { ok: true; agent: DeployedAgent }> {
    if (!hasWallet) return { ok: false, error: fail('UNAUTHORIZED', 'This tool needs a wallet-backed API key (the legacy shared key has no wallet identity)') };
    const agent = await getDeployedAgent(agentId);
    if (!agent) return { ok: false, error: fail('NOT_FOUND', `No deployed agent with id ${agentId}`) };
    if (!isAgentOwner(agent, allAddresses)) {
      return { ok: false, error: fail('FORBIDDEN', 'Only the agent owner can perform this action. Your API key resolves to a wallet that is not this agent\'s owner.') };
    }
    return { ok: true, agent };
  }

  // ── Discovery (public reads) ──────────────────────────────────────────────

  server.registerTool(
    'platform_status',
    {
      title: 'Platform Status',
      description: 'Live BlindMarket platform stats: open task count, deployed/active agents, chain id.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const [openTasks, agents] = await Promise.all([
        registryService.openTaskCount().catch(() => 0),
        loadAllAgents().catch(() => []),
      ]);
      return ok({
        openTasks,
        totalAgents: agents.length,
        activeAgents: agents.filter((a) => a.status === 'running').length,
        chainId: config.ogChainId,
        escrowAddress: config.blindEscrowAddress,
      });
    },
  );

  server.registerTool(
    'browse_services',
    {
      title: 'Browse Agent Services',
      description: 'List active rent-an-agent service listings (name, description, per-call price in wei of native 0G, the agent behind it).',
      inputSchema: {
        agent: z.string().optional().describe('Filter to one agent wallet address (0x…)'),
        limit: z.number().int().min(1).max(50).optional().describe('Page size (default 20, max 50)'),
        offset: z.number().int().min(0).optional().describe('Pagination offset'),
      },
      annotations: READ_ONLY,
    },
    async ({ agent, limit, offset }) => {
      const result = await serviceStore.listActiveServices({ agentAddress: agent, limit, offset });
      return ok(result);
    },
  );

  server.registerTool(
    'get_service',
    {
      title: 'Get Service',
      description: 'Full detail for one service listing, including the provider agent\'s public key (needed to encrypt a brief to it).',
      inputSchema: { serviceId: z.number().int().positive().describe('Service id from browse_services') },
      annotations: READ_ONLY,
    },
    async ({ serviceId }) => {
      const service = await serviceStore.getActiveService(serviceId);
      if (!service) return fail('NOT_FOUND', `No active service with id ${serviceId}`);
      return ok(service);
    },
  );

  server.registerTool(
    'search_agents',
    {
      title: 'Search Agents',
      description: 'Search registered executor agents by capability and name/address. Returns reputation, completed-task count, minimum service price, and the agent\'s encryption public key.',
      inputSchema: {
        capability: z.enum(AGENT_CAPABILITIES as unknown as [string, ...string[]]).optional()
          .describe('Filter by declared capability'),
        query: z.string().max(100).optional().describe('Case-insensitive match on display name or address'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results (default 20)'),
      },
      annotations: READ_ONLY,
    },
    async ({ capability, query, limit }) => {
      let agents = await agentStore.listAgents(capability ? [capability] : undefined);
      const q = (query ?? '').toLowerCase().trim();
      if (q) {
        agents = agents.filter(
          (a) => (a.displayName || '').toLowerCase().includes(q) || a.address.toLowerCase().includes(q),
        );
      }
      const priceMap = await serviceStore.getMinActivePricesByAgents(agents.map((a) => a.address));
      const results = agents.slice(0, limit ?? 20).map((a) => ({
        address: a.address,
        name: a.displayName,
        capabilities: a.capabilities,
        reputation: a.reputation,
        tasksCompleted: a.tasksCompleted,
        publicKey: a.publicKey,
        fromPrice: priceMap.get(a.address.toLowerCase()) ?? null,
      }));
      return ok({ agents: results, total: agents.length });
    },
  );

  server.registerTool(
    'browse_tasks',
    {
      title: 'Browse Open Tasks',
      description: 'Browse open agent-targeted tasks on the marketplace, optionally filtered by capabilities or minimum poster reputation. Public projection — briefs of private tasks are encrypted and not included.',
      inputSchema: {
        capabilities: z.string().optional().describe('Comma-separated capability filter (e.g. "web_research,data_processing")'),
        minReputation: z.number().optional().describe('Minimum reputation filter'),
        limit: z.number().int().min(1).max(100).optional().describe('Page size (default 25)'),
        offset: z.number().int().min(0).optional().describe('Pagination offset'),
      },
      annotations: READ_ONLY,
    },
    async ({ capabilities, minReputation, limit, offset }) => {
      const caps = capabilities
        ? (capabilities.split(',').map((s) => s.trim()).filter(Boolean) as AgentCapability[])
        : undefined;
      const matches = await a2aStore.browseAgentTasks(caps, minReputation);
      const off = offset ?? 0;
      const lim = limit ?? 25;
      // Same public projection as the unauthenticated REST browse — key
      // material must never reach a third-party model's context.
      const tasks = matches.slice(off, off + lim).map(a2aStore.projectPublicEntry);
      return ok({ tasks, total: matches.length, offset: off, limit: lim });
    },
  );

  server.registerTool(
    'get_task_status',
    {
      title: 'Get Task Status',
      description: 'Status of one task by numeric id or 0x task hash: on-chain escrow state plus marketplace lifecycle state. The deliverable (resultData) is included only if your API key\'s wallet is the poster or the worker.',
      inputSchema: { taskId: z.string().describe('Numeric task id or 0x-prefixed 32-byte task hash') },
      annotations: READ_ONLY,
    },
    async ({ taskId }) => {
      let numericId: number;
      if (/^0x[0-9a-fA-F]{64}$/.test(taskId)) {
        const resolved = await redis.get(`a2a:hash2id:${taskId.toLowerCase()}`);
        if (!resolved || !/^\d+$/.test(resolved)) {
          return fail('NOT_INDEXED_YET', 'Task hash not found — the create transaction may not be confirmed or indexed yet. Retry in a few seconds.');
        }
        numericId = parseInt(resolved, 10);
      } else if (/^\d+$/.test(taskId)) {
        numericId = parseInt(taskId, 10);
      } else {
        return fail('INVALID_TASK_ID', 'taskId must be a positive integer or a 0x-prefixed 32-byte hash');
      }

      let task;
      try {
        task = await escrowService.getTask(numericId);
      } catch (err) {
        if ((err as Error).message?.includes('could not decode result data')) {
          return fail('NOT_FOUND', 'Task not found on chain');
        }
        throw err;
      }

      const [meta, state, decimals] = await Promise.all([
        a2aStore.getMeta(task.taskHash),
        a2aStore.getState(task.taskHash),
        getTokenDecimals(task.token).catch(() => 18),
      ]);

      // Same poster/worker gate as REST task detail (resultVisibility.ts).
      // Public tasks: the poster opted out of blindness — result is public.
      let canSeeResult = meta?.privacy === 'public';
      if (!canSeeResult && state?.resultData != null) {
        canSeeResult = await canViewerSeeResult(user, String(task.agent), String(task.worker));
      }

      return ok({
        taskId: numericId.toString(),
        ...JSON.parse(JSON.stringify(task, bigintReplacer)),
        decimals,
        a2aMeta: meta ? a2aStore.projectPublicMeta(meta) : null,
        a2aState: state
          ? { ...a2aStore.projectPublicState(state), resultData: canSeeResult ? state.resultData ?? null : null }
          : null,
      });
    },
  );

  server.registerTool(
    'get_reputation',
    {
      title: 'Get Reputation',
      description: 'Merged reputation for an agent wallet: on-chain BlindReputation plus off-chain decayed score.',
      inputSchema: { address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe('Agent wallet address') },
      annotations: READ_ONLY,
    },
    async ({ address }) => {
      const [onChain, decayed] = await Promise.all([
        reputationService.getReputationWithScore(address).catch(() => null),
        reputationDecay.getDecayedReputation(address),
      ]);
      return ok({
        address,
        tasksCompleted: onChain?.tasksCompleted ?? decayed.tasksCompleted,
        avgScore: onChain?.avgScore ?? 0,
        disputes: onChain?.disputes ?? decayed.disputes,
        onChainScore: onChain?.score ?? 0,
        decayedScore: decayed.decayedScore,
        daysSinceLastTask: decayed.daysSinceLastTask,
      });
    },
  );

  server.registerTool(
    'get_leaderboard',
    {
      title: 'Reputation Leaderboard',
      description: 'Top worker agents by decayed reputation score.',
      inputSchema: { limit: z.number().int().min(1).max(50).optional().describe('Max entries (default 20)') },
      annotations: READ_ONLY,
    },
    async ({ limit }) => ok({ leaderboard: await reputationDecay.getLeaderboard(Math.min(50, Math.max(1, limit ?? 20))) }),
  );

  // ── My scope (wallet-bound reads) ─────────────────────────────────────────

  server.registerTool(
    'get_my_posted_tasks',
    {
      title: 'My Posted Tasks',
      description: 'Tasks posted by your API key\'s wallet, with lifecycle status and (once submitted and verified) the deliverable. This is how you poll for results of tasks you funded.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      if (!hasWallet) return fail('UNAUTHORIZED', 'This tool needs a wallet-backed API key');
      const tasks = await a2aStore.getPosterTasks(user.address);
      // Poster's own surface: project the meta (no reason to pump ECIES blobs
      // into an LLM context, even the poster's own) but keep the deliverable.
      const projected = tasks.map((t) => ({
        meta: a2aStore.projectPublicMeta(t.meta),
        state: { ...a2aStore.projectPublicState(t.state), resultData: t.state.resultData ?? null },
      }));
      return ok({ tasks: projected, total: projected.length });
    },
  );

  // ── Deployed-agent operation (owner-gated actions) ────────────────────────

  server.registerTool(
    'list_my_agents',
    {
      title: 'My Deployed Agents',
      description: 'List agents deployed by your wallet (or linked to it as an authorized owner), with status and wallet address. Secrets are never included.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      if (!hasWallet) return fail('UNAUTHORIZED', 'This tool needs a wallet-backed API key');
      const all = await loadAllAgents();
      const mine = all.filter((a) => isAgentOwner(a, allAddresses)).map((a) => stripAgentSecrets(a));
      return ok({ agents: mine, total: mine.length });
    },
  );

  server.registerTool(
    'get_agent_logs',
    {
      title: 'Agent Logs',
      description: 'Recent log lines from a deployed agent\'s worker process.',
      inputSchema: {
        agentId: z.string().describe('Deployed agent id'),
        lines: z.number().int().min(1).max(200).optional().describe('How many recent lines (default 50)'),
      },
      annotations: READ_ONLY,
    },
    async ({ agentId, lines }) => {
      const history = await getAgentLogs(agentId);
      return ok({ agentId, lines: history.slice(-(lines ?? 50)) });
    },
  );

  const lifecycle = [
    { name: 'start_agent', title: 'Start Agent', description: 'Start a deployed agent you own. It begins polling the marketplace and accepting matching tasks.', run: startAgent },
    { name: 'stop_agent', title: 'Stop Agent', description: 'Stop a deployed agent you own.', run: stopAgent },
    {
      name: 'restart_agent',
      title: 'Restart Agent',
      description: 'Stop then start a deployed agent you own.',
      run: async (id: string) => { await stopAgent(id); await startAgent(id); },
    },
  ] as const;

  for (const t of lifecycle) {
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: { agentId: z.string().describe('Deployed agent id') },
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async ({ agentId }) => {
        const res = await ownedAgent(agentId);
        if (!res.ok) return res.error;
        try {
          await t.run(agentId);
        } catch (err) {
          return fail('AGENT_ACTION_FAILED', (err as Error).message);
        }
        const updated = stripAgentSecrets(await getDeployedAgent(agentId));
        return ok({ ok: true, agent: updated });
      },
    );
  }

  return server;
}
