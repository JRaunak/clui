import { useEffect, useState } from 'react'
import { IconClose } from './Icon'

/**
 * One toast at a time; fixed position so it doesn't reflow content.
 */
export function Toast({
  message,
  highlight,
  actionLabel,
  onAction,
  durationMs,
  onDismiss
}: {
  message: string
  /** Emphasized fragment shown after `message` (e.g. the deleted session title). */
  highlight?: string
  actionLabel: string
  onAction: () => void
  durationMs: number
  onDismiss: () => void
}): JSX.Element {
  const [shown, setShown] = useState(false)
  // A key that changes with each new toast so the progress bar restarts its drain.
  useEffect(() => {
    // Trigger the enter transition on mount.
    const id = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(id)
  }, [])

  // Top-center, not bottom: the composer dock floats bottom-center and --dock-h isn't in this
  // sidebar subtree to offset against, so a bottom toast would block the model/mode row.
  return (
    <div className="pointer-events-none fixed inset-x-0 top-5 z-[60] flex justify-center px-4">
      <div
        className={`pointer-events-auto flex w-[min(420px,100%)] flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-raised shadow-lg transition-[transform,opacity] duration-200 ease-out ${
          shown ? 'translate-y-0 opacity-100' : '-translate-y-2 opacity-0'
        }`}
        role="status"
      >
        <div className="flex items-center gap-3 px-4 py-3 text-sm">
          <span className="min-w-0 flex-1 truncate text-content">
            {message}
            {highlight && <span className="text-dim"> {highlight}</span>}
          </span>
          <button
            className="shrink-0 rounded px-1 py-1 font-semibold text-accent transition-colors hover:text-accent-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            onClick={onAction}
          >
            {actionLabel}
          </button>
          <button
            className="shrink-0 rounded p-1.5 text-dim transition-colors hover:text-content"
            onClick={onDismiss}
            title="Dismiss"
          >
            <IconClose className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="h-0.5 w-full bg-border">
          <div
            className="h-full bg-accent"
            style={{
              animation: `toast-drain ${durationMs}ms linear forwards`
            }}
          />
        </div>
      </div>
    </div>
  )
}
