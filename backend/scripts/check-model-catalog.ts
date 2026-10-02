/**
 * Diff the model catalog (LLM_PROVIDER_MODELS in src/types.ts) against each
 * provider's public docs. Informational: prints what changed and exits 0. It
 * needs no API key and calls no model; it reads the providers' markdown docs.
 *
 *   npm run check-model-catalog             # print the diff
 *   npm run check-model-catalog -- --record # also rewrite src/services/providerModelDocs.json
 *
 * providerModelDocs.json is what providerModels.test.ts holds the catalog to:
 * every catalog id must be on its provider's page, at the page's price. Record
 * it again after editing the catalog from a fresh read of these pages.
 *
 * The docs are parsed by their table layout on 2026-10-02. When a provider
 * reworks a page this reports "0 models read" for it rather than guessing.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LLM_PROVIDER_MODELS, type LLMProvider } from '../src/types.js';

type Keyed = Exclude<LLMProvider, '0g-compute'>;

interface DocModel {
  id: string;
  /** USD per 1M tokens, standard tier, short-context rate. */
  inputCostPer1M?: number;
  outputCostPer1M?: number;
  /** What the page says about it, when it says: Active / Deprecated / Retired, Production / Preview. */
  status?: string;
}

const SOURCES: Record<Keyed, { url: string; parse: (md: string) => DocModel[] }> = {
  openai: { url: 'https://developers.openai.com/api/docs/pricing.md', parse: parseOpenai },
  anthropic: { url: 'https://platform.claude.com/docs/en/about-claude/model-deprecations.md', parse: parseAnthropicStatus },
  groq: { url: 'https://console.groq.com/docs/models.md', parse: parseGroq },
  gemini: { url: 'https://ai.google.dev/gemini-api/docs/pricing.md.txt', parse: parseGemini },
  xai: { url: 'https://docs.x.ai/developers/pricing.md', parse: parseXai },
};
// Anthropic's ids and lifecycle are on the deprecations page; prices on this one.
const ANTHROPIC_PRICING = 'https://platform.claude.com/docs/en/about-claude/pricing.md';

const usd = (s: string | undefined) => {
  const m = /\$\s*([\d.]+)/.exec(s ?? '');
  return m ? Number(m[1]) : undefined;
};
const cells = (row: string) => row.split('|').slice(1, -1).map((c) => c.trim());

/** OpenAI: the first "Standard pricing data" table: model | short input | cached | writes | short output | … */
function parseOpenai(md: string): DocModel[] {
  const table = md.split('### Standard pricing data')[1]?.split('\n\n').find((b) => b.trim().startsWith('|')) ?? '';
  return table.split('\n').filter((r) => r.startsWith('| ') && !r.startsWith('| Model') && !r.startsWith('| ---')).map((r) => {
    const c = cells(r);
    return { id: c[0].replace(/\s*\(.*\)$/, ''), inputCostPer1M: usd(c[1]), outputCostPer1M: usd(c[4]) };
  });
}

/** Anthropic: the "Model status" table: API model name | state | deprecated | retirement. */
function parseAnthropicStatus(md: string): DocModel[] {
  const table = md.split('## Model status')[1]?.split('\n## ')[0] ?? '';
  return table.split('\n').filter((r) => /^\|\s*claude-/.test(r)).map((r) => {
    const c = cells(r);
    return { id: c[0], status: c[1] };
  });
}

/** Anthropic prices by display name ("Claude Opus 5.5" → claude-opus-5-5): base input and output columns. */
function parseAnthropicPrices(md: string): Map<string, { in?: number; out?: number }> {
  const table = md.split('## Model pricing')[1]?.split('\n## ')[0] ?? '';
  const out = new Map<string, { in?: number; out?: number }>();
  for (const r of table.split('\n').filter((l) => /^\|\s*Claude /.test(l))) {
    const c = cells(r);
    const id = c[0].replace(/\s*\(.*$/, '').toLowerCase().replace(/[ .]/g, '-');
    out.set(id, { in: usd(c[1]), out: usd(c[5]) });
  }
  return out;
}

/** Groq: model rows link /docs/model/<id>; price cell reads "$0.15 input$0.60 output". */
function parseGroq(md: string): DocModel[] {
  const models: DocModel[] = [];
  let status = '';
  for (const line of md.split('\n')) {
    const h = /^## \[(.+?)\]/.exec(line);
    if (h) status = h[1].replace(/ Models$/, '');
    const id = /\]\(\/docs\/model\/([^)]+)\)/.exec(line)?.[1];
    if (!id || !line.startsWith('|')) continue;
    const price = cells(line)[2] ?? '';
    const [i, o] = [/\$([\d.]+) input/.exec(price)?.[1], /\$([\d.]+) output/.exec(price)?.[1]];
    models.push({ id, status, ...(i && o ? { inputCostPer1M: Number(i), outputCostPer1M: Number(o) } : {}) });
  }
  return models;
}

