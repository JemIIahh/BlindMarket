import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The worker reads its settlement chains from SETTLEMENT_CHAINS_JSON, the
 * table the backend builds from its registry, and falls back to the legacy
 * OG_ and BASE_ vars when an older backend injects none. Adding a chain is
 * then a backend config change, not an edit to worker.js.
 *
 * What this worker can SIGN for stays a property of its code: a table naming a
 * chain this file does not know must not be declared at registration, or the
 * agent would be offered tasks it cannot deliver.
 */

vi.mock('ai', () => ({ tool: (d: unknown) => d, generateText: vi.fn(), generateObject: vi.fn(), stepCountIs: (n: number) => n }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => () => 'm' }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: () => () => 'm' }));
vi.mock('@ai-sdk/groq', () => ({ createGroq: () => () => 'm' }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), emit: vi.fn() }) }));

const OG_ESCROW = '0x0a0a000000000000000000000000000000000002';
const BASE_ESCROW = '0xCca5ab873158b888158AD9Dc36fb4Ee683eFbEBf';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const NATIVE = '0x0000000000000000000000000000000000000000';
const KEY = '0x' + '11'.repeat(32);

const TABLE = [
  {
    key: '0g', chainId: 16661, rpcUrl: 'https://og.example/rpc', escrow: OG_ESCROW,
    token: { address: NATIVE, kind: 'native', symbol: '0G', decimals: 18 },
    gasSymbol: '0G', nativeIsSettlementToken: false, aa: false, posting: false,
  },
  {
    key: 'base', chainId: 84532, rpcUrl: 'https://base.example/rpc', escrow: BASE_ESCROW,
    token: { address: USDC, kind: 'erc20', symbol: 'USDC', decimals: 6 },
    gasSymbol: 'ETH', nativeIsSettlementToken: false, aa: true, posting: true,
  },
];

const ORIGINAL = { ...process.env };

/** Import a fresh worker under `env`; every chain var is cleared first. */
async function loadWorker(env: Record<string, string>) {
  vi.resetModules();
  process.env = {
    ...ORIGINAL,
    SETTLEMENT_CHAINS_JSON: '', OG_RPC_URL: '', OG_CHAIN_ID: '', BASE_RPC_URL: '', BASE_CHAIN_ID: '',
    AGENT_ESCROW_ADDRESS: '', AGENT_BASE_ESCROW_ADDRESS: '', AA_USDC: '', AGENT_PRIVATE_KEY: KEY,
    AGENT_WALLET: '', AGENT_ID: 'test-agent',
    ...env,
  };
  // @ts-expect-error — plain-JS worker, no d.ts
  return import('./worker.js');
}

