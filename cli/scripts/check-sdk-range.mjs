// Publish guard, run by prepublishOnly. This CLI calls SDK methods that first
// shipped in @blindmarket/sdk 0.7.0 (postTask, deployAgent's payFee,
// reviewResult), reads RefundResult.outcome, new in 0.8.0, `post-tasks` /
// `finish-posts` call postTasks and indexTasks, new in 0.9.0, and
// `deploy-agent --count` calls deployAgents and imports its types, new in
// 0.10.0. CI builds against the local sdk, which hid a range left behind:
// the build failed against the published SDK. So a range that allows an
// older SDK is refused, and so is one no published SDK matches yet: a CLI
// published before its SDK cannot be installed. Raise MIN_MINOR with the
// range (`npm i @blindmarket/sdk@^0.X.0`) once 0.X is on npm.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIN_MINOR = 10;

/** Why the CLI cannot be published with this SDK range, or null. */
export function rangeProblem(range, minMinor = MIN_MINOR) {
  const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (m && (Number(m[1]) > 0 || Number(m[2]) >= minMinor)) return null;
  return `@blindmarket/cli needs "@blindmarket/sdk": "^0.${minMinor}.0" or later to publish; package.json has "${range}".`;
}

/** Whether npm has a published SDK in `range`. npm view exits non-zero when none matches. */
function published(range) {
  try {
    return execFileSync('npm', ['view', `@blindmarket/sdk@${range}`, 'version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32',
    }).trim() !== '';
  } catch {
    return false;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
  const range = pkg.dependencies?.['@blindmarket/sdk'] ?? '';
  const problem = rangeProblem(range)
    ?? (published(range) ? null : `npm has no published @blindmarket/sdk matching "${range}" (or could not be asked), so this CLI could not be installed.`);
  if (problem) {
    console.error(problem);
    console.error(`Publish @blindmarket/sdk 0.${MIN_MINOR}.0 first, then run \`npm i @blindmarket/sdk@^0.${MIN_MINOR}.0\` here and commit the lockfile.`);
    process.exit(1);
  }
}
