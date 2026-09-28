import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useActive, useSession, ensureModelPrefsLoaded } from './store'
import { SessionsSidebar } from './components/SessionsSidebar'
import { GateAnnouncer } from './components/Gate'
import { Customizations } from './components/Customizations'
import { Settings } from './components/Settings'
import { CommandPalette, type PaletteMode } from './components/CommandPalette'
import { GlobalSearch } from './components/GlobalSearch'
import { Stage } from './components/Stage'
import { Hero } from './components/Hero'
import { SplitNewSession } from './components/SplitNewSession'
import { Onboarding, cliHealth } from './components/Onboarding'
import { IconSettings, IconPlus, IconSidebar } from './components/Icon'
import { applyTheme } from './lib/theme'
import { useKeyboardShortcuts } from './lib/useKeyboardShortcuts'
import { useGuardedAsync } from './lib/useGuardedAsync'
import { useSidebarResize, SIDEBAR_DEFAULT } from './lib/useSidebarResize'
import { useBrowserEvents } from './lib/useBrowserEvents'
import { useOccludeWhile } from './lib/browserOcclusion'
import type { CliInfo } from '../../shared/ipc'

/** Shown on the new-session controls while the CLI can't start a session. */
const NEW_SESSION_DISABLED_HINT = 'Claude CLI unavailable. Set the path in Settings.'

