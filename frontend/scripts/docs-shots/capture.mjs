#!/usr/bin/env node
// Docs screenshots of the BlindMarket web app, with demo data.
//
// Starts the app on a Vite dev server with Privy/wagmi stubbed (see
// vite.config.ts), drives headless Chrome through each screen, answers every
// API and RPC call from ./fixtures, and writes <name>-light.png and
// <name>-dark.png into docs-site/images/app/.
//
//   node frontend/scripts/docs-shots/capture.mjs            # every screen, both themes
//   node frontend/scripts/docs-shots/capture.mjs --only settings,messages --theme dark
//
// Env: CHROME_PATH (default: macOS Google Chrome), DOCS_SHOTS_PORT (5199),
//      OUT (default docs-site/images/app), KEEP_RAW=1 keeps the 2x originals.
// Needs: macOS `sips` to downscale; `ffmpeg` (optional) to shrink any PNG
// still over 400 KB to a 256-colour palette.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { createFixtures } from './fixtures/api.mjs';
import { answerRpc, isRpcHost } from './fixtures/rpc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(here, '../..');
const repo = path.resolve(frontend, '..');
const OUT = path.resolve(process.env.OUT || path.join(repo, 'docs-site/images/app'));
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.DOCS_SHOTS_PORT || 5199);
const APP = `http://127.0.0.1:${PORT}`;
const API_ORIGIN = 'http://docs-api.test';
const VIEWPORT = { width: 1440, height: 900 };
const SCALE = 2;
const MAX_BYTES = 400 * 1024;
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const ONLY = argValue('--only')?.split(',').map((s) => s.trim()).filter(Boolean);
const THEMES = argValue('--theme') ? [argValue('--theme')] : ['light', 'dark'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (cmd) => {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

if (!fs.existsSync(CHROME)) {
  console.error(`Chrome not found at ${CHROME}. Set CHROME_PATH.`);
  process.exit(2);
}

// ── Page helpers ─────────────────────────────────────────────────────────────

async function waitText(page, text, timeout = 20_000) {
  await page.waitForFunction((t) => document.body?.innerText.includes(t), { timeout, polling: 100 }, text);
}

/** Click the first `selector` element whose text is `text` (or contains it). */
async function clickText(page, text, { selector = 'button', exact = true } = {}) {
  const ok = await page.evaluate((text, selector, exact) => {
    const el = [...document.querySelectorAll(selector)].find((e) =>
      exact ? e.textContent.trim() === text : e.textContent.includes(text));
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  }, text, selector, exact);
  if (!ok) throw new Error(`no ${selector} with text "${text}"`);
}

/** Set a React-controlled field's value the way typing would, then optionally blur it. */
async function setValue(page, selector, value, { blur = false } = {}) {
  await page.waitForSelector(selector, { timeout: 15_000 });
  await page.$eval(selector, (el, value, blur) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    if (blur) {
      el.focus();
      el.blur();
    }
  }, value, blur);
}

async function blurAll(page) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.getSelection()?.removeAllRanges();
  });
}

/** The rectangle from the top of `fromSel` (or the page top) to the bottom of `toSel`, in page coordinates. */
async function regionClip(page, { fromSel = null, toSel, padTop = 24, padBottom = 32, column = false }) {
  return page.evaluate((fromSel, toSel, padTop, padBottom, column) => {
    const top = fromSel ? document.querySelector(fromSel).getBoundingClientRect().top + window.scrollY - padTop : 0;
    const bottom = document.querySelector(toSel).getBoundingClientRect().bottom + window.scrollY + padBottom;
    // `column`: only the content column, without the sidebar beside it.
    const main = column ? document.querySelector('main').getBoundingClientRect() : null;
    const x = main ? Math.round(main.left) : 0;
    const width = main ? Math.round(main.width) : document.documentElement.clientWidth;
    return { x, y: Math.max(0, top), width, height: bottom - Math.max(0, top) };
  }, fromSel, toSel, padTop, padBottom, column);
}

/**
 * Grow the viewport to the page's full height, so a tall screen is captured
 * in one frame with the fixed sidebar running its full length (puppeteer's
 * fullPage keeps fixed elements at viewport height).
 */
