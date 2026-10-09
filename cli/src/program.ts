import { Command } from 'commander';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { JsonRpcProvider, Wallet, formatUnits, parseUnits } from 'ethers';
import ora from 'ora';
import { BlindMarket, ApiError } from '@blindmarket/sdk';
import type { AgentCapability, DeployAgentParams, DeployAgentsPlan, DeployAgentsResult, DeployFeeTerms, PostTasksRowResult } from '@blindmarket/sdk';
import {
  loadConfig, resolveConfig, saveConfig, DEFAULT_API_BASE,
  pendingFee, setPendingFee, pendingFeeNonce, pendingPosts, setPendingPost,
  bulkKey, bulkProgress, setBulkRow, fundedBulkRow, markListed, forgetFunding, type BulkRow,
  saveFundingRaw, fundingRaw, setBulkFile, bulkFile,
} from './config.js';
import { readTaskFile, toTaskRows, describeProblems, csvField, type TaskRow } from './rows.js';
import { fundingState, FUNDING_WORDS, type FundingState, type RawRpc } from './funding.js';
import { api } from './api.js';
import { client, signingClient, rpcEnvName, rpcUrlFor } from './client.js';
import { saveKeystore, signingKeySource, keystorePath, publicKeyHex } from './keys.js';
import { askHidden, confirm } from './prompt.js';
import { CliError } from './errors.js';

/**
 * The `blind` commands. Built by a function so tests drive the same program
 * the binary runs; every failure is thrown (a CliError, or the SDK's ApiError)
 * and index.ts prints it and exits 1.
 *
 * Identity: an sk_ API key (`blind login`) names the wallet the backend acts
 * as, and that wallet's own key signs every transaction locally. It is the
 * same model as the SDK and the MCP server.
 */

const PROVIDER_KEY_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  groq: 'GROQ_API_KEY',
  gemini: 'GEMINI_API_KEY',
  xai: 'XAI_API_KEY',
};
const PROVIDERS = ['openai', 'anthropic', 'groq', 'gemini', 'xai', '0g-compute'];
const STATUS = ['Funded', 'Assigned', 'Submitted', 'Verified', 'Completed', 'Cancelled', 'Disputed'];

function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string }).version;
  } catch {
    return '0.0.0-unknown';
  }
}

/** `--instructions` or `--instructions-file`, exactly one. */
function instructionsFrom(opts: { instructions?: string; instructionsFile?: string }): string {
  if (!!opts.instructions === !!opts.instructionsFile) {
    throw new CliError('INSTRUCTIONS_REQUIRED', 'Pass exactly one of --instructions <text> or --instructions-file <path>.');
  }
  const text = opts.instructions ?? readFileSync(opts.instructionsFile!, 'utf-8');
  if (!text.trim()) throw new CliError('INSTRUCTIONS_REQUIRED', 'The instructions are empty.');
  return text;
}

const list = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TASK_HASH = /^0x[0-9a-fA-F]{64}$/;

/** post-task's --open terms, or the refusal the escrow or the task board would give after funding. */
function openTerms(opts: { open?: boolean; verifier?: string; pick?: string; pickWindow?: string; target?: string; verification?: string; public?: boolean }):
  { verifier: string; pick: 'agent' | 'creator'; window?: number } | undefined {
  if (!opts.open) {
    if (opts.verifier || opts.pick || opts.pickWindow) throw new CliError('OPEN_REQUIRED', '--verifier, --pick and --pick-window are for a task many agents submit to: add --open, or drop them.');
    return undefined;
  }
  if (opts.target) throw new CliError('OPEN_TASK_PINNED', 'A task many agents submit to is offered to every agent: drop --target.');
  if (opts.verification) throw new CliError('BAD_VERIFICATION', 'A task many agents submit to is judged by its --verifier agent: drop --verification.');
  if (!opts.verifier || !ADDRESS.test(opts.verifier)) throw new CliError('VERIFIER_REQUIRED', '--open needs --verifier <0x address>: the verifier agent that judges the submissions and picks the winner.');
  const pick = opts.pick ?? 'verifier';
  if (pick !== 'verifier' && pick !== 'me') throw new CliError('BAD_PICK', '--pick must be verifier or me.');
  if (opts.pickWindow !== undefined && pick !== 'me') throw new CliError('BAD_PICK_WINDOW', '--pick-window is your window to pick first: add --pick me.');
  if (opts.pickWindow !== undefined && !/^\d+$/.test(opts.pickWindow)) throw new CliError('BAD_PICK_WINDOW', '--pick-window must be a whole number of seconds.');
  return { verifier: opts.verifier, pick: pick === 'me' ? 'creator' : 'agent', ...(opts.pickWindow !== undefined ? { window: Number(opts.pickWindow) } : {}) };
}

/** Tasks many agents submit to need SDK methods newer than the CLI's oldest supported SDK. */
function assertOpenSdk(bb: BlindMarket): void {
  if (typeof (bb as { getOpenTaskStatus?: unknown }).getOpenTaskStatus !== 'function') {
    throw new CliError('SDK_TOO_OLD', 'Tasks many agents submit to need a newer @blindmarket/sdk (with getOpenTaskStatus). Reinstall @blindmarket/cli, or update @blindmarket/sdk beside it.');
  }
}

/** An open task's phase in words. */
const OPEN_PHASE: Record<string, string> = {
  submissions: 'taking submissions',
  creator_pick: "in the poster's pick window",
  verifier_pick: "in the verifier's pick window",
  backup_pick: "in the backup judge's window",
  admin: 'waiting for an admin',
  closed: 'closed',
};
const when = (sec: number | null | undefined) => (sec ? new Date(sec * 1000).toISOString() : '-');
const out = (line = '') => console.log(line);

/** Run an async step behind a spinner; the spinner fails with the error, which is rethrown. */
async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const spin = ora({ text: label, stream: process.stderr }).start();
  try {
    const result = await fn();
    spin.stop();
    return result;
  } catch (e) {
    spin.fail(label);
    throw e;
  }
}

/** A task file row as the results CSV shows it. */
interface RowView {
  status: string;
  taskId?: string;
  taskHash?: string;
  txHash?: string;
  error?: string;
}

const PAID_NOT_LISTED = 'paid, not listed: run `blind finish-posts`';
const UNCONFIRMED = 'funded, unconfirmed: not paid again';
/** Funded this run and not listed yet: what the file says if the run is cut off there. */
const SENT = 'funded, not listed yet: run this again or `blind finish-posts`';

/**
 * The results CSV: every row of the file, in order, with what became of it.
 * Rewritten as each row settles, so it is current even if the run is cut off.
 */
function writeResultsCsv(path: string, tasks: TaskRow[], view: (t: TaskRow) => RowView, escrow: (t: TaskRow) => string): void {
  const lines = ['line,status,escrow,task_id,task_hash,tx_hash,error'];
  for (const t of tasks) {
    const c = view(t);
    lines.push([t.line, c.status, escrow(t), c.taskId, c.taskHash, c.txHash, c.error].map(csvField).join(','));
  }
  writeFileSync(path, `${lines.join('\n')}\n`);
}

/**
 * Rewrite a task file's results from what is saved, with what this command
 * just learnt about some of its rows (by fingerprint): how `finish-posts`
 * keeps a file's results current. Nothing is written when the file's results
 * path is not known or the file can no longer be read.
 */
function refreshResults(key: string, learnt: Map<string, RowView>): void {
  const meta = bulkFile(key);
  if (!meta) return;
  let tasks: TaskRow[];
  try {
    tasks = toTaskRows(meta.file, readTaskFile(meta.file).rows, { decimals: meta.decimals, symbol: meta.symbol }).tasks;
  } catch {
    return;
  }
  const saved = bulkProgress(key);
  writeResultsCsv(meta.resultsPath, tasks, (t) => {
    const known = learnt.get(t.fingerprint);
    if (known) return known;
    const row = saved[t.fingerprint];
    if (row?.status === 'posted') return { status: 'already posted', taskId: row.taskId, taskHash: row.taskHash, txHash: row.txHash };
    if (row?.status === 'funded') return { status: SENT, taskHash: row.taskHash, txHash: row.txHash };
    return { status: 'pending' };
  }, (t) => `${formatUnits(t.amountRaw, meta.decimals)} ${meta.symbol}`);
}

/** The SDK names rows by their place in the list it was given (rows[2]); a person reads the file's line (line 4). */
const rowsToLines = (text: string, lineOf: (index: number) => number | undefined) =>
  text.replace(/rows\[(\d+)\]/g, (_, i: string) => `line ${lineOf(Number(i)) ?? '?'}`);

/**
 * A read-only JSON-RPC client for `chain`, checked to serve `chainId`; null
 * when there is none, which leaves every funding 'unknown' (never freed).
 */
const readers = new Map<string, Promise<RawRpc | null>>();
function chainReader(chain: string, chainId: number): Promise<RawRpc | null> {
  const key = `${chain}|${chainId}`;
  if (!readers.has(key)) {
    readers.set(key, (async () => {
      const url = rpcUrlFor(chain, chainId);
      if (!url) return null;
      try {
        const provider = new JsonRpcProvider(url, chainId, { staticNetwork: true });
        return Number(BigInt(await provider.send('eth_chainId', []))) === chainId ? provider : null;
      } catch {
        return null;
      }
    })());
  }
  return readers.get(key)!;
}

/**
 * Whether the backend knows `taskHash` as a task on-chain: true when some
 * transaction funded it, false when it does not (404), undefined when it
 * could not say. A funding that looks dropped is freed only on false.
 */
async function knownOnChain(bb: BlindMarket, taskHash: string): Promise<boolean | undefined> {
  try {
    const t = await bb.getTask(taskHash) as unknown as { taskId?: unknown };
    return t?.taskId !== undefined && t.taskId !== null;
  } catch (e) {
    return e instanceof ApiError && e.status === 404 ? false : undefined;
  }
}

/**
 * What became of the funding of rows `post-tasks` saved as funded: from the
 * chain (funding.ts), once per funding transaction however many rows it
 * funds, and for one that looks dropped, from the backend too. A funding no
 * node has whose nonce is still unused is re-broadcast from its saved raw
 * transaction (it can only land once). With `apply`, a row whose funding
 * provably never landed is freed (forgetFunding): nothing was escrowed.
 */
