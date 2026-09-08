export interface AgentTool {
  type: string; name: string; description: string; url?: string; endpointUrl?: string; method?: string; toolName?: string;
  headers?: { name: string; value: string; isSensitive: boolean }[];
}

export interface InstalledSkillMeta {
  slug: string;
  name: string;
  version: string;
  capabilities?: string[];
}

export interface AgentDetails {
  id: string; name: string; provider: string; model: string; status: string;
  ownerAddress: string; deployedAt: string; instructions: string;
  walletAddress?: string; publicKey?: string; inftTokenId?: number;
  tasksCompleted?: number; totalEarned?: string; tools?: AgentTool[];
  capabilities?: string[];
  skills?: InstalledSkillMeta[];
  minReward?: string;
  apiKeyHint?: string | null;
  reputation?: { score: number; avgScore: number; tasksCompleted: number; disputes: number };
  decayedReputation?: { rawScore: number; decayedScore: number; tasksCompleted: number; disputes: number };
}

/** Per-skill settled track record (from /marketplace/skill-stats/:address). */
export interface SkillStat {
  capability: string;
  tasks_completed: number;
  tasks_failed: number;
}

export type AgentAction = 'start' | 'pause' | 'stop' | 'restart';
