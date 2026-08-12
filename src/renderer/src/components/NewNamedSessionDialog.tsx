/**
 * Collects a name for a new session, then hands it to `App.startNamedSession` (pick +
 * spawn with `-n`). Autofocuses the input, so it skips `useDialogFocus` (which exists
 * for dialogs that must NOT preselect a control).
 */
import { useRef, useState } from 'react'
import { useEscape } from '../lib/useEscape'
import { useClickOutside } from '../lib/useClickOutside'
import { Button } from './Button'

export function NewNamedSessionDialog({
  onClose,
  onConfirm
}: {
  onClose: () => void
  /** Given the trimmed name (possibly empty), run the pick + spawn. */
  onConfirm: (name: string) => void
}): JSX.Element {
  const [value, setValue] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Esc / outside-click both cancel (focus restores to the trigger via App's inert
  // effect). Enter confirms.
  useEscape(true, onClose)
  useClickOutside(panelRef, true, onClose)

  const confirm = (): void => onConfirm(value.trim())

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[18vh]">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Name this session"
        className="flex w-[min(420px,92%)] flex-col gap-4 rounded-xl border border-border bg-bg-elev p-5 shadow-lg"
      >
        <h2 className="font-serif text-lg font-semibold text-content">Name this session</h2>
        <div className="flex flex-col gap-1.5">
          <input
            ref={inputRef}
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                confirm()
              }
            }}
            placeholder="e.g. PROJ-1234 or a short label"
            className="h-11 rounded-md border border-border bg-bg px-3 text-sm text-content outline-none focus:border-accent placeholder:text-faint"
            spellCheck={false}
          />
          <p className="text-[12px] text-faint">
            Used as the session title from the first turn. Leave blank for an unnamed session.
          </p>
        </div>
        <div className="flex items-center justify-end gap-3">
          <Button variant="outline" size="md" onClick={onClose}>
            Cancel
          </Button>
          {/* Constant label: a blank submit does the same visible thing (open the folder
              picker), so an empty name never reads as an error. */}
          <Button variant="primary" size="md" onClick={confirm}>
            Choose folder…
          </Button>
        </div>
      </div>
    </div>
  )
}