async function checkFunding(bb: BlindMarket, rows: Array<{ taskHash: string; row: BulkRow }>, apply: boolean): Promise<Map<string, FundingState>> {
  const states = new Map<string, FundingState>();
  const byTx = new Map<string, Array<{ taskHash: string; row: BulkRow }>>();
  for (const r of rows) {
    if (!r.row.txHash) states.set(r.taskHash, 'unknown');
    else byTx.set(r.row.txHash.toLowerCase(), [...(byTx.get(r.row.txHash.toLowerCase()) ?? []), r]);
  }
  for (const [txHash, group] of byTx) {
    const { row } = group[0];
    const rpc = row.chain && row.chainId !== undefined ? await chainReader(row.chain, row.chainId) : null;
    let state: FundingState = rpc
      ? await fundingState(rpc, { txHash: row.txHash!, nonce: row.nonce, from: row.from, raw: apply ? fundingRaw(txHash) : undefined }, {
        onRebroadcast: () => out(`Re-sent funding ${txHash} (${group.length} row${group.length === 1 ? '' : 's'}): no node had it and its nonce was unused. It can only land once.`),
      })
      : 'unknown';
    // Its own transaction never landed, but another one may have funded the
    // same tasks (a wallet re-sent it): then they are never posted again.
    if (state === 'dropped') {
      for (const { taskHash } of group) {
        if ((await knownOnChain(bb, taskHash)) !== false) { state = 'unknown'; break; }
      }
    }
    for (const { taskHash } of group) {
      if (apply && (state === 'dropped' || state === 'reverted')) forgetFunding(taskHash);
      states.set(taskHash, state);
    }
  }
  return states;
}

/**
 * List tasks whose escrow is funded, paying nothing: one by one through
 * /a2a/tasks/index, and rows `post-tasks` funded in one transaction together
 * through /a2a/tasks/index-batch (the single route refuses their shared
 * receipt). A listed task's pending entry is cleared and a task file's row
 * for it marked posted. Returns each task's id, or why it is not listed.
 */
async function listFunded(bb: BlindMarket, entries: Array<[string, Record<string, unknown>]>): Promise<Map<string, { taskId?: string } | { error: string }>> {
  const outcome = new Map<string, { taskId?: string } | { error: string }>();
  const listed = (taskHash: string, id: unknown) => {
    const taskId = id === undefined || id === null ? undefined : String(id);
    markListed(taskHash, taskId);
    outcome.set(taskHash, taskId ? { taskId } : {});
  };
  const shared = new Map<string, Array<[string, Record<string, unknown>]>>();
  for (const [taskHash, params] of entries) {
    if (params.batch === true && typeof params.txHash === 'string') {
      shared.set(params.txHash, [...(shared.get(params.txHash) ?? []), [taskHash, params]]);
      continue;
    }
    try {
      const { batch: _batch, ...body } = params;
      const res = await step(`Listing ${taskHash}…`, () => bb.indexTask(body as never));
      listed(taskHash, res.onChainTaskId);
    } catch (e) {
      outcome.set(taskHash, { error: (e as Error).message });
    }
  }
  for (const [txHash, group] of shared) {
    if (typeof (bb as { indexTasks?: unknown }).indexTasks !== 'function') {
      throw new CliError('SDK_TOO_OLD', 'Listing tasks funded together needs @blindmarket/sdk 0.9 or later. Reinstall @blindmarket/cli, or run `npm i @blindmarket/sdk@^0.9.0` beside it.');
    }
    try {
      const res = await step(`Listing ${group.length} task(s) funded in ${txHash}…`, () => bb.indexTasks({
        txHash,
        tasks: group.map(([, params]) => {
          const { txHash: _tx, batch: _batch, ...task } = params;
          return task as never;
        }),
      }));
      const byHash = new Map((res.results ?? []).map((r) => [String(r.taskHash).toLowerCase(), r]));
      for (const [taskHash] of group) {
        const r = byHash.get(taskHash.toLowerCase());
        if (r && 'indexed' in r && r.indexed) listed(taskHash, r.onChainTaskId);
        else outcome.set(taskHash, { error: r && 'error' in r ? r.error.message : 'the backend did not say it listed it' });
      }
    } catch (e) {
      for (const [taskHash] of group) outcome.set(taskHash, { error: (e as Error).message });
    }
  }
  return outcome;
}

/**
 * Whether the deploy fee `hash`, saved by an earlier version without its
 * chain, is a successful transaction on `chain`: its receipt, read from the
 * chain's RPC once that RPC answers `chainId`. Throws, before anything is
 * paid, when that cannot be read.
 */
async function earlierFeeOn(hash: string, chain: string, chainId: number): Promise<boolean> {
  try {
    const url = rpcUrlFor(chain, chainId);
    if (!url) throw new Error(`no RPC is known for chain ${chainId}; set ${rpcEnvName(chain)}`);
    const provider = new JsonRpcProvider(url, chainId, { staticNetwork: true });
    const served = Number(BigInt(await provider.send('eth_chainId', [])));
    if (served !== chainId) throw new Error(`${rpcEnvName(chain)} serves chain ${served}`);
    return (await provider.getTransactionReceipt(hash))?.status === 1;
  } catch (e) {
    throw new CliError('FEE_UNCHECKED', `The deploy fee an earlier version saved (${hash}) could not be checked on ${chain} (chain ${chainId}): ${(e as Error).message}. Nothing was paid.`);
  }
}

/**
 * A deploy fee an earlier attempt paid that no deploy has used yet, for this
 * backend, wallet and fee chain. A payment is saved under the chain id it was
 * made on; one an earlier version saved without it pays only if it is on
 * that chain, and either way the unkeyed entry goes, so it is never offered
 * blindly again.
 */
async function savedDeployFee(apiBase: string, address: string, terms: DeployFeeTerms): Promise<string | undefined> {
  const feeChainId = terms.required ? terms.chainId : undefined;
  const saved = pendingFee(apiBase, address, feeChainId);
  const unkeyed = feeChainId !== undefined && !saved ? pendingFee(apiBase, address) : undefined;
  if (unkeyed && terms.required && feeChainId !== undefined) {
    const onChain = await step('Checking an earlier payment…', () => earlierFeeOn(unkeyed, terms.chain, feeChainId));
    setPendingFee(apiBase, address, undefined, null);
    if (onChain) {
      setPendingFee(apiBase, address, feeChainId, unkeyed);
      return unkeyed;
    }
    out(`The deploy fee an earlier version saved (${unkeyed}) is not on ${terms.chain} (chain ${feeChainId}), so it cannot pay for this deploy.`);
  }
  return saved;
}

/**
 * Whether the deploy fee `hash` the backend cannot find never paid: no node
 * has it and `from` has used the nonce it was sent with since, or it
 * reverted (funding.ts). A fee saved without a nonce, or one the fee chain's
 * RPC cannot tell, is not proof: null, and it stays saved.
 */
async function feeNeverPaid(hash: string, from: string, terms: DeployFeeTerms): Promise<string | null> {
  const nonce = pendingFeeNonce(hash);
  if (nonce === undefined || !terms.required || terms.chainId === undefined) return null;
  const rpc = await chainReader(terms.chain, terms.chainId);
  const state = rpc ? await fundingState(rpc, { txHash: hash, nonce, from }) : 'unknown';
  if (state === 'reverted') return `The deploy fee ${hash} reverted, so nothing was paid, and it is forgotten.`;
  if (state === 'dropped') return `The deploy fee ${hash} never landed: no node has it, and ${from} has used its nonce ${nonce} since. Nothing was paid, and it is forgotten.`;
  return null;
}

/** `--forget-fee`: drop the fee an earlier attempt saved for this backend, wallet and fee chain, so this deploy pays anew. */
function forgetSavedFee(apiBase: string, address: string, terms: DeployFeeTerms): void {
  const feeChainId = terms.required ? terms.chainId : undefined;
  const saved = [pendingFee(apiBase, address, feeChainId), feeChainId !== undefined ? pendingFee(apiBase, address) : undefined].filter(Boolean);
  setPendingFee(apiBase, address, feeChainId, null);
  if (feeChainId !== undefined) setPendingFee(apiBase, address, undefined, null);
  out(saved.length
    ? `Forgot the deploy fee saved by an earlier attempt (${saved.join(', ')}): this deploy pays a new one. If it lands after all, it pays for no deploy.`
    : 'No deploy fee was saved by an earlier attempt.');
}

/** What `deploy-agent` takes on the command line. */
interface DeployAgentOpts {
  name: string;
  instructions?: string;
  instructionsFile?: string;
  provider: string;
  model: string;
  skill?: string[];
  providerKeyEnv?: string;
  maxFee: string;
  count?: string;
  startAt: string;
  fund?: string;
  results?: string;
  forgetFee?: boolean;
  yes?: boolean;
}

/** `--provider`, checked, and its API key, read from the environment. */
function providerKey(opts: Pick<DeployAgentOpts, 'provider' | 'providerKeyEnv'>): { provider: DeployAgentParams['provider']; apiKey: string } {
  // Typed by the SDK; checked against PROVIDERS, which may name one an
  // older SDK's type lacks (the SDK passes the field through).
  const provider = opts.provider as DeployAgentParams['provider'];
  if (!PROVIDERS.includes(provider)) {
    throw new CliError('BAD_PROVIDER', `--provider must be one of ${PROVIDERS.join(', ')}; got ${opts.provider}.`);
  }
  // The provider key is read from the environment, never from argv: argv
  // lands in shell history and process lists.
  let apiKey = '';
  if (provider !== '0g-compute') {
    const envName = opts.providerKeyEnv ?? PROVIDER_KEY_ENV[provider];
    apiKey = process.env[envName] ?? '';
    if (!apiKey) throw new CliError('PROVIDER_KEY_MISSING', `Set ${envName}: the agent calls ${provider} with it.`);
  }
  return { provider, apiKey };
}

/** How long the SDK waits between asking the backend again for a fee it has not seen yet (BLINDMARKET_DEPLOY_POLL_MS); for tests. */
const deployPoll = () => (process.env.BLINDMARKET_DEPLOY_POLL_MS ? { pollIntervalMs: Number(process.env.BLINDMARKET_DEPLOY_POLL_MS) } : {});

/** Whether a failed deploy means its fee can never pay for one, so it is forgotten. */
const feeSpent = (err: ApiError) => ['DEPLOY_FEE_ALREADY_USED', 'DEPLOY_FEE_REVERTED'].includes(err.code ?? '')
  || (err.code === 'DEPLOY_FEE_NOT_PAID' && err.reason !== 'PAYER_NOT_LINKED');

/** The most agents one `deploy-agent --count` run deploys (the SDK's MAX_DEPLOY_AGENTS). */
const MAX_COUNT = 10;

/** One agent of a `deploy-agent --count` run, as the table and the results file show it. */
interface AgentRow {
  index: number;
  name: string;
  status: 'pending' | 'deployed' | 'not started' | 'failed' | 'skipped';
  agentId?: string;
  walletAddress?: string;
  feeTxHash?: string;
  funding?: { txHash?: string; amount?: string; error?: string };
  error?: string;
}

const short = (v?: string) => (v && v.length > 14 ? `${v.slice(0, 8)}…${v.slice(-4)}` : v ?? '');

/** The results table: one line per agent, columns padded to fit. */
function agentTable(rows: AgentRow[]): string {
  const cells = rows.map((r) => [
    String(r.index + 1), r.name, r.status, r.agentId ?? '', short(r.walletAddress), short(r.feeTxHash),
    r.funding ? (r.funding.error ? `failed: ${r.funding.error}` : `${r.funding.amount} (${short(r.funding.txHash)})`) : '',
    r.error ?? '',
  ]);
  const head = ['#', 'name', 'status', 'agent', 'wallet', 'fee tx', 'gas', 'error'];
  // Columns no agent has anything in are left out.
  const keep = head.map((_, c) => c).filter((c) => c < 3 || cells.some((row) => row[c]));
  const width = keep.map((c) => Math.max(head[c].length, ...cells.map((row) => row[c].length)));
  const line = (row: string[]) => keep.map((c, k) => row[c].padEnd(width[k])).join('  ').trimEnd();
  return [line(head), ...cells.map(line)].join('\n');
}

