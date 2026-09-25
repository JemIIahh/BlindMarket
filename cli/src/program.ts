import { Command } from 'commander';
import { readFileSync } from 'fs';
import { Wallet, formatUnits, parseUnits } from 'ethers';
import ora from 'ora';
import { BlindMarket, ApiError } from '@blindmarket/sdk';
import type { AgentCapability } from '@blindmarket/sdk';
import {
  loadConfig, resolveConfig, saveConfig, DEFAULT_API_BASE,
  pendingFee, setPendingFee, pendingPosts, setPendingPost,
} from './config.js';
import { api } from './api.js';
import { client, signingClient } from './client.js';
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
};
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
    .requiredOption('--provider <provider>', 'openai | anthropic | groq | gemini | 0g-compute')
    .requiredOption('--model <model>', 'Model id, e.g. gpt-4o-mini')
    .option('--skill <slug...>', 'Public skills to install')
    .option('--provider-key-env <name>', 'Environment variable holding the provider API key (default OPENAI_API_KEY etc.)')
    .option('--max-fee <amount>', 'Most you will pay, in USDC', '1')
    .option('--yes', 'Pay without asking')
    .action(async (opts: { name: string; instructions?: string; instructionsFile?: string; provider: string; model: string; skill?: string[]; providerKeyEnv?: string; maxFee: string; yes?: boolean }) => {
      const provider = opts.provider as 'openai' | 'anthropic' | 'groq' | 'gemini' | '0g-compute';
      if (!['openai', 'anthropic', 'groq', 'gemini', '0g-compute'].includes(provider)) {
        throw new CliError('BAD_PROVIDER', `--provider must be one of openai, anthropic, groq, gemini, 0g-compute; got ${opts.provider}.`);
      }
      // The provider key is read from the environment, never from argv: argv
      // lands in shell history and process lists.
      let apiKey = '';
      if (provider !== '0g-compute') {
        const envName = opts.providerKeyEnv ?? PROVIDER_KEY_ENV[provider];
        apiKey = process.env[envName] ?? '';
        if (!apiKey) throw new CliError('PROVIDER_KEY_MISSING', `Set ${envName}: the agent calls ${provider} with it.`);
      }
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
      // A payment is saved for the chain id it was made on.
      const feeChainId = terms.required ? terms.chainId : undefined;
      const saved = pendingFee(cfg.apiBase, signer.address, feeChainId);
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
          { payFee: true, maxFeeRaw, onFeePaid: (hash) => setPendingFee(cfg.apiBase, signer.address, feeChainId, hash) },
        ));
      } catch (e) {
        // A payment that can never pay for a deploy is forgotten, so the next attempt pays anew.
        const err = e as ApiError;
        const spent = ['DEPLOY_FEE_ALREADY_USED', 'DEPLOY_FEE_REVERTED'].includes(err.code ?? '')
          || (err.code === 'DEPLOY_FEE_NOT_PAID' && err.reason !== 'PAYER_NOT_LINKED');
        if (spent) setPendingFee(cfg.apiBase, signer.address, feeChainId, null);
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
    .option('--verification <mode>', 'auto (checked against criteria) or manual (you approve with `blind review`)', 'auto')
    .option('--yes', 'Fund without asking')
    .action(async (opts: {
      instructions?: string; instructionsFile?: string; reward?: string; amount?: string; token?: string;
      zone: string; duration: string; public?: boolean; capabilities?: string; target?: string; verification: string; yes?: boolean;
    }) => {
      const instructions = instructionsFrom(opts);
      if (opts.target && !/^0x[0-9a-fA-F]{40}$/.test(opts.target)) throw new CliError('BAD_TARGET', '--target must be a 0x wallet address.');
      if (!!opts.reward === !!opts.amount) throw new CliError('AMOUNT_REQUIRED', 'Pass exactly one of --reward <amount> or --amount <raw>.');
      if (opts.verification !== 'auto' && opts.verification !== 'manual') throw new CliError('BAD_VERIFICATION', '--verification must be auto or manual.');
      if (!/^\d+$/.test(opts.duration)) throw new CliError('INVALID_DURATION', '--duration must be a whole number of seconds.');

      const { bb, signer, postingChain, chains } = await signingClient();
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
      const privacy = opts.public ? 'public' : 'private';
      const human = formatUnits(amountRaw, entry.token.decimals);
      await confirm(
        `Post a ${privacy} task on ${postingChain}, locking ${human} ${entry.token.symbol} in escrow from ${signer.address} (plus gas)?`,
        opts.yes,
      );
      let task;
      try {
        task = await step('Posting…', () => bb.postTask(
          {
            instructions,
            amountRaw,
            durationSeconds: Number(opts.duration),
            privacy,
            verificationMode: opts.verification as 'auto' | 'manual',
            requiredCapabilities: list(opts.capabilities) as AgentCapability[],
            ...(opts.target ? { targetExecutor: opts.target as `0x${string}` } : {}),
            locationZone: opts.zone,
          },
          { onFunded: ({ taskHash, indexParams }) => setPendingPost(taskHash, { ...indexParams }) },
        ));
      } catch (e) {
        const err = e as ApiError;
        if (err.txHash) {
          out(`The escrow is funded (${err.txHash}) but the task is not listed yet. Run \`blind finish-posts\` to list it (nothing is paid again), or \`blind cancel\` it.`);
        }
        throw e;
      }
      setPendingPost(task.taskHash, null);
      out(`Posted ${privacy} task on ${task.chain}`);
      out(`  task hash: ${task.taskHash}`);
      if (task.taskId) out(`  task id:   ${task.taskId}`);
      out(`  escrow:    ${human} ${entry.token.symbol} (tx ${task.txHash})`);
      if (privacy === 'private') out(`  readable by ${task.wrappedTo} executor(s)`);
      out(`Check on it with: blind status --task ${task.taskHash}`);
    });

  program
    .command('finish-posts')
    .description('List tasks whose escrow was funded but whose listing did not finish')
    .action(async () => {
      const pending = Object.entries(pendingPosts());
      if (pending.length === 0) { out('Nothing to finish.'); return; }
      const { bb } = client();
      let failed = 0;
      for (const [taskHash, params] of pending) {
        try {
          const res = await step(`Listing ${taskHash}…`, () => bb.indexTask(params as never));
          setPendingPost(taskHash, null);
          out(`Listed ${taskHash}${res.onChainTaskId ? ` (task id ${res.onChainTaskId})` : ''}.`);
        } catch (e) {
          failed++;
          out(`Could not list ${taskHash}: ${(e as Error).message}`);
        }
      }
      if (failed) throw new CliError('NOT_FINISHED', `${failed} task(s) are still funded but unlisted: run this again, or \`blind cancel\` them for a refund.`);
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
      out(res.outcome === 'escalate'
        ? `Sent task ${ref.id} on ${res.chain} for review (tx ${res.txHash}). Its work was delivered before the deadline and never judged, so nothing was refunded: an admin rules on it, and with no ruling within 14 days the worker is paid.`
        : `Reclaimed the escrow of task ${ref.id} on ${res.chain} (tx ${res.txHash}). ${listing(res.listingClosed)}`);
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
