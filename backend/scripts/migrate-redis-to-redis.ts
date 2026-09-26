/**
 * migrate-redis-to-redis.ts
 *
 * Online Redis → Redis migration.
 *
 * Scans every key on the source Redis, DUMP/RESTOREs it into the target,
 * preserving TTLs. Safe to run against a live source; the source is only
 * read. The target is written to with RESTORE, which will fail if a key
 * already exists unless --overwrite is passed.
 *
 * Usage:
 *   npx tsx scripts/migrate-redis-to-redis.ts --from <OLD_REDIS_URL> --to <NEW_REDIS_URL>
 *
 * Env alternatives:
 *   OLD_REDIS_URL=redis://old:6379 NEW_REDIS_URL=redis://new:6379 npx tsx scripts/migrate-redis-to-redis.ts
 *
 * Flags:
 *   --from <url>     Source Redis URL (defaults to OLD_REDIS_URL)
 *   --to <url>       Target Redis URL (defaults to NEW_REDIS_URL)
 *   --overwrite      Replace keys that already exist on the target
 *   --dry-run        Count keys but do not write anything
 *   --batch <n>      Pipeline batch size for RESTORE (default 50)
 *   --verbose        Log every key as it is copied
 */

import Redis from 'ioredis';

interface Options {
  from: string;
  to: string;
  overwrite: boolean;
  dryRun: boolean;
  batch: number;
  verbose: boolean;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };
  const hasFlag = (flag: string): boolean => args.includes(flag);

  const from = getArg('--from') ?? process.env.OLD_REDIS_URL;
  const to = getArg('--to') ?? process.env.NEW_REDIS_URL;
  const batchRaw = getArg('--batch') ?? '50';
  const batch = Number(batchRaw);

  if (!from || !to) {
    console.error(`
Usage:
  npx tsx scripts/migrate-redis-to-redis.ts --from <OLD_REDIS_URL> --to <NEW_REDIS_URL>

Environment:
  OLD_REDIS_URL   URL of the source Redis instance
  NEW_REDIS_URL   URL of the target Redis instance (your new Docker/VPS Redis)
`);
    process.exit(1);
  }

  return {
    from,
    to,
    overwrite: hasFlag('--overwrite'),
    dryRun: hasFlag('--dry-run'),
    batch: Number.isFinite(batch) && batch > 0 ? batch : 50,
    verbose: hasFlag('--verbose'),
  };
}

function createClient(url: string, label: string): Redis {
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    connectTimeout: 10_000,
    commandTimeout: 30_000,
    retryStrategy: (times: number) => Math.min(200 * times, 2_000),
  });
  client.on('error', (err: Error) => console.error(`[${label}] Redis error:`, err.message));
  return client;
}

async function exists(client: Redis, key: string): Promise<boolean> {
  return (await client.exists(key)) === 1;
}

async function scanKeys(client: Redis): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await client.scan(cursor, 'COUNT', 1000);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

async function migrateKey(
  source: Redis,
  target: Redis,
  key: string,
  opts: Pick<Options, 'overwrite' | 'dryRun'>,
): Promise<{ status: 'copied' | 'skipped' | 'error'; error?: string }> {
  try {
    const hasKey = await exists(target, key);
    if (hasKey && !opts.overwrite && !opts.dryRun) {
      return { status: 'skipped' };
    }

    const [dumped, pttlRaw] = await Promise.all([
      source.dump(key),
      source.pttl(key),
    ]);

    if (dumped === null) {
      return { status: 'skipped' };
    }

    const pttl = pttlRaw > 0 ? pttlRaw : 0;

    if (opts.dryRun) {
      return { status: 'copied' };
    }

    if (hasKey && opts.overwrite) {
      await target.del(key);
    }

    // RESTORE with TTL=0 means the key has no expiry.
    // ABSTTL is not used because pttl is a relative duration.
    await target.restore(key, pttl, dumped);
    return { status: 'copied' };
  } catch (err) {
    return { status: 'error', error: (err as Error).message };
  }
}

async function main() {
  const opts = parseArgs();

  console.log(`Source : ${opts.from}`);
  console.log(`Target : ${opts.to}`);
  console.log(`Mode   : ${opts.dryRun ? 'dry-run' : opts.overwrite ? 'overwrite' : 'skip-existing'}`);
  console.log('---');

  const source = createClient(opts.from, 'source');
  const target = createClient(opts.to, 'target');

  try {
    await source.connect();
    await target.connect();

    const sourceInfo = await source.info('server');
    const targetInfo = await target.info('server');
    const sourceVersion = sourceInfo.match(/redis_version:(.+)/)?.[1]?.trim();
    const targetVersion = targetInfo.match(/redis_version:(.+)/)?.[1]?.trim();
    console.log(`Source Redis version: ${sourceVersion ?? 'unknown'}`);
    console.log(`Target Redis version: ${targetVersion ?? 'unknown'}`);

    console.log('Scanning source keys...');
    const keys = await scanKeys(source);
    console.log(`Found ${keys.length} keys`);

    if (keys.length === 0) {
      console.log('Nothing to migrate.');
      return;
    }

    let copied = 0;
    let skipped = 0;
    let errors = 0;
    const failedKeys: string[] = [];

    for (let i = 0; i < keys.length; i += opts.batch) {
      const batch = keys.slice(i, i + opts.batch);
      const results = await Promise.all(
        batch.map(async (key) => {
          const result = await migrateKey(source, target, key, opts);
          return { key, result };
        }),
      );

      for (const { key, result } of results) {
        if (result.status === 'copied') {
          copied++;
          if (opts.verbose) console.log(`copied   ${key}`);
        } else if (result.status === 'skipped') {
          skipped++;
          if (opts.verbose) console.log(`skipped  ${key}`);
        } else {
          errors++;
          failedKeys.push(key);
          if (opts.verbose) console.error(`error    ${key}: ${result.error}`);
        }
      }

      if ((i / opts.batch) % 10 === 0) {
        console.log(`progress: ${Math.min(i + opts.batch, keys.length)}/${keys.length}`);
      }
    }

    console.log('---');
    console.log(`Copied : ${copied}`);
    console.log(`Skipped: ${skipped}`);
    console.log(`Errors : ${errors}`);

    if (failedKeys.length > 0) {
      console.log('Failed keys (first 20):');
      for (const key of failedKeys.slice(0, 20)) {
        console.log(`  ${key}`);
      }
      process.exitCode = 1;
    }
  } finally {
    source.disconnect();
    target.disconnect();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
