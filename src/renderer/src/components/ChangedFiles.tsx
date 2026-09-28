import { useId, useState } from 'react'
import { useActive, EMPTY_STRINGS } from '../store'
import { IconChevron, IconFile } from './Icon'

/** Workspace-relative path; a file outside cwd stays absolute. */
function toWorkspaceRelative(cwd: string | null, path: string): string {
  return cwd && path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path
}

export function ChangedFiles(): JSX.Element | null {
  const changedFiles = useActive((s) => s?.changedFiles ?? EMPTY_STRINGS)
  const cwd = useActive((s) => s?.cwd ?? null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const listId = useId()
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
    // behind its top edge so it reads as sliding out from under it. It hides while a Gate is in the
    // dock, including the Gate's exit, so it never floats on the dock's full-height frame.
    <div data-ui="changed-files" className="mx-auto -mb-3 w-full max-w-5xl px-11 group-has-[[data-ui=gate]]/dock:hidden">
      <div className="dock-fade-top rounded-t-xl border border-b-0 border-border bg-bg-elev px-4 pb-5 pt-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          className="-mx-1 flex h-6 items-center gap-1.5 rounded px-1 text-label text-dim transition-colors hover:text-content"
          onClick={() => setOpen((o) => !o)}
        >
          <IconChevron className={`h-3 w-3 transition-transform duration-fast ease-out ${open ? 'rotate-90' : ''}`} />
          <IconFile className="h-3.5 w-3.5" />
          Changed files
          <span className="rounded-full bg-bg-raised px-1.5 py-0.5 text-badge tabular-nums">{changedFiles.length}</span>
        </button>
        {open && (
          <>
            <ul id={listId} className="-mx-1 mt-0.5 flex max-h-48 flex-col overflow-y-auto">
              {changedFiles.map((f) => {
                const rel = toWorkspaceRelative(cwd, f)
                const cut = rel.lastIndexOf('/')
                const dir = cut > 0 ? rel.slice(0, cut) : ''
                const base = cut >= 0 ? rel.slice(cut + 1) : rel
                return (
                  <li key={f}>
                    <button
                      type="button"
                      className="flex h-6 w-full items-baseline gap-2 rounded px-1 text-left leading-6 transition-colors hover:bg-bg-raised"
                      onClick={() => void openFile(f)}
                      title={`Open in editor: ${f}`}
                    >
                      <span className="max-w-full shrink-0 truncate font-mono text-code text-content">{base}</span>
                      {dir && <span className="min-w-0 flex-1 truncate font-mono text-meta text-faint">{dir}</span>}
                    </button>
                  </li>
                )
              })}
            </ul>
            {error && <p role="alert" className="mt-1 text-meta text-err">{error}</p>}
          </>
        )}
      </div>
    </div>
  )
}
