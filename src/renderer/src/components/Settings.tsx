import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { CluiSettings, SettingsKey } from '../../../shared/settings'
import { useSession, type SettingsSection } from '../store'
import { Button } from './Button'
import { IconClose } from './Icon'
import { applyTheme } from '../lib/theme'
import { useEscape } from '../lib/useEscape'
import { useDialogFocus } from '../lib/useDialogFocus'
import { useOverlayEnter, useOverlayCovered } from '../lib/overlayOrigin'
import { Pane } from './settings/shared'
import { GeneralSection } from './settings/GeneralSection'
import { SessionsSection } from './settings/SessionsSection'
import { BrowserSection } from './settings/BrowserSection'
import {
  draftPatch,
  draftValues,
  editDraft,
  isDirty,
  isOverridden as overridden,
  rebaseDraft,
  resetDraft,
  type Draft,
  type StagedKey
} from './settings/draft'

const SECTIONS: { key: SettingsSection; label: string }[] = [
  { key: 'general', label: 'General' },
  { key: 'sessions', label: 'Sessions' },
  { key: 'browser', label: 'Browser' }
]

export function Settings({ covered }: { covered: boolean }): JSX.Element {
  const section = useSession((s) => s.settingsSection) ?? 'general'
  const openSettings = useSession((s) => s.openSettings)
  const closeSettings = useSession((s) => s.closeSettings)
  // The theme is applied on change but persisted on Save, so closing with a staged theme reverts to the saved one.
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const latest = useRef<Draft | null>(null)
  useEffect(() => {
    latest.current = draft
  }, [draft])

  useEffect(() => {
    window.clui.getSettings().then((saved) => setDraft((d) => rebaseDraft(d, saved)))
  }, [])

  // `latest` is null until loaded, so StrictMode's simulated unmount before getSettings() resolves reverts nothing.
  useEffect(() => {
    return () => {
      const d = latest.current
      if (d?.edits.theme !== undefined) applyTheme(d.saved.values.theme)
    }
  }, [])

  // Runs after Overlay's own effect has focused the dialog, so the active tab wins, on open and on
  // a section change from outside (a deep link, or ⌘, while open).
  useEffect(() => {
    document.getElementById(`settings-tab-${section}`)?.focus()
  }, [section])

  // Through the escape stack, so an open dropdown inside closes first.
  useEscape(true, closeSettings)

  const set = <K extends StagedKey>(key: K, value: CluiSettings[K]): void => {
    setDraft((d) => d && editDraft(d, key, value))
    setSaveError(null)
  }

  const reset = (key: SettingsKey): void => {
    setDraft((d) => d && resetDraft(d, key))
    setSaveError(null)
  }

  const previewTheme = (t: CluiSettings['theme']): void => {
    set('theme', t)
    applyTheme(t)
  }

  // Save commits + dismisses (dialog contract: the primary action of a modal both applies and closes).
  // But close only on success: if the write fails we keep the modal open and surface the error.
  const save = async (): Promise<void> => {
    if (!draft || saving) return
    setSaving(true)
    setSaveError(null)
    const { patch, clear } = draftPatch(draft)
    try {
      const saved = await window.clui.updateSettings(patch, clear)
      // Nothing is staged any more, so the unmount revert leaves the saved theme alone.
      latest.current = rebaseDraft(null, saved)
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

  const props = draft && {
    settings: draftValues(draft),
    sources: draft.saved.sources,
    set,
    reset,
    isOverridden: (k: SettingsKey) => overridden(draft, k)
  }
  const dirty = !!draft && isDirty(draft)
  // Browser applies its changes right away, so it only needs Save while another section holds an edit.
  const footer = section !== 'browser' || dirty || !!saveError
  const loading = <p className="text-meta text-dim">Loading…</p>

  return (
    <Overlay covered={covered}>
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
            {props ? <GeneralSection {...props} previewTheme={previewTheme} /> : loading}
          </Pane>
          <Pane section="sessions" active={section === 'sessions'} className="flex flex-col gap-10">
            {props ? <SessionsSection {...props} /> : loading}
          </Pane>
          <BrowserSection active={section === 'browser'} />
        </div>
      </div>

      {footer && (
        <div className="flex items-center justify-end gap-3 border-t border-border px-5 py-3">
          {/* A failed save keeps the modal open and says why; success closes it. On Browser the slot says why Save is here. */}
          {saveError ? (
            <span className="mr-auto text-xs text-err" role="alert" aria-live="assertive">
              {saveError}
            </span>
          ) : (
            section === 'browser' && <span className="mr-auto text-meta text-dim">Unsaved changes in other sections.</span>
          )}
          <Button variant="outline" size="md" onClick={closeSettings}>
            Cancel
          </Button>
          <Button variant="primary" size="md" onClick={() => void save()} disabled={saving || !props}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}
    </Overlay>
  )
}

/** No scrim dismissal: the form holds unsaved edits an outside click would discard. The height is
 *  fixed so switching between a short section and a long one never moves the dialog. */
function Overlay({ covered, children }: { covered: boolean; children: React.ReactNode }): JSX.Element {
  const scrimRef = useRef<HTMLDivElement>(null)
  const dialogRef = useDialogFocus<HTMLDivElement>()
  useOverlayEnter(scrimRef, dialogRef)
  useOverlayCovered(scrimRef, covered)
  return (
    <div ref={scrimRef} className="fixed inset-0 z-40 flex items-center justify-center scrim">
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
