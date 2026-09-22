import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { ethers } from 'ethers';

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

describe('preflightGas takes the paymaster path only when a UserOp can be sent', () => {
  const aaEnv = {
    SETTLEMENT_CHAINS_JSON: JSON.stringify(TABLE),
    AGENT_SMART_ACCOUNT_ADDRESS: '0x' + '5a'.repeat(20),
    AA_ENTRY_POINT: '0x' + 'e7'.repeat(20),
  };

  it('skips the gas check with account, entry point and bundler on an AA chain', async () => {
    const w = await loadWorker({ ...aaEnv, PIMLICO_BUNDLER_URL: 'https://bundler.example' });
    expect(await w.preflightGas('base', null)).toBeNull();
  });

  it('checks gas like any EOA when no bundler is configured', async () => {
    const w = await loadWorker({ ...aaEnv, PIMLICO_BUNDLER_URL: '' });
    expect(await w.preflightGas('base', null)).toMatch(/no base signer/);
  });

  it('checks gas on a chain whose escrow does not record smart accounts', async () => {
    const w = await loadWorker({ ...aaEnv, PIMLICO_BUNDLER_URL: 'https://bundler.example' });
    expect(await w.preflightGas('0g', null)).toMatch(/no 0g signer/);
  });
});

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

const ARC_ESCROW = '0xaBf70843E0380F1e749d2b85C30dD6820Ff5C731';
const ARC = {
  key: 'arc', chainId: 5042002, rpcUrl: 'https://arc.example/rpc', escrow: ARC_ESCROW,
  token: { address: '0x3600000000000000000000000000000000000000', kind: 'erc20', symbol: 'USDC', decimals: 6 },
  gasSymbol: 'USDC', nativeIsSettlementToken: true, aa: false, posting: true,
};

describe('Arc, the chain production posts on', () => {
  // What production's backend sends since #73: Base kept for legacy tasks,
  // Arc as the posting chain, no 0G.
  const prodTable = [{ ...TABLE[1], posting: false }, ARC];

  it('is declared at registration, so the backend offers Arc tasks to this agent', async () => {
    const { registrationBody } = await loadWorker({ SETTLEMENT_CHAINS_JSON: JSON.stringify(prodTable) });
    expect(registrationBody({ displayName: 'a', capabilities: [], publicKey: '04ab' }).supportedChains).toEqual(['0g', 'base', 'arc']);
  });

  it('gets a signer on the Arc RPC and the Arc escrow', async () => {
    const w = await loadWorker({ SETTLEMENT_CHAINS_JSON: JSON.stringify(prodTable) });
    expect(w.pickChain('arc')).toBe('arc');
    expect(rpcOf(w.signerFor('arc'))).toBe(ARC.rpcUrl);
    expect(w.escrowAddressFor('arc')).toBe(ARC_ESCROW);
    expect(w.postingChainInfo().key).toBe('arc');
  });

  it('is accepted when the wallet holds gas, and names USDC when it does not', async () => {
    const w = await loadWorker({ SETTLEMENT_CHAINS_JSON: JSON.stringify(prodTable) });
    expect(await w.acceptBlocker('arc', async () => null)).toBeNull();
    const empty = { address: '0x' + 'ab'.repeat(20), provider: { getBalance: async () => 0n } };
    expect(await w.preflightGas('arc', empty, false)).toMatch(/holds 0 USDC on arc/);
  });

  it('says the backend did not inject Arc when this deployment has no Arc entry', async () => {
    const w = await loadWorker({ SETTLEMENT_CHAINS_JSON: JSON.stringify(TABLE) });
    expect(w.signerFor('arc')).toBeNull();
    expect(await w.preflightGas('arc', null, false)).toMatch(/no arc signer — SETTLEMENT_CHAINS_JSON not injected \(backend has no Arc escrow configured\?\)/);
  });
});

