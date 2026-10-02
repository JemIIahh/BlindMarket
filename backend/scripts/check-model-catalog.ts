/**
 * Diff the model catalog (LLM_PROVIDER_MODELS in src/types.ts) against each
 * provider's public docs. Informational: prints what changed and exits 0. It
 * needs no API key and calls no model; it reads the providers' markdown docs.
 *
 *   npm run check-model-catalog             # print the diff
 *   npm run check-model-catalog -- --record # also rewrite src/services/providerModelDocs.json
 *
 * providerModelDocs.json is what providerModelDocs.test.ts holds the catalog
 * to: every catalog id must be on its provider's page at the page's price, not
 * deprecated, retired, or open only to some accounts, and marked preview
 * exactly when the provider calls it preview or beta. Record it again after
 * editing the catalog from a fresh read of these pages.
 *
 * Each model carries the page's lifecycle word in `status`:
 *   Deprecated  a shutdown date is announced (or it is already shut down)
 *   Retired     Anthropic's word for shut down
 *   Limited     open only to approved, invited or past users
 *   Enterprise  Groq: enterprise contracts only
 *   Preview / Beta, Active / Production, or none when the page says nothing
 *
 * The docs are parsed by their layout on 2026-10-02. When a provider reworks a
 * page this reports "0 models read" for it rather than guessing.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LLM_PROVIDER_MODELS, type LLMProvider } from '../src/types.js';

// The live-list filters sit beside the backend's 0G code, whose config import
// requires PRIVY_APP_ID at load; this script reads no config.
process.env.PRIVY_APP_ID ??= 'check-model-catalog';
const { geminiChatIds, groqChatIds, openaiChatIds } = await import('../src/services/providerModels.js');

type Keyed = Exclude<LLMProvider, '0g-compute'>;

interface DocModel {
  id: string;
  /** USD per 1M tokens, standard tier, short-context rate. */
  inputCostPer1M?: number;
  outputCostPer1M?: number;
  status?: string;
}

const OPENAI = 'https://developers.openai.com/api/docs';
const ANTHROPIC = 'https://platform.claude.com/docs/en/about-claude';
const GEMINI = 'https://ai.google.dev/gemini-api/docs';
const XAI = 'https://docs.x.ai/developers';

const SOURCES: Record<Keyed, { url: string; read: () => Promise<DocModel[]> }> = {
  openai: { url: `${OPENAI}/pricing.md`, read: readOpenai },
  anthropic: { url: `${ANTHROPIC}/model-deprecations.md`, read: readAnthropic },
  groq: { url: 'https://console.groq.com/docs/models.md', read: readGroq },
  gemini: { url: `${GEMINI}/pricing.md.txt`, read: readGemini },
  xai: { url: `${XAI}/pricing.md`, read: readXai },
};

const usd = (s: string | undefined) => {
  const m = /\$\s*([\d.]+)/.exec(s ?? '');
  return m ? Number(m[1]) : undefined;
};
// A cell may hold an escaped pipe ("`gpt-4-turbo` \\| `gpt-4-turbo-2024-04-09`").
const cells = (row: string) => row.replace(/\\\|/g, '\u0000').split('|').slice(1, -1).map((c) => c.replace(/\u0000/g, '|').trim());
const ticked = (s: string) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

/**
 * Every markdown table in `md`: its header cells, its body rows' cells, and
 * the group it sits under on OpenAI's pricing page ("Cyber models", …).
 */
function tables(md: string): Array<{ head: string[]; rows: string[][]; group: string }> {
  const out: Array<{ head: string[]; rows: string[][]; group: string }> = [];
  const lines = md.split('\n');
  let group = '';
  for (let i = 0; i < lines.length - 1; i++) {
    if (/^[A-Z][A-Za-z ]* models$/.test(lines[i].trim())) group = lines[i].trim();
    if (!lines[i].startsWith('|') || !/^\|\s*-{3}/.test(lines[i + 1])) continue;
    const head = cells(lines[i]);
    const rows: string[][] = [];
    for (i += 2; i < lines.length && lines[i].startsWith('|'); i++) rows.push(cells(lines[i]));
    out.push({ head, rows, group });
  }
  return out;
}

async function read(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.text();
}

/**
 * OpenAI: ids and prices from every pricing table with Model, input and output
 * columns (the first, standard-tier table wins). Lifecycle from the
 * deprecations page, which names snapshots: a model whose own page gives a
 * deprecated default snapshot is deprecated too (gpt-5 → gpt-5-2025-08-07).
 * Limited: the cyber models (gpt-5.6-cyber's page: "approved defenders") and
 * any model the models page or its own page offers to approved users only.
 */
