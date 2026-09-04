import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useActive, useSession, loadPersistedCosts, EMPTY_PENDING } from './store'
import { Chat } from './components/Chat'
import { Composer } from './components/Composer'
import { SessionsSidebar } from './components/SessionsSidebar'
import { PermissionDialog } from './components/PermissionDialog'
import { Customizations } from './components/Customizations'
import { ChangedFiles } from './components/ChangedFiles'
import { Settings } from './components/Settings'
import { CommandPalette } from './components/CommandPalette'
import { NewNamedSessionDialog } from './components/NewNamedSessionDialog'
import { GlobalSearch } from './components/GlobalSearch'
import { BackgroundTasks } from './components/BackgroundTasks'
import { SubagentView } from './components/SubagentView'
import { WorkflowTray } from './components/WorkflowTray'
import { Button } from './components/Button'
import { SplitNewSession } from './components/SplitNewSession'
import { Onboarding, cliHealth } from './components/Onboarding'
import { IconSettings, IconPlus, IconSidebar } from './components/Icon'
import { applyTheme } from './lib/theme'
import { useKeyboardShortcuts } from './lib/useKeyboardShortcuts'
import type { CliInfo } from '../../shared/ipc'

export function App(): JSX.Element {
  const cwd = useActive((s) => s?.cwd ?? null)
  const sessionId = useActive((s) => s?.sessionId ?? null)
  const costUsd = useActive((s) => s?.costUsd ?? null)
  const startSession = useSession((s) => s.startSession)
  const notice = useSession((s) => s.notice)
  const viewingSubagent = useSession((s) => s.viewingSubagent)
  const dismissNotice = useSession((s) => s.dismissNotice)
  const [cliInfo, setCliInfo] = useState<CliInfo | null>(null)
  // First-run intro flag; `null` until loaded, so the intro doesn't flash before we know.
  const [onboarded, setOnboarded] = useState<boolean | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showCustomizations, setShowCustomizations] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  const [showNamedSession, setShowNamedSession] = useState(false)
  const globalSearchOpen = useSession((s) => s.globalSearchOpen)
  const permissionPending = useActive((s) => (s?.pendingPermissions ?? EMPTY_PENDING).length > 0)

  // Native `inert` on the background regions contains focus and hides them from AT while a
  // dialog is open (WCAG 2.4.3 / 2.1.2), in one property instead of a hand-rolled Tab cycle.
  const asideRef = useRef<HTMLElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  // Toggle lives outside <aside>, so it needs inerting alongside aside/main under a modal.
  const titleToggleRef = useRef<HTMLButtonElement>(null)
  // Background focus before a dialog opened, to restore on close. Tracked live via focusin,
  // not an effect: a child's open-focus runs before App's effect and would be captured instead.
  const lastBgFocusRef = useRef<HTMLElement | null>(null)
  // Holds the previous overlay state so the restore below skips the initial mount.
  const wasOverlayOpenRef = useRef(false)
  const anyOverlayOpen =
    showSettings ||
    showCustomizations ||
    showPalette ||
    showNamedSession ||
    globalSearchOpen ||
    permissionPending

  useEffect(() => {
    const onFocusIn = (e: FocusEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && !t.closest('[data-overlay-host]')) lastBgFocusRef.current = t
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [])

  // On close, clear inert FIRST (.focus() on an inert node is a no-op), then restore focus to
  // the trigger, falling back to composer/new-session if it's gone. Layout effect: inert before paint.
  useLayoutEffect(() => {
    if (asideRef.current) asideRef.current.inert = anyOverlayOpen
    if (mainRef.current) mainRef.current.inert = anyOverlayOpen
    if (titleToggleRef.current) titleToggleRef.current.inert = anyOverlayOpen
    // Only on a real close, not mount: a launch-time .focus() paints the focus-visible ring unprompted.
    if (!anyOverlayOpen && wasOverlayOpenRef.current) {
      const prev = lastBgFocusRef.current
      const fallback =
        document.querySelector<HTMLElement>('[data-composer-input]') ??
        document.querySelector<HTMLElement>('[data-new-session]')
      if (prev && document.contains(prev)) prev.focus()
      else fallback?.focus()
    }
    wasOverlayOpenRef.current = anyOverlayOpen
  }, [anyOverlayOpen])

  useEffect(() => {
    window.clui.getCliInfo().then(setCliInfo)
    // Warm the model list at startup so the picker is instant (main-process caches it).
    void window.clui.listModels()
    // Load persisted per-session costs so resumed sessions show accrued cost.
    void loadPersistedCosts()
    // Re-assert the theme and install the 'system' OS-change listener; read onboarded in the
    // same call so the first-run intro shows only once.
    void window.clui.getSettings().then(({ values }) => {
      applyTheme(values.theme)
      setOnboarded(values.onboarded)
      setSidebarCollapsed(values.sidebarCollapsed)
    })
  }, [])

  useEffect(() => {
    void window.clui.getFullscreen().then(setIsFullscreen)
    return window.clui.onFullscreenChanged(setIsFullscreen)
  }, [])

  // Refresh CLI info when Settings closes (path may have changed).
  useEffect(() => {
    if (!showSettings) window.clui.getCliInfo().then(setCliInfo)
  }, [showSettings])

  // Persist + clear the first-run intro. Called on Skip (explicit dismiss).
  const dismissIntro = useCallback(() => {
    setOnboarded(true)
    void window.clui.updateSettings({ onboarded: true })
  }, [])

  // Opening ANY session completes first-run, keyed on `cwd` so every entry path counts:
  // otherwise resuming a disk session left onboarded=false and closing it bounced back to the intro.
  useEffect(() => {
    if (cwd && onboarded === false) {
      setOnboarded(true)
      void window.clui.updateSettings({ onboarded: true })
    }
  }, [cwd, onboarded])

  const recheckCli = useCallback(() => {
    setCliInfo(null) // brief "checking" gap; getCliInfo re-detects live
    void window.clui.getCliInfo().then(setCliInfo)
  }, [])

  // A file dropped outside the composer would navigate the webview to its file:// URL and
  // white-screen the app; cancel any drop the composer didn't handle. passive:false to preventDefault.
  useEffect(() => {
    const cancel = (e: DragEvent): void => {
      if (e.defaultPrevented) return // composer already handled + previewed it
      e.preventDefault()
    }
    window.addEventListener('dragover', cancel, false)
    window.addEventListener('drop', cancel, false)
    return () => {
      window.removeEventListener('dragover', cancel, false)
      window.removeEventListener('drop', cancel, false)
    }
  }, [])

  const pickAndStart = useCallback(async (): Promise<void> => {
    // First-run completion is handled by the cwd-keyed effect above, not here.
    const dir = await window.clui.pickWorkspace()
    if (dir) await startSession(dir)
  }, [startSession])

  // Close FIRST so the OS folder picker isn't stacked behind a still-open Clui dialog.
  const startNamedSession = useCallback(
    async (name: string): Promise<void> => {
      setShowNamedSession(false)
      const dir = await window.clui.pickWorkspace()
      if (dir) await startSession(dir, undefined, { name })
    },
    [startSession]
  )

  // ⌘N new session · ⌘⇧N named session · ⌘W close · ⌘, settings · ⌘K palette (native
  // menu) + ⌃Tab / ⌃C.
  const openSettings = useCallback(() => setShowSettings(true), [])
  const openPalette = useCallback(() => setShowPalette(true), [])
  const openNamedSession = useCallback(() => setShowNamedSession(true), [])

  // Sidebar chrome remounts on toggle; if focus sat inside it, move it to the persistent
  // title-bar toggle rather than let it fall to <body>.
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev
      void window.clui.updateSettings({ sidebarCollapsed: next })
      if (asideRef.current?.contains(document.activeElement)) titleToggleRef.current?.focus()
      return next
    })
  }, [])

  useKeyboardShortcuts({
    onNewSession: pickAndStart,
    onNewNamedSession: openNamedSession,
    onOpenSettings: openSettings,
    onOpenPalette: openPalette,
    onToggleSidebar: toggleSidebar
  })

  return (
    <div className="relative flex h-screen overflow-hidden">
      {/* One class-swapped node: two keyed branches would remount SessionsSidebar and blank the list. */}
      <aside
        key="sidebar"
        ref={asideRef}
        id="app-sidebar"
        className={`sidebar-anim flex h-screen min-h-0 shrink-0 flex-col ${
          sidebarCollapsed ? 'w-11 items-center gap-2.5 bg-bg' : 'w-72 gap-3 bg-bg-sidebar'
        }`}
      >
        {/* Top band under the OS title bar. Drag region starts past the toggle, so the toggle
            stays clickable (drag regions swallow clicks). */}
        <div className={`flex h-11 shrink-0 items-center ${isFullscreen ? 'justify-center' : ''}`}>
          {!sidebarCollapsed && (
            <div className={`flex h-full items-center [-webkit-app-region:drag] ${isFullscreen ? '' : 'ml-[124px] flex-1'}`}>
              <span className="flex items-baseline gap-2">
                <span className="font-serif text-2xl font-semibold tracking-tight text-content">
                  Clui
                </span>
                <span className="h-1.5 w-1.5 translate-y-[-2px] rounded-full bg-accent" aria-hidden="true" />
              </span>
            </div>
          )}
        </div>
        {/* Keyed by mode so incoming controls remount and fade in; the list below stays unkeyed. */}
        <div
          key={sidebarCollapsed ? 'rail-chrome' : 'expanded-chrome'}
          className={`sidebar-fade flex shrink-0 flex-col ${
            sidebarCollapsed ? 'items-center gap-2.5' : 'gap-3 px-3'
          }`}
        >
          {sidebarCollapsed ? (
            <>
              <button
                data-new-session
                className="flex h-[30px] w-[30px] items-center justify-center rounded-lg bg-accent text-on-accent transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-sidebar"
                onClick={pickAndStart}
                aria-label="New session"
                title="New session"
              >
                <IconPlus className="h-4 w-4" />
              </button>
            </>
          ) : (
            <>
              <SplitNewSession onNew={pickAndStart} onNewNamed={openNamedSession} />
            </>
          )}
        </div>

        {/* Never key this: an unmount drops SessionsSidebar's scanned list. */}
        <div
          className={`flex min-h-0 flex-1 flex-col ${
            sidebarCollapsed ? 'w-full items-center' : 'border-t border-border pl-3 pt-3'
          }`}
        >
          <SessionsSidebar collapsed={sidebarCollapsed} />
        </div>

        {sidebarCollapsed ? (
          // Always h-8 so list height stays steady; border-t only with a session, to line up
          // with main's info bar.
          <div
            className={`flex h-8 w-full shrink-0 items-center justify-center ${cwd ? 'border-t border-border' : ''}`}
          >
            <button
              className="flex h-[30px] w-[30px] items-center justify-center rounded-lg text-dim transition-colors hover:bg-bg-raised hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              onClick={() => setShowSettings(true)}
              aria-label="Settings"
              title="Settings ⌘,"
            >
              <IconSettings className="h-4 w-4" />
            </button>
          </div>
        ) : (
          // Gear is absolute so it doesn't pull the centered CLI status off-center.
          <div className="relative flex h-8 shrink-0 items-center justify-center border-t border-border bg-bg-sidebar px-3 text-[12px] text-dim">
            {cliInfo?.path ? (
              <span className="truncate font-mono" title={cliInfo.path}>
                claude {cliInfo.version ?? ''}
              </span>
            ) : (
              <span className="truncate text-err">claude CLI not found</span>
            )}
            <button
              className="absolute right-1.5 flex h-7 w-7 items-center justify-center rounded-md text-dim transition-colors hover:bg-bg-raised hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-sidebar"
              onClick={() => setShowSettings(true)}
              aria-label="Settings"
              title="Settings ⌘,"
            >
              <IconSettings className="h-4 w-4" />
            </button>
          </div>
        )}
      </aside>

      <main ref={mainRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {/* No in-app top bar: the sidebar's drag band spans the window top; Settings lives in the sidebar. */}
        {/* Collapsed-only spacer pushing the border-l divider below the title band. Drag starts
            past the toggle so its pixels stay clickable. */}
        {sidebarCollapsed && (
          <div className="ml-20 h-11 shrink-0 [-webkit-app-region:drag]" aria-hidden="true" />
        )}
        {/* No divider when collapsed: the rail is bg-bg like main, so border-l would draw
            through one uniform surface. */}
        <div
          className={`flex min-h-0 flex-1 flex-col ${sidebarCollapsed ? '' : 'border-l border-border'}`}
        >
        {notice && (
          <div className="flex items-center gap-2 border-b border-warn/40 bg-warn/10 px-4 py-1.5 text-[12px] text-warn">
            <span className="flex-1">{notice}</span>
            <button className="text-warn hover:text-content" onClick={dismissNotice} title="Dismiss">
              ✕
            </button>
          </div>
        )}

        {cwd && viewingSubagent ? (
          // Maximized transcript view takes over the main region (sidebar persists).
          <SubagentView />
        ) : cwd ? (
          <>
            <Chat />
            <ChangedFiles />
            <Composer />
            {/* Bottom-left workspace/session info. Same h-8 as the sidebar footer
                so their divider lines align across the two columns. */}
            <div className="flex h-8 items-center gap-3 border-t border-border px-4 text-[12px] text-dim">
              <span title={cwd ?? ''}>
                Workspace: <span className="text-dim">{cwd ? basename(cwd) : '—'}</span>
              </span>
              <span className="text-faint">·</span>
              <span title={sessionId ?? ''}>
                Session:{' '}
                <span className="font-mono text-dim">{sessionId ? sessionId.slice(0, 8) : '—'}</span>
              </span>
              {costUsd !== null && (
                <>
                  <span className="text-faint">·</span>
                  <span title="Cumulative session cost (from the CLI result event)">
                    Cost: <span className="font-mono text-dim">{formatCost(costUsd)}</span>
                  </span>
                </>
              )}
              <BackgroundTasksSlot />
              <WorkflowTray />
            </div>
          </>
        ) : // Onboarding takes the empty pane when the CLI is unhealthy or first-run isn't done.
        // Wait for `onboarded` to load (null) so the intro never flashes; healthy+onboarded returns null.
        onboarded !== null && (cliHealth(cliInfo) !== 'ok' || !onboarded) ? (
          <Onboarding
            cliInfo={cliInfo}
            onboarded={onboarded}
            onOpenSettings={openSettings}
            onRecheck={recheckCli}
            onPickWorkspace={pickAndStart}
            onDismissIntro={dismissIntro}
          />
        ) : (
          <div className="m-auto flex max-w-md flex-col items-center px-6 text-center">
            <div className="mb-6 flex items-baseline gap-2.5">
              <span className="font-serif text-5xl font-semibold tracking-tight text-content">Clui</span>
              <span className="h-2.5 w-2.5 translate-y-[-6px] rounded-full bg-accent" aria-hidden="true" />
            </div>
            <p className="font-serif text-xl italic leading-snug text-dim">
              Drive Claude Code, visually.
            </p>
            <p className="mt-3 text-sm leading-relaxed text-faint">
              A local window onto the <span className="font-mono text-dim">claude</span> CLI — your
              sessions, permissions, and tools, running side by side.
            </p>
            <Button variant="primary" size="lg" className="mt-7" onClick={pickAndStart}>
              <IconPlus className="h-4 w-4" />
              New session
            </Button>
            {/* Ghost, not a second accent: the hero's boldness is spent on the primary. */}
            <Button variant="ghost" size="md" className="mt-2" onClick={openNamedSession}>
              New named session…
            </Button>
          </div>
        )}
        </div>
      </main>

      {/* Sits on drag-free pixels: a no-drag button nested in a drag band doesn't reliably carve back out. */}
      <button
        ref={titleToggleRef}
        data-sidebar-collapse
        className={`absolute ${isFullscreen ? 'left-2' : 'left-[84px]'} top-2 z-20 flex h-7 w-7 items-center justify-center rounded text-dim transition-colors hover:bg-bg-raised hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [-webkit-app-region:no-drag]`}
        onClick={toggleSidebar}
        aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-expanded={!sidebarCollapsed}
        aria-controls="app-sidebar"
        title={`${sidebarCollapsed ? 'Expand' : 'Collapse'} sidebar ⌘B`}
      >
        <IconSidebar className="h-4 w-4" />
      </button>

      {/* Overlays mount outside <aside>/<main> so those regions can be inerted wholesale (see the
          inert effect above). `data-overlay-host` marks this subtree so the focus tracker ignores it. */}
      <div data-overlay-host>
        <PermissionDialog />
        <GlobalSearch />
        {showNamedSession && (
          <NewNamedSessionDialog
            onClose={() => setShowNamedSession(false)}
            onConfirm={(name) => void startNamedSession(name)}
          />
        )}
        {showCustomizations && <Customizations onClose={() => setShowCustomizations(false)} />}
        {showSettings && <Settings onClose={() => setShowSettings(false)} />}
        {showPalette && (
          <CommandPalette
            onClose={() => setShowPalette(false)}
            onNewSession={() => {
              setShowPalette(false)
              void pickAndStart()
            }}
            onNewNamedSession={() => {
              setShowPalette(false)
              openNamedSession()
            }}
            onOpenSettings={() => {
              setShowPalette(false)
              setShowSettings(true)
            }}
            onOpenCustomizations={() => {
              setShowPalette(false)
              setShowCustomizations(true)
            }}
            onToggleSidebar={() => {
              setShowPalette(false)
              toggleSidebar()
            }}
            sidebarCollapsed={sidebarCollapsed}
          />
        )}
      </div>
    </div>
  )
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

/** Renders the background-tasks chip WITH its leading separator, only when the
 *  active session has any background task (so the info bar has no dangling `·`). */
function BackgroundTasksSlot(): JSX.Element | null {
  const hasTasks = useActive((s) => Object.keys(s?.backgroundTasks ?? {}).length > 0)
  if (!hasTasks) return null
  return (
    <>
      <span className="text-faint">·</span>
      <BackgroundTasks />
    </>
  )
}

/** e.g. $0.0032, $0.14, $2.10 */
function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

