import { Redis } from 'ioredis';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

/**
 * Connection hygiene for a remote Redis (Redis Cloud, us-east-1).
 *
 * Without these, a socket that a NAT or load balancer silently dropped while
 * idle is not discovered until the OS declares `read ETIMEDOUT` — measured at
 * ~4 minutes here — and every command issued meanwhile waits on it. That is
 * how POST /a2a/tasks/index took 248s (server-side, then succeeded), how
 * GET /tasks/:id and /a2a/tasks/posted hung past 60s, and how the MCP saw
 * "fetch failed" twice for posts that had already landed on-chain. A fresh
 * client from the same machine answered in <1.5s the whole time: the network
 * was fine, the long-lived socket was dead.
 *
 * - keepAlive keeps the socket from going idle long enough to be dropped.
 * - connectTimeout / commandTimeout bound how long a dead socket can hold a
 *   request before ioredis gives up, reconnects, and retries it.
 * - retryStrategy reconnects promptly with a small bounded backoff instead
 *   of the default exponential growth.
 * - Lifecycle logs, because the silence was half of why this took so long
 *   to find — the only signal was one ETIMEDOUT line, minutes in.
 */
const REDIS_OPTIONS = {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  connectTimeout: 10_000,
  commandTimeout: 15_000,
  keepAlive: 10_000,
  enableReadyCheck: true,
  retryStrategy: (times: number) => Math.min(200 * times, 2_000),
  // When the heartbeat forces a reconnect (below), do NOT replay the commands
  // that were stuck on the dead socket: their promises were already rejected
  // by commandTimeout, and replaying a boot-time migration burst onto the new
  // socket is exactly how a fresh connection inherits the old one's backlog.
  autoResendUnfulfilledCommands: false,
} as const;

export const redis = new Redis(REDIS_URL, REDIS_OPTIONS);
export const redisSub = new Redis(REDIS_URL, REDIS_OPTIONS);

for (const [name, client] of [['client', redis], ['sub', redisSub]] as const) {
  client.on('error', (e: Error) => console.error(`[redis] ${name} error:`, e.message));
  client.on('ready', () => console.log(`[redis] ${name} ready`));
  client.on('reconnecting', (ms: number) => console.warn(`[redis] ${name} reconnecting in ${ms}ms`));
  client.on('end', () => console.warn(`[redis] ${name} connection ended`));
}

/**
 * Keep the connection genuinely alive, not just TCP-alive.
 *
 * With the timeouts above, an idle-dropped socket costs 15s and one failed
 * command instead of four minutes — measured: the first command after a few
 * idle minutes still hit "Command timed out". TCP keepalive probes do not
 * count as traffic to the load balancer that drops idle connections; a
 * Redis-level PING does. Ten seconds is well inside any idle cutoff seen.
 *
 * Connect eagerly too: with lazyConnect the first request of a process paid
 * the connection (and, once, a 15s timeout) instead of boot paying it.
 * Failures here are logged and left to the reconnect strategy — a Redis
 * outage must not stop the server from listening.
 *
 * The heartbeat is skipped for the subscriber: a client in subscribe mode
 * only accepts (P|S)UBSCRIBE-family commands, and its subscriptions are
 * themselves periodic traffic.
 */
const HEARTBEAT_MS = 10_000;
/**
 * Consecutive heartbeat failures before the socket is declared dead and
 * torn down. Measured 2026-09-10: a socket that came up `ready` (its INFO
 * ready-check was answered) then never delivered another reply — Redis
 * Cloud's server side showed our PINGs arriving every 10s, the kernel showed
 * Recv-Q 0, and ioredis still reported "Command timed out" for every one of
 * them, for the life of the process. commandTimeout rejects the caller but
 * never touches the connection, so ioredis sat on that zombie forever with
 * status "ready" and a queue that only grew. Three misses (30s) is long
 * enough to ride out a slow round trip (500ms is normal to us-east-1 from
 * here) and short enough that a request never waits a minute on it.
 */
const HEARTBEAT_DEAD_AFTER = 3;
let heartbeatMisses = 0;
redis.connect().catch((e: Error) => console.error('[redis] client initial connect failed:', e.message));
redisSub.connect().catch((e: Error) => console.error('[redis] sub initial connect failed:', e.message));
redis.on('ready', () => { heartbeatMisses = 0; });
const heartbeat = setInterval(() => {
  if (redis.status !== 'ready') return;
  redis.ping().then(
    () => { heartbeatMisses = 0; },
    (e: Error) => {
      heartbeatMisses += 1;
      console.warn(`[redis] heartbeat ping failed (${heartbeatMisses}/${HEARTBEAT_DEAD_AFTER}):`, e.message);
      if (heartbeatMisses >= HEARTBEAT_DEAD_AFTER) {
        // disconnect(true): close the socket but keep the client alive, so
        // retryStrategy reconnects it. Commands still parked on the dead
        // socket are rejected with a connection-closed error (they were
        // already rejected by their own timeout, so nobody is waiting).
        console.error(`[redis] client socket dead: ${heartbeatMisses} heartbeats unanswered — forcing reconnect`);
        heartbeatMisses = 0;
        redis.disconnect(true);
      }
    },
  );
}, HEARTBEAT_MS);
heartbeat.unref(); // never keep the process alive on its own

// ── Keys ─────────────────────────────────────────────────────────────────────

const KEY = {
  agentLogs: (id: string) => `agent:${id}:logs`,
  agentLogChannel: (id: string) => `agent:${id}:log-stream`,
  agentHeartbeat: (id: string) => `agent:${id}:heartbeat`,
};

const HEARTBEAT_TTL_S = 90; // agent considered dead if no heartbeat for 90s
const LOG_LIMIT = 200;

// ── Logs ──────────────────────────────────────────────────────────────────────

function formatLogTs(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export async function appendLog(id: string, line: string): Promise<void> {
  // Worker logs already carry ISO timestamps from nowStamp(). Lines from
  // agentRunner (crash logs, watchdog warnings) usually don't — prepend one
  // so the frontend's regex always has a timestamp to parse.
  const hasTs = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(line);
  const stamped = hasTs ? line : `${formatLogTs()} ${line}`;
  const pipe = redis.pipeline();
  pipe.rpush(KEY.agentLogs(id), stamped);
  pipe.ltrim(KEY.agentLogs(id), -LOG_LIMIT, -1);
  await pipe.exec();
  // Publish to channel for live SSE subscribers
  await redis.publish(KEY.agentLogChannel(id), stamped);
}

export async function getLogs(id: string): Promise<string[]> {
  return redis.lrange(KEY.agentLogs(id), 0, -1);
}

/**
 * Subscribe to live log lines for an agent.
 * Returns an unsubscribe function.
 */
export async function subscribeAgentLogs(
  id: string,
  cb: (line: string) => void,
): Promise<() => void> {
  const channel = KEY.agentLogChannel(id);
  await redisSub.subscribe(channel);
  const handler = (chan: string, message: string) => {
    if (chan === channel) cb(message);
  };
  redisSub.on('message', handler);
  return async () => {
    redisSub.off('message', handler);
    await redisSub.unsubscribe(channel);
  };
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

export async function touchHeartbeat(id: string): Promise<void> {
  await redis.set(KEY.agentHeartbeat(id), Date.now(), 'EX', HEARTBEAT_TTL_S);
}

export async function isAlive(id: string): Promise<boolean> {
  return (await redis.exists(KEY.agentHeartbeat(id))) === 1;
}

export async function getHeartbeat(id: string): Promise<number> {
  const raw = await redis.get(KEY.agentHeartbeat(id));
  return raw ? Number(raw) : 0;
}
