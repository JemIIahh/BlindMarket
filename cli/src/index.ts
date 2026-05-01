#!/usr/bin/env node
import { Command } from 'commander';
import { Wallet } from 'ethers';
import ora from 'ora';
import { loadConfig, saveConfig } from './config.js';
import { api } from './api.js';

const program = new Command();

program
  .name('blind')
  .description('BlindBounty CLI — hire humans from the command line')
  .version('0.1.0');

// ── register ──────────────────────────────────────────────────────────────────

program
  .command('register')
  .description('Register this agent with BlindBounty (device flow)')
  .requiredOption('--name <name>', 'Agent name')
  .option('--api-base <url>', 'API base URL', 'http://localhost:3001')
  .action(async (opts: { name: string; apiBase: string }) => {
    const cfg = loadConfig();
    cfg.apiBase = opts.apiBase;
    saveConfig(cfg);

    // Generate agent wallet
    const wallet = Wallet.createRandom();
    const spin = ora('Creating registration session…').start();

    try {
      const { token, url } = await api.post<{ token: string; url: string }>(
        '/api/v1/registration/session',
        { agentName: opts.name, agentWallet: wallet.address, agentPublicKey: wallet.publicKey },
      );
      spin.stop();

      console.log('\n  Open this URL in your browser and sign with your wallet:\n');
      console.log(`  ${url}\n`);

      // Poll until confirmed
      const polling = ora('Waiting for wallet signature…').start();
      let apiKey: string | undefined;
      for (let i = 0; i < 120; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const { status, apiKey: key } = await api.get<{ status: string; apiKey?: string }>(
          `/api/v1/registration/session/${token}`,
        );
        if (status === 'confirmed' && key) { apiKey = key; break; }
      }
      polling.stop();

      if (!apiKey) { console.error('  Timed out waiting for signature.'); process.exit(1); }

      saveConfig({ ...cfg, apiKey, agentWallet: wallet.address, agentName: opts.name });
      console.log(`  ✓ Registered as "${opts.name}"`);
      console.log(`  agent wallet: ${wallet.address}`);
      console.log(`  config saved to ~/.blind/config.json\n`);
    } catch (e) {
      spin.fail((e as Error).message);
      process.exit(1);
    }
  });

// ── post-task ─────────────────────────────────────────────────────────────────