async function expandViewport(page) {
  for (let i = 0; i < 3; i++) {
    const height = await page.evaluate(() => Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)));
    const vp = page.viewport();
    if (height <= vp.height) break;
    await page.setViewport({ ...vp, height });
    await sleep(500);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(200);
}

/** Words that mean a screen is not fully rendered, or something failed. */
const BAD_TEXT = [/Couldn['’]t/i, /Something went wrong/i, /Loading/, /Checking…/, /Quoting…/, /Not authorised/i, /Waiting for logs/i, /no fixture/i];

async function settle(page, label) {
  await page.evaluate(() => document.fonts.ready);
  // The top bar balance arrives from the fake Arc RPC: wait for it so no shot shows "…".
  await waitText(page, '148.25');
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), { timeout: 10_000 }).catch(() => {});
  await sleep(900); // route fade-in (framer-motion) and font swap
  const text = await page.evaluate(() => document.body.innerText);
  const bad = BAD_TEXT.filter((re) => re.test(text)).map(String);
  if (bad.length) console.warn(`  ! ${label}: page text matches ${bad.join(', ')}`);
}

// ── Screens ──────────────────────────────────────────────────────────────────
// Each: path, what to wait for, optional actions, and how to frame the shot
// (viewport, fullPage, or a clip computed on the page).