export function App(): JSX.Element {
  const cwd = useActive((s) => s?.cwd ?? null)
  const startSession = useSession((s) => s.startSession)
  const chatDir = useSession((s) => s.chatDir)
  const [cliInfo, setCliInfo] = useState<CliInfo | null>(null)
  // No workable CLI, so nothing can start; the new-session controls go inert below.
  const cliUnavailable = cliHealth(cliInfo) !== 'ok'
  // First-run intro flag; `null` until loaded, so the intro doesn't flash before we know.
  const [onboarded, setOnboarded] = useState<boolean | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showCustomizations, setShowCustomizations] = useState(false)
  const settingsOpen = useSession((s) => s.settingsSection !== null)
  const openSettingsAt = useSession((s) => s.openSettings)
  const [palette, setPalette] = useState<{ mode: PaletteMode; seq: number } | null>(null)
  const globalSearchOpen = useSession((s) => s.globalSearchOpen)

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
  const anyOverlayOpen = settingsOpen || showCustomizations || !!palette || globalSearchOpen

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
    // Warm the per-session model/effort sidecar so a resumed session keeps its picks.
    void ensureModelPrefsLoaded()
    // Read the CLI effort caps once so the picker/chip are honest from the first session.
    void useSession.getState().loadEffortCaps()
    // Cache the directoryless cwd so the sidebar/status-bar/composer can recognize it.
    void useSession.getState().loadChatDir()
    // Re-assert the theme and install the 'system' OS-change listener; read onboarded in the
    // same call so the first-run intro shows only once.
    void window.clui.getSettings().then(({ values }) => {
      applyTheme(values.theme)
      setOnboarded(values.onboarded)
      setSidebarCollapsed(values.sidebarCollapsed)
      setSidebarWidth(values.sidebarWidth)
      useSession.setState({ paneFull: values.subagentPaneFull, browserPaneFull: values.browserPaneFull })
    })
  }, [])

  useEffect(() => {
    void window.clui.getFullscreen().then(setIsFullscreen)
    return window.clui.onFullscreenChanged(setIsFullscreen)
  }, [])

  // Refresh CLI info when Settings closes (path may have changed).
  useEffect(() => {
    if (!settingsOpen) window.clui.getCliInfo().then(setCliInfo)
  }, [settingsOpen])

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

  // Primary: start a directoryless session in the chat dir with no folder dialog, so the
  // user lands straight in a live composer. First-run completion is handled by the
  // cwd-keyed effect above, not here.
  const newSession = useCallback(async (): Promise<void> => {
    const dir = chatDir ?? (await window.clui.getChatDir())
    await startSession(dir)
  }, [startSession, chatDir])

  // Quick: an ephemeral session in the chat dir, spawned with --no-session-persistence so no
  // transcript hits disk (discarded on close).
  const quickSession = useCallback(async (): Promise<void> => {
    const dir = chatDir ?? (await window.clui.getChatDir())
    await startSession(dir, undefined, { ephemeral: true })
  }, [startSession, chatDir])

  const pickAndStart = useCallback(async (): Promise<void> => {
    const dir = await window.clui.pickWorkspace()
    if (dir) await startSession(dir)
  }, [startSession])

  // One guard across every spawn entry point (split button, rail, welcome, ⌘N/⌥⌘N/⌘⇧N,
  // onboarding): each handler awaits the CLI spawn before any store write, so an unguarded
  // flurry of clicks starts one session per click. `spawnPending` drives the busy affordance.
  const [spawnSession, spawnPending] = useGuardedAsync((kind: 'new' | 'quick' | 'pick') =>
    kind === 'new' ? newSession() : kind === 'quick' ? quickSession() : pickAndStart()
  )
  const startNew = useCallback(() => void spawnSession('new'), [spawnSession])
  const startQuick = useCallback(() => void spawnSession('quick'), [spawnSession])
  const startInDir = useCallback(() => void spawnSession('pick'), [spawnSession])

  // ⌘N new session · ⌘⇧N new session in a directory · ⌘W close · ⌘, settings · ⌘K palette · ⌘⇧K commands
  // (native menu) + ⌃Tab / ⌃C.
  const openSettings = useCallback(() => openSettingsAt(), [openSettingsAt])
  const openPalette = useCallback(
    (mode: PaletteMode) => setPalette((p) => ({ mode, seq: (p?.seq ?? 0) + 1 })),
    []
  )

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

  // Persist on release, not per-frame.
  const persistWidth = useCallback((w: number) => {
    setSidebarWidth(w)
    void window.clui.updateSettings({ sidebarWidth: w })
  }, [])

  const sidebarResize = useSidebarResize({
    width: sidebarWidth,
    setWidth: persistWidth,
    collapsed: sidebarCollapsed
  })

  // Modal overlays cover the window, and a sidebar drag moves the pane edge every frame; the native
  // browser view would paint over both, so it gives way to its still.
  useOccludeWhile(anyOverlayOpen || sidebarResize.dragging)
  useBrowserEvents()

  useKeyboardShortcuts({
    onNewSession: startNew,
    onNewQuickSession: startQuick,
    onNewSessionInDir: startInDir,
    onOpenSettings: openSettings,
    onOpenPalette: openPalette,
    onToggleSidebar: toggleSidebar
  })

  const emptyPane =
    onboarded !== null && (cliHealth(cliInfo) !== 'ok' || !onboarded) ? (
      <Onboarding
        cliInfo={cliInfo}
        onboarded={onboarded}
        onOpenSettings={openSettings}
        onRecheck={recheckCli}
        onPickWorkspace={startInDir}
        onDismissIntro={dismissIntro}
      />
    ) : (
      <Hero onNew={startNew} onNewInDir={startInDir} busy={spawnPending} />
    )

  return (
    <div className="relative flex h-screen overflow-hidden">
      {/* One class-swapped node: two keyed branches would remount SessionsSidebar and blank the list. */}
      <aside
        key="sidebar"
        ref={asideRef}
        id="app-sidebar"
        // No width transition while dragging, so the edge tracks the pointer 1:1.
        className={`relative flex h-screen min-h-0 shrink-0 flex-col ${sidebarResize.dragging ? '' : 'sidebar-anim'} ${
          sidebarCollapsed ? 'w-11 items-center gap-2.5 bg-bg' : 'gap-3 bg-bg-sidebar'
        }`}
        style={sidebarCollapsed ? undefined : { width: sidebarResize.appliedWidth }}
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
                className={`flex h-[30px] w-[30px] items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg ${
                  cliUnavailable
                    ? 'cursor-default border border-border text-faint'
                    : `border border-control-edge text-content hover:bg-bg-raised ${spawnPending ? 'pointer-events-none opacity-60' : ''}`
                }`}
                onClick={cliUnavailable ? undefined : startNew}
                aria-disabled={cliUnavailable || undefined}
                aria-busy={spawnPending || undefined}
                aria-label="New session"
                title={cliUnavailable ? NEW_SESSION_DISABLED_HINT : 'New session'}
              >
                <IconPlus className="h-4 w-4" />
              </button>
            </>
          ) : (
            <>
              <SplitNewSession
                onNew={startNew}
                onQuick={startQuick}
                disabled={cliUnavailable}
                pending={spawnPending}
                disabledTitle={NEW_SESSION_DISABLED_HINT}
              />
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
            data-ui="sidebar-footer"
            className={`flex h-8 w-full shrink-0 items-center justify-center ${cwd ? 'border-t border-border' : ''}`}
          >
            <button
              className="flex h-[30px] w-[30px] items-center justify-center rounded-lg text-dim transition-colors hover:bg-bg-raised hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              onClick={openSettings}
              aria-label="Settings"
              title="Settings ⌘,"
            >
              <IconSettings className="h-4 w-4" />
            </button>
          </div>
        ) : (
          // Gear is absolute so it doesn't pull the centered CLI status off-center.
          <div data-ui="sidebar-footer" className="relative flex h-8 shrink-0 items-center justify-center border-t border-border bg-bg-sidebar px-3 text-meta text-dim">
            {cliInfo?.path ? (
              <span className="truncate font-mono" title={cliInfo.path}>
                claude {cliInfo.version ?? ''}
              </span>
            ) : (
              <span className="truncate text-err">claude CLI not found</span>
            )}
            <button
              className="absolute right-1.5 flex h-7 w-7 items-center justify-center rounded-md text-dim transition-colors hover:bg-bg-raised hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-sidebar"
              onClick={openSettings}
              aria-label="Settings"
              title="Settings ⌘,"
            >
              <IconSettings className="h-4 w-4" />
            </button>
          </div>
        )}
        {/* Resize handle on the right seam, shown only when expanded (the collapsed rail is
            toggle-only, no drag). */}
        {!sidebarCollapsed && (
          <div
            {...sidebarResize.separatorProps}
            className="group absolute right-0 top-0 z-20 h-full w-2.5 translate-x-1/2 cursor-col-resize [-webkit-app-region:no-drag] focus-visible:outline-none"
          >
            {/* All-neutral: an accent ring on this h-full sliver would paint a full-window accent band,
                so focus reads as a bright content hairline and drag as the mid-gray one. */}
            <span
              className={`absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors ${
                sidebarResize.dragging
                  ? 'bg-dim'
                  : 'bg-transparent group-hover:bg-dim/50 group-focus-visible:bg-content'
              }`}
              aria-hidden="true"
            />
          </div>
        )}
      </aside>

      <main ref={mainRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Collapsed and windowed, the traffic lights and the sidebar toggle sit over the Stage's
            top-left, so the band's content starts after them. */}
        <Stage
          leftInset={sidebarCollapsed && !isFullscreen ? 76 : 16}
          bleed={sidebarCollapsed ? 44 : 0}
          bordered={!sidebarCollapsed}
          empty={emptyPane}
        />
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
        <GateAnnouncer />
        <GlobalSearch />
        {showCustomizations && <Customizations onClose={() => setShowCustomizations(false)} />}
        {settingsOpen && <Settings />}
        {palette && (
          <CommandPalette
            mode={palette.mode}
            openSeq={palette.seq}
            onClose={() => setPalette(null)}
            onNewSession={() => {
              setPalette(null)
              void newSession()
            }}
            onNewSessionInDir={() => {
              setPalette(null)
              void pickAndStart()
            }}
            onOpenSettings={() => {
              setPalette(null)
              openSettings()
            }}
            onOpenCustomizations={() => {
              setPalette(null)
              setShowCustomizations(true)
            }}
            onToggleSidebar={() => {
              setPalette(null)
              toggleSidebar()
            }}
            sidebarCollapsed={sidebarCollapsed}
          />
        )}
      </div>
    </div>
  )
}