describe('a chain this worker does not know', () => {
  const withUnknown = [...TABLE, { ...ARC, key: 'solana', chainId: 900 }];

  it('is never declared at registration, whatever the backend configures', async () => {
    const { registrationBody } = await loadWorker({ SETTLEMENT_CHAINS_JSON: JSON.stringify(withUnknown) });
    expect(registrationBody({ displayName: 'a', capabilities: [], publicKey: '04ab' }).supportedChains).toEqual(['0g', 'base', 'arc']);
  });

  it('is refused before accepting a task on it', async () => {
    const { pickChain, isUnsupportedChain, acceptBlocker } = await loadWorker({ SETTLEMENT_CHAINS_JSON: JSON.stringify(withUnknown) });
    expect(isUnsupportedChain('solana')).toBe(true);
    expect(() => pickChain('solana')).toThrow(/not supported by this worker/);
    expect(await acceptBlocker('solana', async () => null)).toMatchObject({ unsupported: true });
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
 * Delegation posts a real escrow-funded sub-task, so it must use the chain the
 * backend posts on. It used to always sign on 0G and send native value, which
 * a Base-posting backend refuses outright (400 TOKEN_NOT_SETTLEMENT): the
 * agent burned an LLM turn and got nothing.
 *
 * These drive the real path against a stub JSON-RPC node and a stubbed
 * backend, so they see which chain was dialled, which balance was read, and
 * what was broadcast — assertions on the returned message alone passed even
 * when the signer, the value and the approve target were all wrong.
 */
describe('delegate_to_agent funds on the posting chain', () => {
  const delegateArgs = {
    taskDescription: 'Summarise the attached market report in five bullet points.',
    requiredCapabilities: ['summarization'],
  };
  const AGENT_ADDRESS = new ethers.Wallet(KEY).address;
  const ERC20 = new ethers.Interface([
    'function balanceOf(address) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
  ]);

  /** A JSON-RPC node that records what was asked of it and what was broadcast. */
  function stubNode(chainId: number, balances: { native: bigint; token: bigint }) {
    const calls: string[] = [];
    const sent: Array<{ to: string; value: bigint; data: string }> = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const reqs = JSON.parse(body);
        const answer = (rpc: { id: number; method: string; params: unknown[] }) => {
          calls.push(rpc.method);
          switch (rpc.method) {
            case 'eth_chainId': return { id: rpc.id, jsonrpc: '2.0', result: '0x' + chainId.toString(16) };
            case 'eth_getBalance': return { id: rpc.id, jsonrpc: '2.0', result: '0x' + balances.native.toString(16) };
            case 'eth_call': return {
              id: rpc.id, jsonrpc: '2.0',
              result: ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [balances.token]),
            };
            case 'eth_getTransactionCount': return { id: rpc.id, jsonrpc: '2.0', result: '0x0' };
            case 'eth_estimateGas': return { id: rpc.id, jsonrpc: '2.0', result: '0x186a0' };
            case 'eth_gasPrice': return { id: rpc.id, jsonrpc: '2.0', result: '0x3b9aca00' };
            case 'eth_maxPriorityFeePerGas': return { id: rpc.id, jsonrpc: '2.0', result: '0x3b9aca00' };
            case 'eth_blockNumber': return { id: rpc.id, jsonrpc: '2.0', result: '0x1' };
            case 'eth_getBlockByNumber': return {
              id: rpc.id, jsonrpc: '2.0',
              result: { number: '0x1', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), timestamp: '0x1', baseFeePerGas: '0x3b9aca00', gasLimit: '0x1c9c380', gasUsed: '0x0', difficulty: '0x0', nonce: '0x0000000000000000', miner: ethers.ZeroAddress, extraData: '0x', transactions: [] },
            };
            case 'eth_sendRawTransaction': {
              const tx = ethers.Transaction.from(rpc.params[0] as string);
              sent.push({ to: tx.to ?? '', value: tx.value, data: tx.data });
              return { id: rpc.id, jsonrpc: '2.0', result: tx.hash };
            }
            case 'eth_getTransactionReceipt': return {
              id: rpc.id, jsonrpc: '2.0',
              result: { transactionHash: rpc.params[0], blockNumber: '0x1', blockHash: '0x' + '11'.repeat(32), status: '0x1', gasUsed: '0x5208', cumulativeGasUsed: '0x5208', logs: [], logsBloom: '0x' + '00'.repeat(256), type: '0x2', from: AGENT_ADDRESS, to: ethers.ZeroAddress, contractAddress: null, transactionIndex: '0x0', effectiveGasPrice: '0x3b9aca00' },
            };
            default: return { id: rpc.id, jsonrpc: '2.0', error: { code: -32601, message: `stub has no ${rpc.method}` } };
          }
        };
        const out = Array.isArray(reqs) ? reqs.map(answer) : answer(reqs);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      });
    });
    return { server, calls, sent };
  }

  /** The backend endpoints delegation calls, stopping at the index step. */
  function stubBackend(seen: { createTask?: Record<string, string> }, opts: { builtOn?: string } = {}) {
    return vi.fn(async (url: string, init?: { body?: string }) => {
      const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('/storage/upload')) return json({ rootHash: '0xroot' });
      if (url.includes('/a2a/executors')) return json({ executors: [] });
      if (url.endsWith('/api/v1/tasks')) {
        seen.createTask = JSON.parse(init?.body ?? '{}');
        return json({ unsignedTx: { to: BASE_ESCROW, data: '0xabcdef', value: '0x0' }, ...(opts.builtOn ? { chain: opts.builtOn } : {}) });
      }
      // Stop before the 2-minute result poll; the funding path is what matters.
      if (url.includes('/a2a/tasks/index')) return new Response('nope', { status: 500 });
      return new Response('{}', { status: 200 });
    });
  }

  async function delegateAgainstStub(
    table: typeof TABLE,
    balances: { native: bigint; token: bigint },
    opts: { builtOn?: string; env?: Record<string, string> } = {},
  ) {
    const posting = table.find((c) => c.posting)!;
    const node = stubNode(posting.chainId, balances);
    await new Promise<void>((resolve) => node.server.listen(0, '127.0.0.1', resolve));
    const { port } = node.server.address() as { port: number };
    const url = `http://127.0.0.1:${port}`;
    const seen: { createTask?: Record<string, string> } = {};
    const fetchStub = stubBackend(seen, { builtOn: opts.builtOn });
    vi.stubGlobal('fetch', fetchStub);
    try {
      const worker = await loadWorker({
        SETTLEMENT_CHAINS_JSON: JSON.stringify(table.map((c) => (c.posting ? { ...c, rpcUrl: url } : c))),
        BACKEND_URL: url,
        ...(opts.env ?? {}),
      });
      const out = (await worker.buildTools().delegate_to_agent.execute(delegateArgs)) as string;
      return { out, calls: node.calls, sent: node.sent, seen };
    } finally {
      vi.unstubAllGlobals();
      await new Promise<void>((resolve) => node.server.close(() => resolve()));
    }
  }

  it('reads the ERC-20 balance, approves the escrow, and funds in USDC on a Base-posting stack', async () => {
    const { out, calls, sent, seen } = await delegateAgainstStub(TABLE, { native: 10n ** 16n, token: 5_000_000n });

    // The token balance was read on the POSTING chain, not a native balance on 0G.
    expect(calls).toContain('eth_call');
    // createTask was asked for in the posting chain's token, in its decimals.
    expect(seen.createTask).toMatchObject({ token: USDC, amount: ethers.parseUnits('0.01', 6).toString() });
    // Two txs: approve(escrow, reward) to the token, then the funded createTask.
    expect(sent).toHaveLength(2);
    expect(sent[0].to.toLowerCase()).toBe(USDC.toLowerCase());
    const approve = ERC20.decodeFunctionData('approve', sent[0].data);
    expect(approve[0].toLowerCase()).toBe(BASE_ESCROW.toLowerCase());
    expect(approve[1]).toBe(ethers.parseUnits('0.01', 6));
    // The escrow pulls with transferFrom, so the createTask carries no value.
    expect(sent[1].to.toLowerCase()).toBe(BASE_ESCROW.toLowerCase());
    expect(sent[1].value).toBe(0n);
    // It got as far as indexing, which the stub refuses.
    expect(out).toMatch(/index 500/);
  });

  it('sends native value and no approve on a 0G-posting stack', async () => {
    const posting0g = TABLE.map((c) => ({ ...c, posting: c.key === '0g' }));
    const { calls, sent, seen } = await delegateAgainstStub(posting0g, { native: 10n ** 18n, token: 0n });

    expect(calls).toContain('eth_getBalance');
    expect(seen.createTask).toMatchObject({ token: NATIVE, amount: ethers.parseEther('0.0001').toString() });
    // Only the createTask: nothing to approve when the reward is the native coin.
    expect(sent).toHaveLength(1);
  });

  it('skips before spending anything when the ERC-20 balance is below the reward', async () => {
    const { out, sent } = await delegateAgainstStub(TABLE, { native: 10n ** 16n, token: 1n });
    expect(out).toMatch(/below the 0.01 USDC reward/);
    expect(sent).toEqual([]);
  });

  it('skips when the posting chain has no gas, before approving', async () => {
    const { out, sent } = await delegateAgainstStub(TABLE, { native: 0n, token: 5_000_000n });
    expect(out).toMatch(/holds 0 ETH on base/);
    expect(sent).toEqual([]);
  });

  // Arc's USDC is both the settlement token and the gas coin, so funding a
  // sub-task spends the balance that pays for this agent's own submitEvidence.
  // No such chain exists yet; this marks Base as one.
  describe('where the settlement token is also the gas coin', () => {
    const gasCoinTable = TABLE.map((c) => (c.key === 'base' ? { ...c, nativeIsSettlementToken: true } : c));
    const reward = ethers.parseUnits('0.01', 6);
    const reserve = ethers.parseUnits('0.005', 6);

    it('keeps the gas reserve back, refusing a balance that only covers the reward', async () => {
      const { out, sent } = await delegateAgainstStub(gasCoinTable, { native: 10n ** 16n, token: reward + reserve - 1n });
      expect(out).toMatch(/below the 0.01 USDC reward plus the 0.005 USDC gas reserve/);
      expect(sent).toEqual([]);
    });

    it('funds once the balance covers both', async () => {
      const { sent } = await delegateAgainstStub(gasCoinTable, { native: 10n ** 16n, token: reward + reserve });
      expect(sent).toHaveLength(2);
    });
  });

  it("refuses up front for a smart-account agent on a Base-posting stack (the EOA holds nothing)", async () => {
    const { out, calls, sent } = await delegateAgainstStub(TABLE, { native: 10n ** 16n, token: 5_000_000n }, {
      env: { AGENT_SMART_ACCOUNT_ADDRESS: '0x3333333333333333333333333333333333333333', AA_ENTRY_POINT: '0x0000000071727De22E5E9d8BAf0edAc6f37da032' },
    });
    expect(out).toMatch(/cannot delegate — this agent runs as a smart account on base/);
    // Nothing asked of the chain, nothing uploaded, nothing sent.
    expect(calls).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('still delegates from the EOA on a 0G-posting stack, smart account or not (0G has no account abstraction)', async () => {
    const ogPosting = TABLE.map((c) => ({ ...c, posting: c.key === '0g' }));
    const { out, sent } = await delegateAgainstStub(ogPosting, { native: 10n ** 18n, token: 0n }, {
      env: { AGENT_SMART_ACCOUNT_ADDRESS: '0x3333333333333333333333333333333333333333', AA_ENTRY_POINT: '0x0000000071727De22E5E9d8BAf0edAc6f37da032' },
    });
    expect(out).not.toMatch(/runs as a smart account/);
    expect(sent.length).toBeGreaterThan(0);
  });

  it('refuses to sign a task the backend built for another chain', async () => {
    const { out, sent } = await delegateAgainstStub(TABLE, { native: 10n ** 16n, token: 5_000_000n }, { builtOn: '0g' });
    expect(out).toMatch(/built the task on 0g, but this agent posts on base/);
    expect(sent).toEqual([]);
  });

  it('refuses when the posting chain has no signer', async () => {
    const worker = await loadWorker({ SETTLEMENT_CHAINS_JSON: JSON.stringify(TABLE), AGENT_PRIVATE_KEY: '' });
    const out = (await worker.buildTools().delegate_to_agent.execute(delegateArgs)) as string;
    expect(out).toMatch(/cannot delegate/);
  });
});

