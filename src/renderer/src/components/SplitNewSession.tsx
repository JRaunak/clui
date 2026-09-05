/** The expanded sidebar's New session control: a split-button. The wide segment starts an unnamed session;
 *  the tag segment opens the named-session dialog directly. One accent fill, subdivided. */
import { IconPlus, IconTag } from './Icon'

export function SplitNewSession({
  onNew,
  onNewNamed
}: {
  onNew: () => void
  onNewNamed: () => void
}): JSX.Element {
  const seg =
    'flex h-9 items-center justify-center bg-accent text-on-accent transition-colors duration-150 ease-out ' +
    'hover:bg-accent-hover active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-sidebar focus-visible:z-10'

  // Two buttons flush at the inner corners read as one pill; each rounds its own outer corners so an offset focus ring isn't clipped.
  return (
    <div role="group" aria-label="New session" className="flex w-full">
      <button data-new-session onClick={onNew} className={`${seg} flex-1 gap-2 rounded-l-md text-sm font-semibold`}>
        <IconPlus className="h-4 w-4" />
        New session
      </button>
      <button
        aria-haspopup="dialog"
        aria-label="New named session"
        title="New named session ⌘⇧N"
        onClick={onNewNamed}
        className={`${seg} w-9 shrink-0 rounded-r-md border-l border-on-accent/25`}
      >
        {/* A tag, not a chevron: this opens the name dialog, so it signals labeling the session. */}
        <IconTag className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
