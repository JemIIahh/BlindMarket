import { authedGet, authedPost } from '../lib/api';

export interface AgentExecutor {
  address: string;
  displayName: string;
  capabilities: string[];
  agentCardUrl?: string;
  mcpEndpointUrl?: string;
  reputation: number;
  tasksCompleted: number;
  registeredAt: string;
}

export interface A2ATaskMeta {
  taskId: string;
  targetExecutorType: 'human' | 'agent';
  verificationMode: 'manual' | 'auto' | 'oracle';
  verificationCriteria?: {
    required_fields?: string[];
    min_length?: number;
    contains_keywords?: string[];
  };
  requiredCapabilities: string[];
}

export interface A2ATaskState {
  taskId: string;
  status: string;
  executorAddress?: string;
  acceptedAt?: string;
  submittedAt?: string;
  resultData?: Record<string, unknown>;
  verificationResult?: { passed: boolean; reasons: string[] };
}

export interface A2ATaskEntry {
  meta: A2ATaskMeta;
  state: A2ATaskState;
}

export async function registerAgent(data: {
  displayName: string;
  capabilities: string[];
  agentCardUrl?: string;
  mcpEndpointUrl?: string;
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
  const qs = params.toString();
  return authedGet<{ tasks: A2ATaskEntry[]; total: number }>(
    `/api/v1/a2a/tasks${qs ? `?${qs}` : ''}`,
  );
}

export async function acceptTask(taskId: string): Promise<{ taskId: string; status: string }> {
  return authedPost<{ taskId: string; status: string }>(`/api/v1/a2a/tasks/${taskId}/accept`, {});
}

export async function submitWork(
  taskId: string,
  resultData: Record<string, unknown>,
): Promise<{
  taskId: string;
  status: string;
  verificationResult: { passed: boolean; reasons: string[] } | null;
}> {
  return authedPost(`/api/v1/a2a/tasks/${taskId}/submit`, { resultData });
}

export async function getExecutions(): Promise<{ executions: A2ATaskEntry[]; total: number }> {
  return authedGet<{ executions: A2ATaskEntry[]; total: number }>('/api/v1/a2a/executions');
}

export async function getProfile(): Promise<{ agent: AgentExecutor }> {
  return authedGet<{ agent: AgentExecutor }>('/api/v1/a2a/profile');
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
  verificationResult: { passed: boolean; reasons: string[] };
}> {
  return authedPost(`/api/v1/a2a/tasks/${taskId}/verify`, { passed, reasons });
}
