import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Every provider takes its chain id on trust (staticNetwork), so an RPC for
 * another network was read and signed through as if it were this one: a
 * testnet ARC_RPC_URL left in place after ARC_CHAIN_ID moved to mainnet would
 * have indexed testnet as mainnet. Boot now asks each RPC for its chain id.
 * The stack mocked here is Arc mainnet next to the Base Sepolia escrow, with
 * bridging on the mainnet tier.
 */

const m = vi.hoisted(() => ({
  og: { send: vi.fn() },
  base: { send: vi.fn() },
  arc: { send: vi.fn() },
  cctpArc: { send: vi.fn() },
  polygon: { send: vi.fn() },
  settles: [] as Array<'base' | 'arc'>,
  cctp: false,
  disableCctpLeg: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('@sentry/node', () => ({ captureMessage: m.captureMessage }));
vi.mock('../middleware/errorHandler.js', () => ({ flushSentry: vi.fn(async () => {}) }));
vi.mock('../config.js', () => ({ config: { ogChainId: 16661 } }));
vi.mock('./chain.js', () => ({ provider: m.og }));
vi.mock('./chainRuntime.js', () => ({ chainRuntime: (key: 'base' | 'arc') => ({ provider: m[key] }) }));
vi.mock('./settlementChains.js', () => ({
  configuredChainKeys: () => m.settles,
  settlementChainConfig: (key: 'base' | 'arc') => (key === 'arc'
    ? { label: 'Arc', rpcEnv: 'ARC_RPC_URL', chainId: 5042 }
    : { label: 'Base', rpcEnv: 'BASE_RPC_URL', chainId: 84532 }),
}));
vi.mock('./cctpChains.js', () => ({
  isCctpConfigured: () => m.cctp,
  disableCctpLeg: m.disableCctpLeg,
  supportedCctpChains: () => [
    { chainKey: 'arc', label: 'Arc', chainId: 5042, rpc: m.cctpArc },
    { chainKey: 'polygon', label: 'Polygon PoS', chainId: 137, rpc: m.polygon },
  ],
}));

const { assertRpcChainIds, bootRpcEndpoints, checkRpcChainIds } = await import('./rpcChainIds.js');

const OG = '0x4115'; // 16661
const ARC_MAINNET = '0x13b2'; // 5042
const ARC_TESTNET = '0x4cef52'; // 5042002
const BASE_SEPOLIA = '0x14a34'; // 84532
const POLYGON = '0x89'; // 137

let errored: string[];
let warned: string[];

beforeEach(() => {
  for (const p of [m.og, m.base, m.arc, m.cctpArc, m.polygon]) p.send.mockReset();
  m.og.send.mockResolvedValue(OG);
  m.base.send.mockResolvedValue(BASE_SEPOLIA);
  m.arc.send.mockResolvedValue(ARC_MAINNET);
  m.cctpArc.send.mockResolvedValue(ARC_MAINNET);
  m.polygon.send.mockResolvedValue(POLYGON);
  m.settles = ['base', 'arc'];
  m.cctp = true;
  m.disableCctpLeg.mockReset();
  m.captureMessage.mockReset();
  errored = [];
  warned = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errored.push(a.join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warned.push(a.join(' ')); });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('checkRpcChainIds', () => {
  it('passes RPCs that serve their chain', async () => {
    expect(await checkRpcChainIds(bootRpcEndpoints())).toEqual({ fatal: [], disabled: [], unanswered: [] });
    expect(m.arc.send).toHaveBeenCalledWith('eth_chainId', []);
  });

  it('reports an RPC the backend cannot run without on another network, naming its setting', async () => {
    m.arc.send.mockResolvedValue(ARC_TESTNET);
    const report = await checkRpcChainIds(bootRpcEndpoints());
    expect(report.fatal).toEqual(['Arc (ARC_RPC_URL) serves chain 5042002, not 5042']);
    expect(m.disableCctpLeg).not.toHaveBeenCalled();
  });

  it('turns off a CCTP leg on another network instead: bridging is optional', async () => {
    m.polygon.send.mockResolvedValue('0x13882'); // Amoy
    const report = await checkRpcChainIds(bootRpcEndpoints());
    expect(report).toMatchObject({ fatal: [], disabled: ['CCTP Polygon PoS (CCTP_POLYGON_RPC_URL) serves chain 80002, not 137'] });
    expect(m.disableCctpLeg).toHaveBeenCalledWith('polygon');
  });

  it('only reports an RPC that gives no usable answer, and reads number answers', async () => {
    m.arc.send.mockReturnValue(new Promise(() => {}));
    m.base.send.mockRejectedValue(new Error('ECONNRESET'));
    m.polygon.send.mockResolvedValue({ chainId: 137 });
    m.og.send.mockResolvedValue(16661);
    m.cctpArc.send.mockResolvedValue('5042');
    const report = await checkRpcChainIds(bootRpcEndpoints(), 20);
    expect(report.fatal).toEqual([]);
    expect(report.unanswered.map((u) => u.reason).sort()).toEqual([
      'Arc (ARC_RPC_URL) did not answer eth_chainId (no answer in 0.02s), so its chain is unchecked',
      'Base (BASE_RPC_URL) did not answer eth_chainId (ECONNRESET), so its chain is unchecked',
      'CCTP Polygon PoS (CCTP_POLYGON_RPC_URL) answered eth_chainId with {"chainId":137}, so its chain is unchecked',
    ]);
  });

  it('asks a provider behind two settings once, and checks it against each', async () => {
    const shared = { send: vi.fn(async () => BASE_SEPOLIA) };
    const report = await checkRpcChainIds([
      { name: 'Base (BASE_RPC_URL)', chainId: 84532, provider: shared },
      { name: 'CCTP Base Sepolia (CCTP_BASE_RPC_URL)', chainId: 84532, provider: shared, cctpLeg: 'base-sepolia' },
      { name: 'Other (OTHER_RPC_URL)', chainId: 8453, provider: shared },
    ]);
    expect(shared.send).toHaveBeenCalledTimes(1);
    expect(report.fatal).toEqual(['Other (OTHER_RPC_URL) serves chain 84532, not 8453']);
  });
});

describe('assertRpcChainIds, the boot check', () => {
  it('stops the boot on a wrong chain', async () => {
    m.arc.send.mockResolvedValue(ARC_TESTNET);
    await expect(assertRpcChainIds(bootRpcEndpoints())).rejects.toThrow(
      /RPC on the wrong network: Arc \(ARC_RPC_URL\) serves chain 5042002, not 5042\. Point each setting/,
    );
    expect(errored).toContain('[boot] rpc: Arc (ARC_RPC_URL) serves chain 5042002, not 5042');
  });

  it('boots with a CCTP leg on the wrong chain turned off, and reports it', async () => {
    m.polygon.send.mockResolvedValue(ARC_MAINNET);
    await expect(assertRpcChainIds(bootRpcEndpoints())).resolves.toBeUndefined();
    expect(errored.join('\n')).toMatch(/CCTP Polygon PoS \(CCTP_POLYGON_RPC_URL\) serves chain 5042, not 137: bridging on that leg is off/);
    expect(m.captureMessage).toHaveBeenCalledWith(expect.stringContaining('CCTP Polygon PoS'), 'error');
  });

  it('boots past an RPC that does not answer, then asks it again until it does', async () => {
    vi.useFakeTimers();
    const onWrongChain = vi.fn();
    m.arc.send.mockReturnValue(new Promise(() => {}));
    const boot = assertRpcChainIds(bootRpcEndpoints(), { timeoutMs: 20, recheckMs: 1000, onWrongChain });
    await vi.advanceTimersByTimeAsync(20);
    await expect(boot).resolves.toBeUndefined();
    expect(warned.join('\n')).toMatch(/Arc \(ARC_RPC_URL\) did not answer eth_chainId .*asking again every minute/);

    // Still silent: asked again, nothing else is.
    m.og.send.mockClear();
    await vi.advanceTimersByTimeAsync(1020);
    expect(m.arc.send).toHaveBeenCalledTimes(2);
    expect(m.og.send).not.toHaveBeenCalled();

    // It answers, on the wrong network: stopped as boot would have.
    m.arc.send.mockResolvedValue(ARC_TESTNET);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onWrongChain).toHaveBeenCalledWith('RPC on the wrong network: Arc (ARC_RPC_URL) serves chain 5042002, not 5042');

    // Nothing is asked after that.
    await vi.advanceTimersByTimeAsync(5000);
    expect(m.arc.send).toHaveBeenCalledTimes(3);
  });

  it('stops asking once a late answer is right', async () => {
    vi.useFakeTimers();
    const onWrongChain = vi.fn();
    m.arc.send.mockReturnValueOnce(new Promise(() => {}));
    const boot = assertRpcChainIds(bootRpcEndpoints(), { timeoutMs: 20, recheckMs: 1000, onWrongChain });
    await vi.advanceTimersByTimeAsync(20);
    await boot;
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(m.arc.send).toHaveBeenCalledTimes(2);
    expect(onWrongChain).not.toHaveBeenCalled();
  });
});

describe('bootRpcEndpoints', () => {
  const names = () => bootRpcEndpoints().map((e) => e.name);

  it('checks 0G, each chain this deployment settles on, and CCTP legs while bridging is on', () => {
    expect(names()).toEqual([
      '0G (OG_RPC_URL)',
      'Base (BASE_RPC_URL)',
      'Arc (ARC_RPC_URL)',
      'CCTP Arc (CCTP_ARC_RPC_URL)',
      'CCTP Polygon PoS (CCTP_POLYGON_RPC_URL)',
    ]);
    expect(bootRpcEndpoints().filter((e) => e.cctpLeg).map((e) => e.cctpLeg)).toEqual(['arc', 'polygon']);
    m.cctp = false;
    m.settles = [];
    expect(names()).toEqual(['0G (OG_RPC_URL)']);
  });
});
