import { describe, it, expect, vi } from 'vitest';

/**
 * Unit tests for the public projections added in the security closeout. These
 * are the functions that keep brief key material (wrappedKeys, keyCustodyBlob,
 * rootHash) and operator-internal diagnostics (assignError, verifyError) off
 * unauthenticated discovery surfaces (REST browse, JSON-RPC tasks/list &
 * tasks/get, REST task detail, cross-address /executions). The closeout's
 * security claim rests on these stripping fields at RUNTIME, not just in types.
 *
 * a2aStore imports redis at module load; the projections are pure, so a stub
 * redis is enough to import the real (unmocked) functions.
 */
vi.mock('./redis.js', () => ({
  redis: { get: vi.fn(), set: vi.fn(), pipeline: vi.fn(), smembers: vi.fn(), eval: vi.fn() },
}));

import { projectPublicMeta, projectPublicState, projectPublicEntry } from './a2aStore.js';

const fullMeta = {
  taskId: '0xtask',
  targetExecutorType: 'agent' as const,
  verificationMode: 'auto' as const,
  requiredCapabilities: ['web_research' as const],
  posterAddress: '0xposter',
  verifierAddress: '0xverifier',
  rootHash: '0xroot',
  wrappedKeys: { '0xagent': 'deadbeefslice' },
  keyCustodyBlob: { keyId: 'kid', blob: 'abcd' },
  deadline: 123,
};

const fullState = {
  taskId: '0xtask',
  status: 'submitted' as const,
  executorAddress: '0xagent',
  resultData: { output: 'the secret deliverable' },
  assignError: 'revert: NotVerifier 0x24663556 (rpc fragment)',
  verifyError: 'revert: InvalidStatus',
  assignTxHash: '0xtx',
};

describe('projectPublicMeta', () => {
  it('strips all three key-material fields at runtime', () => {
    const pub = projectPublicMeta(fullMeta as any);
    expect('wrappedKeys' in pub).toBe(false);
    expect('keyCustodyBlob' in pub).toBe(false);
    expect('rootHash' in pub).toBe(false);
  });

  it('preserves non-sensitive discovery fields', () => {
    const pub = projectPublicMeta(fullMeta as any);
    expect(pub.taskId).toBe('0xtask');
    expect(pub.requiredCapabilities).toEqual(['web_research']);
    expect(pub.posterAddress).toBe('0xposter');
    expect(pub.verifierAddress).toBe('0xverifier');
    expect(pub.deadline).toBe(123);
  });

  it('exposes hasEncryptedBrief from rootHash presence', () => {
    expect(projectPublicMeta(fullMeta as any).hasEncryptedBrief).toBe(true);
    const { rootHash: _r, ...noRoot } = fullMeta;
    expect(projectPublicMeta(noRoot as any).hasEncryptedBrief).toBe(false);
  });

  it('does not mutate the source object (store cache safety)', () => {
    const src = JSON.parse(JSON.stringify(fullMeta));
    projectPublicMeta(src);
    expect(src.wrappedKeys).toEqual({ '0xagent': 'deadbeefslice' });
    expect(src.rootHash).toBe('0xroot');
  });

  it('keeps rootHash + publicBrief on PUBLIC tasks (poster opted out of blindness)', () => {
    // A privacy='public' row can carry no key material by construction
    // (enforced at /tasks/index), so the only fields present are safe ones.
    const publicMeta = {
      taskId: '0xtask',
      targetExecutorType: 'agent' as const,
      verificationMode: 'auto' as const,
      requiredCapabilities: [],
      posterAddress: '0xposter',
      rootHash: '0xplaintext-root',
      privacy: 'public' as const,
      publicBrief: 'Summarize this article about MCP servers',
      deadline: 123,
    };
    const pub = projectPublicMeta(publicMeta as any);
    expect(pub.rootHash).toBe('0xplaintext-root');
    expect((pub as any).publicBrief).toBe('Summarize this article about MCP servers');
    expect(pub.hasEncryptedBrief).toBe(false);
    expect((pub as any).privacy).toBe('public');
  });

  it('still strips everything on a malformed row that claims public AND carries keys', () => {
    // Defense in depth: /tasks/index refuses this combination, but if a row
    // were hand-written into Redis, the key material must still be stripped.
    const malformed = { ...fullMeta, privacy: 'public' as const };
    const pub = projectPublicMeta(malformed as any);
    expect('wrappedKeys' in pub).toBe(false);
    expect('keyCustodyBlob' in pub).toBe(false);
  });
});

describe('projectPublicState', () => {
  it('strips operator-internal diagnostics', () => {
    const pub = projectPublicState(fullState as any);
    expect('assignError' in pub).toBe(false);
    expect('verifyError' in pub).toBe(false);
  });

  it('preserves status/tx fields', () => {
    const pub = projectPublicState(fullState as any) as any;
    expect(pub.status).toBe('submitted');
    expect(pub.assignTxHash).toBe('0xtx');
  });
});

describe('projectPublicEntry', () => {
  it('projects both meta and state', () => {
    const pub = projectPublicEntry({ meta: fullMeta as any, state: fullState as any });
    expect('wrappedKeys' in pub.meta).toBe(false);
    expect('rootHash' in pub.meta).toBe(false);
    expect(pub.meta.hasEncryptedBrief).toBe(true);
    expect('assignError' in pub.state).toBe(false);
    expect('verifyError' in pub.state).toBe(false);
  });
});
