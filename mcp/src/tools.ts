import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BlindMarket, AgentCapability } from '@blindmarket/sdk';
import type { WalletCtx } from './wallet.js';
import type { Settlement } from './settlement.js';

type ToolResult = { isError?: boolean; content: Array<{ type: 'text'; text: string }> };

/**
 * `settlement` is rent.ts's resolver. An executor registered from this process
 * delivers through complete_task, which settles on that one chain — the chain
 * the backend posts new tasks on — so that is the only chain it declares.
 * Declaring more would get it offered tasks it cannot deliver; declaring
 * nothing reads as the legacy 0G+Base set.
 */
export function registerMarketTools(
  server: McpServer,
  bb: BlindMarket,
  walletCtx: WalletCtx | null = null,
  settlement?: () => Promise<Settlement>,
): void {
  async function declaredChains(tool: string): Promise<{ supportedChains: string[] | undefined } | { error: ToolResult }> {
    if (!settlement) return { supportedChains: undefined };
    try {
      return { supportedChains: [(await settlement()).mode] };
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'SETTLEMENT_UNKNOWN';
      const message = `${tool} declares the chain this process can deliver on (the one the backend posts new tasks on), and could not learn it: ${(err as Error).message}`;
      return { error: { isError: true, content: [{ type: 'text', text: JSON.stringify({ success: false, error: { code, message } }) }] } };
    }
  }

  // ── Health & Stats ────────────────────────────────────────────────────

  server.registerTool(
    'health',
    {
      title: 'Health Check',
      description: 'Check if the BlindMarket backend is reachable and healthy',
      inputSchema: {},
    },
    async () => {
      const result = await bb.health();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'stats',
    {
      title: 'Platform Stats',
      description: 'Get live BlindMarket platform statistics (tasks, agents, users)',
      inputSchema: {},
    },
    async () => {
      const result = await bb.stats();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ── Tasks ─────────────────────────────────────────────────────────────

  server.registerTool(
    'list_open_tasks',
    {
      title: 'List Open Tasks',
      description: 'List open tasks available for assignment on BlindMarket',
      inputSchema: {
        limit: z.number().optional().describe('Maximum number of tasks to return (default 20)'),
      },
    },
    async ({ limit }) => {
      const tasks = await bb.listTasks(limit ?? 20);
      return { content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }] };
    },
  );

  server.registerTool(
    'get_task',
    {
      title: 'Get Task Details',
      description: 'Get full details for a specific task by ID',
      inputSchema: {
        taskId: z.string().describe('Task ID (numeric or 0x)'),
      },
    },
    async ({ taskId }) => {
      const task = await bb.getTask(taskId);
      return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
    },
  );

  server.registerTool(
    'browse_a2a_tasks',
    {
      title: 'Browse A2A Tasks',
      description: 'Browse agent-to-agent tasks available for execution, optionally filtered by capabilities',
      inputSchema: {
        capabilities: z.string().optional().describe('Comma-separated capability filter (e.g. "data_processing,web_research")'),
        minReputation: z.number().optional().describe('Minimum reputation filter'),
      },
    },
    async ({ capabilities, minReputation }) => {
      const result = await bb.browseA2ATasks({
        capabilities: capabilities ? capabilities.split(',').map(s => s.trim()) : undefined,
        minReputation: minReputation ?? undefined,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result.tasks, null, 2) }] };
    },
  );

  // ── Agents ────────────────────────────────────────────────────────────

  server.registerTool(
    'create_agent',
    {
      title: 'Create Agent',
      description: "Register as an A2A executor using the local wallet (BLINDMARKET_PRIVATE_KEY): derives its uncompressed public key and registers it. The executor is ALWAYS the wallet that owns BLINDMARKET_API_KEY, so on 0G the two must be the same wallet (checked — a mismatch is refused). No wallet is generated and no key is returned. On Base with a Privy owner wallet, use register_as_executor with wallet_status's executorPublicKey instead.",
      inputSchema: {
        displayName: z.string().describe('Display name for the agent'),
        capabilities: z.string().describe('Comma-separated capabilities (e.g. "data_processing,web_research")'),
        minReward: z.string().optional().describe("Minimum reward per task, as an integer in the payment token's smallest unit (USDC: 6 decimals, so '1000000' = 1 USDC)"),
        preferredCapabilities: z.string().optional().describe('Comma-separated preferred capabilities (subset of capabilities)'),
      },
    },
    async ({ displayName, capabilities, minReward, preferredCapabilities }) => {
      if (!walletCtx) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ success: false, error: { code: 'NO_WALLET', message: 'create_agent derives the executor public key from BLINDMARKET_PRIVATE_KEY — set it to the key of the wallet that owns BLINDMARKET_API_KEY.' } }) }] };
      }
      // SDKs before the release that added deliverResult() ignore `privateKey`
      // and register a freshly generated wallet instead — a key nobody holds,
      // so every brief wrapped to it is lost. package.json cannot require that
      // release until it is on npm, so refuse here, before anything is registered.
      if (typeof (bb as { deliverResult?: unknown }).deliverResult !== 'function') {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ success: false, error: { code: 'SDK_TOO_OLD', message: 'The installed @blindmarket/sdk ignores the wallet key passed to createAgent. Upgrade @blindmarket/sdk, or use register_as_executor with wallet_status\'s executorPublicKey.' } }) }] };
      }
      const chains = await declaredChains('create_agent');
      if ('error' in chains) return chains.error;
      const { executor, wallet } = await bb.createAgent({
        supportedChains: chains.supportedChains,
        privateKey: walletCtx.wallet.privateKey,
        displayName,
        capabilities: capabilities.split(',').map(s => s.trim()) as AgentCapability[],
        minReward: minReward ?? undefined,
        preferredCapabilities: preferredCapabilities
          ? preferredCapabilities.split(',').map(s => s.trim()) as AgentCapability[]
          : undefined,
      });
      // Never echo the private key into the model's context.
      const result = { executor, wallet: { address: wallet.address, publicKey: wallet.publicKey } };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'register_as_executor',
    {
      title: 'Register as Executor',
      description: "Register as an A2A executor. The executor address is ALWAYS the wallet that owns BLINDMARKET_API_KEY; publicKey is the key briefs get wrapped to (wallet_status reports the local one as executorPublicKey). Declares the one chain this process delivers on (the chain the backend posts new tasks on — wallet_status shows it), so the backend offers it only tasks it can complete.",
      inputSchema: {
        address: z.string().optional().describe("Ignored by the backend — the executor is the API key's owner wallet"),
        displayName: z.string().describe('Display name'),
        capabilities: z.string().describe('Comma-separated capabilities'),
        publicKey: z.string().regex(/^04[0-9a-fA-F]{128}$/).describe('Uncompressed secp256k1 public key: 130 hex chars, leading 04, no 0x prefix'),
        minReward: z.string().optional().describe("Minimum reward, as an integer in the payment token's smallest unit (USDC: 6 decimals)"),
      },
    },
    async ({ displayName, capabilities, publicKey, minReward }) => {
      const chains = await declaredChains('register_as_executor');
      if ('error' in chains) return chains.error;
      const result = await bb.registerExecutor({
        supportedChains: chains.supportedChains,
        displayName,
        capabilities: capabilities.split(',').map(s => s.trim()) as AgentCapability[],
        publicKey,
        minReward: minReward ?? undefined,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'list_agents',
    {
      title: 'List Agents',
      description: 'List deployed agents, optionally filtered by owner address',
      inputSchema: {
        ownerAddress: z.string().optional().describe('Filter by owner wallet address'),
      },
    },
    async ({ ownerAddress }) => {
      const agents = await bb.listAgents(ownerAddress ?? undefined);
      return { content: [{ type: 'text', text: JSON.stringify(agents, null, 2) }] };
    },
  );

  server.registerTool(
    'get_agent',
    {
      title: 'Get Agent Details',
      description: 'Get details for a single deployed agent by ID',
      inputSchema: {
        agentId: z.string().describe('Agent ID'),
      },
    },
    async ({ agentId }) => {
      const agent = await bb.getAgent(agentId);
      return { content: [{ type: 'text', text: JSON.stringify(agent, null, 2) }] };
    },
  );

  // ── A2A Actions ───────────────────────────────────────────────────────

  server.registerTool(
    'bid_on_task',
    {
      title: 'Bid on Task',
      description: 'Register bid intent on an A2A task',
      inputSchema: {
        taskId: z.string().describe('Task ID'),
      },
    },
    async ({ taskId }) => {
      await bb.bidOnTask(taskId);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
    },
  );

  server.registerTool(
    'accept_task',
    {
      title: 'Accept Task',
      description: 'Claim an open A2A task — this assigns you on-chain — and get the rootHash + wrapped AES key (then fetch_brief, then complete_task). On NEEDS_WRAP the brief key is not wrapped to you yet: call bid_on_task and retry once the poster has wrapped it.',
      inputSchema: {
        taskId: z.string().describe('Task ID'),
      },
    },
    async ({ taskId }) => {
      const result = await bb.acceptTask(taskId);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // No submit_result tool: POST /submit only BUILDS an unsigned submitEvidence
  // and flips the task to 'submitted'. A tool that stopped there never signed
  // it, and a later complete_task then 409'd on the state it left behind.
  // complete_task (rent.ts) is the one delivery path: submit → sign/relay →
  // finalize, with /rebroadcast healing for a stranded 'submitted' task.

  server.registerTool(
    'verify_task',
    {
      title: 'Verify Task',
      description: 'Trigger AI/TEE verification for a submitted task result',
      inputSchema: {
        // taskHash, not a numeric id: ids collide across 0G and Base, so the
        // backend keys verification on the hash like every other A2A surface.
        taskHash: z.string().describe('Task hash (bytes32 hex, 0x-prefixed)'),
        taskCategory: z.string().describe('Task category (e.g. photography, research)'),
        // Optional and privileged: the backend builds the standard being judged
        // against from the task the poster created. It accepts this only from
        // the poster or the designated verifier — an executor sending it is
        // rejected, since defining your own bar is self-grading.
        taskRequirements: z
          .string()
          .optional()
          .describe('Optional supplemental requirements (poster/verifier only)'),
        evidenceSummary: z.string().describe('Summary of submitted evidence'),
      },
    },
    async ({ taskHash, taskCategory, taskRequirements, evidenceSummary }) => {
      const result = await bb.verify({ taskHash, taskCategory, taskRequirements, evidenceSummary });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ── Reputation ────────────────────────────────────────────────────────

  server.registerTool(
    'get_reputation',
    {
      title: 'Get Reputation',
      description: "Get an address's on-chain + off-chain reputation on BlindMarket",
      inputSchema: {
        address: z.string().describe('Wallet address (0x...)'),
      },
    },
    async ({ address }) => {
      const rep = await bb.getReputation(address as `0x${string}`);
      return { content: [{ type: 'text', text: JSON.stringify(rep, null, 2) }] };
    },
  );

  server.registerTool(
    'get_leaderboard',
    {
      title: 'Get Leaderboard',
      description: 'Get top workers ranked by reputation score',
      inputSchema: {
        limit: z.number().optional().describe('Number of top workers to return (default 50)'),
      },
    },
    async ({ limit }) => {
      const board = await bb.getLeaderboard(limit ?? 50);
      return { content: [{ type: 'text', text: JSON.stringify(board, null, 2) }] };
    },
  );

  // ── Marketplace ───────────────────────────────────────────────────────

  server.registerTool(
    'search_agents',
    {
      title: 'Search Agents',
      description: 'Search registered agents by capability or minimum rating',
      inputSchema: {
        capability: z.string().optional().describe('Capability filter'),
        minRating: z.number().optional().describe('Minimum rating (1-5)'),
      },
    },
    async ({ capability, minRating }) => {
      const agents = await bb.searchAgents({
        capability: capability ?? undefined,
        minRating: minRating ?? undefined,
      });
      return { content: [{ type: 'text', text: JSON.stringify(agents, null, 2) }] };
    },
  );

  // ── Messages ─────────────────────────────────────────────────────────

  server.registerTool(
    'send_message',
    {
      title: 'Send Message',
      description: 'Send a message to a task participant',
      inputSchema: {
        taskId: z.string().describe('Task ID'),
        to: z.string().describe('Recipient address or "poster"/"agent" shortcut'),
        content: z.string().describe('Message content'),
      },
    },
    async ({ taskId, to, content }) => {
      const result = await bb.sendMessage({ taskId, to, content });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'get_inbox',
    {
      title: 'Get Inbox',
      description: 'Read inbox messages for the authenticated user',
      inputSchema: {},
    },
    async () => {
      const result = await bb.getInbox();
      return { content: [{ type: 'text', text: JSON.stringify(result.messages, null, 2) }] };
    },
  );

  // ── Agent Management (write) ──────────────────────────────────────────

  server.registerTool(
    'start_agent',
    {
      title: 'Start Agent',
      description: 'Start a deployed BlindMarket agent',
      inputSchema: {
        agentId: z.string().describe('Agent ID'),
      },
    },
    async ({ agentId }) => {
      const result = await bb.startAgent(agentId);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'stop_agent',
    {
      title: 'Stop Agent',
      description: 'Stop a deployed BlindMarket agent',
      inputSchema: {
        agentId: z.string().describe('Agent ID'),
      },
    },
    async ({ agentId }) => {
      const result = await bb.stopAgent(agentId);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'pause_agent',
    {
      title: 'Pause Agent',
      description: 'Pause a deployed BlindMarket agent',
      inputSchema: {
        agentId: z.string().describe('Agent ID'),
      },
    },
    async ({ agentId }) => {
      const result = await bb.pauseAgent(agentId);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'restart_agent',
    {
      title: 'Restart Agent',
      description: 'Restart a deployed BlindMarket agent',
      inputSchema: {
        agentId: z.string().describe('Agent ID'),
      },
    },
    async ({ agentId }) => {
      const result = await bb.restartAgent(agentId);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
