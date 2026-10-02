import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';

/**
 * Where sponsored gas may run (gasSponsorConfig.ts): off by default; never on
 * SQLite; only with a DEPLOYMENT_ID, an Arc escrow, a delegate recorded for
 * the Arc chain id, and a sponsor key of its own — none of the backend's
 * signing keys and not the escrow's verifier, treasury or admin.
 */

const sponsorKey = ethers.Wallet.createRandom().privateKey;
const SPONSOR = new ethers.Wallet(sponsorKey).address;
const DELEGATE = '0x' + 'de'.repeat(20);

const cfg = vi.hoisted(() => ({
  databaseUrl: 'postgres://x',
  deploymentId: 'staging-arc',
  arcAgentDelegateAddress: '',
  arcMarketplaceSignerPrivateKey: '',
  baseMarketplaceSignerPrivateKey: '',
  marketplaceSignerPrivateKey: '',
  ogStoragePrivateKey: '',
  ogComputePrivateKey: '',
  keyCustody: { privateKey: '' },
  gasSponsor: {} as Record<string, unknown>,
}));
vi.mock('../config.js', () => ({ config: cfg }));
const arc = vi.hoisted(() => ({
  entry: {
    key: 'arc', label: 'Arc', chainId: 5042002, escrowAddress: '0x' + 'e5'.repeat(20) as string | null, aa: false,
    token: { address: '0x3600000000000000000000000000000000000000', unit: { symbol: 'USDC', decimals: 6 } },
    gas: { nativeIsSettlementToken: true, workerTxGasLimit: 200_000n },
  },
}));
vi.mock('./settlementChains.js', () => ({ settlementChainConfig: () => arc.entry }));
const roles = vi.hoisted(() => ({ verifier: '0x' + '01'.repeat(20), treasury: '0x' + '02'.repeat(20), admin: '0x' + '03'.repeat(20), fail: false }));
vi.mock('./chainRuntime.js', () => ({
  chainRuntime: () => ({
    escrow: {
      verifier: async () => { if (roles.fail) throw new Error('rpc down'); return roles.verifier; },
      treasury: async () => roles.treasury,
      admin: async () => roles.admin,
    },
  }),
}));
const identity = vi.hoisted(() => ({ allowed: true }));
vi.mock('./deploymentIdentity.js', () => ({ backgroundWritesAllowed: () => identity.allowed }));

const { gasSponsorSettings, runnableSettings, _resetSponsorRoles } = await import('./gasSponsorConfig.js');

function enable(o: Record<string, unknown> = {}) {
  cfg.gasSponsor = {
    enabled: true, privateKey: sponsorKey, maxGas: '200000', maxFeeGwei: '100', minTaskUsdc: '0.10',
    perAgentDaily: '10', perUserDaily: '20', perPosterDaily: '10', hourlyBudgetUsdc: '0.25', dailyBudgetUsdc: '1',
    maxStrikes: '3', maxFailuresPerHour: '5', ...o,
  };
}

beforeEach(() => {
  Object.assign(cfg, { databaseUrl: 'postgres://x', deploymentId: 'staging-arc', arcAgentDelegateAddress: DELEGATE, arcMarketplaceSignerPrivateKey: '', ogStoragePrivateKey: '' });
  cfg.gasSponsor = { enabled: false };
  arc.entry.escrowAddress = '0x' + 'e5'.repeat(20);
  Object.assign(roles, { verifier: '0x' + '01'.repeat(20), treasury: '0x' + '02'.repeat(20), admin: '0x' + '03'.repeat(20), fail: false });
  identity.allowed = true;
  _resetSponsorRoles();
});

describe('gasSponsorSettings', () => {
  it('is off by default, quietly', () => {
    expect(gasSponsorSettings()).toEqual({ enabled: false, reason: 'GAS_SPONSOR_ENABLED is not true', misconfigured: false });
  });

  it('is on with every piece in place, in wei and token units', () => {
    enable();
    expect(gasSponsorSettings()).toMatchObject({
      enabled: true, chainId: 5042002, delegate: ethers.getAddress(DELEGATE), maxGas: 200_000n, maxFeeWei: 100n * 10n ** 9n,
      minTaskRaw: 100_000n,
      caps: { perAgentDaily: 10, perUserDaily: 20, perPosterDaily: 10, hourlyBudgetWei: 25n * 10n ** 16n, dailyBudgetWei: 10n ** 18n, maxStrikes: 3 },
      maxFailuresPerHour: 5,
    });
  });

  it.each([
    ['no Postgres', () => { cfg.databaseUrl = ''; }, /DATABASE_URL/],
    ['no DEPLOYMENT_ID', () => { cfg.deploymentId = ''; }, /DEPLOYMENT_ID/],
    ['no Arc escrow', () => { arc.entry.escrowAddress = null; }, /no Arc escrow/],
    ['no delegate for this Arc chain', () => { cfg.arcAgentDelegateAddress = ''; }, /no BlindAgentDelegate is recorded for Arc chain 5042002/],
    ['no key', () => enable({ privateKey: '' }), /GAS_SPONSOR_PRIVATE_KEY is empty/],
    ['not a key', () => enable({ privateKey: 'nope' }), /not a private key/],
    ['a bad cap', () => enable({ perUserDaily: '0' }), /whole numbers above 0/],
    ['a bad budget', () => enable({ dailyBudgetUsdc: 'lots' }), /amounts above 0/],
  ])('stays off with %s', (_name, change, reason) => {
    enable();
    change();
    const s = gasSponsorSettings();
    expect(s.enabled).toBe(false);
    expect(s.enabled === false && s.reason).toMatch(reason);
  });

  it('refuses a sponsor that is one of the keys the backend signs with', () => {
    enable();
    cfg.arcMarketplaceSignerPrivateKey = sponsorKey;
    expect(gasSponsorSettings()).toMatchObject({ enabled: false, reason: expect.stringMatching(/ARC_MARKETPLACE_SIGNER_PRIVATE_KEY/) });
    cfg.arcMarketplaceSignerPrivateKey = '';
    cfg.ogStoragePrivateKey = sponsorKey.slice(2);
    expect(gasSponsorSettings()).toMatchObject({ enabled: false, reason: expect.stringMatching(/OG_STORAGE_PRIVATE_KEY/) });
  });
});

describe('runnableSettings', () => {
  it("runs when the sponsor is none of the escrow's roles and this backend owns its Redis", async () => {
    enable();
    expect(await runnableSettings('test')).toMatchObject({ ok: true });
  });

  it.each(['verifier', 'treasury', 'admin'] as const)("refuses a sponsor that is the escrow's %s", async (role) => {
    enable();
    roles[role] = SPONSOR;
    expect(await runnableSettings('test')).toEqual({ ok: false, reason: expect.stringMatching(new RegExp(`escrow's ${role}`)) });
  });

  it("stays off while a role can't be read, and on another deployment's Redis", async () => {
    enable();
    roles.fail = true;
    expect(await runnableSettings('test')).toEqual({ ok: false, reason: expect.stringMatching(/could not read the Arc escrow's verifier/) });
    roles.fail = false;
    identity.allowed = false;
    expect(await runnableSettings('test')).toEqual({ ok: false, reason: expect.stringMatching(/another deployment's Redis/) });
  });
});
