/**
 * Outbound HTTP to user-chosen URLs: agent tools, MCP servers, OpenAPI specs and
 * webhooks. Without this guard a signed-in user could make the backend (or a
 * hosted worker on the same host) fetch loopback, private-network or cloud
 * metadata addresses and read the response, or stream an unbounded body into
 * the shared process (security audit run 1: C02, C06, C16).
 *
 * The check runs at connect time, inside an undici connector, so it also
 * applies to every redirect hop and to the address DNS actually returned (no
 * rebinding window between a check and the connect). Literal-IP URLs are also
 * refused up front so callers get a clear error before any request is built.
 *
 * Calls to our own backend (BACKEND_URL) and to fixed provider URLs must keep
 * using plain fetch: those destinations are ours, not the caller's.
 */
import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { Agent, buildConnector, fetch as undiciFetch, type RequestInit, type Response } from 'undici';

const BLOCKED = new BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including broadcast
] as const) BLOCKED.addSubnet(prefix, bits, 'ipv4');
for (const [prefix, bits] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64 (embeds an IPv4 address)
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard
  ['2001::', 32], // Teredo (embeds an IPv4 address)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds an IPv4 address)
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const) BLOCKED.addSubnet(prefix, bits, 'ipv6');
// IPv4-mapped IPv6 (::ffff:a.b.c.d) is checked against the IPv4 rules by BlockList.

export class EgressBlockedError extends Error {
  readonly code = 'EGRESS_BLOCKED';
  constructor(message: string) {
    super(message);
    this.name = 'EgressBlockedError';
  }
}

export class ResponseTooLargeError extends Error {
  readonly code = 'RESPONSE_TOO_LARGE';
  constructor(maxBytes: number) {
    super(`Response is larger than ${maxBytes} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

/** Largest body read from a tool or MCP server response. */
export const MAX_TOOL_RESPONSE_BYTES = 5 * 1024 * 1024;

export type AddressFilter = (address: string) => boolean;

/** True for any address outside the public internet. Anything that is not an IP
 *  literal is blocked too: callers pass resolved addresses. */
export const isBlockedAddress: AddressFilter = (address) => {
  const family = isIP(address);
  if (family === 4) return BLOCKED.check(address, 'ipv4');
  if (family === 6) return BLOCKED.check(address, 'ipv6');
  return true;
};

function bareHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/** Refuse anything but http(s), and literal-IP hosts in a blocked range. Names
 *  are resolved and checked at connect time. */
export function assertEgressUrl(raw: string, isBlocked: AddressFilter = isBlockedAddress): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EgressBlockedError('Destination is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EgressBlockedError(`Destination scheme ${url.protocol} is not allowed; use http or https`);
  }
  const host = bareHost(url.hostname);
  if (isIP(host) && isBlocked(host)) {
    throw new EgressBlockedError('Destination is a private, loopback or link-local address');
  }
  return url;
}

/** An undici dispatcher whose every connection, redirects included, goes to a
 *  public address. */
export function createEgressDispatcher(isBlocked: AddressFilter = isBlockedAddress): Agent {
  const connect = buildConnector({});
  return new Agent({
    connect(opts, callback) {
      const host = bareHost(opts.hostname);
      const resolve = isIP(host)
        ? Promise.resolve([host])
        : lookup(host, { all: true, verbatim: true }).then((records) => records.map((r) => r.address));
      resolve.then(
        (addresses) => {
          // Every record must be public, or a mixed answer could still land on
          // an internal address.
          if (addresses.length === 0 || addresses.some(isBlocked)) {
            callback(new EgressBlockedError('Destination resolves to a private, loopback or link-local address'), null);
            return;
          }
          // Connect to the vetted address. `host` keeps the original name, so
          // TLS SNI and certificate checks still use it.
          connect({ ...opts, hostname: addresses[0] }, callback);
        },
        (err: Error) => callback(err, null),
      );
    },
  });
}

/** fetch() for a user-chosen URL. */
export function createEgressFetch(isBlocked: AddressFilter = isBlockedAddress) {
  const dispatcher = createEgressDispatcher(isBlocked);
  return async function egressFetch(url: string, init: RequestInit = {}): Promise<Response> {
    assertEgressUrl(url, isBlocked);
    try {
      return await undiciFetch(url, { ...init, dispatcher });
    } catch (e) {
      // undici wraps connector errors as `TypeError: fetch failed` with a cause.
      const cause = (e as { cause?: unknown }).cause;
      if (cause instanceof EgressBlockedError) throw cause;
      throw e;
    }
  };
}

export const egressFetch = createEgressFetch();

/** Read a response body as text, refusing more than maxBytes. */
export async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new ResponseTooLargeError(maxBytes);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ResponseTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
