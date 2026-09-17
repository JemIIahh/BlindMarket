/**
 * The settlement chain registry: each chain's facts as data.
 *
 * Pins the entries production builds today, the boot invariants that keep a
 * chain from booking its native coin as an ERC-20 settlement token (Arc's USDC
 * is both), and the readers that now take their numbers from the registry.
 *
 * Run: npx vitest run src/services/settlementChains.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ethers } from 'ethers';

const OG_ESCROW = '0x3d0374963DaaD43e31d42373eb11156A8e8ce2Ff';
const BASE_ESCROW = '0xCca5ab873158b888158AD9Dc36fb4Ee683eFbEBf';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const NATIVE = '0x0000000000000000000000000000000000000000';

// Production pairs 0G mainnet with Base Sepolia. The RPC URLs are never
// dialled: providers use a static network and every read below is stubbed.
const PRODUCTION = {
  ogChainId: 16661,
  ogRpcUrl: 'http://127.0.0.1:9',
  blindEscrowAddress: OG_ESCROW,
  taskRegistryAddress: '0x1111111111111111111111111111111111111111',
  blindReputationAddress: '0x2222222222222222222222222222222222222222',
  inftAddress: '',
  ogStoragePrivateKey: '',
  marketplaceSignerPrivateKey: '',
  baseChainId: 84532,
  baseRpcUrl: 'http://127.0.0.1:9',
  baseEscrowAddress: BASE_ESCROW,
  baseUsdcAddress: USDC,
  baseMarketplaceSignerPrivateKey: '',
  deploymentSet: '',
};

const cfg = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock('../config.js', () => ({ config: cfg }));
Object.assign(cfg, PRODUCTION);

const {
  SETTLEMENT_CHAIN_KEYS,
  settlementChainConfig,
  settlementChainConfigs,
  configuredChainKeys,
  assertRegistryInvariants,
} = await import('./settlementChains.js');
const chain = await import('./chain.js');
const { chainRuntime } = await import('./chainRuntime.js');

beforeEach(() => {
  for (const key of Object.keys(cfg)) delete cfg[key];
  Object.assign(cfg, PRODUCTION);
});

describe('entries with production config', () => {
  it('0G is mainnet, pays in native 0G, and records EOAs as workers', () => {
    expect(settlementChainConfig('0g')).toMatchObject({
      key: '0g',
      label: '0G',
      chainId: 16661,
      tier: 'mainnet',
      hardhatNetwork: '0g-mainnet',
      escrowAddress: OG_ESCROW,
      escrowEnv: 'BLIND_ESCROW_ADDRESS',
      signerEnv: 'MARKETPLACE_SIGNER_PRIVATE_KEY',
      deploymentBlockEnv: 'ESCROW_DEPLOYMENT_BLOCK',
      token: { kind: 'native', address: NATIVE, unit: { symbol: '0G', decimals: 18 } },
      relayCaip2: null,
      aa: false,
    });
  });

  it('Base is testnet, pays in USDC with 6 decimals, and records smart accounts as workers', () => {
    expect(settlementChainConfig('base')).toMatchObject({
      key: 'base',
      label: 'Base',
      chainId: 84532,
      tier: 'testnet',
      hardhatNetwork: 'base-sepolia',
      escrowAddress: BASE_ESCROW,
      escrowEnv: 'BASE_ESCROW_ADDRESS',
      signerEnv: 'BASE_MARKETPLACE_SIGNER_PRIVATE_KEY',
      deploymentBlockEnv: 'BASE_ESCROW_DEPLOYMENT_BLOCK',
      token: { kind: 'erc20', address: USDC, unit: { symbol: 'USDC', decimals: 6 } },
      relayCaip2: 'eip155:84532',
      aa: true,
    });
  });

  it('keeps the withdraw gas numbers routes/agents.ts used', () => {
    expect(settlementChainConfig('0g').gas).toEqual({
      symbol: '0G',
      nativeIsSettlementToken: false,
      withdrawReserveWei: ethers.parseEther('0.001'),
      withdrawMinWei: ethers.parseEther('0.0002'),
    });
    expect(settlementChainConfig('base').gas).toEqual({
      symbol: 'ETH',
      nativeIsSettlementToken: false,
      withdrawReserveWei: ethers.parseEther('0.0003'),
      withdrawMinWei: ethers.parseEther('0.00005'),
    });
  });

  it('lists 0G, then Base', () => {
    expect(SETTLEMENT_CHAIN_KEYS).toEqual(['0g', 'base']);
    expect(settlementChainConfigs().map((c) => c.key)).toEqual(['0g', 'base']);
    expect(configuredChainKeys()).toEqual(['0g', 'base']);
  });

  it('reads config when called, not at import', () => {
    Object.assign(cfg, { ogChainId: 16602, baseChainId: 8453 });
    expect(settlementChainConfig('0g')).toMatchObject({ tier: 'testnet', hardhatNetwork: '0g-testnet' });
    expect(settlementChainConfig('base')).toMatchObject({ tier: 'mainnet', hardhatNetwork: 'base', relayCaip2: 'eip155:8453' });
  });

  it('throws on a chain it does not know', () => {
    expect(() => settlementChainConfig('arc' as never)).toThrow(/unknown settlement chain arc/);
  });
});

describe('a deployment that does not settle on Base', () => {
  it('still knows Base, but has no escrow there', () => {
    cfg.baseEscrowAddress = '';
    expect(configuredChainKeys()).toEqual(['0g']);
    expect(settlementChainConfigs()).toHaveLength(2);
    expect(settlementChainConfig('base').escrowAddress).toBeNull();
  });

  it('treats a zero-address escrow as none', () => {
    cfg.blindEscrowAddress = NATIVE;
    expect(settlementChainConfig('0g').escrowAddress).toBeNull();
    expect(configuredChainKeys()).toEqual(['base']);
  });

  it('has no Base settlement token when USDC is not configured', () => {
    cfg.baseUsdcAddress = '';
    expect(settlementChainConfig('base').token).toMatchObject({ kind: 'erc20', address: null });
  });
});

describe('assertRegistryInvariants', () => {
  const base = () => settlementChainConfig('base');

  it('passes the entries production builds, with or without a Base escrow or USDC', () => {
    expect(() => assertRegistryInvariants(settlementChainConfigs())).not.toThrow();
    Object.assign(cfg, { baseEscrowAddress: '', baseUsdcAddress: '' });
    expect(() => assertRegistryInvariants(settlementChainConfigs())).not.toThrow();
  });

  it('passes the entries the real config defaults build', async () => {
    const real = await vi.importActual<typeof import('../config.js')>('../config.js');
    Object.assign(cfg, real.config);
    expect(() => assertRegistryInvariants(settlementChainConfigs())).not.toThrow();
  });

  it('refuses a chain whose native gas coin is the settlement asset but books address(0)', () => {
    const arcLike = {
      ...base(),
      token: { kind: 'native' as const, address: NATIVE, unit: base().token.unit },
      gas: { ...base().gas, symbol: 'USDC', nativeIsSettlementToken: true },
    };
    expect(() => assertRegistryInvariants([arcLike])).toThrow(/settlement token must be its ERC-20/);
  });

  it('accepts that chain when it books the ERC-20', () => {
    const arcLike = {
      ...base(),
      token: { kind: 'erc20' as const, address: '0x3600000000000000000000000000000000000000', unit: base().token.unit },
      gas: { ...base().gas, symbol: 'USDC', nativeIsSettlementToken: true },
    };
    expect(() => assertRegistryInvariants([arcLike])).not.toThrow();
    expect(() => assertRegistryInvariants([{ ...arcLike, token: { ...arcLike.token, address: null } }])).toThrow(
      /settlement token must be its ERC-20/,
    );
  });

  it('refuses a native token at a non-zero address', () => {
    const entry = { ...base(), token: { ...base().token, kind: 'native' as const } };
    expect(() => assertRegistryInvariants([entry])).toThrow(/token kind is native/);
  });

  it('refuses an ERC-20 at address(0)', () => {
    const entry = { ...base(), token: { ...base().token, address: NATIVE } };
    expect(() => assertRegistryInvariants([entry])).toThrow(/token kind is erc20/);
  });

  it('refuses decimals other than 6 or 18', () => {
    const entry = { ...base(), token: { ...base().token, unit: { symbol: 'USDC', decimals: 8 } as never } };
    expect(() => assertRegistryInvariants([entry])).toThrow(/decimals must be 6 or 18, not 8/);
  });
});

describe('getTokenDecimals', () => {
  let baseCall: ReturnType<typeof vi.spyOn>;
  let baseSend: ReturnType<typeof vi.spyOn>;
  let ogCall: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const offline = async () => { throw new Error('no RPC in this test'); };
    baseCall = vi.spyOn(chain.baseProvider, 'call').mockImplementation(offline);
    baseSend = vi.spyOn(chain.baseProvider, 'send').mockImplementation(offline);
    ogCall = vi.spyOn(chain.provider, 'call').mockImplementation(offline);
  });

  afterEach(() => vi.restoreAllMocks());

  it("answers Base's USDC from the registry without an RPC call", async () => {
    expect(await chain.getTokenDecimals(USDC, 'base')).toBe(6);
    expect(await chain.getTokenDecimals(USDC.toLowerCase(), 'base')).toBe(6);
    expect(baseCall).not.toHaveBeenCalled();
    expect(baseSend).not.toHaveBeenCalled();
  });

  it('still reads any other token on-chain, falling back to 18', async () => {
    expect(await chain.getTokenDecimals('0x4444444444444444444444444444444444444444', 'base')).toBe(18);
    expect(baseCall).toHaveBeenCalledTimes(1);
  });

  it("does not treat Base's USDC as 0G's settlement token", async () => {
    expect(await chain.getTokenDecimals(USDC)).toBe(18);
    expect(ogCall).toHaveBeenCalledTimes(1);
    expect(baseCall).not.toHaveBeenCalled();
  });

  it('returns 18 for a native task on either chain without a read', async () => {
    expect(await chain.getTokenDecimals(NATIVE, '0g')).toBe(18);
    expect(await chain.getTokenDecimals(NATIVE, 'base')).toBe(18);
    expect(ogCall).not.toHaveBeenCalled();
    expect(baseCall).not.toHaveBeenCalled();
  });

  it('reads on-chain when no Base USDC is configured', async () => {
    cfg.baseUsdcAddress = '';
    expect(await chain.getTokenDecimals(USDC, 'base')).toBe(18);
    expect(baseCall).toHaveBeenCalledTimes(1);
  });
});

describe('chainRuntime', () => {
  it("hands out each chain's own provider and escrow", () => {
    expect(chainRuntime('0g').provider).toBe(chain.provider);
    expect(chainRuntime('0g').escrow).toBe(chain.escrow);
    expect(chainRuntime('base').provider).toBe(chain.baseProvider);
    expect(chainRuntime('base').escrow).toBe(chain.baseEscrow);
    expect(chainRuntime('base').escrow).not.toBeNull();
  });

  it('has no marketplace signer without a key', () => {
    expect(chainRuntime('0g').marketplaceSigner).toBeNull();
    expect(chainRuntime('base').escrowAsMarketplace).toBeNull();
  });

  it('throws on a chain it does not know', () => {
    expect(() => chainRuntime('arc' as never)).toThrow(/unknown settlement chain arc/);
    expect(() => chainRuntime('toString' as never)).toThrow(/unknown settlement chain/);
  });
});
