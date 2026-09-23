import { useEffect, useState } from 'react'

/**
 * Top-center, not bottom: the composer dock owns bottom-center and --dock-h isn't in this subtree
 * to offset against. No dismiss ✕: waiting IS the commit and Undo is the only action, so a ✕ would
 * read as "cancel" and invert the meaning.
 */
export function Toast({
  title,
  suffix,
  actionLabel,
  onAction,
  durationMs
}: {
  /** Primary token, emphasized; truncates under width pressure so the recognizable name survives. */
  title: string
  /** Dim trailing verb naming what Undo reverses (e.g. "· deleted"); never truncates. */
  suffix?: string
  actionLabel: string
  onAction: () => void
  durationMs: number
}): JSX.Element {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(id)
  }, [])

  return (
    <div className="pointer-events-none fixed inset-x-0 top-5 z-[60] flex justify-center px-4">
      <div
        className={`pointer-events-auto relative inline-flex min-w-[min(300px,calc(100vw-2rem))] max-w-[min(360px,calc(100vw-2rem))] items-center gap-3 overflow-hidden rounded-lg border border-border bg-bg-raised px-3.5 py-1 text-xs shadow-md transition-[transform,opacity] duration-200 ease-out ${
          shown ? 'translate-y-0 opacity-100' : '-translate-y-2 opacity-0'
        }`}
        role="status"
      >
        <span className="flex min-w-0 flex-1 items-baseline gap-1">
          <span className="min-w-0 truncate font-medium text-content">{title}</span>
          {suffix && <span className="shrink-0 text-dim">{suffix}</span>}
        </span>
        <button
          className="shrink-0 rounded px-2 py-1.5 font-semibold text-accent transition-colors hover:text-accent-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          onClick={onAction}
        >
          {actionLabel}
        </button>
        {/* Neutral (not accent) countdown so the sole accent stays on Undo; hidden under
            reduced-motion where the drain keyframe would otherwise snap to empty and sit broken. */}
        <div
          className="absolute bottom-0 left-0 h-px bg-content/20 motion-reduce:hidden"
          style={{ animation: `toast-drain ${durationMs}ms linear forwards` }}
        />
      </div>
    </div>
  )
}
