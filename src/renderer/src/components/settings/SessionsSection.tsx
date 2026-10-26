import { useMemo } from 'react'
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
  contextSizeLabel,
  contextWindowForModel,
  type CluiSettings
} from '../../../../shared/settings'
import { Dropdown } from '../Dropdown'
import { PermissionIcon } from '../Composer'
import { IconWarn } from '../Icon'
import { useSession } from '../../store'
import { Field, SubNav, SubPane, useSettingsSub, type DraftProps } from './shared'

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

const TABS = [
  { key: 'new', label: 'New sessions' },
  { key: 'quick', label: 'Quick sessions' }
] as const

export function SessionsSection({
  settings,
  sources,
  set,
  reset,
  isOverridden,
  modelList
}: DraftProps & { modelList: ModelListResult | null }): JSX.Element {
  const sub = useSettingsSub('sessions', 'new')
  const system = useSession((s) => s.systemPermissionMode)
  const resolved = system === undefined ? null : systemDefault(system)
  const defaultModel = deriveModelInfo(settings.model)

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

  const pick = async (key: 'defaultWorkspace' | 'defaultChatDir'): Promise<void> => {
    const dir = await window.clui.pickWorkspace()
    if (dir) set(key, dir)
  }

  return (
    <>
      <SubNav section="sessions" label="Session types" tabs={TABS} value={sub} />
      <SubPane section="sessions" sub="new" active={sub === 'new'} className="flex flex-col gap-5">
        <p className="text-meta text-dim">
          Used when a session starts. Permission mode, model and effort can also be changed in the composer during a
          session.
        </p>
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
          hint={
            defaultModel.efforts.length
              ? sources.effort === 'cli'
                ? INHERITING
                : undefined
              : `${defaultModel.label} doesn't take an effort level. This default applies when a session switches to a model that does.`
          }
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
              onClick={() => void pick('defaultWorkspace')}
            >
              Browse…
            </button>
          </div>
        </Field>

        <Field
          label="Workbench folder"
          hint="Where sessions started without a project folder run. Leave blank for ~/.clui. Open Workbench sessions stay where they are."
          onReset={isOverridden('defaultChatDir') ? () => reset('defaultChatDir') : undefined}
        >
          <div className="flex gap-2">
            <input
              aria-label="Workbench folder"
              className="flex-1 rounded border border-border bg-bg px-2 py-1.5 font-mono text-xs text-content outline-none focus:border-accent"
              placeholder="~/.clui"
              value={settings.defaultChatDir}
              onChange={(e) => set('defaultChatDir', e.target.value)}
            />
            <button
              className="rounded border border-border px-3 text-xs text-dim hover:text-content"
              onClick={() => void pick('defaultChatDir')}
            >
              Browse…
            </button>
          </div>
        </Field>
      </SubPane>

      <SubPane section="sessions" sub="quick" active={sub === 'quick'} className="flex flex-col gap-5">
        <p className="text-meta text-dim">
          Throwaway chats with a limited tool set. These settings apply to every quick session.
        </p>
        <Field
          label="Model family"
          hint="Runs the latest model in this family, at high effort when the model takes one."
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
      </SubPane>
    </>
  )
}
