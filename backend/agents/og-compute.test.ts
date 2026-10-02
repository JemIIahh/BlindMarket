import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * A 0g-compute agent pays for its model calls from its own 0G Compute
 * account. Until Oct 2026 the worker funded whichever provider the chain
 * listed first and sent every call to the 0G Compute Router, which wants its
 * own API key (401 invalid_auth), so no 0g-compute agent ever answered a model
 * call. A prod agent on deepseek-v4-flash sat "not taking tasks" for days,
 * its 2 0G parked with the glm-5 provider, never used. These drive the
 * worker's 0G Compute side (createOgCompute) against a mock broker.
 */

vi.mock('ai', () => ({ tool: (d: unknown) => d, generateText: vi.fn(), generateObject: vi.fn(), stepCountIs: (n: number) => n }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => () => 'm' }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: () => () => 'm' }));
vi.mock('@ai-sdk/groq', () => ({ createGroq: () => () => 'm' }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), emit: vi.fn() }) }));

const ORIGINAL = { ...process.env };
process.env = { ...ORIGINAL, AGENT_PRIVATE_KEY: '0x' + '11'.repeat(32), AGENT_ID: 'test-agent', SETTLEMENT_CHAINS_JSON: '' };
const {
  createOgCompute, ogProviderFundingPlan, ogRefundAction, ogDepositWei,
  OG_PROVIDER_TARGET_WEI, OG_REFUND_LOCK_MS,
// @ts-expect-error — plain-JS worker, no d.ts
} = await import('./worker.js');

afterEach(() => {
  process.env = { ...ORIGINAL };
});

const OG = 10n ** 18n;
const WALLET = '0xCD7e56fB4c1b3832e8462a33576B4dd034aEc25F';

type Svc = { provider: string; serviceType: string; model: string; url: string; inputPrice: bigint; outputPrice: bigint; teeSignerAcknowledged: boolean };
const svc = (provider: string, model: string, url: string, extra: Partial<Svc> = {}): Svc => ({
  provider, model, url, serviceType: 'chatbot', inputPrice: 10n ** 12n, outputPrice: 5n * 10n ** 12n, teeSignerAcknowledged: true, ...extra,
});
// Mainnet's InferenceServing on 2026-10-02, in its order: glm-5 is listed first.
const GLM5 = svc('0xd9966e13a6026Fcca4b13E7ff95c94DE268C471C', 'glm-5', 'https://compute-network-1.integratenetwork.work');
const WHISPER = svc('0x36aCffCEa3CCe07cAdd1740Ad992dB16Ab324517', 'openai/whisper-large-v3', 'https://compute-network-16.integratenetwork.work', { serviceType: 'speech-to-text' });
const QWEN = svc('0x1B3AAef3ae5050EEE04ea38cD4B087472BD85EB0', 'qwen3.7-plus', 'https://compute-network-4.integratenetwork.work');
const SERVICES = [GLM5, WHISPER, QWEN];

type Account = { balance: bigint; pendingRefund: bigint; acknowledged: boolean; refunds: Array<{ createdAt: bigint; processed: boolean }> };

/** A broker over a fake chain: an account (ledger) and sub-accounts per provider. */
function mockChain({ ledger = { availableBalance: 3n * OG, totalBalance: 3n * OG } as { availableBalance: bigint; totalBalance: bigint } | null, accounts = {} as Record<string, Partial<Account>>, walletWei = 0n } = {}) {
  const subs = new Map<string, Account>(
    Object.entries(accounts).map(([p, a]) => [p.toLowerCase(), { balance: 0n, pendingRefund: 0n, acknowledged: false, refunds: [], ...a }]),
  );
  const sub = (p: string) => subs.get(p.toLowerCase());
  const byProvider = (p: string) => SERVICES.find((s) => s.provider.toLowerCase() === p.toLowerCase())!;
  const broker = {
    inference: {
      listService: vi.fn(async (offset: number, limit: number) => SERVICES.slice(offset, offset + limit)),
      getServiceMetadata: vi.fn(async (p: string) => ({ endpoint: `${byProvider(p).url}/v1/proxy`, model: byProvider(p).model })),
      getAccount: vi.fn(async (p: string) => {
        const a = sub(p);
        if (!a) throw new Error('Sub-account not found. Initialize it by transferring funds via "transfer-fund"');
        return a;
      }),
      acknowledged: vi.fn(async (p: string) => sub(p)?.acknowledged === true),
      acknowledgeProviderSigner: vi.fn(async (p: string) => { sub(p)!.acknowledged = true; }),
      startAutoFunding: vi.fn(async () => {}),
      getRequestHeaders: vi.fn(async (p: string) => ({ Authorization: `Bearer app-sk-signed-for-${p}` })),
      processResponse: vi.fn(async () => true),
    },
    ledger: {
      getLedger: vi.fn(async () => {
        if (!ledger) throw new Error('LedgerNotExists');
        return ledger;
      }),
      addLedger: vi.fn(async () => {}),
      depositFund: vi.fn(async (amount: number) => { ledger!.availableBalance += BigInt(Math.round(amount * 1e6)) * 10n ** 12n; }),
      transferFund: vi.fn(async (p: string, _type: string, wei: bigint) => {
        ledger!.availableBalance -= wei;
        const a = sub(p) ?? { balance: 0n, pendingRefund: 0n, acknowledged: false, refunds: [] };
        a.balance += wei;
        subs.set(p.toLowerCase(), a);
      }),
      getProvidersWithBalance: vi.fn(async () => {
        if (!ledger) throw new Error('LedgerNotExists');
        return [...subs].filter(([, a]) => a.balance > 0n || a.pendingRefund > 0n).map(([p, a]) => [p, a.balance, a.pendingRefund]);
      }),
      retrieveFundFromProvider: vi.fn(async () => {}),
    },
  };
  const wallet = { address: WALLET, provider: { getBalance: vi.fn(async () => walletWei) } };
  return { broker, wallet, subs };
}

