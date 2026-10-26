import { useId, useMemo } from 'react'
import type { ModelListResult } from '../../../../shared/ipc'
import { classifierModelIds, classifierRefuses, deriveModelInfo, groupModels } from '../../../../shared/settings'
import { Dropdown } from '../Dropdown'
import { IconWarn } from '../Icon'
import { FieldError } from '../LoginFields'
import { useSettings } from '../../lib/settings'
import { CheckField, Field, Pane, SAVE_FAILED, TIMING, useInstantSetting } from './shared'

export function AdvancedSection({ active, modelList }: { active: boolean; modelList: ModelListResult | null }): JSX.Element {
  const uid = useId()
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
    <Pane section="advanced" active={active} className="flex flex-col gap-5">
      <CheckField
        setting="enableTaskTools"
        ui="task-tools"
        label="Task tracking tools"
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
            options={classifierOptions}
            onChange={model.set}
          />
        </Field>
      )}
    </Pane>
  )
}
