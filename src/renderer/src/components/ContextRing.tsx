import { autoCompactPercent } from '../lib/compaction'

/**
 * C1: Context-window usage as a real gauge (like the CLI statusline's
 * `used_percentage`). An arc with a track, threshold coloring, and the percent set
 * in mono inside the ring. NO threshold tick marks: at 30px a 1px radial notch can't
 * be visually mapped to a specific % (the auto-compact point on a 1M window sits ~at
 * 12 o'clock and reads as a smudge), and the info is already carried by the fill
 * color (amber→red) and the tooltip's "auto-compacts near N%".
 */
export function ContextRing({
  percent,
  usedTokens,
  contextWindow
}: {
  percent: number | null
  usedTokens?: number | null
  contextWindow?: number | null
}): JSX.Element {
  // Show an empty ring (0%) before the first turn rather than hiding it entirely.
  const p = Math.max(0, Math.min(100, percent ?? 0))
  const size = 30
  const stroke = 3
  const r = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  const dash = (p / 100) * circ
  const cx = size / 2
  const cy = size / 2

  // Green → amber → red as the context fills.
  const color = p >= 85 ? 'var(--color-err)' : p >= 60 ? 'var(--color-warn)' : 'var(--color-ok)'

  // The auto-compact point isn't drawn on the ring (too small to read) but IS named in
  // the tooltip: it's window-dependent, so a user can't otherwise guess where it falls.
  const compactPct = contextWindow ? autoCompactPercent(contextWindow) : null

  const tooltip =
    usedTokens && contextWindow
      ? `Context: ${fmtTokens(usedTokens)} / ${fmtTokens(contextWindow)} tokens used (${p}%)` +
        (compactPct !== null ? ` — auto-compacts near ${compactPct}%` : '')
      : `Context window: ${p}% used${percent === null ? ' (no turns yet)' : ''}`

  return (
    <div
      className="relative flex h-[30px] w-[30px] items-center justify-center"
      title={tooltip}
      // A gauge is a meter, not a slider (read-only status). aria-valuetext carries the
      // same human-readable figures as the tooltip so AT speaks tokens, not a bare %.
      role="meter"
      aria-label="Context window usage"
      aria-valuenow={p}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={tooltip}
    >
      <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--color-border)" strokeWidth={stroke} />
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circ}`}
          style={{ transition: 'stroke-dasharray 0.4s var(--ease-out), stroke 0.3s ease' }}
        />
      </svg>
      <span
        className="absolute font-mono text-[9px] font-medium leading-none tabular-nums"
        style={{ color }}
      >
        {p}
      </span>
    </div>
  )
}

/** 21500 → "21.5K", 200000 → "200K", 1000000 → "1M". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${m % 1 === 0 ? m : m.toFixed(1)}M`
  }
  if (n >= 1000) {
    const k = n / 1000
    return `${k % 1 === 0 || k >= 100 ? Math.round(k) : k.toFixed(1)}K`
  }
  return String(n)
}
