import { get, authedGet, authedPost, authedPatch, authedDelete } from '../lib/api';

export interface AgentSearchResult {
  address: string;
  name: string;
  capabilities: string[];
  reputation: number;
  tasksCompleted: number;
  avgRating: number;
  totalReviews: number;
  badges: { capability: string; type: string }[];
  fromPrice: string | null; // min active service price (wei) for the "From" column
}

/** A rentable service listing (rent-your-agent Phase 1). `agent_*` fields are
 *  present only on the public projection. `price_raw` is per-call rent in wei. */
export interface AgentService {
  id: number;
  agent_address: string;
  owner_address: string;
  name: string;
  description: string;
  price_raw: string;
  service_type: 'api' | 'a2a';
  active: boolean;
  sold_count: number;
  avg_rating: number;
  created_at: string;
  updated_at: string;
  agent_name?: string | null;
  agent_capabilities?: string[] | null;
  agent_reputation?: number | null;
}

export interface AgentReview {
  id: number;
  task_id: string;
  agent_address: string;
  reviewer_address: string;
  rating: number;
  review: string | null;
  created_at: string;
}

export interface AgentReviewStats {
  avgRating: number;
  totalReviews: number;
  distribution: Record<number, number>;
}

export interface TaskTemplate {
  id: number;
  creator_address: string;
  name: string;
  description: string;
  required_capabilities: string[];
  verification_criteria: Record<string, unknown> | null;
  suggested_reward: string | null;
  is_public: boolean;
  use_count: number;
  created_at: string;
}

export interface AgentWebhook {
  id: number;
  url: string;
  events: string[];
  isActive: boolean;
}

export interface AgentBadge {
  id: number;
  agent_address: string;
  capability: string;
  badge_type: string;
  granted_at: string;
  expires_at: string | null;
}

export async function searchAgents(
  capability?: string,
  minRating?: number,
  limit?: number,
  page: number = 1,
  query?: string,
): Promise<{ agents: AgentSearchResult[]; total: number }> {
  const params = new URLSearchParams();
  if (capability) params.set('capability', capability);
  if (minRating !== undefined) params.set('minRating', String(minRating));
  if (limit !== undefined) params.set('limit', String(limit));
  if (page !== 1) params.set('page', String(page));
  if (query) params.set('q', query);
  const qs = params.toString();
  return get<{ agents: AgentSearchResult[]; total: number }>(
    `/api/v1/marketplace/agents/search${qs ? `?${qs}` : ''}`,
  );
}

export async function submitReview(data: {
  taskId: string;
  agentAddress: string;
  rating: number;
  review?: string;
}): Promise<AgentReview> {
  return authedPost<AgentReview>('/api/v1/marketplace/reviews', data);
}

export async function getAgentReviews(
  agentAddress: string,
  limit = 20,
  offset = 0,
): Promise<{ reviews: AgentReview[]; stats: AgentReviewStats }> {
  return get<{ reviews: AgentReview[]; stats: AgentReviewStats }>(
    `/api/v1/marketplace/reviews/${agentAddress}?limit=${limit}&offset=${offset}`,
  );
}

export async function getPublicTemplates(
  limit = 20,
  offset = 0,
): Promise<{ templates: TaskTemplate[]; total: number }> {
  return get<{ templates: TaskTemplate[]; total: number }>(
    `/api/v1/marketplace/templates?limit=${limit}&offset=${offset}`,
  );
}

export async function getMyTemplates(): Promise<TaskTemplate[]> {
  return authedGet<TaskTemplate[]>('/api/v1/marketplace/templates/mine');
}

export async function createTemplate(data: {
  name: string;
  description: string;
  requiredCapabilities?: string[];
  verificationCriteria?: Record<string, unknown>;
  suggestedReward?: string;
  isPublic?: boolean;
}): Promise<TaskTemplate> {
  return authedPost<TaskTemplate>('/api/v1/marketplace/templates', data);
}

export async function registerWebhook(data: {
  url: string;
  secret?: string;
  events?: string[];
}): Promise<{ id: number; url: string; events: string[]; secret: string }> {
  return authedPost('/api/v1/marketplace/webhooks', data);
}

export async function getWebhooks(): Promise<AgentWebhook[]> {
  return authedGet<AgentWebhook[]>('/api/v1/marketplace/webhooks');
}

export async function deleteWebhook(id: number): Promise<void> {
  await authedDelete(`/api/v1/marketplace/webhooks/${id}`);
}

export async function getAgentBadges(agentAddress: string): Promise<AgentBadge[]> {
  return get<AgentBadge[]>(`/api/v1/marketplace/badges/${agentAddress}`);
}

// ── Agent services (rent-your-agent Phase 1) ────────────────────────────────

/** Public: active services (all, or filtered to one agent's wallet address). */
export async function listServices(
  agentAddress?: string,
): Promise<{ services: AgentService[]; total: number }> {
  const qs = agentAddress ? `?agent=${encodeURIComponent(agentAddress)}` : '';
  return get<{ services: AgentService[]; total: number }>(`/api/v1/marketplace/services${qs}`);
}

/** Public: a single active service. */
export async function getService(id: number): Promise<AgentService> {
  return get<AgentService>(`/api/v1/marketplace/services/${id}`);
}

/** Owner: all services for an agent (including inactive). */
export async function getAgentServices(agentId: string): Promise<AgentService[]> {
  return authedGet<AgentService[]>(`/api/v1/agents/${agentId}/services`);
}

export async function createService(
  agentId: string,
  data: { name: string; description?: string; priceRaw: string; serviceType: 'api' | 'a2a'; active?: boolean },
): Promise<AgentService> {
  return authedPost<AgentService>(`/api/v1/agents/${agentId}/services`, data);
}

export async function updateService(
  agentId: string,
  serviceId: number,
  data: Partial<{ name: string; description: string; priceRaw: string; serviceType: 'api' | 'a2a'; active: boolean }>,
): Promise<AgentService> {
  return authedPatch<AgentService>(`/api/v1/agents/${agentId}/services/${serviceId}`, data);
}

export async function deleteService(agentId: string, serviceId: number): Promise<void> {
  await authedDelete(`/api/v1/agents/${agentId}/services/${serviceId}`);
}


