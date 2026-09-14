import { describe, it, expect } from 'vitest';
import type { DeployedAgent } from '../types.js';
import { stripAgentSecrets } from './agentOwnership.js';

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
