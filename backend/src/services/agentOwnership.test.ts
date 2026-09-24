import { describe, it, expect, vi } from 'vitest';
import type { DeployedAgent } from '../types.js';
import { principalAddresses, stripAgentSecrets } from './agentOwnership.js';

vi.mock('./a2aStore.js', () => ({
  getMeta: vi.fn(async () => ({ posterAddress: '0xposter' })),
  getState: vi.fn(async () => ({ executorAddress: '0xexecutor' })),
}));

import { assertTaskParticipant } from './taskParticipant.js';

/**
 * H1 regression: unauthenticated GET /agents and GET /agents/:id serve
 * stripAgentSecrets() output. Third-party credentials baked into agent
 * `tools` (literal http header values, MCP auth headers) must not survive
 * the projection — paginated public listing would otherwise harvest them.
 */
describe('stripAgentSecrets redacts tool-embedded secrets (H1)', () => {
  const agent = {
    id: 'a1', ownerAddress: '0xowner', name: 'A', instructions: 'x', provider: 'openai', model: 'm',
    apiKey: 'SECRET_LLM', encryptedApiKey: 'SECRET_ENC_API', capabilities: ['testing'],
    tools: [
      {
        type: 'http', name: 'crm', description: '', url: 'https://crm.example.com', method: 'GET',
        headers: [
          { name: 'Authorization', value: 'Bearer SECRET_CRM_TOKEN', isSensitive: true },
          // Unflagged values redact too — the flag is advisory, never a gate.
          { name: 'X-Tenant', value: 'SECRET_TENANT_ID', isSensitive: false },
        ],
      },
      {
        type: 'tool', name: 'mcp-tool', description: '',
        input_schema: { type: 'object', properties: {} },
        execution: { method: 'GET', url: 'https://mcp.example.com', param_mapping: {} },
        auth: { type: 'header', key_name: 'Authorization', secret_ref: 'mcp:token' },
        mcp_headers: { Authorization: 'Bearer SECRET_MCP_TOKEN' },
      },
    ],
    toolSecrets: { STRIPE: 'sk_live_SECRET_STRIPE' },
    encryptedToolSecrets: { STRIPE: 'SECRET_ENC_TOOL' },
    status: 'stopped', deployedAt: 't', walletAddress: '0xw', publicKey: '04',
    encryptedPrivateKey: 'SECRET_PRIV', rawPrivateKey: 'SECRET_RAW', platformToken: 'SECRET_JWT',
  } as unknown as DeployedAgent;

  it('leaks no credential string anywhere in the serialized output', () => {
    const text = JSON.stringify(stripAgentSecrets(agent));
    for (const secret of ['SECRET_LLM', 'SECRET_ENC_API', 'SECRET_PRIV', 'SECRET_RAW', 'SECRET_JWT',
      'SECRET_CRM_TOKEN', 'SECRET_TENANT_ID', 'SECRET_MCP_TOKEN',
      'SECRET_STRIPE', 'SECRET_ENC_TOOL']) {
      expect(text).not.toContain(secret);
    }
  });

  it('drops toolSecrets records and redacts header values with a stable placeholder', () => {
    const out = stripAgentSecrets(agent)!;
    expect('toolSecrets' in (out as Record<string, unknown>)).toBe(false);
    expect('encryptedToolSecrets' in (out as Record<string, unknown>)).toBe(false);
    const http = (out.tools as any[])[0];
    expect(http.headers).toEqual([
      { name: 'Authorization', value: '•••', isSensitive: true },
      { name: 'X-Tenant', value: '•••', isSensitive: false },
    ]);
    const mcp = (out.tools as any[])[1];
    expect(mcp.mcp_headers).toEqual({ Authorization: '•••' });
  });

  it('preserves non-secret tool shape (names, urls, key names)', () => {
    const out = stripAgentSecrets(agent)!;
    const http = (out.tools as any[])[0];
    expect(http.name).toBe('crm');
    expect(http.url).toBe('https://crm.example.com');
    expect(http.headers[0].name).toBe('Authorization');
    const mcp = (out.tools as any[])[1];
    expect(mcp.auth).toEqual({ type: 'header', key_name: 'Authorization', secret_ref: 'mcp:token' });
    expect(out.name).toBe('A');
    expect(out.walletAddress).toBe('0xw');
  });
});

/**
 * M6: a phished device-flow registration binds the victim's wallet as
 * ownerAddress on the ATTACKER's agent JWT. That claim must not unlock other
 * wallets' resources (deliverables, custody chains, deployed agents).
 * First-party worker tokens ('agent-platform', server-minted) keep the full
 * set — only the phishable flavor is scoped.
 */
describe('principalAddresses (M6 claim scoping)', () => {
  const VICTIM = '0xcccccccccccccccccccccccccccccccccccccccc';
  const ATTACKER_WALLET = '0xdddddddddddddddddddddddddddddddddddddddd';

  const fixated = {
    address: ATTACKER_WALLET,
    ownerAddress: VICTIM,
    typ: 'agent-registration',
  } as const;

  it('drops ownerAddress for device-flow (agent-registration) principals', () => {
    expect(principalAddresses(fixated as any)).toEqual([ATTACKER_WALLET.toLowerCase()]);
  });

  it('keeps the full set for first-party worker (agent-platform) tokens', () => {
    const addrs = principalAddresses({ ...fixated, typ: 'agent-platform' } as any);
    expect(addrs).toContain(VICTIM.toLowerCase());
    expect(addrs).toContain(ATTACKER_WALLET.toLowerCase());
  });

  it('keeps the full set for Privy / sk_ identities (no typ)', () => {
    const addrs = principalAddresses({ address: ATTACKER_WALLET, ownerAddress: VICTIM });
    expect(addrs).toContain(VICTIM.toLowerCase());
  });

  it('denies the fixated principal at the custody gate for a victim task', async () => {
    // Task posted by the victim, executed by someone else entirely.
    const { getMeta, getState } = await import('./a2aStore.js');
    vi.mocked(getMeta).mockResolvedValue({ posterAddress: VICTIM } as any);
    vi.mocked(getState).mockResolvedValue({ executorAddress: '0xexecutor' } as any);
    expect(await assertTaskParticipant('0xtask', fixated as any)).toBe(false);
  });

  it('still admits the executor wallet itself through the same gate', async () => {
    expect(
      await assertTaskParticipant('0xtask', { address: '0xexecutor', typ: 'agent-registration' } as any),
    ).toBe(true);
  });
});

describe('stripAgentSecrets with a malformed stored tools value (audit run 1, C22)', () => {
  it('returns the agent without tools instead of throwing', () => {
    for (const tools of [{}, 'x', 5]) {
      const agent = { id: 'agent-x', walletAddress: '0xabc', ownerAddress: '0xdef', tools } as unknown as DeployedAgent;
      expect(() => stripAgentSecrets(agent)).not.toThrow();
      expect(stripAgentSecrets(agent)!.tools).toBeUndefined();
    }
  });
});