function screens(ids) {
  return [
    {
      name: 'marketplace-tasks',
      path: '/a2a',
      ready: ['in escrow'],
      shot: { fullPage: true },
    },
    {
      name: 'agents-browse',
      path: '/agents/browse',
      ready: ['research-scout', 'Build the missing agent'],
      shot: { fullPage: true },
    },
    {
      name: 'agent-storefront',
      path: `/agents/${ids.storefrontAgent}`,
      ready: ['Competitor snapshot', '23 total'],
      shot: { clip: (page) => regionClip(page, { toSel: '#services', padBottom: 40 }) },
    },
    {
      name: 'rent-use-now',
      path: `/agents/${ids.storefrontAgent}`,
      ready: ['Competitor snapshot'],
      act: async (page) => {
        await clickText(page, 'Use now');
        await waitText(page, 'Your input');
        await setValue(page, 'textarea[placeholder="What do you want this agent to do?"]',
          'Snapshot five competitors for our invoicing app for freelancers in Europe. Focus on pricing for teams of up to 10 people.');
        await blurAll(page);
      },
      shot: {},
    },
    {
      name: 'post-task-form',
      path: '/tasks/new',
      ready: ['Posting as', 'Encrypt and post task'],
      act: async (page) => {
        await setValue(page, 'textarea[placeholder="Describe exactly what needs to be done."]',
          'Analyse our March to August churn export (CSV link below). Group churned accounts into monthly signup cohorts, find the three biggest drivers of churn by plan and company size, and recommend two changes we could test next quarter.\n\nReturn a one-page memo with one table.');
        await setValue(page, 'input[placeholder*="Summarize a technical article"]', 'Churn analysis memo from a SaaS customer export');
        await setValue(page, 'input[placeholder="e.g. function, return, sort"]', 'cohort, churn, recommendation');
        await setValue(page, 'input[placeholder^="e.g. unable to complete"]', 'unable to complete, as an AI language model');
        await setValue(page, 'input[type="number"][step="0.0001"]', '8');
        const deadline = await page.evaluate(() => {
          const d = new Date(Date.now() + 3 * 24 * 3600 * 1000);
          d.setHours(17, 0, 0, 0);
          const p = (n) => String(n).padStart(2, '0');
          return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
        });
        await setValue(page, 'input[type="datetime-local"]', deadline);
        await blurAll(page);
      },
      shot: { fullPage: true },
    },
    {
      name: 'post-many',
      path: '/tasks/bulk',
      ready: ['Drop a CSV or JSONL file here'],
      act: async (page) => {
        const input = await page.$('input[type="file"]');
        await input.uploadFile(path.join(here, 'fixtures/demo-tasks.csv'));
        // Stat labels are CSS-uppercased, and innerText returns them that way.
        await waitText(page, 'valid of 5 rows');
        await waitText(page, 'needs fixing');
        await blurAll(page);
      },
      shot: { fullPage: true },
    },
    {
      name: 'my-tasks',
      path: '/tasks/mine',
      ready: ['Draft a launch checklist', '6 shown / 6 total'],
      shot: { fullPage: true },
    },
    {
      name: 'task-detail',
      path: `/tasks/${ids.completedTask}`,
      ready: ['Agent output', 'Rate your agent'],
      shot: { fullPage: true },
    },
    {
      name: 'create-agent-choose',
      path: '/agents/deploy',
      ready: ['No code, in the browser'],
      shot: { clip: (page) => regionClip(page, { toSel: 'main a[href="/agents/deploy/sdk"]', padBottom: 64 }) },
    },
    {
      name: 'create-agent-form',
      path: '/agents/deploy/ui',
      ready: ['Source citations', 'You can start 2 now.'],
      act: async (page) => {
        await setValue(page, 'input[placeholder="research-agent"]', 'support-triage');
        await setValue(page, 'textarea[placeholder^="Describe what this agent does"]', [
          '# Support Triage',
          '',
          'You read incoming support tickets for a project-management app and route each one.',
          '',
          '## For every ticket',
          '- Tag the product area: billing, mobile app, integrations or account.',
          '- Mark it urgent if the customer cannot log in or was charged twice.',
          '- Draft a first reply in a friendly, plain tone.',
          '- Return JSON with area, urgency and reply.',
        ].join('\n'));
        await setValue(page, 'select:has(option[value="anthropic"])', 'anthropic');
        await sleep(200);
        await setValue(page, 'select:has(option[value="claude-sonnet-5-5"])', 'claude-sonnet-5-5');
        await setValue(page, 'input[type="password"][placeholder="sk-..."]', 'sk-ant-docs-demo-0000000000000000000000', { blur: true });
        await waitText(page, 'Live from Anthropic');
        await clickText(page, 'Ticket triage', { selector: 'button[aria-pressed]', exact: false });
        await clickText(page, 'Plain English', { selector: 'button[aria-pressed]', exact: false });
        await waitText(page, '2 skill(s) selected');
        await blurAll(page);
      },
      shot: { fullPage: true },
    },
    {
      name: 'my-agents',
      path: '/agents/mine',
      ready: ['invoice-parser', 'market-brief', 'Low balance'],
      shot: {},
    },
    {
      name: 'agent-console',
      path: `/agents/${ids.consoleAgent}`,
      ready: ['Operations', 'Withdraw to owner', 'agent stopped'],
      shot: { fullPage: true },
    },
    {
      name: 'agent-services',
      path: `/agents/${ids.servicesAgent}`,
      ready: ['Start from a template', 'Purchase order extract'],
      act: async (page) => {
        await setValue(page, 'input[placeholder="e.g. Market sentiment analysis"]', 'Credit note to JSON');
        await setValue(page, 'input[placeholder="0.5"]', '0.30');
        await clickText(page, 'Add description');
        await setValue(page, 'textarea[placeholder="What the buyer gets per call"]',
          'One credit note in, structured JSON out: the original invoice number, amounts, tax and the reason.');
        await blurAll(page);
      },
      shot: { clip: (page) => regionClip(page, { fromSel: '#services', toSel: '#owner-services-form', padTop: 32, padBottom: 40, column: true }) },
    },
    {
      name: 'settings',
      path: '/settings',
      ready: ['CI pipeline', 'Telegram alerts', 'BlindMarket wallet'],
      shot: { fullPage: true },
    },
    {
      name: 'messages',
      path: '/messages',
      ready: ['Ticket tagging: one ambiguous category'],
      act: async (page) => {
        await clickText(page, 'Ticket tagging: one ambiguous category', { selector: 'div.cursor-pointer', exact: false });
        await page.waitForSelector('textarea[placeholder="Type your message…"]');
        await setValue(page, 'textarea[placeholder="Type your message…"]', 'Listing them separately is perfect. Thanks, I will review those 30 by hand.');
        await blurAll(page);
      },
      shot: { fullPage: true },
    },
    {
      // The top-bar bell is a link to Activity, with the unread count on it:
      // there is no dropdown. This shot is the Activity page it opens.
      name: 'notifications',
      path: '/activity',
      ready: ['Result submitted', 'Mark all read'],
      shot: {},
    },
    {
      name: 'fund-cctp',
      path: '/a2a',
      ready: ['in escrow'],
      act: async (page) => {
        await page.click('button[title="Switch asset"]');
        await clickText(page, 'Fund from another chain', { exact: false });
        await waitText(page, 'Balance: 250.0000 USDC');
        await setValue(page, 'input[placeholder="10.00"]', '50');
        await waitText(page, 'You\'ll receive');
        await blurAll(page);
      },
      shot: {},
    },
    {
      name: 'earnings',
      path: '/earnings',
      ready: ['47 entries', 'invoice-parser', 'Pending payments'],
      shot: { fullPage: true },
    },
    {
      name: 'withdraw',
      path: '/a2a',
      ready: ['in escrow'],
      act: async (page) => {
        await page.click('button[title="Switch asset"]');
        await clickText(page, 'Withdraw', { exact: false, selector: '[role="menu"] button' });
        await waitText(page, '148.2500 USDC');
        await clickText(page, 'Send to my linked wallet', { exact: false });
        await setValue(page, 'input[placeholder="10.00"]', '25');
        await blurAll(page);
      },
      shot: {},
    },
  ];
}

