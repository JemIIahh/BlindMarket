import { afterEach, describe, expect, it } from 'vitest';
import { clientErrorMessage, safeErrorMessage } from './errorHandler.js';

/** Error text returned to clients carries no infrastructure detail (audit run 1, C23). */

const ETHERS_ERROR = Object.assign(
  new Error('server response 401 Unauthorized (request={ }, response={ }, error=null, info={ "requestUrl": "https://rpc.example/v2/SECRET-KEY" }, code=SERVER_ERROR, version=6.13.1)'),
  { shortMessage: 'server response 401 Unauthorized', code: 'SERVER_ERROR' },
);

afterEach(() => { delete process.env.NODE_ENV; });

describe('safeErrorMessage', () => {
  it('keeps the short message and code, drops the request tail and masks URLs', () => {
    expect(safeErrorMessage(ETHERS_ERROR)).toBe('server response 401 Unauthorized [SERVER_ERROR]');
    expect(safeErrorMessage(new Error('fetch https://iris.example/v2/fees?key=abc failed'))).toBe('fetch <rpc> failed');
  });
});

describe('clientErrorMessage', () => {
  it('shows an ethers short message, never the RPC URL', () => {
    process.env.NODE_ENV = 'production';
    const text = clientErrorMessage(ETHERS_ERROR);
    expect(text).toBe('server response 401 Unauthorized [SERVER_ERROR]');
    expect(text).not.toContain('SECRET-KEY');
  });

  it('is generic in production for any other error', () => {
    process.env.NODE_ENV = 'production';
    expect(clientErrorMessage(new Error('connect ECONNREFUSED 10.0.0.5:5432'))).toBe('Internal server error');
    expect(clientErrorMessage(new Error('x'), 'Withdraw failed')).toBe('Withdraw failed');
  });

  it('keeps the sanitized text outside production', () => {
    process.env.NODE_ENV = 'development';
    expect(clientErrorMessage(new Error('connect ECONNREFUSED 10.0.0.5:5432'))).toBe('connect ECONNREFUSED 10.0.0.5:5432');
  });
});