/** Gemini: a "## <name>" section per model, its id in backticks, then a Standard table of paid prices. */
function parseGemini(md: string): DocModel[] {
  const models: DocModel[] = [];
  for (const section of md.split('\n## ').slice(1)) {
    const id = /\*\[`(gemini-[^`]+)`\]/.exec(section)?.[1];
    if (!id) continue;
    const standard = section.split('### Standard')[1]?.split('###')[0] ?? '';
    const row = (label: RegExp) => standard.split('\n').find((l) => label.test(l));
    const paid = (r?: string) => (r ? usd(cells(r)[2]) : undefined);
    models.push({ id, inputCostPer1M: paid(row(/^\|\s*Input price/)), outputCostPer1M: paid(row(/^\|\s*Output price/)) });
  }
  return models;
}

/** xAI: "| grok-4.7 (< 200k prompt tokens) | 500k | $2.00 | $0.50 | $6.00 |" — the short-context rows. */
function parseXai(md: string): DocModel[] {
  const table = md.split('### Text API Pricing')[1]?.split('\n\n').find((b) => b.trim().startsWith('|')) ?? '';
  return table.split('\n').filter((r) => /^\|\s*grok-/.test(r) && !/≥/.test(r)).map((r) => {
    const c = cells(r);
    return { id: c[0].replace(/\s*\(.*\)$/, ''), inputCostPer1M: usd(c[2]), outputCostPer1M: usd(c[4]) };
  });
}

async function read(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.text();
}

async function main() {
  const record = process.argv.includes('--record');
  const recorded: Record<string, { source: string; models: DocModel[] }> = {};
  for (const provider of Object.keys(SOURCES) as Keyed[]) {
    const { url, parse } = SOURCES[provider];
    let docs: DocModel[];
    try {
      docs = parse(await read(url));
      if (provider === 'anthropic') {
        const prices = parseAnthropicPrices(await read(ANTHROPIC_PRICING));
        docs = docs.map((m) => {
          const p = prices.get(m.id) ?? prices.get(m.id.replace(/-\d{8}$/, ''));
          return p?.in !== undefined && p.out !== undefined ? { ...m, inputCostPer1M: p.in, outputCostPer1M: p.out } : m;
        });
      }
    } catch (err) {
      console.log(`\n${provider}: could not read ${url}: ${(err as Error).message}`);
      continue;
    }
    recorded[provider] = { source: url, models: docs };
    const byId = new Map(docs.map((m) => [m.id, m]));
    const catalog = LLM_PROVIDER_MODELS[provider];
    const find = (id: string) => byId.get(id) ?? [...byId.values()].find((m) => m.id.replace(/-\d{8}$/, '') === id);
    const missing = catalog.filter((m) => !find(m.id)).map((m) => m.id);
    const flagged = catalog.map((m) => ({ m, d: find(m.id) })).filter(({ d }) => d?.status && !/^(Active|Production)$/.test(d.status));
    const repriced = catalog
      .map((m) => ({ m, d: find(m.id) }))
      .filter(({ m, d }) => d?.inputCostPer1M !== undefined && d.outputCostPer1M !== undefined
        && (d.inputCostPer1M !== m.inputCostPer1M || d.outputCostPer1M !== m.outputCostPer1M));
    const known = new Set(catalog.map((m) => m.id));
    const extra = docs.filter((m) => !known.has(m.id) && !known.has(m.id.replace(/-\d{8}$/, ''))
      && !/^(Deprecated|Retired)$/.test(m.status ?? ''));

    console.log(`\n${provider} — ${docs.length} models read from ${url}`);
    console.log(`  catalog ids the page doesn't list: ${missing.join(', ') || 'none'}`);
    for (const { m, d } of flagged) console.log(`  ${m.id}: the page says ${d!.status}`);
    for (const { m, d } of repriced) {
      console.log(`  ${m.id}: catalog $${m.inputCostPer1M}/$${m.outputCostPer1M}, page $${d!.inputCostPer1M}/$${d!.outputCostPer1M}`);
    }
    console.log(`  on the page, not in the catalog: ${extra.map((m) => m.id).join(', ') || 'none'}`);
  }
  if (record) {
    const path = fileURLToPath(new URL('../src/services/providerModelDocs.json', import.meta.url));
    writeFileSync(path, `${JSON.stringify({ recordedAt: new Date().toISOString().slice(0, 10), providers: recorded }, null, 2)}\n`);
    console.log(`\nrecorded ${path}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
