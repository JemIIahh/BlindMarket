// Mobile layout audit. Loads each app route in headless Chrome at phone and
// tablet widths and checks for the layout bugs that have shipped before.
//
// Fails (exit 1) on:
//   - horizontal page overflow (scrollWidth > viewport) at any width
//   - a visible text field under 16px below 640px (iOS Safari zooms on focus)
//   - a sidebar link that can't be scrolled into view inside the sidebar, or a
//     sidebar scroll area under three links tall
//     (/a2a at 375x667 with the drawer open, 844x390 and 1024x600)
// Inconclusive (exit 3) when the local API rate limit (100 requests a minute
// per IP) still answers 429 after a wait and one reload, or a task/agent page
// never renders its data: an empty page can't show the overflow its data causes.
// Reports only: tap targets under 24px, text under 11px.
//
// Run: start the app (`npm run dev`) and the backend, then `npm run audit:mobile`.
// Pages load one at a time, and the run waits for the rate-limit window whenever
// fewer than API_RESERVE requests are left, so a browser using the same API
// keeps working.
// Env: BASE (default http://localhost:5173), API (default http://localhost:3001),
//      CHROME_PATH, ROUTES and WIDTHS (comma-separated), API_RESERVE (default 40),
//      VERBOSE=1 to list the report-only findings.
// Screenshots at <=390px land in frontend/.mobile-audit/ (gitignored).
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const BASE = (process.env.BASE || 'http://localhost:5173').replace(/\/$/, '');
const API = (process.env.API || 'http://localhost:3001').replace(/\/$/, '');
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = new URL('../.mobile-audit/', import.meta.url).pathname;
const API_RESERVE = Number(process.env.API_RESERVE ?? 40);
const WIDTHS = (process.env.WIDTHS || '360,390,768').split(',').map(Number);
const ROUTES = (process.env.ROUTES || [
  '/', '/how-it-works', '/a2a', '/agents/browse', '/agents/:id', '/tasks/:id', '/tasks/new',
  '/tasks/mine', '/tasks/templates', '/agents/deploy', '/agents/deploy/ui', '/agents/deploy/sdk',
  '/agents/mine', '/earnings', '/settings', '/messages', '/activity', '/metrics', '/no-such-page',
].join(',')).split(',').map((r) => r.trim()).filter(Boolean);
const SIDEBAR_VIEWPORTS = [
  { width: 375, height: 667, drawer: true },
  { width: 844, height: 390, mobile: true },
  { width: 1024, height: 600 },
  { width: 844, height: 390, mobile: true, collapsed: true },
  { width: 1024, height: 600, collapsed: true },
];
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const RATE_LIMITED = 'local API rate limit hit; re-run later';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const warn = (msg) => console.warn(`warn: ${msg}`);

if (!fs.existsSync(CHROME_PATH)) {
  console.error(`Chrome not found at ${CHROME_PATH}. Set CHROME_PATH to a Chrome or Chromium binary.`);
  process.exit(2);
}
try {
  await fetch(BASE, { signal: AbortSignal.timeout(5000) });
} catch {
  console.error(`${BASE} is not reachable. Start the app with \`npm run dev\` (or set BASE).`);
  process.exit(2);
}

async function discover(label, path, pick) {
  try {
    const res = await fetch(API + path, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const item = pick(await res.json());
    if (item) return item;
    warn(`${path} returned no ${label}`);
  } catch (e) {
    warn(`${API}${path} failed (${e.message})`);
  }
  return null;
}

const agent = await discover('agent', '/api/v1/agents?limit=1', (j) => j?.data?.[0]);
const task = await discover('task', '/api/v1/tasks?limit=1', (j) => j?.data?.tasks?.[0]);

// A detail page only counts once its data is on screen.
const routes = [];
for (const path of ROUTES) {
  if (!path.includes(':id')) {
    routes.push({ path });
  } else if (path.startsWith('/agents/') && agent?.id) {
    routes.push({ path: path.replace(':id', encodeURIComponent(agent.id)), expect: { h1: agent.name || '' } });
  } else if (path.startsWith('/tasks/') && task?.taskId) {
    routes.push({
      path: path.replace(':id', encodeURIComponent(task.taskId)),
      expect: { h1: 'Task #', text: (task.taskHash || '').slice(0, 12) },
    });
  } else {
    warn(`skipping ${path}: no id to fill in`);
  }
}

fs.mkdirSync(OUT, { recursive: true });
// One browser, one tab at a time: Chrome marks background tabs hidden and
// freezes their CSS animations, and parallel loads burn the API budget.
const browser = await puppeteer.launch({
  executablePath: CHROME_PATH,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
});

// Latest rate-limit state the API reported, from any response a page saw.
const budget = { remaining: Infinity, resetAt: 0 };
const fromApi = (url) => url.startsWith(API) || url.startsWith(BASE);

async function waitForBudget() {
  if (budget.remaining >= API_RESERVE || Date.now() >= budget.resetAt) return;
  const secs = Math.ceil((budget.resetAt - Date.now()) / 1000) + 1;
  warn(`${budget.remaining} API requests left in this window; waiting ${secs}s`);
  await sleep(secs * 1000);
  budget.remaining = Infinity;
}

async function openPage({ width, height, mobile = width < 768, collapsed = false }) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
  if (mobile) await page.setUserAgent(MOBILE_UA);
  await page.evaluateOnNewDocument((c) => {
    try { localStorage.setItem('bb.sidebar.collapsed', c ? '1' : '0'); } catch {}
  }, collapsed);
  page.on('response', (res) => {
    if (!fromApi(res.url())) return;
    const h = res.headers();
    if (h['ratelimit-remaining'] != null) {
      budget.remaining = Number(h['ratelimit-remaining']);
      budget.resetAt = Date.now() + Number(h['ratelimit-reset'] || 60) * 1000;
    }
  });
  return page;
}

