import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { tierMismatches } from './services/settlementTier.js';

/**
 * The env templates people copy must boot on the tier they resolve to. When
 * NODE_ENV=production started deriving SETTLEMENT_TIER=mainnet, .env.example
 * still named Arc testnet (ARC_CHAIN_ID=5042002), so a production stack copied
 * from it was refused at boot. Loads the real config with each template and
 * checks what assertBootConfig checks for the tier (tierMismatches).
 */

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
});

async function loadTemplate(file: string) {
  vi.resetModules();
  const template = dotenv.parse(fs.readFileSync(new URL(`../${file}`, import.meta.url)));
  // SETTLEMENT_TIER is cleared first, so only the template and NODE_ENV name it.
  // PRIVY_APP_ID is the one secret config requires at load; the templates leave
  // it blank for the operator to fill.
  process.env = { ...ORIGINAL, SETTLEMENT_TIER: '', ...template, PRIVY_APP_ID: template.PRIVY_APP_ID || 'test-app-id' };
  const { config } = await import('./config.js');
  return config;
}

describe('the shipped env templates boot on their own tier', () => {
  it('.env.example (NODE_ENV=production) is full mainnet, with no chain id off the tier', async () => {
    const config = await loadTemplate('.env.example');
    expect(config.settlementTier).toBe('mainnet');
    expect(tierMismatches(process.env, 'mainnet')).toEqual([]);
    expect({ og: config.ogChainId, base: config.baseChainId, arc: config.arcChainId }).toEqual({ og: 16661, base: 8453, arc: 5042 });
  });

  it('.env.staging-testnet.example stays on testnet, with no chain id off the tier', async () => {
    const config = await loadTemplate('.env.staging-testnet.example');
    expect(config.settlementTier).toBe('testnet');
    expect(tierMismatches(process.env, 'testnet')).toEqual([]);
    expect({ og: config.ogChainId, base: config.baseChainId, arc: config.arcChainId }).toEqual({ og: 16602, base: 84532, arc: 5042002 });
  });
});
