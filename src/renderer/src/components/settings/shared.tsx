import { useCallback, useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react'
import type { CluiSettings, SettingsKey, SettingsSource } from '../../../../shared/settings'
import { useSession, type SettingsSection } from '../../store'
import { useSettings } from '../../lib/settings'
import { useEscape } from '../../lib/useEscape'
import { IconCheck } from '../Icon'
import { FieldError } from '../LoginFields'

export const TIMING = 'Applies to new and resumed sessions. Running sessions keep what they started with.'
export const SAVE_FAILED = "Couldn't save this setting. Try again."
export const OUTLINE_BUTTON = 'rounded border border-border px-3 text-xs text-dim transition-colors pointer-fine:hover:text-content'

const SCROLL = 'overflow-y-auto [scrollbar-gutter:stable] py-4 pl-5 pr-3'

/** Every pane stays mounted while Settings is open, so a switch keeps its forms and scroll. */
export function Pane({
  section,
  active,
  className = '',
  children
}: {
  section: SettingsSection
  active: boolean
  className?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div
      role="tabpanel"
      id={`settings-panel-${section}`}
      aria-labelledby={`settings-tab-${section}`}
      hidden={!active}
      className={`h-full ${SCROLL} ${className}`}
    >
      {children}
    </div>
  )
}

/** A titled run of fields within a page. The heading takes focus so a deep link can land on it. */
export function Group({ id, label, children }: { id: string; label: string; children: ReactNode }): JSX.Element {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h3 id={id} tabIndex={-1} className="text-caps uppercase text-dim focus-visible:outline-none">
        {label}
      </h3>
      <div className="flex flex-col gap-5">{children}</div>
    </section>
  )
}

export const describedBy = (...ids: (string | false | undefined)[]): string | undefined => ids.filter(Boolean).join(' ') || undefined

/** A setting saved the moment it changes, read from the settings mirror. The new value shows at once and
 *  the saved one comes back if the write fails. `value` and `source` are null until the mirror loads. A write that
 *  fails after Settings closes has no field left to show it, so `closedFail` words it for the app notice. */
export function useInstantSetting<K extends SettingsKey>(
  key: K,
  closedFail?: (value: CluiSettings[K]) => string
): {
  value: CluiSettings[K] | null
  source: SettingsSource | null
  overridden: boolean
  set: (v: CluiSettings[K]) => void
  reset: () => void
  failed: boolean
  clearFailed: () => void
} {
  const saved = useSettings((s) => (s ? s.values[key] : null))
  const source = useSettings((s) => (s ? s.sources[key] : null))
  const [pending, setPending] = useState<{ value: CluiSettings[K] } | null>(null)
  const [failed, setFailed] = useState(false)
  // Only the latest write settles the display: main applies them in order, so the last one is what sticks.
  const seq = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  // A reset shows nothing of its own, since the value it falls back to is only known once the mirror updates.
  const write = (next: { value: CluiSettings[K] } | null): void => {
    if (!useSettings.getState()) return
    const n = ++seq.current
    setPending(next)
    setFailed(false)
    const patch: Partial<CluiSettings> = next ? { [key]: next.value } : {}
    void window.clui.updateSettings(patch, next ? undefined : [key]).then(
      () => n === seq.current && setPending(null),
      () => {
        if (n !== seq.current) return
        if (!mounted.current && next && closedFail) useSession.getState().setNotice(closedFail(next.value), 'error')
        setPending(null)
        setFailed(true)
      }
    )
  }
  return {
    value: pending ? pending.value : saved,
    source,
    overridden: source === 'override',
    set: (v) => write({ value: v }),
    reset: () => write(null),
    failed,
    clearFailed: () => setFailed(false)
  }
}

type TextKey = 'editorCommand' | 'cliPath' | 'defaultWorkspace' | 'defaultChatDir'
const NAME: Record<TextKey, string> = {
  editorCommand: 'the editor command',
  cliPath: 'the Claude CLI path',
  defaultWorkspace: 'the default workspace',
  defaultChatDir: 'the workbench folder'
}

