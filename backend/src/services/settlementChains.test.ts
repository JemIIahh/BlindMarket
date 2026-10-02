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

const BASE_ESCROW = '0xCca5ab873158b888158AD9Dc36fb4Ee683eFbEBf';
const ARC_ESCROW = '0x3600000000000000000000000000000000000000';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const NATIVE = '0x0000000000000000000000000000000000000000';

// Production settles on Base Sepolia. The RPC URLs are never dialled:
// providers use a static network and every read below is stubbed.
const PRODUCTION = {
  ogChainId: 16661,
  ogRpcUrl: 'http://127.0.0.1:9',
  blindEscrowAddress: '0x3d0374963DaaD43e31d42373eb11156A8e8ce2Ff',
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
  arcChainId: 5042002,
  arcRpcUrl: 'http://127.0.0.1:9',
  arcEscrowAddress: '',
  arcUsdcAddress: ARC_USDC,
  arcMarketplaceSignerPrivateKey: '',
  deploymentSet: '',
};

const cfg = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock('../config.js', () => ({ config: cfg }));
Object.assign(cfg, PRODUCTION);

const {
  SETTLEMENT_CHAIN_KEYS,
  settlementChainConfig,
  withdrawReserveWei,
  WITHDRAW_TX_GAS,
  settlementChainConfigs,
  configuredChainKeys,
  assertRegistryInvariants,
  postingChain,
  receiptSearchOrder,
  assertPostingChain,
} = await import('./settlementChains.js');
const chain = await import('./chain.js');
const { chainRuntime } = await import('./chainRuntime.js');

beforeEach(() => {
  for (const key of Object.keys(cfg)) delete cfg[key];
  Object.assign(cfg, PRODUCTION);
});

