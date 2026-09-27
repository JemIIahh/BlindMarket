import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '../bb';
import {
  AVATAR_PALETTES,
  AVATAR_PARTS,
  HEADWEAR,
  avatarDataUri,
  avatarFromSeed,
  optionLabel,
  randomAvatar,
  type AvatarColor,
  type AvatarPart,
  type SavedAvatar,
} from './avatarOptions';

type Probability = 'topProbability' | 'facialHairProbability' | 'accessoriesProbability';

interface Tab {
  id: string;
  label: string;
  part?: AvatarPart;
  /** A part that can be left off, with the label of its "none" choice. */
  optional?: { key: Probability; none: string };
  colors?: (draft: SavedAvatar) => AvatarColor[];
  /** Zoom the thumbnails in on the face, where these parts are. */
  face?: boolean;
}

const TABS: Tab[] = [
  {
    id: 'hair',
    label: 'Hair',
    part: 'top',
    optional: { key: 'topProbability', none: 'No hair' },
    colors: (d) => (d.topProbability === 0 ? [] : HEADWEAR.includes(d.top?.[0] ?? '') ? ['hatColor'] : ['hairColor']),
  },
  { id: 'eyes', label: 'Eyes', part: 'eyes', face: true },
  { id: 'brows', label: 'Brows', part: 'eyebrows', face: true },
  { id: 'mouth', label: 'Mouth', part: 'mouth', face: true },
  {
    id: 'beard',
    label: 'Beard',
    part: 'facialHair',
    optional: { key: 'facialHairProbability', none: 'None' },
    colors: (d) => (d.facialHairProbability ? ['facialHairColor'] : []),
    face: true,
  },
  {
    id: 'glasses',
    label: 'Glasses',
    part: 'accessories',
    optional: { key: 'accessoriesProbability', none: 'None' },
    colors: (d) => (d.accessoriesProbability ? ['accessoriesColor'] : []),
    face: true,
  },
  { id: 'clothes', label: 'Clothes', part: 'clothing', colors: () => ['clothesColor'] },
  { id: 'skin', label: 'Skin', colors: () => ['skinColor'] },
  { id: 'background', label: 'Background', colors: () => ['backgroundColor'] },
];

// Scaled about the centre, then moved down so the face (not the hair) fills the tile.
const FACE_ZOOM = { scale: 170, translateY: 8 };

const COLOR_LABEL: Record<AvatarColor, string> = {
  hairColor: 'Hair colour',
  hatColor: 'Hat colour',
  facialHairColor: 'Beard colour',
  accessoriesColor: 'Frame colour',
  clothesColor: 'Colour',
  skinColor: 'Skin tone',
  backgroundColor: 'Background',
};

const selectedRing = 'border-ink ring-1 ring-ink';

/**
 * The avatar builder: a live preview and a picker per part, every choice
 * drawn as the avatar it would make. Starts from the saved avatar, or from
 * the face `seed` already gets (what the person's tasks show until now).
 */
