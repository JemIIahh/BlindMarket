import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  assertEgressUrl,
  createEgressFetch,
  egressFetch,
  EgressBlockedError,
  isBlockedAddress,
  readCappedText,
  ResponseTooLargeError,
} from './egressGuard.js';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254',
    '64:ff9b::7f00:1', '2002:7f00:1::1', 'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111'])('allows %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe('assertEgressUrl', () => {
  it.each([
    'file:///etc/passwd', 'gopher://example.com', 'ftp://example.com', 'not a url',
    'http://127.0.0.1/', 'http://[::1]:8080/', 'http://169.254.169.254/latest/meta-data/',
    'http://[::ffff:127.0.0.1]/', 'http://10.0.0.5:6379/',
  ])('refuses %s', (url) => {
    expect(() => assertEgressUrl(url)).toThrow(EgressBlockedError);
  });

  it('accepts a public name; names are checked at connect time', () => {
    expect(assertEgressUrl('https://api.example.com/v1?q=1').hostname).toBe('api.example.com');
  });
});

describe('egressFetch against a loopback server', () => {
  let server: Server;
  let port = 0;
  let hits = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits++;
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: `http://127.0.0.2:${port}/landed` }).end();
        return;
      }
      if (req.url === '/big') {
        res.writeHead(200); // no content-length: chunked
        res.end('x'.repeat(2 * 1024 * 1024));
        return;
      }
      if (req.url === '/declared') {
        res.writeHead(200, { 'Content-Length': String(3 * 1024 * 1024) });
        res.end('x'.repeat(3 * 1024 * 1024));
        return;
      }
      res.writeHead(200).end('loopback-only');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('refuses a literal loopback URL before sending anything', async () => {
    const before = hits;
    await expect(egressFetch(`http://127.0.0.1:${port}/`)).rejects.toBeInstanceOf(EgressBlockedError);
    expect(hits).toBe(before);
  });

  it('refuses a name that resolves to loopback, at connect time', async () => {
    const before = hits;
    await expect(egressFetch(`http://localhost:${port}/`)).rejects.toBeInstanceOf(EgressBlockedError);
    expect(hits).toBe(before);
  });

  // The rest use a filter that lets 127.0.0.1 through, standing in for a public
  // host, so the connect path and redirects can be exercised offline.
  const allowOnly127001 = createEgressFetch((address) => address !== '127.0.0.1');

  it('fetches an allowed address', async () => {
    const res = await allowOnly127001(`http://127.0.0.1:${port}/`);
    expect(await readCappedText(res, 1024)).toBe('loopback-only');
  });

  it('checks every redirect hop', async () => {
    await expect(allowOnly127001(`http://127.0.0.1:${port}/redirect`)).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it('stops reading a chunked body past the cap', async () => {
    const res = await allowOnly127001(`http://127.0.0.1:${port}/big`);
    await expect(readCappedText(res, 1024 * 1024)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('refuses a declared Content-Length over the cap without reading it', async () => {
    const res = await allowOnly127001(`http://127.0.0.1:${port}/declared`);
    await expect(readCappedText(res, 1024 * 1024)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });
});
