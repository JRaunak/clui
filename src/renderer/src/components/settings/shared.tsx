import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { DEFAULT_SETTINGS, type CluiSettings, type SettingsKey, type SettingsSource } from '../../../../shared/settings'
import { useSession, type SettingsSection, type SettingsSubs } from '../../store'
import { useSettings } from '../../lib/settings'
import type { StagedKey } from './draft'
import { IconCheck } from '../Icon'
import { FieldError } from '../LoginFields'

export type DraftProps = {
  settings: CluiSettings
  sources: Record<SettingsKey, SettingsSource>
  set: <K extends StagedKey>(key: K, value: CluiSettings[K]) => void
  reset: (key: SettingsKey) => void
  isOverridden: (key: SettingsKey) => boolean
}

export const TIMING = 'Applies to new and resumed sessions. Running sessions keep what they started with.'
export const SAVE_FAILED = "Couldn't save this setting. Try again."

const SCROLL = 'overflow-y-auto [scrollbar-gutter:stable] py-4 pl-5 pr-3'

/** Every pane stays mounted while Settings is open, so a switch keeps its drafts, forms and scroll.
 *  A `flush` pane holds a SubNav and SubPanes, which scroll by themselves under the fixed tab row. */
export function Pane({
  section,
  active,
  flush,
  className = '',
  children
}: {
  section: SettingsSection
  active: boolean
  flush?: boolean
  className?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div
      role="tabpanel"
      id={`settings-panel-${section}`}
      aria-labelledby={`settings-tab-${section}`}
      hidden={!active}
      className={flush ? 'flex h-full flex-col' : `h-full ${SCROLL} ${className}`}
    >
      {children}
    </div>
  )
}

type Sub = keyof SettingsSubs

// Not `settings-tab-*`: Settings focuses `settings-tab-${section}` whenever the section changes.
const subTabId = (section: Sub, sub: string): string => `settings-subtab-${section}-${sub}`
const subPanelId = (section: Sub, sub: string): string => `settings-subpanel-${section}-${sub}`

/** The tab a section's sub-nav shows, its first until one is picked during this open. */
export function useSettingsSub<S extends Sub>(section: S, first: SettingsSubs[S]): SettingsSubs[S] {
  return useSession((s) => s.settingsSub[section]) ?? first
}

/** A section's second tab row: the outer tablist's keyboard model turned sideways. */
export function SubNav<S extends Sub>({
  section,
  label,
  tabs,
  value
}: {
  section: S
  label: string
  tabs: readonly { key: SettingsSubs[S]; label: string }[]
  value: SettingsSubs[S]
}): JSX.Element {
  const openSettings = useSession((s) => s.openSettings)
  const select = (key: SettingsSubs[S]): void => {
    openSettings(section, key)
    document.getElementById(subTabId(section, key))?.focus()
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const i = tabs.findIndex((t) => t.key === value)
    const n = tabs.length
    const next =
      e.key === 'ArrowRight'
        ? (i + 1) % n
        : e.key === 'ArrowLeft'
          ? (i - 1 + n) % n
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? n - 1
              : e.key === 'Enter' || e.key === ' '
                ? i
                : -1
    if (next < 0) return
    e.preventDefault()
    if (next !== i) select(tabs[next].key)
  }
  return (
    <div className="flex shrink-0 px-5 pb-3 pt-4">
      <div
        role="tablist"
        aria-orientation="horizontal"
        aria-label={label}
        onKeyDown={onKey}
        className="inline-flex h-8 items-center gap-0.5 rounded-md border border-control-edge bg-control p-0.5"
      >
        {tabs.map(({ key, label }) => {
          const active = key === value
          return (
            <button
              key={key}
              type="button"
              role="tab"
              id={subTabId(section, key)}
              aria-controls={subPanelId(section, key)}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => select(key)}
              className="relative h-7 rounded px-3 text-label text-dim -outline-offset-2 pointer-fine:hover:text-content aria-selected:bg-bg-raised aria-selected:font-medium aria-selected:text-content aria-selected:after:absolute aria-selected:after:inset-x-2 aria-selected:after:bottom-0.5 aria-selected:after:h-0.5 aria-selected:after:rounded-full aria-selected:after:bg-content"
            >
              {label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function SubPane<S extends Sub>({
  section,
  sub,
  active,
  className,
  children
}: {
  section: S
  sub: SettingsSubs[S]
  active: boolean
  className: string
  children: ReactNode
}): JSX.Element {
  return (
    <div
      role="tabpanel"
      id={subPanelId(section, sub)}
      aria-labelledby={subTabId(section, sub)}
      hidden={!active}
      className={`min-h-0 flex-1 ${SCROLL} ${className}`}
    >
      {children}
    </div>
  )
}

/** A setting saved the moment it changes, read from the settings mirror. The new value shows at once and
 *  the saved one comes back if the write fails. `value` is null until the mirror loads. */
export function useInstantSetting<K extends SettingsKey>(
  key: K
): { value: CluiSettings[K] | null; set: (v: CluiSettings[K]) => void; reset: () => void; failed: boolean } {
  const saved = useSettings((s) => (s ? s.values[key] : null))
  const [pending, setPending] = useState<{ value: CluiSettings[K] } | null>(null)
  const [failed, setFailed] = useState(false)
  // Only the latest write settles the display: main applies them in order, so the last one is what sticks.
  const seq = useRef(0)
  const write = (value: CluiSettings[K], reset: boolean): void => {
    if (!useSettings.getState()) return
    const n = ++seq.current
    setPending({ value })
    setFailed(false)
    const patch: Partial<CluiSettings> = reset ? {} : { [key]: value }
    void window.clui.updateSettings(patch, reset ? [key] : undefined).then(
      () => n === seq.current && setPending(null),
      () => {
        if (n !== seq.current) return
        setPending(null)
        setFailed(true)
      }
    )
  }
  return {
    value: pending ? pending.value : saved,
    set: (v) => write(v, false),
    reset: () => write(DEFAULT_SETTINGS[key], true),
    failed
  }
}

/** The box of a checkbox row; the row itself is the `role="checkbox"` button and a `group`. */
export function CheckBox({ checked }: { checked: boolean }): JSX.Element {
  return (
    <span
      className={`flex h-4 w-4 flex-none items-center justify-center rounded-[4px] border transition-colors duration-150 ${
        checked
          ? 'border-content bg-content text-bg group-aria-disabled:border-faint group-aria-disabled:bg-faint'
          : 'border-control-edge text-transparent group-hover:border-dim group-aria-disabled:border-border'
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

type BoolKey = { [K in SettingsKey]: CluiSettings[K] extends boolean ? K : never }[SettingsKey]

/** A field holding one checkbox that saves the moment it's flipped. */
export function CheckField({ setting, label, hint, text, ui }: { setting: BoolKey; label: string; hint: string; text: string; ui?: string }): JSX.Element {
  const s = useInstantSetting(setting)
  const id = useId()
  return (
    <Field label={label} hint={hint} hintId={`${id}-hint`} note={s.failed && <FieldError id={`${id}-err`} text={SAVE_FAILED} />}>
      <button
        type="button"
        role="checkbox"
        data-ui={ui}
        aria-checked={!!s.value}
        aria-disabled={s.value === null || undefined}
        aria-describedby={`${id}-hint${s.failed ? ` ${id}-err` : ''}`}
        onClick={() => s.value !== null && s.set(!s.value)}
        className="group flex items-center gap-2 self-start rounded-md py-1 pr-1 text-left"
      >
        <CheckBox checked={!!s.value} />
        <span className="text-label text-content">{text}</span>
      </button>
    </Field>
  )
}
