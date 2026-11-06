import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CliInfo, ModelListResult } from '../../../../shared/ipc'
import { ADDITIONAL_INSTRUCTIONS_MAX as MAX, NATIVE_AWARENESS } from '../../../../shared/native-awareness'
import { classifierModelIds, classifierRefuses, deriveModelInfo, groupModels } from '../../../../shared/settings'
import { Dropdown } from '../Dropdown'
import { IconChevron, IconWarn } from '../Icon'
import { FieldError } from '../LoginFields'
import { useSettings } from '../../lib/settings'
import { useEscape } from '../../lib/useEscape'
import { useSession } from '../../store'
import { CheckField, Field, SAVE_FAILED, TIMING, describedBy, useInstantSetting, useInstantText } from './shared'

const NEAR_AT = 3_700
const num = (v: number): string => v.toLocaleString('en-US')
const chars = (v: number): string => `${num(v)} character${v === 1 ? '' : 's'}`
const bandOf = (len: number): 'normal' | 'near' | 'over' => (len > MAX ? 'over' : len >= NEAR_AT ? 'near' : 'normal')
const overSaid = (len: number): string => `${chars(len - MAX)} over the limit. Not saved.`

/** Saved like useInstantText's fields, on blur and ⌘↩, with Esc reverting and closing Settings saving, but kept as
 *  typed and never written over the limit. An over-limit draft stays in the field, like a failed write, so the user
 *  can trim it. */
function InstructionsField(): JSX.Element {
  // The text can run to thousands of characters, so the notice doesn't quote it.
  const s = useInstantSetting('additionalInstructions', () => "Couldn't save your additional instructions. Open Settings to try again.")
  const saved = s.value ?? ''
  const [text, setText] = useState(saved)
  const [focused, setFocused] = useState(false)
  const len = text.length
  const band = bandOf(len)
  const over = band === 'over'
  if (!focused && !s.failed && !over && text !== saved) setText(saved)

  const commit = (): void => {
    if (!over && text !== saved) s.set(text)
  }
  const latest = useRef({ commit, over })
  latest.current = { commit, over }
  // ⌘Q skips unmount, so beforeunload is the only commit point for an unblurred draft.
  useEffect(() => {
    const flush = (): void => latest.current.commit()
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      if (latest.current.over) useSession.getState().setNotice(`Your additional instructions weren't saved because they're over ${num(MAX)} characters.`, 'error')
      else flush()
    }
  }, [])

  // Spoken only once typing pauses, and only near or over the limit.
  const [said, setSaid] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const wasOver = useRef(false)
  useEffect(() => () => clearTimeout(timer.current), [])
  const onChange = (v: string): void => {
    setText(v)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const b = bandOf(v.length)
      const back = wasOver.current && b !== 'over'
      wasOver.current = b === 'over'
      setSaid(back ? 'Within the limit.' : b === 'near' ? `${chars(MAX - v.length)} left` : b === 'over' ? overSaid(v.length) : '')
    }, 750)
  }
  // A blocked ⌘↩ must be heard even when the region already holds the same words.
  const sayOver = (): void => {
    clearTimeout(timer.current)
    wasOver.current = true
    const t = overSaid(len)
    if (said !== t) return setSaid(t)
    setSaid('')
    requestAnimationFrame(() => setSaid(t))
  }

  useEscape(focused && text !== saved, () => {
    clearTimeout(timer.current)
    wasOver.current = false
    setSaid('')
    setText(saved)
    s.clearFailed()
  })

  const id = useId()
  const hintId = `${id}-hint`
  const countId = `${id}-count`
  const overId = `${id}-over`
  const errId = `${id}-err`
  const tail = band === 'near' ? num(MAX - len) : num(len - MAX)
  return (
    <Field
      label="Additional instructions"
      hint="Claude follows these in every session you start from now on, quick sessions included. A session that already started, and any fork of it, keeps the instructions it started with, even after you resume it. They can't loosen Clui's rules for its browser and pane, shown below, or override permissions."
      hintId={hintId}
      note={
        <>
          {over && (
            <p id={overId} className="flex items-start gap-1.5 text-meta text-err">
              <IconWarn className="mt-px h-3.5 w-3.5 shrink-0" />
              Too long to save. Shorten it by {chars(len - MAX)} and it saves when you leave the field.
            </p>
          )}
          {s.failed && <FieldError id={errId} text={SAVE_FAILED} />}
          <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
            {said}
          </p>
          <details className="group mt-2" data-ui="native-awareness">
            <summary className="flex min-h-6 w-fit cursor-pointer list-none items-center gap-1 rounded text-label text-dim pointer-fine:hover:text-content [&::-webkit-details-marker]:hidden">
              <IconChevron className="h-3.5 w-3.5 transition-transform duration-fast ease-out group-open:rotate-90 motion-reduce:transition-none" />
              What Clui adds to Claude's prompt
            </summary>
            <div className="mt-2 flex flex-col gap-2">
              <p className="text-meta text-dim">
                Clui adds this to every new session's system prompt, ahead of your instructions. Quick sessions get your instructions without it.
              </p>
              <pre className="select-text whitespace-pre-wrap break-words rounded border border-border bg-tool p-3 font-mono text-code text-content">
                {NATIVE_AWARENESS}
              </pre>
            </div>
          </details>
        </>
      }
    >
      <textarea
        aria-label="Additional instructions"
        data-ui="additional-instructions"
        spellCheck
        autoComplete="off"
        aria-keyshortcuts="Meta+Enter"
        aria-invalid={over || undefined}
        aria-describedby={describedBy(hintId, countId, over && overId, s.failed && errId)}
        className="block max-h-96 min-h-20 w-full resize-none [field-sizing:content] rounded border border-control-edge bg-bg px-2.5 py-2 text-ui leading-normal text-content outline-none focus:border-accent focus:shadow-[0_0_0_1px_var(--color-accent)] aria-invalid:border-err aria-invalid:focus:shadow-[0_0_0_1px_var(--color-err)]"
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          commit()
        }}
        onKeyDown={(e) => {
          if (!e.metaKey || e.key !== 'Enter' || e.nativeEvent.isComposing) return
          e.preventDefault()
          if (over) sayOver()
          else commit()
        }}
      />
      <p className={`self-end text-meta tabular-nums ${over ? 'text-err' : band === 'near' ? 'text-warn' : 'text-faint'}`}>
        <span aria-hidden>
          {num(len)} / {num(MAX)}
          {band === 'normal' ? '' : ` · ${tail} ${over ? 'over' : 'left'}`}
        </span>
        <span id={countId} className="sr-only">
          {num(len)} of {num(MAX)} characters{band === 'normal' ? '' : `, ${tail} ${over ? 'over the limit' : 'left'}`}
        </span>
      </p>
    </Field>
  )
}

