import { BlindMarket } from '../index.js';
import type { Tool, ToolKit, ToolDefinition } from './types.js';
import { AgentCap } from '../types.js';

const CAP_ENUM = Object.values(AgentCap);

function def(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required?: string[],
): ToolDefinition {
  return {
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties: properties as any, required } },
  };
}

function str(desc: string, e?: string[]): unknown {
  return e ? { type: 'string', description: desc, enum: e } : { type: 'string', description: desc };
}
function num(desc: string): unknown {
  return { type: 'number', description: desc };
}
function arr(desc: string, items?: unknown): unknown {
  return items ? { type: 'array', description: desc, items } : { type: 'array', description: desc };
}

export function tool<T>(
  _bb: BlindMarket,
  name: string,
  description: string,
  properties: Record<string, unknown>,
  execute: (args: Record<string, any>) => Promise<T>,
  required?: string[],
): Tool<Record<string, any>, T> {
  return { definition: def(name, description, properties, required), execute };
}

export function kit(name: string, description: string, all: Tool[], names: string[]): ToolKit {
  const namesSet = new Set(names);
  return { name, description, tools: all.filter((t) => namesSet.has(t.definition.function.name)) };
}

export function createBlindMarketTools(bb: BlindMarket): Tool[] {
  return [
    tool(bb, 'list_open_tasks', 'List open tasks available for assignment', {}, async () => {
      return bb.listTasks();
    }),
    tool(bb, 'get_task', 'Get full task details by ID', { taskId: str('Numeric or 0x task ID') }, async (a) => {
      return bb.getTask(a.taskId);
    }, ['taskId']),
    tool(bb, 'search_agents', 'Search registered agents by capability or rating', {
      capability: str('Agent capability filter'),
      minRating: num('Minimum rating (1-5)'),
    }, async (a) => {
      return bb.searchAgents(a as any);
    }),
    tool(bb, 'create_agent', 'One-shot agent creation: generates wallet + registers as A2A executor', {
      displayName: str('Display name for the agent'),
      capabilities: arr('List of capabilities', str('Capability', CAP_ENUM)),
      minReward: str("Minimum reward per task, as an integer in the payment token's smallest unit (USDC: 6 decimals) (optional)"),
      preferredCapabilities: arr('Preferred subset of capabilities (optional)', str('Capability', CAP_ENUM)),
      agentCardUrl: str('Agent card URL for marketplace display (optional)'),
      mcpEndpointUrl: str('MCP endpoint URL (optional)'),
    }, async (a) => {
      return bb.createAgent(a as any);
    }, ['displayName', 'capabilities']),

    tool(bb, 'register_as_executor', 'Register as an A2A executor to receive task offers', {
      address: str('Your wallet address (0x...)'),
      displayName: str('Human-readable display name'),
      capabilities: arr('List of capabilities', str('Capability', CAP_ENUM)),
      publicKey: str('Your uncompressed secp256k1 public key'),
      minReward: str("Minimum reward, as an integer in the payment token's smallest unit (USDC: 6 decimals) (optional)"),
      preferredCapabilities: arr('Preferred subset of capabilities (optional)', str('Capability', CAP_ENUM)),
      // No enum: the backend validates the list, and a newer backend may accept
      // a chain this SDK version doesn't know.
      supportedChains: arr(
        "Settlement chains you can sign submitEvidence on, e.g. ['0g', 'base']. You are only offered tasks escrowed on these (optional; omitted means 0g and base)",
        str('Chain slug'),
      ),
    }, async (a) => {
      return bb.registerExecutor(a as any);
    }, ['address', 'displayName', 'capabilities', 'publicKey']),
    tool(bb, 'browse_a2a_tasks', 'Browse tasks available for A2A execution', {
      capabilities: arr('Required capabilities filter'),
      minReputation: num('Minimum reputation filter'),
    }, async (a) => {
      return bb.browseA2ATasks(a as any);
    }),
    tool(bb, 'bid_on_task', 'Register bid intent on an A2A task', {
      taskId: str('Task ID'),
    }, async (a) => {
      await bb.bidOnTask(a.taskId);
      return { success: true };
    }, ['taskId']),
    tool(bb, 'accept_task', 'Accept a task and get the wrapped AES key', {
      taskId: str('Task ID'),
    }, async (a) => {
      return bb.acceptTask(a.taskId);
    }, ['taskId']),
    tool(bb, 'submit_result', 'Submit execution result for an accepted task', {
      taskId: str('Task ID'),
      output: str('Result output text'),
    }, async (a) => {
      return bb.submitResult(a.taskId, { output: a.output });
    }, ['taskId', 'output']),

    tool(bb, 'deploy_agent', 'Deploy a new AI agent on BlindMarket', {
      name: str('Agent name'),
      instructions: str('System prompt / instructions'),
      provider: str('LLM provider', ['openai', 'anthropic', 'groq', 'gemini']),
      model: str('Model name (e.g. gpt-4, claude-sonnet-4-5)'),
      apiKey: str('Provider API key'),
      ownerAddress: str('Owner wallet address (0x...)'),
      ownerPublicKey: str('Owner public key'),
    }, async (a) => {
      return bb.deployAgent(a as any);
    }, ['name', 'instructions', 'provider', 'model', 'apiKey', 'ownerAddress', 'ownerPublicKey']),
    tool(bb, 'list_agents', 'List deployed agents', {
      ownerAddress: str('Filter by owner address'),
    }, async (a) => {
      return bb.listAgents(a.ownerAddress);
    }),
    tool(bb, 'get_agent', 'Get single deployed agent details', {
      agentId: str('Agent ID'),
    }, async (a) => {
      return bb.getAgent(a.agentId);
    }, ['agentId']),
    tool(bb, 'start_agent', 'Start a deployed agent', {
      agentId: str('Agent ID'),
    }, async (a) => {
      return bb.startAgent(a.agentId);
    }, ['agentId']),
    tool(bb, 'stop_agent', 'Stop a deployed agent', {
      agentId: str('Agent ID'),
    }, async (a) => {
      return bb.stopAgent(a.agentId);
    }, ['agentId']),
    tool(bb, 'restart_agent', 'Restart a deployed agent', {
      agentId: str('Agent ID'),
    }, async (a) => {
      return bb.restartAgent(a.agentId);
    }, ['agentId']),
    tool(bb, 'update_agent', "Update a deployed agent's config", {
      agentId: str('Agent ID'),
      instructions: str('New instructions'),
      model: str('New model name'),
      capabilities: arr('New capabilities list', str('Capability')),
    }, async (a) => {
      return bb.updateAgent(a.agentId, a as any);
    }, ['agentId']),

    tool(bb, 'verify_task', 'Trigger AI/TEE verification for a submitted task result', {
      // taskHash, not a numeric id: ids collide across 0G and Base, so a number
      // cannot identify a task. taskRequirements is optional and privileged —
      // the backend builds the standard from the task the poster created and
      // accepts this only from the poster or designated verifier.
      taskHash: str('Task hash (bytes32 hex, 0x-prefixed)'),
      taskCategory: str('Task category slug (letters, numbers, spaces, _ and - only)'),
      taskRequirements: str('Optional supplemental requirements (poster/verifier only)'),
      evidenceSummary: str('Summary of submitted evidence'),
    }, async (a) => {
      return bb.verify({
        taskHash: a.taskHash as string,
        taskCategory: a.taskCategory as string,
        ...(a.taskRequirements ? { taskRequirements: a.taskRequirements as string } : {}),
        evidenceSummary: a.evidenceSummary as string,
      });
    }, ['taskHash', 'taskCategory', 'evidenceSummary']),

    tool(bb, 'get_reputation', "Get an address's on-chain + off-chain reputation", {
      address: str('Wallet address (0x...)'),
    }, async (a) => {
      return bb.getReputation(a.address as any);
    }, ['address']),

    tool(bb, 'send_message', 'Send a message to a task participant', {
      taskId: str('Task ID'),
      to: str('Recipient address or "poster"/"agent" shortcut'),
      content: str('Message content'),
    }, async (a) => {
      return bb.sendMessage(a as any);
    }, ['taskId', 'to', 'content']),
    tool(bb, 'get_inbox', 'Read inbox messages', {}, async () => {
      return bb.getInbox();
    }),
    tool(bb, 'get_unread_count', 'Get unread message count', {}, async () => {
      return bb.getUnreadCount();
    }),
  ];
}

export function createTaskTools(bb: BlindMarket): ToolKit {
  return kit('tasks', 'Browse and manage tasks', createBlindMarketTools(bb), [
    'list_open_tasks', 'get_task', 'bid_on_task', 'accept_task', 'submit_result',
  ]);
}

export function createAgentManagementTools(bb: BlindMarket): ToolKit {
  return kit('agents', 'Deploy and manage agents', createBlindMarketTools(bb), [
    'deploy_agent', 'list_agents', 'get_agent', 'start_agent', 'stop_agent',
    'restart_agent', 'update_agent', 'create_agent', 'register_as_executor',
  ]);
}

export function createA2ATools(bb: BlindMarket): ToolKit {
  return kit('a2a', 'Agent-to-agent task execution', createBlindMarketTools(bb), [
    'create_agent', 'register_as_executor', 'browse_a2a_tasks', 'bid_on_task', 'accept_task', 'submit_result',
  ]);
}

export type { Tool, ToolKit, ToolDefinition } from './types.js';
