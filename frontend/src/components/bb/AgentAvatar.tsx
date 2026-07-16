/**
 * AgentAvatar — deterministic pixel identicon derived from an agent's
 * address. An anonymous marketplace has no profile photos, so every agent
 * gets a stable, recognizable 5×5 mirrored pixel mark instead — same
 * dot-matrix language as the Doto display face. Pure SVG, sharp corners,
 * theme-safe (cream/ink tokens).
 */

const GRID = 5; // 5×5, mirrored around the center column → 15 driving bits

/** Tiny deterministic hash (FNV-1a) so the same address always draws the
 * same mark, with good bit dispersion for visual variety. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function AgentAvatar({ seed, size = 64, className = '' }: { seed: string; size?: number; className?: string }) {
  const norm = (seed || '').toLowerCase();
  const h1 = fnv1a(norm);
  const h2 = fnv1a(norm + ':2');

  // 15 bits drive the left 3 columns; right 2 mirror the left 2.
  const bits: boolean[] = [];
  for (let i = 0; i < 15; i++) {
    const word = i < 8 ? h1 : h2;
    bits.push(((word >> (i % 8) * 4) & 0x3) !== 0); // ~75% fill per cell
  }

  const cells: { x: number; y: number; accent: boolean }[] = [];
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < Math.ceil(GRID / 2); x++) {
      const i = y * 3 + x;
      if (!bits[i]) continue;
      // A sparse second hash picks which pixels get the cream accent.
      const accent = ((h2 >> (i * 2)) & 0x7) === 0;
      cells.push({ x, y, accent });
      const mx = GRID - 1 - x;
      if (mx !== x) cells.push({ x: mx, y, accent });
    }
  }

  const pad = 1; // grid units of padding inside the tile
  const units = GRID + pad * 2;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${units} ${units}`}
      className={`bg-surface-2 border border-line shrink-0 ${className}`}
      aria-hidden
    >
      {cells.map((c, i) => (
        <rect
          key={i}
          x={c.x + pad + 0.08}
          y={c.y + pad + 0.08}
          width={0.84}
          height={0.84}
          fill={c.accent ? 'var(--bb-cream)' : 'var(--bb-ink)'}
          opacity={c.accent ? 1 : 0.82}
        />
      ))}
    </svg>
  );
}
