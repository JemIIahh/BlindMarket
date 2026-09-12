import { describe, it, expect } from 'vitest';
import pg from 'pg';
import { connectionOptions } from './db.js';

/**
 * TLS settings for the waitlist database. The bug these guard against:
 * node-postgres lets an `sslmode` in the URL override the `ssl` option, so
 * `?sslmode=require` silently turned "TLS without CA verification" into full
 * verification — and a host with a private CA never connected.
 */

// What node-postgres will actually use, after it merges the URL over the options.
// `connectionParameters` is its resolved (untyped, internal) config — the only
// place that merge can be observed without opening a connection.
const effectiveSsl = (url: string) =>
  (new pg.Client(connectionOptions(url)) as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl;

describe('connectionOptions', () => {
  it.each([
    ['no sslmode', 'postgres://u:p@db.example.com:5432/w', { rejectUnauthorized: false }],
    ['sslmode=require', 'postgres://u:p@db.example.com:5432/w?sslmode=require', { rejectUnauthorized: false }],
    ['sslmode=prefer', 'postgres://u:p@db.example.com:5432/w?sslmode=prefer', { rejectUnauthorized: false }],
    ['sslmode=no-verify', 'postgres://u:p@db.example.com:5432/w?sslmode=no-verify', { rejectUnauthorized: false }],
    ['sslmode=verify-full', 'postgres://u:p@db.example.com:5432/w?sslmode=verify-full', { rejectUnauthorized: true }],
    ['sslmode=verify-ca', 'postgres://u:p@db.example.com:5432/w?sslmode=verify-ca', { rejectUnauthorized: true }],
    ['sslmode=disable', 'postgres://u:p@localhost:5432/w?sslmode=disable', false],
  ])('%s → the TLS setting node-postgres really uses', (_label, url, expected) => {
    expect(connectionOptions(url).ssl).toEqual(expected);
    expect(effectiveSsl(url)).toEqual(expected);
  });

  it('keeps the rest of the URL — credentials, host, database, other parameters', () => {
    const { connectionString } = connectionOptions('postgresql://user:p%40ss@db.example.com:6543/wait?application_name=waitlist&sslmode=require');
    expect(connectionString).toBe('postgresql://user:p%40ss@db.example.com:6543/wait?application_name=waitlist');
  });
});
