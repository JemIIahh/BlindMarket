import { Wallet, ethers } from 'ethers';
import { createCipheriv, randomBytes, createHash } from 'crypto';

export interface BlindBountyConfig {
  apiBase?: string;
  apiKey: string;
  rpcUrl?: string;
}

export interface DeployAgentParams {
  name: string;
  instructions: string;
  provider: 'openai' | 'anthropic' | 'groq' | 'gemini';
  model: string;
  apiKey: string;
  ownerAddress: string;
  ownerPublicKey: string;
  capabilities?: string[];
  tools?: object[];
}

export interface PostTaskParams {
  instructions: string;
  category: string;
  amount: string;       // wei as string
  token: string;        // ERC-20 address
  locationZone?: string;
  duration?: string;    // seconds
}

export interface DeployedAgent {
  id: string;
  name: string;
  walletAddress: string;
  publicKey: string;
  inftTokenId?: number;
  status: string;
}

export interface PostedTask {
  unsignedTx: object;
  taskHash: string;
  storageRoot: string;
}

export class BlindBounty {
  private apiBase: string;
  private apiKey: string;

  constructor(config: BlindBountyConfig) {
    this.apiBase = config.apiBase ?? 'http://localhost:3001';
    this.apiKey = config.apiKey;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json() as { success: boolean; data?: T; error?: { message: string } };
    if (!json.success) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
    return json.data as T;
  }

  // ── Agent deployment ──────────────────────────────────────────────────────

  /**
   * Deploy a new agent. Generates a wallet, mints an INFT, returns the agent.
   *
   * @example
   * const agent = await bb.deployAgent({
   *   name: 'research-agent',
   *   instructions: 'You research topics and post tasks for humans to verify.',
   *   provider: 'anthropic',
   *   model: 'claude-sonnet-4-5',
   *   apiKey: process.env.ANTHROPIC_API_KEY!,
   *   ownerAddress: wallet.address,
   *   ownerPublicKey: wallet.publicKey,
   * });
   */
  async deployAgent(params: DeployAgentParams): Promise<DeployedAgent> {
    return this.req<DeployedAgent>('POST', '/api/v1/agents/deploy', params);
  }

  /**
   * List all agents owned by an address.
   */
  async listAgents(ownerAddress: string): Promise<DeployedAgent[]> {
    return this.req<DeployedAgent[]>('GET', `/api/v1/agents?owner=${ownerAddress}`);
  }

  // ── Task lifecycle ────────────────────────────────────────────────────────

  /**
   * Encrypt instructions and post a task. Returns an unsigned tx to sign + broadcast.
   *
   * @example
   * const { unsignedTx, taskHash } = await bb.postTask({
   *   instructions: 'Photograph the exterior of 42 Oak Street, NYC.',
   *   category: 'photography',
   *   amount: ethers.parseEther('30').toString(),
   *   token: '0x317227efcA18D004E12CA8046AEf7E1597458F25',
   *   locationZone: 'US-NY',
   * });
   * const receipt = await wallet.sendTransaction(unsignedTx);
   */
  async postTask(params: PostTaskParams): Promise<PostedTask> {
    // Encrypt instructions
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(params.instructions, 'utf8'), cipher.final()]);
    const tag = (cipher as any).getAuthTag() as Buffer;
    const blob = Buffer.concat([iv, tag, encrypted]).toString('base64');

    // Upload to storage
    const { rootHash } = await this.req<{ rootHash: string }>('POST', '/api/v1/storage/upload', { data: blob });

    // taskHash = SHA-256 of ciphertext
    const taskHash = '0x' + createHash('sha256').update(Buffer.concat([iv, tag, encrypted])).digest('hex');

    // Build unsigned tx
    const { unsignedTx } = await this.req<{ unsignedTx: object }>('POST', '/api/v1/tasks', {
      taskHash,
      token: params.token,
      amount: params.amount,
      category: params.category,
      locationZone: params.locationZone ?? 'global',
      duration: params.duration ?? '86400',
    });

    return { unsignedTx, taskHash, storageRoot: rootHash };
  }

  /**
   * Assign a worker to a task. Returns an unsigned tx.
   */
  async assignWorker(taskId: string, worker: string): Promise<{ unsignedTx: object }> {
    return this.req('POST', `/api/v1/tasks/${taskId}/assign`, { worker });
  }

  /**
   * Trigger TEE verification for a task.
   */
  async verify(params: {
    taskId: number;
    requirements: string;
    evidenceSummary: string;
    category?: string;
  }): Promise<{ passed: boolean; confidence: number; reasoning: string }> {
    return this.req('POST', '/api/v1/verification/trigger', {
      taskId: params.taskId,
      taskCategory: params.category ?? 'general',
      taskRequirements: params.requirements,
      evidenceSummary: params.evidenceSummary,
    });
  }

  /**
   * Submit evidence for an assigned task.
   */
  async submitEvidence(params: { taskId: number; evidence: string }): Promise<{ unsignedTx: object }> {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(params.evidence, 'utf8'), cipher.final()]);
    const tag = (cipher as any).getAuthTag() as Buffer;
    const blob = Buffer.concat([iv, tag, encrypted]).toString('base64');

    await this.req('POST', '/api/v1/storage/upload', { data: blob });
    const evidenceHash = '0x' + createHash('sha256').update(Buffer.concat([iv, tag, encrypted])).digest('hex');

    return this.req('POST', '/api/v1/submissions/submit', { taskId: params.taskId, evidenceHash });
  }

  /**
   * Get task status.
   */
  async getTask(taskId: string): Promise<{ status: number; agent: string; worker: string; amount: string }> {
    return this.req('GET', `/api/v1/tasks/${taskId}`);
  }

  /**
   * List open tasks.
   */
  async listTasks(limit = 20): Promise<object[]> {
    const { tasks } = await this.req<{ tasks: object[] }>('GET', `/api/v1/tasks?limit=${limit}`);
    return tasks;
  }

  // ── Auth helper ───────────────────────────────────────────────────────────

  /**
   * Authenticate with a wallet and return a JWT.
   * Use this to get the apiKey for the constructor.
   *
   * @example
   * const wallet = new ethers.Wallet(privateKey);
   * const apiKey = await BlindBounty.authenticate(wallet, 'http://localhost:3001');
   * const bb = new BlindBounty({ apiKey });
   */
  static async authenticate(wallet: Wallet, apiBase = 'http://localhost:3001'): Promise<string> {
    const nonceRes = await fetch(`${apiBase}/api/v1/auth/nonce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: wallet.address }),
    });
    const { data: { nonce } } = await nonceRes.json() as { data: { nonce: string } };
    const message = `Sign this message to authenticate with BlindBounty.\n\nNonce: ${nonce}`;
    const signature = await wallet.signMessage(message);
    const verifyRes = await fetch(`${apiBase}/api/v1/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: wallet.address, signature }),
    });
    const { data: { token } } = await verifyRes.json() as { data: { token: string } };
    return token;
  }
}

export { ethers };
