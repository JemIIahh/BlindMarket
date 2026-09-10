/**
 * Seeds the public task-template catalog with 100 task types.
 *
 * Why: `GET /api/v1/marketplace/templates` currently returns an empty list, so
 * the "Task templates" page (frontend/src/pages/TaskTemplates.tsx) shows only
 * its EmptyState and PostTask has no starting points. This fills that catalog.
 *
 * Shape follows the OKX.AI task marketplace: every entry is a *specific* job
 * with concrete parameters baked into the brief (their "Calculate Health Factor"
 * task reads "…for a position with 2 ETH collateral and 3,000 USDT debt"), not
 * an abstract category label. A poster picks one and edits the numbers.
 *
 * Categories: `task_templates` has NO category column — migration 10
 * (`drop_task_templates_category`, backend/src/services/neonDb.ts) dropped it.
 * So the category lives in this file as the grouping axis, and is projected
 * into the row through `required_capabilities`, which is the taxonomy the
 * matcher actually reads (AGENT_CAPABILITIES, backend/src/types.ts). Every tag
 * used here is a member of that 20-value enum.
 *
 * Pricing: `suggested_reward` is a plain decimal string rendered verbatim by the
 * browse card. Values are sized for a USDC settlement layer (0.01–30), matching
 * OKX's per-use pricing band. NOTE: the card currently labels it with
 * getNativeCurrency(activeChain).symbol — "ETH" on Base — while task rewards are
 * actually denominated in USDC there (see getPaymentSymbol(), constants.ts:146).
 * That label is wrong independently of this seed.
 *
 * SAFETY: refuses to run against a non-local DATABASE_URL unless --force is
 * passed. Idempotent — an entry whose name already exists is skipped, so
 * re-running tops the catalog up rather than duplicating it.
 *
 * Usage:
 *   cd backend
 *   DATABASE_URL='postgres://localhost:5432/blindmarket?sslmode=disable' \
 *     npx tsx scripts/seed-task-templates.ts
 *
 *   # preview without writing
 *   … npx tsx scripts/seed-task-templates.ts --dry-run
 *
 *   # remove everything this script inserted
 *   … npx tsx scripts/seed-task-templates.ts --undo
 */
import 'dotenv/config';
import { getPool } from '../src/services/neonDb.js';

/** A single seeded task type. */
interface SeedTemplate {
  name: string;
  description: string;
  /** Decimal string, USDC-denominated on Base. */
  reward: string;
  /** Subset of AGENT_CAPABILITIES (backend/src/types.ts). */
  capabilities: string[];
  /** Matches createTaskSchema.verificationCriteria (backend/src/routes/tasks.ts). */
  criteria: Record<string, unknown>;
}

interface Category {
  name: string;
  templates: SeedTemplate[];
}

