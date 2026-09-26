import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * RUN_MODE parsing: all (default), api, and indexer. A typo must fail fast.
 */

const ORIGINAL = { ...process.env };

async function load(env: Record<string, string>) {
  vi.resetModules();
  process.env = { ...ORIGINAL, ...env };
  const mod = await import('./config.js');
  return mod;
}

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('RUN_MODE', () => {
  it('defaults to all', async () => {
    const { config } = await load({ PRIVY_APP_ID: 'dummy' });
    expect(config.runMode).toBe('all');
  });

  it('accepts api and indexer', async () => {
    for (const mode of ['api', 'indexer', 'ALL', 'Api', 'Indexer']) {
      const { config } = await load({ RUN_MODE: mode, PRIVY_APP_ID: 'dummy' });
      expect(config.runMode).toBe(mode.toLowerCase());
    }
  });

  it('throws on an invalid run mode at load time', async () => {
    await expect(load({ RUN_MODE: 'worker', PRIVY_APP_ID: 'dummy' })).rejects.toThrow(
      /RUN_MODE=.*worker/,
    );
  });
});
