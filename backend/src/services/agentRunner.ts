import { fork, type ChildProcess } from 'child_process';
import { randomUUID, createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { Wallet } from 'ethers';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { eciesEncrypt, generateKeyPair } from './crypto.js';
import { inft } from './chain.js';
import {
  saveAgent, loadAgent, loadAllAgents,
  appendLog, getLogs, subscribeAgentLogs as redisSubscribe,
  touchHeartbeat,
} from './redis.js';
import type { DeployedAgent, AgentCapability, AgentStatus, LLMProvider, AgentTool } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, '../../agents/worker.js');

// Running child processes (in-memory only — processes don't survive restarts)
const processes = new Map<string, ChildProcess>();

// ── Logs ─────────────────────────────────────────────────────────────────────

export async function getAgentLogs(id: string): Promise<string[]> {
  return getLogs(id);
}

export async function subscribeAgentLogs(
  id: string,
  cb: (line: string) => void,
): Promise<() => void> {
  return redisSubscribe(id, cb);
}

// ── Deploy ────────────────────────────────────────────────────────────────────

export async function deployAgent(params: {
  ownerAddress: string;
  ownerPublicKey: string;
  name: string;
  instructions: string;
  provider: LLMProvider;
  model: string;
  apiKey: string;
  capabilities: AgentCapability[];
  tools?: AgentTool[];
  storageRef?: string;
}): Promise<DeployedAgent> {
  const { privateKey, publicKey } = generateKeyPair();
  const walletAddress = new Wallet(`0x${privateKey}`).address;

  const encryptedPrivateKey = eciesEncrypt(
    Buffer.from(privateKey, 'hex'),
    params.ownerPublicKey,
  ).toString('hex');

  const encryptedApiKey = eciesEncrypt(
    Buffer.from(params.apiKey, 'utf8'),
    params.ownerPublicKey,
  ).toString('hex');

  let inftTokenId: number | undefined;
  if (inft) {
    try {
      const metadataHash = `0x${createHash('sha256').update(walletAddress + publicKey).digest('hex')}` as `0x${string}`;
      const tx = await (inft as any).mint(params.ownerAddress, '', metadataHash);
      const receipt = await tx.wait();
      const event = receipt?.logs?.find((l: any) => {
        try { return (inft as any).interface.parseLog(l)?.name === 'INFTMinted'; } catch { return false; }
      });
      if (event) {
        inftTokenId = Number((inft as any).interface.parseLog(event)?.args?.tokenId);
      }
    } catch (e) {
      console.warn('INFT mint failed (non-fatal):', (e as Error).message);
    }
  }

  const platformToken = jwt.sign(
    { address: walletAddress, ownerAddress: params.ownerAddress.toLowerCase(), agentName: params.name },
    config.jwtSecret,
    { algorithm: 'HS256', expiresIn: '365d' } as jwt.SignOptions,
  );

  const agent: DeployedAgent = {
    id: randomUUID(),
    ownerAddress: params.ownerAddress,
    name: params.name,
    instructions: params.instructions,
    provider: params.provider,
    model: params.model,
    apiKey: params.apiKey,       // kept in memory for worker env; not persisted to Redis
    encryptedApiKey,
    capabilities: params.capabilities,
    tools: params.tools ?? [],
    status: 'stopped',
    deployedAt: new Date().toISOString(),
    walletAddress,
    publicKey,
    encryptedPrivateKey,
    rawPrivateKey: privateKey,
    inftTokenId,
    storageRef: params.storageRef,
    platformToken,
  };

  await saveAgent(agent);
  return agent;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export async function startAgent(id: string): Promise<void> {
  const agent = await loadAgent(id);
  if (!agent) throw new Error(`Agent ${id} not found`);
  if (processes.has(id)) return;

  // Migration: Generate platform token if missing
  if (!agent.platformToken) {
    if (!config.jwtSecret) {
      console.error('[agentRunner] Cannot start agent: JWT_SECRET not configured');
      throw new Error('Server configuration error: JWT_SECRET missing');
    }
    agent.platformToken = jwt.sign(
      { address: agent.walletAddress, ownerAddress: agent.ownerAddress.toLowerCase(), agentName: agent.name },
      config.jwtSecret,
      { algorithm: 'HS256', expiresIn: '365d' } as jwt.SignOptions,
    );
    await saveAgent(agent);
    console.log(`[agentRunner] Generated missing platform token for agent ${id}`);
  }

  const child = fork(WORKER_PATH, [], {
    env: {
      ...process.env,
      AGENT_ID: agent.id,
      AGENT_NAME: agent.name,
      AGENT_INSTRUCTIONS: agent.instructions,
      AGENT_PROVIDER: agent.provider,
      AGENT_MODEL: agent.model,
      AGENT_API_KEY: agent.apiKey,
      AGENT_PLATFORM_TOKEN: agent.platformToken,
      AGENT_WALLET: agent.walletAddress,
      AGENT_PRIVATE_KEY: agent.rawPrivateKey ?? '',
      // Worker passes this to /a2a/register so posters can ECIES-wrap the AES
      // key to it at task-creation time. Same format the backend ECIES expects:
      // uncompressed secp256k1 hex, no 0x prefix.
      AGENT_PUBLIC_KEY: agent.publicKey ?? '',
      OG_RPC_URL: config.ogRpcUrl,
      OG_CHAIN_ID: String(config.ogChainId),
      // Escrow proxy address — the verifier role (verificationMode='agent')
      // signs completeVerification directly against this contract.
      AGENT_ESCROW_ADDRESS: config.blindEscrowAddress,
      BACKEND_URL: `http://localhost:${config.port}`,
      AGENT_TOOLS: JSON.stringify(agent.tools ?? []),
      AGENT_CAPABILITIES: JSON.stringify(agent.capabilities ?? []),
    },
    silent: true,
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    chunk.toString().split('\n').filter(Boolean).forEach(line => appendLog(id, line));
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    chunk.toString().split('\n').filter(Boolean).forEach(line => appendLog(id, `[err] ${line}`));
  });

  child.on('message', async (msg: unknown) => {
    if (typeof msg === 'object' && msg !== null && (msg as any).type === 'heartbeat') {
      await touchHeartbeat(id);
      const a = await loadAgent(id);
      if (a) {
        a.lastActiveAt = new Date().toISOString();
        await saveAgent(a);
      }
    }
  });

  child.on('exit', async () => {
    processes.delete(id);
    const a = await loadAgent(id);
    if (a && a.status === 'running') {
      a.status = 'stopped';
      await saveAgent(a);
    }
  });

  processes.set(id, child);
  agent.status = 'running';
  await saveAgent(agent);
}

export async function pauseAgent(id: string): Promise<void> {
  const child = processes.get(id);
  if (!child) throw new Error(`Agent ${id} is not running`);
  child.kill('SIGSTOP');
  const agent = await loadAgent(id);
  if (agent) { agent.status = 'paused'; await saveAgent(agent); }
}

export async function stopAgent(id: string): Promise<void> {
  const child = processes.get(id);
  if (child) { child.kill('SIGTERM'); processes.delete(id); }
  const agent = await loadAgent(id);
  if (agent) { agent.status = 'stopped'; await saveAgent(agent); }
}

export async function getAgent(id: string): Promise<DeployedAgent | undefined> {
  return (await loadAgent(id)) ?? undefined;
}

export async function listAgents(ownerAddress?: string): Promise<DeployedAgent[]> {
  const all = await loadAllAgents();
  return ownerAddress ? all.filter(a => a.ownerAddress === ownerAddress) : all;
}

export async function updateAgent(id: string, patch: Partial<Pick<DeployedAgent, 'instructions' | 'model' | 'tools' | 'capabilities'>>): Promise<DeployedAgent | undefined> {
  const agent = await loadAgent(id);
  if (!agent) return undefined;
  // Strip undefined values before merging. Callers can send a subset of the
  // patch keys (e.g. the EDIT tab on AgentDetail only sends instructions +
  // model), and {...agent, ...patch} with `patch.capabilities === undefined`
  // would overwrite the existing array with undefined → JSON.stringify drops
  // the field → next worker spawn reads `agent.capabilities ?? []` as [] →
  // worker defaults to ['data_processing']. Same hazard for tools. Surfaced
  // as "agent registered with caps=data_processing even though I picked
  // code_review" after the user edited the prompt on a deployed agent.
  const cleanPatch: typeof patch = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (cleanPatch as Record<string, unknown>)[k] = v;
  }
  const updated = { ...agent, ...cleanPatch };
  await saveAgent(updated);
  return updated;
}
