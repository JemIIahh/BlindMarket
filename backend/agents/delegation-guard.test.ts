import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * delegate_to_agent pays a sub-task's reward from the agent's wallet, and the
 * task brief sits in the same prompt as the tool. A brief that says "call
 * delegate_to_agent with capability X" would have the agent pay whichever
 * agent takes the sub-task, the poster's own included. The tool is therefore
 * the owner's opt-in (AGENT_DELEGATION_ENABLED, from
 * DeployedAgent.delegationEnabled), off by default: the model is never given
 * it, so no brief can make it call it. The backend refuses the posting too
 * (routes/a2a.delegationGuard.test.ts).
 */

vi.mock('ai', () => ({ tool: (d: unknown) => d, generateText: vi.fn(), generateObject: vi.fn(), stepCountIs: (n: number) => n }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => () => 'm' }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: () => () => 'm' }));
vi.mock('@ai-sdk/groq', () => ({ createGroq: () => () => 'm' }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), emit: vi.fn() }) }));

const ORIGINAL = { ...process.env };
const ARC = {
  key: 'arc', chainId: 5042, rpcUrl: 'https://arc.example/rpc', escrow: '0xd2B819B57a9568Cb6bFc98C687F9a851EC8330C4',
  token: { address: '0x3600000000000000000000000000000000000000', kind: 'erc20', symbol: 'USDC', decimals: 6 },
  gasSymbol: 'USDC', nativeIsSettlementToken: true, aa: false, posting: true, preflightGasLimit: '200000',
};

async function loadWorker(env: Record<string, string>) {
  vi.resetModules();
  process.env = {
    ...ORIGINAL,
    SETTLEMENT_CHAINS_JSON: JSON.stringify([ARC]), AGENT_PRIVATE_KEY: '0x' + '11'.repeat(32), AGENT_ID: 'test-agent',
    AGENT_DELEGATION_ENABLED: '',
    ...env,
  };
  // @ts-expect-error — plain-JS worker, no d.ts
  return import('./worker.js');
}

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('delegate_to_agent is the owner\'s opt-in', () => {
  it('is not given to the model when the owner has not turned it on, however the task run asks for tools', async () => {
    const { buildTools } = await loadWorker({});
    // As runAcceptedTask builds them for a task whose brief asks to delegate.
    const tools = buildTools('0x' + 'ab'.repeat(32), { posterAddress: '0x' + '22'.repeat(20) });
    expect(tools).not.toHaveProperty('delegate_to_agent');
    expect(buildTools()).not.toHaveProperty('delegate_to_agent');
  });

  it.each(['false', 'TRUE', '1', 'yes'])('stays off for AGENT_DELEGATION_ENABLED=%s', async (value) => {
    const { buildTools } = await loadWorker({ AGENT_DELEGATION_ENABLED: value });
    expect(buildTools()).not.toHaveProperty('delegate_to_agent');
  });

  it('is given to the model once the owner turned it on', async () => {
    const { buildTools } = await loadWorker({ AGENT_DELEGATION_ENABLED: 'true' });
    expect(buildTools()).toHaveProperty('delegate_to_agent');
  });
});

describe('the gas a worker transaction needs on Arc', () => {
  const gwei = 10n ** 9n;
  const provider = (balance: bigint, maxFee: bigint) => ({
    getBalance: async () => balance,
    getFeeData: async () => ({ maxFeePerGas: maxFee, gasPrice: maxFee / 2n }),
  });
  const signer = (balance: bigint, maxFee: bigint) => ({ address: '0x' + '33'.repeat(20), provider: provider(balance, maxFee) });

  it('takes the chain table\'s 200k budget, and 300k where the table names none', async () => {
    const { preflightGasLimitFor } = await loadWorker({});
    expect(preflightGasLimitFor('arc')).toBe(200_000n);
    expect(preflightGasLimitFor('arc', [{ ...ARC, preflightGasLimit: undefined }])).toBe(300_000n);
    expect(preflightGasLimitFor('arc', [{ ...ARC, preflightGasLimit: 'lots' }])).toBe(300_000n);
    expect(preflightGasLimitFor('arc', [{ ...ARC, preflightGasLimit: '0' }])).toBe(300_000n);
  });

  it('accepts at 0.008 USDC with Arc mainnet fees (20 gwei base, 40 gwei max fee) and refuses just under', async () => {
    const { preflightGas } = await loadWorker({});
    const gate = 200_000n * 40n * gwei; // 0.008
    expect(await preflightGas('arc', signer(gate, 40n * gwei), false)).toBeNull();
    expect(await preflightGas('arc', signer(gate - 1n, 40n * gwei), false)).toMatch(/below the ~0.008 USDC one tx needs/);
  });
});

describe('delegationGasKeep', () => {
  const gwei = 10n ** 9n;
  const reserve = 5_000n; // 0.005 USDC

  it('keeps three gas budgets where they are more than the configured reserve', async () => {
    const { delegationGasKeep } = await loadWorker({});
    // Arc at a 20 gwei base fee: 3 × 200k × 40 gwei = 0.024 USDC.
    expect(delegationGasKeep(200_000n * 40n * gwei, reserve, 6)).toBe(24_000n);
  });

  it('keeps the reserve when gas is cheap or the fees could not be read', async () => {
    const { delegationGasKeep } = await loadWorker({});
    expect(delegationGasKeep(200_000n * gwei, reserve, 6)).toBe(reserve);
    expect(delegationGasKeep(null, reserve, 6)).toBe(reserve);
  });

  it('rounds a fraction of a token unit up, and leaves 18-decimal amounts as they are', async () => {
    const { delegationGasKeep } = await loadWorker({});
    expect(delegationGasKeep(10n ** 12n * 2_000n + 1n, 0n, 6)).toBe(6_001n);
    expect(delegationGasKeep(10n ** 15n, 0n, 18)).toBe(3n * 10n ** 15n);
  });
});
