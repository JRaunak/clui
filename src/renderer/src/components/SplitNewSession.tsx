/** The expanded sidebar's New session control: a split-button. The wide segment starts a
 *  directoryless session (no folder dialog); the icon segment starts an ephemeral "Quick"
 *  session (not saved). One outlined control, subdivided. */
import { useId } from 'react'
import { IconPlus, IconGhost } from './Icon'

/** Why the CLI can't start a session: `reason` shows under the control, `hint` is the pointer tooltip. */
export interface CliUnavailable {
  reason: string
  hint: string
}

export function SplitNewSession({
  onNew,
  onQuick,
  onFixCli,
  unavailable,
  pending = false
}: {
  onNew: () => void
  onQuick: () => void
  onFixCli: () => void
  unavailable: CliUnavailable | null
  /** A spawn is in flight or the CLI is still being checked: keep the live styling (busy, not
   *  unavailable), dim it, and swallow clicks so a slow CLI cold-start can't be double-submitted. */
  pending?: boolean
}): JSX.Element {
  const reasonId = useId()
  const inert = !!unavailable || pending
  const base =
    'flex h-9 items-center justify-center transition-colors duration-150 ease-out ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ' +
    'focus-visible:ring-offset-2 focus-visible:ring-offset-bg-sidebar focus-visible:z-10'
  // Dashed so unavailable reads by shape, not only by the fainter ink.
  const seg = unavailable
    ? `${base} cursor-default border border-dashed border-faint/50 text-faint`
    : `${base} border border-control-edge bg-transparent text-content hover:bg-bg-raised active:scale-[0.98] ${
        pending ? 'pointer-events-none opacity-60' : ''
      }`
  const disabledProps = unavailable
    ? { 'aria-disabled': true, 'aria-describedby': reasonId, title: unavailable.hint }
    : {}

  // Two buttons flush at the inner corners read as one pill; each rounds its own outer corners so an offset focus ring isn't clipped.
  return (
    <>
      <div role="group" aria-label="New session" className="flex w-full">
        <button
          data-new-session
          onClick={inert ? undefined : onNew}
          aria-busy={pending || undefined}
          {...disabledProps}
          className={`${seg} flex-1 gap-2 rounded-l-md text-sm font-medium`}
        >
          <IconPlus className="h-4 w-4" />
          New session
        </button>
        <button
          aria-label="Quick session (not saved)"
          aria-busy={pending || undefined}
          title="Quick session · not saved (discarded when closed) · ⌥⌘N"
          {...disabledProps}
          onClick={inert ? undefined : onQuick}
          className={`${seg} w-9 shrink-0 rounded-r-md border-l-0`}
        >
          <IconGhost className="h-4 w-4" />
        </button>
      </div>
      {unavailable && (
        <p className="flex items-center gap-1.5 text-meta text-dim">
          <span id={reasonId}>{unavailable.reason}</span>
          <button
            type="button"
            className="min-h-6 text-content underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-sidebar"
            onClick={onFixCli}
          >
            Set CLI path
          </button>
        </p>
      )}
    </>
  )
}
