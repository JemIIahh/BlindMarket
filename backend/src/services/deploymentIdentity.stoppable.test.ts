/**
 * Only a stoppable process can have its background writes stopped: a staging
 * stack, or anything not running as production. Production can never be,
 * including after the SETTLEMENT_TIER=mainnet flip.
 *
 * Run: npx vitest run src/services/deploymentIdentity.stoppable.test.ts
 */
import { describe, it, expect, vi } from 'vitest';

const cfg = vi.hoisted(() => ({ settlementTier: null as string | null, deploymentSet: '', nodeEnv: 'production', ogChainId: 16661 }));
vi.mock('../config.js', () => ({ config: cfg }));
vi.mock('./redis.js', () => ({ redis: {} }));
vi.mock('./settlementChains.js', () => ({ settlementChainConfigs: () => [] }));
vi.mock('./settlementTier.js', () => ({ TIER_CHAIN_IDS: { '0g': { mainnet: 16661, testnet: 16602 } } }));

import { isStoppable } from './deploymentIdentity.js';

describe('isStoppable', () => {
  it.each([
    ['production', 16661, null, '', false],
    ['production', 16661, 'mainnet', '', false],
    ['production', 16661, 'testnet', '', true],
    ['production', 16661, null, 'staging', true],
    ['production', 16661, 'testnet', 'staging', true],
    // A staging stack that dropped DEPLOYMENT_SET and SETTLEMENT_TIER is still off 0G mainnet.
    ['production', 16602, null, '', true],
    ['development', 16661, null, '', true],
    ['test', 16661, null, '', true],
  ])('NODE_ENV=%s OG_CHAIN_ID=%s SETTLEMENT_TIER=%s DEPLOYMENT_SET=%j → %s', (nodeEnv, ogChainId, tier, set, stoppable) => {
    cfg.nodeEnv = nodeEnv;
    cfg.ogChainId = ogChainId;
    cfg.settlementTier = tier;
    cfg.deploymentSet = set;
    expect(isStoppable()).toBe(stoppable);
  });
});