function og(model: string, chain: ReturnType<typeof mockChain>, fetchImpl = vi.fn(), now = () => 1_000_000) {
  const logs: string[] = [];
  const compute = createOgCompute({
    enabled: true, model, wallet: () => chain.wallet, loadBroker: async () => chain.broker,
    log: (m: string) => logs.push(m), fetchImpl, now, retryMs: 1000,
  });
  return { compute, logs, fetchImpl };
}

describe('setup: the provider is the one that serves the agent\'s model', () => {
  it("funds, acknowledges and auto-funds qwen's provider for a qwen agent, though glm-5 is listed first", async () => {
    const chain = mockChain();
    const { compute } = og('qwen3.7-plus', chain);
    await compute.ensure({ force: true });
    expect(compute.ready()).toBe(true);
    expect(compute.service()).toEqual({ provider: QWEN.provider, endpoint: `${QWEN.url}/v1/proxy`, model: 'qwen3.7-plus' });
    expect(chain.broker.ledger.transferFund).toHaveBeenCalledWith(QWEN.provider, 'inference', OG_PROVIDER_TARGET_WEI);
    expect(chain.broker.inference.acknowledgeProviderSigner).toHaveBeenCalledWith(QWEN.provider);
    expect(chain.broker.inference.startAutoFunding).toHaveBeenCalledWith(QWEN.provider);
    for (const fn of [chain.broker.ledger.transferFund, chain.broker.inference.acknowledgeProviderSigner, chain.broker.inference.startAutoFunding]) {
      expect(fn.mock.calls.every((c: unknown[]) => c[0] !== GLM5.provider)).toBe(true);
    }
  });

  it('names the model no provider serves, and funds nothing (the prod agent on deepseek-v4-flash)', async () => {
    const chain = mockChain({ ledger: { availableBalance: OG, totalBalance: 3n * OG }, accounts: { [GLM5.provider]: { balance: 2n * OG, acknowledged: true } } });
    const { compute } = og('deepseek-v4-flash', chain);
    await compute.ensure({ force: true });
    expect(compute.ready()).toBe(false);
    expect(compute.problem()).toContain('no 0G Compute provider serves the model deepseek-v4-flash');
    expect(chain.broker.ledger.transferFund).not.toHaveBeenCalled();
    expect(chain.broker.inference.acknowledgeProviderSigner).not.toHaveBeenCalled();
    expect(chain.broker.inference.startAutoFunding).not.toHaveBeenCalled();
  });

  it('the prod agent switched to glm-5 runs on the 2 0G already with that provider: no new 0G, no transfer', async () => {
    const chain = mockChain({ ledger: { availableBalance: OG, totalBalance: 3n * OG }, accounts: { [GLM5.provider]: { balance: 2n * OG, acknowledged: true } } });
    const { compute } = og('glm-5', chain);
    await compute.ensure({ force: true });
    expect(compute.ready()).toBe(true);
    expect(compute.service()?.provider).toBe(GLM5.provider);
    expect(chain.broker.ledger.transferFund).not.toHaveBeenCalled();
    expect(chain.broker.ledger.depositFund).not.toHaveBeenCalled();
    expect(chain.broker.inference.acknowledgeProviderSigner).not.toHaveBeenCalled();
    expect(chain.broker.inference.startAutoFunding).toHaveBeenCalledWith(GLM5.provider);
  });

  it('short of 0G for a new provider: says so, names the stranded balance, and asks for it back once', async () => {
    const chain = mockChain({ ledger: { availableBalance: OG, totalBalance: 3n * OG }, accounts: { [GLM5.provider]: { balance: 2n * OG, acknowledged: true } }, walletWei: 10n ** 17n });
    let t = 1_000_000;
    const { compute } = og('qwen3.7-plus', chain, vi.fn(), () => t);
    await compute.ensure({ force: true });
    expect(compute.ready()).toBe(false);
    expect(compute.problem()).toContain('paying the 0G Compute provider for qwen3.7-plus takes 2.0 0G');
    expect(compute.problem()).toContain('2.0 0G is with the provider for glm-5');
    expect(compute.problem()).toContain(WALLET);
    expect(chain.broker.ledger.transferFund).not.toHaveBeenCalled();
    expect(chain.broker.ledger.retrieveFundFromProvider).toHaveBeenCalledWith('inference', GLM5.provider.toLowerCase());
    // The next attempt a few minutes later sends no second refund.
    t += 5 * 60_000;
    await compute.ensure({ force: true });
    expect(chain.broker.ledger.retrieveFundFromProvider).toHaveBeenCalledTimes(1);
  });

  it('moves 0G the owner sent to the wallet into the account, then funds the provider', async () => {
    const chain = mockChain({ ledger: { availableBalance: OG, totalBalance: 3n * OG }, accounts: { [GLM5.provider]: { balance: 2n * OG, acknowledged: true } }, walletWei: 2n * OG });
    const { compute } = og('qwen3.7-plus', chain);
    await compute.ensure({ force: true });
    expect(chain.broker.ledger.depositFund).toHaveBeenCalledTimes(1);
    expect(chain.broker.ledger.depositFund.mock.calls[0][0]).toBeCloseTo(1.001, 6);
    expect(chain.broker.ledger.transferFund).toHaveBeenCalledWith(QWEN.provider, 'inference', 2n * OG);
    expect(compute.ready()).toBe(true);
    expect(chain.broker.ledger.retrieveFundFromProvider).not.toHaveBeenCalled();
  });
});

