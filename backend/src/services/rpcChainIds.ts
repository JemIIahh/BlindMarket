/**
 * Whether each RPC the backend uses serves the chain it is configured for.
 *
 * Every provider is built with staticNetwork: ethers takes the configured
 * chain id on trust and never asks the node. An RPC for another network, such
 * as a testnet URL left in place when ARC_CHAIN_ID moved to mainnet, is then
 * read as this network's: the indexers scan the wrong chain, reads return
 * another chain's state, and every signed transaction carries a chain id the
 * node rejects. index.ts asks each RPC before the port is bound.
 *
 * Bridging is optional, so a CCTP leg on the wrong chain is only turned off.
 * Anything else on the wrong chain stops the backend. An RPC that gives no
 * answer does not: it is asked again every minute until it does.
 */
import * as Sentry from '@sentry/node';
import type { JsonRpcProvider } from 'ethers';
import { config } from '../config.js';
import { flushSentry } from '../middleware/errorHandler.js';
import { provider as ogProvider } from './chain.js';
import { chainRuntime } from './chainRuntime.js';
import { disableCctpLeg, isCctpConfigured, supportedCctpChains, type CctpChainKey } from './cctpChains.js';
import { configuredChainKeys, settlementChainConfig } from './settlementChains.js';

export interface RpcEndpoint {
  /** The endpoint in messages, with the setting that points at it: "Arc (ARC_RPC_URL)". */
  name: string;
  chainId: number;
  provider: Pick<JsonRpcProvider, 'send'>;
  /** Set on a CCTP leg: on the wrong chain it is turned off, and the backend runs on. */
  cctpLeg?: CctpChainKey;
}

export interface RpcChainIdReport {
  /** RPCs the backend cannot run without, serving another chain. */
  fatal: string[];
  /** CCTP legs serving another chain, now turned off. */
  disabled: string[];
  /** RPCs that gave no usable answer: unchecked, not wrong. */
  unanswered: Array<{ endpoint: RpcEndpoint; reason: string }>;
}

const TIMEOUT_MS = 10_000;
const RECHECK_MS = 60_000;

