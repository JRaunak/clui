import { useEffect, useId, useMemo, useState } from 'react'
import type { CliInfo, ModelListResult } from '../../../../shared/ipc'
import { classifierModelIds, classifierRefuses, deriveModelInfo, groupModels } from '../../../../shared/settings'
import { Dropdown } from '../Dropdown'
import { IconWarn } from '../Icon'
import { FieldError } from '../LoginFields'
import { useSettings } from '../../lib/settings'
import { CheckField, Field, SAVE_FAILED, TIMING, describedBy, useInstantSetting, useInstantText } from './shared'

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
            className="flex-1 rounded border border-border bg-bg px-2 py-1.5 font-mono text-xs text-content outline-none focus:border-accent"
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
    </>
  )
}
