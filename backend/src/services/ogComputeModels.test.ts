import { describe, it, expect } from 'vitest';
import { matchOgService, ogChatServices, type OgServiceLike } from './ogComputeModels.js';

/**
 * A 0g-compute agent pays the provider that serves its model. The worker used
 * to take whichever provider the chain listed first (it served glm-5), so an
 * agent on deepseek-v4-flash funded and called the wrong provider. The backend
 * and the worker both pick through matchOgService, so these pin the rule.
 */

const OG = 10n ** 12n; // per-token prices in neuron, the size of mainnet's
const svc = (provider: string, model: string, extra: Partial<OgServiceLike> = {}): OgServiceLike => ({
  provider, model, serviceType: 'chatbot', inputPrice: 5n * OG, outputPrice: 20n * OG, teeSignerAcknowledged: true, ...extra,
});

const GLM5 = svc('0xd9966e13a6026Fcca4b13E7ff95c94DE268C471C', 'glm-5');
const QWEN = svc('0x1B3AAef3ae5050EEE04ea38cD4B087472BD85EB0', 'qwen3.7-plus');
const GLM53_CHEAP = svc('0x7DCFe6AEa70350C2090041524c9B4A9262DCe87D', 'glm-5.3', { inputPrice: 4n * OG, outputPrice: 14n * OG });
const GLM53_DEAR = svc('0x6446fE523D8f3678185ed53e3ADEffB4d27475cC', 'glm-5.3', { inputPrice: 7n * OG, outputPrice: 22n * OG });
const WHISPER = svc('0x36aCffCEa3CCe07cAdd1740Ad992dB16Ab324517', 'openai/whisper-large-v3', { serviceType: 'speech-to-text' });
const GPT_OSS_UNACKED = svc('0x44ba5021daDa2eDc84b4f5FC170b85F7bC51ef64', 'openai/gpt-oss-20b', { teeSignerAcknowledged: false });

const ALL = [GLM5, WHISPER, QWEN, GLM53_DEAR, GPT_OSS_UNACKED, GLM53_CHEAP];

describe('ogChatServices', () => {
  it('keeps chatbot services whose TEE signer 0G acknowledged', () => {
    expect(ogChatServices(ALL)).toEqual([GLM5, QWEN, GLM53_DEAR, GLM53_CHEAP]);
  });
});

describe('matchOgService', () => {
  it("picks the provider serving the agent's model, not the first one listed", () => {
    expect(matchOgService(ALL, 'qwen3.7-plus')).toBe(QWEN);
    expect(matchOgService(ALL, 'glm-5')).toBe(GLM5);
  });

  it('finds no provider for a model only the Router offers', () => {
    expect(matchOgService(ALL, 'deepseek-v4-flash')).toBeNull();
  });

  it('never picks a service that is not a chat service or not acknowledged', () => {
    expect(matchOgService(ALL, 'openai/whisper-large-v3')).toBeNull();
    expect(matchOgService(ALL, 'openai/gpt-oss-20b')).toBeNull();
  });

  it('matches ignoring case when no id matches exactly, and prefers an exact id', () => {
    expect(matchOgService(ALL, 'GLM-5')).toBe(GLM5);
    const upper = svc('0x0000000000000000000000000000000000000001', 'GLM-5');
    expect(matchOgService([upper, GLM5], 'glm-5')).toBe(GLM5);
    expect(matchOgService([GLM5, upper], 'GLM-5')).toBe(upper);
  });

  it('of several providers, takes the cheapest per token', () => {
    expect(matchOgService(ALL, 'glm-5.3')).toBe(GLM53_CHEAP);
  });

  it('prefers a provider the account already funds over a cheaper one', () => {
    expect(matchOgService(ALL, 'glm-5.3', [GLM53_DEAR.provider.toLowerCase()])).toBe(GLM53_DEAR);
    // Funding with a provider of another model changes nothing.
    expect(matchOgService(ALL, 'glm-5.3', [GLM5.provider])).toBe(GLM53_CHEAP);
  });

  it('breaks a price tie on the lower provider address, whatever the list order', () => {
    const a = svc('0x00000000000000000000000000000000000000aa', 'm');
    const b = svc('0x00000000000000000000000000000000000000BB', 'm');
    expect(matchOgService([a, b], 'm')).toBe(a);
    expect(matchOgService([b, a], 'm')).toBe(a);
  });
});
