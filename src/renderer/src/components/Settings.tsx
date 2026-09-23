import { useEffect, useMemo, useRef, useState } from 'react'
import type { CliInfo, ModelListResult } from '../../../shared/ipc'
import {
  PERMISSION_MODES,
  PERMISSION_MODE_LABELS,
  PERMISSION_MODE_COLORS,
  PERMISSION_MODE_DESCRIPTIONS,
  EFFORT_CHOICES,
  EFFORT_LABELS,
  THEME_CHOICES,
  THEME_LABELS,
  deriveModelInfo,
  groupModels,
  contextSizeLabel,
  contextWindowForModel,
  type CluiSettings,
  type SettingsKey,
  type SettingsSource
} from '../../../shared/settings'
import { Dropdown } from './Dropdown'
import { Button } from './Button'
import { IconClose, IconWarn, IconCheck } from './Icon'
import { applyTheme } from '../lib/theme'
import { useEscape } from '../lib/useEscape'
import { useDialogFocus } from '../lib/useDialogFocus'

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

/** Model families offered for quick sessions (the latest live model of the pick is resolved at
 *  spawn; see latestModelInFamily). Not the full live list: a quick chat picks a family, not a
 *  concrete id. */
const QUICK_FAMILIES: CluiSettings['quickModelFamily'][] = ['opus', 'sonnet', 'haiku']
const QUICK_FAMILY_LABELS: Record<CluiSettings['quickModelFamily'], string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku'
}

/** Permission modes a quick session can use: a deliberate subset of PERMISSION_MODES (no
 *  Silent Deny / Plan / Auto Edit, which don't fit a throwaway chat). */
const QUICK_PERMISSION_MODES: CluiSettings['permissionMode'][] = [
  'inherit',
  'default',
  'auto',
  'bypassPermissions'
]

/** In the quick-session context, System Default couples to the global permission mode, not a
 *  settings.json field, so its description is reworded to keep that coupling honest. */
const QUICK_PERMISSION_DESCRIPTIONS: Record<CluiSettings['permissionMode'], string> = {
  ...PERMISSION_MODE_DESCRIPTIONS,
  inherit: 'Follows your global permission mode'
}