async function readOpenai(): Promise<DocModel[]> {
  const byId = new Map<string, DocModel>();
  const limited = new Set<string>();
  for (const line of (await read(`${OPENAI}/models.md`)).split('\n')) {
    if (!/approved|authorized/i.test(line)) continue;
    for (const m of line.matchAll(/\/api\/docs\/models\/(.+?)\.md\)/g)) limited.add(m[1]);
    for (const id of ticked(line)) limited.add(id);
  }
  for (const { head, rows, group } of tables(await read(`${OPENAI}/pricing.md`))) {
    const model = head.findIndex((h) => h === 'Model');
    const input = head.findIndex((h) => /^(short context )?input$/i.test(h));
    const output = head.findIndex((h) => /^(short context )?output$/i.test(h));
    if (model < 0 || input < 0 || output < 0) continue;
    for (const r of rows) {
      const id = r[model]?.replace(/\s*\(.*\)$/, '');
      if (!id || !/^[a-z0-9][\w.-]*$/.test(id) || byId.has(id)) continue;
      byId.set(id, { id, inputCostPer1M: usd(r[input]), outputCostPer1M: usd(r[output]) });
      if (group === 'Cyber models') limited.add(id);
    }
  }
  const deprecated = new Set<string>();
  for (const { head, rows } of tables(await read(`${OPENAI}/deprecations.md`))) {
    const col = head.findIndex((h) => /model|snapshot|system/i.test(h) && !/replacement|substitute|price/i.test(h));
    if (col >= 0) for (const r of rows) for (const id of ticked(r[col] ?? '')) deprecated.add(id);
  }
  for (const m of byId.values()) {
    const page = await read(`${OPENAI}/models/${m.id}.md`).catch(() => '');
    const snapshot = /Default snapshot: `([^`]+)`/.exec(page)?.[1];
    if (deprecated.has(m.id) || (snapshot && deprecated.has(snapshot))) m.status = 'Deprecated';
    else if (limited.has(m.id) || /requires separate approval|approved defenders|approved organizations/i.test(page)) m.status = 'Limited';
  }
  return [...byId.values()];
}

/** Anthropic: ids and lifecycle from "Model status"; prices by display name ("Claude Opus 5.5" → claude-opus-5-5). */
async function readAnthropic(): Promise<DocModel[]> {
  const status = (await read(`${ANTHROPIC}/model-deprecations.md`)).split('## Model status')[1]?.split('\n## ')[0] ?? '';
  const models: DocModel[] = status.split('\n').filter((r) => /^\|\s*claude-/.test(r)).map((r) => ({ id: cells(r)[0], status: cells(r)[1] }));
  const pricing = (await read(`${ANTHROPIC}/pricing.md`)).split('## Model pricing')[1]?.split('\n## ')[0] ?? '';
  for (const r of pricing.split('\n').filter((l) => /^\|\s*Claude /.test(l))) {
    const c = cells(r);
    const id = c[0].replace(/\s*\(.*$/, '').toLowerCase().replace(/[ .]/g, '-');
    for (const m of models.filter((x) => x.id === id || x.id.replace(/-\d{8}$/, '') === id)) {
      m.inputCostPer1M = usd(c[1]);
      m.outputCostPer1M = usd(c[5]);
      if (/limited availability/i.test(c[0]) && m.status === 'Active') m.status = 'Limited';
    }
  }
  return models;
}

/** Groq: model rows link /docs/model/<id>; the section names Production or Preview; an Enterprise badge wins. */
async function readGroq(): Promise<DocModel[]> {
  const models: DocModel[] = [];
  let section = '';
  for (const line of (await read('https://console.groq.com/docs/models.md')).split('\n')) {
    const h = /^## \[(.+?)\]/.exec(line);
    if (h) section = h[1].replace(/ Models$/, '');
    const id = /\]\(\/docs\/model\/([^)]+)\)/.exec(line)?.[1];
    if (!id || !line.startsWith('|')) continue;
    const price = cells(line)[2] ?? '';
    const [i, o] = [/\$([\d.]+) input/.exec(price)?.[1], /\$([\d.]+) output/.exec(price)?.[1]];
    models.push({
      id,
      status: /\)Enterprise/.test(line) ? 'Enterprise' : section,
      ...(i && o ? { inputCostPer1M: Number(i), outputCostPer1M: Number(o) } : {}),
    });
  }
  return models;
}

/**
 * Gemini: a "## <name>" pricing section per model, its id in backticks, then
 * a Standard table of paid prices. Lifecycle from the deprecations page: an
 * announced shutdown date is a deprecation; a section noting that access is
 * limited to past users makes its models Limited.
 */
async function readGemini(): Promise<DocModel[]> {
  const models: DocModel[] = [];
  for (const section of (await read(`${GEMINI}/pricing.md.txt`)).split('\n## ').slice(1)) {
    const id = /\*\[`(gemini-[^`]+)`\]/.exec(section)?.[1];
    if (!id) continue;
    const standard = section.split('### Standard')[1]?.split('###')[0] ?? '';
    const row = (label: RegExp) => standard.split('\n').find((l) => label.test(l));
    const paid = (r?: string) => (r ? usd(cells(r)[2]) : undefined);
    models.push({ id, inputCostPer1M: paid(row(/^\|\s*Input price/)), outputCostPer1M: paid(row(/^\|\s*Output price/)) });
  }
  const lifecycle = new Map<string, string>();
  for (const section of (await read(`${GEMINI}/deprecations.md.txt`)).split('\n## ').slice(1)) {
    const limited = /limiting access/i.test(section);
    for (const { rows } of tables(section)) {
      for (const r of rows) {
        const id = ticked(r[0] ?? '')[0];
        if (!id) continue;
        if (r[2] && !/no shutdown date/i.test(r[2])) lifecycle.set(id, 'Deprecated');
        else if (limited) lifecycle.set(id, 'Limited');
      }
    }
  }
  return models.map((m) => {
    const status = lifecycle.get(m.id) ?? (/-preview/.test(m.id) ? 'Preview' : undefined);
    return status ? { ...m, status } : m;
  });
}

