import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';

/**
 * A revoked platform token must not keep, or get, an agent room on the socket
 * server (security audit run 1, C32). Real socket.io server and client; only
 * token verification and the denylist are mocked.
 */

const AGENT = '0xa9e7000000000000000000000000000000000001';
const { revoked } = vi.hoisted(() => ({ revoked: new Set<string>() }));

vi.mock('../middleware/auth.js', () => ({
  verifyRegistrationToken: (token: string) =>
    token.startsWith('token-') ? { address: AGENT, typ: 'agent-platform', jti: token.slice('token-'.length) } : null,
  isJwtRevoked: async (jti: string | undefined) => !!jti && revoked.has(jti),
}));
vi.mock('./a2aStore.js', () => ({ browseAgentTasks: vi.fn(async () => []) }));

import { disconnectSocketsForToken, emit, initSocket } from './socket.js';

let server: Server;
let url = '';
const clients: Socket[] = [];

beforeAll(async () => {
  server = createServer();
  initSocket(server, { origin: '*' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const c of clients) c.close();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => revoked.clear());

async function client(token?: string): Promise<Socket> {
  const c = connect(url, { transports: ['websocket'], auth: token ? { token } : {}, forceNew: true });
  clients.push(c);
  await new Promise<void>((resolve, reject) => { c.once('connect', () => resolve()); c.once('connect_error', reject); });
  return c;
}

/** Join and wait long enough for the async join handler to run. */
async function join(c: Socket, room: string): Promise<boolean> {
  let denied = false;
  const onDenied = (p: { room: string }) => { if (p.room === room) denied = true; };
  c.on('join:denied', onDenied);
  c.emit('join', room);
  await new Promise((r) => setTimeout(r, 100));
  c.off('join:denied', onDenied);
  return !denied;
}

async function receivesOffer(c: Socket): Promise<boolean> {
  let got = false;
  const onOffer = () => { got = true; };
  c.on('task:offer', onOffer);
  emit(`agent:${AGENT}`, 'task:offer', { taskId: '0xabc' });
  await new Promise((r) => setTimeout(r, 100));
  c.off('task:offer', onOffer);
  return got;
}

describe('socket agent rooms and token revocation', () => {
  it('a valid platform token joins its agent room and receives offers', async () => {
    const c = await client('token-live');
    expect(await join(c, `agent:${AGENT}`)).toBe(true);
    expect(await receivesOffer(c)).toBe(true);
  });

  it('a token revoked before the handshake gets no agent room', async () => {
    revoked.add('dead');
    const c = await client('token-dead');
    expect(await join(c, `agent:${AGENT}`)).toBe(false);
    expect(await join(c, 'tasks')).toBe(true); // public rooms still work
  });

  it('a token revoked after the handshake loses its agent room at the next join', async () => {
    const c = await client('token-later');
    expect(await join(c, `agent:${AGENT}`)).toBe(true);
    revoked.add('later');
    expect(await join(c, `agent:${AGENT}`)).toBe(false);
    expect(await receivesOffer(c)).toBe(false);
  });

  it('revoking disconnects the sockets that authenticated with that token', async () => {
    const c = await client('token-kill');
    const other = await client('token-keep');
    const gone = new Promise<void>((r) => c.once('disconnect', () => r()));
    expect(await disconnectSocketsForToken('kill')).toBe(1);
    await gone;
    expect(other.connected).toBe(true);
  });
});
