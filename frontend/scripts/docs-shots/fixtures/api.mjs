// Demo API for the docs screenshots: every endpoint the captured pages call,
// answered in the real envelope ({ success: true, data }) with the shapes the
// backend returns (backend/src/routes/*). All people, agents, addresses,
// hashes and amounts are fictional. Times are relative to `now`, so a
// screenshot taken today still says "Ends in 2d".
//
// Where the backend and the frontend disagree on a shape, the backend's shape
// wins: the screenshot shows what the live app shows.
import crypto from 'node:crypto';
import fs from 'node:fs';

const identity = JSON.parse(fs.readFileSync(new URL('./identity.json', import.meta.url), 'utf8'));
const providers = JSON.parse(fs.readFileSync(new URL('./providers.json', import.meta.url), 'utf8'));

const M = 60_000;
const H = 60 * M;
const D = 24 * H;

// ── Fixed addresses (fictional) ─────────────────────────────────────────────
export const USER = identity.user.embedded;
export const USER_EXTERNAL = identity.user.external;
const lc = (a) => a.toLowerCase();

// Public contract addresses from config/networks.json (Arc mainnet). They
// must match the build, or Post many refuses to run (lib/bulkCalls.ts).
const ARC_ESCROW = '0xd2B819B57a9568Cb6bFc98C687F9a851EC8330C4';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const ZERO = '0x0000000000000000000000000000000000000000';

const OWNER = {
  maya: '0xC0FFEE00000000000000000000000000000000A1',
  jonas: '0xC0FFEE00000000000000000000000000000000A2',
  priya: '0xC0FFEE00000000000000000000000000000000A3',
  tomas: '0xC0FFEE00000000000000000000000000000000A4',
  ade: '0xC0FFEE00000000000000000000000000000000A5',
  lena: '0xC0FFEE00000000000000000000000000000000A6',
};
const POSTER = {
  p1: '0xB0B0000000000000000000000000000000000031',
  p2: '0xB0B0000000000000000000000000000000000032',
  p3: '0xB0B0000000000000000000000000000000000033',
  p4: '0xB0B0000000000000000000000000000000000034',
  p5: '0xB0B0000000000000000000000000000000000035',
};

/** Deterministic fake 32-byte hex, from a seed. */
const hash = (seed) => `0x${crypto.createHash('sha256').update(`docs-shots:${seed}`).digest('hex')}`;
/** A 65-byte uncompressed-pubkey-shaped hex (not a curve point; never used to encrypt here). */
const pubkey = (seed) => `04${hash(`${seed}:x`).slice(2)}${hash(`${seed}:y`).slice(2)}`;
/** USDC amount → 6-decimal base units string. */
const usdc = (n) => String(Math.round(n * 1e6));

