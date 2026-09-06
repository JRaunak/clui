import { useState } from 'react'
import { useActive, EMPTY_STRINGS } from '../store'
import { IconChevron, IconFile } from './Icon'

/** Workspace-relative path; a file outside cwd stays absolute. */
function toWorkspaceRelative(cwd: string | null, path: string): string {
  return cwd && path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path
}

export function ChangedFiles(): JSX.Element | null {
  const changedFiles = useActive((s) => s?.changedFiles ?? EMPTY_STRINGS)
  const cwd = useActive((s) => s?.cwd ?? null)
  const [open, setOpen] = useState(true)
  const [error, setError] = useState<string | null>(null)
  if (changedFiles.length === 0) return null

  const openFile = async (path: string): Promise<void> => {
    setError(null)
    try {
      await window.clui.openInEditor(path)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    // The composer paints on top as the later sibling; this negative bottom margin tucks the card
    // behind its top edge so it reads as sliding out from under it.
    <div className="mx-auto -mb-3 w-full max-w-5xl px-11">
      <div className="dock-fade-top rounded-t-xl border border-b-0 border-border bg-bg-elev px-4 pb-5 pt-2 text-xs">
        <button
          className="flex items-center gap-1.5 text-dim transition-colors hover:text-content"
          onClick={() => setOpen((o) => !o)}
        >
          <IconChevron className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`} />
          <IconFile className="h-3.5 w-3.5" />
          Changed files
          <span className="rounded-full bg-bg-raised px-1.5 py-0.5 text-[10px] font-semibold tabular-nums">
            {changedFiles.length}
          </span>
        </button>
        {open && (
          <div className="mt-1.5 flex flex-col gap-0.5">
            {changedFiles.map((f) => {
              const rel = toWorkspaceRelative(cwd, f)
              const cut = rel.lastIndexOf('/')
              const dir = cut >= 0 ? rel.slice(0, cut + 1) : ''
              const base = cut >= 0 ? rel.slice(cut + 1) : rel
              return (
                <button
                  key={f}
                  className="group flex items-center rounded px-1 py-0.5 text-left font-mono text-[12px] transition-colors hover:bg-bg-raised"
                  onClick={() => void openFile(f)}
                  title={`Open in editor: ${f}`}
                >
                  {/* Directory truncates from the START (rtl) so the ellipsis eats leftmost
                      segments, keeping the basename visible. */}
                  {dir && (
                    <span className="min-w-0 flex-1 truncate text-left text-faint [direction:rtl] group-hover:text-accent">
                      {dir}
                    </span>
                  )}
                  <span className="shrink-0 font-medium text-content group-hover:text-accent">{base}</span>
                </button>
              )
            })}
            {error && <div className="mt-1 text-[12px] text-err">{error}</div>}
          </div>
        )}
      </div>
    </div>
  )
}