// ── Network ──────────────────────────────────────────────────────────────────

function corsHeaders(req) {
  return {
    'Access-Control-Allow-Origin': APP,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': req.headers()['access-control-request-headers'] || 'Content-Type, Authorization, X-Active-Chain',
    'Access-Control-Max-Age': '600',
  };
}

function attachNetwork(page, ctx) {
  page.on('request', (req) => {
    if (req.isInterceptResolutionHandled()) return;
    const url = new URL(req.url());
    const method = req.method();
    if (url.origin === APP || url.protocol === 'data:' || url.protocol === 'blob:' || FONT_HOSTS.has(url.hostname)) {
      return req.continue();
    }
    if (method === 'OPTIONS') return req.respond({ status: 204, headers: corsHeaders(req) });

    if (url.origin === API_ORIGIN) {
      // The agent log stream reconnects 3 s after each response ends. Serve
      // the lines once per page (and to StrictMode's immediate second mount),
      // then answer reconnects with no content so lines don't repeat.
      if (/\/api\/v1\/agents\/[^/]+\/logs$/.test(url.pathname)) {
        const first = ctx.logsServedAt ?? 0;
        if (first && Date.now() - first > 1500) return req.respond({ status: 204, headers: corsHeaders(req) });
        ctx.logsServedAt ||= Date.now();
      }
      let body;
      try {
        body = req.postData() ? JSON.parse(req.postData()) : undefined;
      } catch {
        body = undefined;
      }
      const res = ctx.fixtures.handle({ method, url: req.url(), body });
      if (!res) {
        ctx.unknown.add(`${method} ${url.pathname}${url.search}`);
        return req.respond({
          status: 404,
          headers: corsHeaders(req),
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'docs-shots: no fixture for this route' } }),
        });
      }
      return req.respond({
        status: res.status,
        headers: corsHeaders(req),
        contentType: res.contentType || 'application/json',
        body: res.text ?? JSON.stringify(res.json),
      });
    }

    if (isRpcHost(url.hostname) && method === 'POST') {
      let body = null;
      try {
        body = JSON.parse(req.postData() || 'null');
      } catch { /* answered as an empty call below */ }
      return req.respond({
        status: 200,
        headers: corsHeaders(req),
        contentType: 'application/json',
        body: JSON.stringify(answerRpc(url.hostname, body ?? {}, ctx.fixtures.balances)),
      });
    }

    ctx.blocked.add(`${method} ${url.origin}${url.pathname}`);
    return req.abort('blockedbyclient');
  });
}

// ── Images ───────────────────────────────────────────────────────────────────

