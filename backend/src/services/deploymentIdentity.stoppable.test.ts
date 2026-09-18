/**
 * Only a stoppable process can have its background writes stopped: a staging
 * stack, or anything not running as production. Production can never be,
 * including after the SETTLEMENT_TIER=mainnet flip.
 *
 * Run: npx vitest run src/services/deploymentIdentity.stoppable.test.ts
 */
import { describe, it, expect, vi } from 'vitest';

const cfg = vi.hoisted(() => ({ settlementTier: null as string | null, deploymentSet: '', nodeEnv: 'production' }));
vi.mock('../config.js', () => ({ config: cfg }));
vi.mock('./redis.js', () => ({ redis: {} }));
vi.mock('./settlementChains.js', () => ({ settlementChainConfigs: () => [] }));

import { isStoppable } from './deploymentIdentity.js';

describe('isStoppable', () => {
  it.each([
    ['production', null, '', false],
    ['production', 'mainnet', '', false],
    ['production', 'testnet', '', true],
    ['production', null, 'staging', true],
    ['production', 'testnet', 'staging', true],
    ['development', null, '', true],
    ['test', null, '', true],
  ])('NODE_ENV=%s SETTLEMENT_TIER=%s DEPLOYMENT_SET=%j → %s', (nodeEnv, tier, set, stoppable) => {
    cfg.nodeEnv = nodeEnv;
    cfg.settlementTier = tier;
    cfg.deploymentSet = set;
    expect(isStoppable()).toBe(stoppable);
  });
});