const CATEGORIES: Category[] = [
  {
    name: 'Trading & market signals',
    templates: [
      {
        name: 'Perp Funding Rate Snapshot',
        description:
          'Report the current funding rate, open interest and 24h OI change for BTC and ETH perpetuals on Binance, Bybit and Hyperliquid. Flag any venue where funding exceeds ±0.05% per 8h and state which side is paying.',
        reward: '0.5',
        capabilities: ['market_research', 'data_extraction', 'report_generation'],
        criteria: { required_fields: ['venue', 'funding_rate', 'open_interest'], contains_keywords: ['funding', 'open interest'], min_length: 200 },
      },
      {
        name: 'Mean Reversion Signal Scan',
        description:
          'Scan the top 50 spot pairs by 24h volume for assets trading more than 2 standard deviations below their 20-day moving average. Return ticker, z-score, current price and 20d MA, sorted by z-score ascending.',
        reward: '1',
        capabilities: ['market_research', 'math_computation', 'data_extraction'],
        criteria: { required_fields: ['ticker', 'z_score', 'price'], contains_keywords: ['standard deviation', 'moving average'], min_length: 150 },
      },
      {
        name: 'Breakout Watchlist for Tomorrow',
        description:
          'Identify up to 10 liquid altcoins (>$20M 24h volume) that have consolidated inside a range narrower than 4% for at least 72 hours. For each give range high, range low, volume trend and a breakout invalidation level.',
        reward: '1',
        capabilities: ['market_research', 'data_extraction', 'report_generation'],
        criteria: { required_fields: ['ticker', 'range_high', 'range_low', 'invalidation'], max_length: 4000, min_length: 200 },
      },
      {
        name: 'Daily Crypto Market Recap',
        description:
          'Summarise the last 24 hours across BTC, ETH and SOL: price change, dominant narrative, largest liquidation cluster, and one notable ETF or macro headline. Plain prose, no financial advice, maximum 400 words.',
        reward: '0.2',
        capabilities: ['market_research', 'summarization', 'content_generation'],
        criteria: { contains_keywords: ['BTC', 'ETH', 'SOL'], max_length: 2800, min_length: 400, forbidden_phrases: ['financial advice', 'guaranteed'] },
      },
      {
        name: 'Liquidation Heatmap Summary',
        description:
          'Report where the largest long and short liquidation clusters sit for BTC and ETH within ±10% of spot, with total notional at each level and the single price that would trigger the most forced selling.',
        reward: '0.5',
        capabilities: ['market_research', 'data_extraction', 'math_computation'],
        criteria: { required_fields: ['asset', 'price_level', 'notional', 'side'], contains_keywords: ['liquidation'], min_length: 150 },
      },
      {
        name: 'Options Skew Read',
        description:
          'Report 7-day and 30-day 25-delta skew and at-the-money implied volatility for BTC and ETH, then state in two sentences whether positioning is bid for calls or puts and how that has shifted week over week.',
        reward: '0.5',
        capabilities: ['market_research', 'math_computation', 'text_analysis'],
        criteria: { required_fields: ['tenor', 'skew_25d', 'atm_iv'], contains_keywords: ['skew', 'implied volatility'], min_length: 150 },
      },
      {
        name: 'Stablecoin Flow Check',
        description:
          'Report net 7-day mint and burn for USDT, USDC and DAI plus aggregate exchange netflow, and say in a short paragraph what it implies about incoming spot bid. Include the data source for each figure.',
        reward: '0.3',
        capabilities: ['market_research', 'data_extraction', 'report_generation'],
        criteria: { required_fields: ['stablecoin', 'net_mint', 'exchange_netflow', 'source'], contains_keywords: ['USDT', 'USDC'], min_length: 200 },
      },
      {
        name: 'Copy-Trading Signal Digest',
        description:
          'Condense the last 7 days of a signal provider’s calls into a table with entry, target, stop, outcome and R multiple per trade, then report win rate, average R and maximum drawdown across the set.',
        reward: '2',
        capabilities: ['data_processing', 'math_computation', 'report_generation'],
        criteria: { required_fields: ['entry', 'target', 'stop', 'outcome', 'r_multiple'], contains_keywords: ['win rate'], min_length: 200 },
      },
      {
        name: 'Cross-Exchange Spread Report',
        description:
          'For BTC, ETH and SOL report the best bid, best ask and spread in basis points across five named venues at a single timestamp, and flag every pair/venue where the spread exceeds 15bps.',
        reward: '0.3',
        capabilities: ['api_integration', 'data_extraction', 'math_computation'],
        criteria: { required_fields: ['venue', 'asset', 'bid', 'ask', 'spread_bps'], min_length: 150 },
      },
    ],
  },
  {
    name: 'Crypto research & on-chain intel',
    templates: [
      {
        name: 'Token Due Diligence Brief',
        description:
          'Produce a due-diligence brief on a named ERC-20: contract address, supply and emissions, top-10 holder concentration, liquidity depth, team and funding history, audit status, and three concrete red flags if any exist.',
        reward: '3',
        capabilities: ['web_research', 'data_extraction', 'report_generation'],
        criteria: { required_fields: ['contract_address', 'supply', 'holder_concentration', 'liquidity', 'audit_status'], regex_pattern: '0x[a-fA-F0-9]{40}', min_length: 600 },
      },
      {
        name: 'Smart Money Wallet Trace',
        description:
          'Given a wallet address, list its last 30 days of DEX activity: tokens bought and sold, notional per trade, realised PnL, current open positions, and the three tokens it accumulated most aggressively.',
        reward: '1.5',
        capabilities: ['data_extraction', 'api_integration', 'data_processing'],
        criteria: { required_fields: ['token', 'side', 'notional', 'realised_pnl'], regex_pattern: '0x[a-fA-F0-9]{40}', min_length: 200 },
      },
      {
        name: 'New Token Launch Screen',
        description:
          'Screen tokens launched in the last 48 hours on a named chain. Exclude anything with under $50k liquidity or a mint function still open. Return name, address, liquidity, holder count, and deployer launch history.',
        reward: '1',
        capabilities: ['web_research', 'data_extraction', 'data_processing'],
        criteria: { required_fields: ['name', 'address', 'liquidity', 'holder_count'], contains_keywords: ['liquidity', 'deployer'], min_length: 200 },
      },
      {
        name: 'Protocol Revenue Breakdown',
        description:
          'Break down a named protocol’s last-quarter revenue by source, state the split between what accrues to the treasury and what accrues to token holders, and compare fee take rate against two named competitors.',
        reward: '2',
        capabilities: ['market_research', 'competitive_analysis', 'report_generation'],
        criteria: { required_fields: ['revenue_source', 'amount', 'treasury_share', 'holder_share'], contains_keywords: ['revenue', 'take rate'], min_length: 400 },
      },
      {
        name: 'Airdrop Eligibility Checklist',
        description:
          'For a named upcoming airdrop, list every published or credibly reported eligibility criterion, the snapshot date if known, and a step-by-step checklist a wallet can follow. Mark each criterion confirmed or speculative.',
        reward: '0.5',
        capabilities: ['web_research', 'summarization', 'report_generation'],
        criteria: { required_fields: ['criterion', 'status'], contains_keywords: ['eligibility', 'snapshot'], forbidden_phrases: ['guaranteed'], min_length: 300 },
      },
      {
        name: 'Bridge Flow Analysis',
        description:
          'Report 30-day net bridged value in and out of a named L2, broken down by bridge and by asset, and identify the single largest net inflow week and what coincided with it.',
        reward: '1.5',
        capabilities: ['data_extraction', 'data_processing', 'report_generation'],
        criteria: { required_fields: ['bridge', 'asset', 'net_flow'], contains_keywords: ['inflow', 'outflow'], min_length: 250 },
      },
      {
        name: 'Governance Proposal Digest',
        description:
          'Summarise every governance proposal for a named DAO from the last 30 days: title, what it changes, current vote tally, quorum status, and a one-line note on who benefits. Neutral tone, no voting recommendation.',
        reward: '0.5',
        capabilities: ['web_research', 'summarization', 'document_processing'],
        criteria: { required_fields: ['title', 'summary', 'vote_tally', 'quorum_status'], forbidden_phrases: ['you should vote'], min_length: 300 },
      },
      {
        name: 'Holder Concentration Report',
        description:
          'For a named token, report the share of supply held by the top 10, top 50 and top 100 addresses, exclude known exchange and contract addresses, and flag any cluster of wallets funded from a common source.',
        reward: '1',
        capabilities: ['data_extraction', 'data_processing', 'math_computation'],
        criteria: { required_fields: ['top_10_share', 'top_50_share', 'top_100_share'], contains_keywords: ['concentration'], min_length: 200 },
      },
      {
        name: 'Narrative Momentum Scan',
        description:
          'Rank five named crypto narratives by 7-day momentum using mention volume, aggregate market cap change and new-token launch count. Show the metric behind each rank rather than an unexplained score.',
        reward: '1',
        capabilities: ['market_research', 'social_media', 'data_processing'],
        criteria: { required_fields: ['narrative', 'mention_volume', 'mcap_change', 'rank'], min_length: 250 },
      },
    ],
  },
  {
    name: 'DeFi tools & calculators',
    templates: [
      {
        name: 'Calculate Lending Health Factor',
        description:
          'Calculate the health factor, liquidation price and risk level for a lending position of 2 ETH collateral against 3,000 USDT debt on a named protocol. Show the LTV and liquidation threshold used.',
        reward: '0.01',
        capabilities: ['math_computation', 'api_integration'],
        criteria: { required_fields: ['health_factor', 'liquidation_price', 'risk_level'], contains_keywords: ['health factor', 'liquidation'], min_length: 80 },
      },
      {
        name: 'Impermanent Loss Estimate',
        description:
          'Estimate impermanent loss for a 50/50 ETH/USDC LP position opened at ETH $3,000 and valued at ETH $4,200, against simply holding. Report IL percentage, fee income needed to break even, and net position value.',
        reward: '0.05',
        capabilities: ['math_computation', 'data_processing'],
        criteria: { required_fields: ['il_percent', 'breakeven_fees', 'net_value'], contains_keywords: ['impermanent loss'], min_length: 100 },
      },
      {
        name: 'LP Position Yield Projection',
        description:
          'Project 30-day yield for a $10,000 concentrated-liquidity position in a named pool at a stated price range. Include fee APR, expected time in range, and the yield if price exits the range on day 10.',
        reward: '0.2',
        capabilities: ['math_computation', 'data_processing', 'report_generation'],
        criteria: { required_fields: ['fee_apr', 'time_in_range', 'projected_yield'], min_length: 150 },
      },
      {
        name: 'Liquidation Price Calculator',
        description:
          'Given collateral asset and amount, debt asset and amount, and the protocol’s liquidation threshold, return the exact liquidation price and the percentage move from spot that would reach it.',
        reward: '0.01',
        capabilities: ['math_computation'],
        criteria: { required_fields: ['liquidation_price', 'distance_percent'], min_length: 60 },
      },
      {
        name: 'Gas Cost Estimator for a Batch',
        description:
          'Estimate the total gas cost of executing 250 ERC-20 transfers on a named chain at current base fee, compared against one Multicall3 aggregate call. Report both in native units and USD.',
        reward: '0.05',
        capabilities: ['math_computation', 'api_integration'],
        criteria: { required_fields: ['individual_cost', 'batched_cost', 'savings'], contains_keywords: ['gas'], min_length: 100 },
      },
      {
        name: 'Staking Reward Forecast',
        description:
          'Forecast 12-month staking rewards for 100 units of a named asset at the current rate, showing gross rewards, commission, net rewards, and how the result changes if the rate falls 30%.',
        reward: '0.1',
        capabilities: ['math_computation', 'report_generation'],
        criteria: { required_fields: ['gross_rewards', 'commission', 'net_rewards'], min_length: 100 },
      },
      {
        name: 'Portfolio Rebalance Plan',
        description:
          'Given a current portfolio and a target allocation, produce the exact list of buys and sells to rebalance, minimising the number of trades and reporting the estimated slippage and gas cost of the plan.',
        reward: '0.5',
        capabilities: ['math_computation', 'data_processing', 'report_generation'],
        criteria: { required_fields: ['asset', 'action', 'amount'], contains_keywords: ['rebalance'], min_length: 150 },
      },
    ],
  },
  {
    name: 'Security & risk',
    templates: [
      {
        name: 'Smart Contract Risk Review',
        description:
          'Review a supplied Solidity contract for reentrancy, access-control gaps, unchecked external calls, integer issues and upgrade risk. Report each finding with severity, the exact line, and a concrete fix.',
        reward: '5',
        capabilities: ['code_review', 'text_analysis', 'report_generation'],
        criteria: { required_fields: ['severity', 'line', 'finding', 'fix'], contains_keywords: ['severity'], min_length: 400 },
      },
      {
        name: 'Token Approval Audit',
        description:
          'For a given wallet, list every outstanding ERC-20 approval: spender, token, allowance amount, whether it is unlimited, when it was granted, and whether the spender is a known or unverified contract.',
        reward: '0.3',
        capabilities: ['data_extraction', 'api_integration', 'report_generation'],
        criteria: { required_fields: ['spender', 'token', 'allowance', 'is_unlimited'], regex_pattern: '0x[a-fA-F0-9]{40}', min_length: 150 },
      },
      {
        name: 'Rug Pull Risk Screen',
        description:
          'Screen a named token for rug indicators: mint authority, unlocked liquidity, proxy upgradeability, blacklist or transfer-fee functions, and deployer history. Return a per-indicator verdict, not a single opaque score.',
        reward: '0.5',
        capabilities: ['code_review', 'data_extraction', 'report_generation'],
        criteria: { required_fields: ['indicator', 'verdict', 'evidence'], contains_keywords: ['mint', 'liquidity'], min_length: 250 },
      },
      {
        name: 'Phishing URL Triage',
        description:
          'Triage a batch of up to 50 URLs. For each return a verdict of safe, suspicious or malicious with the specific signal behind it — domain age, homoglyph characters, hosting reputation, or a known-bad match.',
        reward: '0.2',
        capabilities: ['web_research', 'text_analysis', 'data_processing'],
        criteria: { required_fields: ['url', 'verdict', 'signal'], contains_keywords: ['suspicious'], min_length: 150 },
      },
      {
        name: 'Wallet Activity Anomaly Alert',
        description:
          'Monitor a named wallet and report any transaction in the last 24 hours that departs from its baseline: a new counterparty, an unusually large transfer, a first-time contract interaction, or an approval to an unverified spender.',
        reward: '0.1',
        capabilities: ['api_integration', 'data_processing', 'text_analysis'],
        criteria: { required_fields: ['tx_hash', 'anomaly_type', 'detail'], regex_pattern: '0x[a-fA-F0-9]{64}', min_length: 100 },
      },
      {
        name: 'Dependency Vulnerability Sweep',
        description:
          'Given a package manifest and lockfile, list every dependency with a known CVE: package, installed version, CVE id, severity, fixed version, and whether the vulnerable path is actually reachable from application code.',
        reward: '1',
        capabilities: ['code_review', 'data_extraction', 'report_generation'],
        criteria: { required_fields: ['package', 'version', 'cve', 'severity', 'fixed_version'], regex_pattern: 'CVE-\\d{4}-\\d+', min_length: 200 },
      },
    ],
  },
  {
    name: 'News & social intelligence',
    templates: [
      {
        name: 'Daily Crypto News Digest',
        description:
          'Collect the 10 most significant crypto stories of the last 24 hours. For each give a one-sentence summary, the primary source link, and why it matters. Exclude price-only commentary and paid promotions.',
        reward: '0.2',
        capabilities: ['web_research', 'summarization', 'content_generation'],
        criteria: { required_fields: ['headline', 'summary', 'source_url', 'why_it_matters'], max_length: 4000, min_length: 400 },
      },
      {
        name: 'KOL Sentiment Snapshot',
        description:
          'For a named token, sample the last 7 days of posts from accounts above 10k followers and report bullish, bearish and neutral counts, the sentiment trend day by day, and the three most-engaged posts on each side.',
        reward: '0.5',
        capabilities: ['social_media', 'text_analysis', 'data_processing'],
        criteria: { required_fields: ['bullish_count', 'bearish_count', 'neutral_count', 'trend'], min_length: 200 },
      },
      {
        name: 'X Account Profile Report',
        description:
          'Profile a named X account: follower count and 30-day growth, posting cadence, dominant topics, top five posts by engagement, and the overlap between its audience and two named comparison accounts.',
        reward: '0.3',
        capabilities: ['social_media', 'web_research', 'report_generation'],
        criteria: { required_fields: ['follower_count', 'growth_30d', 'top_topics'], min_length: 200 },
      },
      {
        name: 'Event Monitoring Brief',
        description:
          'Monitor a named upcoming event — a mainnet launch, unlock, listing or hearing — and report the confirmed date, what is actually scheduled to happen, the last three official updates, and the two most credible risks to the timeline.',
        reward: '0.5',
        capabilities: ['web_research', 'summarization', 'report_generation'],
        criteria: { required_fields: ['event', 'date', 'official_updates', 'risks'], min_length: 300 },
      },
      {
        name: 'Reddit Thread Sentiment Read',
        description:
          'Read a supplied Reddit thread and report the dominant positions, how many commenters hold each, the strongest argument on each side, and any factual claim that contradicts a top-level comment.',
        reward: '0.2',
        capabilities: ['text_analysis', 'summarization', 'web_research'],
        criteria: { required_fields: ['position', 'commenter_count', 'strongest_argument'], min_length: 250 },
      },
      {
        name: 'Podcast Episode Summary',
        description:
          'Summarise a supplied podcast episode into a 500-word brief plus a timestamped list of the eight most substantive claims made, each attributed to the speaker who made it.',
        reward: '0.5',
        capabilities: ['summarization', 'document_processing', 'text_analysis'],
        criteria: { required_fields: ['timestamp', 'claim', 'speaker'], max_length: 5000, min_length: 500 },
      },
      {
        name: 'Competitor Announcement Watch',
        description:
          'Track three named competitors across their blog, X account and changelog for the last 14 days. Report each announcement with date, what shipped, and a one-line read on whether it changes the competitive picture.',
        reward: '0.5',
        capabilities: ['competitive_analysis', 'web_research', 'report_generation'],
        criteria: { required_fields: ['competitor', 'date', 'announcement', 'assessment'], min_length: 300 },
      },
    ],
  },
  {
    name: 'Market & competitive research',
    templates: [
      {
        name: 'Competitor Pricing Teardown',
        description:
          'Tear down the pricing of three named competitors: every tier, what each includes, per-seat versus usage components, published discounts, and where our own pricing sits relative to each. One table plus a short read.',
        reward: '2',
        capabilities: ['competitive_analysis', 'web_research', 'report_generation'],
        criteria: { required_fields: ['competitor', 'tier', 'price', 'includes'], min_length: 400 },
      },
      {
        name: 'TAM Estimate for a Niche',
        description:
          'Estimate total addressable market for a stated product in a stated geography. Build it bottom-up from a named population, an adoption rate and a price point, show every assumption, and give a low/base/high range.',
        reward: '3',
        capabilities: ['market_research', 'math_computation', 'report_generation'],
        criteria: { required_fields: ['assumption', 'value', 'source', 'tam_low', 'tam_base', 'tam_high'], contains_keywords: ['assumption'], min_length: 500 },
      },
      {
        name: 'Feature Gap Matrix',
        description:
          'Build a matrix of our product against four named competitors across the twelve features that matter most to buyers. Mark present, partial or absent per cell, and close with the three gaps that lose deals.',
        reward: '2',
        capabilities: ['competitive_analysis', 'web_research', 'report_generation'],
        criteria: { required_fields: ['feature', 'competitor', 'status'], min_length: 400 },
      },
      {
        name: 'Customer Review Mining',
        description:
          'Read up to 200 public reviews of a named product and extract the recurring complaints and the recurring praise, each with a frequency count and two verbatim quotes. Separate paid-plan reviewers from free-tier ones.',
        reward: '1',
        capabilities: ['text_analysis', 'data_processing', 'summarization'],
        criteria: { required_fields: ['theme', 'sentiment', 'frequency', 'quote'], min_length: 400 },
      },
      {
        name: 'Go-to-Market Channel Scan',
        description:
          'For a stated product and audience, evaluate six acquisition channels on reachable audience size, estimated CAC, time to first signal and effort to run. Rank them and justify the top two in three sentences each.',
        reward: '2',
        capabilities: ['market_research', 'report_generation'],
        criteria: { required_fields: ['channel', 'audience_size', 'estimated_cac', 'rank'], min_length: 400 },
      },
      {
        name: 'Regulatory Landscape Brief',
        description:
          'Brief the current regulatory position for a stated activity in three named jurisdictions: the governing rule, the responsible regulator, what is explicitly permitted or prohibited, and any change proposed in the last 12 months. Cite every source. Informational only, not legal advice.',
        reward: '3',
        capabilities: ['web_research', 'document_processing', 'report_generation'],
        criteria: { required_fields: ['jurisdiction', 'rule', 'regulator', 'status', 'source'], forbidden_phrases: ['legal advice'], min_length: 600 },
      },
      {
        name: 'Vendor Shortlist with Scores',
        description:
          'Shortlist five vendors for a stated requirement. Score each out of 5 on fit, price, integration effort, support and lock-in risk using a stated weighting, then recommend one and name the strongest objection to it.',
        reward: '1.5',
        capabilities: ['market_research', 'competitive_analysis', 'report_generation'],
        criteria: { required_fields: ['vendor', 'score', 'recommendation'], rubric: [{ criterion: 'weighting stated', keywords: ['weight'], weight: 1 }], min_length: 400 },
      },
      {
        name: 'Positioning Statement Options',
        description:
          'Write three distinct positioning statements for a stated product, each naming a different primary audience and a different competitive alternative. Add one sentence per option on who it wins and who it loses.',
        reward: '1',
        capabilities: ['content_generation', 'market_research'],
        criteria: { required_fields: ['statement', 'audience', 'alternative'], max_length: 2500, min_length: 250 },
      },
    ],
  },
  {
    name: 'Content & copywriting',
    templates: [
      {
        name: 'Landing Page Hero Copy',
        description:
          'Write five hero variants for a stated product: headline under 60 characters, subhead under 140, and one call to action. No exclamation marks, no "revolutionary", no em-dash-heavy phrasing. State the angle of each variant.',
        reward: '0.5',
        capabilities: ['content_generation', 'text_analysis'],
        criteria: { required_fields: ['headline', 'subhead', 'cta', 'angle'], forbidden_phrases: ['revolutionary', 'game-changing'], max_length: 2000, min_length: 200 },
      },
      {
        name: 'Cold Outreach Email Sequence',
        description:
          'Write a four-email outreach sequence for a stated offer and audience. Each email under 120 words with its own subject line, a specific reason for writing, and one clear ask. No fake familiarity, no false urgency.',
        reward: '1',
        capabilities: ['email_drafting', 'content_generation'],
        criteria: { required_fields: ['subject', 'body', 'ask'], forbidden_phrases: ['just following up', 'circling back'], max_length: 3000, min_length: 300 },
      },
      {
        name: 'Product Launch Announcement',
        description:
          'Write a launch announcement for a stated feature in three formats: a 100-word blog intro, a 280-character post, and a 60-word in-app notice. All three must carry the same single core claim.',
        reward: '0.5',
        capabilities: ['content_generation', 'social_media'],
        criteria: { required_fields: ['blog_intro', 'social_post', 'in_app_notice'], max_length: 2000, min_length: 200 },
      },
      {
        name: 'SEO Blog Outline',
        description:
          'Produce an outline for a stated target keyword: title, meta description, H2/H3 structure, the questions each section answers, target word count per section, and three internal link opportunities.',
        reward: '0.5',
        capabilities: ['content_generation', 'web_research'],
        criteria: { required_fields: ['title', 'meta_description', 'headings', 'word_count'], min_length: 300 },
      },
      {
        name: 'Acrostic Poem from Initials',
        description:
          'Create a natural, readable English acrostic from the initials OMG — one line per letter, in order — and supply a plain-English gloss of each line. Lines must read as real phrases, not forced word salad.',
        reward: '0.01',
        capabilities: ['content_generation'],
        criteria: { min_length: 60, max_length: 800 },
      },
      {
        name: 'Product Description Set',
        description:
          'Write descriptions for 10 supplied SKUs. Each needs a 15-word summary, a 60-word body and three bullet specs. Keep a consistent voice across the set and never invent a specification that was not supplied.',
        reward: '1',
        capabilities: ['content_generation', 'data_processing'],
        criteria: { required_fields: ['sku', 'summary', 'body', 'bullets'], min_length: 500 },
      },
      {
        name: 'FAQ Section from Docs',
        description:
          'Read supplied product documentation and write the 15 questions a new user most likely asks, each with an answer under 80 words that links to the relevant doc section. Do not answer anything the docs do not cover.',
        reward: '0.5',
        capabilities: ['document_processing', 'content_generation', 'summarization'],
        criteria: { required_fields: ['question', 'answer', 'doc_link'], min_length: 500 },
      },
      {
        name: 'Push Notification Variants',
        description:
          'Write eight push notification variants for a stated trigger event, each under 90 characters, each with a distinct motivation — utility, curiosity, urgency, social. Flag any that would read as manipulative.',
        reward: '0.2',
        capabilities: ['content_generation', 'text_analysis'],
        criteria: { required_fields: ['text', 'motivation'], max_length: 1500, min_length: 150 },
      },
    ],
  },
  {
    name: 'Creative & design briefs',
    templates: [
      {
        name: 'Brand Design Token Set',
        description:
          'Distil a stated brand into a design token set: colour ramp with hex values and WCAG contrast ratios against light and dark backgrounds, type scale, spacing scale and radius scale. Deliver as JSON.',
        reward: '2',
        capabilities: ['content_generation', 'data_processing'],
        criteria: { expected_schema: { type: 'object', required: ['colors', 'typography', 'spacing'] }, contains_keywords: ['contrast'], min_length: 300 },
      },
      {
        name: 'Merch Mockup Brief',
        description:
          'Write a production brief for a hoodie featuring a tuxedo cat in a minimalist style: placement and print dimensions, colourway, file requirements, and the accompanying product copy. Text deliverable only, no attachments.',
        reward: '0.5',
        capabilities: ['content_generation', 'image_analysis'],
        criteria: { required_fields: ['placement', 'dimensions', 'colorway', 'copy'], min_length: 250 },
      },
      {
        name: 'Social Card Copy and Layout',
        description:
          'Specify a 1200x630 social card for a stated announcement: headline text, supporting line, visual hierarchy, safe-area margins, and the contrast ratio of every text layer against its background.',
        reward: '0.3',
        capabilities: ['content_generation', 'image_analysis'],
        criteria: { required_fields: ['headline', 'supporting_line', 'hierarchy', 'contrast'], min_length: 200 },
      },
      {
        name: 'Logo Concept Directions',
        description:
          'Describe four distinct logo directions for a stated brand — wordmark, monogram, abstract mark, and pictorial — each with the idea behind it, the shape language, and where it would fail at 16px.',
        reward: '1',
        capabilities: ['content_generation'],
        criteria: { required_fields: ['direction', 'concept', 'shape_language', 'weakness'], min_length: 350 },
      },
      {
        name: 'Image Alt-Text Pass',
        description:
          'Write alt text for a supplied set of up to 40 images. Each under 125 characters, describing function rather than appearance, and marked decorative where the image carries no information.',
        reward: '0.3',
        capabilities: ['image_analysis', 'content_generation'],
        criteria: { required_fields: ['image_id', 'alt_text', 'is_decorative'], max_length: 6000, min_length: 200 },
      },
      {
        name: 'Video Script for 15s Promo',
        description:
          'Write a 15-second promo script for a stated product: shot list with timings, on-screen text per shot, voiceover under 40 words total, and the single frame that would work as a thumbnail.',
        reward: '0.5',
        capabilities: ['content_generation'],
        criteria: { required_fields: ['timing', 'shot', 'on_screen_text', 'voiceover'], max_length: 2000, min_length: 200 },
      },
    ],
  },
  {
    name: 'Code & engineering',
    templates: [
      {
        name: 'Bug Reproduction Script',
        description:
          'Given a bug report and repository, produce the smallest runnable script that reproduces the failure, plus the exact command to run it, the observed output and the expected output.',
        reward: '1',
        capabilities: ['code_execution', 'testing'],
        criteria: { required_fields: ['script', 'command', 'observed', 'expected'], min_length: 200 },
      },
      {
        name: 'Unit Test Suite for a Module',
        description:
          'Write a unit test suite for a supplied module covering the happy path, every error branch and the boundary values. Tests must fail if the implementation is reverted. Report the resulting line coverage.',
        reward: '2',
        capabilities: ['testing', 'code_execution', 'code_review'],
        criteria: { required_fields: ['test_file', 'coverage'], contains_keywords: ['expect', 'coverage'], min_length: 400 },
      },
      {
        name: 'Pull Request Review',
        description:
          'Review a supplied diff for correctness bugs, missing error handling, unhandled edge cases and dropped call sites after a deletion. Each finding needs the file, the line, why it breaks, and the fix.',
        reward: '2',
        capabilities: ['code_review', 'text_analysis'],
        criteria: { required_fields: ['file', 'line', 'issue', 'fix'], min_length: 300 },
      },
      {
        name: 'SQL Query Optimisation',
        description:
          'Given a slow query and its schema, produce an optimised version, the EXPLAIN plan before and after, the indexes required, and proof that both queries return identical rows.',
        reward: '1.5',
        capabilities: ['code_execution', 'data_processing', 'math_computation'],
        criteria: { required_fields: ['optimised_query', 'plan_before', 'plan_after', 'indexes'], contains_keywords: ['EXPLAIN'], min_length: 300 },
      },
      {
        name: 'Regex Builder and Test Set',
        description:
          'Build a regular expression for a stated pattern and supply 15 test strings — 10 that must match and 5 that must not — plus a plain-English explanation of each component of the expression.',
        reward: '0.3',
        capabilities: ['code_execution', 'text_analysis'],
        criteria: { required_fields: ['regex', 'should_match', 'should_not_match', 'explanation'], min_length: 200 },
      },
      {
        name: 'API Client Wrapper',
        description:
          'Write a typed client wrapper for a supplied OpenAPI spec with retry on 429 and 5xx, request timeouts, typed errors, and a usage example per endpoint. No secrets in code or logs.',
        reward: '3',
        capabilities: ['api_integration', 'code_execution', 'document_processing'],
        criteria: { required_fields: ['client_code', 'usage_example'], contains_keywords: ['retry', 'timeout'], forbidden_phrases: ['api_key ='], min_length: 500 },
      },
      {
        name: 'CI Pipeline Config',
        description:
          'Write a CI config for a stated stack that installs, type-checks, tests and builds on every pull request, caches dependencies, and fails the run on any type error. Explain each caching decision.',
        reward: '1',
        capabilities: ['code_execution', 'testing', 'document_processing'],
        criteria: { required_fields: ['config', 'explanation'], contains_keywords: ['typecheck', 'cache'], min_length: 300 },
      },
      {
        name: 'Dockerfile Hardening',
        description:
          'Harden a supplied Dockerfile: pin the base image by digest, drop to a non-root user, use multi-stage builds, remove build tooling from the final layer, and report the image size before and after.',
        reward: '1',
        capabilities: ['code_review', 'code_execution'],
        criteria: { required_fields: ['dockerfile', 'size_before', 'size_after'], contains_keywords: ['non-root', 'multi-stage'], min_length: 250 },
      },
      {
        name: 'Migration Script with Rollback',
        description:
          'Write a forward migration and a matching rollback for a stated schema change, safe to run against a live table with 10M rows. State the lock taken, the expected duration, and how to verify success.',
        reward: '2',
        capabilities: ['code_execution', 'data_processing'],
        criteria: { required_fields: ['up', 'down', 'lock', 'verification'], contains_keywords: ['rollback'], min_length: 300 },
      },
    ],
  },
  {
    name: 'Data processing & extraction',
    templates: [
      {
        name: 'CSV Cleanup and Normalisation',
        description:
          'Clean a supplied CSV: normalise dates to ISO 8601, trim whitespace, unify country names to ISO 3166 codes, coerce numerics, and return a row-level report of every value that was changed or rejected.',
        reward: '0.5',
        capabilities: ['data_processing', 'data_extraction'],
        criteria: { required_fields: ['cleaned_rows', 'changed', 'rejected'], contains_keywords: ['ISO'], min_length: 200 },
      },
      {
        name: 'Web Page to Structured JSON',
        description:
          'Extract a supplied page into JSON against a stated schema. Every field must trace to visible page text — return null rather than inferring, and list any field the page did not contain.',
        reward: '0.3',
        capabilities: ['data_extraction', 'web_research', 'data_processing'],
        criteria: { expected_schema: { type: 'object', required: ['data', 'missing_fields'] }, min_length: 100 },
      },
      {
        name: 'PDF Table Extraction',
        description:
          'Extract every table from a supplied PDF into CSV, preserving merged cells and multi-page tables as single tables. Report each table’s page number and flag any cell where OCR confidence was low.',
        reward: '1',
        capabilities: ['document_processing', 'data_extraction'],
        criteria: { required_fields: ['table_id', 'page', 'csv'], min_length: 150 },
      },
      {
        name: 'Entity Extraction from Text',
        description:
          'Extract people, organisations, locations, dates and monetary amounts from a supplied document. Return each entity with its type, the surrounding sentence, and a character offset into the source.',
        reward: '0.5',
        capabilities: ['text_analysis', 'data_extraction'],
        criteria: { required_fields: ['entity', 'type', 'context', 'offset'], min_length: 200 },
      },
      {
        name: 'Deduplicate a Contact List',
        description:
          'Deduplicate a supplied contact list using fuzzy matching on name, email and phone. Return merged records, the rule that merged each pair, and a separate list of near-matches held back for human review.',
        reward: '0.5',
        capabilities: ['data_processing', 'text_analysis'],
        criteria: { required_fields: ['merged', 'rule', 'needs_review'], min_length: 200 },
      },
      {
        name: 'Schema Mapping Between Systems',
        description:
          'Map a source schema onto a target schema field by field, with the transform for each pair, the fields that have no counterpart in either direction, and the mapping expressed as runnable code.',
        reward: '1.5',
        capabilities: ['data_processing', 'api_integration', 'code_execution'],
        criteria: { required_fields: ['source_field', 'target_field', 'transform', 'unmapped'], min_length: 250 },
      },
      {
        name: 'Log File Error Rollup',
        description:
          'Roll up a supplied log file into distinct error signatures with an occurrence count, first and last seen timestamps, one example line each, and the three signatures that started within the window.',
        reward: '0.5',
        capabilities: ['data_processing', 'text_analysis', 'data_extraction'],
        criteria: { required_fields: ['signature', 'count', 'first_seen', 'last_seen', 'example'], min_length: 200 },
      },
      {
        name: 'Webhook Payload Validator',
        description:
          'Given a webhook contract, write a validator that checks structure, types and required fields, plus a fixture set of 10 valid and 10 invalid payloads with the exact rejection reason for each invalid one.',
        reward: '1',
        capabilities: ['api_integration', 'code_execution', 'testing'],
        criteria: { required_fields: ['validator', 'valid_fixtures', 'invalid_fixtures'], min_length: 300 },
      },
    ],
  },
  {
    name: 'Documents & reports',
    templates: [
      {
        name: 'Contract Clause Summary',
        description:
          'Summarise a supplied contract clause by clause: what each obliges, the party it binds, the notice periods, the termination and liability terms, and any clause that is unusual for this contract type. Informational only, not legal advice.',
        reward: '2',
        capabilities: ['document_processing', 'summarization', 'text_analysis'],
        criteria: { required_fields: ['clause', 'obligation', 'party', 'notes'], forbidden_phrases: ['legal advice'], min_length: 500 },
      },
      {
        name: 'Meeting Notes to Action Items',
        description:
          'Convert supplied meeting notes into action items, each with an owner, a due date and the exact quote it derives from. List separately every decision made and every question left open.',
        reward: '0.2',
        capabilities: ['summarization', 'document_processing', 'text_analysis'],
        criteria: { required_fields: ['action', 'owner', 'due_date', 'source_quote'], min_length: 200 },
      },
      {
        name: 'Research Paper Summary',
        description:
          'Summarise a supplied paper: the question, the method, the dataset, the headline result with its effect size, the stated limitations, and the one assumption that would most change the conclusion if wrong.',
        reward: '1',
        capabilities: ['document_processing', 'summarization', 'text_analysis'],
        criteria: { required_fields: ['question', 'method', 'result', 'limitations'], min_length: 400 },
      },
      {
        name: 'Weekly Status Report',
        description:
          'Assemble a weekly status report from supplied inputs: what shipped, what slipped and why, what is blocked and on whom, and next week’s three priorities. Under 500 words, no filler.',
        reward: '0.3',
        capabilities: ['report_generation', 'summarization'],
        criteria: { required_fields: ['shipped', 'slipped', 'blocked', 'priorities'], max_length: 3500, min_length: 250 },
      },
      {
        name: 'Invoice Data Extraction',
        description:
          'Extract structured data from a batch of supplied invoices: vendor, invoice number, date, due date, line items, subtotal, tax and total. Flag any invoice where the line items do not sum to the stated subtotal.',
        reward: '0.5',
        capabilities: ['document_processing', 'data_extraction', 'math_computation'],
        criteria: { expected_schema: { type: 'object', required: ['vendor', 'invoice_number', 'total'] }, contains_keywords: ['total'], min_length: 150 },
      },
      {
        name: 'Slide Outline from a Report',
        description:
          'Turn a supplied report into a 12-slide outline: one message per slide as a full sentence, the supporting evidence, and the chart or table each slide needs. No slide may carry two arguments.',
        reward: '1',
        capabilities: ['document_processing', 'summarization', 'report_generation'],
        criteria: { required_fields: ['slide_number', 'message', 'evidence', 'visual'], min_length: 400 },
      },
      {
        name: 'Policy Document Diff',
        description:
          'Diff two versions of a supplied policy document. Report every substantive change with the before and after text, classify each as an addition, removal or narrowing, and ignore pure formatting changes.',
        reward: '1',
        capabilities: ['document_processing', 'text_analysis', 'report_generation'],
        criteria: { required_fields: ['section', 'before', 'after', 'change_type'], min_length: 300 },
      },
    ],
  },
  {
    name: 'Translation & localisation',
    templates: [
      {
        name: 'Marketing Copy Localisation',
        description:
          'Localise supplied marketing copy into a stated target locale. Adapt idioms, currency, date formats and cultural references rather than translating literally, and note every place you deviated and why.',
        reward: '0.5',
        capabilities: ['translation', 'content_generation', 'text_analysis'],
        criteria: { required_fields: ['translated', 'deviations'], min_length: 200 },
      },
      {
        name: 'Technical Doc Translation',
        description:
          'Translate supplied technical documentation into a stated target language, leaving code blocks, CLI flags, API field names and error strings untranslated. Return a glossary of every term you fixed a translation for.',
        reward: '1',
        capabilities: ['translation', 'document_processing'],
        criteria: { required_fields: ['translated', 'glossary'], min_length: 300 },
      },
      {
        name: 'Subtitle File Translation',
        description:
          'Translate a supplied SRT into a stated target language, preserving every timestamp exactly, keeping lines under 42 characters and never spanning more than two lines per cue.',
        reward: '0.5',
        capabilities: ['translation', 'document_processing', 'data_processing'],
        criteria: { regex_pattern: '\\d{2}:\\d{2}:\\d{2},\\d{3}', contains_keywords: ['-->'], min_length: 200 },
      },
      {
        name: 'Tone-Matched Reply Translation',
        description:
          'Translate a supplied customer message into English, draft a reply in English, then translate the reply back into the customer’s language matching their register of formality. Return all four texts.',
        reward: '0.2',
        capabilities: ['translation', 'email_drafting', 'text_analysis'],
        criteria: { required_fields: ['original', 'translated_in', 'reply_en', 'reply_translated'], min_length: 150 },
      },
      {
        name: 'Glossary Consistency Check',
        description:
          'Check a supplied translated corpus against a supplied glossary. Report every term rendered inconsistently, each variant used with its occurrence count and file location, and the correct term.',
        reward: '0.5',
        capabilities: ['translation', 'text_analysis', 'data_processing'],
        criteria: { required_fields: ['term', 'variants', 'count', 'location', 'correct_term'], min_length: 200 },
      },
    ],
  },
  {
    name: 'Ops, scheduling & comms',
    templates: [
      {
        name: 'Timezone Meeting Slot Finder',
        description:
          'Find three meeting slots that fall inside 08:00–18:00 local time for participants in New York, London and Singapore next week. Return each slot in all three local times plus UTC.',
        reward: '0.05',
        capabilities: ['scheduling', 'math_computation'],
        criteria: { required_fields: ['utc_time', 'local_times'], contains_keywords: ['UTC'], min_length: 80 },
      },
      {
        name: 'Calendar Conflict Resolution',
        description:
          'Given a set of calendars and a new meeting request, find the earliest slot that conflicts with nothing, or if none exists propose the smallest set of moves that opens one and name whose meeting shifts.',
        reward: '0.2',
        capabilities: ['scheduling', 'data_processing'],
        criteria: { required_fields: ['proposed_slot', 'conflicts', 'moves'], min_length: 100 },
      },
      {
        name: 'Customer Support Reply Draft',
        description:
          'Draft a reply to a supplied support ticket: acknowledge the specific problem, give the fix or the next step, state a realistic timeline, and never promise anything the supplied docs do not support.',
        reward: '0.1',
        capabilities: ['email_drafting', 'text_analysis', 'content_generation'],
        criteria: { required_fields: ['reply', 'next_step', 'timeline'], forbidden_phrases: ['we guarantee', 'immediately resolved'], max_length: 2000, min_length: 100 },
      },
      {
        name: 'Incident Status Update',
        description:
          'Write a status page update for an ongoing incident: what users are experiencing, what is confirmed versus still under investigation, what has been done, and the next update time. No blame, no speculation on cause.',
        reward: '0.2',
        capabilities: ['content_generation', 'report_generation'],
        criteria: { required_fields: ['impact', 'confirmed', 'investigating', 'next_update'], forbidden_phrases: ['root cause is'], max_length: 1500, min_length: 120 },
      },
      {
        name: 'Recurring Reminder Schedule',
        description:
          'Build a recurring reminder schedule from a stated cadence and timezone, expand the next 12 occurrences to absolute UTC timestamps, and state how each daylight-saving transition in that window is handled.',
        reward: '0.1',
        capabilities: ['scheduling', 'math_computation', 'data_processing'],
        criteria: { required_fields: ['occurrences', 'dst_handling'], contains_keywords: ['UTC'], min_length: 100 },
      },
      {
        name: 'World Time and Offset Lookup',
        description:
          'Report the current date, time, timezone name and UTC offset for Beijing, and state whether daylight saving is in effect and when the next transition occurs.',
        reward: '0.01',
        capabilities: ['api_integration', 'scheduling'],
        criteria: { required_fields: ['datetime', 'timezone', 'utc_offset'], contains_keywords: ['UTC'], min_length: 50 },
      },
    ],
  },
  {
    name: 'Analysis & QA',
    templates: [
      {
        name: 'Fact Check a Claim Set',
        description:
          'Check each claim in a supplied list. Return supported, contradicted or unverifiable, with a primary source and the exact passage that settles it. Say unverifiable rather than reasoning toward a verdict.',
        reward: '1',
        capabilities: ['web_research', 'text_analysis', 'report_generation'],
        criteria: { required_fields: ['claim', 'verdict', 'source_url', 'passage'], contains_keywords: ['unverifiable'], min_length: 300 },
      },
      {
        name: 'Rubric Scoring of Submissions',
        description:
          'Score a set of supplied submissions against a supplied rubric. Give a per-criterion score with the evidence behind it, a total, and a note on any submission where two criteria pulled in opposite directions.',
        reward: '1',
        capabilities: ['text_analysis', 'report_generation'],
        criteria: { required_fields: ['submission_id', 'criterion', 'score', 'evidence', 'total'], pass_threshold: 70, min_length: 300 },
      },
      {
        name: 'A/B Test Result Read',
        description:
          'Read a supplied A/B result: report lift, confidence interval and p-value, state whether the sample reached the pre-registered size, and say plainly whether the result supports shipping or is inconclusive.',
        reward: '0.5',
        capabilities: ['math_computation', 'data_processing', 'report_generation'],
        criteria: { required_fields: ['lift', 'confidence_interval', 'p_value', 'recommendation'], contains_keywords: ['confidence'], min_length: 200 },
      },
      {
        name: 'Survey Free-Text Themes',
        description:
          'Cluster supplied free-text survey responses into themes. Give each theme a name, a response count, three verbatim quotes, and the segment breakdown. Keep a residual bucket rather than forcing every response into a theme.',
        reward: '1',
        capabilities: ['text_analysis', 'data_processing', 'summarization'],
        criteria: { required_fields: ['theme', 'count', 'quotes', 'residual'], min_length: 350 },
      },
      {
        name: 'Accessibility Audit of a Page',
        description:
          'Audit a supplied page against WCAG 2.2 AA. Report each failure with the element, the criterion, the measured value where relevant such as contrast ratio, and the specific fix. Separate automated from manual findings.',
        reward: '2',
        capabilities: ['web_research', 'code_review', 'report_generation'],
        criteria: { required_fields: ['element', 'criterion', 'measured', 'fix', 'method'], contains_keywords: ['WCAG', 'contrast'], min_length: 400 },
      },
    ],
  },
];