describe('entries with production config', () => {
  it('Base is testnet, pays in USDC with 6 decimals, and records smart accounts as workers', () => {
    expect(settlementChainConfig('base')).toMatchObject({
      key: 'base',
      label: 'Base',
      chainId: 84532,
      tier: 'testnet',
      hardhatNetwork: 'base-sepolia',
      escrowAddress: BASE_ESCROW,
      escrowEnv: 'BASE_CHAIN_ID=84532 record',
      signerEnv: 'BASE_MARKETPLACE_SIGNER_PRIVATE_KEY',
      deploymentBlockEnv: 'BASE_ESCROW_DEPLOYMENT_BLOCK',
      token: { kind: 'erc20', address: USDC, unit: { symbol: 'USDC', decimals: 6 } },
      relayCaip2: 'eip155:84532',
      aa: true,
      hasTaskRegistry: false,
    });
  });

  it('Arc is testnet, pays in USDC, gas is also USDC, no smart accounts', () => {
    expect(settlementChainConfig('arc')).toMatchObject({
      key: 'arc',
      label: 'Arc',
      chainId: 5042002,
      tier: 'testnet',
      hardhatNetwork: 'arc-testnet',
      escrowAddress: null,
      escrowEnv: 'ARC_CHAIN_ID=5042002 record',
      signerEnv: 'ARC_MARKETPLACE_SIGNER_PRIVATE_KEY',
      deploymentBlockEnv: 'ARC_ESCROW_DEPLOYMENT_BLOCK',
      token: { kind: 'erc20', address: ARC_USDC, unit: { symbol: 'USDC', decimals: 6 } },
      relayCaip2: null,
      aa: false,
      hasTaskRegistry: false,
    });
  });

  it('keeps the withdraw gas numbers', () => {
    expect(settlementChainConfig('base').gas).toEqual({
      symbol: 'ETH',
      nativeIsSettlementToken: false,
      withdrawReserveWei: ethers.parseEther('0.0003'),
      withdrawMinWei: ethers.parseEther('0.00005'),
      workerTxGasLimit: 300_000n,
    });
    expect(settlementChainConfig('arc').gas).toEqual({
      symbol: 'USDC',
      nativeIsSettlementToken: true,
      withdrawReserveWei: ethers.parseEther('0.01'),
      withdrawMinWei: ethers.parseEther('0.002'),
      workerTxGasLimit: 200_000n,
    });
  });

  describe("what an Arc withdraw leaves behind follows the worker's gas gate", () => {
    const gwei = (n: number) => ethers.parseUnits(String(n), 'gwei');
    // ethers' getFeeData on Arc: maxFeePerGas is twice the base fee, gasPrice
    // the base fee (Arc mainnet read 2026-10-02: 20 gwei → 40 gwei max fee).
    const fees = (base: number) => ({ maxFeePerGas: 2n * gwei(base), gasPrice: gwei(base) });
    const arcGas = () => settlementChainConfig('arc').gas;
    const gate = (base: number) => arcGas().workerTxGasLimit * 2n * gwei(base);

    it.each([
      [20, '0.0103'], // 0.0088 (gate × 1.1) + 0.0015 (the withdraw's own gas)
      [25, '0.012875'],
      [60, '0.0309'],
    ])('at a %i gwei base fee it keeps %s USDC', (base, kept) => {
      expect(ethers.formatEther(withdrawReserveWei(arcGas(), fees(base)))).toBe(kept);
    });

    it.each([20, 25, 60, 200])('leaves the gate covered after the withdraw pays its own gas at %i gwei', (base) => {
      const left = withdrawReserveWei(arcGas(), fees(base)) - WITHDRAW_TX_GAS * gwei(base);
      expect(left).toBeGreaterThanOrEqual(gate(base));
    });

    it('keeps the 0.01 USDC floor when fees are low or could not be read', () => {
      expect(withdrawReserveWei(arcGas(), fees(1))).toBe(ethers.parseEther('0.01'));
      expect(withdrawReserveWei(arcGas(), null)).toBe(ethers.parseEther('0.01'));
      expect(withdrawReserveWei(arcGas(), { maxFeePerGas: null, gasPrice: null })).toBe(ethers.parseEther('0.01'));
    });

    it('prices the gate at gasPrice where the chain reports no max fee', () => {
      expect(withdrawReserveWei(arcGas(), { maxFeePerGas: null, gasPrice: gwei(100) }))
        .toBe((200_000n * gwei(100) * 11n) / 10n + WITHDRAW_TX_GAS * gwei(100));
    });
  });

  it('lists Base, then Arc', () => {
    expect(SETTLEMENT_CHAIN_KEYS).toEqual(['base', 'arc']);
    expect(settlementChainConfigs().map((c) => c.key)).toEqual(['base', 'arc']);
    expect(configuredChainKeys()).toEqual(['base']);
  });

  it('reads config when called, not at import', () => {
    Object.assign(cfg, { baseChainId: 8453, arcChainId: 5042 });
    expect(settlementChainConfig('base')).toMatchObject({ tier: 'mainnet', hardhatNetwork: 'base', relayCaip2: 'eip155:8453' });
    expect(settlementChainConfig('arc')).toMatchObject({ tier: 'mainnet', hardhatNetwork: 'arc-mainnet' });
  });

  it("reads each chain's RPC endpoint from its own setting", () => {
    Object.assign(cfg, { baseRpcUrl: 'https://base.example/v2/key', arcRpcUrl: 'https://arc.example/v2/key' });
    expect(settlementChainConfig('base').rpcUrl).toBe('https://base.example/v2/key');
    expect(settlementChainConfig('arc').rpcUrl).toBe('https://arc.example/v2/key');
  });

  it('throws on a chain it does not know', () => {
    expect(() => settlementChainConfig('0g' as never)).toThrow(/unknown settlement chain 0g/);
  });
});

describe('a deployment that does not settle on Arc', () => {
  it('still knows Arc, but has no escrow there', () => {
    expect(configuredChainKeys()).toEqual(['base']);
    expect(settlementChainConfigs()).toHaveLength(2);
    expect(settlementChainConfig('arc').escrowAddress).toBeNull();
  });

  it('treats a zero-address escrow as none', () => {
    cfg.baseEscrowAddress = NATIVE;
    expect(settlementChainConfig('base').escrowAddress).toBeNull();
    expect(configuredChainKeys()).toEqual([]);
  });

  it('has no Arc settlement token when USDC is not configured', () => {
    cfg.arcUsdcAddress = '';
    expect(settlementChainConfig('arc').token).toMatchObject({ kind: 'erc20', address: null });
  });
});