describe('calls go to the provider, signed for it', () => {
  async function readyQwen(fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'chatcmpl-1', usage: { prompt_tokens: 12, completion_tokens: 3 } }), { status: 200, headers: { 'ZG-Res-Key': 'chat-1' } }))) {
    const chain = mockChain();
    const o = og('qwen3.7-plus', chain, fetchImpl);
    await o.compute.ensure({ force: true });
    return { ...o, chain };
  }

  it("sends to the provider's endpoint with that provider's headers in place of the client's placeholder", async () => {
    const { compute, chain, fetchImpl } = await readyQwen();
    const url = `${QWEN.url}/v1/proxy/chat/completions`;
    await compute.fetch(url, { method: 'POST', headers: { authorization: 'Bearer 0g-compute', 'content-type': 'application/json' }, body: '{}' });
    expect(chain.broker.inference.getRequestHeaders).toHaveBeenCalledWith(QWEN.provider);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [sentUrl, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(sentUrl).toBe(url);
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe(`Bearer app-sk-signed-for-${QWEN.provider}`);
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('hands each answer\'s token usage to processResponse, for the fee auto-funding tracks', async () => {
    const { compute, chain } = await readyQwen();
    await compute.fetch(`${QWEN.url}/v1/proxy/chat/completions`, { method: 'POST', body: '{}' });
    expect(chain.broker.inference.processResponse).toHaveBeenCalledWith(QWEN.provider, undefined, JSON.stringify({ prompt_tokens: 12, completion_tokens: 3 }));
  });

  it('refuses to sign a request for any other host, the Router included', async () => {
    const { compute, chain, fetchImpl } = await readyQwen();
    await expect(compute.fetch('https://router-api.0g.ai/v1/chat/completions', { method: 'POST' })).rejects.toThrow(/another host/);
    await expect(compute.fetch(`${GLM5.url}/v1/proxy/chat/completions`, { method: 'POST' })).rejects.toThrow(/another host/);
    expect(chain.broker.inference.getRequestHeaders).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends nothing before the setup has finished', async () => {
    const chain = mockChain();
    const { compute, fetchImpl } = og('deepseek-v4-flash', chain);
    await compute.ensure({ force: true });
    await expect(compute.fetch(`${QWEN.url}/v1/proxy/chat/completions`, {})).rejects.toThrow(/not set up: no 0G Compute provider serves/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("attests the last chat at the provider's signature URL", async () => {
    const fetchImpl = vi.fn(async (url: string) => url.includes('/signature/')
      ? new Response(JSON.stringify({ signature: '0xsig', signing_address: '0xtee', text: 'signed' }), { status: 200 })
      : new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { 'ZG-Res-Key': 'chat-1' } }));
    const { compute, chain } = await readyQwen(fetchImpl);
    await compute.fetch(`${QWEN.url}/v1/proxy/chat/completions`, { method: 'POST', body: '{}' });
    const attestation = await compute.attest();
    expect(chain.broker.inference.processResponse).toHaveBeenLastCalledWith(QWEN.provider, 'chat-1');
    expect(fetchImpl.mock.calls[1][0]).toBe(`${QWEN.url}/v1/proxy/signature/chat-1?model=qwen3.7-plus`);
    expect(attestation).toEqual({ signature: '0xsig', signer: '0xtee', signedText: 'signed', chatID: 'chat-1', verified: true });
    expect(await compute.attest()).toBeNull();
  });
});

describe('the provider sub-account plan', () => {
  const acct = (balance: bigint, pendingRefund = 0n) => ({ balance, pendingRefund });

  it('leaves a sub-account at the SDK target alone', () => {
    expect(ogProviderFundingPlan(acct(2n * OG), 0n)).toEqual({ action: 'ready' });
  });

  it('opens a new one with the target from the ledger', () => {
    expect(ogProviderFundingPlan(null, 3n * OG)).toEqual({ action: 'transfer', transferWei: 2n * OG });
  });

  it('tops up at least 1 0G at a time (MIN_TRANSFER_AMOUNT)', () => {
    expect(ogProviderFundingPlan(acct(15n * 10n ** 17n), 5n * OG)).toEqual({ action: 'transfer', transferWei: OG });
  });

  it('takes what the ledger has when that clears the 1 0G floor', () => {
    expect(ogProviderFundingPlan(null, 15n * 10n ** 17n)).toEqual({ action: 'transfer', transferWei: 15n * 10n ** 17n });
  });

  it('runs on a sub-account above the floor when the ledger is empty', () => {
    expect(ogProviderFundingPlan(acct(15n * 10n ** 17n), 0n)).toEqual({ action: 'ready' });
  });

  it('is short when the provider would refuse: 1 0G locked is not enough to pay for a call', () => {
    expect(ogProviderFundingPlan(null, OG)).toEqual({ action: 'short', needWei: 2n * OG, shortfallWei: OG });
    expect(ogProviderFundingPlan(acct(OG), 0n)).toEqual({ action: 'short', needWei: OG, shortfallWei: OG });
  });

  it('does not count a balance already on its way back to the ledger', () => {
    expect(ogProviderFundingPlan(acct(2n * OG, 2n * OG), 0n).action).toBe('short');
  });

  it('deposits the shortfall rounded up, with room for the float amount', () => {
    expect(ogDepositWei(OG)).toBe(1001n * 10n ** 15n);
    expect(ogDepositWei(OG + 1n)).toBe(1002n * 10n ** 15n);
  });
});

describe('refunds from a provider the agent no longer uses', () => {
  const NOW = 1_800_000_000_000;
  it('requests one for a free balance', () => {
    expect(ogRefundAction({ balance: 2n * OG, pendingRefund: 0n, refunds: [] }, NOW, undefined)).toBe('request');
  });
  it('collects one whose 24-hour lock has passed, not before', () => {
    const created = BigInt(Math.floor((NOW - OG_REFUND_LOCK_MS) / 1000));
    expect(ogRefundAction({ balance: 2n * OG, pendingRefund: 2n * OG, refunds: [{ createdAt: created, processed: false }] }, NOW, undefined)).toBe('collect');
    expect(ogRefundAction({ balance: 2n * OG, pendingRefund: 2n * OG, refunds: [{ createdAt: created + 60n, processed: false }] }, NOW, undefined)).toBeNull();
    expect(ogRefundAction({ balance: 0n, pendingRefund: 0n, refunds: [{ createdAt: created, processed: true }] }, NOW, undefined)).toBeNull();
  });
  it('tries at most once an hour per provider', () => {
    expect(ogRefundAction({ balance: 2n * OG, pendingRefund: 0n, refunds: [] }, NOW, NOW - 30 * 60_000)).toBeNull();
    expect(ogRefundAction({ balance: 2n * OG, pendingRefund: 0n, refunds: [] }, NOW, NOW - 61 * 60_000)).toBe('request');
  });
});