// Loads a route and waits until it has settled: networkidle alone can land on a
// Suspense fallback, so also wait for a heading, for the aria-busy placeholders
// to go away and, on detail pages, for the data itself. A 429 means a wait for
// the window and one reload; a second 429 makes the result inconclusive.
async function load(page, route, errors) {
  for (let attempt = 1; ; attempt++) {
    await waitForBudget();
    errors.length = 0;
    let retryAfter = 0;
    const on429 = (res) => {
      if (res.status() !== 429 || !fromApi(res.url())) return;
      const h = res.headers();
      retryAfter = Math.max(retryAfter, Number(h['retry-after'] || h['ratelimit-reset']) || 60);
    };
    page.on('response', on429);
    try {
      await page.goto(BASE + route.path, { waitUntil: 'networkidle2', timeout: 45000 });
    } catch (e) {
      errors.push(`goto: ${e.message.slice(0, 80)}`);
    }
    const ready = await page
      .waitForFunction(() => document.querySelector('h1') && !document.querySelector('[aria-busy="true"]'), { timeout: 10000, polling: 200 })
      .then(() => true, () => false);
    const rendered = !route.expect || await page
      .waitForFunction(({ h1, text }) => {
        const heading = document.querySelector('h1')?.innerText ?? '';
        return heading.includes(h1) && document.body.innerText.includes(text ?? '');
      }, { timeout: 15000, polling: 250 }, route.expect)
      .then(() => true, () => false);
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    await sleep(300);
    page.off('response', on429);

    if (!retryAfter) {
      return { ready, inconclusive: rendered ? null : `data never rendered (${JSON.stringify(route.expect)})` };
    }
    if (attempt === 2) return { ready, inconclusive: `API answered 429 again after waiting: ${RATE_LIMITED}` };
    warn(`API answered 429 on ${route.path}; waiting ${retryAfter + 1}s, then reloading`);
    await sleep((retryAfter + 1) * 1000);
    budget.remaining = Infinity;
  }
}

// Runs in the page.
function measure() {
  const vw = document.documentElement.clientWidth;
  const describe = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 4).join('.') : '';
    const txt = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '')
      .trim().replace(/\s+/g, ' ').slice(0, 40);
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${txt ? ` "${txt}"` : ''}`;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity !== 0;
  };
  // Off-screen horizontally, e.g. inside the closed mobile drawer.
  const offscreen = (r) => r.right <= 0 || r.left >= vw;
  const clipsX = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(p).overflowX)) return true;
    }
    return false;
  };
  const all = [...document.body.querySelectorAll('*')];

  // Outermost elements that stick out of the viewport without a clipping ancestor.
  const offenders = [];
  const overSet = new Set();
  for (const el of all) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (!(r.right > vw + 1 || r.left < -1) || clipsX(el)) continue;
    if (getComputedStyle(el).position === 'fixed' && offscreen(r)) continue;
    let nested = false;
    for (let p = el.parentElement; p; p = p.parentElement) if (overSet.has(p)) { nested = true; break; }
    overSet.add(el);
    if (!nested) offenders.push(`${describe(el)} [${Math.round(r.left)}..${Math.round(r.right)}]`);
  }

  const textFields = [...document.querySelectorAll(
    'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=color]),select,textarea',
  )].filter(visible);
  const smallFields = textFields
    .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16)
    .map((el) => `${parseFloat(getComputedStyle(el).fontSize)}px ${describe(el)}`);

  // A pseudo-element absolutely positioned with negative insets enlarges the hit area.
  const hasHitSlop = (el) => ['::before', '::after'].some((pseudo) => {
    const cs = getComputedStyle(el, pseudo);
    if (cs.content === 'none' || cs.position !== 'absolute') return false;
    return ['top', 'right', 'bottom', 'left'].some((side) => parseFloat(cs[side]) < 0);
  });
  const smallTargets = [...document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=tab],summary')]
    .filter(visible)
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ el, r }) => (r.width < 24 || r.height < 24) && !offscreen(r) && !hasHitSlop(el))
    .map(({ el, r }) => `${describe(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);

  const tinyText = new Set();
  for (const el of all) {
    if (!visible(el) || offscreen(el.getBoundingClientRect())) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size < 11) tinyText.add(`${size}px ${describe(el)}`);
  }

  return {
    vw,
    hidden: document.visibilityState === 'hidden',
    scrollW: document.documentElement.scrollWidth,
    offenders: offenders.slice(0, 8),
    smallFields,
    smallTargets: [...new Set(smallTargets)],
    tinyText: [...tinyText],
  };
}

