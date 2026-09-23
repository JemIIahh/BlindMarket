import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  assertBootConfig,
  config,
  deploymentSetProblems,
  DEPLOYMENT_SET_REQUIRED_ENV,
  parseDeploymentSet,
} from './config.js';

/**
 * A staging backend (DEPLOYMENT_SET=staging) must not fall back to the
 * generated production addresses: optional() treats unset AND empty as
 * missing, so every address has to be set explicitly.
 */

const ZERO = '0x0000000000000000000000000000000000000000';
const STAGING_CHAINS = { og: 16602, base: 84532 };
const fullEnv = (): Record<string, string | undefined> => ({
  ...Object.fromEntries(DEPLOYMENT_SET_REQUIRED_ENV.map((k) => [k, '0x1111111111111111111111111111111111111111'])),
  PUBLIC_API_URL: 'https://api.staging.example',
  PUBLIC_APP_URL: 'https://staging.example',
});

describe('parseDeploymentSet', () => {
  it('maps unset, empty and "default" to the default set', () => {
    expect(parseDeploymentSet(undefined)).toBe('');
    expect(parseDeploymentSet('')).toBe('');
    expect(parseDeploymentSet(' default ')).toBe('');
  });

  it('accepts staging', () => {
    expect(parseDeploymentSet('staging')).toBe('staging');
  });

  it('rejects anything else', () => {
    expect(() => parseDeploymentSet('prod')).toThrow(/not a deployment set/);
    expect(() => parseDeploymentSet('Staging')).toThrow(/not a deployment set/);
  });
});

describe('deploymentSetProblems', () => {
  it('asks nothing of the default set', () => {
    expect(deploymentSetProblems('', {}, { og: 16661, base: 8453 })).toEqual([]);
  });

  it('covers every address config.ts falls back to generated values for, plus the pool, 0G RPC and public URLs', () => {
    expect([...DEPLOYMENT_SET_REQUIRED_ENV].sort()).toEqual([
      'AGENT_FACTORY_ADDRESS',
      'ARC_AGENT_FACTORY_ADDRESS',
      'BASE_ESCROW_ADDRESS',
      'BLIND_ACCOUNT_FACTORY_ADDRESS',
      'BLIND_ESCROW_ADDRESS',
      'BLIND_REPUTATION_ADDRESS',
      'ENTRY_POINT_ADDRESS',
      'INFT_ADDRESS',
      'OG_RPC_URL',
      'PUBLIC_API_URL',
      'PUBLIC_APP_URL',
      'TASK_REGISTRY_ADDRESS',
      'USDC_PAYMASTER_ADDRESS',
      'VALIDATOR_POOL_ADDRESS',
    ]);
  });

  it('passes a staging env with every address set', () => {
    expect(deploymentSetProblems('staging', fullEnv(), STAGING_CHAINS)).toEqual([]);
  });

  it('counts a zero address as set', () => {
    const env = { ...fullEnv(), AGENT_FACTORY_ADDRESS: ZERO, USDC_PAYMASTER_ADDRESS: ZERO };
    expect(deploymentSetProblems('staging', env, STAGING_CHAINS)).toEqual([]);
  });

  it('names unset and empty addresses, which would fall back to production', () => {
    const env = { ...fullEnv(), BASE_ESCROW_ADDRESS: undefined, AGENT_FACTORY_ADDRESS: '', INFT_ADDRESS: '  ' };
    const [problem, ...rest] = deploymentSetProblems('staging', env, STAGING_CHAINS);
    expect(rest).toEqual([]);
    expect(problem).toContain('INFT_ADDRESS, BASE_ESCROW_ADDRESS, AGENT_FACTORY_ADDRESS are not set');
  });

  it("refuses production's public URLs, which would send agents that find staging to production", () => {
    const env = { ...fullEnv(), PUBLIC_API_URL: 'https://api.blindmarket.xyz/', PUBLIC_APP_URL: 'https://blindmarket.xyz' };
    expect(deploymentSetProblems('staging', env, STAGING_CHAINS)).toEqual([
      expect.stringContaining("PUBLIC_API_URL is production's https://api.blindmarket.xyz"),
      expect.stringContaining("PUBLIC_APP_URL is production's https://blindmarket.xyz"),
    ]);
    expect(deploymentSetProblems('staging', { ...fullEnv(), PUBLIC_APP_URL: undefined }, STAGING_CHAINS)).toEqual([
      expect.stringContaining('PUBLIC_APP_URL is not set'),
    ]);
  });

  it('refuses staging on other chain ids', () => {
    expect(deploymentSetProblems('staging', fullEnv(), { og: 16661, base: 84532 })).toEqual([
      expect.stringContaining('OG_CHAIN_ID=16602 and BASE_CHAIN_ID=84532; this backend has 16661 and 84532'),
    ]);
    // NODE_ENV=production defaults Base to mainnet.
    expect(deploymentSetProblems('staging', fullEnv(), { og: 16602, base: 8453 })).toHaveLength(1);
  });
});

describe('assertBootConfig with a deployment set', () => {
  const saved = { set: config.deploymentSet, og: config.ogChainId, base: config.baseChainId };

  afterEach(() => {
    Object.assign(config, { deploymentSet: saved.set, ogChainId: saved.og, baseChainId: saved.base });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function stage(env: Record<string, string | undefined>) {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    Object.assign(config, { deploymentSet: 'staging', ogChainId: 16602, baseChainId: 84532 });
    for (const k of DEPLOYMENT_SET_REQUIRED_ENV) vi.stubEnv(k, env[k]);
  }

  it('fails boot when a staging address is missing', () => {
    stage({ ...fullEnv(), BLIND_ESCROW_ADDRESS: undefined });
    expect(() => assertBootConfig()).toThrow(/Invalid boot config: 1 fatal/);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('BLIND_ESCROW_ADDRESS is not set'));
  });

  it('boots when every staging address is set', () => {
    stage(fullEnv());
    expect(() => assertBootConfig()).not.toThrow();
  });

  it('ignores the address env in the default set', () => {
    stage({});
    Object.assign(config, { deploymentSet: '' });
    expect(() => assertBootConfig()).not.toThrow();
  });
});