export function AvatarBuilder({
  seed,
  initial,
  saving = false,
  onSave,
  onCancel,
  error,
  note,
}: {
  seed: string;
  initial: SavedAvatar | null;
  saving?: boolean;
  onSave: (avatar: SavedAvatar) => void;
  onCancel?: () => void;
  /** Why the last save failed, shown above the buttons. */
  error?: ReactNode;
  /** A line under the buttons, e.g. where the avatar is saved. */
  note?: ReactNode;
}) {
  const [draft, setDraft] = useState<SavedAvatar>(() => ({ ...avatarFromSeed(seed), ...(initial ?? {}) }));
  const [tabId, setTabId] = useState(TABS[0].id);
  const tab = TABS.find((t) => t.id === tabId) ?? TABS[0];

  const preview = useMemo(() => avatarDataUri(seed, draft), [seed, draft]);

  // Opening a tab scrolls its current choice into the middle of the grid.
  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const grid = gridRef.current;
    const selected = grid?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!grid || !selected) return;
    grid.scrollTop = selected.offsetTop - grid.offsetTop - (grid.clientHeight - selected.clientHeight) / 2;
  }, [tabId]);

  // Every choice on the open tab, drawn on the current avatar.
  const choices = useMemo(() => {
    if (!tab.part) return [];
    const part = tab.part;
    const zoom = tab.face ? FACE_ZOOM : undefined;
    const list: Array<{ value: string | null; label: string; uri: string; selected: boolean }> = [];
    if (tab.optional) {
      const off = { ...draft, [tab.optional.key]: 0 };
      list.push({ value: null, label: tab.optional.none, uri: avatarDataUri(seed, off, zoom), selected: draft[tab.optional.key] === 0 });
    }
    for (const value of AVATAR_PARTS[part]) {
      const on = { ...draft, [part]: [value], ...(tab.optional ? { [tab.optional.key]: 100 } : {}) };
      const shown = !tab.optional || draft[tab.optional.key] !== 0;
      list.push({ value, label: optionLabel(value), uri: avatarDataUri(seed, on, zoom), selected: shown && draft[part]?.[0] === value });
    }
    return list;
  }, [tab, draft, seed]);

  const graphics = useMemo(() => {
    if (tab.id !== 'clothes' || draft.clothing?.[0] !== 'graphicShirt') return [];
    return AVATAR_PARTS.clothingGraphic.map((value) => ({
      value,
      label: optionLabel(value),
      uri: avatarDataUri(seed, { ...draft, clothingGraphic: [value] }),
      selected: draft.clothingGraphic?.[0] === value,
    }));
  }, [tab.id, draft, seed]);

  const choose = (value: string | null) => {
    if (!tab.part) return;
    const part = tab.part;
    setDraft((d) => {
      if (value === null && tab.optional) return { ...d, [tab.optional.key]: 0 };
      return { ...d, [part]: [value as string], ...(tab.optional ? { [tab.optional.key]: 100 } : {}) };
    });
  };

  const setColor = (key: AvatarColor, value: string | null) =>
    setDraft((d) => {
      const next = { ...d };
      if (value === null) delete next[key];
      else next[key] = [value];
      return next;
    });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <img
          src={preview}
          width={112}
          height={112}
          alt="Your avatar"
          className="shrink-0 rounded-full border border-line bg-surface-2"
        />
        <div className="min-w-0 space-y-2">
          <p className="text-sm text-ink-2 leading-relaxed">Shown on the tasks you post. It doesn't reveal who you are.</p>
          <Button variant="outline" size="sm" type="button" label="Randomise" onClick={() => setDraft(randomAvatar())} disabled={saving} />
        </div>
      </div>

      <div role="tablist" aria-label="Avatar parts" className="flex flex-wrap gap-1.5">
        {TABS.map((t) => {
          const active = t.id === tab.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTabId(t.id)}
              className={`rounded-full border px-3.5 py-1.5 text-[13px] transition-colors duration-200 ${
                active ? 'border-transparent bg-invert text-invert-fg' : 'border-line text-ink-3 hover:border-line-2 hover:text-ink'
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" aria-label={tab.label} className="space-y-4 min-h-[300px]">
        {choices.length > 0 && (
          <div ref={gridRef} className="grid grid-cols-5 sm:grid-cols-6 gap-2 max-h-[236px] overflow-y-auto p-0.5">
            {choices.map((c) => (
              <button
                key={c.value ?? 'none'}
                type="button"
                title={c.label}
                aria-label={c.label}
                aria-pressed={c.selected}
                onClick={() => choose(c.value)}
                className={`relative overflow-hidden rounded-xl border p-0.5 transition-colors duration-240 ease-bb ${
                  c.selected ? selectedRing : 'border-line hover:border-line-2'
                }`}
              >
                <img src={c.uri} alt="" className="block w-full aspect-square rounded-[9px] bg-surface-2" loading="lazy" />
                {c.value === null && (
                  <span className="absolute inset-x-0 bottom-0 bg-[color-mix(in_srgb,var(--bb-surface)_85%,transparent)] py-0.5 text-center font-mono text-[9px] uppercase tracking-wider text-ink-3">
                    {c.label}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {graphics.length > 0 && (
          <div className="space-y-2">
            <div className="font-mono text-2xs uppercase tracking-wider text-ink-3">Print</div>
            <div className="grid grid-cols-5 sm:grid-cols-10 gap-1.5">
              {graphics.map((g) => (
                <button
                  key={g.value}
                  type="button"
                  title={g.label}
                  aria-label={g.label}
                  aria-pressed={g.selected}
                  onClick={() => setDraft((d) => ({ ...d, clothingGraphic: [g.value] }))}
                  className={`overflow-hidden rounded-xl border p-0.5 transition-colors duration-240 ease-bb ${g.selected ? selectedRing : 'border-line hover:border-line-2'}`}
                >
                  <img src={g.uri} alt="" className="block w-full aspect-square rounded-[9px] bg-surface-2" loading="lazy" />
                </button>
              ))}
            </div>
          </div>
        )}

        {(tab.colors?.(draft) ?? []).map((key) => {
          const current = draft[key]?.[0] ?? null;
          return (
            <div key={key} className="space-y-2">
              <div className="font-mono text-2xs uppercase tracking-wider text-ink-3">{COLOR_LABEL[key]}</div>
              <div className="flex flex-wrap gap-1.5">
                {key === 'backgroundColor' && (
                  <button
                    type="button"
                    title="No background"
                    aria-label="No background"
                    aria-pressed={current === null}
                    onClick={() => setColor(key, null)}
                    className={`h-7 w-7 rounded-full border bg-surface-2 bg-[linear-gradient(135deg,transparent_45%,var(--bb-line-2)_45%,var(--bb-line-2)_55%,transparent_55%)] ${
                      current === null ? 'border-ink ring-2 ring-ink ring-offset-2 ring-offset-surface' : 'border-line hover:border-line-2'
                    }`}
                  />
                )}
                {AVATAR_PALETTES[key].map((c) => (
                  <button
                    key={c}
                    type="button"
                    title={`#${c}`}
                    aria-label={`${COLOR_LABEL[key]} #${c}`}
                    aria-pressed={current === c}
                    onClick={() => setColor(key, c)}
                    style={{ backgroundColor: `#${c}` }}
                    className={`h-7 w-7 rounded-full border transition-transform duration-240 ease-bb hover:-translate-y-px ${
                      current === c ? 'border-ink ring-2 ring-ink ring-offset-2 ring-offset-surface' : 'border-line'
                    }`}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {error}
      <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
        {onCancel && <Button variant="ghost" size="sm" type="button" label="Cancel" onClick={onCancel} disabled={saving} />}
        <Button variant="primary" size="sm" type="button" label={saving ? 'Saving…' : 'Save avatar'} onClick={() => onSave(draft)} disabled={saving} />
      </div>
      {note && <div className="text-xs text-ink-3 text-right">{note}</div>}
    </div>
  );
}
