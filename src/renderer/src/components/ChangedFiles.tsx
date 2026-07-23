import { useState } from 'react'
import { useActive, EMPTY_STRINGS } from '../store'
import { IconChevron, IconFile } from './Icon'

/** Collapsible bar listing files changed this session; click to open in editor. */
export function ChangedFiles(): JSX.Element | null {
  const changedFiles = useActive((s) => s?.changedFiles ?? EMPTY_STRINGS)
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
    <div className="border-t border-border bg-bg-elev px-4 py-2 text-xs">
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
          {changedFiles.map((f) => (
            <button
              key={f}
              className="flex items-center gap-1.5 truncate rounded px-1 py-0.5 text-left font-mono text-[12px] text-dim transition-colors hover:bg-bg-raised hover:text-accent"
              onClick={() => void openFile(f)}
              title={`Open in editor: ${f}`}
            >
              <span className="truncate">{f}</span>
            </button>
          ))}
          {error && <div className="mt-1 text-[12px] text-err">{error}</div>}
        </div>
      )}
    </div>
  )
}