// Runs in the page. For each sidebar link, scrolls only the boxes a person can
// scroll (overflow-y auto/scroll) to bring it to the top, then checks it is
// fully visible: inside the viewport and inside every clipping ancestor.
// scrollIntoView() won't do here, since it also scrolls overflow:hidden boxes.
// Also flags a scroll box shorter than three links: the nav once squeezed to a
// 52px strip that showed one link at a time.
function sidebarReach() {
  const aside = document.querySelector('aside');
  if (!aside) return { total: 0, reachable: 0, missing: ['no <aside>'] };
  const links = [...aside.querySelectorAll('nav a')];
  const ancestors = (a) => {
    const list = [];
    for (let p = a.parentElement; p; p = p.parentElement) {
      list.push(p);
      if (p === aside) break;
    }
    return list;
  };
  const scrollable = (el) => ['auto', 'scroll'].includes(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1;
  const clips = (el) => getComputedStyle(el).overflowX !== 'visible' || getComputedStyle(el).overflowY !== 'visible';
  const missing = [];
  let cramped = null;
  for (const a of links) {
    const scrollers = ancestors(a).filter(scrollable);
    for (const p of scrollers) p.scrollTop += a.getBoundingClientRect().top - p.getBoundingClientRect().top;
    const r = a.getBoundingClientRect();
    if (scrollers.length && scrollers[0].clientHeight < 3 * r.height) {
      cramped = `${scrollers[0].tagName.toLowerCase()} scroll area is ${scrollers[0].clientHeight}px tall, under 3 links (${Math.round(3 * r.height)}px)`;
    }
    const within = (b) => r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5 && r.left >= b.left - 0.5 && r.right <= b.right + 0.5;
    const shown = r.width > 0 && r.height > 0
      && within({ top: 0, left: 0, bottom: innerHeight, right: innerWidth })
      && ancestors(a).every((p) => !clips(p) || within(p.getBoundingClientRect()));
    if (!shown) missing.push(a.getAttribute('href'));
  }
  aside.scrollTop = aside.scrollHeight;
  return { total: links.length, reachable: links.length - missing.length, missing, cramped };
}

const safeName = (path, w) => `${path.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'home'}@${w}`;

async function auditPage(route, width) {
  const page = await openPage({ width, height: 800 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 100)));
  try {
    const { ready, inconclusive } = await load(page, route, errors);
    let m;
    try {
      m = await page.evaluate(measure);
    } catch (e) {
      m = { error: e.message };
    }
    if (width <= 390) {
      await page.screenshot({ path: `${OUT}${safeName(route.path, width)}.png`, fullPage: true }).catch(() => {});
    }
    const fails = [];
    if (m.error) fails.push(`measure failed: ${m.error}`);
    else {
      if (m.scrollW > m.vw) fails.push(`overflow +${m.scrollW - m.vw}px: ${m.offenders.join('; ') || 'no single offender found'}`);
      if (width < 640 && m.smallFields.length) fails.push(`fields under 16px: ${m.smallFields.join('; ')}`);
    }
    return { path: route.path, width, ready, inconclusive, errors, fails, ...m };
  } finally {
    await page.close();
  }
}