describe('assertRegistryInvariants', () => {
  const base = () => settlementChainConfig('base');

  it('passes the entries production builds', () => {
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
      token: { kind: 'erc20' as const, address: ARC_USDC, unit: base().token.unit },
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
    expect(() => assertRegistryInvariants([{ ...entry, escrowAddress: null }])).toThrow(/decimals must be 6 or 18/);
  });

  it('only warns about the token of a chain this deployment does not settle on', () => {
    Object.assign(cfg, { baseEscrowAddress: NATIVE, baseUsdcAddress: NATIVE });
    let warnings: string[] = [];
    expect(() => { warnings = assertRegistryInvariants(settlementChainConfigs()); }).not.toThrow();
    expect(warnings).toEqual([expect.stringMatching(/^base: token kind is erc20/)]);

    const arcLike = {
      ...base(),
      escrowAddress: null,
      token: { kind: 'erc20' as const, address: null, unit: base().token.unit },
      gas: { ...base().gas, nativeIsSettlementToken: true },
    };
    expect(assertRegistryInvariants([arcLike])).toEqual([expect.stringMatching(/settlement token must be its ERC-20/)]);
  });

  it('returns no warnings for the entries production builds', () => {
    expect(assertRegistryInvariants(settlementChainConfigs())).toEqual([]);
  });
});

describe('posting chain', () => {
  it('is Arc when it has an escrow, else Base', () => {
    // Arc unset but Base set → Base.
    expect(postingChain()).toBe('base');
    cfg.arcEscrowAddress = ARC_ESCROW;
    expect(postingChain()).toBe('arc');
    cfg.baseEscrowAddress = '';
    expect(postingChain()).toBe('arc');
  });

  it('looks for a receipt on the posting chain first, then the other chains with an escrow', () => {
    expect(receiptSearchOrder()).toEqual(['base']);
    cfg.arcEscrowAddress = ARC_ESCROW;
    expect(receiptSearchOrder()).toEqual(['arc', 'base']);
  });

  it('refuses a posting chain that is not on the deployment tier', () => {
    cfg.arcEscrowAddress = ARC_ESCROW; // Arc testnet
    expect(() => assertPostingChain({ tier: 'mainnet' })).toThrow(/but SETTLEMENT_TIER=mainnet/);
    expect(assertPostingChain({ tier: 'testnet' })).toEqual([]);
  });

  it('reports (does not throw) when the default posting chain has no escrow', () => {
    cfg.baseEscrowAddress = '';
    cfg.arcEscrowAddress = '';
    expect(assertPostingChain({})).toEqual([expect.stringMatching(/has no escrow/)]);
  });
});

describe('getTokenDecimals', () => {
  let baseCall: ReturnType<typeof vi.spyOn>;
  let baseSend: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const offline = async () => { throw new Error('no RPC in this test'); };
    baseCall = vi.spyOn(chain.baseProvider, 'call').mockImplementation(offline);
    baseSend = vi.spyOn(chain.baseProvider, 'send').mockImplementation(offline);
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

  it('returns 18 for a native task on either chain without a read', async () => {
    expect(await chain.getTokenDecimals(NATIVE, 'arc')).toBe(18);
    expect(await chain.getTokenDecimals(NATIVE, 'base')).toBe(18);
    expect(baseCall).not.toHaveBeenCalled();
  });
});

describe('chainRuntime', () => {
  it("hands out each chain's own provider and escrow", () => {
    expect(chainRuntime('base').provider).toBe(chain.baseProvider);
    expect(chainRuntime('base').escrow).toBe(chain.baseEscrow);
    expect(chainRuntime('arc').provider).toBe(chain.arcProvider);
    expect(chainRuntime('arc').escrow).toBe(chain.arcEscrow);
  });

  it('has no marketplace signer without a key', () => {
    expect(chainRuntime('base').marketplaceSigner).toBeNull();
    expect(chainRuntime('arc').escrowAsMarketplace).toBeNull();
  });

  it('throws on a chain it does not know', () => {
    expect(() => chainRuntime('0g' as never)).toThrow(/unknown settlement chain 0g/);
    expect(() => chainRuntime('toString' as never)).toThrow(/unknown settlement chain/);
  });
});