/** The chain id `provider` serves, or why it gave none in time. */
async function servedChainId(provider: RpcEndpoint['provider'], timeoutMs: number): Promise<{ chainId: number } | { reason: string }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const answer: unknown = await Promise.race([
      provider.send('eth_chainId', []),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer in ${timeoutMs / 1000}s`)), timeoutMs);
      }),
    ]);
    // JSON-RPC answers a hex quantity; some nodes answer a number.
    if (typeof answer === 'number' && Number.isSafeInteger(answer)) return { chainId: answer };
    if (typeof answer === 'string' && /^(0x[0-9a-f]+|[0-9]+)$/i.test(answer)) return { chainId: Number(BigInt(answer)) };
    return { reason: `answered eth_chainId with ${JSON.stringify(answer)}` };
  } catch (err) {
    return { reason: `did not answer eth_chainId (${(err as Error).message})` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks each provider once and checks the answer against every endpoint it
 * serves. A CCTP leg on another chain is turned off here.
 */
export async function checkRpcChainIds(endpoints: readonly RpcEndpoint[], timeoutMs = TIMEOUT_MS): Promise<RpcChainIdReport> {
  const report: RpcChainIdReport = { fatal: [], disabled: [], unanswered: [] };
  const byProvider = new Map<RpcEndpoint['provider'], RpcEndpoint[]>();
  for (const endpoint of endpoints) byProvider.set(endpoint.provider, [...(byProvider.get(endpoint.provider) ?? []), endpoint]);
  await Promise.all([...byProvider].map(async ([provider, served]) => {
    const answer = await servedChainId(provider, timeoutMs);
    for (const endpoint of served) {
      if ('reason' in answer) {
        report.unanswered.push({ endpoint, reason: `${endpoint.name} ${answer.reason}, so its chain is unchecked` });
      } else if (answer.chainId !== endpoint.chainId) {
        const wrong = `${endpoint.name} serves chain ${answer.chainId}, not ${endpoint.chainId}`;
        if (endpoint.cctpLeg) {
          disableCctpLeg(endpoint.cctpLeg);
          report.disabled.push(wrong);
        } else {
          report.fatal.push(wrong);
        }
      }
    }
  }));
  return report;
}

function reportDisabled(disabled: readonly string[], prefix: string): void {
  for (const line of disabled) {
    const message = `${line}: bridging on that leg is off until it is fixed`;
    console.error(`${prefix} ${message}`);
    Sentry.captureMessage(`rpc: ${message}`, 'error');
  }
}

/** A wrong chain found after boot: stop, as boot would have, rather than run on it. */
async function stopOnWrongChain(message: string): Promise<void> {
  console.error(`[rpc] ${message}. Stopping: this backend would read and sign on the wrong network.`);
  Sentry.captureMessage(`rpc: ${message}`, 'fatal');
  await flushSentry();
  process.exit(1);
}

/**
 * Asks `pending` again every `recheckMs` until each has answered. A wrong
 * chain found then is handled as at boot: a CCTP leg is turned off, and
 * anything else goes to onWrongChain, which stops the process.
 */
export function recheckRpcChainIds(
  pending: readonly RpcEndpoint[],
  opts: { recheckMs?: number; timeoutMs?: number; onWrongChain?: (message: string) => void | Promise<void> } = {},
): NodeJS.Timeout {
  let left = [...pending];
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void (async () => {
      try {
        const report = await checkRpcChainIds(left, opts.timeoutMs);
        reportDisabled(report.disabled, '[rpc]');
        left = report.unanswered.map(({ endpoint }) => endpoint);
        if (left.length === 0) clearInterval(timer);
        if (report.fatal.length > 0) {
          clearInterval(timer);
          await (opts.onWrongChain ?? stopOnWrongChain)(`RPC on the wrong network: ${report.fatal.join('; ')}`);
        }
      } catch (err) {
        console.error('[rpc] chain id re-check failed:', (err as Error).message);
      } finally {
        checking = false;
      }
    })();
  }, opts.recheckMs ?? RECHECK_MS);
  timer.unref();
  return timer;
}

/**
 * The boot check. Throws when an RPC the backend cannot run without serves
 * another chain; turns off a CCTP leg that does; and leaves RPCs that gave no
 * answer to recheckRpcChainIds.
 */
export async function assertRpcChainIds(
  endpoints: readonly RpcEndpoint[],
  opts: Parameters<typeof recheckRpcChainIds>[1] = {},
): Promise<void> {
  const report = await checkRpcChainIds(endpoints, opts.timeoutMs);
  reportDisabled(report.disabled, '[boot] rpc:');
  for (const { reason } of report.unanswered) console.warn(`[boot] rpc: ${reason}; asking again every minute`);
  if (report.fatal.length > 0) {
    for (const line of report.fatal) console.error(`[boot] rpc: ${line}`);
    throw new Error(
      `RPC on the wrong network: ${report.fatal.join('; ')}. Point each setting at its chain's RPC, or set the chain id you meant.`,
    );
  }
  if (report.unanswered.length > 0) recheckRpcChainIds(report.unanswered.map(({ endpoint }) => endpoint), opts);
}

/** Every RPC the backend reads or signs through: 0G, each chain it settles on, and CCTP's legs when bridging is on. */
export function bootRpcEndpoints(): RpcEndpoint[] {
  const endpoints: RpcEndpoint[] = [{ name: '0G (OG_RPC_URL)', chainId: config.ogChainId, provider: ogProvider }];
  for (const key of configuredChainKeys()) {
    const { label, rpcEnv, chainId } = settlementChainConfig(key);
    endpoints.push({ name: `${label} (${rpcEnv})`, chainId, provider: chainRuntime(key).provider });
  }
  if (isCctpConfigured()) {
    for (const leg of supportedCctpChains()) {
      const env = `CCTP_${leg.chainKey.split('-')[0].toUpperCase()}_RPC_URL`;
      endpoints.push({ name: `CCTP ${leg.label} (${env})`, chainId: leg.chainId, provider: leg.rpc, cctpLeg: leg.chainKey });
    }
  }
  return endpoints;
}
