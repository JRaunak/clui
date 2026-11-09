import { useId, useMemo } from 'react'
import type { ModelListResult } from '../../../../shared/ipc'
import {
  DEFAULT_SETTINGS,
  PERMISSION_MODE_LABELS,
  PERMISSION_MODE_COLORS,
  PERMISSION_MODE_DESCRIPTIONS,
  QUICK_MODEL_FAMILIES,
  QUICK_PERMISSION_MODES,
  EFFORT_CHOICES,
  EFFORT_LABELS,
  deriveModelInfo,
  groupModels,
  contextSizeLabel,
  contextWindowForModel,
  sameModel,
  type CluiSettings
} from '../../../../shared/settings'
import { Dropdown } from '../Dropdown'
import { IconWarn } from '../Icon'
import { FieldError } from '../LoginFields'
import { PermissionModeField } from './PermissionModeField'
import { Field, Group, OUTLINE_BUTTON, SAVE_FAILED, describedBy, useInstantSetting, useInstantText } from './shared'

type Reason = NonNullable<ModelListResult['reason']>

/** A partial list is the CLI's catalog standing in for a failed Bedrock query, so its fix is the aws side
 *  alone. The fallback means the CLI couldn't be asked either, so its fix starts with the claude CLI. */
const PARTIAL_NOTES: Record<Reason, string> = {
  'no-cli':
    "Showing the claude CLI's model list, which leaves out some Bedrock models. For the full list, put the aws CLI on Clui's PATH, then reopen Settings.",
  'expired-creds':
    "Your AWS credentials have expired, so this is the claude CLI's shorter model list. Run aws sso login, then reopen Settings.",
  other:
    "The Bedrock model query failed, so this is the claude CLI's shorter list. Check the aws CLI and your credentials, then reopen Settings."
}

const FALLBACK_UNREACHABLE =
  "Showing Clui's built-in model list. Newer models may be missing. Check the claude CLI and, if you use Bedrock, the aws CLI and your credentials, then reopen Settings."

const FALLBACK_NOTES: Record<Reason, string> = {
  'no-cli': FALLBACK_UNREACHABLE,
  'expired-creds':
    "Your AWS credentials have expired, so this is Clui's built-in model list. Newer models may be missing. Run aws sso login, then reopen Settings.",
  other: FALLBACK_UNREACHABLE
}

const QUICK_FAMILY_LABELS: Record<CluiSettings['quickModelFamily'], string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku'
}

/** Quick's System Default passes no flag, so the CLI's settings.json decides, not the New sessions mode a
 *  user would assume it follows. */
const QUICK_PERMISSION_DESCRIPTIONS: Record<CluiSettings['permissionMode'], string> = {
  ...PERMISSION_MODE_DESCRIPTIONS,
  inherit: 'Follows your CLI settings.json, not New sessions'
}

const INHERITING = 'Currently inheriting from ~/.claude/settings.json.'
const INPUT = 'flex-1 rounded border border-control-edge bg-bg px-2 py-1.5 font-mono text-xs text-content outline-none focus:border-accent focus:shadow-[0_0_0_1px_var(--color-accent)]'