program
  .command('post-task')
  .description('Post a new encrypted task')
  .requiredOption('--instructions <text>', 'Task instructions (will be encrypted)')
  .requiredOption('--category <cat>', 'Category (e.g. photography, research, verification)')
  .requiredOption('--amount <wei>', 'Payment amount in wei')
  .requiredOption('--token <address>', 'ERC-20 token address for payment')
  .option('--zone <zone>', 'Location zone', 'global')
  .option('--duration <seconds>', 'Task duration in seconds', '86400')
  .action(async (opts: { instructions: string; category: string; amount: string; token: string; zone: string; duration: string }) => {
    const cfg = loadConfig();
    if (!cfg.apiKey) { console.error('Not registered. Run: blind register --name <name>'); process.exit(1); }

    const spin = ora('Encrypting and posting task…').start();
    try {
      // Encrypt instructions (AES-256-GCM via Web Crypto — use Node crypto here)
      const { createCipheriv, randomBytes, createHash } = await import('crypto');
      const key = randomBytes(32);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(opts.instructions, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      const blob = Buffer.concat([iv, tag, encrypted]).toString('base64');

      // Upload to storage
      const { rootHash } = await api.post<{ rootHash: string }>('/api/v1/storage/upload', { data: blob }, cfg.apiKey);

      // taskHash = SHA-256 of ciphertext
      const taskHash = '0x' + createHash('sha256').update(Buffer.concat([iv, tag, encrypted])).digest('hex');

      // Build unsigned tx
      const { unsignedTx } = await api.post<{ unsignedTx: object }>(
        '/api/v1/tasks',
        { taskHash, token: opts.token, amount: opts.amount, category: opts.category, locationZone: opts.zone, duration: opts.duration },
        cfg.apiKey,
      );

      spin.succeed('Task created');
      console.log(`  storage root: ${rootHash}`);
      console.log(`  task hash:    ${taskHash}`);
      console.log(`  unsigned tx:  sign and broadcast with your agent wallet to lock escrow`);
      console.log(JSON.stringify(unsignedTx, null, 2));
    } catch (e) {
      spin.fail((e as Error).message);
      process.exit(1);
    }
  });

// ── tasks ─────────────────────────────────────────────────────────────────────

program
  .command('tasks')
  .description('List open tasks')
  .option('--limit <n>', 'Max results', '20')
  .action(async (opts: { limit: string }) => {
    const cfg = loadConfig();
    const spin = ora('Fetching tasks…').start();
    try {
      const { tasks, total } = await api.get<{ tasks: Array<{ taskId: string; category: string; locationZone: string; reward: string; agent: string }>; total: number }>(
        `/api/v1/tasks?limit=${opts.limit}`,
      );
      spin.stop();
      console.log(`\n  ${total} open tasks\n`);
      for (const t of tasks) {
        const reward = (BigInt(t.reward) / 10n ** 18n).toString();
        console.log(`  #${t.taskId}  ${t.category.padEnd(20)} ${t.locationZone.padEnd(12)} ${reward} tokens`);
      }
      console.log('');
    } catch (e) {
      spin.fail((e as Error).message);
      process.exit(1);
    }
  });

// ── assign ────────────────────────────────────────────────────────────────────

program
  .command('assign')
  .description('Assign a worker to a task')
  .requiredOption('--task <id>', 'Task ID')
  .requiredOption('--worker <address>', 'Worker wallet address')
  .action(async (opts: { task: string; worker: string }) => {
    const cfg = loadConfig();
    if (!cfg.apiKey) { console.error('Not registered. Run: blind register --name <name>'); process.exit(1); }

    const spin = ora(`Assigning ${opts.worker} to task #${opts.task}…`).start();
    try {
      const { unsignedTx } = await api.post<{ unsignedTx: object }>(
        `/api/v1/tasks/${opts.task}/assign`,
        { worker: opts.worker },
        cfg.apiKey,
      );
      spin.succeed('Assignment tx ready — sign and broadcast:');
      console.log(JSON.stringify(unsignedTx, null, 2));
    } catch (e) {
      spin.fail((e as Error).message);
      process.exit(1);
    }
  });

// ── verify ────────────────────────────────────────────────────────────────────

program
  .command('verify')
  .description('Trigger TEE verification for a task')
  .requiredOption('--task <id>', 'Task ID')
  .requiredOption('--requirements <text>', 'What the worker was asked to do')
  .requiredOption('--evidence <text>', 'Summary of submitted evidence')
  .option('--category <cat>', 'Task category', 'general')
  .action(async (opts: { task: string; requirements: string; evidence: string; category: string }) => {
    const cfg = loadConfig();
    if (!cfg.apiKey) { console.error('Not registered. Run: blind register --name <name>'); process.exit(1); }

    const spin = ora('Triggering TEE verification…').start();
    try {
      const result = await api.post<{ passed: boolean; confidence: number; reasoning: string }>(
        '/api/v1/verification/trigger',
        { taskId: parseInt(opts.task), taskCategory: opts.category, taskRequirements: opts.requirements, evidenceSummary: opts.evidence },
        cfg.apiKey,
      );
      spin.stop();
      const icon = result.passed ? '✓' : '✗';
      console.log(`\n  ${icon} ${result.passed ? 'PASSED' : 'FAILED'} (${(result.confidence * 100).toFixed(1)}% confidence)`);
      if (result.reasoning) console.log(`  ${result.reasoning}\n`);
    } catch (e) {
      spin.fail((e as Error).message);
      process.exit(1);
    }
  });

// ── status ────────────────────────────────────────────────────────────────────

program
  .command('status')
  .description('Check task status')
  .requiredOption('--task <id>', 'Task ID')
  .action(async (opts: { task: string }) => {
    const cfg = loadConfig();
    const spin = ora(`Fetching task #${opts.task}…`).start();
    try {
      const task = await api.get<{ status: number; agent: string; worker: string; amount: string; evidenceHash: string }>(
        `/api/v1/tasks/${opts.task}`,
        cfg.apiKey,
      );
      spin.stop();
      const STATUS = ['Funded', 'Assigned', 'Submitted', 'Verified', 'Completed', 'Cancelled', 'Disputed'];
      console.log(`\n  task #${opts.task}`);
      console.log(`  status:   ${STATUS[task.status] ?? task.status}`);
      console.log(`  agent:    ${task.agent}`);
      console.log(`  worker:   ${task.worker || '(unassigned)'}`);
      console.log(`  amount:   ${(BigInt(task.amount) / 10n ** 18n).toString()} tokens`);
      if (task.evidenceHash && task.evidenceHash !== '0x' + '0'.repeat(64)) {
        console.log(`  evidence: ${task.evidenceHash}`);
      }
      console.log('');
    } catch (e) {
      spin.fail((e as Error).message);
      process.exit(1);
    }
  });

// ── validator ─────────────────────────────────────────────────────────────────

const validator = program.command('validator').description('Validator pool commands');

validator
  .command('stake')
  .description('Stake tokens to become a validator')
  .option('--amount <tokens>', 'Amount to stake (in tokens, min 100)', '100')
  .action(async (opts: { amount: string }) => {
    const cfg = loadConfig();
    if (!cfg.apiKey) { console.error('Not registered. Run: blind register --name <name>'); process.exit(1); }
    const spin = ora(`Staking ${opts.amount} tokens…`).start();
    try {
      const amount = (BigInt(opts.amount) * 10n ** 18n).toString();
      const { unsignedTx } = await api.post<{ unsignedTx: object }>('/api/v1/validators/register', { amount }, cfg.apiKey);
      spin.succeed('Stake tx ready — sign and broadcast:');
      console.log(JSON.stringify(unsignedTx, null, 2));
    } catch (e) { spin.fail((e as Error).message); process.exit(1); }
  });

validator
  .command('unstake')
  .description('Withdraw your stake')
  .action(async () => {
    const cfg = loadConfig();
    if (!cfg.apiKey) { console.error('Not registered.'); process.exit(1); }
    const spin = ora('Building unstake tx…').start();
    try {
      const { unsignedTx } = await api.post<{ unsignedTx: object }>('/api/v1/validators/unstake', {}, cfg.apiKey);
      spin.succeed('Unstake tx ready:');
      console.log(JSON.stringify(unsignedTx, null, 2));
    } catch (e) { spin.fail((e as Error).message); process.exit(1); }
  });

validator
  .command('vote')
  .description('Vote on a dispute')
  .requiredOption('--dispute <id>', 'Dispute ID')
  .requiredOption('--for <side>', 'worker or agent')
  .action(async (opts: { dispute: string; for: string }) => {
    const cfg = loadConfig();
    if (!cfg.apiKey) { console.error('Not registered.'); process.exit(1); }
    const vote = opts.for === 'worker' ? 1 : opts.for === 'agent' ? 2 : null;
    if (!vote) { console.error('--for must be "worker" or "agent"'); process.exit(1); }
    const spin = ora(`Voting ${opts.for} on dispute #${opts.dispute}…`).start();
    try {
      const { unsignedTx } = await api.post<{ unsignedTx: object }>('/api/v1/validators/vote', { disputeId: opts.dispute, vote }, cfg.apiKey);
      spin.succeed('Vote tx ready:');
      console.log(JSON.stringify(unsignedTx, null, 2));
    } catch (e) { spin.fail((e as Error).message); process.exit(1); }
  });

validator
  .command('finalize')
  .description('Finalize a dispute after the 48h vote window')
  .requiredOption('--dispute <id>', 'Dispute ID')
  .action(async (opts: { dispute: string }) => {
    const cfg = loadConfig();
    if (!cfg.apiKey) { console.error('Not registered.'); process.exit(1); }
    const spin = ora(`Finalizing dispute #${opts.dispute}…`).start();
    try {
      const { unsignedTx } = await api.post<{ unsignedTx: object }>('/api/v1/validators/finalize', { disputeId: opts.dispute }, cfg.apiKey);
      spin.succeed('Finalize tx ready:');
      console.log(JSON.stringify(unsignedTx, null, 2));
    } catch (e) { spin.fail((e as Error).message); process.exit(1); }
  });

validator
  .command('run')
  .description('Run validator daemon — watches for disputes and auto-votes')
  .option('--rpc <url>', 'RPC URL', 'https://evmrpc-testnet.0g.ai')
  .option('--pool <address>', 'ValidatorPool contract address')
  .action(async (opts: { rpc: string; pool?: string }) => {
    const cfg = loadConfig();
    if (!cfg.apiKey || !cfg.agentWallet) {
      console.error('Not registered. Run: blind register --name <name>');
      process.exit(1);
    }

    const poolAddress = opts.pool || process.env.VALIDATOR_POOL_ADDRESS;
    if (!poolAddress) {
      console.error('ValidatorPool address required: --pool <address> or VALIDATOR_POOL_ADDRESS env var');
      process.exit(1);
    }

    const { ethers } = await import('ethers');
    const provider = new ethers.JsonRpcProvider(opts.rpc);
    const POOL_ABI = [
      'event DisputeOpened(uint256 indexed disputeId, uint256 indexed taskId, address escrow)',
      'function vote(uint256 disputeId, uint8 vote) external',
      'function finalizeDispute(uint256 disputeId) external',
      'function getDispute(uint256 disputeId) external view returns (uint256 taskId, address escrow, uint256 amount, uint256 openedAt, bool finalized, bool workerFavored, uint256 workerVotes, uint256 agentVotes)',
      'function getVote(uint256 disputeId, address validator) external view returns (uint8)',
    ];
    const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);

    const VOTE_WINDOW_MS = 48 * 60 * 60 * 1000;
    const pendingFinalize = new Map<string, number>(); // disputeId → finalizeAt

    console.log(`\n  blind validator daemon`);
    console.log(`  wallet:  ${cfg.agentWallet}`);
    console.log(`  pool:    ${poolAddress}`);
    console.log(`  rpc:     ${opts.rpc}`);
    console.log(`  listening for DisputeOpened events...\n`);

    const handleDispute = async (disputeId: bigint, taskId: bigint) => {
      const dId = disputeId.toString();
      console.log(`  [${new Date().toISOString()}] DisputeOpened #${dId} (task #${taskId})`);

      // Check if already voted
      const existingVote = await pool.getVote(dId, cfg.agentWallet).catch(() => 0);
      if (Number(existingVote) !== 0) {
        console.log(`  already voted on #${dId}, skipping`);
        return;
      }

      // Ask TEE to evaluate
      const result = await api.post<{ passed: boolean; confidence: number }>(
        '/api/v1/verification/trigger',
        {
          taskId: Number(taskId),
          taskCategory: 'general',
          taskRequirements: 'Evidence must demonstrate task completion',
          evidenceSummary: `Dispute #${dId} on task #${taskId}`,
        },
        cfg.apiKey,
      ).catch(() => null);

      const vote = result?.passed !== false ? 1 : 2; // default worker-favored if TEE unavailable
      console.log(`  voting ${vote === 1 ? 'worker' : 'agent'} (confidence: ${result ? (result.confidence * 100).toFixed(0) : '?'}%)`);

      const { unsignedTx } = await api.post<{ unsignedTx: object }>(
        '/api/v1/validators/vote',
        { disputeId: dId, vote },
        cfg.apiKey,
      );
      console.log(`  vote tx (sign + broadcast): ${JSON.stringify(unsignedTx)}\n`);

      // Schedule finalize
      const dispute = await pool.getDispute(dId);
      const finalizeAt = Number(dispute.openedAt) * 1000 + VOTE_WINDOW_MS + 60_000;
      pendingFinalize.set(dId, finalizeAt);
    };

    // Subscribe to on-chain events
    pool.on('DisputeOpened', (disputeId: bigint, taskId: bigint) => {
      handleDispute(disputeId, taskId).catch(e =>
        console.error(`  [error] ${(e as Error).message}`)
      );
    });

    // Check finalize queue every minute
    setInterval(async () => {
      const now = Date.now();
      for (const [dId, finalizeAt] of pendingFinalize) {
        if (now >= finalizeAt) {
          console.log(`  [${new Date().toISOString()}] finalizing dispute #${dId}`);
          const { unsignedTx } = await api.post<{ unsignedTx: object }>(
            '/api/v1/validators/finalize',
            { disputeId: dId },
            cfg.apiKey,
          ).catch(e => { console.error(`  finalize error: ${(e as Error).message}`); return { unsignedTx: null }; });
          if (unsignedTx) console.log(`  finalize tx: ${JSON.stringify(unsignedTx)}\n`);
          pendingFinalize.delete(dId);
        }
      }
    }, 60_000);

    console.log('  daemon running. press ctrl+c to stop.\n');
    // Keep process alive
    await new Promise(() => {});
  });

validator
  .command('info')
  .description('Check your validator status')
  .action(async () => {
    const cfg = loadConfig();
    if (!cfg.agentWallet) { console.error('Not registered.'); process.exit(1); }
    const spin = ora('Fetching validator info…').start();
    try {
      const info = await api.get<{ stake: string; active: boolean; totalVotes: number; correctVotes: number }>(
        `/api/v1/validators/${cfg.agentWallet}`,
      );
      spin.stop();
      console.log(`\n  wallet:        ${cfg.agentWallet}`);
      console.log(`  active:        ${info.active}`);
      console.log(`  stake:         ${(BigInt(info.stake) / 10n ** 18n).toString()} tokens`);
      console.log(`  total_votes:   ${info.totalVotes}`);
      console.log(`  correct_votes: ${info.correctVotes}`);
      console.log(`  accuracy:      ${info.totalVotes > 0 ? ((info.correctVotes / info.totalVotes) * 100).toFixed(0) : '—'}%\n`);
    } catch (e) { spin.fail((e as Error).message); process.exit(1); }
  });

program.parse();
