import type { AgentTool, DeployedAgent, InstalledSkill } from '../types.js';

/**
 * Shared ownership predicate for deployed agents. Owner set = the original
 * wagmi deploy wallet (ownerAddress) plus any signature-linked wallets
 * (authorizedOwners, added via POST /agents/:id/link-owner).
 *
 * Used by both the REST routes (agents.ts authorizeOwner) and the MCP tool
 * surface (services/mcp/tools.ts) so the two gates cannot drift apart.
 */
export function isAgentOwner(agent: DeployedAgent, candidateAddresses: Array<string | undefined>): boolean {
  const ownerSet = new Set(
    [agent.ownerAddress, ...(agent.authorizedOwners ?? [])].map((a) => a.toLowerCase()),
  );
  return candidateAddresses.some(
    (a) => typeof a === 'string' && a !== 'agent' && ownerSet.has(a.toLowerCase()),
  );
}

/** An installed skill projected to its PUBLIC identity — no prompt/tools/secrets. */
export type PublicInstalledSkill = Pick<InstalledSkill, 'skillId' | 'slug' | 'name' | 'version' | 'capabilities' | 'source' | 'installedAt'>;

/**
 * Strip every secret-bearing field from a DeployedAgent record before it
 * leaves the backend. Single definition shared by agents.ts strip() and the
 * MCP tools, so a newly added secret field only needs stripping in one place.
 *
 * Installed-skill snapshots are ALSO projected here to their public identity
 * (slug/name/version/capabilities). Their `instructions` are the skill's
 * prompt (author IP), `tools` can carry `mcp_headers` with baked credentials,
 * and `secretRefs` name the secret slots — none of which may leak through the
 * UNAUTHENTICATED GET /agents(/:id). No client needs the full snapshot from
 * the API (the worker reads it straight from the DB), so this is safe for
 * owner and non-owner alike; skill authors manage full content via the
 * author-gated /skills routes.
 */
const REDACTED = '•••';

function redactTools(tools: AgentTool[] | undefined): AgentTool[] | undefined {
  if (!tools) return undefined;
  return tools.map((t) => {
    if (!t || typeof t !== 'object') return t;
    const rec = t as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = { ...rec };
    // Legacy http tools carry literal header VALUES (the isSensitive flag is
    // stored, never honored on read) — redact every value, not just flagged
    // ones, so a mis-flagged secret can't slip through.
    if (Array.isArray(rec.headers)) {
      out.headers = (rec.headers as Array<Record<string, unknown>>).map((h) =>
        h && typeof h === 'object' ? { ...h, value: REDACTED } : h,
      );
    }
    // MCP-imported ToolDefinitions carry baked auth headers (mcpClient bakes
    // the live credentials at import). Same redaction as the /skills display
    // surfaces — predictable placeholder, key names preserved for debugging.
    if (rec.mcp_headers && typeof rec.mcp_headers === 'object') {
      out.mcp_headers = Object.fromEntries(
        Object.keys(rec.mcp_headers as Record<string, string>).map((k) => [k, REDACTED]),
      );
    }
    return out as unknown as AgentTool;
  });
}

export function stripAgentSecrets<T extends DeployedAgent>(agent: T | null | undefined) {
  if (!agent) return null;
  const {
    encryptedPrivateKey: _a, encryptedApiKey: _b, apiKey: _c, rawPrivateKey: _d, platformToken: _e,
    toolSecrets: _f, encryptedToolSecrets: _g,
    ...safe
  } = agent;
  const publicSkills: PublicInstalledSkill[] | undefined = safe.skills?.map((s) => ({
    skillId: s.skillId,
    slug: s.slug,
    name: s.name,
    version: s.version,
    capabilities: s.capabilities,
    source: s.source,
    installedAt: s.installedAt,
  })) as PublicInstalledSkill[] | undefined;
  return { ...safe, skills: publicSkills, tools: redactTools(safe.tools) };
}
