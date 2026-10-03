/**
 * How much memory a new agent worker can still use, so agentRunner refuses
 * to fork one that would run the box (or its container) out of memory.
 *
 * Each hosted agent is its own Node process. In the production image one
 * takes ~105–110 MB once settled and ~140 MB while it starts
 * (docs/HOSTED-AGENT-CAPACITY.md). A count cap alone can't tell how much a
 * given box holds, and when memory runs out the kernel's OOM killer can take
 * the API down with the workers (measured: a 512 MB container running 5).
 *
 * Linux only. Inside a container with a memory limit (cgroup v2), what is
 * left under that limit counts: memory.max minus memory.current, less the
 * page cache the kernel can drop (inactive_file), as `docker stats` counts
 * it; never more than the machine itself has available. Otherwise
 * os.freemem(), which on Linux is MemAvailable. Elsewhere (a developer's
 * Mac, whose os.freemem() leaves out memory it can reclaim) nothing is
 * measured and no start is refused for memory.
 */
import { readFileSync, writeFileSync } from 'fs';
import { freemem, totalmem } from 'os';

const MB = 1024 * 1024;

/** What this module reads: the real system unless a test says otherwise. */
export interface MemoryProbe {
  readFile: (path: string) => string;
  freemem: () => number;
  totalmem: () => number;
  platform: NodeJS.Platform;
}

const systemProbe: MemoryProbe = {
  readFile: (path) => readFileSync(path, 'utf8'),
  freemem,
  totalmem,
  platform: process.platform,
};

export interface MemoryReading {
  /** MB still free for new processes: under the container's limit, or on the machine. */
  availableMb: number;
  /** MB in all: the container's limit, or the machine's memory. */
  totalMb: number;
  /** 'cgroup' when a container memory limit binds, 'os' otherwise. */
  source: 'cgroup' | 'os';
}

/** The container's memory limit and what it uses, in MB; null when there is no limit or no cgroup v2. */
function cgroupMemory(probe: MemoryProbe): { limitMb: number; usedMb: number } | null {
  try {
    const max = probe.readFile('/sys/fs/cgroup/memory.max').trim();
    if (max === 'max') return null;
    const limit = Number(max);
    const current = Number(probe.readFile('/sys/fs/cgroup/memory.current').trim());
    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(current) || current < 0) return null;
    let reclaimable = 0;
    try {
      reclaimable = Number(/^inactive_file (\d+)$/m.exec(probe.readFile('/sys/fs/cgroup/memory.stat'))?.[1] ?? 0);
    } catch { /* no memory.stat: count the cache as used */ }
    return { limitMb: limit / MB, usedMb: Math.max(0, current - reclaimable) / MB };
  } catch {
    return null;
  }
}

/** Free memory as a new worker would find it, or null where it isn't measured (not Linux). */
export function readMemory(probe: MemoryProbe = systemProbe): MemoryReading | null {
  if (probe.platform !== 'linux') return null;
  const osAvailableMb = probe.freemem() / MB;
  const osTotalMb = probe.totalmem() / MB;
  const cg = cgroupMemory(probe);
  if (cg && cg.limitMb < osTotalMb) {
    return {
      availableMb: Math.max(0, Math.min(cg.limitMb - cg.usedMb, osAvailableMb)),
      totalMb: cg.limitMb,
      source: 'cgroup',
    };
  }
  return { availableMb: Math.max(0, osAvailableMb), totalMb: osTotalMb, source: 'os' };
}

/**
 * The memory kept free when deciding whether a worker may start, in MB:
 * AGENT_MEMORY_RESERVE_MB when it is a whole number (0 included), else an
 * eighth of the box (or container limit), at least 64 and at most 2048 —
 * 2048 on a 16 GB box, 128 on 1 GB, 64 on 512 MB, where that still lets
 * two workers start as measured.
 */
export function memoryReserveMb(totalMb: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENT_MEMORY_RESERVE_MB?.trim();
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  return Math.min(2048, Math.max(64, Math.round(totalMb / 8)));
}

/**
 * Make a worker the OOM killer's first choice, ahead of the API that forked
 * it: when memory runs out anyway (a worker grows after it started), the
 * kernel then ends a worker, which agentRunner restarts if memory allows,
 * instead of the API and every agent with it. Raising the score of a
 * process one owns needs no privilege. Linux only, best effort.
 */
export function preferWorkerForOom(
  pid: number | undefined,
  write: (path: string, value: string) => void = (path, value) => writeFileSync(path, value),
  platform: NodeJS.Platform = process.platform,
): void {
  if (!pid || platform !== 'linux') return;
  try {
    write(`/proc/${pid}/oom_score_adj`, '500');
  } catch { /* not permitted here: the worker keeps the default score */ }
}
