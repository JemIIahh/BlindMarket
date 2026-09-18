/**
 * A strict process refuses to claim a Redis holding indexer state with no
 * escrow fingerprint (production from before fingerprints). Staging stacks
 * are strict through either setting they carry; production sets neither.
 *
 * Run: npx vitest run src/services/deploymentIdentity.strict.test.ts
 */
import { describe, it, expect, vi } from 'vitest';

const cfg = vi.hoisted(() => ({ settlementTier: null as string | null, deploymentSet: '' }));
vi.mock('../config.js', () => ({ config: cfg }));
vi.mock('./redis.js', () => ({ redis: {} }));
vi.mock('./settlementChains.js', () => ({ settlementChainConfigs: () => [] }));

import { isStrict } from './deploymentIdentity.js';

describe('isStrict', () => {
  it.each([
    [null, '', false],
    ['testnet', '', true],
    ['mainnet', '', true],
    [null, 'staging', true],
    ['testnet', 'staging', true],
  ])('SETTLEMENT_TIER=%s DEPLOYMENT_SET=%j → %s', (tier, set, strict) => {
    cfg.settlementTier = tier;
    cfg.deploymentSet = set;
    expect(isStrict()).toBe(strict);
  });
});
