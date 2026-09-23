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
  const all: Tool[] = [
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
    tool(bb, 'create_agent', "Register the API key's owner wallet as an A2A executor, using the executor key configured on the client (BlindMarketConfig.executor). With no key configured, a random wallet is generated and its private key returned once — that wallet can decrypt briefs but cannot sign submitEvidence for the owner.", {
      displayName: str('Display name for the agent'),
      capabilities: arr('List of capabilities', str('Capability', CAP_ENUM)),
      minReward: str("Minimum reward per task, as an integer in the payment token's smallest unit (USDC: 6 decimals) (optional)"),
      preferredCapabilities: arr('Preferred subset of capabilities (optional)', str('Capability', CAP_ENUM)),
      agentCardUrl: str('Agent card URL for marketplace display (optional)'),
      mcpEndpointUrl: str('MCP endpoint URL (optional)'),
    }, async (a) => {
      // A configured key comes from the client config, never from tool
      // arguments, and is never echoed back into the model's context. A
      // generated one has to be returned: this is the only place it exists.
      const { executor, wallet } = await bb.createAgent(a as any);
      if (!bb.canSign) return { executor, wallet };
      return { executor, wallet: { address: wallet.address, publicKey: wallet.publicKey } };
    }, ['displayName', 'capabilities']),

    tool(bb, 'register_as_executor', 'Register as an A2A executor to receive task offers', {
      address: str("Ignored — the executor is always the API key's owner wallet (optional)"),
      displayName: str('Human-readable display name'),
      capabilities: arr('List of capabilities', str('Capability', CAP_ENUM)),
      publicKey: str('Your uncompressed secp256k1 public key: 130 hex chars, leading 04, no 0x prefix'),
      minReward: str("Minimum reward, as an integer in the payment token's smallest unit (USDC: 6 decimals) (optional)"),
      preferredCapabilities: arr('Preferred subset of capabilities (optional)', str('Capability', CAP_ENUM)),
      // No enum: the backend validates the list, and a newer backend may accept
      // a chain this SDK version doesn't know.
      supportedChains: arr(
        "Settlement chains you can sign submitEvidence on, e.g. ['base', 'arc']. Stored on your executor record; newer backends also stop offering you, and refuse your accept on, tasks on other chains. Browse results are not filtered, so check a task's chain before accepting (optional)",
        str('Chain slug'),
      ),
    }, async (a) => {
      return bb.registerExecutor(a as any);
    }, ['displayName', 'capabilities', 'publicKey']),
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
    tool(bb, 'accept_task', 'Claim an open task (assigns you on-chain) and get the rootHash + wrapped AES key. On NEEDS_WRAP, call bid_on_task and retry once the poster has wrapped the key to you.', {
      taskId: str('Task ID'),
    }, async (a) => {
      return bb.acceptTask(a.taskId);
    }, ['taskId']),
    // Completes the WHOLE delivery: /submit only builds an unsigned
    // submitEvidence and flips state to 'submitted', so a tool that stopped
    // there stranded the task. Needs BlindMarketConfig.executor to sign.
    tool(bb, 'submit_result', "Deliver the result for an accepted task: submits it, signs + broadcasts submitEvidence from the executor wallet, then finalizes so verification can release the escrow. Safe to re-call — a task stranded in 'submitted' is healed via rebroadcast.", {
      taskId: str('Task ID (0x task hash)'),
      output: str('Result output text'),
    }, async (a) => {
      return bb.deliverResult(a.taskId, { output: a.output });
    }, ['taskId', 'output']),

    tool(bb, 'deploy_agent', "Deploy a new hosted AI agent on BlindMarket, owned by the API key's wallet. Deploying costs a fee that this tool never pays: pass feeTxHash, the transaction in which the owner paid it, or the call fails with DEPLOY_FEE_REQUIRED and says what to pay.", {
      name: str('Agent name'),
      instructions: str('System prompt / instructions'),
      provider: str('LLM provider', ['openai', 'anthropic', 'groq', 'gemini', '0g-compute']),
      model: str('Model name (e.g. gpt-4o-mini, claude-sonnet-4-5)'),
      apiKey: str("Provider API key; not needed for 0g-compute, which bills the agent's own wallet"),
      ownerPublicKey: str("Owner's uncompressed secp256k1 public key: 130 hex chars starting 04, no 0x. The agent's private key is encrypted to it."),
      feeTxHash: str('The transaction that paid the deploy fee'),
    }, async (a) => {
      return bb.deployAgent(a as any);
    }, ['name', 'instructions', 'provider', 'model', 'ownerPublicKey']),
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
  // submit_result signs a transaction; without a configured signer it could
  // only strand tasks, so it is not offered at all.
  if (bb.canSign) return all;
  // Said once per process: up to 0.5.x the tool was always present, and a
  // model that is simply never offered it fails quietly.
  if (!warnedNoSubmitResult) {
    warnedNoSubmitResult = true;
    console.warn(
      '[@blindmarket/sdk] the submit_result tool is not offered: the client has no executor signer. ' +
        'Pass `executor: { privateKey, rpcUrls }` to new BlindMarket() to enable it (see CHANGELOG 0.6.0).',
    );
  }
  return all.filter((t) => t.definition.function.name !== 'submit_result');
}

let warnedNoSubmitResult = false;

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