/** A text setting saved on blur and on Enter, trimmed. Esc reverts an edit, and closing Settings mid-edit saves it.
 *  The field follows the saved value except while it's focused or holding a write that failed, which stays for a retry. */
export function useInstantText(key: TextKey): {
  inputProps: InputHTMLAttributes<HTMLInputElement>
  set: (v: string) => void
  reset: () => void
  failed: boolean
  overridden: boolean
  value: string
  hintId: string
  errId: string
} {
  // Closing Settings throws the typed value away, so the notice quotes it.
  const s = useInstantSetting(key, (v) => `Couldn't save ${NAME[key]} "${v}". Open Settings to try again.`)
  const saved = s.value ?? ''
  const [text, setText] = useState(saved)
  const [focused, setFocused] = useState(false)
  if (!focused && !s.failed && text !== saved) setText(saved)

  const commit = (): void => {
    const next = text.trim()
    setText(next)
    if (next !== saved) s.set(next)
  }
  const latest = useRef(commit)
  latest.current = commit
  useEffect(() => () => latest.current(), [])

  // The reverted text is the saved value, so a failed write's error no longer describes it.
  const revert = useCallback(() => {
    setText(saved)
    s.clearFailed()
  }, [saved, s])
  useEscape(focused && text !== saved, revert)

  const id = useId()
  const hintId = `${id}-hint`
  const errId = `${id}-err`
  return {
    inputProps: {
      value: text,
      onChange: (e) => setText(e.target.value),
      onFocus: () => setFocused(true),
      onBlur: () => {
        setFocused(false)
        commit()
      },
      onKeyDown: (e) => {
        if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
        e.preventDefault()
        commit()
      },
      'aria-describedby': describedBy(hintId, s.failed && errId)
    },
    set: s.set,
    reset: s.reset,
    failed: s.failed,
    overridden: s.overridden,
    value: saved,
    hintId,
    errId
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

/** The track of a switch row; the row itself is the `role="switch"` button and a `group`. */
export function SwitchTrack({ on }: { on: boolean }): JSX.Element {
  return (
    <span
      aria-hidden
      className={`flex h-4 w-7 flex-none items-center rounded-full border p-0.5 group-aria-disabled:opacity-50 ${
        on ? 'border-content bg-content' : 'border-control-edge pointer-fine:group-hover:border-dim'
      }`}
    >
      <span
        className={`size-2.5 rounded-full transition-transform duration-150 ease-[cubic-bezier(0.2,0,0,1)] ${
          on ? 'translate-x-3 bg-bg-elev' : 'bg-control-edge pointer-fine:group-hover:bg-dim'
        }`}
      />
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
  /** Absent when a group heading already names the field. */
  label?: string
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
      {label && (
        // min-h-6 keeps the row a constant height whether or not the button is there,
        // so resetting a field doesn't reflow everything below it.
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
      )}
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

/** A field holding one switch that saves the moment it's flipped. */
export function SwitchField({ setting, label, hint, text, ui }: { setting: BoolKey; label?: string; hint: string; text: string; ui?: string }): JSX.Element {
  const s = useInstantSetting(setting)
  const id = useId()
  return (
    <Field label={label} hint={hint} hintId={`${id}-hint`} note={s.failed && <FieldError id={`${id}-err`} text={SAVE_FAILED} />}>
      <button
        type="button"
        role="switch"
        data-ui={ui}
        aria-checked={!!s.value}
        aria-disabled={s.value === null || undefined}
        aria-describedby={`${id}-hint${s.failed ? ` ${id}-err` : ''}`}
        onClick={() => s.value !== null && s.set(!s.value)}
        className="group flex min-h-6 items-center gap-2 self-start rounded-md py-1 pr-1 text-left"
      >
        <SwitchTrack on={!!s.value} />
        <span className="text-label text-content group-aria-disabled:text-faint">{text}</span>
      </button>
    </Field>
  )
}
