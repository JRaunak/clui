/** The expanded sidebar's New session control: a split-button. The wide segment starts an unnamed session;
 *  the tag segment opens the named-session dialog directly. One accent fill, subdivided. */
import { IconPlus, IconTag } from './Icon'

export function SplitNewSession({
  onNew,
  onNewNamed,
  disabled = false,
  disabledTitle
}: {
  onNew: () => void
  onNewNamed: () => void
  /** CLI can't start a session: render an inert neutral affordance (aria-disabled + tooltip). */
  disabled?: boolean
  disabledTitle?: string
}): JSX.Element {
  const base =
    'flex h-9 items-center justify-center transition-colors duration-150 ease-out ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ' +
    'focus-visible:ring-offset-2 focus-visible:ring-offset-bg-sidebar focus-visible:z-10'
  // Neutral inert fill when disabled, so it can't read as a live accent button (mirrors the Button
  // disabled treatment). aria-disabled + tooltip keep it perceivable beyond color; clicks no-op.
  const seg = disabled
    ? `${base} cursor-default bg-bg-raised text-faint`
    : `${base} bg-accent text-on-accent hover:bg-accent-hover active:scale-[0.98]`

  // Two buttons flush at the inner corners read as one pill; each rounds its own outer corners so an offset focus ring isn't clipped.
  return (
    <div role="group" aria-label="New session" className="flex w-full">
      <button
        data-new-session
        onClick={disabled ? undefined : onNew}
        aria-disabled={disabled || undefined}
        title={disabled ? disabledTitle : undefined}
        className={`${seg} flex-1 gap-2 rounded-l-md text-sm font-semibold`}
      >
        <IconPlus className="h-4 w-4" />
        New session
      </button>
      <button
        aria-haspopup="dialog"
        aria-label="New named session"
        aria-disabled={disabled || undefined}
        title={disabled ? disabledTitle : 'New named session ⌘⇧N'}
        onClick={disabled ? undefined : onNewNamed}
        className={`${seg} w-9 shrink-0 rounded-r-md border-l ${disabled ? 'border-border' : 'border-on-accent/25'}`}
      >
        {/* A tag, not a chevron: this opens the name dialog, so it signals labeling the session. */}
        <IconTag className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
