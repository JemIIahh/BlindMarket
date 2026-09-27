import { useState } from 'react';
import { Button, FormInput, Icon, ErrorNotice } from '../bb';
import { authedPost, authedDelete } from '../../lib/api';

export interface InstalledSkillMeta {
  slug: string;
  name: string;
  version: string;
  capabilities?: string[];
}

/** Owner-only skill install/remove for an existing agent. Uses the dedicated
 *  /agents/:id/skills routes (NOT the generic Save, which never touches
 *  skills). New skills take effect on the next restart. */
export function SkillsManager({
  agentId,
  installed,
  agentRunning,
  onChange,
}: {
  agentId: string;
  installed: InstalledSkillMeta[];
  agentRunning: boolean;
  onChange: (skills: InstalledSkillMeta[]) => void;
}) {
  const [slug, setSlug] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>('');
  // Only a running worker keeps its spawn-time composition; a stopped agent
  // picks up the change on next start, so no nudge is needed there.
  const [needsRestart, setNeedsRestart] = useState(false);
  const showRestart = needsRestart && agentRunning;

  const install = async () => {
    if (!slug.trim()) return;
    setBusy(true); setError('');
    try {
      const res = await authedPost<{ agent: { skills?: InstalledSkillMeta[] }; requiresRestart: boolean }>(
        `/api/v1/agents/${agentId}/skills`, { slug: slug.trim() },
      );
      onChange(res.agent.skills ?? []);
      setNeedsRestart(res.requiresRestart);
      setSlug('');
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  const remove = async (s: string) => {
    setBusy(true); setError('');
    try {
      const res = await authedDelete<{ agent: { skills?: InstalledSkillMeta[] }; requiresRestart: boolean }>(
        `/api/v1/agents/${agentId}/skills/${s}`,
      );
      onChange(res.agent.skills ?? []);
      setNeedsRestart(res.requiresRestart);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <div className="text-[13px] font-medium text-ink-2">Skills</div>
      <div className="text-xs text-ink-3 -mt-1">Installed skills shape the agent's prompt and tools. Browse the registry to find slugs.</div>
      {installed.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {installed.map((s) => (
            <span key={s.slug} className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs border border-line-2 bg-surface-2 text-ink">
              {s.name} <span className="opacity-60">v{s.version}</span>
              <button type="button" onClick={() => remove(s.slug)} disabled={busy} aria-label={`Remove ${s.name}`} className="p-2 -m-2">
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <div className="text-xs text-ink-3">No skills installed.</div>
      )}
      <div className="flex gap-2">
        <FormInput className="font-mono" placeholder="skill-slug" value={slug} onChange={(e) => setSlug(e.target.value)} />
        <Button variant="outline" size="sm" label={busy ? '…' : 'Install'} onClick={install} disabled={busy || !slug.trim()} />
      </div>
      {showRestart && (
        <div className="rounded-lg text-[11px] text-ink-2 border border-[color:color-mix(in_srgb,var(--bb-warn)_45%,transparent)] bg-[color:color-mix(in_srgb,var(--bb-warn)_7%,transparent)] px-3 py-2">Restart the agent (stop then start) for skill changes to take effect.</div>
      )}
      <ErrorNotice error={error} title="Couldn't update skills" compact />
    </div>
  );
}
