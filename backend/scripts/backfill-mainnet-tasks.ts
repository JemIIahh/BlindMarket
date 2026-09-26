import 'dotenv/config';
import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Redis } from 'ioredis';

const __dirname = dirname(fileURLToPath(import.meta.url));

const RPC = process.env.OG_RPC_URL ?? 'https://0g-rpc.publicnode.com';
const CHAIN_ID = Number(process.env.OG_CHAIN_ID ?? 16661);
const ESCROW = process.env.BLIND_ESCROW_ADDRESS ?? '0x3d0374963DaaD43e31d42373eb11156A8e8ce2Ff';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const DEPLOYMENT_BLOCK = Number(process.env.ESCROW_DEPLOYMENT_BLOCK ?? 33_459_885);

async function main() {
  console.log(`RPC:       ${RPC}`);
  console.log(`Chain ID:  ${CHAIN_ID}`);
  console.log(`Escrow:    ${ESCROW}`);
  console.log(`Redis:     ${REDIS_URL.replace(/:[^:@]+@/, ':****@')}`);
  console.log(`Deploy:    block ${DEPLOYMENT_BLOCK}`);
  console.log('');

  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID, {
    batchMaxCount: 1,
    staticNetwork: true,
  });
  const abi = JSON.parse(
    readFileSync(join(__dirname, '..', 'src', 'abi', 'BlindEscrow.json'), 'utf-8'),
  ) as ethers.InterfaceAbi;
  const escrow = new ethers.Contract(ESCROW, abi, provider);

  const latest = await provider.getBlockNumber();
  console.log(`Current block: ${latest}`);
  console.log(`Range:         ${DEPLOYMENT_BLOCK}..${latest} (${latest - DEPLOYMENT_BLOCK} blocks)`);
  console.log('');

  const filter = escrow.filters.TaskCreated();
  const MAX_BLOCKS = 1000;

  const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetryAttempts: 3 });
  await redis.connect();

  let from = DEPLOYMENT_BLOCK;
  let total = 0;
  while (from <= latest) {
    const to = Math.min(latest, from + MAX_BLOCKS - 1);
    try {
      const events = await escrow.queryFilter(filter, from, to);
      if (events.length > 0) {
        const pipe = redis.pipeline();
        for (const ev of events) {
          const args = (ev as ethers.EventLog).args;
          if (!args) continue;
          const taskId = args.taskId as bigint | undefined;
          const taskHash = args.taskHash as string | undefined;
          if (taskId === undefined || !taskHash) continue;
          const hash = taskHash.toLowerCase();

          pipe.set(`a2a:hash2id:${hash}`, String(taskId));
          pipe.set(`a2a:id2hash:${String(taskId)}`, hash);
          // Create minimal meta + state so task appears in /a2a/tasks
          const meta = {
            taskId: hash,
            targetExecutorType: 'agent',
            verificationMode: 'auto',
            verificationCriteria: { min_length: 10 },
            requiredCapabilities: [],
            posterAddress: (args.agent as string).toLowerCase(),
            rootHash: '',
            wrappedKeys: {},
          };
          const state = {
            taskId: hash,
            status: 'open',
            assignee: null,
            resultData: null,
            createdAt: new Date().toISOString(),
          };
          pipe.set(`a2a:meta:${hash}`, JSON.stringify(meta));
          pipe.set(`a2a:state:${hash}`, JSON.stringify(state));
          pipe.sadd('a2a:open', hash);
          pipe.sadd(`a2a:poster:${(args.agent as string).toLowerCase()}`, hash);
          total++;
        }
        await pipe.exec();
        console.log(`  blocks ${from}..${to}: ${events.length} event(s)`);
      }
      from = to + 1;
    } catch (e) {
      console.error(`  blocks ${from}..${to} failed: ${(e as Error).message}; retrying in 2s`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  console.log('');
  console.log(`Backfill complete: ${total} tasks indexed`);
  await redis.quit();
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
