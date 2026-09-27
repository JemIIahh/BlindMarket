import { useState, useEffect, useCallback, useRef } from 'react';
import { Button, FormField, FormInput, FormTextarea, Tag, Icon, Spinner } from './index';
import { authedPost, get } from '../../lib/api';
import { friendlyErrorText } from '../../lib/friendlyError';

/**
 * Skill browse + install picker for the deploy form. A "skill" is a reusable
 * bundle of instructions + declarative tools that composes into the agent's
 * actual behavior (system prompt + tool belt). Two ways in:
 *   1. Browse the public registry (search + capability filter).
 *   2. Import a SKILL.md file (open Agent Skills standard) — parsed
 *      preview-first (scripts are never imported; warnings shown), saved as a
 *      private skill you can then select.
 *
 * The parent owns the selected slug list + the shared toolSecrets map; this
 * component surfaces each selected skill's secret_refs as inputs feeding that
 * same map (identical mechanism to ToolManager).
 */

export interface RegistrySkill {
  id: number;
  slug: string;
  name: string;
  description: string;
  version: string;
  author_address: string;
  capabilities: string[];
  install_count: number;
  secret_refs: Array<{ secret_ref: string; key_name?: string; type?: string } | string>;
}

function secretRefKey(r: RegistrySkill['secret_refs'][number]): string {
  return typeof r === 'string' ? r : r.secret_ref;
}

