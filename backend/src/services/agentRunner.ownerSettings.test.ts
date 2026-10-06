import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A worker heartbeat must not revert what the owner set meanwhile (delta
 * audit 2026-10-06, deploy-2). The heartbeat used to load the whole agent row,
 * stamp last_active_at and upsert every column back, so a delegation opt-out
 * or a Stop that landed between its load and its save was silently undone,
 * and a reverted 'running' status re-forked a stopped agent at the next boot.
 *
 * Runs the real agent store on the real SQLite migrations, in memory, under
 * the real agentRunner. The store is wrapped so the heartbeat's first store
 * call can be held open: a read returns its copy only after the owner's
 * changes, a write lands only after them.
 */

const forkMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ fork: forkMock }));
vi.mock('./memoryHeadroom.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./memoryHeadroom.js')>()),
  readMemory: () => null,
  preferWorkerForOom: vi.fn(),
}));
vi.mock('better-sqlite3', async (importOriginal) => {
  const Real = (await importOriginal<{ default: new (path: string) => object }>()).default;
  return { default: class extends Real { constructor() { super(':memory:'); } } };
});

const hold = vi.hoisted(() => ({
  armed: false,
  reached: null as null | (() => void),
  release: null as null | Promise<void>,
}));
vi.mock('./deployedAgentStore.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const wrapped: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(real)) {
    if (typeof fn !== 'function') { wrapped[name] = fn; continue; }
    wrapped[name] = async (...args: unknown[]) => {
      if (!hold.armed) return (fn as (...a: unknown[]) => unknown)(...args);
      hold.armed = false;
      hold.reached?.();
      const isRead = name.startsWith('load');
      if (isRead) {
        const copy = await (fn as (...a: unknown[]) => unknown)(...args);
        await hold.release;
        return copy;
      }
      await hold.release;
      return (fn as (...a: unknown[]) => unknown)(...args);
    };
  }
  return wrapped;
});
vi.mock('./notificationStore.js', () => ({ notify: vi.fn(async () => null) }));
vi.mock('./redis.js', () => ({
  appendLog: vi.fn(), getLogs: vi.fn(async () => []), subscribeAgentLogs: vi.fn(),
  touchHeartbeat: vi.fn(async () => {}), isAlive: vi.fn(async () => false), getHeartbeat: vi.fn(async () => null),
  redis: { set: vi.fn(), get: vi.fn(), del: vi.fn() },
}));
vi.mock('./chain.js', () => ({ inft: null }));
vi.mock('./agentReadiness.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agentReadiness.js')>()),
  saveAgentReadiness: vi.fn(async () => {}),
}));
vi.mock('./deploymentIdentity.js', () => ({
  backgroundWritesAllowed: () => true,
  deploymentIdentityStatus: () => null,
  onBackgroundWritesStopped: () => {},
}));
vi.mock('./crypto.js', () => ({ eciesEncrypt: () => Buffer.from(''), generateKeyPair: () => ({ privateKey: 'x', publicKey: 'y' }) }));

import { startAgent, stopAgent, updateAgent } from './agentRunner.js';
import { saveAgent, loadAgent } from './deployedAgentStore.js';
import type { DeployedAgent } from '../types.js';

const agent = (id: string): DeployedAgent => ({
  id, ownerAddress: '0xaaaa00000000000000000000000000000000000a', name: id, instructions: 'x', provider: 'openai', model: 'm',
  apiKey: 'sk', encryptedApiKey: '', capabilities: [], tools: [], status: 'stopped', deployedAt: '2026-10-06T00:00:00.000Z',
  walletAddress: `0x${id.padStart(40, '0')}`, publicKey: '04ab', encryptedPrivateKey: '', rawPrivateKey: 'deadbeef',
  platformToken: 'jwt', delegationEnabled: true, verifierEnabled: true,
});

beforeEach(() => {
  forkMock.mockReset();
  forkMock.mockImplementation(() => ({ stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, on: vi.fn(), pid: 1, kill: vi.fn() }));
});

/** Start the agent and return its worker's IPC message handler. */
async function startWithHandler(id: string): Promise<(msg: unknown) => Promise<void>> {
  await startAgent(id);
  const child = forkMock.mock.results.at(-1)!.value;
  return child.on.mock.calls.find(([event]: [string]) => event === 'message')[1];
}

/** Run `between` while `call`'s first store call is held open. */
async function heldAround(call: () => Promise<unknown>, between: () => Promise<void>): Promise<void> {
  let open!: () => void;
  hold.release = new Promise<void>((r) => { open = r; });
  const reached = new Promise<void>((r) => { hold.reached = r; });
  hold.armed = true;
  const pending = call();
  await reached;
  await between();
  open();
  await pending;
}

const heartbeat = (onMessage: (msg: unknown) => Promise<void>) => () => onMessage({ type: 'heartbeat', timestamp: Date.now() });

describe('worker heartbeat vs owner settings (deploy-2)', () => {
  it('keeps an owner\'s delegation opt-out and Stop made while a heartbeat was in flight', async () => {
    await saveAgent(agent('hb1'));
    const onMessage = await startWithHandler('hb1');
    expect((await loadAgent('hb1'))?.status).toBe('running');

    await heldAround(heartbeat(onMessage), async () => {
      await updateAgent('hb1', { delegationEnabled: false });
      await stopAgent('hb1');
    });

    const after = (await loadAgent('hb1'))!;
    expect(after.delegationEnabled).toBe(false);
    expect(after.status).toBe('stopped');
  });

  it('keeps a verifier opt-out made while a heartbeat was in flight, and still stamps last activity', async () => {
    await saveAgent(agent('hb2'));
    const onMessage = await startWithHandler('hb2');

    await heldAround(heartbeat(onMessage), async () => {
      await updateAgent('hb2', { verifierEnabled: false });
    });

    const after = (await loadAgent('hb2'))!;
    expect(after.verifierEnabled).toBe(false);
    expect(after.delegationEnabled).toBe(true);
    expect(after.status).toBe('running');
    expect(after.lastActiveAt).toBeTruthy();
    await stopAgent('hb2');
  });

  it('a settings edit in flight across a Stop does not bring the agent back to running', async () => {
    await saveAgent(agent('hb3'));
    await startWithHandler('hb3');

    await heldAround(() => updateAgent('hb3', { instructions: 'new' }), async () => {
      await stopAgent('hb3');
    });

    const after = (await loadAgent('hb3'))!;
    expect(after.status).toBe('stopped');
    expect(after.instructions).toBe('new');
  });
});