describe('pickSignerWallet — the legacy 0G-only paths always get a signer', () => {
  it('is the 0G signer when 0G is configured', async () => {
    const { pickSignerWallet } = await loadWorker({ SETTLEMENT_CHAINS_JSON: JSON.stringify(TABLE) });
    const bySigner = { '0g': { address: '0xog' }, base: { address: '0xbase' } };
    expect(pickSignerWallet(TABLE, bySigner)).toBe(bySigner['0g']);
  });

  // Base+Arc with no 0G escrow is where this plan is going. A null here would
  // let the agent accept a task on-chain and then refuse every submit until
  // the poster's claimTimeout.
  it('falls back to the posting chain when there is no 0G signer', async () => {
    const baseOnly = TABLE.filter((c) => c.key === 'base');
    const { pickSignerWallet } = await loadWorker({ SETTLEMENT_CHAINS_JSON: JSON.stringify(baseOnly) });
    const bySigner = { '0g': null, base: { address: '0xbase' } };
    expect(pickSignerWallet(baseOnly, bySigner)).toBe(bySigner.base);
  });

  // The wiring, not just the function: reverting the assignment to
  // `signers['0g'] ?? null` must fail something.
  it('is actually what the worker assigns, on a stack with no 0G escrow', async () => {
    const baseOnly = TABLE.filter((c) => c.key === 'base');
    const { _signerWallet, signerFor } = await loadWorker({ SETTLEMENT_CHAINS_JSON: JSON.stringify(baseOnly) });
    expect(_signerWallet()).not.toBeNull();
    expect(_signerWallet()).toBe(signerFor('base'));
  });

  it('is the 0G signer on a stack that has one', async () => {
    const { _signerWallet, signerFor } = await loadWorker({ SETTLEMENT_CHAINS_JSON: JSON.stringify(TABLE) });
    expect(_signerWallet()).toBe(signerFor('0g'));
  });

  it('falls back to any signer at all rather than none', async () => {
    const { pickSignerWallet } = await loadWorker({ SETTLEMENT_CHAINS_JSON: JSON.stringify(TABLE) });
    const bySigner = { '0g': null, base: null, other: { address: '0xother' } };
    expect(pickSignerWallet([], bySigner)).toBe(bySigner.other);
    expect(pickSignerWallet([], { '0g': null })).toBeNull();
  });
});
