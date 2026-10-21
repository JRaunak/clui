import { useEffect, useMemo, useState } from 'react'
import type { ModelListResult } from '../../../../shared/ipc'
import {
  PERMISSION_MODES,
  PERMISSION_MODE_LABELS,
  PERMISSION_MODE_COLORS,
  PERMISSION_MODE_DESCRIPTIONS,
  QUICK_MODEL_FAMILIES,
  QUICK_PERMISSION_MODES,
  EFFORT_CHOICES,
  EFFORT_LABELS,
  deriveModelInfo,
  groupModels,
  classifierModelIds,
  classifierRefuses,
  contextSizeLabel,
  contextWindowForModel,
  type CluiSettings
} from '../../../../shared/settings'
import { Dropdown } from '../Dropdown'
import { PermissionIcon } from '../Composer'
import { IconWarn } from '../Icon'
import { useSession } from '../../store'
import { CheckBox, Field, type DraftProps } from './shared'

/** What to tell the user when the model list is the bundled fallback. Only Bedrock can be queried
 *  for a list; on other providers the CLI reads its own built-in catalog, so a missing `aws` is normal. */
const FALLBACK_NOTES: Record<NonNullable<ModelListResult['reason']>, string> = {
  'no-cli':
    "Showing Clui's built-in model list. A live list needs the aws CLI on Clui's PATH, which only applies if you use Bedrock.",
  'expired-creds':
    'Your AWS credentials have expired, so newer models may be missing. Run aws sso login, then reopen Settings.',
  other:
    "Showing Clui's built-in list. The live Bedrock query failed, so newer models may be missing. Check the aws CLI and your credentials, then reopen Settings."
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

type ModeChoice = CluiSettings['permissionMode']

/** What System Default resolves to, from ~/.claude/settings.json: unset means Interactive, and a mode
 *  Clui doesn't know keeps its raw name and no glyph. */
function systemDefault(raw: string | null): { mode: ModeChoice | null; label: string } {
  if (raw === null) return { mode: 'default', label: PERMISSION_MODE_LABELS.default }
  return raw in PERMISSION_MODE_LABELS ? { mode: raw as ModeChoice, label: PERMISSION_MODE_LABELS[raw as ModeChoice] } : { mode: null, label: raw }
}

function systemNote(raw: string | null): string {
  if (raw === null) return 'Currently Interactive. ~/.claude/settings.json sets no default mode.'
  const { mode, label } = systemDefault(raw)
  return mode === 'bypassPermissions'
    ? 'Currently Autonomous, from ~/.claude/settings.json. New sessions run tools without asking.'
    : `Currently ${label}, from ~/.claude/settings.json.`
}

export function SessionsSection({ settings, sources, set, reset, isOverridden }: DraftProps): JSX.Element {
  const system = useSession((s) => s.systemPermissionMode)
  const resolved = system === undefined ? null : systemDefault(system)
  // Null until listModels resolves, so a loading list can't read as a live list missing the classifier pin.
  const [modelList, setModelList] = useState<ModelListResult | null>(null)
  useEffect(() => {
    void window.clui.listModels().then(setModelList)
  }, [])

  // Group + version-sort the unordered live Bedrock list into the composer picker's shape.
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

  const pin = settings.classifierModel
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

  const pickWorkspace = async (): Promise<void> => {
    const dir = await window.clui.pickWorkspace()
    if (dir) set('defaultWorkspace', dir)
  }

  return (
    <>
      <section aria-labelledby="settings-new-sessions" className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h3 id="settings-new-sessions" className="text-caps uppercase text-dim">
            New sessions
          </h3>
          <p className="text-meta text-dim">
            Used when a session starts. Permission mode, model and effort can also be changed in the composer during a
            session.
          </p>
        </div>
        <Field
          label="Permission mode"
          hint="Applied as a --permission-mode flag. System Default passes none, so the CLI uses your settings, and a project's own settings can override it. Clui never writes ~/.claude/settings.json."
          onReset={isOverridden('permissionMode') ? () => reset('permissionMode') : undefined}
          note={
            settings.permissionMode === 'inherit' &&
            resolved && (
              <p className="flex items-center gap-1.5 text-meta text-dim">
                {resolved.mode && <PermissionIcon mode={resolved.mode} className="h-3.5 w-3.5" />}
                {systemNote(system ?? null)}
              </p>
            )
          }
        >
          <Dropdown<CluiSettings['permissionMode']>
            value={settings.permissionMode}
            ariaLabel="Permission mode"
            options={PERMISSION_MODES.map((m) => ({
              value: m,
              label: PERMISSION_MODE_LABELS[m],
              color: PERMISSION_MODE_COLORS[m],
              description:
                m === 'inherit' && resolved
                  ? system === null
                    ? 'Follows ~/.claude/settings.json, not set there, so Interactive'
                    : `Follows ~/.claude/settings.json, now ${resolved.label}`
                  : PERMISSION_MODE_DESCRIPTIONS[m],
              tone: m === 'bypassPermissions' ? ('danger' as const) : undefined
            }))}
            menuClassName="w-72"
            onChange={(m) => set('permissionMode', m)}
          />
        </Field>

        <Field
          label="Model"
          hint={sources.model === 'cli' ? INHERITING : undefined}
          onReset={isOverridden('model') ? () => reset('model') : undefined}
          // Amber = degraded but usable: they still have a working list, just possibly incomplete.
          note={
            modelList &&
            !modelList.live && (
              <p className="flex items-start gap-1.5 text-meta text-warn" role="status">
                <IconWarn className="mt-px h-3.5 w-3.5 shrink-0" />
                {FALLBACK_NOTES[modelList.reason ?? 'other']}
              </p>
            )
          }
        >
          <Dropdown<CluiSettings['model']>
            value={settings.model}
            ariaLabel="Default model for new sessions"
            options={modelOptions}
            onChange={(m) => set('model', m)}
          />
        </Field>

        <Field
          label="Effort"
          hint={sources.effort === 'cli' ? INHERITING : undefined}
          onReset={isOverridden('effort') ? () => reset('effort') : undefined}
        >
          <Dropdown<CluiSettings['effort']>
            value={settings.effort}
            ariaLabel="Default reasoning effort for new sessions"
            options={EFFORT_CHOICES.map((e) => ({ value: e, label: EFFORT_LABELS[e] }))}
            onChange={(e) => set('effort', e)}
          />
        </Field>

        <Field
          label="Task tracking tools"
          hint="Lets Claude keep a checklist of its work in the task puck. Opus 4.8 and newer only offer these tools when this is on. Off by default."
          hintId="task-tools-hint"
          onReset={isOverridden('enableTaskTools') ? () => reset('enableTaskTools') : undefined}
        >
          <button
            type="button"
            role="checkbox"
            aria-checked={settings.enableTaskTools}
            aria-label="Enable task tracking tools for new sessions"
            aria-describedby="task-tools-hint"
            onClick={() => set('enableTaskTools', !settings.enableTaskTools)}
            className="group flex items-center gap-2 rounded-md py-1 pr-1 text-left"
          >
            <CheckBox checked={settings.enableTaskTools} />
            <span className="text-label text-content">Enable for new sessions</span>
          </button>
        </Field>

        <Field
          label="Adaptive mode classifier"
          hint="Adaptive mode checks actions with a classifier that runs server-side by default, at no token charge. Run locally, its tokens are billed and don't appear in Clui's cost meter. Applies to sessions started or resumed after you save. Open sessions keep the setting they started with."
          hintId="local-classifier-hint"
          onReset={isOverridden('localClassifier') ? () => reset('localClassifier') : undefined}
        >
          <button
            type="button"
            role="checkbox"
            aria-checked={settings.localClassifier}
            aria-label="Run the Adaptive mode classifier locally for new sessions"
            aria-describedby="local-classifier-hint"
            onClick={() => set('localClassifier', !settings.localClassifier)}
            className="group flex items-center gap-2 rounded-md py-1 pr-1 text-left"
          >
            <CheckBox checked={settings.localClassifier} />
            <span className="text-label text-content">Run locally for new sessions</span>
          </button>
        </Field>

        {settings.localClassifier && (
          <Field
            label="Classifier model"
            hint="Only used while a session is in Adaptive mode."
            onReset={isOverridden('classifierModel') ? () => reset('classifierModel') : undefined}
            note={
              classifierNote ? (
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
              onChange={(m) => set('classifierModel', m)}
            />
          </Field>
        )}

        <Field
          label="Default workspace"
          hint="Offered when starting a new session."
          onReset={isOverridden('defaultWorkspace') ? () => reset('defaultWorkspace') : undefined}
        >
          <div className="flex gap-2">
            <input
              aria-label="Default workspace"
              className="flex-1 rounded border border-border bg-bg px-2 py-1.5 font-mono text-xs text-content outline-none focus:border-accent"
              placeholder="(none)"
              value={settings.defaultWorkspace}
              onChange={(e) => set('defaultWorkspace', e.target.value)}
            />
            <button
              className="rounded border border-border px-3 text-xs text-dim hover:text-content"
              onClick={() => void pickWorkspace()}
            >
              Browse…
            </button>
          </div>
        </Field>
      </section>

      <section aria-labelledby="settings-quick-sessions" className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h3 id="settings-quick-sessions" className="text-caps uppercase text-dim">
            Quick sessions
          </h3>
          <p className="text-meta text-dim">
            Throwaway chats with a limited tool set. These settings apply to every quick session.
          </p>
        </div>
        <Field
          label="Model family"
          hint="Runs the latest model in this family, at high effort."
          onReset={isOverridden('quickModelFamily') ? () => reset('quickModelFamily') : undefined}
        >
          <Dropdown<CluiSettings['quickModelFamily']>
            value={settings.quickModelFamily}
            ariaLabel="Quick session model family"
            options={QUICK_MODEL_FAMILIES.map((f) => ({ value: f, label: QUICK_FAMILY_LABELS[f] }))}
            onChange={(f) => set('quickModelFamily', f)}
          />
        </Field>

        <Field
          label="Permission mode"
          hint="How quick sessions handle tool permissions."
          onReset={isOverridden('quickPermissionMode') ? () => reset('quickPermissionMode') : undefined}
        >
          <Dropdown<CluiSettings['quickPermissionMode']>
            value={settings.quickPermissionMode}
            ariaLabel="Quick session permission mode"
            options={QUICK_PERMISSION_MODES.map((m) => ({
              value: m,
              label: PERMISSION_MODE_LABELS[m],
              color: PERMISSION_MODE_COLORS[m],
              description: QUICK_PERMISSION_DESCRIPTIONS[m],
              tone: m === 'bypassPermissions' ? ('danger' as const) : undefined
            }))}
            menuClassName="w-72"
            onChange={(m) => set('quickPermissionMode', m)}
          />
        </Field>
      </section>
    </>
  )
}
