import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { CluiSettings, SettingsKey, SettingsSource } from '../../../shared/settings'
import { useSession, type SettingsSection } from '../store'
import { Button } from './Button'
import { IconClose } from './Icon'
import { applyTheme } from '../lib/theme'
import { useEscape } from '../lib/useEscape'
import { useDialogFocus } from '../lib/useDialogFocus'
import { Pane } from './settings/shared'
import { GeneralSection } from './settings/GeneralSection'
import { SessionsSection } from './settings/SessionsSection'
import { BrowserSection } from './settings/BrowserSection'

const SECTIONS: { key: SettingsSection; label: string }[] = [
  { key: 'general', label: 'General' },
  { key: 'sessions', label: 'Sessions' },
  { key: 'browser', label: 'Browser' }
]

export function Settings(): JSX.Element {
  const section = useSession((s) => s.settingsSection) ?? 'general'
  const openSettings = useSession((s) => s.openSettings)
  const closeSettings = useSession((s) => s.closeSettings)
  const [settings, setSettings] = useState<CluiSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
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
    })
  }, [])

  // On unmount, revert an unsaved live theme preview, but only if one was made and we know the persisted baseline.
  useEffect(() => {
    return () => {
      if (previewedTheme.current !== null && persistedTheme.current !== null) {
        applyTheme(persistedTheme.current)
      }
    }
  }, [])

  // Runs after Overlay's own effect has focused the dialog, so the active tab wins, on open and on
  // a section change from outside (a deep link, or ⌘, while open).
  useEffect(() => {
    document.getElementById(`settings-tab-${section}`)?.focus()
  }, [section])

  // Through the escape stack, so an open dropdown inside closes first.
  useEscape(true, closeSettings)

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
  const isOverridden = (key: SettingsKey): boolean => sources?.[key] === 'override' && !cleared.includes(key)

  const previewTheme = (t: CluiSettings['theme']): void => {
    set('theme', t)
    previewedTheme.current = t
    applyTheme(t)
  }

  // Save commits + dismisses (dialog contract: the primary action of a modal both applies and closes).
  // But close only on success: if the write fails we keep the modal open and surface the error.
  const save = async (): Promise<void> => {
    if (!settings || saving) return
    setSaving(true)
    setSaveError(null)
    // The browser switch saves itself the moment it's flipped, so this draft's copy may be stale.
    const { browserEnabled: _, ...values } = settings
    try {
      await window.clui.updateSettings(values, cleared)
      // The live-applied theme is now persisted, so mark it so the unmount revert is a no-op.
      persistedTheme.current = settings.theme
      previewedTheme.current = null
      closeSettings()
    } catch (e) {
      setSaving(false)
      setSaveError(e instanceof Error ? e.message : 'Could not save settings.')
    }
  }

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const i = SECTIONS.findIndex((x) => x.key === section)
    const n = SECTIONS.length
    const next =
      e.key === 'ArrowDown'
        ? (i + 1) % n
        : e.key === 'ArrowUp'
          ? (i - 1 + n) % n
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? n - 1
              : e.key === 'Enter' || e.key === ' '
                ? i
                : -1
    if (next < 0) return
    e.preventDefault()
    if (next !== i) openSettings(SECTIONS[next].key)
  }

  const draft = settings && sources ? { settings, sources, set, reset, isOverridden } : null
  const loading = <p className="text-meta text-dim">Loading…</p>

  return (
    <Overlay>
      <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
        <div className="text-title text-content">Settings</div>
        <button
          className="rounded-md p-1 text-dim transition-colors hover:bg-bg-raised hover:text-content"
          onClick={closeSettings}
          title="Close"
        >
          <IconClose className="h-4 w-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div
          role="tablist"
          aria-orientation="vertical"
          aria-label="Settings sections"
          onKeyDown={onTabKey}
          className="flex w-40 shrink-0 flex-col gap-0.5 border-r border-border p-2"
        >
          {SECTIONS.map(({ key, label }) => {
            const active = key === section
            return (
              <button
                key={key}
                type="button"
                role="tab"
                id={`settings-tab-${key}`}
                aria-controls={`settings-panel-${key}`}
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onClick={() => openSettings(key)}
                className={`relative flex h-8 w-full items-center rounded-md px-3 text-left text-ui -outline-offset-2 transition-colors ${
                  active
                    ? 'bg-bg-raised font-semibold text-content'
                    : 'text-dim pointer-fine:hover:bg-[var(--color-row-hover)] pointer-fine:hover:text-content'
                }`}
              >
                {active && (
                  <span aria-hidden="true" className="absolute bottom-2 left-1 top-2 w-0.5 rounded-full bg-[var(--color-dim)]" />
                )}
                {label}
              </button>
            )
          })}
        </div>

        <div className="relative min-w-0 flex-1">
          <Pane section="general" active={section === 'general'} className="flex flex-col gap-5">
            {draft ? <GeneralSection {...draft} previewTheme={previewTheme} /> : loading}
          </Pane>
          <Pane section="sessions" active={section === 'sessions'} className="flex flex-col gap-10">
            {draft ? <SessionsSection {...draft} /> : loading}
          </Pane>
          <BrowserSection active={section === 'browser'} />
        </div>
      </div>

      <div className="flex items-center justify-end gap-3 border-t border-border px-5 py-3">
        {/* On failure only: keep the modal open + explain. Success needs no message; the modal closes. */}
        {saveError && (
          <span className="mr-auto text-xs text-err" role="alert" aria-live="assertive">
            {saveError}
          </span>
        )}
        <Button variant="outline" size="md" onClick={closeSettings}>
          Cancel
        </Button>
        <Button variant="primary" size="md" onClick={() => void save()} disabled={saving || !draft}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Overlay>
  )
}

/** No scrim dismissal: the form holds unsaved edits an outside click would discard. The height is
 *  fixed so switching between a short section and a long one never moves the dialog. */
function Overlay({ children }: { children: React.ReactNode }): JSX.Element {
  const dialogRef = useDialogFocus<HTMLDivElement>()
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center scrim">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        data-ui="settings"
        className="flex h-[min(640px,calc(100dvh-4rem))] w-[min(760px,calc(100vw-3rem))] flex-col rounded-lg border border-border bg-bg-elev shadow-[var(--shadow-float)] outline-none"
      >
        {children}
      </div>
    </div>
  )
}
