import { describe, expect, it, vi } from 'vitest';
import { memoryReserveMb, preferWorkerForOom, readMemory, type MemoryProbe } from './memoryHeadroom.js';

/**
 * Free memory as a new agent worker would find it: under a container's
 * cgroup v2 limit when one binds (less the page cache the kernel can drop),
 * else the machine's MemAvailable (os.freemem), and nothing measured off
 * Linux. Plus the reserve kept free and the OOM preference for workers.
 *
 * Run: npx vitest run src/services/memoryHeadroom.test.ts
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** A Linux box with `files` under /sys/fs/cgroup (a missing file throws ENOENT, as readFileSync does). */
function probe(files: Record<string, string>, o: Partial<MemoryProbe> = {}): MemoryProbe {
  return {
    readFile: (path) => {
      if (path in files) return files[path];
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    },
    freemem: () => 12 * GB,
    totalmem: () => 16 * GB,
    platform: 'linux',
    ...o,
  };
}
const cgroup = (max: string, current: number, inactiveFile?: number) => ({
  '/sys/fs/cgroup/memory.max': `${max}\n`,
  '/sys/fs/cgroup/memory.current': `${current}\n`,
  ...(inactiveFile === undefined ? {} : { '/sys/fs/cgroup/memory.stat': `anon ${current}\nfile 123\ninactive_file ${inactiveFile}\nactive_file 9\n` }),
});

describe('readMemory', () => {
  it('counts what is left under a container memory limit, the dropable page cache not counted as used', () => {
    // 2 GB limit, 1.5 GB charged of which 0.25 GB is inactive page cache → 0.75 GB free.
    const r = readMemory(probe(cgroup(String(2 * GB), 1.5 * GB, 0.25 * GB)));
    expect(r).toEqual({ availableMb: 768, totalMb: 2048, source: 'cgroup' });
  });

  it('counts the whole charge as used when memory.stat cannot be read', () => {
    expect(readMemory(probe(cgroup(String(2 * GB), 1.5 * GB)))?.availableMb).toBe(512);
  });

  it('never reports more than the machine has available, whatever the limit', () => {
    const r = readMemory(probe(cgroup(String(8 * GB), 1 * GB, 0), { freemem: () => 3 * GB }));
    expect(r).toEqual({ availableMb: 3072, totalMb: 8192, source: 'cgroup' });
  });

  it('falls back to os.freemem with no limit (memory.max "max")', () => {
    expect(readMemory(probe(cgroup('max', 1 * GB, 0)))).toEqual({ availableMb: 12_288, totalMb: 16_384, source: 'os' });
  });

  it('falls back to os.freemem without cgroup v2 files, or with a limit above the machine', () => {
    expect(readMemory(probe({}))?.source).toBe('os');
    expect(readMemory(probe(cgroup(String(64 * GB), 1 * GB, 0)))).toEqual({ availableMb: 12_288, totalMb: 16_384, source: 'os' });
  });

  it('falls back to os.freemem when a cgroup file holds something else than a number', () => {
    expect(readMemory(probe({ '/sys/fs/cgroup/memory.max': 'garbage', '/sys/fs/cgroup/memory.current': '1' }))?.source).toBe('os');
    expect(readMemory(probe({ '/sys/fs/cgroup/memory.max': String(GB), '/sys/fs/cgroup/memory.current': 'x' }))?.source).toBe('os');
  });

  it('reports 0, not a negative number, when usage is past the limit', () => {
    expect(readMemory(probe(cgroup(String(GB), 1.2 * GB, 0)))?.availableMb).toBe(0);
  });

  it('measures nothing off Linux, where os.freemem leaves out reclaimable memory', () => {
    const readFile = vi.fn();
    expect(readMemory(probe({}, { platform: 'darwin', readFile, freemem: () => 50 * MB }))).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe('memoryReserveMb', () => {
  it('keeps an eighth of the box free by default, between 64 and 2048 MB', () => {
    expect(memoryReserveMb(16_384, {})).toBe(2048);
    expect(memoryReserveMb(65_536, {})).toBe(2048);
    expect(memoryReserveMb(8192, {})).toBe(1024);
    expect(memoryReserveMb(1024, {})).toBe(128);
    expect(memoryReserveMb(512, {})).toBe(64);
    expect(memoryReserveMb(256, {})).toBe(64);
  });

  it('follows AGENT_MEMORY_RESERVE_MB when it is a whole number, 0 included', () => {
    expect(memoryReserveMb(16_384, { AGENT_MEMORY_RESERVE_MB: '3000' })).toBe(3000);
    expect(memoryReserveMb(16_384, { AGENT_MEMORY_RESERVE_MB: ' 0 ' })).toBe(0);
  });

  it.each(['', 'lots', '-5', '1.5'])('ignores AGENT_MEMORY_RESERVE_MB=%j', (value) => {
    expect(memoryReserveMb(16_384, { AGENT_MEMORY_RESERVE_MB: value })).toBe(2048);
  });
});

describe('preferWorkerForOom', () => {
  it('raises the worker\'s oom_score_adj on Linux', () => {
    const write = vi.fn();
    preferWorkerForOom(4242, write, 'linux');
    expect(write).toHaveBeenCalledWith('/proc/4242/oom_score_adj', '500');
  });

  it('does nothing off Linux or without a pid, and a refused write is not an error', () => {
    const write = vi.fn();
    preferWorkerForOom(4242, write, 'darwin');
    preferWorkerForOom(undefined, write, 'linux');
    expect(write).not.toHaveBeenCalled();
    expect(() => preferWorkerForOom(1, () => { throw new Error('EACCES'); }, 'linux')).not.toThrow();
  });
});
