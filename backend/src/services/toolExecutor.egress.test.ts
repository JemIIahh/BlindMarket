import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { executeTool, validateToolDefinition } from './toolExecutor.js';
import type { ToolDefinition } from '../types.js';

/**
 * /tools/test and /tools/execute call executeTool with a caller-supplied URL.
 * It must not reach host-internal services (security audit run 1, C02).
 */

function toolFor(url: string): ToolDefinition {
  return {
    name: 'probe',
    description: 'probe',
    input_schema: { type: 'object', properties: {} },
    auth: { type: 'none' },
    execution: { method: 'GET', url, param_mapping: {} },
  } as unknown as ToolDefinition;
}

describe('executeTool destination guard', () => {
  let server: Server;
  let port = 0;
  let hits = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits++;
      res.writeHead(200).end('INTERNAL-ONLY-MARKER');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('refuses a loopback URL and never contacts it', async () => {
    const before = hits;
    for (const url of [`http://127.0.0.1:${port}/internal`, `http://localhost:${port}/internal`]) {
      const result = await executeTool(toolFor(url), {}, {});
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/private, loopback or link-local/);
      expect(JSON.stringify(result)).not.toContain('INTERNAL-ONLY-MARKER');
    }
    expect(hits).toBe(before);
  });

  it('validation rejects metadata, private and non-http destinations', () => {
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5:6379/', 'file:///etc/passwd']) {
      expect(validateToolDefinition(toolFor(url)).some((e) => e.startsWith('execution.url'))).toBe(true);
    }
    expect(validateToolDefinition(toolFor('https://api.example.com/{q}')).some((e) => e.startsWith('execution.url'))).toBe(false);
  });
});
