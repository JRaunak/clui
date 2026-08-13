/**
 * The expanded sidebar's New session control: a split-button. The wide segment starts an
 * unnamed session; the caret opens "New named session…". One accent fill, subdivided, so
 * the scarce accent isn't spent on a second control. The collapsed rail omits it (⌘⇧N).
 */
import { useCallback, useRef, useState } from 'react'
import { IconPlus, IconChevron } from './Icon'
import { useEscape } from '../lib/useEscape'
import { useClickOutside } from '../lib/useClickOutside'

export function SplitNewSession({
  onNew,
  onNewNamed
}: {
  onNew: () => void
  onNewNamed: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const caretRef = useRef<HTMLButtonElement>(null)

  // Esc/outside-click close; Esc returns focus to the caret (the menu item it left has
  // unmounted, so focus would otherwise fall to <body>).
  const dismiss = useCallback(() => {
    setOpen(false)
    caretRef.current?.focus()
  }, [])
  useEscape(open, dismiss)
  useClickOutside(ref, open, () => setOpen(false))

  const seg =
    'flex h-9 items-center justify-center bg-accent text-on-accent transition-colors duration-150 ease-out ' +
    'hover:bg-accent-hover active:bg-accent-deep focus-visible:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-sidebar focus-visible:z-10'

  return (
    <div className="relative" ref={ref}>
      {/* Two buttons flush at the inner corners read as one pill; each rounds its own
          outer corners so an offset focus ring isn't clipped (no overflow-hidden). */}
      <div role="group" aria-label="New session" className="flex w-full">
        <button
          data-new-session
          onClick={onNew}
          className={`${seg} flex-1 gap-2 rounded-l-md text-sm font-semibold`}
        >
          <IconPlus className="h-4 w-4" />
          New session
        </button>
        <button
          ref={caretRef}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="New session options"
          onClick={() => setOpen((o) => !o)}
          className={`${seg} w-9 shrink-0 rounded-r-md border-l border-on-accent/25`}
        >
          <IconChevron
            className={`h-3.5 w-3.5 transition-transform duration-150 ${open ? '-rotate-90' : 'rotate-90'}`}
          />
        </button>
      </div>

      {open && (
        <div
          role="menu"
          aria-label="New session options"
          className="absolute left-0 top-full z-30 mt-1 min-w-[220px] rounded-lg border border-border bg-bg-elev p-1 shadow-lg"
        >
          <button
            role="menuitem"
            autoFocus
            onClick={() => {
              setOpen(false)
              onNewNamed()
            }}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] text-content transition-colors hover:bg-bg-raised focus-visible:bg-bg-raised focus-visible:outline-none"
          >
            <span className="flex-1">New named session…</span>
            <span className="font-mono text-[11px] text-faint">⌘⇧N</span>
          </button>
        </div>
      )}
    </div>
  )
}
