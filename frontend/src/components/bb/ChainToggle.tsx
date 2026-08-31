import { useState, useRef, useEffect } from 'react';
import { useChain } from '../../context/ChainContext';

const chainLabels: Record<string, { name: string; short: string; color: string }> = {
  base: { name: 'Base', short: 'Base', color: 'bg-blue-500' },
  og: { name: '0G Chain', short: '0G', color: 'bg-ok' },
};

export function ChainToggle() {
  const { activeChain, setActiveChain } = useChain();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const current = chainLabels[activeChain] ?? chainLabels.og;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 px-3 py-1.5 border border-line text-[11px] font-mono text-ink hover:bg-surface-2 transition-colors"
      >
        <span className={`w-1.5 h-1.5 ${current.color} inline-block`} />
        {current.short}
        <svg
          className={`w-3 h-3 text-ink-3 transition-transform ${open ? 'rotate-180' : ''}`}
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 min-w-[160px] border border-line bg-surface text-[11px] font-mono z-50">
          {Object.entries(chainLabels).map(([id, label]) => (
            <button
              key={id}
              onClick={() => {
                setActiveChain(id as 'base' | 'og');
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
                id === activeChain
                  ? 'text-ink bg-surface-2'
                  : 'text-ink-2 hover:bg-surface-2 hover:text-ink'
              }`}
            >
              <span className={`w-1.5 h-1.5 ${label.color} inline-block shrink-0`} />
              {label.name}
              {id === activeChain && (
                <span className="ml-auto text-cream">●</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}