/** A whole number from `min` to `max`, or a CliError naming the flag. */
function wholeNumber(flag: string, raw: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || n < min || n > max) {
    throw new CliError('INVALID_COUNT', `${flag} must be a whole number from ${min}${max < Number.MAX_SAFE_INTEGER ? ` to ${max}` : ''}; got ${raw}.`);
  }
  return n;
}

/** Whether BlindMarket pays hosted agents' gas on this backend now (/health/bridge gasSponsor). False when it cannot say. */
async function gasSponsored(): Promise<boolean> {
  try {
    const bridge = await api.get<{ gasSponsor?: { enabled?: boolean; paused?: boolean; killed?: boolean } }>('/health/bridge');
    const g = bridge?.gasSponsor;
    return g?.enabled === true && g.paused !== true && g.killed !== true;
  } catch {
    return false;
  }
}

/**
 * `deploy-agent --count n`: n agents from one set of flags, through the SDK's
 * deployAgents(). Its checks run before anything is paid (the request once,
 * the room to start them all, the fee and the wallet's balance); this shows
 * the plan and asks once, then deploys one after another, printing each, and
 * ends with a table (and --results, rewritten as each agent settles). A run
 * that stops keeps what it deployed; a fee paid for an agent that did not
 * deploy is saved like a single deploy's, and the next run's first agent
 * uses it.
 */
async function deployMany(opts: DeployAgentOpts): Promise<void> {
  const count = wholeNumber('--count', opts.count!, 1, MAX_COUNT);
  const startAt = wholeNumber('--start-at', opts.startAt, 1);
  const { provider, apiKey } = providerKey(opts);
  const maxFeeRaw = parseUnits(opts.maxFee, 6);
  const instructions = instructionsFrom(opts);
  const { cfg, bb, signer, postingChain, chains } = await signingClient();
  if (typeof (bb as { deployAgents?: unknown }).deployAgents !== 'function') {
    throw new CliError('SDK_TOO_OLD', 'deploy-agent --count needs @blindmarket/sdk 0.10 or later. Reinstall @blindmarket/cli, or run `npm i @blindmarket/sdk@^0.10.0` beside it.');
  }
  let fund: { amountRaw: bigint } | undefined;
  if (opts.fund !== undefined) {
    const decimals = chains.find((c) => c.chain === postingChain)?.token.decimals ?? 6;
    try {
      fund = { amountRaw: parseUnits(opts.fund, decimals) };
    } catch {
      throw new CliError('INVALID_AMOUNT', `--fund ${opts.fund} is not a USDC amount with at most ${decimals} decimals.`);
    }
  }
  const sponsored = fund ? await gasSponsored() : false;
  const terms = await bb.getDeployFee();
  const feeChainId = terms.required ? terms.chainId : undefined;
  if (opts.forgetFee) forgetSavedFee(cfg.apiBase, signer.address, terms);
  const saved = await savedDeployFee(cfg.apiBase, signer.address, terms);
  const setFee = (hash: string | null, nonce?: number) => setPendingFee(cfg.apiBase, signer.address, feeChainId, hash, nonce);

  let rows: AgentRow[] = [];
  const writeResults = (result?: DeployAgentsResult) => {
    if (!opts.results) return;
    const body = {
      requested: result?.requested ?? rows.length,
      deployed: rows.filter((r) => r.status === 'deployed' || r.status === 'not started').length,
      ...(result?.stopped ? { stopped: result.stopped } : {}),
      agents: rows,
    };
    writeFileSync(opts.results, `${JSON.stringify(body, null, 2)}\n`);
  };

  const describe = (plan: DeployAgentsPlan): void => {
    const names = plan.names.length > 3 ? `${plan.names[0]}, ${plan.names[1]} … ${plan.names[plan.names.length - 1]}` : plan.names.join(', ');
    out(`Deploy ${plan.count} agent${plan.count === 1 ? '' : 's'}: ${names}`);
    out(`  model:    ${provider} ${opts.model}`);
    if (plan.capacity) out(`  room:     ${freeSlots(plan.capacity)} can start now on this server (${roomText(plan.capacity)})`);
    if (plan.fee?.method === 'transfer') {
      const each = formatUnits(BigInt(plan.fee.perAgentRaw), plan.fee.decimals).replace(/\.0$/, '');
      const total = formatUnits(BigInt(plan.fee.totalRaw), plan.fee.decimals).replace(/\.0$/, '');
      out(`  fee:      ${each} USDC each on ${plan.fee.chain}, ${total} USDC for ${plan.fee.paying} to ${plan.fee.recipient}${saved ? ` (the first uses ${saved}, already paid)` : ''}`);
    } else if (plan.fee) {
      out(`  fee:      one AgentFactory payment on ${plan.fee.chain} per agent (${plan.fee.paying})`);
    } else {
      out('  fee:      none');
    }
    if (plan.funding) {
      const each = formatUnits(BigInt(plan.funding.perAgentRaw), plan.funding.decimals);
      const total = formatUnits(BigInt(plan.funding.totalRaw), plan.funding.decimals);
      out(`  gas:      ${each} ${plan.funding.symbol} to each agent's wallet on ${plan.funding.chain} once it runs, ${total} ${plan.funding.symbol} in all`);
    }
    out(`  from:     ${signer.address}`);
    if (sponsored) out('  note:     BlindMarket pays gas for agents deployed from the web app while signed in. One deployed with an API key qualifies after you open it there signed in; until then its wallet pays its own gas.');
    if (provider === '0g-compute') {
      out(`  note:     each 0g-compute agent pays for its own inference: send each wallet about 3.1 0G on the 0G chain (3 0G opens its 0G Compute account) before it takes a task.`);
    } else if (plan.count > 1) {
      out(`  note:     all ${plan.count} agents call ${provider} with your one API key, so they share its rate limits and its bill.`);
    }
  };

  const result = await bb.deployAgents(
    {
      name: opts.name,
      instructions,
      provider,
      model: opts.model,
      apiKey,
      skillSlugs: opts.skill ?? [],
      // Each agent's wallet key is encrypted to yours.
      ownerPublicKey: publicKeyHex(signer),
      ...(saved ? { feeTxHash: saved } : {}),
    },
    {
      count,
      startAt,
      // Fewer than asked only with a yes from a person at a terminal (confirm below).
      upToCapacity: true,
      payFee: true,
      maxFeeRaw,
      ...deployPoll(),
      ...(fund ? { fund } : {}),
      // How long the first wait after a 429 is (it doubles from there); for tests.
      ...(process.env.BLINDMARKET_DEPLOY_BACKOFF_MS ? { retry: { baseDelayMs: Number(process.env.BLINDMARKET_DEPLOY_BACKOFF_MS) } } : {}),
      confirm: async (plan) => {
        if (plan.count < plan.asked) {
          const why = `Only ${plan.count} of the ${plan.asked} agents can start now (${plan.capacity ? roomText(plan.capacity) : 'the server said so'}).`;
          if (opts.yes || !process.stdin.isTTY) throw new CliError('AGENT_CAPACITY', `${why} Nothing was deployed or paid. Run again with --count ${plan.count}.`);
          out(why);
        }
        describe(plan);
        rows = plan.names.map((name, index) => ({ index, name, status: 'pending' }));
        writeResults();
        await confirm(plan.count < plan.asked ? `Deploy these ${plan.count}?` : `Deploy ${plan.count === 1 ? 'it' : `all ${plan.count}`}?`, opts.yes);
        return true;
      },
      onFeePaid: (hash, _index, nonce) => setFee(hash, nonce),
      onProgress: (e) => {
        const at = `[${e.index + 1}/${rows.length}] ${e.name}`;
        const row = rows[e.index];
        switch (e.type) {
          case 'deploying': process.stderr.write(`${at}: deploying…\n`); break;
          case 'rate-limited': process.stderr.write(`${at}: the backend is busy (429), asking again in ${Math.round(e.waitMs / 1000)} s\n`); break;
          case 'deployed':
            // The fee in the saved slot, if any, has paid for this agent.
            setFee(null);
            Object.assign(row, {
              status: e.agent.started === false ? 'not started' : 'deployed',
              agentId: e.agent.id,
              walletAddress: e.agent.walletAddress,
              ...(e.agent.feeTxHash ? { feeTxHash: e.agent.feeTxHash } : {}),
            });
            process.stderr.write(`${at}: deployed ${e.agent.id} (wallet ${e.agent.walletAddress})${e.agent.started === false ? ', but it did not start' : ''}\n`);
            writeResults();
            break;
          case 'funding': process.stderr.write(`${at}: sending gas to ${e.walletAddress}…\n`); break;
          case 'funded':
            row.funding = { txHash: e.txHash, amount: opts.fund };
            process.stderr.write(`${at}: funded (${e.txHash})\n`);
            writeResults();
            break;
          case 'failed':
            // A fee it paid and could still use stays saved; one the backend calls spent goes.
            setFee(e.feeTxHash ?? null);
            Object.assign(row, { status: 'failed', error: `${e.error.code ? `${e.error.code}: ` : ''}${e.error.message}`, ...(e.feeTxHash ? { feeTxHash: e.feeTxHash } : {}) });
            process.stderr.write(`${at}: failed: ${row.error}\n`);
            writeResults();
            break;
        }
      },
    },
  );

  for (const r of result.results) {
    const row = rows[r.index];
    if (r.status === 'skipped') row.status = 'skipped';
    if (r.status === 'deployed' && r.funding && 'error' in r.funding) {
      row.funding = { ...(r.funding.txHash ? { txHash: r.funding.txHash } : {}), error: r.funding.error.message };
    }
  }
  writeResults(result);
  out('');
  out(agentTable(rows));
  if (opts.results) out(`\nResults: ${resolve(opts.results)}`);
  if (result.stopped) {
    const done = result.results.filter((r) => r.status === 'deployed').length;
    const unspent = result.results.find((r) => r.status === 'failed' && r.feeTxHash);
    // A fee the backend never found, that never paid: forgotten, not carried to the next run.
    const neverPaid = unspent?.status === 'failed' && unspent.error.code === 'DEPLOY_FEE_NOT_FOUND'
      ? await feeNeverPaid(unspent.feeTxHash!, signer.address, terms)
      : null;
    if (neverPaid) setFee(null);
    const left = result.requested - done;
    throw new CliError(
      'NOT_ALL_DEPLOYED',
      `Deployed ${done} of ${result.requested}; stopped at ${result.results[result.stopped.index].name}: ${result.stopped.message}` +
        (neverPaid ? ` ${neverPaid} The next run pays a new one.`
          : unspent && unspent.status === 'failed' ? ` Its fee (${unspent.feeTxHash}) is saved, and the next run's first agent uses it.` : '') +
        (left > 0 ? ` Once that is fixed, deploy the rest with --count ${left} --start-at ${startAt + done}.` : ''),
    );
  }
}