async function auditSidebar(vp) {
  const page = await openPage(vp);
  const label = `${vp.width}x${vp.height}${vp.drawer ? ' drawer' : ''}${vp.collapsed ? ' collapsed' : ''}`;
  try {
    const { inconclusive } = await load(page, { path: '/a2a' }, []);
    let r;
    if (vp.drawer) {
      const btn = await page.$('button[aria-label="open menu"]');
      if (btn) {
        await btn.click();
        await sleep(600);
      }
      r = btn ? await page.evaluate(sidebarReach) : { total: 0, reachable: 0, missing: ['no "open menu" button'] };
      await page.screenshot({ path: `${OUT}sidebar_${vp.width}x${vp.height}.png` }).catch(() => {});
    } else {
      r = await page.evaluate(sidebarReach);
    }
    const path = new URL(page.url()).pathname;
    const fails = [];
    if (!path.startsWith('/a2a')) fails.push(`page navigated to ${path} while opening the menu`);
    else if (r.total === 0) fails.push(`no sidebar links${r.missing.length ? ` (${r.missing.join(', ')})` : ''}`);
    else if (r.missing.length) fails.push(`unreachable: ${r.missing.join(', ')}`);
    if (r.cramped) fails.push(r.cramped);
    return { label, ...r, inconclusive, fails };
  } finally {
    await page.close();
  }
}

const results = [];
for (const route of routes) {
  for (const width of WIDTHS) {
    results.push(await auditPage(route, width).catch((e) => (
      { path: route.path, width, ready: false, errors: [], fails: [`audit crashed: ${e.message}`] }
    )));
  }
}
const sidebar = [];
for (const vp of SIDEBAR_VIEWPORTS) sidebar.push(await auditSidebar(vp));
await browser.close();

// Report
const status = (r) => (r.fails.length ? 'FAIL' : r.inconclusive ? 'INCONCL' : 'ok');
const pathW = Math.max(...results.map((r) => r.path.length), 5);
console.log(`\n${'route'.padEnd(pathW)}  width  result   overflow  fields<16  tap<24  text<11  notes`);
for (const r of results) {
  const notes = [
    !r.ready && 'no h1/still busy',
    r.hidden && 'tab was hidden',
    r.errors.length && `${r.errors.length} page error(s)`,
  ].filter(Boolean).join(', ');
  console.log([
    r.path.padEnd(pathW),
    String(r.width).padStart(5),
    status(r).padEnd(7),
    (r.scrollW > r.vw ? `+${r.scrollW - r.vw}px` : '-').padEnd(8),
    String(r.smallFields?.length ?? '?').padStart(9),
    String(r.smallTargets?.length ?? '?').padStart(6),
    String(r.tinyText?.length ?? '?').padStart(7),
    notes,
  ].join('  '));
}
console.log('\nsidebar (/a2a)');
for (const s of sidebar) {
  console.log(`  ${s.label.padEnd(24)} ${status(s).padEnd(7)}  ${s.reachable}/${s.total} links reachable`);
}

const where = (x) => (x.path ? `${x.path} @${x.width}` : `sidebar ${x.label}`);
const all = [...results, ...sidebar];
const failed = all.filter((x) => x.fails.length);
const inconclusive = all.filter((x) => !x.fails.length && x.inconclusive);
if (failed.length) {
  console.log('\nfailures');
  for (const f of failed) for (const msg of f.fails) console.log(`  ${where(f)}: ${msg}`);
}
if (inconclusive.length) {
  console.log('\ninconclusive');
  for (const x of inconclusive) console.log(`  ${where(x)}: ${x.inconclusive}`);
}
if (process.env.VERBOSE) {
  console.log('\nreport-only details');
  for (const r of results) {
    const lines = [...(r.smallTargets ?? []).map((t) => `tap<24  ${t}`), ...(r.tinyText ?? []).map((t) => `text<11 ${t}`), ...r.errors.map((e) => `error   ${e}`)];
    if (lines.length) console.log(`  ${r.path} @${r.width}\n    ${lines.join('\n    ')}`);
  }
}

const count = (list) => `${list.filter((x) => !x.fails.length && !x.inconclusive).length}/${list.length}`;
const verdict = failed.length ? 'FAIL' : inconclusive.length ? 'INCONCLUSIVE' : 'PASS';
console.log(`\n${verdict}: ${count(results)} page checks, ${count(sidebar)} sidebar checks ok; screenshots in ${OUT}`);
if (inconclusive.length) {
  const limited = inconclusive.some((x) => x.inconclusive.includes(RATE_LIMITED));
  console.log(limited ? RATE_LIMITED : 'some pages never rendered their data; re-run later');
}
process.exit(failed.length ? 1 : inconclusive.length ? 3 : 0);
