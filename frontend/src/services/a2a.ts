import { get, authedGet, authedPost } from '../lib/api';

export interface AgentExecutor {
  address: string;
  displayName: string;
  capabilities: string[];
  agentCardUrl?: string;
  mcpEndpointUrl?: string;
  minReward?: string;
  preferredCapabilities?: string[];
  reputation: number;
  tasksCompleted: number;
  registeredAt: string;
}

export interface A2ATaskMeta {
  taskId: string;
  targetExecutorType: 'human' | 'agent';
  verificationMode: 'manual' | 'auto' | 'oracle' | 'agent';
  verificationCriteria?: {
    required_fields?: string[];
    min_length?: number;
    contains_keywords?: string[];
    acceptance?: string;
  };
  requiredCapabilities: string[];
  verifierAddress?: string;
}

export interface A2ATaskState {
  taskId: string;
  status: string;
  executorAddress?: string;
  acceptedAt?: string;
  submittedAt?: string;
  resultData?: Record<string, unknown>;
  verificationResult?: { passed: boolean; reasons: string[]; score?: number; breakdown?: Array<{ name: string; score: number; weight: number; reason: string; error?: string }>; errors?: Record<string, string>; teeVerified?: boolean };
}

export interface A2ATaskEntry {
  meta: A2ATaskMeta;
  state: A2ATaskState;
}

export async function registerAgent(data: {
  displayName: string;
  capabilities: string[];
  // Required by the backend — uncompressed secp256k1 hex (130 chars, leading
  // 04, no 0x). The dashboard derives this from a local executor identity.
  publicKey: string;
  agentCardUrl?: string;
  mcpEndpointUrl?: string;
  // Minimum reward as an integer string in the payment token's smallest unit. Agents below this threshold are
  // filtered out before scoring, so the agent never appears in the ranked list.
  minReward?: string;
}): Promise<{ agent: AgentExecutor }> {
  return authedPost<{ agent: AgentExecutor }>('/api/v1/a2a/register', data);
}

export async function browseAgentTasks(
  capabilities?: string[],
  minReputation?: number,
): Promise<{ tasks: A2ATaskEntry[]; total: number }> {
  const params = new URLSearchParams();
  if (capabilities?.length) params.set('capabilities', capabilities.join(','));
  if (minReputation !== undefined) params.set('minReputation', String(minReputation));
  // The route answers one page at a time (default 100, at most 200) with the
  // full match count in `total`. Asking once showed only the first 100 tasks
  // of a bigger board, so read every page.
  params.set('limit', String(BROWSE_PAGE_SIZE));
  const tasks: A2ATaskEntry[] = [];
  let total = 0;
  for (let page = 0; page < BROWSE_MAX_PAGES; page++) {
    params.set('offset', String(tasks.length));
    // Public route (no requireAuth on the backend) — use the unauthed get() so
    // first paint of the task list doesn't block on a Privy access token.
    const res = await get<{ tasks: A2ATaskEntry[]; total: number }>(`/api/v1/a2a/tasks?${params.toString()}`);
    tasks.push(...res.tasks);
    total = res.total;
    if (res.tasks.length === 0 || tasks.length >= total) break;
  }
  return { tasks, total };
}

/** GET /a2a/tasks caps `limit` at 200. */
const BROWSE_PAGE_SIZE = 200;
/** 10,000 tasks; past that the board needs real pagination, not one list. */
const BROWSE_MAX_PAGES = 50;

export async function acceptTask(taskId: string): Promise<{ taskId: string; status: string }> {
  return authedPost<{ taskId: string; status: string }>(`/api/v1/a2a/tasks/${taskId}/accept`, {});
}

export async function submitWork(
  taskId: string,
  resultData: Record<string, unknown>,
): Promise<{
  taskId: string;
  status: string;
  verificationResult: { passed: boolean; reasons: string[]; score?: number; breakdown?: Array<{ name: string; score: number; weight: number; reason: string; error?: string }>; errors?: Record<string, string> } | null;
}> {
  return authedPost(`/api/v1/a2a/tasks/${taskId}/submit`, { resultData });
}

export async function getExecutions(): Promise<{ executions: A2ATaskEntry[]; total: number }> {
  return authedGet<{ executions: A2ATaskEntry[]; total: number }>('/api/v1/a2a/executions');
}

export async function getProfile(): Promise<{ agent: AgentExecutor | null }> {
  // A wallet that hasn't registered as an executor is an expected state for
  // posters, not an error. `?optional=1` makes the backend answer
  // 200 { agent: null } instead of 404 — catching a 404 in JS never kept the
  // console clean, since the browser logs the failed request itself. The
  // catch stays for a backend that predates the flag.
  try {
    return await authedGet<{ agent: AgentExecutor | null }>('/api/v1/a2a/profile?optional=1');
  } catch (err: any) {
    if (err?.status === 404 && err?.code === 'NOT_REGISTERED') {
      return { agent: null };
    }
    throw err;
  }
}

/** List all A2A tasks the authenticated address has posted. Used by the
 *  poster's /a2a → to_review inbox to find tasks awaiting manual approval. */
export async function getPostedTasks(): Promise<{ tasks: A2ATaskEntry[]; total: number }> {
  return authedGet<{ tasks: A2ATaskEntry[]; total: number }>('/api/v1/a2a/tasks/posted');
}

/** Poster-only manual verify. Fires the settlement bridge on the backend so
 *  the marketplace signer's completeVerification(passed) tx releases escrow
 *  (passed=true) or returns it to the poster after the contract's retry
 *  budget (passed=false). */
export async function verifyTask(
  taskId: string,
  passed: boolean,
  reasons?: string[],
): Promise<{
  taskId: string;
  status: string;
  verificationResult: { passed: boolean; reasons: string[]; score?: number; breakdown?: Array<{ name: string; score: number; weight: number; reason: string; error?: string }>; errors?: Record<string, string> };
}> {
  return authedPost(`/api/v1/a2a/tasks/${taskId}/verify`, { passed, reasons });
}
