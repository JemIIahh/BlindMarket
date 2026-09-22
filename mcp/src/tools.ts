import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BlindMarket, AgentCapability } from '@blindmarket/sdk';
import type { WalletCtx } from './wallet.js';
import type { Settlement } from './settlement.js';

type ToolResult = { isError?: boolean; content: Array<{ type: 'text'; text: string }> };

/**
 * `settlement` is rent.ts's resolver. An executor registered from this process
 * delivers through complete_task, which settles on that one chain (the
 * backend's posting chain, or the one BLINDMARKET_SETTLEMENT names), so that
 * is the only chain it declares. Declaring more would get it offered tasks it
 * cannot deliver on a backend that filters by the list; declaring nothing is
 * read as 0G+Base there and stored as ['0g'] by older backends — wrong either
 * way for a one-chain process.
 */
export function registerMarketTools(
  server: McpServer,
  bb: BlindMarket,
  walletCtx: WalletCtx | null = null,
  settlement?: () => Promise<Settlement>,
): void {
  async function declaredChains(tool: string): Promise<{ supportedChains: string[] | undefined; warning?: string } | { error: ToolResult }> {
    if (!settlement) return { supportedChains: undefined };
    try {
      const s = await settlement();
      return {
        supportedChains: [s.mode],
        ...(s.payment === 'local-native' && !walletCtx
          ? { warning: `Declared ${s.mode}, but complete_task delivers on 0G from BLINDMARKET_PRIVATE_KEY, which is not set: tasks accepted there cannot be delivered from this process until it is.` }
          : {}),
      };
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'SETTLEMENT_UNKNOWN';
      const message = `${tool} declares the chain this process can deliver on (the backend's posting chain, or the one BLINDMARKET_SETTLEMENT names), and could not learn it: ${(err as Error).message}`;
      return { error: { isError: true, content: [{ type: 'text', text: JSON.stringify({ success: false, error: { code, message } }) }] } };
    }
  }

  // ── Health & Stats ────────────────────────────────────────────────────

  server.registerTool(
    'health',
    {
      title: 'Health Check',
      description: 'Check that the BlindMarket backend this server talks to is up: returns its status and server time. It does not check settlement readiness (escrows, signers), so use it to tell an outage apart from a request that failed for its own reasons.',
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
      description: 'Get live platform totals: open tasks in the legacy 0G TaskRegistry, active and deployed agents, registered users, completed tasks, and the volume processed through escrow in the pricing unit (USDC). Public and read-only; for work you can take, use browse_a2a_tasks.',
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
      description: 'List open tasks from the legacy 0G TaskRegistry (numeric ids on the 0G escrow), up to limit (max 50), each flagged a2aIndexed when agents can reach it. Tasks escrowed on Base or Arc are not in this list: use browse_a2a_tasks to find work you can take.',
      inputSchema: {
        limit: z.number().optional().describe('Maximum number of tasks to return (default 20, max 50)'),
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
      description: "Get one task: its on-chain escrow record (status 0 Funded, 1 Assigned, 2 Submitted, 3 failed verification, 4 Completed, 5 Cancelled, 6 Disputed; reward, deadline, poster and worker), the reward's unit, and its marketplace state. Prefer the 0x task hash, which resolves to whichever chain holds the task; a numeric id is read on the chain new tasks are posted on, and ids repeat across chains. The deliverable (resultData) is included only for the task's poster or worker, or when the task is public.",
      inputSchema: {
        taskId: z.string().describe('Task hash (0x-prefixed bytes32, preferred) or numeric escrow id'),
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
      description: "List open agent-to-agent tasks you could execute, with public metadata only (such as the task's chain, deadline, required capabilities and verification mode, plus the brief itself for a public task), never an encrypted brief or anyone's wrapped key; tasks past their deadline are left out. With capabilities, a task is kept only if every capability it requires is in your list (tasks requiring none are always kept). Results are not filtered by chain, so check each task's chain against the one this process delivers on (wallet_status) before accept_task.",
      inputSchema: {
        capabilities: z.string().optional().describe('Comma-separated capability filter (e.g. "data_processing,web_research")'),
        minReputation: z.number().optional().describe('Accepted for compatibility; ignored by the backend'),
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
      description: "Register as an A2A executor using the local wallet (BLINDMARKET_PRIVATE_KEY): derives its uncompressed public key and registers it. The executor is always the wallet that owns BLINDMARKET_API_KEY, so on 0G the two must be the same wallet (checked — a mismatch is refused). No wallet is generated and no key is returned. On Base with a Privy owner wallet, use register_as_executor with wallet_status's executorPublicKey instead.",
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
      const result = { executor, wallet: { address: wallet.address, publicKey: wallet.publicKey }, ...(chains.warning ? { warning: chains.warning } : {}) };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'register_as_executor',
    {
      title: 'Register as Executor',
      description: "Register as an A2A executor. The executor address is always the wallet that owns BLINDMARKET_API_KEY; publicKey is the key briefs get wrapped to (wallet_status reports the local one as executorPublicKey). Declares the one chain this process delivers on (the chain the backend posts new tasks on, or BLINDMARKET_SETTLEMENT's — wallet_status shows it); a backend that filters by it then offers only tasks it can complete.",
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
      const body = chains.warning ? { ...result, warning: chains.warning } : result;
      return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
    },
  );

  server.registerTool(
    'list_agents',
    {
      title: 'List Agents',
      description: "List agents hosted on BlindMarket with their public profile (name, provider and model, status, capabilities); keys and secrets are never included. Returns the first 20; pass ownerAddress to see one owner's agents. Agents that take tasks from elsewhere (SDK, MCP) are not hosted here, so use search_agents to find agents to hire.",
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
      description: "Get one hosted agent's public profile by its agent id (from list_agents): status, provider and model, capabilities, wallet address and on-chain identity. Keys and secrets are never included.",
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
      description: "Register interest in an open A2A task whose brief key has not been wrapped to you, so the poster can wrap it to your public key; accept_task then succeeds. Use it when accept_task answers NEEDS_WRAP. Idempotent. Refused for your own task, before you have registered as an executor with a public key, or when your registration does not include the task's chain (CHAIN_UNSUPPORTED).",
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
      description: "Ask the platform's AI verifier (0G Compute, in a TEE) for a verdict on a submitted result: returns passed, confidence, reasoning, the model used and whether the run was TEE-attested. It does not settle the escrow or change the task; settlement follows the task's verification mode. Only the task's poster, designated verifier or assigned executor may call it, only the poster or verifier may add taskRequirements, and calls are rate-limited because each one runs a paid inference.",
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
      description: "Get an address's reputation: its on-chain BlindReputation record and the platform's decayed score, which halves for every 7 days since the address's last task. Use it to vet an agent before relying on its work.",
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
      description: 'Get the top workers ranked by reputation score, up to limit (default 50). For agents with a particular capability, use search_agents.',
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
      description: "Search agents registered to take marketplace tasks, by capability tag and optionally a minimum average review rating. Returns the 20 most recently registered matches, each with its address, name, capabilities, reputation, average rating, earned badges and lowest service price; use it to find an agent to hire or delegate to.",
      inputSchema: {
        capability: z.string().optional().describe('Capability filter'),
        minRating: z.number().optional().describe("Minimum average review rating from posters' reviews (1-5)"),
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
      description: 'Send a message on a task to another participant. to is a wallet address, or the shortcut "poster" (the task\'s poster) or "agent" (its assigned executor), which need taskId. The recipient reads it in their BlindMarket inbox; replies arrive in get_inbox.',
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
      description: "Read the messages sent to the wallet behind your API key, across all tasks, with each message's sender and task. Check it after send_message to read replies.",
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
      description: 'Start one of your hosted agents (owner only). On start it re-registers as an executor, resumes any task still assigned to it, and begins taking tasks, paying gas from its own wallet, so fund that wallet on the settlement chain first. Returns the agent\'s updated record.',
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
      description: 'Stop one of your hosted agents (owner only): its process ends and it takes no new tasks until started again, when it resumes any task still assigned to it. Returns the agent\'s updated record.',
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
      description: 'Freeze one of your hosted agents in place (owner only). Unlike stop_agent it keeps the process and any task it holds, doing nothing until brought back; restart_agent brings it back as a fresh process. Fails if the agent is not running.',
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
      description: 'Stop and start one of your hosted agents (owner only), for example to pick up a changed configuration. Returns the agent\'s updated record.',
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
