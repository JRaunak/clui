import type { ReactNode } from 'react'
import type { CluiSettings, SettingsKey, SettingsSource } from '../../../../shared/settings'
import type { SettingsSection } from '../../store'
import { IconCheck } from '../Icon'

export type DraftProps = {
  settings: CluiSettings
  sources: Record<SettingsKey, SettingsSource>
  set: <K extends keyof CluiSettings>(key: K, value: CluiSettings[K]) => void
  reset: (key: SettingsKey) => void
  isOverridden: (key: SettingsKey) => boolean
}

/** Every pane stays mounted while Settings is open, so a switch keeps its drafts, forms and scroll. */
export function Pane({
  section,
  active,
  className,
  children
}: {
  section: SettingsSection
  active: boolean
  className: string
  children: ReactNode
}): JSX.Element {
  return (
    <div
      role="tabpanel"
      id={`settings-panel-${section}`}
      aria-labelledby={`settings-tab-${section}`}
      hidden={!active}
      className={`h-full overflow-y-auto [scrollbar-gutter:stable] py-4 pl-5 pr-3 ${className}`}
    >
      {children}
    </div>
  )
}

/** The box of a checkbox row; the row itself is the `role="checkbox"` button and a `group`. */
export function CheckBox({ checked }: { checked: boolean }): JSX.Element {
  return (
    <span
      className={`flex h-4 w-4 flex-none items-center justify-center rounded-[4px] border transition-colors duration-150 ${
        checked ? 'border-content bg-content text-bg' : 'border-control-edge text-transparent group-hover:border-dim group-aria-disabled:border-border'
      }`}
    >
      <IconCheck className="h-3 w-3" />
    </span>
  )
}

export function Field({
  label,
  hint,
  hintId,
  onReset,
  note,
  children
}: {
  label: string
  hint?: string
  /** id for the hint <p>, so a control in `children` can point aria-describedby at it. */
  hintId?: string
  /** Present only while this field holds an override, and its presence is the "modified"
   *  marker. A neutral gutter rule can't reach 3:1 non-text contrast on this surface (the
   *  best neutral is 1.79:1) and the accent is reserved, so the control carries the state. */
  onReset?: () => void
  /** Rendered after the hint, for a state the hint can't express (e.g. a degraded source). */
  note?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      {/* min-h-6 keeps the row a constant height whether or not the button is there,
          so resetting a field doesn't reflow everything below it. */}
      <div className="flex min-h-6 items-center justify-between gap-3">
        <label className="text-ui font-semibold text-content">{label}</label>
        {onReset && (
          <button
            type="button"
            onClick={onReset}
            aria-label={`Reset ${label} to its inherited value`}
            className="-mr-1.5 flex h-6 items-center rounded px-1.5 text-label font-medium text-dim transition-colors hover:text-content"
          >
            Reset
          </button>
        )}
      </div>
      {children}
      {hint && (
        <p id={hintId} className="text-meta text-dim">
          {hint}
        </p>
      )}
      {note}
    </div>
  )
}
