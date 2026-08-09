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
import { GlobalSearch } from './components/GlobalSearch'
import { BackgroundTasks } from './components/BackgroundTasks'
import { SubagentView } from './components/SubagentView'
import { WorkflowTray } from './components/WorkflowTray'
import { Button } from './components/Button'
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
  // First-run intro flag. `null` = not yet loaded (don't flash the intro before we
  // know); once loaded it's true/false. Persisted in settings via `updateSettings`.
  const [onboarded, setOnboarded] = useState<boolean | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [showCustomizations, setShowCustomizations] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  const globalSearchOpen = useSession((s) => s.globalSearchOpen)
  const permissionPending = useActive((s) => (s?.pendingPermissions ?? EMPTY_PENDING).length > 0)

  // An open modal must contain focus and hide the rest of the app from assistive
  // tech, or Tab walks the ring out of the dialog into the scrimmed content behind
  // it (WCAG 2.4.3 / 2.1.2). We toggle native `inert` on the two background regions
  // rather than hand-rolling a Tab cycle: `inert` gives focus-containment + subtree
  // aria-hidden + pointer-inertness in one property. The overlays render as siblings
  // of these regions (below), so inerting both leaves only the open dialog reachable.
  const asideRef = useRef<HTMLElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  // Where focus sat in the background before a dialog opened, so we can return it on
  // close. Tracked live (any focusin outside the overlay host) rather than captured in
  // an effect, because a child's open-focus (search input) runs before App's effect and
  // would otherwise be what we captured.
  const lastBgFocusRef = useRef<HTMLElement | null>(null)
  const anyOverlayOpen =
    showSettings || showCustomizations || showPalette || globalSearchOpen || permissionPending

  useEffect(() => {
    const onFocusIn = (e: FocusEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && !t.closest('[data-overlay-host]')) lastBgFocusRef.current = t
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [])

  // Toggle inert with the overlay state. On close, clear inert FIRST (a .focus() on a
  // still-inert node is a silent no-op), then restore focus to the trigger, falling
  // back through composer → new-session button → body if the trigger is gone (e.g. a
  // deleted session row). useLayoutEffect so the DOM is inert before the browser paints.
  useLayoutEffect(() => {
    if (asideRef.current) asideRef.current.inert = anyOverlayOpen
    if (mainRef.current) mainRef.current.inert = anyOverlayOpen
    if (!anyOverlayOpen) {
      const prev = lastBgFocusRef.current
      const fallback =
        document.querySelector<HTMLElement>('[data-composer-input]') ??
        document.querySelector<HTMLElement>('[data-new-session]')
      if (prev && document.contains(prev)) prev.focus()
      else fallback?.focus()
    }
  }, [anyOverlayOpen])

  useEffect(() => {
    window.clui.getCliInfo().then(setCliInfo)
    // Warm the model list at startup so the picker is instant (main-process caches it).
    void window.clui.listModels()
    // Load persisted per-session costs so resumed sessions show accrued cost.
    void loadPersistedCosts()
    // Re-assert the theme (preload set it pre-paint) and install the OS-change
    // listener for 'system'. Reads the persisted preference from settings. Also read
    // the onboarded flag here (same call) so the first-run intro shows only once.
    void window.clui.getSettings().then(({ values }) => {
      applyTheme(values.theme)
      setOnboarded(values.onboarded)
      setSidebarCollapsed(values.sidebarCollapsed)
    })
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

  // Opening ANY session (pick / resume-from-disk / activate) completes first-run,
  // keyed on `cwd` so every entry path counts, not just "Pick a workspace". Without
  // this, resuming a disk session on first run left onboarded=false, so CLOSING it
  // bounced the user back to the intro card (reported bug). Runs once (guarded on the
  // loaded false state); persists so it never reshows.
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

  // Electron footgun guard: a file dropped ANYWHERE outside the composer would make
  // the webview navigate to the dropped file:// URL and white-screen the app. Cancel
  // the default at the window level for any drop the composer didn't already handle
  // (the composer's own handlers preventDefault first, so this only swallows stray
  // drops on the sidebar/chat/etc.). Passive:false so preventDefault takes effect.
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
    // The picker opens at the configured default workspace, if any. First-run
    // completion is handled by the cwd-keyed effect below (covers every entry path).
    const dir = await window.clui.pickWorkspace()
    if (dir) await startSession(dir)
  }, [startSession])

  // ⌘N new session · ⌘W close · ⌘, settings · ⌘K palette (native menu) + ⌃Tab / ⌃C.
  const openSettings = useCallback(() => setShowSettings(true), [])
  const openPalette = useCallback(() => setShowPalette(true), [])

  // Toggle focus mode. Persist the new state, and if focus was sitting inside the
  // sidebar, move it to the mirror control in the incoming layout so keyboard users
  // aren't dumped on <body> when the old trigger button unmounts. Focus outside the
  // sidebar is left alone. rAF waits for the swapped chrome to mount.
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev
      void window.clui.updateSettings({ sidebarCollapsed: next })
      const inSidebar = document.activeElement?.closest('#app-sidebar')
      if (inSidebar) {
        requestAnimationFrame(() => {
          const sel = next ? '[data-rail-expand]' : '[data-sidebar-collapse]'
          document.querySelector<HTMLElement>(sel)?.focus()
        })
      }
      return next
    })
  }, [])

  useKeyboardShortcuts({
    onNewSession: pickAndStart,
    onOpenSettings: openSettings,
    onOpenPalette: openPalette,
    onToggleSidebar: toggleSidebar
  })

  return (
    <div className="flex h-screen overflow-hidden">
      {/* One node, class-swapped by mode. Splitting collapsed/expanded into two keyed
          <aside> branches remounts SessionsSidebar and blanks the list until the next
          disk scan. */}
      <aside
        key="sidebar"
        ref={asideRef}
        id="app-sidebar"
        className={`flex h-screen min-h-0 shrink-0 flex-col border-r border-border bg-bg-sidebar pt-4 ${
          sidebarCollapsed ? 'w-11 items-center gap-2.5' : 'w-72 gap-3 px-3'
        }`}
      >
        {/* Keyed by mode so the incoming controls remount and fade in. The list below
            is deliberately unkeyed, so it stays mounted across a toggle. */}
        <div
          key={sidebarCollapsed ? 'rail-chrome' : 'expanded-chrome'}
          className={`sidebar-fade flex shrink-0 flex-col ${
            sidebarCollapsed ? 'items-center gap-2.5' : 'gap-3'
          }`}
        >
          {sidebarCollapsed ? (
            <>
              <button
                data-rail-expand
                className="flex h-[30px] w-[30px] items-center justify-center rounded-lg border border-border-strong text-dim transition-colors hover:border-transparent hover:bg-bg-raised hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-sidebar"
                onClick={toggleSidebar}
                aria-label="Expand sidebar"
                aria-expanded={false}
                aria-controls="app-sidebar"
                title="Expand sidebar ⌘B"
              >
                <IconSidebar className="h-4 w-4" />
              </button>
              <div className="w-6 border-b border-border" />
              <button
                data-new-session
                className="flex h-[30px] w-[30px] items-center justify-center rounded-lg bg-accent text-on-accent transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-sidebar"
                onClick={pickAndStart}
                aria-label={cwd ? 'New session' : 'Pick a workspace'}
                title={cwd ? 'New session' : 'Pick a workspace'}
              >
                <IconPlus className="h-4 w-4" />
              </button>
              <button
                className="flex h-[30px] w-[30px] items-center justify-center rounded-lg text-dim transition-colors hover:bg-bg-raised hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-sidebar"
                onClick={() => setShowSettings(true)}
                aria-label="Settings"
                title="Settings"
              >
                <IconSettings className="h-4 w-4" />
              </button>
              <div className="w-6 border-b border-border" />
            </>
          ) : (
            <>
              <div className="flex items-center justify-between px-1">
                <span className="flex items-baseline gap-2">
                  <span className="font-serif text-2xl font-semibold tracking-tight text-content">Clui</span>
                  <span className="h-1.5 w-1.5 translate-y-[-2px] rounded-full bg-accent" aria-hidden="true" />
                </span>
                <button
                  data-sidebar-collapse
                  className="flex h-7 w-7 items-center justify-center rounded text-dim transition-colors hover:bg-bg-raised hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  onClick={toggleSidebar}
                  aria-label="Collapse sidebar"
                  aria-expanded={true}
                  aria-controls="app-sidebar"
                  title="Collapse sidebar ⌘B"
                >
                  <IconSidebar className="h-4 w-4" />
                </button>
              </div>
              <Button data-new-session variant="primary" size="md" onClick={pickAndStart} className="w-full">
                <IconPlus className="h-4 w-4" />
                {cwd ? 'New session' : 'Pick a workspace'}
              </Button>
              {/* A visible Settings door: onboarding needs a new user to find it to set
                  the CLI path. ⌘, / native menu / ⌘K also open it. */}
              <Button variant="outline" size="md" onClick={() => setShowSettings(true)} className="w-full">
                <IconSettings className="h-4 w-4" />
                Settings
              </Button>
            </>
          )}
        </div>

        {/* Never key this: an unmount here drops SessionsSidebar's scanned list. */}
        <div
          className={`flex min-h-0 flex-1 flex-col ${
            sidebarCollapsed ? 'w-full items-center' : 'border-t border-border pt-3'
          }`}
        >
          <SessionsSidebar collapsed={sidebarCollapsed} />
        </div>

        {sidebarCollapsed ? (
          // Footer text ("claude X.Y") clips at rail width, so the rail keeps only a
          // bordered h-8 spacer to align its bottom divider with main's info bar.
          <div className="h-8 w-full shrink-0 border-t border-border" />
        ) : (
          <div className="flex h-8 shrink-0 items-center justify-center gap-1.5 border-t border-border bg-bg-sidebar text-[12px] text-dim">
            {cliInfo?.path ? (
              <span className="truncate font-mono" title={cliInfo.path}>
                claude {cliInfo.version ?? ''}
              </span>
            ) : (
              <span className="text-err">claude CLI not found</span>
            )}
          </div>
        )}
      </aside>

      <main ref={mainRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {/* No top bar: Settings lives in the sidebar (below New Session). macOS draws the
            native title bar, so a custom header would be empty chrome that miscues as a
            title bar and steals ~40px of transcript height. The notice banner + chat carry
            their own top borders. */}
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
        ) : // Onboarding takes over the empty pane when the CLI is unhealthy OR the
        // user hasn't completed first-run. Wait for `onboarded` to load (null) before
        // deciding, so the intro never flashes then vanishes. When healthy + onboarded,
        // Onboarding returns null → fall through to the normal Welcome pane.
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
              Pick a workspace
            </Button>
          </div>
        )}
      </main>

      {/* Overlays mount OUTSIDE <aside>/<main> (both siblings here) so those regions
          can be inerted wholesale while a dialog is open (see the inert effect above).
          Each scrim is `fixed inset-0` (viewport-anchored), so it also covers the
          sidebar, which a `<main>`-scoped `absolute inset-0` never did. `data-overlay-host`
          marks this subtree so the focus tracker ignores focus moves inside a dialog. */}
      <div data-overlay-host>
        <PermissionDialog />
        <GlobalSearch />
        {showCustomizations && <Customizations onClose={() => setShowCustomizations(false)} />}
        {showSettings && <Settings onClose={() => setShowSettings(false)} />}
        {showPalette && (
          <CommandPalette
            onClose={() => setShowPalette(false)}
            onNewSession={() => {
              setShowPalette(false)
              void pickAndStart()
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