/** xAI: "| grok-4.7 (< 200k prompt tokens) | 500k | $2.00 | $0.50 | $6.00 |"; Beta or Preview from each model page's title. */
async function readXai(): Promise<DocModel[]> {
  const md = await read(`${XAI}/pricing.md`);
  const table = md.split('### Text API Pricing')[1]?.split('\n\n').find((b) => b.trim().startsWith('|')) ?? '';
  const models: DocModel[] = table.split('\n').filter((r) => /^\|\s*grok-/.test(r) && !/≥/.test(r)).map((r) => {
    const c = cells(r);
    return { id: c[0].replace(/\s*\(.*\)$/, ''), inputCostPer1M: usd(c[2]), outputCostPer1M: usd(c[4]) };
  });
  for (const m of models) {
    const title = (await read(`${XAI}/models/${m.id}.md`).catch(() => '')).split('\n').find((l) => l.startsWith('# ')) ?? '';
    const flag = /\b(Beta|Preview)\b/.exec(title)?.[1];
    if (flag) m.status = flag;
  }
  return models;
}

const OUT_OF_SCOPE = /^(Deprecated|Retired|Limited|Enterprise)$/;
const undated = (id: string) => id.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, '');

/** The ids the backend's live-list filter would offer as chat models (the same filter, so the report matches the form). */
const CHAT: Partial<Record<Keyed, (ids: string[]) => string[]>> = {
  openai: (ids) => openaiChatIds({ data: ids.map((id) => ({ id })) }),
  groq: (ids) => groqChatIds({ data: ids.map((id) => ({ id })) }),
  gemini: (ids) => geminiChatIds({ models: ids.map((id) => ({ name: `models/${id}`, supportedGenerationMethods: ['generateContent'] })) }),
};

async function main() {
  const record = process.argv.includes('--record');
  const recorded: Record<string, { source: string; models: DocModel[] }> = {};
  for (const provider of Object.keys(SOURCES) as Keyed[]) {
    const { url, read: readDocs } = SOURCES[provider];
    let docs: DocModel[];
    try {
      docs = await readDocs();
    } catch (err) {
      console.log(`\n${provider}: could not read the docs: ${(err as Error).message}`);
      continue;
    }
    recorded[provider] = { source: url, models: docs };
    const find = (id: string) => docs.find((m) => m.id === id) ?? docs.find((m) => undated(m.id) === id);
    const catalog = LLM_PROVIDER_MODELS[provider];
    const missing = catalog.filter((m) => !find(m.id)).map((m) => m.id);
    const flagged = catalog.map((m) => ({ m, d: find(m.id) })).filter(({ d }) => d?.status && OUT_OF_SCOPE.test(d.status));
    const repriced = catalog
      .map((m) => ({ m, d: find(m.id) }))
      .filter(({ m, d }) => d?.inputCostPer1M !== undefined && d.outputCostPer1M !== undefined
        && (d.inputCostPer1M !== m.inputCostPer1M || d.outputCostPer1M !== m.outputCostPer1M));
    const known = new Set(catalog.map((m) => m.id));
    const chat = new Set((CHAT[provider] ?? ((ids: string[]) => ids))(docs.map((m) => m.id)));
    const extra = docs.filter((m) => chat.has(m.id) && !known.has(undated(m.id)) && !OUT_OF_SCOPE.test(m.status ?? ''));

    console.log(`\n${provider} — ${docs.length} models read from ${url}`);
    console.log(`  catalog ids the page doesn't list: ${missing.join(', ') || 'none'}`);
    for (const { m, d } of flagged) console.log(`  ${m.id}: the page says ${d!.status}`);
    for (const { m, d } of repriced) {
      console.log(`  ${m.id}: catalog $${m.inputCostPer1M}/$${m.outputCostPer1M}, page $${d!.inputCostPer1M}/$${d!.outputCostPer1M}`);
    }
    console.log(`  current on the page, not in the catalog: ${extra.map((m) => `${m.id}${m.status ? ` (${m.status})` : ''}`).join(', ') || 'none'}`);
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
