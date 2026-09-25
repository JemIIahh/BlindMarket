/**
 * Tool Error Log — tracks failed tool executions for owner investigation.
 *
 * When an agent's tool call fails (HTTP error, timeout, network error, etc.),
 * the worker reports it here. The owner can then view errors per-agent to
 * diagnose issues like dead API keys, rate limits, or service outages.
 */

export interface ToolErrorEntry {
  id: string;
  agentId: string;
  agentName: string;
  toolName: string;
  toolType: string;        // 'tool' | 'http' | 'mcp' | 'js' | 'sandbox'
  url: string;
  method: string;
  statusCode: number | null;  // null for network errors
  error: string;
  /** Truncated input args (max 2000 chars) */
  requestInput: string;
  /** Truncated response body (max 2000 chars) */
  responseOutput: string;
  durationMs: number;
  createdAt: string;
}

const MAX_ENTRIES = 2000;
// Each agent keeps its newest entries, so one agent's reports can't push other
// agents' entries out of the shared buffer (security audit run 1, C35).
const MAX_ENTRIES_PER_AGENT = 50;
const MAX_INPUT_CHARS = 2000;
const MAX_OUTPUT_CHARS = 2000;

const entries: ToolErrorEntry[] = [];
let nextId = 1;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export function reportToolError(entry: Omit<ToolErrorEntry, 'id' | 'createdAt'>): ToolErrorEntry {
  const record: ToolErrorEntry = {
    ...entry,
    requestInput: truncate(entry.requestInput, MAX_INPUT_CHARS),
    responseOutput: truncate(entry.responseOutput, MAX_OUTPUT_CHARS),
    id: String(nextId++),
    createdAt: new Date().toISOString(),
  };
  entries.unshift(record); // newest first
  let own = 0;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].agentId === record.agentId && ++own > MAX_ENTRIES_PER_AGENT) {
      entries.splice(i, 1); // this agent's oldest
      break;
    }
  }
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  return record;
}

export function getToolErrorLogs(opts: {
  agentId?: string;
  limit?: number;
  offset?: number;
} = {}): { entries: ToolErrorEntry[]; total: number } {
  let filtered = entries;
  if (opts.agentId) {
    filtered = filtered.filter(e => e.agentId === opts.agentId);
  }
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? 50;
  return {
    entries: filtered.slice(offset, offset + limit),
    total: filtered.length,
  };
}

export function clearToolErrorLogs(agentId?: string): number {
  if (!agentId) {
    const count = entries.length;
    entries.length = 0;
    return count;
  }
  const before = entries.length;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].agentId === agentId) entries.splice(i, 1);
  }
  return before - entries.length;
}
