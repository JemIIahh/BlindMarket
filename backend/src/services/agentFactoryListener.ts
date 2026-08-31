/**
 * AgentFactory event listener — watches for AgentDeployed events on Base
 * and creates agent records. Backend never signs for agents (decentralized).
 *
 * Flow:
 * 1. User calls AgentFactory.deployAgent() on Base (pays USDC)
 * 2. Contract emits AgentDeployed event
 * 3. This listener picks it up, creates agent record
 * 4. Agent signs its own 0G transactions
 */
import { ethers } from 'ethers';
import { config } from '../config.js';
import { baseProvider } from './chain.js';
import { deployAgent } from './agentRunner.js';
import { skillStore } from './skillStore.js';

const AGENT_FACTORY_ABI = [
  'event AgentDeployed(address indexed user, uint256 usdcAmount, uint256 nonce, uint256 timestamp)',
];

const AGENT_FACTORY_ADDRESSES: Record<number, string> = {
  8453: process.env.AGENT_FACTORY_ADDRESS || '',
  84532: process.env.AGENT_FACTORY_ADDRESS || '',
};

let contract: ethers.Contract | null = null;
let lastBlock = 0;

export function startAgentFactoryListener() {
  if (!baseProvider) {
    console.log('[agentFactory] no Base provider — listener disabled');
    return;
  }

  const chainId = Number(baseProvider._network?.chainId || 0);
  const factoryAddress = AGENT_FACTORY_ADDRESSES[chainId];

  if (!factoryAddress) {
    console.log('[agentFactory] AGENT_FACTORY_ADDRESS not set — listener disabled');
    return;
  }

  contract = new ethers.Contract(factoryAddress, AGENT_FACTORY_ABI, baseProvider);

  // Start from recent block (don't scan entire history on boot)
  baseProvider.getBlockNumber().then((bn) => {
    lastBlock = bn - 100; // last ~20 blocks
    console.log(`[agentFactory] listening on ${factoryAddress} from block ${lastBlock}`);
  });

  // Poll every 15s for new events (simpler than websocket for now)
  setInterval(pollEvents, 15_000);
}

async function pollEvents() {
  if (!contract) return;

  try {
    const currentBlock = await baseProvider!.getBlockNumber();
    if (currentBlock <= lastBlock) return;

    const events = await contract.queryFilter(
      'AgentDeployed',
      lastBlock + 1,
      currentBlock
    );

    for (const event of events) {
      await handleAgentDeployed(event);
    }

    lastBlock = currentBlock;
  } catch (e) {
    console.error('[agentFactory] poll error:', (e as Error).message);
  }
}

async function handleAgentDeployed(event: ethers.EventLog) {
  const { user, usdcAmount, nonce, timestamp } = event.args as any;
  console.log(`[agentFactory] AgentDeployed: user=${user} amount=${usdcAmount} nonce=${nonce}`);

  try {
    // Create agent with default config
    // In production, user would pass agent config via IPFS hash or similar
    await deployAgent({
      ownerAddress: user,
      ownerPublicKey: '', // Will be updated when agent first connects
      name: `agent-${nonce}`,
      instructions: 'You are an autonomous agent on BlindMarket. Complete tasks to earn USDC.',
      provider: '0g-compute' as any,
      model: 'deepseek-ai/DeepSeek-V3.1',
      apiKey: '',
      capabilities: ['data_processing' as any],
    });

    console.log(`[agentFactory] agent created for user=${user}`);
  } catch (e) {
    console.error(`[agentFactory] failed to create agent:`, (e as Error).message);
  }
}
