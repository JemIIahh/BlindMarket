// Generates the CLI and MCP-tool reference pages from the PUBLISHED packages, so
// they can't drift from what users install.
//
//   node scripts/generate-reference.mjs            # uses the versions pinned below
//   CLI_VERSION=0.7.0 MCP_VERSION=0.8.0 node scripts/generate-reference.mjs
//
// It writes developers/cli/commands.mdx and developers/mcp/tools.mdx. The prose
// for each command and tool lives in NOTES below: keep it short, and re-check it
// against the package whenever you bump a version.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_VERSION = process.env.CLI_VERSION ?? '0.6.0';
const MCP_VERSION = process.env.MCP_VERSION ?? '0.7.0';

const esc = (s) => String(s).replace(/[{}<>]/g, (c) => ({ '{': '&#123;', '}': '&#125;', '<': '&lt;', '>': '&gt;' })[c]);
const attr = (s) => String(s).replace(/"/g, '&quot;');

// ─── CLI ────────────────────────────────────────────────────────────────────

const CLI_GROUPS = [
  { title: 'Account', commands: ['login', 'whoami', 'register'] },
  { title: 'Post and manage tasks', commands: ['post-task', 'post-tasks', 'finish-posts', 'tasks', 'status', 'review', 'cancel', 'reclaim', 'verify'] },
  { title: 'Agents', commands: ['deploy-agent', 'register-executor'] },
];

const CLI_NOTES = {
  login: 'Signs the CLI in with an `sk_` API key. With `--import-key` it also stores the private key of the wallet that owns the API key, encrypted in `~/.blind/keystore.json`. That key signs every transaction. The CLI refuses a wallet key that doesn\'t belong to the API key\'s wallet.',
  whoami: 'Prints the wallet the CLI acts as, and where its signing key comes from: the keystore or `BLINDMARKET_PRIVATE_KEY`.',
  register: 'Registers a new agent wallet through a browser flow, where the API allows it. Most people should use `blind login` with an `sk_` key instead.',
  'post-task': 'Encrypts the brief (unless `--public`), uploads it, approves USDC to the escrow, funds the task, and lists it. Before sending anything, it shows the escrow, the chain, and the paying wallet, and asks you to confirm.',
  'post-tasks': 'Posts every row of a CSV or JSONL file. It checks every row first, asks once, and approves USDC once for the total. See [Post many tasks](/guides/post-many-tasks) for the file format and recovery.',
  'finish-posts': 'Lists tasks whose escrow was funded but whose listing didn\'t finish. It never pays again.',
  tasks: 'Lists open tasks on the market.',
  status: 'Shows one task: its status, its escrow, and the result once delivered.',
  review: 'Approves or rejects the result of a task you posted with `--verification manual`. A rejected agent can resubmit before the deadline.',
  cancel: 'Cancels a task nobody has accepted, and refunds the full reward to the wallet that funded it.',
  reclaim: 'Refunds a task whose deadline passed without a delivery. If the work was delivered and never judged, the task goes to review instead.',
  verify: 'Asks the platform\'s AI checker for an opinion on a submitted result. It doesn\'t settle the task: settlement follows the task\'s verification mode.',
  'deploy-agent': 'Deploys a hosted agent owned by your wallet. The model provider\'s API key is read from an environment variable, never from an argument. If a deploy fee applies, the command checks the request first, shows the fee, and asks before paying.',
  'register-executor': 'Registers your wallet as an agent that takes tasks, so posters can encrypt briefs to it. It costs nothing.',
};

// The published package's own source, for what --help doesn't show (required options).
let cliDist;
function cliProgramSource() {
  if (cliDist) return cliDist;
  const dir = mkdtempSync(join(tmpdir(), 'blind-cli-'));
  execFileSync('npm', ['pack', `@blindmarket/cli@${CLI_VERSION}`, '--pack-destination', dir], { stdio: 'ignore' });
  const tgz = readdirSync(dir).find((f) => f.endsWith('.tgz'));
  execFileSync('tar', ['-xzf', join(dir, tgz), '-C', dir]);
  cliDist = readFileSync(join(dir, 'package/dist/program.js'), 'utf8');
  return cliDist;
}

function requiredFlags(cmd) {
  const src = cliProgramSource();
  const start = src.indexOf(`.command('${cmd}'`);
  if (start < 0) return new Set();
  const next = src.indexOf('.command(', start + 1);
  const block = src.slice(start, next < 0 ? undefined : next);
  return new Set([...block.matchAll(/requiredOption\('(--[a-z-]+)/g)].map((m) => m[1]));
}

function cliCommandsInHelp() {
  const root = execFileSync('npx', ['-y', `@blindmarket/cli@${CLI_VERSION}`, '--help'], { encoding: 'utf8' });
  const section = root.slice(root.indexOf('Commands:'));
  return [...section.matchAll(/^ {2}([a-z][a-z-]*)/gm)].map((m) => m[1]).filter((c) => c !== 'help');
}

function cliHelp(args) {
  return execFileSync('npx', ['-y', `@blindmarket/cli@${CLI_VERSION}`, ...args, '--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function parseOptions(help) {
  const lines = help.split('\n');
  const start = lines.findIndex((l) => l.trim() === 'Options:');
  if (start < 0) return [];
  const opts = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    const m = line.match(/^ {2}(-\S.*?)(?: {2,}(.*))?$/);
    if (m) {
      opts.push({ flag: m[1].trim(), desc: (m[2] ?? '').trim() });
    } else if (opts.length) {
      opts[opts.length - 1].desc += ' ' + line.trim();
    }
  }
  return opts.filter((o) => !o.flag.startsWith('-h'));
}

function cliPage() {
  const listed = new Set(CLI_GROUPS.flatMap((g) => g.commands));
  const missing = cliCommandsInHelp().filter((c) => !listed.has(c));
  if (missing.length) throw new Error(`CLI commands not placed in a group: ${missing.join(', ')}. Add them to CLI_GROUPS and CLI_NOTES.`);
  const out = [];
  out.push('---');
  out.push('title: "CLI command reference"');
  out.push('sidebarTitle: "Command reference"');
  out.push(`description: "Every command and flag in @blindmarket/cli ${CLI_VERSION}."`);
  out.push('---');
  out.push('');
  out.push(`{/* Generated by docs-site/scripts/generate-reference.mjs from \`npx @blindmarket/cli@${CLI_VERSION} <command> --help\`. Don't edit by hand: change NOTES in the script and re-run it. */}`);
  out.push('');
  out.push(`This page lists every command in \`@blindmarket/cli\` ${CLI_VERSION}, generated from the package's own help. For setup and sign-in, see the [CLI overview](/developers/cli/overview).`);
  out.push('');
  out.push('```bash');
  out.push('npm install -g @blindmarket/cli');
  out.push('blind --version');
  out.push('```');
  for (const group of CLI_GROUPS) {
    out.push('');
    out.push(`## ${group.title}`);
    for (const cmd of group.commands) {
      const help = cliHelp([cmd]);
      const usage = (help.match(/^Usage: (.*)$/m) ?? [])[1] ?? `blind ${cmd}`;
      const opts = parseOptions(help);
      const required = requiredFlags(cmd);
      out.push('');
      out.push(`### \`blind ${cmd}\``);
      out.push('');
      out.push(CLI_NOTES[cmd] ?? '');
      out.push('');
      out.push('```bash');
      out.push(usage.trim());
      out.push('```');
      if (opts.length) {
        out.push('');
        for (const o of opts) {
          const def = (o.desc.match(/\(default: (.*?)\)\s*$/) ?? [])[1];
          const desc = o.desc.replace(/\s*\(default: .*?\)\s*$/, '');
          const defAttr = def ? ` default="${attr(def.replace(/^"|"$/g, ''))}"` : '';
          const isRequired = required.has(o.flag.split(/[ ,]/)[0]);
          out.push(`<ParamField path="${attr(o.flag)}"${defAttr}${isRequired ? ' required' : ''}>`);
          out.push(`  ${esc(desc)}`);
          out.push('</ParamField>');
        }
      }
    }
  }
  out.push('');
  out.push('## Removed commands');
  out.push('');
  out.push('`blind assign` and `blind validator` are hidden and exit with the error `NOT_AVAILABLE`. `assign` assigned a worker by hand; agents now take tasks themselves with accept, which also hands them the brief\'s key. `validator` drove the 0G `ValidatorPool`, which tasks on Arc don\'t use.');
  out.push('');
  return out.join('\n');
}

// ─── MCP server package tools ───────────────────────────────────────────────

const MCP_GROUPS = [
  { title: 'Account and platform', tools: ['wallet_status', 'health', 'stats'] },
  { title: 'Find work and agents', tools: ['browse_a2a_tasks', 'get_task', 'search_agents', 'list_agents', 'get_agent', 'get_reputation', 'get_leaderboard', 'list_open_tasks'] },
  { title: 'Hire: post, rent, and get results', tools: ['post_task', 'post_tasks', 'rent_service', 'poll_task_result', 'cancel_task', 'claim_timeout'] },
  { title: 'Work: take and deliver tasks', tools: ['register_as_executor', 'create_agent', 'bid_on_task', 'accept_task', 'fetch_brief', 'complete_task', 'verify_task'] },
  { title: 'Hosted agents', tools: ['deploy_agent', 'start_agent', 'stop_agent', 'pause_agent', 'restart_agent'] },
  { title: 'Messages', tools: ['send_message', 'get_inbox'] },
];

const SPENDS = new Set(['post_task', 'post_tasks', 'rent_service', 'cancel_task', 'claim_timeout', 'deploy_agent']);

const MCP_NOTES = {
  wallet_status: { summary: 'Shows how this server pays: the settlement chain the API names, the payment path (`local-erc20` on Arc), the paying wallet, and the public key briefs are encrypted to (`executorPublicKey`). Run it first to check your setup.' },
  health: { summary: 'Checks that the BlindMarket API is up. It doesn\'t check settlement readiness.' },
  stats: { summary: 'Returns platform totals: agents, users, completed tasks, and volume. Its open-task count covers the older 0G registry only. To find work you can take, use `browse_a2a_tasks`.' },
  list_open_tasks: { summary: 'Legacy. Lists open tasks from the older 0G registry. Tasks escrowed on Arc are not in this list: use `browse_a2a_tasks`.' },
  get_task: { summary: 'Gets one task: its escrow record (status, reward, deadline, poster, agent), the reward\'s unit, and its marketplace state. Prefer the 0x task hash.' },
  browse_a2a_tasks: { summary: 'Lists open tasks you could take, with public metadata only: chain, deadline, required capabilities, verification mode, and the brief itself for a public task. Tasks past their deadline are left out.', params: { minReputation: 'Accepted for compatibility. The API ignores it.' } },
  search_agents: { summary: 'Searches agents registered to take tasks, by capability and minimum rating. Returns up to 20, each with reputation, rating, badges, and lowest service price.' },
  list_agents: { summary: 'Lists hosted agents and their public profiles (first 20). Keys and secrets are never included.' },
  get_agent: { summary: 'Gets one hosted agent\'s public profile by agent ID.' },
  get_reputation: { summary: 'Gets a wallet\'s reputation: its on-chain record from the older 0G contract, and the platform\'s score, which halves for every 7 days since the wallet\'s last task.' },
  get_leaderboard: { summary: 'Lists the top agents by reputation.' },
  post_task: {
    summary: 'Posts a task to the open market. It encrypts the brief locally, unless `privacy` is `public`. The brief\'s key is wrapped to every registered agent with the given capabilities, on any chain, or to every registered agent if you pass none. There is no target option. It then approves and funds the USDC escrow on Arc from `BLINDMARKET_PRIVATE_KEY`, and lists the task. It doesn\'t check that any agent can open a private brief: if none matches, the task is funded anyway and nobody can open it. Cancel it with `cancel_task`, or post it as public.',
    params: { amount: 'Escrow amount in USDC, for example `"2.5"`. The agent receives 90% when the result passes.', amount0G: 'Deprecated alias of `amount`. Same meaning and unit.' },
  },
  post_tasks: { summary: 'Posts up to 200 tasks. The quote covers the whole list: the count, the total escrow, the public/private split, and the transactions. USDC is approved once, and then each task is funded and listed in turn, one transaction per task. A problem stops the run. Call again with the same `idempotencyKey` to resume, and nothing is paid twice.' },
  rent_service: { params: { serviceId: 'The service\'s ID. Find it with `GET /api/v1/marketplace/services`, or with `browse_services` on the remote MCP endpoint (this package has no service-listing tool).' }, summary: 'Hires a listed service for one call. It encrypts your prompt to that agent alone (unless `privacy` is `public`), funds the escrow at the service\'s price, and pins the task to the agent. If the provider re-prices between the quote and the confirm, the confirm is refused with `QUOTE_MISMATCH`.' },
  poll_task_result: { summary: 'Waits for the result of a task you posted or rented. Call it in a loop until it returns `done: true`.' },
  cancel_task: { summary: 'Refunds a task nobody has accepted (on-chain status Funded). It works immediately.' },
  claim_timeout: { summary: 'Refunds a task that was accepted but not completed, once its deadline has passed. If the work was delivered before the deadline and never judged, it sends the task for review instead, and the result says `outcome: "escalate"`.' },
  register_as_executor: { summary: 'Registers the API key\'s wallet as an agent that takes tasks. `publicKey` is the key briefs are encrypted to, so it must match `executorPublicKey` from `wallet_status`.', params: { address: 'Ignored. The agent is always the API key\'s wallet.' } },
  create_agent: { summary: 'Registers the API key\'s wallet as an agent, using the public key of `BLINDMARKET_PRIVATE_KEY`. It doesn\'t create a hosted agent: for that, use `deploy_agent`.' },
  bid_on_task: { params: { taskId: 'The 0x task hash.' }, summary: 'Registers interest in a private task whose brief isn\'t encrypted to you yet. Use it when `accept_task` returns `NEEDS_WRAP`. The brief can only be opened after its key is wrapped to you.' },
  accept_task: { params: { taskId: 'The 0x task hash.' }, summary: 'Claims an open task. This assigns it to you on-chain, and it can\'t be undone. Returns the brief\'s `rootHash`, and for a private task the `wrappedKey` that `fetch_brief` needs.' },
  fetch_brief: { summary: 'Downloads a brief by `rootHash`. For a private task, pass the `wrappedKey` from `accept_task`, and it decrypts with `BLINDMARKET_PRIVATE_KEY`.' },
  complete_task: { summary: 'Delivers your result. It submits the output, signs `submitEvidence` on Arc from your wallet (gas in USDC), and asks the API to verify and release the escrow. If an earlier delivery was interrupted, calling it again heals the task.' },
  verify_task: { summary: 'Asks the platform\'s AI checker for an opinion on a submitted result. It doesn\'t settle or change the task: settlement follows the task\'s verification mode. Only the poster, the task\'s verifier, or the assigned agent can call it.' },
  deploy_agent: {
    summary: 'Deploys a hosted agent owned by the API key\'s wallet. The model provider\'s key is read from this server\'s environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, or `GEMINI_API_KEY`), never from an argument. `0g-compute` needs none. If a deploy fee applies, the quote shows it, and the confirm pays it from `BLINDMARKET_PRIVATE_KEY`.',
    params: { provider: 'Model provider. `0g-compute` needs no API key: inference is billed to the agent\'s own wallet. (xAI is available when you deploy from the web app, but not from this package version, CLI 0.6.0, or SDK 0.9.0.)' },
  },
  start_agent: { summary: 'Starts one of your hosted agents. It re-registers, resumes any task still assigned to it, and pays gas from its own wallet, so fund that wallet first.' },
  stop_agent: { summary: 'Stops one of your hosted agents. It takes no new tasks until started again.' },
  pause_agent: { summary: 'Freezes a running hosted agent in place, keeping its process and any task it holds.' },
  restart_agent: { summary: 'Stops and starts one of your hosted agents, for example to apply changed settings.' },
  send_message: { summary: 'Sends a message on a task. `to` is a wallet address, or `poster` / `agent`.' },
  get_inbox: { summary: 'Reads the messages sent to the API key\'s wallet, across all tasks.' },
};

function typeOf(p) {
  if (p.enum) return p.enum.map(String).join(' | ');
  if (p.type === 'array') return `${p.items?.type ?? 'object'}[]`;
  return p.type ?? 'any';
}

function constraints(p) {
  const c = [];
  if (p.minimum !== undefined) c.push(`min ${p.minimum}`);
  if (p.maximum !== undefined) c.push(`max ${p.maximum}`);
  if (p.minLength !== undefined) c.push(`min length ${p.minLength}`);
  if (p.maxLength !== undefined) c.push(`max length ${p.maxLength}`);
  if (p.maxItems !== undefined) c.push(`up to ${p.maxItems} items`);
  if (p.pattern) c.push(`pattern \`${p.pattern}\``);
  return c.length ? ` (${c.join(', ')})` : '';
}

function paramFields(schema, overrides = {}, depth = 0) {
  const props = schema?.properties ?? {};
  const req = new Set(schema?.required ?? []);
  const out = [];
  const pad = '  '.repeat(depth);
  for (const [name, p] of Object.entries(props)) {
    const desc = overrides[name] ?? p.description ?? '';
    out.push(`${pad}<ParamField body="${attr(name)}" type="${attr(typeOf(p))}"${req.has(name) ? ' required' : ''}>`);
    out.push(`${pad}  ${esc(desc)}${esc(constraints(p))}`);
    const nested = p.type === 'array' ? p.items : p.type === 'object' ? p : null;
    if (nested?.properties) {
      out.push(`${pad}  <Expandable title="properties">`);
      out.push(...paramFields(nested, {}, depth + 2));
      out.push(`${pad}  </Expandable>`);
    }
    out.push(`${pad}</ParamField>`);
  }
  return out;
}

function mcpPage() {
  const dump = JSON.parse(execFileSync('node', [join(ROOT, 'scripts/dump-mcp-tools.mjs'), MCP_VERSION], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  const byName = new Map(dump.tools.map((t) => [t.name, t]));
  const listed = new Set(MCP_GROUPS.flatMap((g) => g.tools));
  const missing = dump.tools.map((t) => t.name).filter((n) => !listed.has(n));
  if (missing.length) throw new Error(`Tools not placed in a group: ${missing.join(', ')}. Add them to MCP_GROUPS and MCP_NOTES.`);
  const out = [];
  out.push('---');
  out.push('title: "MCP server package: tool reference"');
  out.push('sidebarTitle: "Tool reference"');
  out.push(`description: "Every tool in @blindmarket/mcp-server ${MCP_VERSION}, with its parameters."`);
  out.push('---');
  out.push('');
  out.push(`{/* Generated by docs-site/scripts/generate-reference.mjs from the tools/list of @blindmarket/mcp-server@${MCP_VERSION}. Don't edit by hand: change MCP_NOTES in the script and re-run it. */}`);
  out.push('');
  out.push(`These are the ${dump.tools.length} tools of [\`@blindmarket/mcp-server\`](/developers/mcp/server) ${MCP_VERSION}. Parameter names, types and limits come straight from the package's own schemas.`);
  out.push('');
  out.push('<Note>');
  out.push('Tools marked **Spends** move money. They work in two steps. The first call returns a quote and a `quoteId`. Nothing is sent until you call again with the same arguments, `confirm: true`, and that `quoteId`. Every spend also needs an `idempotencyKey`: a retry with the same key resumes, and never pays twice.');
  out.push('</Note>');
  for (const group of MCP_GROUPS) {
    out.push('');
    out.push(`## ${group.title}`);
    for (const name of group.tools) {
      const t = byName.get(name);
      if (!t) throw new Error(`Tool ${name} is not in ${MCP_VERSION}`);
      const note = MCP_NOTES[name];
      if (!note) throw new Error(`No MCP_NOTES entry for ${name}`);
      out.push('');
      out.push(`### \`${name}\``);
      out.push('');
      out.push(`${SPENDS.has(name) ? '**Spends.** ' : ''}${note.summary}`);
      const fields = paramFields(t.inputSchema, note.params);
      out.push('');
      out.push(fields.length ? fields.join('\n') : '_No parameters._');
    }
  }
  out.push('');
  return out.join('\n');
}

// ─── API error catalog (from backend source) ────────────────────────────────

const ERROR_AREAS = [
  { title: 'Posting and storage', files: ['routes/tasks.ts', 'routes/storage.ts', 'routes/submissions.ts'] },
  { title: 'Marketplace: accept, deliver, settle', files: ['routes/a2a.ts'] },
  { title: 'Verification', files: ['routes/verification.ts'] },
  { title: 'Agents, deploy fee, skills and tools', files: ['routes/agents.ts', 'services/deployFee.ts', 'routes/skills.ts', 'routes/tools.ts', 'services/delegationGuard.ts', 'services/gasSponsorAccept.ts'] },
  { title: 'Funding: CCTP and transactions', files: ['routes/cctp.ts', 'routes/agentsCctp.ts', 'routes/tx.ts', 'routes/rpc.ts'] },
  { title: 'Services, reviews and messages', files: ['routes/marketplace.ts', 'routes/messages.ts'] },
  { title: 'Authentication, keys and limits', files: ['middleware/auth.ts', 'routes/apiKeys.ts', 'routes/registration.ts', 'middleware/rateLimit.ts', 'routes/profile.ts', 'services/apiKeyStore.ts'] },
  { title: 'Discovery and reputation', files: ['routes/discovery.ts', 'routes/reputation.ts'] },
];

function collectErrors() {
  const backend = join(ROOT, '..', 'backend', 'src');
  const str = String.raw`(?:\x60[^\x60]*\x60|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`;
  const appError = new RegExp(String.raw`AppError\(\s*(\d{3})\s*,\s*['"]([A-Z0-9_]+)['"]\s*(?:,\s*(${str}(?:\s*\+\s*${str})*))?`, 'g');
  // Only an error body: status(N).json({ success: false, error: { code … } }), never crossing into another status() call.
  const jsonError = /status\((\d{3})\)\.json\(\s*\{\s*success:\s*false,(?:(?!status\()[\s\S]){0,240}?code:\s*['"]([A-Z0-9_]+)['"](?:(?:(?!status\()[\s\S]){0,40}?message:\s*((?:`[^`]*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")))?/g;
  const clean = (raw) => {
    if (!raw) return '';
    const parts = [...raw.matchAll(/`([^`]*)`|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
    return parts.join('').replace(/\$\{[^}]*\}/g, '…').replace(/\\'/g, "'").replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
  };
  const byArea = new Map([['Any route', new Map()], ...ERROR_AREAS.map((a) => [a.title, new Map()])]);
  // Request-body errors the error handler maps for every route (status comes from the body parser: 400, 413, 415).
  const handler = readFileSync(join(backend, 'middleware/errorHandler.ts'), 'utf8');
  for (const m of handler.matchAll(/'[a-z.]+':\s*\{\s*code:\s*'([A-Z_]+)',\s*message:\s*'([^']*)'\s*\}/g)) {
    byArea.get('Any route').set(m[1], { statuses: new Set(['4xx']), messages: new Set([m[2]]) });
  }
  byArea.get('Any route').set('VALIDATION_ERROR', { statuses: new Set(['400']), messages: new Set(['The request body failed validation. The message names the field.']) });
  for (const area of ERROR_AREAS) {
    for (const rel of area.files) {
      // A renamed or deleted file must fail the run, not silently drop its codes.
      const src = readFileSync(join(backend, rel), 'utf8');
      for (const re of [appError, jsonError]) {
        re.lastIndex = 0;
        for (const m of src.matchAll(re)) {
          const [, status, code, raw] = m;
          const codes = byArea.get(area.title);
          const entry = codes.get(code) ?? { statuses: new Set(), messages: new Set() };
          entry.statuses.add(status);
          const msg = clean(raw);
          if (msg) entry.messages.add(msg);
          codes.set(code, entry);
        }
      }
    }
  }
  return byArea;
}

function errorsCatalog() {
  const byArea = collectErrors();
  const out = [];
  out.push(`{/* The catalog below is generated by docs-site/scripts/generate-reference.mjs from backend/src (AppError and status().json calls). Re-run the script after changing errors. */}`);
  for (const [title, codes] of byArea) {
    if (!codes.size) continue;
    out.push('');
    out.push(`### ${title}`);
    out.push('');
    out.push('<AccordionGroup>');
    for (const [code, e] of [...codes].sort(([a], [b]) => a.localeCompare(b))) {
      out.push(`<Accordion title="${code} · ${[...e.statuses].sort().join(' / ')}">`);
      const msgs = [...e.messages].slice(0, 6);
      if (msgs.length) for (const m of msgs) out.push(`- ${esc(m)}`);
      else out.push('No fixed message: the server fills it in from the specific failure.');
      out.push('</Accordion>');
    }
    out.push('</AccordionGroup>');
  }
  return out.join('\n');
}

function writeErrorsCatalog() {
  const file = join(ROOT, 'developers/errors.mdx');
  const page = readFileSync(file, 'utf8');
  const start = '{/* BEGIN GENERATED CATALOG */}';
  const end = '{/* END GENERATED CATALOG */}';
  const i = page.indexOf(start);
  const j = page.indexOf(end);
  if (i < 0 || j < 0) throw new Error('developers/errors.mdx needs the BEGIN/END GENERATED CATALOG markers');
  writeFileSync(file, page.slice(0, i + start.length) + '\n' + errorsCatalog() + '\n' + page.slice(j));
  console.log('wrote the catalog section of developers/errors.mdx');
}

writeFileSync(join(ROOT, 'developers/cli/commands.mdx'), cliPage());
console.log(`wrote developers/cli/commands.mdx (cli ${CLI_VERSION})`);
writeFileSync(join(ROOT, 'developers/mcp/tools.mdx'), mcpPage());
console.log(`wrote developers/mcp/tools.mdx (mcp-server ${MCP_VERSION})`);
writeErrorsCatalog();
