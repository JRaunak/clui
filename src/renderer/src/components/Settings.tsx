import { useEffect, useRef, useState } from 'react'
import type { CliInfo } from '../../../shared/ipc'
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
  type CluiSettings
} from '../../../shared/settings'
import { Dropdown } from './Dropdown'
import { Button } from './Button'
import { IconClose } from './Icon'
import { applyTheme } from '../lib/theme'
import { useEscape } from '../lib/useEscape'

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
  const [modelIds, setModelIds] = useState<string[]>([])
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
    window.clui.getSettings().then((s) => {
      setSettings(s)
      persistedTheme.current = s.theme
      void checkCli(s.cliPath)
    })
    window.clui.listModels().then(setModelIds)
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
    setSaveError(null)
  }

  // Save COMMITS + DISMISSES (dialog contract: the primary action of a modal both
  // applies and closes — the dismissal IS the confirmation, so no separate "Saved"
  // toast). But close ONLY on success: if the write fails we keep the modal open and
  // surface the error, so a failure can't masquerade as a save.
  const save = async (): Promise<void> => {
    if (!settings || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      await window.clui.updateSettings(settings)
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

  if (!settings) return <Overlay onClose={onClose}>Loading…</Overlay>

  return (
    <Overlay onClose={onClose}>
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
        <Field label="Theme" hint="Light re-derives the palette for readable contrast on white; System follows your OS appearance.">
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

        <Field label="Editor command" hint="Used to open changed files / diffs (e.g. code, cursor, subl).">
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

        <Field label="Model" hint="Default model for new sessions (changeable per-session). List is fetched live from Bedrock.">
          <Dropdown<CluiSettings['model']>
            value={settings.model}
            options={modelIds.map((id) => ({ value: id, label: deriveModelInfo(id).label }))}
            onChange={(m) => set('model', m)}
          />
        </Field>

        <Field label="Effort" hint="Default reasoning effort for new sessions (changeable per-session).">
          <Dropdown<CluiSettings['effort']>
            value={settings.effort}
            options={EFFORT_CHOICES.map((e) => ({ value: e, label: EFFORT_LABELS[e] }))}
            onChange={(e) => set('effort', e)}
          />
        </Field>

        <Field label="Default workspace" hint="Offered when starting a new session.">
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

function Overlay({
  children,
  onClose
}: {
  children: React.ReactNode
  onClose: () => void
}): JSX.Element {
  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-[min(620px,92%)] flex-col rounded-lg border border-border bg-bg-elev shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[14px] font-semibold text-content">{label}</label>
      {children}
      {hint && <p className="text-[12px] text-dim">{hint}</p>}
    </div>
  )
}
