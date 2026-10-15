import { describe, it, expect, vi } from 'vitest';
import { pickVerifierService } from './verification.js';

/**
 * The platform verifier must call a chat service whose answers 0G can verify,
 * not whatever service the contract happens to list first (an image or
 * fine-tuning service, or one whose TEE signer was never acknowledged).
 */
const svc = (provider: string, serviceType: string, ack: boolean, model = 'm') =>
  ({ provider, serviceType, teeSignerAcknowledged: ack, model, inputPrice: 0n, outputPrice: 0n, url: `https://${provider}.example` });

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
});
