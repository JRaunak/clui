/**
 * The expanded sidebar's New session control: a split-button. The wide segment starts an
 * unnamed session; the caret opens the named-session dialog directly. With a single
 * alternative action, a menu would be overhead. One accent fill, subdivided, so the
 * scarce accent isn't spent on a second control. The collapsed rail omits it (⌘⇧N).
 */
import { IconPlus, IconChevron } from './Icon'

export function SplitNewSession({
  onNew,
  onNewNamed
}: {
  onNew: () => void
  onNewNamed: () => void
}): JSX.Element {
  const seg =
    'flex h-9 items-center justify-center bg-accent text-on-accent transition-colors duration-150 ease-out ' +
    'hover:bg-accent-hover active:bg-accent-deep focus-visible:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-sidebar focus-visible:z-10'

  // Two buttons flush at the inner corners read as one pill; each rounds its own outer
  // corners so an offset focus ring isn't clipped (no overflow-hidden on the group).
  return (
    <div role="group" aria-label="New session" className="flex w-full">
      <button data-new-session onClick={onNew} className={`${seg} flex-1 gap-2 rounded-l-md text-sm font-semibold`}>
        <IconPlus className="h-4 w-4" />
        New session
      </button>
      <button
        aria-haspopup="dialog"
        aria-label="New named session"
        title="New named session  ⌘⇧N"
        onClick={onNewNamed}
        className={`${seg} w-9 shrink-0 rounded-r-md border-l border-on-accent/25`}
      >
        {/* Static: it opens a dialog, not an in-place disclosure, so the chevron doesn't rotate. */}
        <IconChevron className="h-3.5 w-3.5 rotate-90" />
      </button>
    </div>
  )
}
