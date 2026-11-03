import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ModelListResult } from '../../../shared/ipc'
import { useSession, type SettingsSection } from '../store'
import { useSettings } from '../lib/settings'
import { Button } from './Button'
import { IconClose } from './Icon'
import { useEscape } from '../lib/useEscape'
import { useDialogFocus } from '../lib/useDialogFocus'
import { useOverlayEnter, useOverlayCovered } from '../lib/overlayOrigin'
import { Pane } from './settings/shared'
import { GeneralSection } from './settings/GeneralSection'
import { SessionsSection } from './settings/SessionsSection'
import { PermissionsSection } from './settings/PermissionsSection'
import { PaneSection } from './settings/PaneSection'
import { BrowserSection } from './settings/BrowserSection'
import { AdvancedSection } from './settings/AdvancedSection'

const SECTIONS: { key: SettingsSection; label: string }[] = [
  { key: 'general', label: 'General' },
  { key: 'sessions', label: 'Sessions' },
  { key: 'permissions', label: 'Permissions' },
  { key: 'pane', label: 'Pane' },
  { key: 'browser', label: 'Browser' },
  { key: 'advanced', label: 'Advanced' }
]

export function Settings({ covered }: { covered: boolean }): JSX.Element {
  const section = useSession((s) => s.settingsSection) ?? 'general'
  const openSettings = useSession((s) => s.openSettings)
  const closeSettings = useSession((s) => s.closeSettings)
  const loaded = useSettings((s) => !!s)

  // Null until listModels resolves, so a loading list can't read as a live list missing the classifier pin.
  const [modelList, setModelList] = useState<ModelListResult | null>(null)
  useEffect(() => {
    void window.clui.listModels().then(setModelList)
  }, [])

  // Runs after Overlay's own effect has focused the dialog, so the landing spot wins, on open and on a
  // section change from outside (a deep link, or ⌘, while open).
  useEffect(() => {
    const anchor = useSession.getState().settingsAnchor
    const group = anchor && document.getElementById(`settings-group-${anchor}`)
    if (anchor) useSession.setState({ settingsAnchor: null })
    if (!group) return void document.getElementById(`settings-tab-${section}`)?.focus()
    group.scrollIntoView({ block: 'start' })
    group.focus({ preventScroll: true })
  }, [section])

  // Through the escape stack, so an open dropdown or a field's pending edit takes Esc first.
  useEscape(true, closeSettings)

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
          {loaded ? (
            <>
              <Pane section="general" active={section === 'general'} className="flex flex-col gap-5">
                <GeneralSection />
              </Pane>
              <Pane section="sessions" active={section === 'sessions'} className="flex flex-col gap-10">
                <SessionsSection modelList={modelList} />
              </Pane>
              <Pane section="permissions" active={section === 'permissions'} className="flex flex-col gap-5">
                <PermissionsSection />
              </Pane>
              <Pane section="pane" active={section === 'pane'} className="flex flex-col gap-10">
                <PaneSection />
              </Pane>
              <Pane section="browser" active={section === 'browser'} className="flex flex-col gap-5">
                <BrowserSection />
              </Pane>
              <Pane section="advanced" active={section === 'advanced'} className="flex flex-col gap-5">
                <AdvancedSection modelList={modelList} />
              </Pane>
            </>
          ) : (
            <p className="px-5 py-4 text-meta text-dim">Loading…</p>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end border-t border-border px-5 py-3">
        <Button variant="primary" size="md" onClick={closeSettings}>
          Done
        </Button>
      </div>
    </Overlay>
  )
}

/** The height is fixed so switching between a short section and a long one never moves the dialog. */
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