/** Agents that can start now, from the backend's capacity. */
const freeSlots = (c: { poolFree: number; ownerFree: number; memory?: { slotsFree: number } | null }) =>
  Math.max(0, Math.min(c.poolFree, c.ownerFree, c.memory?.slotsFree ?? Number.POSITIVE_INFINITY));

/** What limits the room: the server's free slots, the owner's share, and what its memory allows when it says. */
const roomText = (c: { poolFree: number; ownerFree: number; ownerMax: number; memory?: { slotsFree: number } | null }) =>
  `${c.poolFree} free slots on the server, ${c.ownerFree} left of your ${c.ownerMax}${c.memory ? `, memory for ${c.memory.slotsFree} more` : ''}`;

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('blind')
    .description('BlindMarket CLI: post tasks, deploy agents and settle escrow from the command line')
    .version(packageVersion());

  // ── login / whoami ────────────────────────────────────────────────────────

  program
    .command('login')
    .description('Sign in with an sk_ API key (web app → Settings → API keys)')
    .option('--api-key <key>', 'The sk_ key (default: BLINDMARKET_API_KEY, else asked for without echo)')
    .option('--api-base <url>', 'Backend URL', undefined)
    .option('--import-key', "Also store the key of the wallet that owns the API key, encrypted (from BLINDMARKET_PRIVATE_KEY, else asked for)")
    .action(async (opts: { apiKey?: string; apiBase?: string; importKey?: boolean }) => {
      const saved = loadConfig();
      const apiBase = opts.apiBase ?? process.env.BLINDMARKET_API_BASE ?? saved.apiBase ?? DEFAULT_API_BASE;
      const apiKey = opts.apiKey ?? process.env.BLINDMARKET_API_KEY ?? await askHidden('API key (sk_…): ');
      const who = await step('Checking the API key…', () => new BlindMarket({ apiKey, apiBase }).whoami());
      if (!/^0x[0-9a-fA-F]{40}$/.test(who.address ?? '')) {
        throw new CliError('NOT_A_WALLET_KEY', `That key authenticates as "${who.address}", not a wallet. Mint an sk_ key in the web app while signed in.`);
      }
      if (opts.importKey) {
        const raw = process.env.BLINDMARKET_PRIVATE_KEY ?? await askHidden(`Private key of ${who.address}: `);
        let wallet: Wallet;
        try {
          wallet = new Wallet(raw.startsWith('0x') ? raw : `0x${raw}`);
        } catch {
          throw new CliError('BAD_PRIVATE_KEY', 'That is not a private key (64 hex characters). Nothing was saved.');
        }
        if (wallet.address.toLowerCase() !== who.address.toLowerCase()) {
          throw new CliError(
            'OWNER_MISMATCH',
            `That key is ${wallet.address}, but the API key belongs to ${who.address}. Tasks and fees count only from the API key's wallet. Nothing was saved.`,
          );
        }
        await step('Encrypting the key…', () => saveKeystore(wallet.privateKey));
      }
      saveConfig({ apiKey, apiBase, address: who.address });
      out(`Signed in as ${who.address} on ${apiBase}.`);
      const source = signingKeySource();
      out(source === 'keystore' ? `Signing key: ${keystorePath()} (encrypted).`
        : source === 'env' ? 'Signing key: BLINDMARKET_PRIVATE_KEY.'
          : 'No signing key yet: set BLINDMARKET_PRIVATE_KEY, or run `blind login --import-key`, before posting or deploying.');
    });

  program
    .command('whoami')
    .description('Show the wallet this CLI acts as, and where its signing key comes from')
    .action(async () => {
      const { cfg, bb } = client();
      const who = await bb.whoami();
      out(`wallet:      ${who.address}`);
      out(`backend:     ${cfg.apiBase}`);
      const source = signingKeySource();
      out(`signing key: ${source === 'env' ? 'BLINDMARKET_PRIVATE_KEY' : source === 'keystore' ? keystorePath() : 'none'}`);
    });

  // ── register (device flow, where the backend allows it) ──────────────────

  program
    .command('register')
    .description('Register a new agent wallet through the browser (use `blind login` with an sk_ key where registration is off)')
    .requiredOption('--name <name>', 'Agent name')
    .option('--api-base <url>', 'Backend URL')
    .action(async (opts: { name: string; apiBase?: string }) => {
      const saved = loadConfig();
      const apiBase = opts.apiBase ?? process.env.BLINDMARKET_API_BASE ?? saved.apiBase ?? DEFAULT_API_BASE;
      // The token this flow gets acts as the generated wallet, so that wallet
      // must be kept: 0.3 discarded it, and nothing could ever sign for it.
      // It is saved (encrypted) before the browser step, so a token can never
      // exist without its key.
      const wallet = Wallet.createRandom();
      const agentPublicKey = wallet.signingKey.publicKey;
      const agentSignature = await wallet.signMessage(agentRegistrationMessage(opts.name, wallet.address, agentPublicKey));
      let session: { token: string; url: string };
      try {
        session = await step('Creating registration session…', () =>
          api.post<{ token: string; url: string }>('/api/v1/registration/session', { agentName: opts.name, agentWallet: wallet.address, agentPublicKey, agentSignature }, '', apiBase));
      } catch (e) {
        if ((e as CliError).code === 'REGISTRATION_DISABLED') {
          throw new CliError(
            'REGISTRATION_DISABLED',
            'This backend has browser registration turned off. Mint an sk_ API key in the web app (Settings → API keys), then run `blind login --import-key`.',
          );
        }
        throw e;
      }
      await saveKeystore(wallet.privateKey);
      saveConfig({ ...saved, apiBase, agentWallet: wallet.address, agentName: opts.name, address: wallet.address });
      out('\nOpen this URL in your browser and sign with your wallet:\n');
      out(`  ${session.url}\n`);
      let apiKey: string | undefined;
      await step('Waiting for your signature…', async () => {
        for (let i = 0; i < 120 && !apiKey; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          const s = await api.get<{ status: string; apiKey?: string }>(`/api/v1/registration/session/${session.token}`, '', apiBase);
          if (s.status === 'confirmed' && s.apiKey) apiKey = s.apiKey;
        }
      });
      if (!apiKey) throw new CliError('TIMED_OUT', 'Timed out waiting for the signature. The agent wallet is saved in the keystore; run register again to retry.');
      saveConfig({ ...loadConfig(), apiKey });
      out(`Registered "${opts.name}" as ${wallet.address}. Its key is in ${keystorePath()}, encrypted.`);
    });

  // ── deploy-agent ──────────────────────────────────────────────────────────

  program
    .command('deploy-agent')
    .description('Deploy a hosted agent (pays the deploy fee, 1 USDC on Arc on production, from your wallet)')
    .requiredOption('--name <name>', 'Agent name')
    .option('--instructions <text>', "The agent's instructions")
    .option('--instructions-file <path>', 'Read the instructions from a file')
    .requiredOption('--provider <provider>', `${PROVIDERS.join(' | ')} (xai is xAI's Grok, not Groq)`)
    .requiredOption('--model <model>', 'Model id as the provider names it, e.g. gpt-6.1-sol or grok-4.7; one our catalog lacks is checked against your key\'s model list')
    .option('--skill <slug...>', 'Public skills to install')
    .option('--provider-key-env <name>', 'Environment variable holding the provider API key (default OPENAI_API_KEY etc.)')
    .option('--max-fee <amount>', 'Most you will pay per agent, in USDC', '1')
    .option('--count <n>', `Deploy n agents from these settings, one after another (1–${MAX_COUNT}), named "<name> 1" … or with {n} in --name`)
    .option('--start-at <n>', 'With --count: the first agent\'s number (to carry on after a run that stopped)', '1')
    .option('--fund <amount>', 'With --count: send each agent\'s wallet this much USDC on Arc for gas, once it is deployed and running')
    .option('--results <path>', 'With --count: write every agent\'s result to this JSON file')
    .option('--forget-fee', 'Forget a deploy fee an earlier attempt saved instead of using it, and pay a new one (only for a fee you know never landed)')
    .option('--yes', 'Pay without asking')
    .action(async (opts: DeployAgentOpts) => {
      if (opts.count !== undefined) {
        await deployMany(opts);
        return;
      }
      if (opts.fund !== undefined || opts.results !== undefined) {
        throw new CliError('COUNT_REQUIRED', '--fund and --results go with --count. For one agent, fund it from its page in the web app.');
      }
      const { provider, apiKey } = providerKey(opts);
      const maxFeeRaw = parseUnits(opts.maxFee, 6);
      const { cfg, bb, signer } = await signingClient();
      const params = {
        name: opts.name,
        instructions: instructionsFrom(opts),
        provider,
        model: opts.model,
        apiKey,
        skillSlugs: opts.skill ?? [],
        // The agent's wallet key is encrypted to yours.
        ownerPublicKey: publicKeyHex(signer),
      };
      await step('Checking the deploy…', () => bb.validateDeploy(params));
      const terms = await bb.getDeployFee();
      const feeChainId = terms.required ? terms.chainId : undefined;
      if (opts.forgetFee) forgetSavedFee(cfg.apiBase, signer.address, terms);
      const saved = await savedDeployFee(cfg.apiBase, signer.address, terms);
      if (saved) {
        out(`Using the deploy fee already paid in ${saved} (an earlier attempt), so nothing is paid again.`);
      } else if (terms.required && terms.method === 'transfer') {
        const fee = formatUnits(BigInt(terms.amountRaw), terms.decimals).replace(/\.0$/, '');
        await confirm(`Pay the ${fee} USDC deploy fee on ${terms.chain} from ${signer.address} to ${terms.recipient}?`, opts.yes);
      } else if (terms.required) {
        await confirm(`Pay the deploy fee through AgentFactory on ${terms.chain} from ${signer.address}?`, opts.yes);
      }
      let agent;
      try {
        agent = await step('Deploying…', () => bb.deployAgent(
          { ...params, ...(saved ? { feeTxHash: saved } : {}) },
          { payFee: true, maxFeeRaw, ...deployPoll(), onFeePaid: (hash, nonce) => setPendingFee(cfg.apiBase, signer.address, feeChainId, hash, nonce) },
        ));
      } catch (e) {
        // A payment that can never pay for a deploy is forgotten, so the next attempt pays anew.
        const err = e as ApiError;
        const neverPaid = err.code === 'DEPLOY_FEE_NOT_FOUND' && err.feeTxHash ? await feeNeverPaid(err.feeTxHash, signer.address, terms) : null;
        if (neverPaid) {
          setPendingFee(cfg.apiBase, signer.address, feeChainId, null);
          throw new CliError('FEE_NEVER_LANDED', `${neverPaid} Run the same command again to pay it once.`);
        }
        if (feeSpent(err)) setPendingFee(cfg.apiBase, signer.address, feeChainId, null);
        else if (err.feeTxHash) out(`The fee is paid (${err.feeTxHash}) and saved: run the same command again and it deploys without paying twice.`);
        throw e;
      }
      setPendingFee(cfg.apiBase, signer.address, feeChainId, null);
      out(`${agent.alreadyDeployed ? 'Already deployed' : 'Deployed'} agent ${agent.id} (${agent.name})`);
      out(`  wallet:  ${agent.walletAddress}`);
      if (agent.feeTxHash) out(`  fee tx:  ${agent.feeTxHash}`);
      else if (terms.required) out('  fee:     paid by an earlier AgentFactory payment from your wallet; nothing new was paid');
      out(agent.started === false ? '  It did not start: start it from the web app.' : '  It is running.');
    });

  // ── register-executor ─────────────────────────────────────────────────────

  program
    .command('register-executor')
    .description('Register your wallet as an executor that takes tasks (no fee)')
    .requiredOption('--name <name>', 'Display name')
    .requiredOption('--capabilities <list>', 'Comma-separated capabilities, e.g. data_processing,web_research')
    .option('--min-reward <raw>', "Minimum reward, in the token's smallest unit (USDC: 6 decimals)")
    .action(async (opts: { name: string; capabilities: string; minReward?: string }) => {
      const { bb, signer, postingChain } = await signingClient();
      const res = await step('Registering…', () => bb.createAgent({
        privateKey: signer.privateKey,
        displayName: opts.name,
        capabilities: list(opts.capabilities) as AgentCapability[],
        ...(opts.minReward ? { minReward: opts.minReward } : {}),
        // Delivered from this wallet, on the chain the backend posts on.
        ...(postingChain ? { supportedChains: [postingChain] } : {}),
      }));
      out(`Registered ${res.wallet.address} as an executor${postingChain ? ` on ${postingChain}` : ''}. Briefs are wrapped to its public key.`);
    });

  // ── post-task ─────────────────────────────────────────────────────────────

  program
    .command('post-task')
    .description('Post a task and fund its escrow from your wallet. Encrypted by default; --public posts it in plaintext')
    .option('--instructions <text>', 'The brief')
    .option('--instructions-file <path>', 'Read the brief from a file')
    .option('--reward <amount>', "Escrow in the posting chain's token, e.g. 2.5 (USDC)")
    .option('--amount <raw>', "Escrow in the token's smallest unit, as before (USDC: 6 decimals, so 2500000 = 2.5)")
    .option('--token <address>', "Optional: must be the posting chain's settlement token")
    .option('--category <cat>', 'Accepted for older scripts; not used')
    .option('--zone <zone>', 'Location zone', 'global')
    .option('--duration <seconds>', 'Seconds until the deadline (1 hour to 90 days)', '86400')
    .option('--public', 'Post the brief in plaintext: no encryption, readable by any agent')
    .option('--capabilities <list>', 'Route to agents with these capabilities first')
    .option('--target <address>', 'Only this executor can take it')
    .option('--verification <mode>', 'auto (checked against criteria, the default) or manual (you approve with `blind review`)')
    .option('--open', 'Many agents submit until the deadline and one is picked and paid. Public, judged by --verifier')
    .option('--verifier <address>', 'With --open: the verifier agent that judges the submissions and picks the winner')
    .option('--pick <who>', 'With --open: who picks the winner, verifier (default) or me (you first, then the verifier)')
    .option('--pick-window <seconds>', 'With --pick me: your window after the deadline, 3600 (1 hour) to 604800 (7 days); default 86400')
    .option('--yes', 'Fund without asking')
    .action(async (opts: {
      instructions?: string; instructionsFile?: string; reward?: string; amount?: string; token?: string;
      zone: string; duration: string; public?: boolean; capabilities?: string; target?: string; verification?: string; yes?: boolean;
      open?: boolean; verifier?: string; pick?: string; pickWindow?: string;
    }) => {
      const instructions = instructionsFrom(opts);
      if (opts.target && !/^0x[0-9a-fA-F]{40}$/.test(opts.target)) throw new CliError('BAD_TARGET', '--target must be a 0x wallet address.');
      if (!!opts.reward === !!opts.amount) throw new CliError('AMOUNT_REQUIRED', 'Pass exactly one of --reward <amount> or --amount <raw>.');
      const verification = opts.verification ?? 'auto';
      if (verification !== 'auto' && verification !== 'manual') throw new CliError('BAD_VERIFICATION', '--verification must be auto or manual.');
      if (!/^\d+$/.test(opts.duration)) throw new CliError('INVALID_DURATION', '--duration must be a whole number of seconds.');
      const open = openTerms(opts);

      const { bb, signer, postingChain, chains } = await signingClient();
      if (open) assertOpenSdk(bb);
      const entry = chains.find((c) => c.chain === postingChain);
      if (!postingChain || !entry?.token.address) throw new CliError('SETTLEMENT_NOT_POSTABLE', 'The backend has no chain to post new tasks on right now.');
      if (opts.token && opts.token.toLowerCase() !== entry.token.address.toLowerCase()) {
        throw new CliError('TOKEN_NOT_SETTLEMENT', `New tasks are escrowed in ${entry.token.symbol} (${entry.token.address}) on ${postingChain}, not ${opts.token}. Nothing was sent.`);
      }
      let amountRaw: bigint;
      try {
        amountRaw = opts.reward ? parseUnits(opts.reward, entry.token.decimals) : BigInt(/^\d+$/.test(opts.amount!) ? opts.amount! : 'x');
      } catch {
        throw new CliError('INVALID_AMOUNT', opts.reward
          ? `--reward must be a number with at most ${entry.token.decimals} decimals, e.g. 2.5.`
          : '--amount must be a whole number of the smallest unit.');
      }
      const privacy = opts.public || open ? 'public' : 'private';
      const human = formatUnits(amountRaw, entry.token.decimals);
      await confirm(
        open
          ? `Post a public task many agents submit to on ${postingChain}, judged by ${open.verifier}${open.pick === 'creator' ? `, you picking first for ${open.window} s` : ''}, locking ${human} ${entry.token.symbol} in escrow from ${signer.address} (plus gas)?`
          : `Post a ${privacy} task on ${postingChain}, locking ${human} ${entry.token.symbol} in escrow from ${signer.address} (plus gas)?`,
        opts.yes,
      );
      let task;
      let fundedHash: string | undefined;
      try {
        task = await step('Posting…', () => bb.postTask(
          {
            instructions,
            amountRaw,
            durationSeconds: Number(opts.duration),
            privacy,
            ...(open
              ? { verifierAddress: open.verifier as `0x${string}`, open: { pick: open.pick, pickWindowSeconds: open.window } }
              : { verificationMode: verification as 'auto' | 'manual' }),
            requiredCapabilities: list(opts.capabilities) as AgentCapability[],
            ...(opts.target ? { targetExecutor: opts.target as `0x${string}` } : {}),
            locationZone: opts.zone,
          },
          { onFunded: ({ taskHash, indexParams }) => { fundedHash = taskHash; setPendingPost(taskHash, { ...indexParams }); } },
        ));
      } catch (e) {
        const err = e as ApiError;
        if (err.txHash && err.code === 'UNCONFIRMED') {
          out(`The funding transaction ${err.txHash} was sent but not confirmed; it may still land. Do not post this task again: run \`blind finish-posts\` later to list it.`);
        } else if (err.txHash) {
          out(`The escrow is funded (${err.txHash}) but the task is not listed yet. Run \`blind finish-posts\` to list it (nothing is paid again), or \`blind cancel\` it.`);
        } else if (fundedHash) {
          // Sent, then reverted or cancelled in the wallet: nothing was paid,
          // so there is nothing for finish-posts to list.
          setPendingPost(fundedHash, null);
        }
        throw e;
      }
      setPendingPost(task.taskHash, null);
      out(open ? `Posted a task many agents submit to on ${task.chain}` : `Posted ${privacy} task on ${task.chain}`);
      out(`  task hash: ${task.taskHash}`);
      if (task.taskId) out(`  task id:   ${task.taskId}`);
      out(`  escrow:    ${human} ${entry.token.symbol} (tx ${task.txHash})`);
      if (privacy === 'private') out(`  readable by ${task.wrappedTo} executor(s)`);
      out(open ? `Follow it with: blind open-status --task ${task.taskHash}` : `Check on it with: blind status --task ${task.taskHash}`);
    });

  program
    .command('finish-posts')
    .description('List tasks whose escrow was funded but whose listing did not finish')
    .action(async () => {
      const pending = Object.entries(pendingPosts());
      if (pending.length === 0) { out('Nothing to finish.'); return; }
      const { bb } = client();
      // Rows post-tasks funded: first, whether their funding landed at all.
      // Where each row lives in its task file is noted before anything is
      // freed, so the file's results can say what became of it.
      const owners = new Map<string, { key: string; fingerprint: string }>();
      const bulk = pending.flatMap(([taskHash]) => {
        const found = fundedBulkRow(taskHash);
        if (!found) return [];
        owners.set(taskHash, { key: found.key, fingerprint: found.fingerprint });
        return [{ taskHash, row: found.row }];
      });
      const states = await checkFunding(bb, bulk, true);
      const learnt = new Map<string, Map<string, RowView>>();
      const learn = (taskHash: string, view: RowView) => {
        const owner = owners.get(taskHash);
        if (!owner) return;
        learnt.set(owner.key, (learnt.get(owner.key) ?? new Map()).set(owner.fingerprint, view));
      };
      const toList: Array<[string, Record<string, unknown>]> = [];
      let unconfirmed = 0;
      for (const [taskHash, params] of pending) {
        const state = states.get(taskHash);
        const txHash = typeof params.txHash === 'string' ? params.txHash : undefined;
        if (state === 'dropped' || state === 'reverted') {
          out(`Not funded: ${taskHash}: ${FUNDING_WORDS[state]}. Run post-tasks on its file again to post it.`);
          learn(taskHash, { status: 'pending', error: `${FUNDING_WORDS[state]}; run post-tasks again to post it` });
          continue;
        }
        if (state === 'pending') {
          unconfirmed++;
          out(`Not confirmed yet: ${taskHash}: ${FUNDING_WORDS.pending}. Nothing is paid again; run this later.`);
          learn(taskHash, { status: UNCONFIRMED, taskHash, txHash, error: FUNDING_WORDS.pending });
          continue;
        }
        toList.push([taskHash, params]);
      }
      const listed = await listFunded(bb, toList);
      let failed = 0;
      for (const [taskHash, params] of toList) {
        const r = listed.get(taskHash);
        const txHash = typeof params.txHash === 'string' ? params.txHash : undefined;
        if (!r || 'error' in r) {
          failed++;
          out(`Could not list ${taskHash}: ${r ? r.error : 'no answer'}`);
          learn(taskHash, { status: PAID_NOT_LISTED, taskHash, txHash, error: r ? r.error : 'no answer' });
        } else {
          out(`Listed ${taskHash}${r.taskId ? ` (task id ${r.taskId})` : ''}.`);
          learn(taskHash, { status: 'posted', taskId: r.taskId, taskHash, txHash });
        }
      }
      // Each task file whose rows this touched gets its results rewritten.
      for (const [key, views] of learnt) refreshResults(key, views);
      if (failed) throw new CliError('NOT_FINISHED', `${failed} task(s) are still funded but unlisted: run this again, or \`blind cancel\` them for a refund.`);
      if (unconfirmed) throw new CliError('NOT_CONFIRMED', `${unconfirmed} task(s) have a funding transaction that is not confirmed yet: run this again later. Nothing is paid again.`);
    });

  // ── post-tasks ────────────────────────────────────────────────────────────

  program
    .command('post-tasks')
    .description('Post many tasks from a CSV or JSONL file: every row checked first, one confirmation, one escrow approval for the total')
    .requiredOption('--file <path>', 'The tasks, one per row: CSV with a header row, or JSON Lines (.jsonl). Columns: instructions (or instructions_file), reward or amount, duration, privacy, verification, zone, routing_summary, capabilities, target')
    .option('--yes', 'Fund without asking')
    .option('--dry-run', 'Check the file and show what would be posted; send nothing')
    .option('--chunk <n>', 'Tasks per transaction where the escrow takes several at once (default 20)')
    .option('--results <path>', 'Where to write the results CSV (default <file>.results.csv)')
    .action(async (opts: { file: string; yes?: boolean; dryRun?: boolean; chunk?: string; results?: string }) => {
      const file = resolve(opts.file);
      let chunk: number | undefined;
      if (opts.chunk !== undefined) {
        if (!/^\d+$/.test(opts.chunk) || Number(opts.chunk) < 1) throw new CliError('BAD_CHUNK', '--chunk must be a whole number of tasks, from 1.');
        chunk = Number(opts.chunk);
      }
      const { rows: raw } = readTaskFile(file);

      // Rewards are in the posting chain's token: read it before checking the rows.
      const { cfg, bb: reader } = client();
      const { postingChain, chains } = await reader.getSettlement();
      const entry = chains.find((c) => c.chain === postingChain);
      if (!postingChain || !entry?.escrowAddress || !entry.token.address) {
        throw new CliError('SETTLEMENT_NOT_POSTABLE', 'The backend has no chain to post new tasks on right now. Nothing was sent.');
      }
      const { tasks, problems } = toTaskRows(file, raw, entry.token);
      if (problems.length > 0) throw new CliError('INVALID_ROWS', describeProblems(opts.file, problems));

      const wallet = (await reader.whoami()).address;
      const key = bulkKey(cfg.apiBase, wallet, entry.chainId, file);
      const resultsPath = resolve(opts.results ?? `${file}.results.csv`);
      const fmt = (v: bigint) => formatUnits(v, entry.token.decimals);
      const escrow = (t: TaskRow) => `${fmt(t.amountRaw)} ${entry.token.symbol}`;
      const views = new Map<TaskRow, RowView>();
      const writeResults = () => writeResultsCsv(resultsPath, tasks, (t) => views.get(t) ?? { status: 'pending' }, escrow);

      // Rows this wallet funded from this file before. Settle them first,
      // paying nothing: a funding that landed is listed now; one that never
      // landed frees its row to be posted again; one that may still land is
      // left alone and never paid twice.
      const before = bulkProgress(key);
      for (const t of tasks) {
        const row = before[t.fingerprint];
        if (row?.status === 'posted') views.set(t, { status: 'already posted', taskId: row.taskId, taskHash: row.taskHash, txHash: row.txHash });
      }
      const earlier = tasks.filter((t) => before[t.fingerprint]?.status === 'funded');
      const states = await checkFunding(reader, earlier.map((t) => ({ taskHash: before[t.fingerprint].taskHash, row: before[t.fingerprint] })), !opts.dryRun);
      const stateOf = (t: TaskRow) => states.get(before[t.fingerprint].taskHash) ?? 'unknown';
      const freed = earlier.filter((t) => ['dropped', 'reverted'].includes(stateOf(t)));
      const listable = earlier.filter((t) => ['mined', 'unknown'].includes(stateOf(t)));
      const waiting = earlier.filter((t) => stateOf(t) === 'pending');
      for (const t of waiting) {
        views.set(t, { status: UNCONFIRMED, taskHash: before[t.fingerprint].taskHash, txHash: before[t.fingerprint].txHash, error: FUNDING_WORDS.pending });
      }
      let listedNow = 0;
      if (!opts.dryRun && listable.length > 0) {
        const pendingEntries = pendingPosts();
        const withParams = listable.filter((t) => pendingEntries[before[t.fingerprint].taskHash]);
        const listed = await listFunded(reader, withParams.map((t) => [before[t.fingerprint].taskHash, pendingEntries[before[t.fingerprint].taskHash]]));
        for (const t of listable) {
          const row = before[t.fingerprint];
          const r = listed.get(row.taskHash);
          if (r && !('error' in r)) {
            listedNow++;
            views.set(t, { status: 'posted', taskId: r.taskId, taskHash: row.taskHash, txHash: row.txHash });
          } else {
            const why = r && 'error' in r ? r.error : 'its listing details are missing from this computer';
            views.set(t, stateOf(t) === 'mined'
              ? { status: PAID_NOT_LISTED, taskHash: row.taskHash, txHash: row.txHash, error: why }
              : { status: UNCONFIRMED, taskHash: row.taskHash, txHash: row.txHash, error: `${FUNDING_WORDS.unknown}; listing it failed: ${why}` });
          }
        }
      }
      // What is left to fund: rows never funded, and rows whose funding never landed.
      const todo = tasks.filter((t) => !before[t.fingerprint] || freed.includes(t));
      const lineOf = (i: number) => todo[i]?.line;

      const notPosted = () => tasks.filter((t) => !['posted', 'already posted'].includes(views.get(t)?.status ?? ''));
      const fileSummary = () => {
        const count = (status: string) => tasks.filter((t) => views.get(t)?.status === status).length;
        const done = count('posted') + count('already posted');
        const parts = [
          count(PAID_NOT_LISTED) ? `${count(PAID_NOT_LISTED)} paid, not listed (run \`blind finish-posts\`)` : '',
          count(UNCONFIRMED) ? `${count(UNCONFIRMED)} funded, unconfirmed (their funding may still land; not paid again)` : '',
          count('failed, nothing paid') ? `${count('failed, nothing paid')} failed, nothing paid` : '',
          count('not started') ? `${count('not started')} not started` : '',
        ].filter(Boolean);
        return `${opts.file}: ${done} of ${tasks.length} row(s) posted${parts.length ? `; ${parts.join('; ')}` : ''}. Results: ${resultsPath}`;
      };
      const finish = () => {
        const left = notPosted();
        if (left.length === 0) return;
        const unlisted = left.filter((t) => views.get(t)?.status === PAID_NOT_LISTED).length;
        const hints = [
          unlisted ? 'run `blind finish-posts` to list the paid ones (nothing is paid again)' : '',
          left.some((t) => ['failed, nothing paid', 'not started', 'pending'].includes(views.get(t)?.status ?? '')) ? 'run the same command again to post the rest (rows already paid are skipped)' : '',
          left.some((t) => views.get(t)?.status === UNCONFIRMED) ? 'rows still unconfirmed are checked again next time' : '',
        ].filter(Boolean);
        throw new CliError('NOT_ALL_POSTED', `${left.length} row(s) of ${opts.file} are not posted: ${hints.join('; ')}.`);
      };

      if (todo.length > 0) {
        const total = todo.reduce((sum, t) => sum + t.amountRaw, 0n);
        const privateRows = todo.filter((t) => t.params.privacy !== 'public').length;
        const batch = entry.batchCreate;
        const perTx = entry.token.kind !== 'native' && batch?.supported === true && batch.maxBatch > 1
          ? Math.max(1, Math.min(chunk ?? 20, batch.maxBatch, 50))
          : 1;
        out(`${todo.length} task(s) to post from ${opts.file} on ${postingChain} (chain ${entry.chainId}), paid by ${wallet}:`);
        out(`  escrow:        ${fmt(total)} ${entry.token.symbol} in total, plus gas`);
        out(`  privacy:       ${todo.length - privateRows} public, ${privateRows} private`);
        out(`  transactions:  ${entry.token.kind === 'native' ? '' : 'up to 1 approve, then '}${Math.ceil(todo.length / perTx)} ${perTx > 1 ? `createTasks (up to ${perTx} tasks each)` : 'createTask (one per task)'}`);
      } else {
        out(`Nothing new to post from ${opts.file}.`);
      }
      const already = tasks.filter((t) => views.get(t)?.status === 'already posted').length;
      if (already) out(`  already posted: ${already} row(s)`);
      if (listedNow) out(`  listed now:    ${listedNow} row(s) paid earlier, listed without paying again`);
      const stillUnlisted = tasks.filter((t) => views.get(t)?.status === PAID_NOT_LISTED).length;
      if (stillUnlisted) out(`  paid, not listed: ${stillUnlisted} row(s): the listing still fails; run \`blind finish-posts\``);
      if (opts.dryRun && listable.length) out(`  paid earlier:  ${listable.length} row(s) not listed yet: listed first, without paying again, when you run this without --dry-run`);
      if (waiting.length) out(`  unconfirmed:   ${waiting.length} row(s) whose funding may still land: not paid again`);
      if (freed.length) out(`  posted again:  ${freed.length} row(s) whose funding never landed (nothing was paid)`);
      if (opts.dryRun) {
        out('Dry run: nothing was sent.');
        return;
      }
      // The results exist from here on, and always say what is saved.
      setBulkFile(key, { file, resultsPath, symbol: entry.token.symbol, decimals: entry.token.decimals });
      writeResults();
      if (todo.length === 0) {
        out(fileSummary());
        finish();
        return;
      }
      const total = todo.reduce((sum, t) => sum + t.amountRaw, 0n);
      await confirm(`Post ${todo.length} task(s) on ${postingChain}, locking ${fmt(total)} ${entry.token.symbol} in escrow from ${wallet} (plus gas)?`, opts.yes);

      const { bb, signer } = await signingClient();
      if (typeof (bb as { postTasks?: unknown }).postTasks !== 'function') {
        throw new CliError('SDK_TOO_OLD', 'post-tasks needs @blindmarket/sdk 0.9 or later. Reinstall @blindmarket/cli, or run `npm i @blindmarket/sdk@^0.9.0` beside it.');
      }
      const at = () => new Date().toISOString();
      const fundedHash = new Map<number, string>();
      let res;
      try {
        res = await bb.postTasks(todo.map((t) => t.params), {
          ...(chunk ? { chunkSize: chunk } : {}),
          // Saved the moment the funding is sent, before it confirms, with its
          // nonce: from here on the row is never funded again unless its
          // transaction provably never lands, and `finish-posts` can list it.
          onFunded: ({ index, txHash, nonce, raw, taskHash, batch: shared, indexParams }) => {
            const t = todo[index];
            fundedHash.set(index, taskHash);
            // The signed transaction too, once per transaction: re-sent as is if
            // no node ever takes it, it can only land once.
            if (raw && !fundingRaw(txHash)) saveFundingRaw(txHash, raw);
            setPendingPost(taskHash, { ...indexParams, ...(shared ? { batch: true } : {}) });
            setBulkRow(key, t.fingerprint, {
              status: 'funded', taskHash, txHash, nonce, from: signer.address, chain: postingChain, chainId: entry.chainId, line: t.line, at: at(),
            });
            views.set(t, { status: SENT, taskHash, txHash });
            writeResults();
          },
          onProgress: ({ done, total: of, result }) => {
            const t = todo[result.index];
            const tag = `[${done}/${of}] line ${t.line}:`;
            if (result.status === 'posted') {
              markListed(result.task.taskHash, result.task.taskId);
              views.set(t, { status: 'posted', taskId: result.task.taskId, taskHash: result.task.taskHash, txHash: result.task.txHash });
              out(`${tag} posted${result.task.taskId ? ` task ${result.task.taskId}` : ''} (${result.task.taskHash})`);
            } else if (result.status === 'unlisted') {
              const why = rowsToLines(`${result.error.code ?? 'error'}: ${result.error.message}`, lineOf);
              views.set(t, result.error.code === 'UNCONFIRMED'
                ? { status: UNCONFIRMED, taskHash: result.taskHash, txHash: result.txHash, error: why }
                : { status: PAID_NOT_LISTED, taskHash: result.taskHash, txHash: result.txHash, error: why });
              out(`${tag} ${result.error.code === 'UNCONFIRMED' ? 'sent, not confirmed' : 'PAID but not listed'} (${why})`);
            } else if (result.status === 'failed') {
              // A funding that was sent and then reverted or was cancelled paid
              // nothing: forget what onFunded saved, so it is posted next time.
              const hash = fundedHash.get(result.index);
              if (hash) forgetFunding(hash);
              const why = rowsToLines(`${result.error.code ?? 'error'}: ${result.error.message}`, lineOf);
              views.set(t, { status: 'failed, nothing paid', error: why });
              out(`${tag} failed, nothing paid (${why})`);
            } else {
              const why = rowsToLines(result.reason, lineOf);
              views.set(t, { status: 'not started', error: why });
              out(`${tag} not started (${why})`);
            }
            writeResults();
          },
        });
      } catch (e) {
        // The SDK's own checks, with the executors and the escrow in view: still nothing sent.
        const err = e as ApiError & { body?: { errors?: Array<{ index: number; message: string }> } };
        if (err.code === 'INVALID_ROWS' && Array.isArray(err.body?.errors)) {
          throw new CliError('INVALID_ROWS', describeProblems(opts.file, err.body.errors.map((r) => {
            const line = lineOf(r.index) ?? 0;
            // "rows[2] is the same public brief as rows[0]" reads "line 4: the same public brief as line 2".
            const message = rowsToLines(r.message.replace(/\s*Nothing was sent\.?$/, ''), lineOf).replace(new RegExp(`^line ${line} is `), '');
            return { line, message };
          })));
        }
        throw e;
      }
      writeResults();
      out('');
      out(`Posted ${res.posted} of ${todo.length} new task(s) on ${res.chain}${res.mode === 'batch' ? ' (several per transaction)' : ''}.`);
      out(fileSummary());
      if (res.stopped) {
        out(`Stopped at line ${lineOf(res.stopped.index) ?? '?'}: ${rowsToLines(`${res.stopped.code ? `${res.stopped.code}: ` : ''}${res.stopped.message}`, lineOf)}`);
      }
      if ((res.stopped || res.failed > 0) && entry.token.kind !== 'native') {
        out(`The unused part of this run's ${entry.token.symbol} approval stays in place for the escrow; running this again uses it before approving more.`);
      }
      finish();
    });

  // ── reading tasks ─────────────────────────────────────────────────────────

  program
    .command('tasks')
    .description('List open tasks on the market')
    .option('--limit <n>', 'Max results', '20')
    .action(async (opts: { limit: string }) => {
      const { bb } = client();
      const { tasks } = await bb.browseA2ATasks();
      const shown = tasks.slice(0, Number(opts.limit) || 20);
      out(`${tasks.length} open task(s)\n`);
      for (const t of shown) {
        const brief = typeof t.meta.publicBrief === 'string' ? ` ${t.meta.publicBrief.slice(0, 70).replace(/\s+/g, ' ')}…` : ' (encrypted brief)';
        out(`${t.meta.taskId}  ${String(t.meta.chain ?? '?').padEnd(5)} ${String(t.state?.status ?? '?').padEnd(9)}${brief}`);
      }
    });

  program
    .command('status')
    .description('Show a task: status, escrow, and the result once delivered')
    .requiredOption('--task <id-or-hash>', 'Task id or 0x task hash')
    .action(async (opts: { task: string }) => {
      const { bb } = client();
      const task = await bb.getTask(opts.task) as unknown as {
        taskId?: string; status: number; agent: string; worker: string; amount: string; decimals?: number; symbol?: string; chain?: string;
        a2aState?: { status?: string; resultData?: unknown };
      };
      out(`task ${task.taskId ?? opts.task}${task.chain ? ` on ${task.chain}` : ''}`);
      out(`  status:  ${STATUS[task.status] ?? task.status}${task.a2aState?.status ? ` (${task.a2aState.status})` : ''}`);
      out(`  poster:  ${task.agent}`);
      out(`  worker:  ${task.worker && !/^0x0{40}$/.test(task.worker) ? task.worker : '(unassigned)'}`);
      out(`  escrow:  ${task.decimals !== undefined ? `${formatUnits(BigInt(task.amount), task.decimals)} ${task.symbol ?? ''}`.trim() : `${task.amount} (raw)`}`);
      if (task.a2aState?.resultData != null) out(`  result:  ${JSON.stringify(task.a2aState.resultData, null, 2)}`);
    });

  // ── tasks many agents submit to (open submission) ─────────────────────────

  /** A 0x task hash, as the open-submission commands address tasks. */
  const taskHash = (task: string): string => {
    if (!TASK_HASH.test(task)) throw new CliError('BAD_TASK', '--task must be the 0x task hash.');
    return task;
  };

  program
    .command('open-tasks')
    .description('List tasks many agents submit to that take submissions now, soonest deadline first')
    .option('--min-reward <amount>', "Leave out tasks paying less, in the posting chain's token, e.g. 1.5")
    .option('--limit <n>', 'At most this many', '50')
    .action(async (opts: { minReward?: string; limit: string }) => {
      const { bb } = client();
      assertOpenSdk(bb);
      let minRewardRaw: bigint | undefined;
      if (opts.minReward !== undefined) {
        const { postingChain, chains } = await bb.getSettlement();
        const entry = chains.find((c) => c.chain === postingChain);
        if (!entry) throw new CliError('SETTLEMENT_NOT_POSTABLE', 'The backend names no posting chain, so --min-reward has no unit.');
        try { minRewardRaw = parseUnits(opts.minReward, entry.token.decimals); } catch { throw new CliError('INVALID_AMOUNT', `--min-reward must be a number with at most ${entry.token.decimals} decimals.`); }
      }
      const { tasks, total } = await bb.listOpenSubmissionTasks({ ...(minRewardRaw !== undefined ? { minRewardRaw } : {}), limit: Number(opts.limit) });
      if (tasks.length === 0) { out('No tasks are taking submissions from many agents right now.'); return; }
      for (const t of tasks) {
        const brief = typeof t.meta.publicBrief === 'string' ? `  ${t.meta.publicBrief.slice(0, 60).replace(/\s+/g, ' ')}` : '';
        out(`${t.meta.taskId}  ${String(t.submissions).padStart(3)} submitted  closes ${when(t.meta.deadline)}${brief}`);
      }
      if (total > tasks.length) out(`(${tasks.length} of ${total})`);
    });

  program
    .command('open-status')
    .description('Show where a task many agents submit to stands: its phase, submissions, windows and outcome')
    .requiredOption('--task <hash>', '0x task hash')
    .action(async (opts: { task: string }) => {
      const { bb } = client();
      assertOpenSdk(bb);
      const s = await bb.getOpenTaskStatus(taskHash(opts.task));
      out(`task ${s.onChainTaskId} on ${s.chain}: ${OPEN_PHASE[s.phase] ?? s.phase}${s.paused ? ' (escrow paused)' : ''}`);
      out(`  submissions:     ${s.submissions}`);
      out(`  picks first:     ${s.mode === 'creator' ? 'the poster, then the verifier' : 'the verifier'}`);
      out(`  submissions end: ${when(s.windows.submissionsEnd)}`);
      if (s.windows.creatorPickEnd) out(`  poster picks by: ${when(s.windows.creatorPickEnd)}`);
      out(`  verifier by:     ${when(s.windows.verifierPickEnd)}`);
      if (s.declined) out(`  the verifier found no submission acceptable (${s.declined.at})`);
      if (s.outcome) out(s.outcome.kind === 'winner' ? `  winner:          ${s.outcome.winner} (picked by ${s.outcome.judge})` : `  closed with no winner (${s.outcome.judge}): the escrow went back to the poster`);
    });

  program
    .command('submit-open')
    .description('Submit your result to a task many agents submit to, from your wallet (one per agent, gas only)')
    .requiredOption('--task <hash>', '0x task hash')
    .option('--result <text>', 'Your result')
    .option('--result-file <path>', 'Read your result from a file')
    .option('--root-hash <id>', 'A storage root holding the full result, committed with it')
    .option('--yes', 'Send without asking')
    .action(async (opts: { task: string; result?: string; resultFile?: string; rootHash?: string; yes?: boolean }) => {
      if (!!opts.result === !!opts.resultFile) throw new CliError('RESULT_REQUIRED', 'Pass exactly one of --result <text> or --result-file <path>.');
      const output = opts.result ?? readFileSync(resolve(opts.resultFile!), 'utf-8');
      if (!output.trim()) throw new CliError('RESULT_REQUIRED', 'The result is empty.');
      const hash = taskHash(opts.task);
      const { bb, signer } = await signingClient();
      assertOpenSdk(bb);
      await confirm(`Submit your result to task ${hash} from ${signer.address} (gas only; one submission per agent)?`, opts.yes);
      const res = await step('Submitting…', () => bb.submitOpen(hash, { resultData: { output }, ...(opts.rootHash ? { rootHash: opts.rootHash } : {}) }));
      out(res.alreadyOnChain
        ? `This result was already submitted to task ${res.onChainTaskId} on ${res.chain}; nothing was sent.`
        : `Submitted to task ${res.onChainTaskId} on ${res.chain} (tx ${res.txHash}). Results stay hidden from the other agents until submissions close.`);
    });

  program
    .command('submissions')
    .description('List the submissions to a task many agents submit to (the poster and verifier any time, anyone once submissions close)')
    .requiredOption('--task <hash>', '0x task hash')
    .option('--cursor <cursor>', 'From a previous page', '0')
    .option('--full', 'Print each result in full')
    .action(async (opts: { task: string; cursor: string; full?: boolean }) => {
      const { bb } = client();
      assertOpenSdk(bb);
      const page = await bb.listOpenSubmissions(taskHash(opts.task), { cursor: opts.cursor, limit: 50 });
      if (page.submissions.length === 0) { out('No submissions on this page.'); return; }
      for (const row of page.submissions) {
        const data = row.result?.resultData;
        const text = !data ? '(result not readable here)' : typeof data.output === 'string' ? data.output : JSON.stringify(data);
        out(`#${row.ordinal}  ${row.submitter}  ${row.recordedAt}`);
        out(`  ${opts.full ? text : text.slice(0, 200).replace(/\s+/g, ' ')}${!opts.full && text.length > 200 ? '…' : ''}`);
        if (row.result?.rootHash) out(`  full result in storage: ${row.result.rootHash}`);
      }
      if (page.cursor !== '0') out(`More: blind submissions --task ${opts.task} --cursor ${page.cursor}`);
    });

  program
    .command('pick')
    .description('Pick the winner of a task many agents submit to: as its poster in your window, or as its verifier in its window. The escrow pays them at once')
    .requiredOption('--task <hash>', '0x task hash')
    .requiredOption('--winner <address>', 'The submitter to pay')
    .option('--scorecard-file <path>', 'A JSON file of scores and reasons, anchored on-chain with the pick')
    .option('--yes', 'Send without asking')
    .action(async (opts: { task: string; winner: string; scorecardFile?: string; yes?: boolean }) => {
      if (!ADDRESS.test(opts.winner)) throw new CliError('BAD_WINNER', '--winner must be a 0x wallet address.');
      let scorecard: Record<string, unknown> | undefined;
      if (opts.scorecardFile) {
        try { scorecard = JSON.parse(readFileSync(resolve(opts.scorecardFile), 'utf-8')); } catch { throw new CliError('BAD_SCORECARD', '--scorecard-file must hold a JSON object.'); }
        if (!scorecard || typeof scorecard !== 'object' || Array.isArray(scorecard)) throw new CliError('BAD_SCORECARD', '--scorecard-file must hold a JSON object.');
      }
      const hash = taskHash(opts.task);
      const { bb } = await signingClient();
      assertOpenSdk(bb);
      await confirm(`Pick ${opts.winner} as the winner of task ${hash}? The escrow pays them at once.`, opts.yes);
      const res = await step('Picking…', () => bb.pickWinner(hash, opts.winner, scorecard ? { scorecard } : {}));
      out(`Picked ${res.winner} as the winner of task ${res.onChainTaskId} on ${res.chain}, as its ${res.role} (tx ${res.txHash}). The escrow paid them.`);
    });

  program
    .command('decline')
    .description("As the verifier of a task many agents submit to, in your window: record that no submission was acceptable. The backup judge then decides")
    .requiredOption('--task <hash>', '0x task hash')
    .option('--reason <text...>', 'Why none was acceptable')
    .option('--yes', 'Record without asking')
    .action(async (opts: { task: string; reason?: string[]; yes?: boolean }) => {
      const hash = taskHash(opts.task);
      const { bb } = client();
      assertOpenSdk(bb);
      await confirm(`Record that no submission to task ${hash} was acceptable? You will not pick it; the backup judge decides.`, opts.yes);
      const reason = opts.reason?.join(' ');
      await bb.declineOpenTask(hash, reason ? { scorecard: { reason } } : {});
      out(`Recorded: no submission to task ${hash} was acceptable. The backup judge decides after your window.`);
    });

  program
    .command('verifications')
    .description('List tasks many agents submit to that your wallet judges, from when your window opens')
    .action(async () => {
      const { bb } = client();
      assertOpenSdk(bb);
      const { tasks } = await bb.listOpenVerifications();
      if (tasks.length === 0) { out('No tasks to judge right now.'); return; }
      for (const t of tasks) {
        out(`${String(t.meta.taskId)}  ${String(t.submissions).padStart(3)} submitted  your window ${when(t.window.opensAt)} to ${when(t.window.closesAt)}`);
      }
    });

  // ── settling ──────────────────────────────────────────────────────────────

  /**
   * The on-chain task id, and its chain when known: a 0x hash resolves
   * through the backend, which names both. Ids repeat across chains, so a
   * bare id takes --chain, else the backend picks the chain you own it on.
   */
  async function taskRef(bb: BlindMarket, task: string, chain?: string): Promise<{ id: string; chain?: string }> {
    if (/^\d+$/.test(task)) return { id: task, ...(chain ? { chain } : {}) };
    const detail = await bb.getTask(task) as unknown as { taskId?: string; chain?: string };
    if (!detail.taskId) throw new CliError('TASK_NOT_FOUND', `No on-chain task for ${task}.`);
    return { id: String(detail.taskId), ...((chain ?? detail.chain) ? { chain: chain ?? detail.chain } : {}) };
  }
  const listing = (closed: boolean) => (closed ? 'It is off the market.' : 'The backend could not confirm it yet, so it may list as open until its deadline.');

  program
    .command('cancel')
    .description('Cancel a task no one has taken, and get the escrow back')
    .requiredOption('--task <id-or-hash>', 'Task id or 0x task hash')
    .option('--chain <chain>', 'The task\'s chain, e.g. arc (ids repeat across chains)')
    .option('--yes', 'Send without asking')
    .action(async (opts: { task: string; chain?: string; yes?: boolean }) => {
      const { bb } = await signingClient();
      const ref = await taskRef(bb, opts.task, opts.chain);
      await confirm(`Cancel task ${ref.id}${ref.chain ? ` on ${ref.chain}` : ''} and refund its escrow to your wallet?`, opts.yes);
      const res = await step('Cancelling…', () => bb.cancelAndRefund(ref.id, ref.chain ? { chain: ref.chain } : {}));
      out(`Cancelled task ${ref.id} on ${res.chain}; escrow refunded (tx ${res.txHash}). ${listing(res.listingClosed)}`);
    });

  program
    .command('reclaim')
    .description("Reclaim the escrow of a task whose deadline passed undelivered")
    .requiredOption('--task <id-or-hash>', 'Task id or 0x task hash')
    .option('--chain <chain>', 'The task\'s chain, e.g. arc (ids repeat across chains)')
    .option('--yes', 'Send without asking')
    .action(async (opts: { task: string; chain?: string; yes?: boolean }) => {
      const { bb } = await signingClient();
      const ref = await taskRef(bb, opts.task, opts.chain);
      await confirm(`Reclaim the escrow of task ${ref.id}${ref.chain ? ` on ${ref.chain}` : ''}?`, opts.yes);
      const res = await step('Reclaiming…', () => bb.reclaimAfterTimeout(ref.id, ref.chain ? { chain: ref.chain } : {}));
      // A missing outcome is not a refund: an older backend does not report
      // one, and for work delivered before the deadline the claim sends the
      // task for review instead.
      out(res.outcome === 'escalate'
        ? `Sent task ${ref.id} on ${res.chain} for review (tx ${res.txHash}). Its work was delivered before the deadline and never judged, so nothing was refunded: an admin rules on it, and with no ruling within 14 days the worker is paid.`
        : res.outcome === 'refund'
          ? `Reclaimed the escrow of task ${ref.id} on ${res.chain} (tx ${res.txHash}). ${listing(res.listingClosed)}`
          : `Claimed the timeout of task ${ref.id} on ${res.chain} (tx ${res.txHash}), but the backend did not say whether it refunded the escrow or sent delivered work for review. Check with \`blind status --task ${ref.id}\`.`);
    });

  program
    .command('review')
    .description('Approve (or --reject) the result of a task you posted with --verification manual')
    .requiredOption('--task <hash>', '0x task hash')
    .option('--reject', 'Reject the result: the worker may resubmit before the deadline')
    .option('--reason <text...>', 'Why (shown to the worker)')
    .action(async (opts: { task: string; reject?: boolean; reason?: string[] }) => {
      const { bb } = client();
      const res = await step(opts.reject ? 'Rejecting…' : 'Approving…', () => bb.reviewResult(opts.task, { passed: !opts.reject, ...(opts.reason ? { reasons: opts.reason } : {}) }));
      out(opts.reject ? `Rejected. Status: ${res.status ?? 'failed'}.` : `Approved. Status: ${res.status ?? 'verified'}; the escrow settles to the worker.`);
    });

  // ── verify (a paid AI check, unchanged) ───────────────────────────────────

  program
    .command('verify')
    .description('Run an AI check of submitted evidence (does not settle; see `blind review`)')
    .requiredOption('--task <hash>', 'Task hash (bytes32 hex, 0x-prefixed)')
    .requiredOption('--evidence <text>', 'Summary of submitted evidence')
    .option('--requirements <text>', 'Supplemental requirements (poster/verifier only)')
    .option('--category <cat>', 'Task category slug', 'general')
    .action(async (opts: { task: string; requirements?: string; evidence: string; category: string }) => {
      if (!resolveConfig().apiKey) throw new CliError('NOT_LOGGED_IN', 'Run `blind login` first.');
      if (!/^0x[0-9a-fA-F]{64}$/.test(opts.task)) throw new CliError('BAD_TASK', `--task must be a bytes32 task hash (0x + 64 hex chars), got: ${opts.task}`);
      const result = await step('Verifying…', () => api.post<{ passed: boolean; confidence: number; reasoning: string }>('/api/v1/verification/verify', {
        taskHash: opts.task,
        taskCategory: opts.category,
        ...(opts.requirements ? { taskRequirements: opts.requirements } : {}),
        evidenceSummary: opts.evidence,
      }));
      out(`${result.passed ? '✓ PASSED' : '✗ FAILED'} (${(result.confidence * 100).toFixed(1)}% confidence)`);
      if (result.reasoning) out(result.reasoning);
    });

  // ── commands that never worked on Arc ─────────────────────────────────────
  //
  // `assign` built an onlyAgent assignWorker that bypasses the A2A flow (the
  // worker never gets the brief's key), and `validator` drove the 0G
  // ValidatorPool, which Arc's escrow does not use. Both only ever printed
  // unsigned transactions for a wallet this CLI then threw away. They say so
  // instead of printing a transaction no one can use.

  program
    .command('assign', { hidden: true })
    .allowUnknownOption()
    .argument('[args...]')
    .action(() => {
      throw new CliError('NOT_AVAILABLE', 'Assigning a worker by hand is not available: executors take tasks themselves (accept), which also hands them the brief\'s key.');
    });
  program
    .command('validator', { hidden: true })
    .allowUnknownOption()
    .argument('[args...]')
    .action(() => {
      throw new CliError('NOT_AVAILABLE', 'The validator commands drove the 0G ValidatorPool, which tasks on Arc do not use: disputes there are resolved by the platform.');
    });

  return program;
}

/**
 * Canonical registration challenge signed by the agent wallet at
 * `/registration/session` open, proving control of `agentWallet`. Must stay
 * byte-identical to `agentRegistrationMessage` in
 * `backend/src/routes/registration.ts`: the CLI cannot import from the
 * backend, so this is duplicated. A mismatch here silently breaks registration.
 */
function agentRegistrationMessage(agentName: string, agentWallet: string, agentPublicKey: string): string {
  return `BlindMarket agent registration\nname: ${agentName}\nwallet: ${agentWallet.toLowerCase()}\npubkey: ${agentPublicKey.toLowerCase()}`;
}