const ALL: { category: string; t: SeedTemplate }[] = CATEGORIES.flatMap((c) =>
  c.templates.map((t) => ({ category: c.name, t })),
);

/** Attribution for seeded rows. Override to attribute the catalog elsewhere. */
const CREATOR = (process.env.SEED_CREATOR_ADDRESS || '0x2f8b1177c83623a560B26B38dE984e154b123D75').toLowerCase();

const DRY_RUN = process.argv.includes('--dry-run');
const UNDO = process.argv.includes('--undo');
const FORCE = process.argv.includes('--force');

/**
 * The answer to "is this a throwaway database?".
 *
 * A managed host (Neon, Supabase, RDS, Railway…) is assumed to be shared or
 * production. Only a loopback host passes without --force.
 */
function isLocalDatabase(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === 'host.docker.internal';
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.\n');
    console.error('This script writes to Postgres directly. Point it at a local database, e.g.');
    console.error("  DATABASE_URL='postgres://localhost:5432/blindmarket?sslmode=disable' npx tsx scripts/seed-task-templates.ts");
    process.exit(1);
  }

  const local = isLocalDatabase(url);
  const host = (() => { try { return new URL(url).hostname; } catch { return '(unparseable)'; } })();

  if (!local && !FORCE) {
    console.error(`Refusing to run: DATABASE_URL points at "${host}", which is not a local database.`);
    console.error('This seed is intended for local/dev only. Re-run with --force if you genuinely mean to write there.');
    process.exit(1);
  }
  if (!local && FORCE) {
    console.warn(`WARNING: --force given; writing to NON-LOCAL host "${host}".`);
  }

  console.log(`Database : ${host}${local ? ' (local)' : ' (REMOTE — forced)'}`);
  console.log(`Creator  : ${CREATOR}`);
  console.log(`Catalog  : ${ALL.length} task types across ${CATEGORIES.length} categories`);
  console.log('');

  // getPool() runs migrations, so task_templates exists before the first query.
  const db = await getPool();

  if (UNDO) {
    const names = ALL.map((x) => x.t.name);
    if (DRY_RUN) {
      const { rows } = await db.query<{ cnt: string }>(
        'SELECT COUNT(*) AS cnt FROM task_templates WHERE creator_address = $1 AND name = ANY($2)',
        [CREATOR, names],
      );
      console.log(`[dry-run] would delete ${rows[0]?.cnt ?? 0} seeded template(s).`);
      return;
    }
    const { rowCount } = await db.query(
      'DELETE FROM task_templates WHERE creator_address = $1 AND name = ANY($2)',
      [CREATOR, names],
    );
    console.log(`Deleted ${rowCount ?? 0} seeded template(s).`);
    return;
  }

  // Idempotency: task_templates has no unique constraint on name, so an
  // ON CONFLICT clause has nothing to target. Read the existing names once and
  // filter in memory instead of issuing 100 existence checks.
  const { rows: existingRows } = await db.query<{ name: string }>(
    'SELECT name FROM task_templates WHERE creator_address = $1',
    [CREATOR],
  );
  const existing = new Set(existingRows.map((r) => r.name));

  let inserted = 0;
  let skipped = 0;

  for (const { category, t } of ALL) {
    if (existing.has(t.name)) {
      skipped++;
      continue;
    }
    if (DRY_RUN) {
      console.log(`[dry-run] ${category.padEnd(32)} ${t.name} — ${t.reward} [${t.capabilities.join(', ')}]`);
      inserted++;
      continue;
    }
    await db.query(
      `INSERT INTO task_templates
         (creator_address, name, description, required_capabilities, verification_criteria, suggested_reward, is_public)
       VALUES ($1, $2, $3, $4, $5, $6, true)`,
      [CREATOR, t.name, t.description, t.capabilities, JSON.stringify(t.criteria), t.reward],
    );
    inserted++;
  }

  console.log('');
  console.log(DRY_RUN ? `[dry-run] would insert ${inserted}, skip ${skipped} (already present).` : `Inserted ${inserted}, skipped ${skipped} (already present).`);

  if (!DRY_RUN) {
    const { rows } = await db.query<{ cnt: string }>('SELECT COUNT(*) AS cnt FROM task_templates WHERE is_public = true');
    console.log(`Public catalog now holds ${rows[0]?.cnt ?? 0} template(s).`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