export function createFixtures(now = Date.now()) {
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const secIn = (ms) => Math.floor((now + ms) / 1000);
  const secAgo = (ms) => Math.floor((now - ms) / 1000);

  // ── Agents ────────────────────────────────────────────────────────────────
  const AGENTS = [
    {
      id: '3f6e1c2a-8b4d-4e71-9a2c-0d0c5a000011',
      name: 'research-scout',
      wallet: '0xA6E7000000000000000000000000000000000011',
      owner: OWNER.maya,
      status: 'running',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      caps: ['web_research', 'summarization', 'data_extraction'],
      tasks: 61, earned: 142.35, inft: 214, deployedAgo: 74 * D, score: 88.2, onChainScore: 91,
      reviews: { avg: 4.83, total: 23, dist: { 5: 20, 4: 2, 3: 1, 2: 0, 1: 0 } },
      badges: [['web_research', 'proven'], ['summarization', 'proven']],
      skillStats: [['web_research', 41, 0], ['summarization', 20, 0]],
      instructions: [
        '# Research Scout',
        '',
        'You answer research questions with sources a reader can check. Every claim gets a link, and every number gets the date it was published.',
        '',
        '## How you work',
        '- Read at least three independent sources before you answer.',
        '- Quote figures exactly and say where they came from.',
        '- Say plainly when sources disagree, and which one you trust more.',
        '',
        '## Output',
        'A two-sentence answer first, then the findings as bullets, each with its source.',
      ].join('\n'),
    },
    {
      id: '5b9d0e4f-2c7a-4f1e-8d3b-0d0c5a000013',
      name: 'contract-auditor',
      wallet: '0xA6E7000000000000000000000000000000000013',
      owner: OWNER.priya,
      status: 'running',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      caps: ['code_review', 'testing'],
      tasks: 22, earned: 198.0, inft: 233, deployedAgo: 51 * D, score: 79.5, onChainScore: 84,
      reviews: { avg: 4.89, total: 9, dist: { 5: 8, 4: 1, 3: 0, 2: 0, 1: 0 } },
      badges: [['code_review', 'proven'], ['tee_verified', 'tee']],
      skillStats: [['code_review', 22, 0]],
      instructions: '# Contract Auditor\n\nYou review Solidity for reentrancy, access control, rounding and upgrade risks, and report each finding with its severity, the affected lines and a fix.',
    },
    {
      id: '8a2f6c1d-4e9b-4a7c-b1e2-0d0c5a000012',
      name: 'data-wrangler',
      wallet: '0xA6E7000000000000000000000000000000000012',
      owner: OWNER.jonas,
      status: 'running',
      provider: 'openai',
      model: 'gpt-5.4',
      caps: ['data_processing', 'data_extraction'],
      tasks: 38, earned: 41.2, inft: 221, deployedAgo: 63 * D, score: 74.1, onChainScore: 78,
      reviews: { avg: 4.64, total: 14, dist: { 5: 10, 4: 3, 3: 1, 2: 0, 1: 0 } },
      badges: [['data_processing', 'proven']],
      skillStats: [['data_processing', 30, 1], ['data_extraction', 8, 0]],
      instructions: '# Data Wrangler\n\nYou clean, reshape and validate tabular data. You never change a value you were not asked to change, and you list every row you dropped and why.',
    },
    {
      id: 'c4e8a2b6-1d3f-4b5a-9c7e-0d0c5a000014',
      name: 'lingo-bridge',
      wallet: '0xA6E7000000000000000000000000000000000014',
      owner: OWNER.tomas,
      status: 'running',
      provider: 'gemini',
      model: 'gemini-3.5-flash',
      caps: ['translation', 'content_generation'],
      tasks: 87, earned: 61.9, inft: 205, deployedAgo: 88 * D, score: 82.7, onChainScore: 86,
      reviews: { avg: 4.71, total: 31, dist: { 5: 24, 4: 5, 3: 2, 2: 0, 1: 0 } },
      badges: [['translation', 'proven']],
      skillStats: [['translation', 87, 2]],
      instructions: '# Lingo Bridge\n\nYou translate product and support copy between English, French, German and Spanish, keeping brand names, feature names and the tone of the source.',
    },
    {
      id: 'b7d2e9f1-6a4c-4d8e-a2f5-0d0c5a000021',
      name: 'invoice-parser',
      wallet: '0xA6E7000000000000000000000000000000000021',
      owner: USER,
      status: 'running',
      provider: 'openai',
      model: 'gpt-5.4-mini',
      caps: ['data_extraction'],
      tasks: 27, earned: 38.7, inft: 388, deployedAgo: 29 * D, score: 71.3, onChainScore: 75,
      reviews: { avg: 4.5, total: 8, dist: { 5: 5, 4: 2, 3: 1, 2: 0, 1: 0 } },
      badges: [['data_extraction', 'proven']],
      skillStats: [['data_extraction', 27, 1]],
      apiKeyHint: 'sk-…f3Qa',
      instructions: '# Invoice Parser\n\nYou turn invoices and receipts into JSON: supplier, invoice number, dates, currency, totals, tax and line items. If a field is missing, return null for it rather than guessing.',
    },
    {
      id: '2e7c9a3b-5f1d-4c6e-8b0a-0d0c5a000015',
      name: 'sql-sherpa',
      wallet: '0xA6E7000000000000000000000000000000000015',
      owner: OWNER.ade,
      status: 'running',
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
      caps: ['data_processing', 'text_analysis'],
      tasks: 12, earned: 9.6, inft: 301, deployedAgo: 33 * D, score: 58.4, onChainScore: 63,
      reviews: { avg: 4.33, total: 6, dist: { 5: 3, 4: 2, 3: 1, 2: 0, 1: 0 } },
      badges: [],
      skillStats: [['data_processing', 12, 1]],
      instructions: '# SQL Sherpa\n\nYou write and explain Postgres queries. Every query comes with the assumptions it makes about the schema.',
    },
    {
      id: 'e1a5c7d9-3b2f-4e8a-9d6c-0d0c5a000022',
      name: 'market-brief',
      wallet: '0xA6E7000000000000000000000000000000000022',
      owner: USER,
      status: 'stopped',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      caps: ['summarization', 'web_research'],
      tasks: 14, earned: 21.15, inft: 391, deployedAgo: 26 * D, score: 63.8, onChainScore: 69,
      reviews: { avg: 4.5, total: 2, dist: { 5: 1, 4: 1, 3: 0, 2: 0, 1: 0 } },
      badges: [],
      skillStats: [['summarization', 14, 0]],
      apiKeyHint: 'sk-ant-…9mPw',
      instructions: '# Market Brief\n\nEach morning you summarise the overnight news on a market the buyer names: five headlines, one line each on why it matters, and the sources.',
    },
    {
      id: 'd3f8b1e6-7c2a-4a9d-b5e4-0d0c5a000016',
      name: 'pitch-polisher',
      wallet: '0xA6E7000000000000000000000000000000000016',
      owner: OWNER.lena,
      status: 'running',
      provider: 'xai',
      model: 'grok-4.5',
      caps: ['content_generation'],
      tasks: 3, earned: 2.1, inft: 412, deployedAgo: 6 * D, score: 31.0, onChainScore: 40,
      reviews: { avg: 0, total: 0, dist: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 } },
      badges: [],
      skillStats: [],
      instructions: '# Pitch Polisher\n\nYou tighten pitch decks, landing pages and launch emails: shorter sentences, one idea per line, and a clear ask.',
    },
    {
      id: 'f6b2d8a4-9e1c-4f3b-a7d5-0d0c5a000023',
      name: 'fr-localizer',
      wallet: '0xA6E7000000000000000000000000000000000023',
      owner: USER,
      status: 'running',
      provider: '0g-compute',
      model: 'glm-5',
      caps: ['translation'],
      tasks: 6, earned: 4.8, inft: 402, deployedAgo: 9 * D, score: 42.6, onChainScore: 52,
      reviews: { avg: 0, total: 0, dist: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 } },
      badges: [],
      skillStats: [['translation', 6, 0]],
      instructions: '# FR Localizer\n\nYou localise English product copy into French for France and Canada, and flag any phrase that does not travel.',
    },
  ];
  const agentBy = (key) => {
    const k = lc(key);
    return AGENTS.find((a) => a.id === key || lc(a.wallet) === k || a.name === key);
  };

  const SERVICES = [
    // research-scout
    { id: 41, agent: 'research-scout', name: 'Competitor snapshot', description: 'Five competitors for a product or market, each with pricing, positioning and a source link.', price: 1.5, type: 'api', sold: 38, rating: 4.8, ago: 60 * D },
    { id: 42, agent: 'research-scout', name: 'Source-checked brief', description: 'A 300-word answer to one research question, every claim cited to two sources.', price: 0.75, type: 'api', sold: 64, rating: 4.9, ago: 58 * D },
    { id: 43, agent: 'research-scout', name: 'Weekly market digest', description: 'Ten headlines from the last seven days on a topic you name, each with a one-line takeaway.', price: 2.0, type: 'a2a', sold: 12, rating: 4.6, ago: 31 * D },
    // contract-auditor
    { id: 51, agent: 'contract-auditor', name: 'Solidity function review', description: 'One function reviewed for reentrancy, access control and rounding, with fixes.', price: 4.0, type: 'api', sold: 17, rating: 4.9, ago: 40 * D },
    { id: 52, agent: 'contract-auditor', name: 'Contract audit (up to 500 lines)', description: 'A findings report with severities, affected lines and suggested patches.', price: 18.0, type: 'a2a', sold: 4, rating: 5.0, ago: 22 * D },
    // data-wrangler
    { id: 61, agent: 'data-wrangler', name: 'CSV clean-up', description: 'Headers normalised, rows deduped, types fixed, and a log of every change.', price: 0.4, type: 'api', sold: 52, rating: 4.6, ago: 50 * D },
    { id: 62, agent: 'data-wrangler', name: 'Spreadsheet to JSON', description: 'A sheet turned into JSON that matches the schema you send.', price: 0.6, type: 'api', sold: 19, rating: 4.7, ago: 35 * D },
    // lingo-bridge
    { id: 71, agent: 'lingo-bridge', name: 'Translate up to 500 words', description: 'English to French, German or Spanish, brand terms kept as they are.', price: 0.3, type: 'api', sold: 140, rating: 4.7, ago: 80 * D },
    // invoice-parser (the demo user's)
    { id: 81, agent: 'invoice-parser', name: 'Invoice to JSON', description: 'One invoice or receipt in, structured JSON out: supplier, totals, tax and line items.', price: 0.25, type: 'api', sold: 112, rating: 4.5, ago: 27 * D },
    { id: 82, agent: 'invoice-parser', name: 'Receipt batch (up to 20)', description: 'Up to 20 receipts in one call, returned as a single JSON array.', price: 2.0, type: 'a2a', sold: 9, rating: 4.4, ago: 14 * D },
    { id: 83, agent: 'invoice-parser', name: 'Purchase order extract', description: 'Line items and delivery terms from a purchase order.', price: 0.35, type: 'api', sold: 0, rating: 0, ago: 4 * D, active: false },
    // sql-sherpa
    { id: 91, agent: 'sql-sherpa', name: 'Write one Postgres query', description: 'A query for the question you ask, with the schema assumptions spelled out.', price: 0.6, type: 'api', sold: 21, rating: 4.3, ago: 30 * D },
    // market-brief (the demo user's, stopped)
    { id: 95, agent: 'market-brief', name: 'Morning market brief', description: 'Five overnight headlines on the market you name, with sources.', price: 0.6, type: 'api', sold: 23, rating: 4.5, ago: 24 * D },
  ];

  function serviceRow(s) {
    const a = agentBy(s.agent);
    return {
      id: s.id,
      agent_address: lc(a.wallet),
      owner_address: lc(a.owner),
      name: s.name,
      description: s.description,
      price_raw: usdc(s.price),
      service_type: s.type,
      active: s.active !== false,
      sold_count: s.sold,
      avg_rating: s.rating,
      created_at: iso(s.ago),
      updated_at: iso(Math.max(0, s.ago - 2 * D)),
      agent_name: a.name,
      agent_capabilities: a.caps,
      agent_reputation: a.onChainScore,
      agent_public_key: pubkey(a.name),
      agent_supported_chains: null,
    };
  }
  const servicesOf = (a, { includeInactive = false } = {}) =>
    SERVICES.filter((s) => s.agent === a.name && (includeInactive || s.active !== false)).map(serviceRow);

  /** GET /api/v1/agents/:id and the rows of GET /api/v1/agents (backend routes/agents.ts). */
  function agentRecord(a) {
    return {
      id: a.id,
      ownerAddress: a.owner,
      authorizedOwners: [],
      name: a.name,
      instructions: a.instructions,
      provider: a.provider,
      model: a.model,
      capabilities: a.caps,
      tools: [],
      status: a.status,
      deployedAt: iso(a.deployedAgo),
      lastActiveAt: iso(a.status === 'running' ? 4 * M : 2 * D),
      walletAddress: a.wallet,
      publicKey: pubkey(a.name),
      inftTokenId: a.inft,
      verifierEnabled: false,
      delegationEnabled: false,
      skills: [],
      tasksCompleted: a.tasks,
      totalEarned: a.earned.toFixed(6),
      totalEarnedUsdc: a.earned.toFixed(6),
      totalEarnedNative: '0.000000',
      apiKeyHint: a.apiKeyHint ?? null,
      reputation: {
        address: a.wallet,
        tasksCompleted: a.tasks,
        avgScore: a.reviews.avg ? Number(a.reviews.avg.toFixed(1)) : 0,
        disputes: 0,
        disputeRatio: 0,
        score: a.onChainScore,
      },
      decayedReputation: {
        address: lc(a.wallet),
        rawScore: a.onChainScore,
        decayedScore: a.score,
        decayFactor: 0.97,
        daysSinceLastTask: 0.4,
        tasksCompleted: a.tasks,
        disputes: 0,
      },
    };
  }

  function minPrice(a) {
    const prices = SERVICES.filter((s) => s.agent === a.name && s.active !== false).map((s) => s.price);
    return prices.length ? usdc(Math.min(...prices)) : null;
  }

  /** GET /api/v1/marketplace/agents/search rows (backend routes/marketplace.ts). */
  function searchRow(a) {
    return {
      address: lc(a.wallet),
      name: a.name,
      capabilities: a.caps,
      reputation: a.onChainScore,
      tasksCompleted: a.tasks,
      supportedChains: ['arc'],
      avgRating: a.reviews.avg,
      totalReviews: a.reviews.total,
      badges: a.badges.map(([capability, type]) => ({ capability, type })),
      fromPrice: minPrice(a),
    };
  }

  // Browse order (the backend's "Newest" is its own order; this one reads well).
  const BROWSE_ORDER = ['research-scout', 'contract-auditor', 'data-wrangler', 'lingo-bridge', 'invoice-parser', 'sql-sherpa', 'market-brief', 'pitch-polisher', 'fr-localizer'];

  const REVIEWS = {
    'research-scout': [
      [POSTER.p1, 5, 'Five competitors, all with current pricing pages linked. Saved me an afternoon.', 2 * D],
      [POSTER.p3, 5, 'Flagged that two of my sources contradicted each other and said which was newer. Exactly what I wanted.', 6 * D],
      [USER, 5, 'Clear, sourced and on time.', 9 * D],
      [POSTER.p2, 4, 'Good brief. One link was to a paywalled article, otherwise spot on.', 15 * D],
      [POSTER.p5, 5, null, 21 * D],
    ],
    'invoice-parser': [
      [POSTER.p4, 5, 'Handled scanned receipts with handwriting better than I expected.', 3 * D],
      [POSTER.p2, 4, 'Accurate totals. Missed a discount line on one invoice.', 10 * D],
    ],
    'market-brief': [
      [POSTER.p1, 5, 'Short and useful every morning.', 12 * D],
      [POSTER.p3, 4, null, 19 * D],
    ],
  };
  function reviewsFor(a) {
    const list = (REVIEWS[a.name] ?? []).map(([reviewer, rating, review, ago], i) => ({
      id: 900 + i,
      task_id: hash(`review:${a.name}:${i}`),
      agent_address: lc(a.wallet),
      reviewer_address: lc(reviewer),
      rating,
      review,
      created_at: iso(ago),
    }));
    return {
      reviews: list,
      stats: { avgRating: a.reviews.avg, totalReviews: a.reviews.total, distribution: a.reviews.dist },
    };
  }

  // ── Open tasks on the board (GET /api/v1/a2a/tasks) ───────────────────────
  // Public rows as projectPublicMeta returns them: no wrappedKeys, no
  // rootHash on private tasks, and no onChain block.
  const BOARD = [
    { seed: 'board-1', privacy: 'private', summary: 'Clean and dedupe a 4,200-row CRM export\n\nMerge duplicate contacts, normalise phone numbers and country names.', reward: 3.5, ends: 2 * D + 5 * H, mode: 'auto', caps: ['data_processing'], poster: POSTER.p1 },
    { seed: 'board-2', privacy: 'public', brief: 'Summarise an earnings call in eight bullets\n\nTake the Q3 call transcript linked below and summarise it in eight bullets: revenue, margins, guidance, and anything management said about hiring. Keep each bullet under 25 words.', reward: 1.5, ends: 20 * H, mode: 'auto', caps: ['summarization'], poster: POSTER.p2 },
    { seed: 'board-3', privacy: 'private', summary: 'Review a Solidity vesting contract for reentrancy and rounding bugs\n\nAbout 340 lines, OpenZeppelin-based.', reward: 12, ends: 5 * D, mode: 'agent', caps: ['code_review'], poster: POSTER.p3 },
    { seed: 'board-4', privacy: 'public', brief: 'Translate a product page into French and German\n\nTranslate the 600-word product page below. Keep the brand name and feature names in English, and match the friendly tone of the original.', reward: 2.25, ends: 3 * D, mode: 'auto', caps: ['translation'], poster: POSTER.p4 },
    { seed: 'board-5', privacy: 'private', summary: 'Find five Series A competitors for a B2B invoicing startup\n\nPricing, target customer and latest funding round for each.', reward: 4, ends: 4 * D, mode: 'auto', caps: ['market_research', 'web_research'], poster: POSTER.p5 },
    { seed: 'task-431', privacy: 'public', brief: 'Write SQL for a monthly retention cohort\n\nGiven tables users(id, created_at) and events(user_id, ts), write a Postgres query that returns monthly signup cohorts and their retention for months 0 to 6.', reward: 2, ends: 6 * H, mode: 'auto', caps: [], poster: USER },
    { seed: 'board-7', privacy: 'private', summary: 'Extract line items from 30 supplier invoices (PDF)\n\nOutput one JSON array per invoice.', reward: 5, ends: 2 * D + 3 * H, mode: 'auto', caps: ['data_extraction'], poster: POSTER.p2 },
    { seed: 'board-8', privacy: 'public', brief: 'Draft three subject lines for a product launch email\n\nThe launch is a budgeting app for freelancers. Give three subject lines under 45 characters and say which one you would test first.', reward: 0.5, ends: 30 * H, mode: 'auto', caps: ['content_generation'], poster: POSTER.p1 },
    { seed: 'board-9', privacy: 'private', summary: 'Check 40 company websites for a live careers page\n\nReturn a yes/no and the URL for each.', reward: 1.8, ends: 9 * D, mode: 'auto', caps: ['web_research'], poster: POSTER.p5 },
  ];
  const STANDARD_FORBIDDEN = ['unable to complete', 'I cannot complete', 'as an AI language model', 'service unavailable', 'lorem ipsum'];
  function boardRow(t) {
    const taskId = hash(t.seed);
    const meta = {
      taskId,
      targetExecutorType: 'agent',
      verificationMode: t.mode,
      requiredCapabilities: t.caps,
      posterAddress: t.poster,
      chain: 'arc',
      chainId: identity.chainId,
      deadline: secIn(t.ends),
      reward: { amount: usdc(t.reward), unit: { symbol: 'USDC', decimals: 6 } },
      ...(t.privacy === 'public'
        ? { privacy: 'public', publicBrief: t.brief, hasEncryptedBrief: false, rootHash: hash(`${t.seed}:root`) }
        : { routingSummary: t.summary, hasEncryptedBrief: true }),
      verificationCriteria: t.mode === 'auto'
        ? { min_length: 10, forbidden_phrases: STANDARD_FORBIDDEN, pass_threshold: 60 }
        : undefined,
    };
    return { meta, state: { taskId, status: 'open' } };
  }

  // Wanted: open tasks no agent serves well (GET /api/v1/a2a/demand).
  const DEMAND = [
    { seed: 'gap-1', text: 'Reconcile a payout CSV against bank statement lines and flag every mismatch', fit: [0.41, 'data-wrangler'], reward: 3, age: 5 * H },
    { seed: 'gap-2', text: 'Write alt text for 12 product photos for an accessible storefront', fit: null, reward: 1.2, age: 26 * H },
    { seed: 'gap-3', text: 'Turn a 40-minute sales call recording into CRM notes and next steps', fit: [0.36, 'research-scout'], reward: 2.5, age: 2 * D + 3 * H },
  ];

  // ── The demo user's posted tasks (GET /api/v1/a2a/tasks/posted) ───────────
  const CHECKLIST_OUTPUT = [
    '## Beta launch checklist',
    '',
    '**Summary:** two weeks, four workstreams, and one go/no-go review on day 14.',
    '',
    '### Week 1: build and distribution',
    '- Freeze features and cut the `beta/1.0` release branch',
    '- Upload the build to TestFlight and the Play Console internal track',
    '- Write tester instructions: what to try, known issues, how to report',
    '- Turn on crash reporting and confirm a test crash arrives',
    '',
    '### Week 2: feedback and readiness',
    '- Invite the first 100 testers; widen to 500 after 48 hours without a P0',
    '- Add an in-app feedback link that captures device and build number',
    '- Triage feedback daily and label it P0, P1 or later',
    '- Track crash-free sessions every morning',
    '',
    '### Go/no-go review (day 14)',
    '',
    '| Check | Target |',
    '|---|---|',
    '| Crash-free sessions | 99.5% or higher |',
    '| Open P0 bugs | 0 |',
    '| Testers active in the last 7 days | 60% or more |',
  ].join('\n');

  const SPANISH_OUTPUT = [
    '**Email 1: Bienvenida**',
    '',
    'Asunto: Te damos la bienvenida',
    '',
    'Hola {{nombre}}, gracias por crear tu cuenta. En tres pasos tendrás tu primera factura lista…',
    '',
    '**Email 2: Primer cliente**',
    '',
    'Asunto: Añade tu primer cliente en un minuto',
  ].join('\n');

  const POSTED = [
    {
      seed: 'task-431', onChainId: '431', status: 0, a2a: 'open', privacy: 'public',
      brief: BOARD[5].brief, reward: 2, created: 2 * H, deadline: 6 * H, worker: null, mode: 'auto',
    },
    {
      seed: 'task-430', onChainId: '430', status: 0, a2a: 'open', privacy: 'private',
      summary: 'Turn 12 customer interviews into a findings memo', reward: 6, created: 5 * H, deadline: 2 * D, worker: null, mode: 'agent',
      wrapCount: 3, hasCustody: true,
    },
    {
      seed: 'task-427', onChainId: '427', status: 1, a2a: 'accepted', privacy: 'public',
      brief: 'Compare prices of five meal-kit services in Lagos\n\nFor each service list the weekly price for two people, delivery fee, delivery areas and how to cancel. Link the pricing page you used.',
      reward: 3, created: 9 * H, deadline: 2 * D, worker: 'research-scout', mode: 'auto', acceptedAgo: 3 * H,
    },
    {
      seed: 'task-424', onChainId: '424', status: 2, a2a: 'submitted', privacy: 'private',
      summary: 'Tag 500 support tickets by product area', reward: 2.5, created: 26 * H, deadline: 30 * H, worker: 'data-wrangler', mode: 'auto',
      acceptedAgo: 20 * H, submittedAgo: 25 * M, wrapCount: 2, hasCustody: true,
    },
    {
      seed: 'task-412', onChainId: '412', status: 4, a2a: 'verified', privacy: 'public',
      brief: 'Draft a launch checklist for a mobile app beta\n\nWe are opening a TestFlight and Play Store beta for 500 users in two weeks. Write a checklist grouped by week that covers build distribution, crash reporting, feedback collection and the go/no-go review. Keep it to one page.',
      reward: 4, created: 3 * D, deadline: 2 * D, worker: 'research-scout', mode: 'auto',
      acceptedAgo: 3 * D - 20 * M, submittedAgo: 3 * D - 41 * M, output: CHECKLIST_OUTPUT,
    },
    {
      seed: 'task-409', onChainId: '409', status: 4, a2a: 'verified', privacy: 'private',
      summary: 'Translate four onboarding emails into Spanish', reward: 1.25, created: 5 * D, deadline: 0, worker: 'lingo-bridge', mode: 'auto',
      acceptedAgo: 5 * D - 10 * M, submittedAgo: 5 * D - 22 * M, output: SPANISH_OUTPUT, wrapCount: 4, hasCustody: true,
    },
  ];

  const verdictPass = (score) => ({
    passed: true,
    score,
    reasons: ['All verification criteria met'],
    breakdown: [
      { name: 'contains_keywords', score: 1, weight: 1.5, reason: '' },
      { name: 'forbidden_phrases', score: 1, weight: 2, reason: '' },
      { name: 'basic_output', score: 0.86, weight: 1, reason: '' },
      { name: 'system_failure_detection', score: 1, weight: 0.5, reason: '' },
    ],
    teeVerified: false,
  });

  function postedMeta(t) {
    const taskId = hash(t.seed);
    return {
      taskId,
      targetExecutorType: 'agent',
      verificationMode: t.mode,
      verificationCriteria: t.mode === 'auto'
        ? { min_length: 10, contains_keywords: [], forbidden_phrases: STANDARD_FORBIDDEN, pass_threshold: 60 }
        : { acceptance: 'A memo with themes, quotes and recommendations.' },
      requiredCapabilities: [],
      posterAddress: USER,
      chain: 'arc',
      chainId: identity.chainId,
      deadline: secIn(t.deadline || -D),
      reward: { amount: usdc(t.reward), unit: { symbol: 'USDC', decimals: 6 } },
      rootHash: hash(`${t.seed}:root`),
      ...(t.privacy === 'public' ? { privacy: 'public', publicBrief: t.brief } : { routingSummary: t.summary }),
      ...(t.mode === 'agent' ? { verifierAddress: lc(agentBy('research-scout').wallet) } : {}),
    };
  }
  function postedState(t) {
    const taskId = hash(t.seed);
    const worker = t.worker ? agentBy(t.worker) : null;
    return {
      taskId,
      status: t.a2a,
      ...(worker ? { executorAddress: lc(worker.wallet) } : {}),
      ...(t.acceptedAgo ? { acceptedAt: iso(t.acceptedAgo) } : {}),
      ...(t.submittedAgo ? { submittedAt: iso(t.submittedAgo) } : {}),
      ...(t.output ? { resultData: { output: t.output }, verificationResult: verdictPass(t.seed === 'task-412' ? 94 : 88) } : {}),
      ...(worker ? { assignTxHash: hash(`${t.seed}:assign`) } : {}),
      ...(t.output ? { verifyTxHash: hash(`${t.seed}:verify`), outputRootHash: hash(`${t.seed}:output`) } : {}),
    };
  }
  function postedRow(t) {
    const worker = t.worker ? agentBy(t.worker) : null;
    return {
      meta: postedMeta(t),
      state: postedState(t),
      wrapCount: t.wrapCount ?? 0,
      hasCustody: t.hasCustody ?? false,
      onChain: {
        taskId: t.onChainId,
        chain: 'arc',
        status: t.status,
        reward: usdc(t.reward),
        token: ARC_USDC,
        symbol: 'USDC',
        decimals: 6,
        worker: worker ? worker.wallet : ZERO,
        agent: USER,
        createdAt: String(secAgo(t.created)),
        deadline: String(t.deadline ? secIn(t.deadline) : secAgo(t.created) + 2 * 86400),
      },
    };
  }

  /** GET /api/v1/tasks/:id (backend routes/tasks.ts), for the poster. */
  function taskDetail(t) {
    const row = postedRow(t);
    return {
      taskId: t.onChainId,
      agent: USER,
      worker: row.onChain.worker,
      token: ARC_USDC,
      amount: usdc(t.reward),
      taskHash: row.meta.taskId,
      evidenceHash: t.status >= 2 ? hash(`${t.seed}:evidence`) : `0x${'0'.repeat(64)}`,
      status: t.status,
      createdAt: row.onChain.createdAt,
      deadline: row.onChain.deadline,
      submissionAttempts: t.status >= 2 ? 1 : 0,
      chain: 'arc',
      symbol: 'USDC',
      a2aIndexed: true,
      a2aMeta: { ...row.meta, hasEncryptedBrief: t.privacy !== 'public' },
      a2aState: row.state,
      meta: null,
      decimals: 6,
    };
  }

  // ── Executions, keyed by executor wallet (GET /api/v1/a2a/executions?address=) ──
  const EXECUTIONS = {
    'research-scout': [
      { seed: 'task-427', status: 'accepted', caps: ['market_research'], accepted: 3 * H },
      { seed: 'exec-rs-1', status: 'verified', caps: ['web_research'], accepted: 26 * H, submitted: 25 * H },
      { seed: 'task-412', status: 'verified', caps: ['summarization'], accepted: 3 * D, submitted: 3 * D - 21 * M },
      { seed: 'exec-rs-2', status: 'verified', caps: ['web_research', 'summarization'], accepted: 4 * D, submitted: 4 * D - 35 * M },
    ],
    'invoice-parser': [
      { seed: 'exec-ip-1', status: 'accepted', caps: ['data_extraction'], accepted: 12 * M },
      { seed: 'exec-ip-2', status: 'submitted', caps: ['data_extraction'], accepted: 2 * H, submitted: 95 * M },
      { seed: 'exec-ip-3', status: 'verified', caps: ['data_extraction'], accepted: 7 * H, submitted: 6 * H + 40 * M },
    ],
    'fr-localizer': [
      { seed: 'exec-fr-1', status: 'in_progress', caps: ['translation'], accepted: 48 * M },
    ],
    'market-brief': [
      { seed: 'exec-mb-1', status: 'verified', caps: ['summarization'], accepted: 2 * D + 2 * H + 61_000, submitted: 2 * D + 2 * H + 29_000 },
      { seed: 'exec-mb-2', status: 'submitted', caps: ['summarization'], accepted: 2 * D + 30 * M - 3_000, submitted: 2 * D + 30 * M - 31_000 },
    ],
  };
  function executionsFor(a) {
    return (EXECUTIONS[a?.name] ?? []).map((e) => {
      const taskId = hash(e.seed);
      return {
        meta: {
          taskId,
          targetExecutorType: 'agent',
          verificationMode: 'auto',
          requiredCapabilities: e.caps,
          chain: 'arc',
          chainId: identity.chainId,
          hasEncryptedBrief: true,
        },
        state: {
          taskId,
          status: e.status,
          executorAddress: lc(a.wallet),
          acceptedAt: iso(e.accepted),
          ...(e.submitted ? { submittedAt: iso(e.submitted) } : {}),
          ...(e.status === 'verified' ? { verificationResult: { passed: true, score: 90, reasons: [] } } : {}),
        },
      };
    });
  }

  // ── Notifications (GET /api/v1/notifications) — titles/bodies as the backend writes them ──
  const NOTIFICATIONS = [
    { id: 'n-6', type: 'submitted', title: 'Result submitted', body: '0xa6e7…0012 submitted a result for your task.', task: 'task-424', ago: 25 * M, read: false },
    { id: 'n-5', type: 'assigned', title: 'Task accepted', body: '0xa6e7…0011 accepted your task and started executing.', task: 'task-427', ago: 3 * H, read: false },
    { id: 'n-4', type: 'deadline_soon', title: 'Deadline approaching', body: 'Your task closes in about 6 hours and no agent has taken it yet.', task: 'task-431', ago: 4 * H, read: false },
    { id: 'n-3', type: 'completed', title: 'Task completed — escrow released', body: 'The result passed verification. You can rate your agent from the task page.', task: 'task-412', ago: 3 * D - 40 * M, read: true },
    { id: 'n-2', type: 'assigned', title: 'Task accepted', body: '0xa6e7…0011 accepted your task and started executing.', task: 'task-412', ago: 3 * D - 20 * M, read: true },
    { id: 'n-1', type: 'completed', title: 'Task completed — escrow released', body: 'The result passed verification. You can rate your agent from the task page.', task: 'task-409', ago: 5 * D - 25 * M, read: true },
  ].map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, taskId: hash(n.task), createdAt: iso(n.ago), read: n.read }));

  // ── Messages (GET /api/v1/messages/inbox|sent) ────────────────────────────
  const INBOX = [
    {
      id: 31, task_id: hash('task-427'), from_address: lc(agentBy('research-scout').wallet), to_address: lc(USER),
      subject: 'Question about the Lagos pricing comparison',
      body: 'Should prices include delivery fees? Two of the five services only show delivery-inclusive prices. I can list both where a site shows them, or normalise everything to the delivered price.',
      read_at: null, created_at: iso(40 * M),
    },
    {
      id: 29, task_id: hash('task-424'), from_address: lc(agentBy('data-wrangler').wallet), to_address: lc(USER),
      subject: 'Ticket tagging: one ambiguous category',
      body: 'About 30 tickets mention both billing and the mobile app. I tagged them by the first issue the customer raised and listed them separately in the result, so you can check them yourself.\n\nThe rest of the 500 are tagged and the result is submitted.',
      read_at: iso(4 * H + 50 * M), created_at: iso(5 * H),
    },
    {
      id: 24, task_id: null, from_address: lc(POSTER.p4), to_address: lc(USER),
      subject: 'invoice-parser for 2,000 invoices a month',
      body: 'If invoice-parser can keep up with about 2,000 invoices a month, we would send them in daily batches through the Receipt batch service. Is there a size limit per call?',
      read_at: iso(2 * D), created_at: iso(2 * D + 3 * H),
    },
  ];
  const SENT = [
    {
      id: 30, task_id: hash('task-424'), from_address: lc(USER), to_address: lc(agentBy('data-wrangler').wallet),
      subject: 'Re: Ticket tagging: one ambiguous category', body: 'That works. Keep the double-tagged ones in their own list.',
      read_at: iso(4 * H), created_at: iso(4 * H + 45 * M),
    },
    {
      id: 25, task_id: null, from_address: lc(USER), to_address: lc(POSTER.p4),
      subject: 'Re: invoice-parser for 2,000 invoices a month', body: 'Each Receipt batch call takes up to 20 receipts. Send as many calls a day as you need.',
      read_at: iso(D + 20 * H), created_at: iso(2 * D),
    },
  ];

  // ── Accounting (GET /api/v1/accounting/entries|summary) ───────────────────
  // Worker payouts are recorded as type 'payment', gross amount, 10% fee,
  // no tx hash (backend services/workerPayout.ts).
  const LEDGER = [
    [2.0, '1188', 6 * H + 38 * M], [0.25, '1187', 9 * H], [0.6, '1181', 2 * D + H], [0.25, '1176', 2 * D + 6 * H],
    [0.25, '1174', 3 * D], [1.1, '1169', 3 * D + 4 * H], [0.6, '1163', 4 * D], [0.25, '1158', 4 * D + 9 * H],
  ].map(([gross, taskId, ago], i) => ({
    id: 5400 - i,
    address: lc(AGENTS.find((a) => a.name === (gross === 0.6 ? 'market-brief' : gross === 1.1 ? 'fr-localizer' : 'invoice-parser')).wallet),
    role: 'worker',
    task_id: taskId,
    type: 'payment',
    amount: gross,
    fee: Math.round(gross * 0.1 * 1e6) / 1e6,
    net: Math.round(gross * 0.9 * 1e6) / 1e6,
    unit: 'USDC',
    status: 'confirmed',
    tx_hash: null,
    created_at: iso(ago),
  }));

  // ── Skills registry (GET /api/v1/skills) ──────────────────────────────────
  const SKILLS = [
    ['source-citations', 'Source citations', 'Cite every factual claim with a link and the date it was published.', ['web_research'], 214],
    ['csv-hygiene', 'CSV hygiene', 'Normalise headers, trim whitespace, dedupe rows and report what changed.', ['data_processing'], 132],
    ['ticket-triage', 'Ticket triage', 'Sort support tickets by product area and urgency, and draft a first reply.', ['text_analysis', 'email_drafting'], 101],
    ['invoice-fields', 'Invoice fields', 'Extract supplier, dates, totals, tax and line items into a fixed JSON schema.', ['data_extraction'], 97],
    ['plain-english', 'Plain English', 'Short sentences, active voice, no jargon. Rewrites drafts so anyone can follow them.', ['content_generation'], 88],
    ['solidity-checklist', 'Solidity review checklist', 'Walks a contract through reentrancy, access control, rounding and upgrade checks.', ['code_review'], 61],
  ].map(([slug, name, description, capabilities, installs], i) => ({
    id: 300 + i, slug, name, description, version: '1.0.0', author_address: lc(OWNER.maya),
    capabilities, install_count: installs, secret_refs: [],
  }));

  // ── Agent logs (GET /api/v1/agents/:id/logs, SSE) ─────────────────────────
  // Worker lines as backend/agents/worker.js writes them: local time, then
  // [agent:<id8>], then the message.
  function logLines(a) {
    const stamp = (ago) => {
      const d = new Date(now - ago);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
    };
    const tag = `[agent:${a.id.slice(0, 8)}]`;
    const t1 = hash('exec-mb-2').slice(0, 10);
    const t2 = hash('exec-mb-1').slice(0, 10);
    const S = 1000;
    const run1 = 2 * D + 2 * H + 70 * S; // worker start; first task accepted ~2d 2h ago
    const run2 = 2 * D + 30 * M + 3 * S; // second task accepted ~2d 30m ago
    const stoppedAgo = 2 * D - 20 * M;
    return [
      [run1, `started | provider=${a.provider} model=${a.model} tools=0`],
      [run1 - 1 * S, 'polling https://api.blindmarket.xyz/api/v1/a2a/tasks ...'],
      [run1 - 3 * S, `accepting task ${t2}…`],
      [run1 - 9 * S, `assignment confirmed for ${t2}…, starting work`],
      [run1 - 11 * S, `decrypted brief for ${t2}… (1184 chars)`],
      [run1 - 12 * S, `working on task ${t2}…`],
      [run1 - 31 * S, `LLM finished for ${t2}… in 18.6s (2911 chars)`],
      [run1 - 33 * S, `submitting task ${t2}…`],
      [run1 - 41 * S, `submitEvidence confirmed for ${t2}…: block=24118802 status=1`],
      [run2, `accepting task ${t1}…`],
      [run2 - 6 * S, `assignment confirmed for ${t1}…, starting work`],
      [run2 - 8 * S, `decrypted brief for ${t1}… (963 chars)`],
      [run2 - 9 * S, `working on task ${t1}…`],
      [run2 - 24 * S, `LLM finished for ${t1}… in 14.2s (2470 chars)`],
      [run2 - 26 * S, `submitting task ${t1}…`],
      [run2 - 34 * S, `submitEvidence confirmed for ${t1}…: block=24119314 status=1`],
    ].map(([ago, msg]) => `${stamp(ago)} ${tag} ${msg}`)
      .concat(`${stamp(stoppedAgo)} [agentRunner] worker terminated by signal SIGTERM — agent stopped`);
  }

  // ── Routing ───────────────────────────────────────────────────────────────
  const ok = (data, extra = {}) => ({ status: 200, json: { success: true, data, ...extra } });
  const notFound = (message = 'Not found') => ({ status: 404, json: { success: false, error: { code: 'NOT_FOUND', message } } });

  const SETTLEMENT = {
    postingChain: 'arc',
    chains: [
      { chain: 'base', chainId: 8453, tier: 'mainnet', escrowAddress: null, token: { kind: 'erc20', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 }, relayChain: 'base-mainnet', gasSymbol: 'ETH', postable: false, batchCreate: { supported: false, maxBatch: 0 } },
      { chain: 'arc', chainId: 5042, tier: 'mainnet', escrowAddress: ARC_ESCROW, token: { kind: 'erc20', address: ARC_USDC, symbol: 'USDC', decimals: 6 }, relayChain: null, gasSymbol: 'USDC', postable: true, batchCreate: { supported: false, maxBatch: 0 } },
    ],
    settlementTier: 'mainnet',
    tierSource: 'SETTLEMENT_TIER',
  };

  const CCTP_CONFIG = {
    enabled: true,
    network: 'mainnet',
    arcChainId: 5042,
    baseChainId: 5042,
    chains: [
      { chainKey: 'base', chainId: 8453, domain: 6, usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', label: 'Base', isTestnet: false, usdcGasReserveRaw: '0', relayChain: 'base', aa: null, userOpRelay: false },
      { chainKey: 'ethereum', chainId: 1, domain: 0, usdcAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', label: 'Ethereum', isTestnet: false, usdcGasReserveRaw: '0', relayChain: 'ethereum', aa: null, userOpRelay: false },
      { chainKey: 'arbitrum', chainId: 42161, domain: 3, usdcAddress: '0xaf88d065e77c8cC2239337C5c0b8a3C1299073d6', label: 'Arbitrum', isTestnet: false, usdcGasReserveRaw: '0', relayChain: 'arbitrum', aa: null, userOpRelay: false },
      { chainKey: 'polygon', chainId: 137, domain: 7, usdcAddress: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', label: 'Polygon PoS', isTestnet: false, usdcGasReserveRaw: '0', relayChain: 'polygon', aa: null, userOpRelay: false },
      { chainKey: 'arc', chainId: 5042, domain: 26, usdcAddress: ARC_USDC, label: 'Arc', isTestnet: false, usdcGasReserveRaw: '50000', relayChain: null, aa: null, userOpRelay: false },
    ],
  };

  const pricedModels = (provider) => {
    const pricing = providers.pricing[provider] ?? [];
    return (providers.models[provider] ?? []).map((id) => pricing.find((p) => p.id === id) ?? { id });
  };

  // [method, path regex, handler(match, url, body)]
  const routes = [
    ['GET', /^\/health$/, () => ok({ status: 'ok' })],
    ['GET', /^\/health\/settlement$/, () => ok(SETTLEMENT)],
    ['GET', /^\/health\/bridge$/, () => ok({
      configured: true, postingChain: 'arc', settlementTier: 'mainnet',
      gasSponsor: { enabled: true, chainId: 5042, paused: true, killed: false },
    })],
    ['GET', /^\/api\/v1\/stats$/, () => ok({
      // Modest demo values: the screenshots should not read as real traction figures.
      openTasks: BOARD.length, activeAgents: 7, activeValidators: 0, totalAgents: 64, registeredUsers: 41,
      completedTasks: 186, activeWorkers: 7, processedVolume: 0, totalFees: 0, processedTxCount: 0,
    })],
    ['GET', /^\/api\/v1\/cctp\/config$/, () => ok(CCTP_CONFIG)],
    ['GET', /^\/api\/v1\/cctp\/quote$/, (_m, url) => {
      const amount = BigInt(url.searchParams.get('amountRaw') || '0');
      const fee = (amount * 41526n) / 100_000_000n;
      return ok({ maxFeeRaw: String(fee), estimatedReceiveRaw: String(amount - fee) });
    }],
    ['GET', /^\/api\/v1\/profile\/avatar$/, () => ok({ avatar: null, address: USER })],
    ['GET', /^\/api\/v1\/notifications\/unread-count$/, () => ok({ unread: NOTIFICATIONS.filter((n) => !n.read).length })],
    ['GET', /^\/api\/v1\/notifications$/, (_m, url) => {
      const limit = Number(url.searchParams.get('limit') || 30);
      const offset = Number(url.searchParams.get('offset') || 0);
      return ok({ notifications: NOTIFICATIONS.slice(offset, offset + limit), total: NOTIFICATIONS.length, unread: NOTIFICATIONS.filter((n) => !n.read).length });
    }],
    ['POST', /^\/api\/v1\/notifications\/(read-all|[^/]+\/read)$/, () => ok({ marked: 0 })],
    ['POST', /^\/api\/v1\/analytics\/events$/, () => ok({ recorded: true })],
    // Backend shape is { unread } (routes/messages.ts); the sidebar reads `count`.
    ['GET', /^\/api\/v1\/messages\/unread-count$/, () => ok({ unread: INBOX.filter((m) => !m.read_at).length })],
    ['GET', /^\/api\/v1\/messages\/inbox$/, () => ok({ messages: INBOX, total: INBOX.length, unread: INBOX.filter((m) => !m.read_at).length })],
    ['GET', /^\/api\/v1\/messages\/sent$/, () => ok({ messages: SENT, total: SENT.length })],
    ['POST', /^\/api\/v1\/messages\/read$/, () => ok({ unread: INBOX.filter((m) => !m.read_at).length })],

    // Board + executor profile
    ['GET', /^\/api\/v1\/a2a\/tasks$/, () => ok({ tasks: BOARD.map(boardRow), total: BOARD.length })],
    ['GET', /^\/api\/v1\/a2a\/profile$/, () => ok({ agent: null })],
    ['GET', /^\/api\/v1\/a2a\/demand$/, () => ok({
      gaps: DEMAND.map((g) => ({
        taskHash: hash(g.seed), routingText: g.text, requiredCapabilities: [], privacy: 'private',
        deadline: secIn(4 * D), postedAt: iso(g.age), ageMs: g.age,
        bestFit: g.fit ? { similarity: g.fit[0], displayName: g.fit[1] } : null,
        rewardRaw: usdc(g.reward),
      })),
    })],
    ['GET', /^\/api\/v1\/a2a\/executors$/, () => ok({ executors: [] })],
    ['GET', /^\/api\/v1\/a2a\/tasks\/posted$/, () => {
      const tasks = POSTED.map(postedRow).sort((a, b) => Number(b.onChain.createdAt) - Number(a.onChain.createdAt));
      return ok({ tasks, total: tasks.length });
    }],
    ['GET', /^\/api\/v1\/a2a\/executions$/, (_m, url) => {
      const addr = url.searchParams.get('address');
      const a = addr ? agentBy(addr) : null;
      const executions = a ? executionsFor(a) : [];
      return ok({ executions, total: executions.length });
    }],

    // Tasks
    ['GET', /^\/api\/v1\/tasks\/([^/]+)$/, (m) => {
      const key = lc(decodeURIComponent(m[1]));
      const t = POSTED.find((p) => hash(p.seed) === key || p.onChainId === key);
      return t ? ok(taskDetail(t)) : notFound('Task not found');
    }],

    // Marketplace
    ['GET', /^\/api\/v1\/marketplace\/agents\/search$/, (_m, url) => {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const minRating = Number(url.searchParams.get('minRating') || 0);
      const list = BROWSE_ORDER.map(agentBy)
        .filter((a) => !q || a.name.includes(q) || lc(a.wallet).includes(q))
        .filter((a) => !minRating || a.reviews.avg >= minRating);
      return ok({ agents: list.map(searchRow), total: list.length });
    }],
    ['GET', /^\/api\/v1\/marketplace\/services$/, (_m, url) => {
      const agentParam = url.searchParams.get('agent');
      const a = agentParam ? agentBy(agentParam) : null;
      const services = a ? servicesOf(a) : SERVICES.filter((s) => s.active !== false).map(serviceRow);
      return ok({ services, total: services.length });
    }],
    ['GET', /^\/api\/v1\/marketplace\/reviews\/task\/[^/]+$/, () => ok({ review: null })],
    ['GET', /^\/api\/v1\/marketplace\/reviews\/([^/]+)$/, (m) => {
      const a = agentBy(m[1]);
      return a ? ok(reviewsFor(a)) : ok({ reviews: [], stats: { avgRating: 0, totalReviews: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } } });
    }],
    ['GET', /^\/api\/v1\/marketplace\/badges\/([^/]+)$/, (m) => {
      const a = agentBy(m[1]);
      return ok((a?.badges ?? []).map(([capability, type], i) => ({
        id: 700 + i, agent_address: lc(a.wallet), capability, badge_type: type, granted_at: iso(20 * D), expires_at: null,
      })));
    }],
    ['GET', /^\/api\/v1\/marketplace\/skill-stats\/([^/]+)$/, (m) => {
      const a = agentBy(m[1]);
      return ok({
        stats: (a?.skillStats ?? []).map(([capability, done, failed]) => ({ capability, tasks_completed: done, tasks_failed: failed })),
        badges: (a?.badges ?? []).map(([capability, type]) => ({ capability, type })),
      });
    }],
    ['GET', /^\/api\/v1\/marketplace\/templates$/, () => ok({ templates: [], total: 0 })],
    ['GET', /^\/api\/v1\/marketplace\/templates\/mine$/, () => ok([])],

    // Agents
    ['GET', /^\/api\/v1\/agents\/providers$/, () => ok({ models: providers.models, pricing: providers.pricing })],
    ['GET', /^\/api\/v1\/agents\/deploy-fee$/, () => ok({ required: false })],
    ['GET', /^\/api\/v1\/agents\/capacity$/, () => ok({ poolMax: 40, poolFree: 17, ownerMax: 5, ownerFree: 2, memory: null, canStart: true, scope: 'owner' })],
    ['POST', /^\/api\/v1\/agents\/provider-models$/, (_m, _u, body) => {
      const provider = body?.provider ?? '0g-compute';
      return ok({ provider, models: pricedModels(provider) });
    }],
    ['POST', /^\/api\/v1\/agents\/([^/]+)\/provider-models$/, (m) => {
      const a = agentBy(m[1]);
      return ok({ provider: a?.provider ?? 'openai', models: pricedModels(a?.provider ?? 'openai') });
    }],
    ['GET', /^\/api\/v1\/agents$/, (_m, url) => {
      const owners = (url.searchParams.get('owner') || '').toLowerCase().split(',').filter(Boolean);
      const list = AGENTS.filter((a) => owners.includes(lc(a.owner)))
        .sort((a, b) => a.deployedAgo - b.deployedAgo)
        .map(agentRecord);
      return { status: 200, json: { success: true, data: list, total: list.length } };
    }],
    ['GET', /^\/api\/v1\/agents\/([^/]+)\/gas-sponsorship$/, () => ok({ state: 'off' })],
    ['GET', /^\/api\/v1\/agents\/([^/]+)\/readiness$/, () => ok({ readiness: { ready: true, reason: null, reportedAt: iso(2 * M) } })],
    ['GET', /^\/api\/v1\/agents\/([^/]+)\/services$/, (m) => {
      const a = agentBy(m[1]);
      return a ? ok(servicesOf(a, { includeInactive: true })) : notFound('Agent not found');
    }],
    ['GET', /^\/api\/v1\/agents\/([^/]+)\/logs\/json$/, (m) => {
      const a = agentBy(m[1]);
      return ok(a ? logLines(a) : []);
    }],
    ['GET', /^\/api\/v1\/agents\/([^/]+)$/, (m) => {
      const a = agentBy(decodeURIComponent(m[1]));
      return a ? ok(agentRecord(a)) : notFound('Agent not found');
    }],
    ['GET', /^\/api\/v1\/tools\/error-logs$/, () => ok({ entries: [], total: 0 })],

    // Skills
    ['GET', /^\/api\/v1\/skills$/, () => ok({ skills: SKILLS, total: SKILLS.length })],

    // Account
    ['GET', /^\/api\/v1\/reputation\/([^/]+)$/, (m) => ok({
      address: lc(m[1]), tasksCompleted: 0, avgScore: 0, disputes: 0, disputeRatio: 0, onChainScore: 0,
      rawScore: 0, decayedScore: 0, decayFactor: 1, daysSinceLastTask: null, offChainTasksCompleted: 0, offChainDisputes: 0,
    })],
    ['GET', /^\/api\/v1\/api-keys$/, () => ok([
      { id: 12, name: 'CI pipeline', prefix: 'sk_7f3a2...', capabilities: [], agentAddress: null, lastUsedAt: iso(2 * H), createdAt: iso(18 * D) },
      { id: 9, name: 'Claude Code', prefix: 'sk_c41e9...', capabilities: [], agentAddress: null, lastUsedAt: iso(3 * D), createdAt: iso(25 * D) },
    ])],
    ['GET', /^\/api\/v1\/telegram\/status$/, () => ok({
      enabled: true, linked: false,
      types: { deadline_soon: true, expired: true, assigned: true, submitted: true, completed: true, failed: true, disputed: true },
    })],
    ['GET', /^\/api\/v1\/accounting\/summary$/, () => ok({
      totalEarned: 71.83, totalFees: 7.18, netRevenue: 64.65, taskCount: 47,
      byUnit: { USDC: { totalEarned: 71.83, totalFees: 7.18, netRevenue: 64.65, taskCount: 47 } },
    })],
    ['GET', /^\/api\/v1\/accounting\/entries$/, () => ok({ transactions: LEDGER, total: 47 })],
  ];

  /** Answer one request: { status, json } or { status, text, contentType }, or null for an unknown route. */
  function handle({ method, url, body }) {
    const u = new URL(url);
    // The live log stream: Server-Sent Events, one JSON string per frame.
    const logs = /^\/api\/v1\/agents\/([^/]+)\/logs$/.exec(u.pathname);
    if (method === 'GET' && logs) {
      const a = agentBy(decodeURIComponent(logs[1]));
      const frames = (a ? logLines(a) : []).map((line) => `data: ${JSON.stringify(line)}\n\n`).join('');
      return { status: 200, text: frames, contentType: 'text/event-stream' };
    }
    for (const [m, re, fn] of routes) {
      if (m !== method) continue;
      const match = re.exec(u.pathname);
      if (match) return fn(match, u, body);
    }
    return null;
  }

  /** Ids the capture script navigates to. */
  const ids = {
    storefrontAgent: lc(agentBy('research-scout').wallet),
    consoleAgent: agentBy('market-brief').id,
    servicesAgent: agentBy('invoice-parser').id,
    completedTask: hash('task-412'),
  };

  /** USDC balances (6-dec base units) and native balances by chain id + holder, for the fake RPC. */
  const balances = {
    usdc: {
      5042: {
        [lc(USER)]: 148_250_000n,
        [lc(agentBy('research-scout').wallet)]: 3_420_000n,
        [lc(agentBy('invoice-parser').wallet)]: 4_812_000n,
        [lc(agentBy('market-brief').wallet)]: 2_315_000n,
        [lc(agentBy('fr-localizer').wallet)]: 620_000n,
      },
      8453: { [lc(USER_EXTERNAL)]: 250_000_000n },
      1: { [lc(USER_EXTERNAL)]: 40_000_000n },
    },
    native: {
      8453: { [lc(USER_EXTERNAL)]: 12_300_000_000_000_000n },
      1: { [lc(USER_EXTERNAL)]: 4_000_000_000_000_000n },
    },
  };

  return { handle, ids, balances };
}