export function AdvancedSection({ modelList }: { modelList: ModelListResult | null }): JSX.Element {
  const uid = useId()
  const cli = useInstantText('cliPath')
  const [cliInfo, setCliInfo] = useState<CliInfo | null>(null)
  const [checking, setChecking] = useState(false)
  const [recheck, setRecheck] = useState(0)
  // Follows the saved path, so a commit, a reset or a change from elsewhere each check what new sessions will use.
  useEffect(() => {
    let live = true
    setChecking(true)
    void window.clui
      .detectCliAt(cli.value)
      .catch(() => null)
      .then((info) => {
        if (!live) return
        setCliInfo(info)
        setChecking(false)
      })
    return () => {
      live = false
    }
  }, [cli.value, recheck])
  const local = useSettings((st) => !!st?.values.localClassifier)
  const model = useInstantSetting('classifierModel')

  const pin = model.value ?? ''
  const classifierIds = useMemo(() => classifierModelIds(modelList?.ids ?? []), [modelList?.ids])
  const pinRefused = !!pin && classifierRefuses(pin)
  const pinListed = !pin || classifierIds.includes(pin)
  const classifierNote = pinRefused
    ? `Claude Code won't use ${deriveModelInfo(pin).label} for the classifier, so new sessions use the CLI default.`
    : !pinListed && modelList?.live
      ? `${deriveModelInfo(pin).label} isn't in the current model list, so new sessions use the CLI default.`
      : null
  const classifierOptions = useMemo(() => {
    const listed = groupModels(classifierIds.map(deriveModelInfo)).flatMap((g, _, groups) =>
      g.models.map((info, i) => ({
        value: info.id,
        label: info.label,
        header: groups.length > 1 && i === 0 ? g.label : undefined
      }))
    )
    // An unlisted pin stays an option so the trigger shows its name, never a raw id.
    const kept = pinListed
      ? []
      : [{ value: pin, label: deriveModelInfo(pin).label, description: pinRefused ? 'Not used by Claude Code' : 'Not in the current model list' }]
    return [{ value: '', label: 'CLI default', description: 'Claude Code picks the model' }, ...kept, ...listed]
  }, [classifierIds, pin, pinListed, pinRefused])

  return (
    <>
      <Field
        label="Claude CLI path"
        hint="Leave blank to detect Claude automatically. Set a path only if it lives somewhere unusual. Sessions already running keep the CLI they started with."
        hintId={cli.hintId}
        onReset={cli.overridden ? cli.reset : undefined}
        note={cli.failed && <FieldError id={cli.errId} text={SAVE_FAILED} />}
      >
        <div className="flex gap-2">
          <input
            aria-label="Claude CLI path"
            data-ui="cli-path"
            className="flex-1 rounded border border-control-edge bg-bg px-2 py-1.5 font-mono text-xs text-content outline-none focus:border-accent focus:shadow-[0_0_0_1px_var(--color-accent)]"
            placeholder="(auto-detect)"
            {...cli.inputProps}
          />
          <button className="rounded border border-border px-3 text-xs text-dim hover:text-content" onClick={() => setRecheck((n) => n + 1)}>
            Check
          </button>
        </div>
        <div className="mt-1 text-meta" role="status" data-ui="cli-status">
          {checking ? (
            <span className="text-dim">checking…</span>
          ) : cli.value && cliInfo?.path && cliInfo.source !== 'settings' ? (
            <p className="flex items-start gap-1.5 text-meta text-warn">
              <IconWarn className="mt-px h-3.5 w-3.5 shrink-0" />
              <span>
                <span className="font-mono">{cli.value}</span> isn't on disk, so Clui is using the auto-detected{' '}
                <span className="font-mono">{cliInfo.path}</span>.
              </span>
            </p>
          ) : cliInfo?.path ? (
            <span className="text-ok">
              ✓ <span className="font-mono">claude {cliInfo.version ?? '?'}</span> ·{' '}
              {cliInfo.source} · <span className="font-mono">{cliInfo.path}</span>
            </span>
          ) : (
            <span className="text-err">✗ claude not found</span>
          )}
        </div>
      </Field>
      <CheckField
        setting="enableTaskTools"
        ui="task-tools"
        label="Task list"
        hint={`Claude keeps a checklist of its work in the task puck. Opus 4.8 and newer offer these tools only when this is on. ${TIMING}`}
        text="Let Claude keep a task list"
      />
      <CheckField
        setting="localClassifier"
        ui="local-classifier"
        label="Adaptive mode classifier"
        hint={`Adaptive mode checks actions with a classifier that runs server-side by default, at no token charge. Run locally, its tokens are billed and don't appear in Clui's cost meter. ${TIMING}`}
        text="Run the classifier locally"
      />

      {local && (
        <Field
          label="Classifier model"
          hint="Only used while a session is in Adaptive mode."
          hintId={`${uid}-model-hint`}
          onReset={pin ? model.reset : undefined}
          note={
            model.failed ? (
              <FieldError id={`${uid}-model-err`} text={SAVE_FAILED} />
            ) : classifierNote ? (
              <p className="flex items-start gap-1.5 text-meta text-warn" role="status">
                <IconWarn className="mt-px h-3.5 w-3.5 shrink-0" />
                {classifierNote}
              </p>
            ) : (
              !modelList && <p className="text-meta text-dim">Loading models…</p>
            )
          }
        >
          <Dropdown<string>
            value={pin}
            ariaLabel="Model for the local Adaptive mode classifier"
            ariaDescribedBy={describedBy(`${uid}-model-hint`, model.failed && `${uid}-model-err`)}
            dataUi="classifier-model"
            options={classifierOptions}
            onChange={model.set}
          />
        </Field>
      )}
      <InstructionsField />
    </>
  )
}
