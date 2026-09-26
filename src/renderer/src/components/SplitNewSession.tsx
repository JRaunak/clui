/** The expanded sidebar's New session control: a split-button. The wide segment starts a
 *  directoryless session (no folder dialog); the icon segment starts an ephemeral "Quick"
 *  session (not saved). One outlined control, subdivided. */
import { IconPlus, IconGhost } from './Icon'

export function SplitNewSession({
  onNew,
  onQuick,
  disabled = false,
  pending = false,
  disabledTitle
}: {
  onNew: () => void
  onQuick: () => void
  /** CLI can't start a session: render an inert neutral affordance (aria-disabled + tooltip). */
  disabled?: boolean
  /** A session spawn is in flight: keep the live styling (busy, not unavailable), dim it, and
   *  swallow clicks so a slow CLI cold-start can't be double-submitted. */
  pending?: boolean
  disabledTitle?: string
}): JSX.Element {
  const base =
    'flex h-9 items-center justify-center transition-colors duration-150 ease-out ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ' +
    'focus-visible:ring-offset-2 focus-visible:ring-offset-bg-sidebar focus-visible:z-10'
  // Faint so disabled can't read as live; aria-disabled + tooltip carry it beyond color.
  const seg = disabled
    ? `${base} cursor-default border border-border text-faint`
    : `${base} border border-control-edge bg-transparent text-content hover:bg-bg-raised active:scale-[0.98] ${
        pending ? 'pointer-events-none opacity-60' : ''
      }`

  // Two buttons flush at the inner corners read as one pill; each rounds its own outer corners so an offset focus ring isn't clipped.
  return (
    <div role="group" aria-label="New session" className="flex w-full">
      <button
        data-new-session
        onClick={disabled ? undefined : onNew}
        aria-disabled={disabled || undefined}
        aria-busy={pending || undefined}
        title={disabled ? disabledTitle : undefined}
        className={`${seg} flex-1 gap-2 rounded-l-md text-sm font-medium`}
      >
        <IconPlus className="h-4 w-4" />
        New session
      </button>
      <button
        aria-label="Quick session (not saved)"
        aria-disabled={disabled || undefined}
        aria-busy={pending || undefined}
        title={disabled ? disabledTitle : 'Quick session · not saved (discarded when closed) · ⌥⌘N'}
        onClick={disabled ? undefined : onQuick}
        className={`${seg} w-9 shrink-0 rounded-r-md border-l-0`}
      >
        <IconGhost className="h-4 w-4" />
      </button>
    </div>
  )
}
