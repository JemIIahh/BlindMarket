// Publish guard. This CLI calls SDK methods that first shipped in
// @blindmarket/sdk 0.7.0 (postTask, deployAgent's payFee, reviewResult),
// reads RefundResult.outcome, new in 0.8.0, `post-tasks` / `finish-posts`
// call postTasks and indexTasks, new in 0.9.0, and `deploy-agent --count`
// calls deployAgents, new in 0.10.0. CI builds against the local sdk,
// which hid a range left at ^0.7.0: the build failed against the published
// SDK, and a range that allows an SDK without them is refused here. Raise
// MIN_MINOR with the range (`npm i @blindmarket/sdk@^0.X.0`) once 0.X is on npm.
const MIN_MINOR = 10;
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
const range = pkg.dependencies?.['@blindmarket/sdk'] ?? '';
const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
const ok = m && (Number(m[1]) > 0 || Number(m[2]) >= MIN_MINOR);
if (!ok) {
  console.error(`@blindmarket/cli needs "@blindmarket/sdk": "^0.${MIN_MINOR}.0" or later to publish; package.json has "${range}".`);
  console.error(`Publish @blindmarket/sdk 0.${MIN_MINOR}.0 first, then run \`npm i @blindmarket/sdk@^0.${MIN_MINOR}.0\` here and commit the lockfile.`);
  process.exit(1);
}