export function SessionsSection({ modelList }: { modelList: ModelListResult | null }): JSX.Element {
  const uid = useId()
  const model = useInstantSetting('model')
  const effort = useInstantSetting('effort')
  const workspace = useInstantText('defaultWorkspace')
  const chatDir = useInstantText('defaultChatDir')
  const family = useInstantSetting('quickModelFamily')
  const quickMode = useInstantSetting('quickPermissionMode')
  const modelId = model.value ?? DEFAULT_SETTINGS.model
  const defaultModel = deriveModelInfo(modelId)

  // Group + version-sort the unordered live list into the composer picker's shape.
  // Headers only when there's more than one family; the context-size column only for known ones.
  const modelOptions = useMemo(
    () =>
      groupModels((modelList?.ids ?? []).map(deriveModelInfo)).flatMap((g, gi, groups) =>
        g.models.map((info, i) => ({
          value: info.id,
          label: info.label,
          header: groups.length > 1 && i === 0 ? g.label : undefined,
          meta: info.family !== 'unknown' ? contextSizeLabel(info.id) : undefined,
          metaTitle:
            info.family !== 'unknown'
              ? `Context window: ${contextWindowForModel(info.id).toLocaleString()} tokens`
              : undefined
        }))
      ),
    [modelList?.ids]
  )
  // The bare default names the same model as its Bedrock profile id, so it shows and checks that option. An
  // unlisted model, or any while the list loads, stays an option so the trigger shows its name, never a raw id.
  const listed = modelOptions.find((o) => sameModel(o.value, modelId))
  const shownModels = listed
    ? modelOptions
    : [{ value: modelId, label: defaultModel.label, description: modelList?.live ? 'Not in the current model list' : undefined }, ...modelOptions]

  // The field's text, not its saved value: the blur commit is async, so a just-typed path hasn't saved yet.
  const shown = (x: { inputProps: { value?: unknown } }): string => String(x.inputProps.value ?? '').trim()
  const pick = async (set: (dir: string) => void, start: string | undefined): Promise<void> => {
    const dir = await window.clui.pickWorkspace(start)
    if (dir) set(dir)
  }

  const modelHint = model.source === 'cli' ? INHERITING : undefined
  const effortHint = defaultModel.efforts.length
    ? effort.source === 'cli'
      ? INHERITING
      : undefined
    : `${defaultModel.label} doesn't take an effort level. This default applies when a session switches to a model that does.`

  return (
    <>
      <Group id="settings-group-new" label="New sessions">
        <p className="text-meta text-dim">
          Used when a session starts. Model, effort and permission mode can also be changed in the composer during a session.
        </p>
        <Field
          label="Model"
          hint={modelHint}
          hintId={`${uid}-model-hint`}
          onReset={model.overridden ? model.reset : undefined}
          // Amber = degraded but usable: they still have a working list, just possibly incomplete.
          note={
            model.failed ? (
              <FieldError id={`${uid}-model-err`} text={SAVE_FAILED} />
            ) : (
              modelList &&
              (modelList.partial || !modelList.live) && (
                <p className="flex items-start gap-1.5 text-meta text-warn" role="status">
                  <IconWarn className="mt-px h-3.5 w-3.5 shrink-0" />
                  {(modelList.partial ? PARTIAL_NOTES : FALLBACK_NOTES)[modelList.reason ?? 'other']}
                </p>
              )
            )
          }
        >
          <Dropdown<CluiSettings['model']>
            value={listed?.value ?? modelId}
            ariaLabel="Default model for new sessions"
            ariaDescribedBy={describedBy(!!modelHint && `${uid}-model-hint`, model.failed && `${uid}-model-err`)}
            dataUi="model"
            options={shownModels}
            onChange={model.set}
          />
        </Field>

        <Field
          label="Effort"
          hint={effortHint}
          hintId={`${uid}-effort-hint`}
          onReset={effort.overridden ? effort.reset : undefined}
          note={effort.failed && <FieldError id={`${uid}-effort-err`} text={SAVE_FAILED} />}
        >
          <Dropdown<CluiSettings['effort']>
            value={effort.value ?? DEFAULT_SETTINGS.effort}
            ariaLabel="Default reasoning effort for new sessions"
            ariaDescribedBy={describedBy(!!effortHint && `${uid}-effort-hint`, effort.failed && `${uid}-effort-err`)}
            dataUi="effort"
            options={EFFORT_CHOICES.map((e) => ({ value: e, label: EFFORT_LABELS[e] }))}
            onChange={effort.set}
          />
        </Field>

        <PermissionModeField />

        <Field
          label="Default workspace"
          hint="Offered when starting a new session."
          hintId={workspace.hintId}
          onReset={workspace.overridden ? workspace.reset : undefined}
          note={workspace.failed && <FieldError id={workspace.errId} text={SAVE_FAILED} />}
        >
          <div className="flex gap-2">
            <input aria-label="Default workspace" data-ui="default-workspace" className={INPUT} placeholder="(none)" {...workspace.inputProps} />
            <button className={OUTLINE_BUTTON} onClick={() => void pick(workspace.set, shown(workspace) || undefined)}>
              Browse…
            </button>
          </div>
        </Field>

        <Field
          label="Workbench folder"
          hint="Where sessions started without a project folder run. Leave blank for ~/.clui. Open Workbench sessions stay where they are."
          hintId={chatDir.hintId}
          onReset={chatDir.overridden ? chatDir.reset : undefined}
          note={chatDir.failed && <FieldError id={chatDir.errId} text={SAVE_FAILED} />}
        >
          <div className="flex gap-2">
            <input aria-label="Workbench folder" data-ui="workbench-folder" className={INPUT} placeholder="~/.clui" {...chatDir.inputProps} />
            <button className={OUTLINE_BUTTON} onClick={() => void pick(chatDir.set, shown(chatDir) || `${window.clui.homeDir}/.clui`)}>
              Browse…
            </button>
          </div>
        </Field>
      </Group>

      <Group id="settings-group-quick" label="Quick sessions">
        <p className="text-meta text-dim">Throwaway chats with a limited tool set. Used when a quick session starts.</p>
        <Field
          label="Model family"
          hint="Runs the latest model in this family, at high effort when the model takes one."
          hintId={`${uid}-family-hint`}
          onReset={family.overridden ? family.reset : undefined}
          note={family.failed && <FieldError id={`${uid}-family-err`} text={SAVE_FAILED} />}
        >
          <Dropdown<CluiSettings['quickModelFamily']>
            value={family.value ?? DEFAULT_SETTINGS.quickModelFamily}
            ariaLabel="Quick session model family"
            ariaDescribedBy={describedBy(`${uid}-family-hint`, family.failed && `${uid}-family-err`)}
            dataUi="quick-model-family"
            options={QUICK_MODEL_FAMILIES.map((f) => ({ value: f, label: QUICK_FAMILY_LABELS[f] }))}
            onChange={family.set}
          />
        </Field>

        <Field
          label="Permission mode"
          hint="How quick sessions handle tool permissions."
          hintId={`${uid}-quick-mode-hint`}
          onReset={quickMode.overridden ? quickMode.reset : undefined}
          note={quickMode.failed && <FieldError id={`${uid}-quick-mode-err`} text={SAVE_FAILED} />}
        >
          <Dropdown<CluiSettings['quickPermissionMode']>
            value={quickMode.value ?? DEFAULT_SETTINGS.quickPermissionMode}
            ariaLabel="Quick session permission mode"
            ariaDescribedBy={describedBy(`${uid}-quick-mode-hint`, quickMode.failed && `${uid}-quick-mode-err`)}
            dataUi="quick-permission-mode"
            options={QUICK_PERMISSION_MODES.map((m) => ({
              value: m,
              label: PERMISSION_MODE_LABELS[m],
              color: PERMISSION_MODE_COLORS[m],
              description: QUICK_PERMISSION_DESCRIPTIONS[m],
              tone: m === 'bypassPermissions' ? ('danger' as const) : undefined
            }))}
            menuClassName="w-72"
            onChange={quickMode.set}
          />
        </Field>
      </Group>
    </>
  )
}
