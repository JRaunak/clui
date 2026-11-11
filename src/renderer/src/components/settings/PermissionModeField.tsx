import { useId } from 'react'
import {
  DEFAULT_SETTINGS,
  PERMISSION_MODES,
  PERMISSION_MODE_LABELS,
  PERMISSION_MODE_COLORS,
  PERMISSION_MODE_DESCRIPTIONS,
  type CluiSettings
} from '../../../../shared/settings'
import { Dropdown } from '../Dropdown'
import { PermissionIcon } from '../Composer'
import { FieldError } from '../LoginFields'
import { useSession } from '../../store'
import { Field, SAVE_FAILED, SwitchField, TIMING, describedBy, useInstantSetting } from './shared'

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

export function PermissionModeField(): JSX.Element {
  const uid = useId()
  const mode = useInstantSetting('permissionMode')
  const system = useSession((s) => s.systemPermissionMode)
  const resolved = system === undefined ? null : systemDefault(system)
  const value = mode.value ?? DEFAULT_SETTINGS.permissionMode

  return (
    <>
      <Field
        label="Permission mode"
        hint="System Default follows ~/.claude/settings.json, and a project's own settings can override it. Clui never writes that file. In Adaptive and Autonomous, mods Claude writes turn on without asking; Silent Deny doesn't load them. A mod's own tool calls never prompt in any mode, though deny rules and organization policy still apply."
        hintId={`${uid}-mode-hint`}
        onReset={mode.overridden ? mode.reset : undefined}
        note={
          mode.failed ? (
            <FieldError id={`${uid}-mode-err`} text={SAVE_FAILED} />
          ) : (
            value === 'inherit' &&
            resolved && (
              <p className="flex items-center gap-1.5 text-meta text-dim">
                {resolved.mode && <PermissionIcon mode={resolved.mode} className="h-3.5 w-3.5" />}
                {systemNote(system ?? null)}
              </p>
            )
          )
        }
      >
        <Dropdown<ModeChoice>
          value={value}
          ariaLabel="Default permission mode for new sessions"
          ariaDescribedBy={describedBy(`${uid}-mode-hint`, mode.failed && `${uid}-mode-err`)}
          dataUi="permission-mode"
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
          onChange={mode.set}
        />
      </Field>

      <SwitchField
        setting="blockOutsideWrites"
        ui="write-fence"
        label="Edits outside the workspace"
        hint={`Claude's Write, Edit and NotebookEdit tools refuse paths outside the session's workspace folder, even in Autonomous mode. Shell commands aren't covered, so this stops stray edits but isn't a sandbox. Quick sessions never use it. ${TIMING}`}
        text="Block file edits outside the workspace"
      />
    </>
  )
}
