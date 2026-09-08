import { Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import type { CorsOptions } from 'cors';
import { verifyRegistrationToken } from '../middleware/auth.js';
import * as a2aStore from './a2aStore.js';

let io: SocketServer | null = null;

// Rooms any client may join: broadcast feeds whose payloads are also served
// by unauthenticated REST endpoints.
const PUBLIC_ROOMS = new Set(['platform', 'tasks', 'disputes']);
// Per-task status rooms (numeric on-chain id or 0x task hash).
const TASK_ROOM = /^task:(\d+|0x[0-9a-fA-F]{64})$/;

/**
 * `agent:<address>` rooms carry targeted task offers, so joining requires
 * proving control of that address: the handshake must carry the agent's
 * platform/registration JWT (worker.js already sends it as
 * `auth: { token }`) whose `address` claim matches the room.
 */
export function canJoin(room: string, agentAddress: string | null): boolean {
  if (PUBLIC_ROOMS.has(room) || TASK_ROOM.test(room)) return true;
  if (room.startsWith('agent:')) {
    return !!agentAddress && room.toLowerCase() === `agent:${agentAddress}`;
  }
  // Unknown room shape (including raw socket ids) — never joinable.
  return false;
}

/**
 * How many open tasks a joining client is told about at once.
 *
 * Bounded because the worker fires an /accept per `task:available`
 * (agents/worker.js), so an unbounded replay would turn one reconnect into a
 * burst of accept attempts against the same board.
 */
export const BACKLOG_REPLAY_LIMIT = 25;

/** Minimal emitter surface — lets the replay be tested without a live server. */
interface Emitter { emit(event: string, data: unknown): unknown }

/**
 * Tell a client joining the `tasks` room what is already open.
 *
 * Without this, joining a room is the end of the story: nothing replays, and
 * `emitTaskAvailable` is only ever called from the request and cascade paths in
 * routes/a2a.ts — no sweeper re-emits. So a task broadcast while an agent was
 * disconnected (a backend restart kills the cascade's setTimeout) was never
 * mentioned to it again, and sat open until it expired with escrow still
 * funded.
 *
 * Deliberately reuses the existing `task:available` event rather than adding a
 * `task:backlog` one: workers already handle it, so every agent already
 * deployed gets the fix without being redeployed.
 *
 * browseAgentTasks() supplies the list, so the deadline filter and capability
 * shape match what the REST board would return — an expired task is not
 * replayed. The payload carries only requiredCapabilities, exactly as
 * emitTaskAvailable does; no key material crosses this channel.
 */
export async function replayOpenBoard(socket: Emitter): Promise<number> {
  try {
    const open = await a2aStore.browseAgentTasks();
    const slice = open.slice(0, BACKLOG_REPLAY_LIMIT);
    for (const { meta } of slice) {
      socket.emit('task:available', {
        taskId: meta.taskId,
        meta: meta.requiredCapabilities?.length
          ? { requiredCapabilities: meta.requiredCapabilities }
          : {},
      });
    }
    return slice.length;
  } catch (err) {
    // Never let a replay failure break the join itself — the client is still
    // connected and WS delivery still works; it just missed the backlog.
    console.warn('[socket] backlog replay failed:', (err as Error).message);
    return 0;
  }
}

export function initSocket(httpServer: HttpServer, corsOptions: CorsOptions): SocketServer {
  io = new SocketServer(httpServer, { cors: corsOptions });

  io.on('connection', (socket) => {
    const token = (socket.handshake.auth as Record<string, unknown> | undefined)?.token;
    const claims = typeof token === 'string' ? verifyRegistrationToken(token) : null;
    const agentAddress = claims?.address?.toLowerCase() ?? null;

    // Client joins a room by emitting 'join'
    socket.on('join', (room: unknown) => {
      if (typeof room !== 'string' || room.length > 128) return;
      if (canJoin(room, agentAddress)) {
        socket.join(room);
        // Catch the joiner up on work already waiting. Fire-and-forget: the
        // join must not block on Redis.
        if (room === 'tasks') {
          void replayOpenBoard(socket).then((n) => {
            if (n > 0) console.log(`[socket] replayed ${n} open task(s) to a joining client`);
          });
        }
      } else {
        console.warn(`[socket] join denied: room=${room} authed=${agentAddress ?? 'anon'}`);
        socket.emit('join:denied', { room });
      }
    });

    socket.on('leave', (room: unknown) => {
      if (typeof room === 'string') socket.leave(room);
    });
  });

  return io;
}

export function emit(room: string, event: string, data: unknown): void {
  io?.to(room).emit(event, data);
}

// Convenience emitters per room
export const rooms = {
  platform: (event: string, data: unknown) => emit('platform', event, data),
  tasks:    (event: string, data: unknown) => emit('tasks', event, data),
  disputes: (event: string, data: unknown) => emit('disputes', event, data),
  task:     (id: string | number, event: string, data: unknown) => emit(`task:${id}`, event, data),
};

/**
 * Emit a scored offer to a specific agent.
 * The agent's WS client should join room `agent:<address>` at connect time.
 */
export function emitTaskOffer(
  agentAddress: string,
  taskId: string,
  meta: Record<string, unknown>,
  score: number,
  deadline: number,
): void {
  emit(`agent:${agentAddress.toLowerCase()}`, 'task:offer', {
    taskId,
    meta,
    score,
    expiresAt: deadline,
  });
}

/** Broadcast that a task is available for CAS-race (fallback when no offer taker). */
export function emitTaskAvailable(taskId: string, meta: Record<string, unknown>): void {
  rooms.tasks('task:available', { taskId, meta });
}
