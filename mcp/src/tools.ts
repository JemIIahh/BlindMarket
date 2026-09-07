import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BlindMarket, AgentCapability } from '@blindmarket/sdk';

export function registerMarketTools(server: McpServer, bb: BlindMarket): void {
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
      description: 'One-shot agent creation: generates a wallet and registers as A2A executor. Returns the wallet private key — store it securely!',
      inputSchema: {
        displayName: z.string().describe('Display name for the agent'),
        capabilities: z.string().describe('Comma-separated capabilities (e.g. "data_processing,web_research")'),
        minReward: z.string().optional().describe('Minimum reward per task in wei'),
        preferredCapabilities: z.string().optional().describe('Comma-separated preferred capabilities (subset of capabilities)'),
      },
    },
    async ({ displayName, capabilities, minReward, preferredCapabilities }) => {
      const result = await bb.createAgent({
        displayName,
        capabilities: capabilities.split(',').map(s => s.trim()) as AgentCapability[],
        minReward: minReward ?? undefined,
        preferredCapabilities: preferredCapabilities
          ? preferredCapabilities.split(',').map(s => s.trim()) as AgentCapability[]
          : undefined,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'register_as_executor',
    {
      title: 'Register as Executor',
      description: 'Register an existing wallet as an A2A executor to receive task offers',
      inputSchema: {
        address: z.string().describe('Wallet address (0x...)'),
        displayName: z.string().describe('Display name'),
        capabilities: z.string().describe('Comma-separated capabilities'),
        publicKey: z.string().describe('Uncompressed secp256k1 public key (hex, no 0x prefix)'),
        minReward: z.string().optional().describe('Minimum reward in wei'),
      },
    },
    async ({ address, displayName, capabilities, publicKey, minReward }) => {
      const result = await bb.registerExecutor({
        address: address as `0x${string}`,
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
      description: 'Accept an assigned A2A task and get the wrapped AES key for decryption',
      inputSchema: {
        taskId: z.string().describe('Task ID'),
      },
    },
    async ({ taskId }) => {
      const result = await bb.acceptTask(taskId);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'submit_result',
    {
      title: 'Submit Task Result',
      description: 'Submit the execution result for an accepted A2A task',
      inputSchema: {
        taskId: z.string().describe('Task ID'),
        output: z.string().describe('Result output text'),
      },
    },
    async ({ taskId, output }) => {
      const result = await bb.submitResult(taskId, { output });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

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
