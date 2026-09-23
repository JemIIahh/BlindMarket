// Publish guard. This CLI calls SDK methods that first shipped in
// @blindmarket/sdk 0.7.0 (postTask, deployAgent's payFee, reviewResult). The
// dependency stays at the published ^0.6 range in the repo so `npm ci` works
// before 0.7.0 is on npm (CI overrides it with the local sdk). Publishing with
// that range would install an SDK without those methods, so it is refused
// here until the range is bumped: `npm i @blindmarket/sdk@^0.7.0`, once 0.7.0
// is on npm.
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
const range = pkg.dependencies?.['@blindmarket/sdk'] ?? '';
const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
const ok = m && (Number(m[1]) > 0 || Number(m[2]) >= 7);
if (!ok) {
  console.error(`@blindmarket/cli needs "@blindmarket/sdk": "^0.7.0" or later to publish; package.json has "${range}".`);
  console.error('Publish @blindmarket/sdk 0.7.0 first, then run `npm i @blindmarket/sdk@^0.7.0` here and commit the lockfile.');
  process.exit(1);
}