afterEach(() => {
  process.env = { ...ORIGINAL };
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const rpcOf = (signer: { provider: { _getConnection: () => { url: string } } }) => signer.provider._getConnection().url;

describe('the backend table and the legacy env agree', () => {
  const legacyEnv = {
    OG_RPC_URL: 'https://og.example/rpc', OG_CHAIN_ID: '16661', AGENT_ESCROW_ADDRESS: OG_ESCROW,
    BASE_RPC_URL: 'https://base.example/rpc', BASE_CHAIN_ID: '84532', AGENT_BASE_ESCROW_ADDRESS: BASE_ESCROW,
    AA_USDC: USDC,
  };

  it('build the same signers and escrows', async () => {
    const fromTable = await loadWorker({ SETTLEMENT_CHAINS_JSON: JSON.stringify(TABLE) });
    const fromLegacy = await loadWorker(legacyEnv);

    for (const chain of ['0g', 'base'] as const) {
      expect(fromTable.escrowAddressFor(chain)).toBe(fromLegacy.escrowAddressFor(chain));
      expect(rpcOf(fromTable.signerFor(chain))).toBe(rpcOf(fromLegacy.signerFor(chain)));
      expect(fromTable.chainInfo(chain).chainId).toBe(fromLegacy.chainInfo(chain).chainId);
    }
    expect(fromTable.escrowAddressFor('base')).toBe(BASE_ESCROW);
    expect(fromTable.postingChainInfo().key).toBe(fromLegacy.postingChainInfo().key);
  });

  it('agree that a Base-configured deployment posts on Base', async () => {
    const { postingChainInfo } = await loadWorker(legacyEnv);
    expect(postingChainInfo()).toMatchObject({ key: 'base', token: { symbol: 'USDC', decimals: 6 } });
  });

  it('post on 0G when the backend says so, which the legacy vars could not express', async () => {
    const posting0g = TABLE.map((c) => ({ ...c, posting: c.key === '0g' }));
    const { postingChainInfo } = await loadWorker({ SETTLEMENT_CHAINS_JSON: JSON.stringify(posting0g) });
    expect(postingChainInfo()).toMatchObject({ key: '0g', token: { kind: 'native', symbol: '0G' } });
  });
});

describe('a chain this worker does not know', () => {
  const withArc = [...TABLE, {
    key: 'arc', chainId: 5042002, rpcUrl: 'https://arc.example/rpc', escrow: '0xa4c0000000000000000000000000000000000003',
    token: { address: USDC, kind: 'erc20', symbol: 'USDC', decimals: 6 },
    gasSymbol: 'USDC', nativeIsSettlementToken: true, aa: false, posting: true,
  }];

  it('is never declared at registration, whatever the backend configures', async () => {
    const { registrationBody } = await loadWorker({ SETTLEMENT_CHAINS_JSON: JSON.stringify(withArc) });
    expect(registrationBody({ displayName: 'a', capabilities: [], publicKey: '04ab' }).supportedChains).toEqual(['0g', 'base']);
  });

  it('is refused before accepting a task on it', async () => {
    const { pickChain, isUnsupportedChain, acceptBlocker } = await loadWorker({ SETTLEMENT_CHAINS_JSON: JSON.stringify(withArc) });
    expect(isUnsupportedChain('arc')).toBe(true);
    expect(() => pickChain('arc')).toThrow(/not supported by this worker/);
    expect(await acceptBlocker('arc', async () => null)).toMatchObject({ unsupported: true });
  });
});

describe('a table the backend did not send, or sent broken', () => {
  it('falls back to the legacy vars on malformed JSON, and says so', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: string) => { errors.push(String(line)); });
    const { chainInfo } = await loadWorker({
      SETTLEMENT_CHAINS_JSON: '{not json', OG_RPC_URL: 'https://og.example/rpc', OG_CHAIN_ID: '16661',
      AGENT_ESCROW_ADDRESS: OG_ESCROW,
    });
    expect(chainInfo('0g')).toMatchObject({ escrow: OG_ESCROW, chainId: 16661 });
    expect(errors.join('\n')).toMatch(/SETTLEMENT_CHAINS_JSON is not valid JSON/);
  });

  it('leaves a chain it was never given out of the table, so its tasks are refused for lack of a signer', async () => {
    const { chainInfo, signerFor, preflightGas } = await loadWorker({
      OG_RPC_URL: 'https://og.example/rpc', OG_CHAIN_ID: '16661', AGENT_ESCROW_ADDRESS: OG_ESCROW,
    });
    expect(chainInfo('base')).toBeNull();
    expect(signerFor('base')).toBeNull();
    expect(await preflightGas('base', null)).toMatch(/BASE_RPC_URL/);
  });
});

/**
 * Delegation posts a real escrow-funded sub-task, so it must use the chain
 * the backend posts on. It used to always sign on 0G and send native value,
 * which a Base-posting backend refuses outright (400 TOKEN_NOT_SETTLEMENT):
 * the agent burned an LLM turn and got nothing.
 */
describe('delegate_to_agent funds on the posting chain', () => {
  const delegateArgs = {
    taskDescription: 'Summarise the attached market report in five bullet points.',
    requiredCapabilities: ['summarization'],
  };

  /** Run the delegate tool far enough to see which chain and token it used. */
  async function delegate(env: Record<string, string>) {
    const worker = await loadWorker(env);
    const tools = worker.buildTools();
    return tools.delegate_to_agent.execute(delegateArgs) as Promise<string>;
  }

  it('reports the settlement token of a Base-posting stack, not native 0G', async () => {
    // The RPC does not exist, so the ERC-20 balance read fails — which is
    // itself the proof: on the old code this path read a NATIVE balance on 0G.
    const out = await delegate({ SETTLEMENT_CHAINS_JSON: JSON.stringify(TABLE) });
    expect(out).toMatch(/USDC/);
    expect(out).toMatch(/on base/);
    expect(out).not.toMatch(/0G/);
  });

  it('keeps the native path on a 0G-posting stack', async () => {
    const posting0g = TABLE.map((c) => ({ ...c, posting: c.key === '0g' }));
    const out = await delegate({ SETTLEMENT_CHAINS_JSON: JSON.stringify(posting0g) });
    // Same unreachable RPC, but the native branch reports a 0G balance.
    expect(out).toMatch(/0G/);
    expect(out).not.toMatch(/USDC/);
  });

  it('refuses when the posting chain has no signer', async () => {
    const out = await delegate({ SETTLEMENT_CHAINS_JSON: JSON.stringify(TABLE), AGENT_PRIVATE_KEY: '' });
    expect(out).toMatch(/cannot delegate/);
  });
});
