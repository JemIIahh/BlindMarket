import { describe, it, expect, vi } from 'vitest';
import { pickVerifierService } from './verification.js';

/**
 * The platform verifier must call a chat service whose answers 0G can verify,
 * not whatever service the contract happens to list first (an image or
 * fine-tuning service, or one whose TEE signer was never acknowledged).
 */
const svc = (provider: string, serviceType: string, ack: boolean, model = 'm', formats?: string[]) =>
  ({ provider, serviceType, teeSignerAcknowledged: ack, model, inputPrice: 0n, outputPrice: 0n, url: `https://${provider}.example`, ...(formats ? { formats } : {}) });

describe('pickVerifierService', () => {
  const listed = [
    svc('0xaaa', 'text-to-image', true),
    svc('0xbbb', 'chatbot', false),
    svc('0xccc', 'chatbot', true, 'glm-5'),
    svc('0xddd', 'chatbot', true, 'qwen'),
  ];

  it('takes the first acknowledged chatbot service, not the first service listed', () => {
    expect(pickVerifierService(listed, '')?.provider).toBe('0xccc');
  });

  it('takes the configured provider when it is registered, in any letter case', () => {
    expect(pickVerifierService(listed, '0xDDD')?.provider).toBe('0xddd');
  });

  it('falls back to a chat service when the configured one is not registered', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(pickVerifierService(listed, '0xeee')?.provider).toBe('0xccc');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('finds nothing when no chat service qualifies', () => {
    expect(pickVerifierService([svc('0xaaa', 'text-to-image', true), svc('0xbbb', 'chatbot', false)], '')).toBeNull();
  });

  it('skips a service that serves only the Anthropic format (claude-* on 0G mainnet)', () => {
    const svcs = [svc('0xa11', 'chatbot', true, 'claude-opus-5', ['anthropic']), svc('0xb22', 'chatbot', true, 'glm-5', ['openai'])];
    expect(pickVerifierService(svcs, '')?.provider).toBe('0xb22');
  });

  it('does not take a configured provider that serves only the Anthropic format', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const svcs = [svc('0xa11', 'chatbot', true, 'claude-opus-5', ['anthropic']), svc('0xb22', 'chatbot', true, 'glm-5', ['openai', 'anthropic'])];
    expect(pickVerifierService(svcs, '0xA11')?.provider).toBe('0xb22');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('finds nothing when every chat service serves only the Anthropic format', () => {
    expect(pickVerifierService([svc('0xa11', 'chatbot', true, 'm', ['anthropic'])], '')).toBeNull();
  });
});