const canSips = has('sips');
const canFfmpeg = has('ffmpeg');

function finishImage(raw, out, width) {
  if (canSips) {
    execFileSync('sips', ['--resampleWidth', String(width), raw, '--out', out], { stdio: 'ignore' });
  } else if (canFfmpeg) {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-vf', `scale=${width}:-1:flags=lanczos`, out]);
  } else {
    fs.copyFileSync(raw, out);
  }
  if (fs.statSync(out).size > MAX_BYTES && canFfmpeg) {
    const tmp = `${out}.q.png`;
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', out, '-vf',
      'split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a', tmp]);
    if (fs.statSync(tmp).size < fs.statSync(out).size) fs.renameSync(tmp, out);
    else fs.rmSync(tmp);
  }
  return fs.statSync(out).size;
}

// ── Run ──────────────────────────────────────────────────────────────────────

process.chdir(frontend); // tailwind.config.js content globs are relative to the cwd
fs.mkdirSync(OUT, { recursive: true });
const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-shots-'));

const server = await createServer({ configFile: path.join(here, 'vite.config.ts') });
await server.listen();
console.log(`app on ${APP}`);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--hide-scrollbars', `--host-resolver-rules=MAP docs-api.test 127.0.0.1`],
});

const results = [];
const unknown = new Set();
const blocked = new Set();
let failed = 0;

try {
  for (const theme of THEMES) {
    const fixtures = createFixtures();
    const list = screens(fixtures.ids).filter((s) => !ONLY || ONLY.includes(s.name));
    for (const screen of list) {
      const label = `${screen.name}-${theme}`;
      const page = await browser.newPage();
      const ctx = { fixtures, unknown, blocked, logsServedAt: 0 };
      try {
        await page.setViewport({ ...VIEWPORT, deviceScaleFactor: SCALE });
        await page.emulateMediaFeatures([
          { name: 'prefers-reduced-motion', value: 'reduce' },
          { name: 'prefers-color-scheme', value: theme },
        ]);
        await page.evaluateOnNewDocument((theme) => {
          try {
            localStorage.setItem('bb.theme', theme);
            localStorage.setItem('bb.sidebar.collapsed', '0');
            localStorage.setItem('bb.chain', 'arc');
          } catch { /* storage blocked: the app falls back to dark */ }
        }, theme);
        page.on('pageerror', (err) => console.warn(`  ! ${label}: page error: ${err.message}`));
        await page.setRequestInterception(true);
        attachNetwork(page, ctx);

        await page.goto(`${APP}${screen.path}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        for (const text of screen.ready ?? []) await waitText(page, text, 30_000);
        if (screen.act) await screen.act(page);
        await settle(page, label);

        const raw = path.join(rawDir, `${label}.png`);
        if (screen.shot.fullPage || screen.shot.clip) await expandViewport(page);
        const clip = screen.shot.clip ? await screen.shot.clip(page) : undefined;
        await page.screenshot({ path: raw, clip });
        const width = Math.round((clip?.width ?? VIEWPORT.width));
        const out = path.join(OUT, `${label}.png`);
        const bytes = finishImage(raw, out, width);
        results.push({ label, bytes });
        console.log(`  ${label}.png  ${(bytes / 1024).toFixed(0)} KB`);
      } catch (err) {
        failed++;
        console.error(`  x ${label}: ${err.message}`);
        await page.screenshot({ path: path.join(rawDir, `${label}.failed.png`) }).catch(() => {});
      } finally {
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
  await server.close();
}

if (unknown.size) console.warn(`\nAPI calls with no fixture:\n  ${[...unknown].sort().join('\n  ')}`);
if (blocked.size) console.log(`\nBlocked outside requests:\n  ${[...blocked].sort().join('\n  ')}`);
if (process.env.KEEP_RAW === '1' || failed) console.log(`\nRaw captures: ${rawDir}`);
else fs.rmSync(rawDir, { recursive: true, force: true });
console.log(`\n${results.length} screenshot(s) written to ${path.relative(repo, OUT)}${failed ? `, ${failed} failed` : ''}`);
process.exit(failed ? 1 : 0);
