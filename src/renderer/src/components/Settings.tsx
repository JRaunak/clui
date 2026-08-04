import { useEffect, useRef, useState } from 'react'
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
  type CluiSettings,
  type SettingsKey,
  type SettingsSource
} from '../../../shared/settings'
import { Dropdown } from './Dropdown'
import { Button } from './Button'
import { IconClose, IconWarn } from './Icon'
import { applyTheme } from '../lib/theme'
import { useEscape } from '../lib/useEscape'
import { useDialogFocus } from '../lib/useDialogFocus'

/**
 * What to tell the user when the model list is the bundled fallback rather than a live one.
 *
 * Only Bedrock can be queried for a list. On every other provider the CLI reads its own
 * built-in catalog, so a missing `aws` is normal for those users, and naming it would send
 * them after a tool they have no reason to install.
 */
const FALLBACK_NOTES: Record<NonNullable<ModelListResult['reason']>, string> = {
  'no-cli':
    "Showing Clui's built-in model list. A live list needs the aws CLI on Clui's PATH, which only applies if you use Bedrock.",
  'expired-creds':
    'Your AWS credentials have expired, so newer models may be missing. Run aws sso login, then reopen Settings.',
  other:
    "Showing Clui's built-in list. The live Bedrock query failed, so newer models may be missing. Check the aws CLI and your credentials, then reopen Settings."
}

/**
 * Settings modal: CLI path override (+auto-detect preview), editor command,
 * default permission mode, model, and default workspace. Persisted via IPC.
 */
export function Settings({ onClose }: { onClose: () => void }): JSX.Element {
  const [settings, setSettings] = useState<CluiSettings | null>(null)
  const [cliInfo, setCliInfo] = useState<CliInfo | null>(null)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [modelList, setModelList] = useState<ModelListResult>({ ids: [], live: true })
  // Per-key provenance from the main process ('override' | 'cli' | 'default'), plus the
  // keys staged for reset. Both drive the reset control; the modal commits on Save, so a
  // reset is staged (not written) until then, and re-picking a value un-stages it.
  const [sources, setSources] = useState<Record<SettingsKey, SettingsSource> | null>(null)
  const [cleared, setCleared] = useState<SettingsKey[]>([])
  // The theme is applied LIVE on change for instant feedback, but only persisted
  // on Save. `persistedTheme` tracks the last-persisted value so closing without
  // saving can revert the live preview; `previewedTheme` is null UNTIL the user
  // actually changes the dropdown — so the unmount revert only fires when there's a
  // real preview to undo. This guards two cases where reverting would be WRONG:
  //   (1) StrictMode's simulated mount→unmount→remount (dev) fires the cleanup
  //       BEFORE the async getSettings() resolves, when persistedTheme still holds
  //       its default — reverting there flipped a light app to dark (the reported bug);
  //   (2) a fast open→close before load (prod) — same stale baseline.
  // No preview made → nothing to revert → the theme the preload set stays put.
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

  // On unmount, revert an unsaved live theme preview — but ONLY if one was made and
  // we know the persisted baseline (see refs above).
  useEffect(() => {
    return () => {
      if (previewedTheme.current !== null && persistedTheme.current !== null) {
        applyTheme(persistedTheme.current)
      }
    }
  }, [])

  // Esc closes the modal (via the escape-stack, so an open dropdown inside closes
  // first). The component only mounts while open, so it's always the active layer.
  useEscape(true, onClose)

  const checkCli = async (path: string): Promise<void> => {
    setChecking(true)
    const info = await window.clui.detectCliAt(path)
    setCliInfo(info)
    setChecking(false)
  }

  const set = <K extends keyof CluiSettings>(key: K, value: CluiSettings[K]): void => {
    setSettings((s) => (s ? { ...s, [key]: value } : s))
    // Editing a field un-stages its pending reset, else Save would clear the key the
    // user just chose a value for.
    setCleared((c) => (c.includes(key) ? c.filter((k) => k !== key) : c))
    setSaveError(null)
  }

  /** Stage a reset: the key is cleared on Save, so the field goes back to inherited. */
  const reset = (key: SettingsKey): void => {
    setCleared((c) => (c.includes(key) ? c : [...c, key]))
    setSaveError(null)
  }

  /** True while this field holds a user override that Save would keep. */
  const isOverridden = (key: SettingsKey): boolean =>
    sources?.[key] === 'override' && !cleared.includes(key)

  // Save COMMITS + DISMISSES (dialog contract: the primary action of a modal both
  // applies and closes — the dismissal IS the confirmation, so no separate "Saved"
  // toast). But close ONLY on success: if the write fails we keep the modal open and
  // surface the error, so a failure can't masquerade as a save.
  const save = async (): Promise<void> => {
    if (!settings || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      await window.clui.updateSettings(settings, cleared)
      // The live-applied theme is now persisted — mark it so the unmount revert is a
      // no-op (we're about to close; the previewed theme must STICK, not revert).
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
          hint="Light re-derives the palette for readable contrast on white; System follows your OS appearance."
          onReset={isOverridden('theme') ? () => reset('theme') : undefined}
        >
          <Dropdown<CluiSettings['theme']>
            value={settings.theme}
            options={THEME_CHOICES.map((t) => ({ value: t, label: THEME_LABELS[t] }))}
            onChange={(t) => {
              set('theme', t)
              // Apply immediately for instant feedback; persisted only on Save.
              // Mark that a live preview now exists so close-without-save reverts it.
              previewedTheme.current = t
              applyTheme(t)
            }}
          />
        </Field>

        <Field
          label="Claude CLI path"
          hint="Leave empty to auto-detect. Set explicitly to share Clui with peers whose claude is elsewhere."
          onReset={isOverridden('cliPath') ? () => reset('cliPath') : undefined}
        >
          <div className="flex gap-2">
            <input
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
          {/* Version + path are machine values → mono (matching the footer, the
              onboarding "Connected to claude …" line, and the CLI-broken screen,
              which all render the identical tokens in mono). */}
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
          // Amber = degraded but usable: they still have a working list, just possibly
          // an incomplete one. Glyph + text carry it so it isn't status-by-colour.
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
            options={modelList.ids.map((id) => ({ value: id, label: deriveModelInfo(id).label }))}
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
      </div>

      <div className="flex items-center justify-end gap-3 border-t border-border px-5 py-3">
        {/* On failure only: keep the modal open + explain (SC 4.1.3 status message,
            polite so it doesn't steal focus). Success needs no message — the modal
            closes, which IS the confirmation. */}
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
  onReset,
  note,
  children
}: {
  label: string
  hint?: string
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
      {hint && <p className="text-[12px] text-dim">{hint}</p>}
      {note}
    </div>
  )
}