export default function SkillPicker({
  selectedSlugs,
  onChange,
  secrets,
  onSecretsChange,
  onImported,
}: {
  selectedSlugs: string[];
  /** caps = union of the selected skills' capability tags, so the parent can
   *  auto-check them in its capability picker. */
  onChange: (slugs: string[], caps?: string[]) => void;
  secrets: Record<string, string>;
  onSecretsChange: (s: Record<string, string>) => void;
  /** Fired per skill created via the importer. `isPublic=false` skills can't
   *  install through the unauthenticated deploy route — the parent must
   *  attach them post-deploy via the authed POST /agents/:id/skills. */
  onImported?: (slug: string, isPublic: boolean) => void;
}) {
  const [tab, setTab] = useState<'browse' | 'import'>('browse');
  const [query, setQuery] = useState('');
  const [list, setList] = useState<RegistrySkill[]>([]);
  const [selectedMeta, setSelectedMeta] = useState<Record<string, RegistrySkill>>({});
  const [loading, setLoading] = useState(false);

  // Always-current mirrors for callbacks that fire in loops (multi-import
  // calls onCreated several times from one click-time closure — reading the
  // render-scoped state there would drop all but the last addition).
  const selectedSlugsRef = useRef(selectedSlugs);
  selectedSlugsRef.current = selectedSlugs;
  const selectedMetaRef = useRef(selectedMeta);
  selectedMetaRef.current = selectedMeta;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await get<{ skills: RegistrySkill[] }>(
        `/api/v1/skills?limit=30${query.trim() ? `&q=${encodeURIComponent(query.trim())}` : ''}`,
      );
      setList(r.skills ?? []);
    } catch { setList([]); } finally { setLoading(false); }
  }, [query]);

  useEffect(() => { void load(); }, [load]);

  // Union of the selected skills' capability tags — passed back so the parent
  // can auto-check them. Derived from the freshest meta map.
  const capsFor = (slugs: string[], meta: Record<string, RegistrySkill>) =>
    [...new Set(slugs.flatMap((slug) => meta[slug]?.capabilities ?? []))];

  const toggle = (s: RegistrySkill) => {
    if (selectedSlugs.includes(s.slug)) {
      const next = selectedSlugs.filter((x) => x !== s.slug);
      onChange(next, capsFor(next, selectedMeta));
    } else {
      const meta = { ...selectedMeta, [s.slug]: s };
      setSelectedMeta(meta);
      const next = [...selectedSlugs, s.slug];
      onChange(next, capsFor(next, meta));
    }
  };

  // Union of secret refs across selected skills → inputs.
  const selectedSkills = selectedSlugs.map((slug) => selectedMeta[slug]).filter(Boolean);
  const requiredSecretRefs = [...new Set(selectedSkills.flatMap((s) => s.secret_refs.map(secretRefKey)))];

  return (
    <div className="space-y-4">
      <div role="tablist" className="flex gap-6 border-b border-line">
        {([['browse', 'Browse registry'], ['import', 'Import SKILL.md']] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`pb-2.5 -mb-px text-xs border-b-2 transition-colors ${tab === id
              ? 'text-ink font-medium border-accent'
              : 'text-ink-3 border-transparent hover:text-ink-2'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'browse' ? (
        <div className="space-y-3">
          <FormInput
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search skills by name or description…"
          />
          {loading ? (
            <div className="py-6 flex justify-center"><Spinner size={18} /></div>
          ) : list.length === 0 ? (
            <p className="text-xs text-ink-3 py-3">No public skills yet. Import a SKILL.md to create the first one.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {list.map((s) => {
                const active = selectedSlugs.includes(s.slug);
                return (
                  <button
                    key={s.slug}
                    type="button"
                    onClick={() => toggle(s)}
                    aria-pressed={active}
                    className={`text-left rounded-xl border p-3.5 transition-colors ${active
                      ? 'border-[color:color-mix(in_srgb,var(--bb-accent)_45%,transparent)] bg-[color:color-mix(in_srgb,var(--bb-accent)_5%,transparent)]'
                      : 'border-line bg-surface-2 hover:border-line-2'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-ink truncate">{s.name}</span>
                      {active && <Icon name="check" size={14} className="text-accent shrink-0" />}
                    </div>
                    <p className="text-xs text-ink-3 mt-1 line-clamp-2">{s.description}</p>
                    <div className="flex flex-wrap gap-1 mt-2">
                      {s.capabilities.slice(0, 3).map((c) => <Tag key={c} tone="neutral">{c.replace(/_/g, ' ')}</Tag>)}
                      <span className="text-[10px] text-ink-3 self-center ml-auto">{s.install_count} installs</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <SkillMdImport
          remainingSlots={Math.max(0, MAX_SKILLS - selectedSlugs.length)}
          onCreated={(s, isPublic) => {
            const meta = { ...selectedMetaRef.current, [s.slug]: s };
            selectedMetaRef.current = meta;
            setSelectedMeta(meta);
            const next = [...selectedSlugsRef.current, s.slug];
            selectedSlugsRef.current = next;
            onChange(next, capsFor(next, meta));
            onImported?.(s.slug, isPublic);
            void load();
            // Stay on the import tab — a multi-import batch shows per-card
            // progress here; the selected chips below reflect additions live.
          }}
        />
      )}

      {selectedSkills.length > 0 && (
        <div className="border-t border-line pt-3 space-y-2">
          <div className="text-xs text-ink-2 font-medium">{selectedSkills.length} skill(s) selected</div>
          <div className="flex flex-wrap gap-1.5">
            {selectedSkills.map((s) => (
              <span key={s.slug} className="inline-flex items-center gap-1 px-2.5 py-0.5 text-xs border border-[color:color-mix(in_srgb,var(--bb-accent)_45%,transparent)] bg-[color:color-mix(in_srgb,var(--bb-accent)_5%,transparent)] text-ink rounded-full">
                {s.name}
                <button type="button" onClick={() => toggle(s)} aria-label={`Remove ${s.name}`}>
                  <Icon name="x" size={11} />
                </button>
              </span>
            ))}
          </div>
          {requiredSecretRefs.length > 0 && (
            <div className="space-y-2 pt-2">
              <div className="text-xs text-ink-3">These skills need secrets (API keys/tokens) — stored encrypted, never shown again:</div>
              {requiredSecretRefs.map((ref) => (
                <FormField key={ref} label={ref}>
                  <FormInput
                    type="password"
                    value={secrets[ref] ?? ''}
                    onChange={(e) => onSecretsChange({ ...secrets, [ref]: e.target.value })}
                    placeholder={`Secret for ${ref}`}
                  />
                </FormField>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Mirrors backend MAX_SKILLS_PER_AGENT (skillComposer.ts) — keep in sync.
const MAX_SKILLS = 10;

interface ParsedPreview {
  name: string;
  description: string;
  version: string;
  instructions: string;
  warnings: string[];
}

interface StagedSkill {
  key: string;                 // local list key
  sourceLabel: string;         // filename or "pasted"
  parsed: ParsedPreview | null; // null = parse failed
  slug: string;                // editable
  status: 'ready' | 'importing' | 'error';
  error?: string;
}

const deriveSlug = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/**
 * Multi-skill importer: files and/or pastes accumulate into a staged queue
 * (one card per skill, editable slug, parse warnings), then one action
 * imports the whole queue via sequential POST /skills — per-card errors
 * (e.g. SLUG_TAKEN) stay on their card for rename-and-retry. Max-10 cap is
 * shared with registry selections.
 */
function SkillMdImport({
  onCreated,
  remainingSlots,
}: {
  onCreated: (s: RegistrySkill, isPublic: boolean) => void;
  remainingSlots: number;
}) {
  const [text, setText] = useState('');
  const [queue, setQueue] = useState<StagedSkill[]>([]);
  // Default PRIVATE: publishing makes the full instruction body world-readable
  // on the public registry. Private drafts still deploy fine — they're
  // attached post-deploy via the authed per-agent install route.
  const [makePublic, setMakePublic] = useState(false);
  const [busy, setBusy] = useState(false);

  let keyCounter = queue.length;
  const nextKey = () => `staged-${Date.now()}-${keyCounter++}`;

  const slotsLeft = remainingSlots - queue.filter((q) => q.parsed).length;

  const parseOne = async (source: string, sourceLabel: string): Promise<StagedSkill> => {
    try {
      const p = await authedPost<ParsedPreview>('/api/v1/skills/parse-skillmd', { text: source });
      return { key: nextKey(), sourceLabel, parsed: p, slug: deriveSlug(p.name), status: 'ready' };
    } catch (e) {
      return { key: nextKey(), sourceLabel, parsed: null, slug: '', status: 'error', error: friendlyErrorText(e) };
    }
  };

  const addPaste = async () => {
    if (!text.trim()) return;
    setBusy(true);
    const staged = await parseOne(text, 'pasted');
    setQueue((q) => [...q, staged]);
    if (staged.parsed) setText('');
    setBusy(false);
  };

  const addFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    const picked = Array.from(files);
    const staged: StagedSkill[] = [];
    for (const f of picked) {
      // One SKILL.md per file — no multi-document splitting ambiguity.
      const source = await f.text();
      staged.push(await parseOne(source, f.name));
    }
    setQueue((q) => [...q, ...staged]);
    setBusy(false);
  };

  const updateSlug = (key: string, slug: string) =>
    setQueue((q) => q.map((item) => (item.key === key ? { ...item, slug, status: 'ready', error: undefined } : item)));
  const remove = (key: string) => setQueue((q) => q.filter((item) => item.key !== key));

  // Intra-batch duplicate slugs block import until renamed.
  const readySlugs = queue.filter((q) => q.parsed).map((q) => q.slug);
  const dupSlugs = new Set(readySlugs.filter((s, i) => s && readySlugs.indexOf(s) !== i));
  const importable = queue.filter((q) => q.parsed && q.slug && !dupSlugs.has(q.slug));
  const overCap = queue.filter((q) => q.parsed).length > remainingSlots;

  const importAll = async () => {
    setBusy(true);
    for (const item of importable) {
      setQueue((q) => q.map((x) => (x.key === item.key ? { ...x, status: 'importing' } : x)));
      try {
        const skill = await authedPost<RegistrySkill>('/api/v1/skills', {
          slug: item.slug,
          name: item.parsed!.name,
          description: item.parsed!.description,
          version: item.parsed!.version,
          instructions: item.parsed!.instructions,
          source: 'skillmd',
          isPublic: makePublic,
        });
        onCreated(skill, makePublic);
        setQueue((q) => q.filter((x) => x.key !== item.key)); // done → selected chip below
      } catch (e) {
        // e.g. 409 SLUG_TAKEN — stays on the card; edit the slug and re-import.
        setQueue((q) => q.map((x) => (x.key === item.key ? { ...x, status: 'error', error: friendlyErrorText(e) } : x)));
      }
    }
    setBusy(false);
  };

  return (
    <div className="space-y-3">
      {/* Sources: multiple files, or repeated pastes — both feed the queue. */}
      <div className="flex flex-wrap items-center gap-3">
        <label className={`inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 border border-line text-xs cursor-pointer transition-colors ${slotsLeft <= 0 ? 'opacity-40 cursor-not-allowed' : 'hover:border-line-2 text-ink-2'}`}>
          <Icon name="plus" size={12} />
          Add SKILL.md files
          <input
            type="file"
            multiple
            accept=".md,.markdown,.txt"
            className="hidden"
            disabled={busy || slotsLeft <= 0}
            onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }}
          />
        </label>
        <span className="text-[11px] text-ink-3">
          {slotsLeft > 0 ? `${slotsLeft} of ${MAX_SKILLS} skill slots left` : `Skill limit reached (${MAX_SKILLS} per agent)`}
        </span>
      </div>

      <FormField label="Or paste a SKILL.md" hint="Frontmatter + instructions. Bundled scripts are never imported.">
        <FormTextarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={'---\nname: my-skill\ndescription: …\n---\n\nInstructions for the agent…'} />
      </FormField>
      <Button
        type="button" variant="outline" size="sm"
        label={busy ? 'Parsing…' : 'Add to import list'}
        onClick={() => void addPaste()}
        disabled={busy || text.trim().length === 0 || slotsLeft <= 0}
      />

      {/* Staged queue */}
      {queue.length > 0 && (
        <div className="space-y-2 pt-1">
          {queue.map((item) => (
            <div key={item.key} className={`rounded-xl border p-3.5 space-y-2 ${item.status === 'error' ? 'border-[color-mix(in_srgb,var(--bb-err)_50%,transparent)] bg-[color-mix(in_srgb,var(--bb-err)_5%,transparent)]' : dupSlugs.has(item.slug) ? 'border-[color-mix(in_srgb,var(--bb-warn)_50%,transparent)] bg-[color-mix(in_srgb,var(--bb-warn)_5%,transparent)]' : 'border-line bg-surface-2'}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  {item.parsed ? (
                    <div className="text-sm text-ink font-medium truncate">
                      {item.parsed.name} <span className="text-ink-3 font-normal">v{item.parsed.version}</span>
                      <span className="ml-2 text-[10px] font-mono text-ink-3">{item.sourceLabel}</span>
                    </div>
                  ) : (
                    <div className="text-sm text-err font-medium truncate">Couldn't parse {item.sourceLabel}</div>
                  )}
                  {item.parsed?.description && <div className="text-xs text-ink-2 mt-0.5 line-clamp-2">{item.parsed.description}</div>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {item.status === 'importing' && <Spinner size={14} />}
                  <button type="button" onClick={() => remove(item.key)} aria-label="Remove from import list" className="text-ink-3 hover:text-ink">
                    <Icon name="x" size={13} />
                  </button>
                </div>
              </div>
              {item.parsed && item.parsed.warnings.length > 0 && (
                <div className="rounded-lg border border-[color:color-mix(in_srgb,var(--bb-warn)_45%,transparent)] bg-[color:color-mix(in_srgb,var(--bb-warn)_7%,transparent)] px-3 py-2 space-y-1">
                  {item.parsed.warnings.map((w, i) => <div key={i} className="text-[11px] text-ink-2 leading-snug">{w}</div>)}
                </div>
              )}
              {item.parsed && (
                <FormField label="Slug" hint={dupSlugs.has(item.slug) ? undefined : 'Unique id, lowercase kebab-case.'}>
                  <FormInput type="text" value={item.slug} onChange={(e) => updateSlug(item.key, deriveSlug(e.target.value) || e.target.value)} placeholder="my-skill" />
                </FormField>
              )}
              {item.parsed && (
                <details className="group">
                  <summary className="text-[11px] text-ink-3 cursor-pointer hover:text-ink-2 select-none">
                    Preview instructions ({(item.parsed.instructions.length / 1024).toFixed(1)} KB)
                  </summary>
                  <pre className="whitespace-pre-wrap break-words text-[11px] text-ink-3 max-h-40 overflow-y-auto rounded-lg border border-line p-2.5 mt-1.5">{item.parsed.instructions}</pre>
                </details>
              )}
              {dupSlugs.has(item.slug) && <div className="text-[11px] text-warn">Duplicate slug in this import list — rename one.</div>}
              {item.error && <div className="text-xs text-err break-words">{item.error}</div>}
            </div>
          ))}

          <label className="flex items-center gap-2 text-xs text-ink-2">
            <input type="checkbox" checked={makePublic} onChange={(e) => setMakePublic(e.target.checked)} />
            Publish to the public registry
          </label>
          {makePublic ? (
            <div className="text-[11px] text-warn">
              Published skills are world-readable — name, description, and the full instructions above. Anyone can install them.
            </div>
          ) : (
            <div className="text-[11px] text-ink-3">
              Kept private: only you can see or use these skills. They're attached to your agent right after deploy.
            </div>
          )}

          <Button
            type="button" variant="primary" size="sm"
            label={busy ? 'Importing…' : `Import ${importable.length} skill${importable.length === 1 ? '' : 's'}`}
            onClick={() => void importAll()}
            disabled={busy || importable.length === 0 || dupSlugs.size > 0 || overCap}
          />
          {overCap && <div className="text-[11px] text-warn">Too many skills staged — an agent can have at most {MAX_SKILLS}.</div>}
        </div>
      )}
    </div>
  );
}