export function Settings({ onClose }: { onClose: () => void }): JSX.Element {
  const [settings, setSettings] = useState<CluiSettings | null>(null)
  const [cliInfo, setCliInfo] = useState<CliInfo | null>(null)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [modelList, setModelList] = useState<ModelListResult>({ ids: [], live: true })
  // Per-key provenance from the main process, plus the keys staged for reset. Both drive the reset control;
  // the modal commits on Save, so a reset is staged until then, and re-picking a value un-stages it.
  const [sources, setSources] = useState<Record<SettingsKey, SettingsSource> | null>(null)
  const [cleared, setCleared] = useState<SettingsKey[]>([])
  // The theme is applied live on change for instant feedback, but only persisted on Save.
  // `persistedTheme` tracks the last-persisted value so closing without saving can revert the live preview;
  // `previewedTheme` is null until the user changes the dropdown, so the unmount revert only fires when
  // there's a real preview to undo. Avoids reverting when StrictMode's simulated mount/unmount fires cleanup
  // before the async getSettings() resolves.
  const persistedTheme = useRef<CluiSettings['theme'] | null>(null)
  const previewedTheme = useRef<CluiSettings['theme'] | null>(null)

  useEffect(() => {
    window.clui.getSettings().then(({ values, sources: src }) => {
      setSettings(values)
      setSources(src)
      persistedTheme.current = values.theme
      void checkCli(values.cliPath)
    })
    window.clui.listModels().then(setModelList)
  }, [])

  // Group + version-sort the unordered live Bedrock list into the composer picker's shape.
  // Headers only when there's more than one family; the context-size column only for known ones.
  const modelOptions = useMemo(
    () =>
      groupModels(modelList.ids.map(deriveModelInfo)).flatMap((g, gi, groups) =>
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
    [modelList.ids]
  )

  // On unmount, revert an unsaved live theme preview, but only if one was made and we know the persisted baseline.
  useEffect(() => {
    return () => {
      if (previewedTheme.current !== null && persistedTheme.current !== null) {
        applyTheme(persistedTheme.current)
      }
    }
  }, [])

  // Esc closes the modal (via the escape-stack, so an open dropdown inside closes first).
  useEscape(true, onClose)

  const checkCli = async (path: string): Promise<void> => {
    setChecking(true)
    const info = await window.clui.detectCliAt(path)
    setCliInfo(info)
    setChecking(false)
  }

  const set = <K extends keyof CluiSettings>(key: K, value: CluiSettings[K]): void => {
    setSettings((s) => (s ? { ...s, [key]: value } : s))
    // Editing a field un-stages its pending reset.
    setCleared((c) => (c.includes(key) ? c.filter((k) => k !== key) : c))
    setSaveError(null)
  }

  /** Stage a reset: the key is cleared on Save. */
  const reset = (key: SettingsKey): void => {
    setCleared((c) => (c.includes(key) ? c : [...c, key]))
    setSaveError(null)
  }

  /** True while this field holds a user override. */
  const isOverridden = (key: SettingsKey): boolean =>
    sources?.[key] === 'override' && !cleared.includes(key)

  // Save commits + dismisses (dialog contract: the primary action of a modal both applies and closes).
  // But close only on success: if the write fails we keep the modal open and surface the error.
  const save = async (): Promise<void> => {
    if (!settings || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      await window.clui.updateSettings(settings, cleared)
      // The live-applied theme is now persisted, so mark it so the unmount revert is a no-op.
      persistedTheme.current = settings.theme
      previewedTheme.current = null
      onClose()
    } catch (e) {
      setSaving(false)
      setSaveError(e instanceof Error ? e.message : 'Could not save settings.')
    }
  }

  const pickWorkspace = async (): Promise<void> => {
    const dir = await window.clui.pickWorkspace()
    if (dir) set('defaultWorkspace', dir)
  }

  if (!settings) return <Overlay>Loading…</Overlay>

  return (
    <Overlay>
      <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
        <div className="font-serif text-lg font-semibold text-content">Settings</div>
        <button
          className="rounded-md p-1 text-dim transition-colors hover:bg-bg-raised hover:text-content"
          onClick={onClose}
          title="Close"
        >
          <IconClose className="h-4 w-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
        <Field
          label="Theme"
          hint="System matches your Mac's appearance. Light and Dark override it."
          onReset={isOverridden('theme') ? () => reset('theme') : undefined}
        >
          <Dropdown<CluiSettings['theme']>
            value={settings.theme}
            ariaLabel="Theme"
            options={THEME_CHOICES.map((t) => ({ value: t, label: THEME_LABELS[t] }))}
            onChange={(t) => {
              set('theme', t)
              // Apply immediately for instant feedback; persisted only on Save. Mark that a live preview exists so close-without-save reverts it.
              previewedTheme.current = t
              applyTheme(t)
            }}
          />
        </Field>

        <Field
          label="Claude CLI path"
          hint="Leave blank to detect Claude automatically. Set a path only if it lives somewhere unusual."
          onReset={isOverridden('cliPath') ? () => reset('cliPath') : undefined}
        >
          <div className="flex gap-2">
            <input
              aria-label="Claude CLI path"
              className="flex-1 rounded border border-border bg-bg px-2 py-1.5 font-mono text-xs text-content outline-none focus:border-accent"
              placeholder="(auto-detect)"
              value={settings.cliPath}
              onChange={(e) => set('cliPath', e.target.value)}
              onBlur={() => void checkCli(settings.cliPath)}
            />
            <button
              className="rounded border border-border px-3 text-xs text-dim hover:text-content"
              onClick={() => void checkCli(settings.cliPath)}
            >
              Check
            </button>
          </div>
          {/* Version + path are machine values, rendered in mono. */}
          <div className="mt-1 text-[12px]">
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

        <Field
          label="Editor command"
          hint="Used to open changed files / diffs (e.g. code, cursor, subl)."
          onReset={isOverridden('editorCommand') ? () => reset('editorCommand') : undefined}
        >
          <input
            aria-label="Editor command"
            className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-xs text-content outline-none focus:border-accent"
            value={settings.editorCommand}
            onChange={(e) => set('editorCommand', e.target.value)}
          />
        </Field>

        <div className="text-[12px] uppercase tracking-wide text-dim">Defaults for new sessions</div>

        <Field
          label="Permission mode"
          hint="Default for new sessions (changeable per-session in the composer). Applied as a --permission-mode flag; 'System Default' passes no flag. Clui never writes your ~/.claude/settings.json."
          onReset={isOverridden('permissionMode') ? () => reset('permissionMode') : undefined}
        >
          <Dropdown<CluiSettings['permissionMode']>
            value={settings.permissionMode}
            ariaLabel="Permission mode"
            options={PERMISSION_MODES.map((m) => ({
              value: m,
              label: PERMISSION_MODE_LABELS[m],
              color: PERMISSION_MODE_COLORS[m],
              description: PERMISSION_MODE_DESCRIPTIONS[m]
            }))}
            menuClassName="w-72"
            onChange={(m) => set('permissionMode', m)}
          />
        </Field>

        <Field
          label="Model"
          hint={`Default model for new sessions (changeable per-session).${
            sources?.model === 'cli' ? ' Currently inheriting from ~/.claude/settings.json.' : ''
          }`}
          onReset={isOverridden('model') ? () => reset('model') : undefined}
          // Amber = degraded but usable: they still have a working list, just possibly incomplete.
          note={
            !modelList.live && (
              <p className="flex items-start gap-1.5 text-[12px] text-warn" role="status">
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
          hint={`Default reasoning effort for new sessions (changeable per-session).${
            sources?.effort === 'cli' ? ' Currently inheriting from ~/.claude/settings.json.' : ''
          }`}
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
            <span
              className={`flex h-4 w-4 flex-none items-center justify-center rounded-[4px] border transition-colors duration-150 ${
                settings.enableTaskTools
                  ? 'border-accent bg-accent/15 text-accent'
                  : 'border-control-edge text-transparent group-hover:border-border-strong'
              }`}
            >
              <IconCheck className="h-3 w-3" />
            </span>
            <span className="text-[13px] text-content">Enable for new sessions</span>
          </button>
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
              onClick={() => void pickWorkspace()}
            >
              Browse…
            </button>
          </div>
        </Field>

        <div className="text-[12px] uppercase tracking-wide text-dim">Quick sessions</div>

        <Field
          label="Model family"
          hint="Quick sessions run this family's latest model at high effort, with a limited tool set. Applies to all quick sessions."
          onReset={isOverridden('quickModelFamily') ? () => reset('quickModelFamily') : undefined}
        >
          <Dropdown<CluiSettings['quickModelFamily']>
            value={settings.quickModelFamily}
            ariaLabel="Quick session model family"
            options={QUICK_FAMILIES.map((f) => ({ value: f, label: QUICK_FAMILY_LABELS[f] }))}
            onChange={(f) => set('quickModelFamily', f)}
          />
        </Field>

        <Field
          label="Permission mode"
          hint="How quick sessions handle tool permissions. Applies to all quick sessions, not per-session."
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
      </div>

      <div className="flex items-center justify-end gap-3 border-t border-border px-5 py-3">
        {/* On failure only: keep the modal open + explain. Success needs no message; the modal closes. */}
        {saveError && (
          <span className="mr-auto text-xs text-err" role="alert" aria-live="assertive">
            {saveError}
          </span>
        )}
        <Button variant="outline" size="md" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" size="md" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Overlay>
  )
}

/** No scrim dismissal: the form holds unsaved edits an outside click would discard. */
function Overlay({ children }: { children: React.ReactNode }): JSX.Element {
  const dialogRef = useDialogFocus<HTMLDivElement>()
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="flex max-h-[85vh] w-[min(620px,92%)] flex-col rounded-lg border border-border bg-bg-elev shadow-2xl outline-none"
      >
        {children}
      </div>
    </div>
  )
}

function Field({
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
  /** Present only while this field holds an override. Its presence IS the "modified"
   *  marker: a neutral gutter rule fails the 3:1 non-text gate on this surface (the
   *  best neutral is 1.79:1) and the only value that passes is the scarce accent, so
   *  the control carries the state instead of a second colored channel. */
  onReset?: () => void
  /** Rendered after the hint, for a state the hint can't express (e.g. a degraded source). */
  note?: React.ReactNode
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      {/* min-h-6 keeps the row a constant height whether or not the button is there,
          so resetting a field doesn't reflow everything below it. */}
      <div className="flex min-h-6 items-center justify-between gap-3">
        <label className="text-[14px] font-semibold text-content">{label}</label>
        {onReset && (
          <button
            type="button"
            onClick={onReset}
            aria-label={`Reset ${label} to its inherited value`}
            className="-mr-1.5 flex h-6 items-center rounded px-1.5 text-[12px] font-medium text-dim transition-colors hover:text-content"
          >
            Reset
          </button>
        )}
      </div>
      {children}
      {hint && (
        <p id={hintId} className="text-[12px] text-dim">
          {hint}
        </p>
      )}
      {note}
    </div>
  )
}
