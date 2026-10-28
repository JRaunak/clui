/**
 * Global keyboard shortcuts.
 *
 * Two sources feed this:
 *  1. The native application menu (main process) owns ⌘N / ⌘W / ⌘,; those must
 *     be defined in the menu so macOS routes them correctly (a renderer ⌘W would
 *     still trigger Electron's default "Close Window"). They arrive here as
 *     `menuAction` pushes and dispatch to the matching store action / modal.
 *  2. App-internal keys that aren't menu commands are handled as DOM listeners:
 *       ⌃Tab / ⌃⇧Tab  — cycle to the next / previous live session
 *       ⌃C            — interrupt the active turn WHILE it is streaming
 *       ⌘B            — collapse / expand the session sidebar (no menu collision)
 *       F6 / ⇧F6      — move focus between the sidebar, the transcript and the detail pane
 *
 * Every binding but F6 uses a modifier, so they stay active even while the
 * composer textarea is focused (the macOS convention: ⌘/⌃ shortcuts are global).
 * F6 types nothing either. No binding is a printable key, which is the actual
 * safety guarantee against hijacking typing.
 */
import { useEffect } from 'react'
import { activeSlice, anyTabIn, browserTabOf, surfaceKindOf, useSession } from '../store'
import { closeTab } from '../components/surfaces/SurfaceTabs'
import { point } from '../components/surfaces/PointButton'
import { OPEN_FILE_EVENT, type PaletteMode } from '../components/CommandPalette'
import { FILE_GOTO_EVENT } from '../components/surfaces/FileSurface'
import { FILE_FIND_EVENT } from '../components/surfaces/fileDoc'
import { TRANSCRIPT_FIND_EVENT } from '../components/FindBar'
import { fileLike, hasFind } from './presentation'

/** Focus is in the Surfaces pane: its DOM, or a native page in it, which only main can report. */
function inPane(page: boolean): boolean {
  const st = useSession.getState()
  return !!activeSlice(st)?.paneOpen && !st.viewingSubagent && (page || !!document.activeElement?.closest('[data-ui="pane-secondary"]'))
}

/**
 * Find, Find Next and Find Previous go to one target. A file tab with a find, Source or a Markdown Preview, owns
 * them while focus is in the pane showing it, and an HTML Preview there takes none. Anywhere else, a native page included, they search the
 * conversation, matching the menu's labels. Only one find is open at a time, so ⌘G never steps two.
 */
function routeFind(what: 'open' | 'next' | 'prev', page: boolean): void {
  const store = useSession.getState()
  const slice = activeSlice(store)
  const tab = slice?.surfaces.active ? slice.surfaces.tabs[slice.surfaces.active] : undefined
  if (inPane(page) && fileLike(tab?.kind)) {
    if (!hasFind(store.activeHandleId, tab)) return
    if (store.findOpen) store.setFindOpen(false)
    window.dispatchEvent(new CustomEvent(FILE_FIND_EVENT, { detail: what }))
    return
  }
  window.dispatchEvent(new CustomEvent(FILE_FIND_EVENT, { detail: 'close' }))
  if (!store.activeHandleId) return
  // Find Next with the bar closed reopens it rather than stepping a query nobody can see.
  if (what === 'open' || !store.findOpen) store.setFindOpen(true)
  else window.dispatchEvent(new CustomEvent(TRANSCRIPT_FIND_EVENT, { detail: what }))
}

const REGIONS = '#app-sidebar, [data-ui="pane-primary"], [data-ui="pane-secondary"]'

/** F6 / ⇧F6: focus the next region's main control from `here`. False when there's no other region to go to. */
function cycleRegion(back: boolean, here: Element | null = document.activeElement?.closest(REGIONS) ?? null): boolean {
  const targets = [
    document.querySelector<HTMLElement>('#app-sidebar [data-new-session]'),
    document.querySelector<HTMLElement>('[data-ui="pane-primary"] [data-composer-input]'),
    document.querySelector<HTMLElement>('[data-ui="pane-secondary"] [data-pane-title]')
  ].filter((el): el is HTMLElement => !!el && !el.closest('[inert]'))
  if (targets.length < 2) return false
  const at = targets.findIndex((el) => el.closest(REGIONS) === here)
  const next = at < 0 ? (back ? targets.length - 1 : 0) : (at + (back ? -1 : 1) + targets.length) % targets.length
  targets[next].focus()
  return true
}

/**
 * @param onNewSession start a directoryless session in the chat dir (⌘N)
 * @param onNewQuickSession start an ephemeral, not-saved session (⌥⌘N)
 * @param onNewSessionInDir pick a workspace folder, then start there (⌘⇧N)
 * @param onOpenSettings open the Settings modal (⌘,)
 */
const MODIFIERS = new Set(['Meta', 'Shift', 'Alt', 'Control'])
/** Set when ⌘W closed the pane's last tab, until the user's next key or click. */
let wClosedPane = false

export function useKeyboardShortcuts(opts: {
  onNewSession: () => void
  onNewQuickSession: () => void
  onNewSessionInDir: () => void
  onOpenSettings: () => void
  onOpenPalette: (mode: PaletteMode) => void
  onToggleSidebar: () => void
}): void {
  const {
    onNewSession,
    onNewQuickSession,
    onNewSessionInDir,
    onOpenSettings,
    onOpenPalette,
    onToggleSidebar
  } = opts

  useEffect(() => {
    const openFile = (): void => {
      if (activeSlice(useSession.getState())?.cwd) onOpenPalette('file')
    }
    window.addEventListener(OPEN_FILE_EVENT, openFile)
    // A hidden page can't keep focus, so a menu key pressed in it hands focus to the composer.
    const leavePage = (page: boolean): void => {
      const after = activeSlice(useSession.getState())
      if (page && (!after?.paneOpen || browserTabOf(after.surfaces.active) === null))
        document.querySelector<HTMLElement>('[data-composer-input]')?.focus()
    }
    // 1. Native-menu actions (⌘N / ⌘W / ⌘,).
    const off = window.clui.onMenuAction((action, page) => {
      const store = useSession.getState()
      switch (action) {
        case 'new-session':
          onNewSession()
          break
        // ⌥⌘N arrives as a menu accelerator (owned by main), so it needs no DOM listener here;
        // a second binding would double-fire against the accelerator.
        case 'new-quick-session':
          onNewQuickSession()
          break
        // The native menu's 'new-named-session' channel fires on ⌘⇧N; it starts a session in a
        // picked directory (the channel keeps its old name).
        case 'new-named-session':
          onNewSessionInDir()
          break
        case 'close-session':
        case 'close-session-menu': {
          // In the pane ⌘W closes tabs, and the last one hides the pane. Mashing it must never end the
          // conversation, so after that only a fresh action lets ⌘W close the session.
          const active = activeSlice(store)?.surfaces.active
          if (inPane(page)) {
            if (active) closeTab(active, true)
            wClosedPane = !activeSlice(useSession.getState())?.paneOpen
          } else if ((action === 'close-session-menu' || !wClosedPane) && store.activeHandleId) void store.closeSession(store.activeHandleId)
          break
        }
        case 'open-settings':
          onOpenSettings()
          break
        case 'open-palette':
          onOpenPalette('switch')
          break
        case 'open-command-palette':
          onOpenPalette('command')
          break
        case 'open-file':
          openFile()
          break
        // Find/search route straight to store flags (no App callback needed).
        // ⌘F only means something with a session open; ⌘⇧F is always available.
        case 'find-in-conversation':
          routeFind('open', page)
          break
        case 'find-next':
        case 'find-prev':
          routeFind(action === 'find-next' ? 'next' : 'prev', page)
          break
        case 'search-global':
          store.setGlobalSearchOpen(true)
          break
        // Clicking the pane's own button reuses its focus rule, and it only exists when the Stage is
        // wide enough to split, so a narrow window or a closed pane makes this a no-op.
        case 'toggle-pane-size':
          document.querySelector<HTMLElement>('[data-ui="pane-expand"]')?.click()
          break
        // The button owns the target, the disabled reason and the double-launch guard.
        case 'pane-external':
          document.querySelector<HTMLElement>('[data-ui="pane-external"]')?.click()
          break
        case 'pane-presentation':
          document.querySelector<HTMLElement>('[data-ui="pane-presentation"]')?.click()
          break
        case 'pane-reload':
          document.querySelector<HTMLElement>('[data-ui="html-reload"]')?.click()
          break
        // F6 pressed inside a native page, which main has already taken focus back from. The DOM's focus is
        // still wherever it was before the page took it, so the cycle counts from the pane.
        case 'region-next':
        case 'region-prev':
          cycleRegion(action === 'region-prev', document.querySelector('[data-ui="pane-secondary"]'))
          break
        // Menu accelerators are a keyboard path, so the pane changes without a transition.
        case 'browser-toggle':
          if (!activeSlice(store)?.browser) break
          store.toggleBrowser()
          leavePage(page)
          break
        // ⌥⌘0 is a click on the pane toggle: the same target, picker and subagent rules.
        case 'pane-toggle':
          if (!activeSlice(store)?.cwd) break
          store.togglePane()
          leavePage(page)
          break
        // A hidden pane has nothing to point at, so Point opens it first.
        case 'browser-annotate': {
          if (store.viewingSubagent) break
          const s = activeSlice(store)
          const kind = s && surfaceKindOf(s.surfaces, s.surfaces.active)
          if (s && !s.paneOpen && (kind === 'browser' || kind === 'diff' || fileLike(kind))) {
            store.setPane('half')
            requestAnimationFrame(point)
          } else point()
          break
        }
        case 'file-goto':
          window.dispatchEvent(new Event(FILE_GOTO_EVENT))
          break
        case 'browser-stop': {
          if (anyTabIn(activeSlice(store)?.browser, 'driving', 'user')) void store.browserDrive('stop')
          break
        }
      }
    })

    // 2. App-internal DOM shortcuts.
    const onKeyDown = (e: KeyboardEvent): void => {
      const store = useSession.getState()

      // ⌃Tab / ⌃⇧Tab: cycle live sessions. Control-based (NOT ⌘Tab, which macOS
      // reserves for app switching).
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab') {
        e.preventDefault()
        store.cycleSession(e.shiftKey ? -1 : 1)
        return
      }

      // ⌘B: toggle the session sidebar. No native-menu binding (no macOS default
      // on ⌘B outside a text field), so a DOM listener is the whole story.
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault()
        onToggleSidebar()
        return
      }

      if (e.key === 'F6' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (cycleRegion(e.shiftKey)) e.preventDefault()
        return
      }

      // ⌃C: interrupt, but ONLY while a turn is streaming. Guarding on `busy`
      // means that when nothing is running, ⌃C is a no-op and the browser's
      // native copy-of-selection still works for users with that habit.
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.key === 'c' || e.key === 'C')) {
        const active = store.activeHandleId ? store.sessions[store.activeHandleId] : null
        if (active?.busy) {
          e.preventDefault()
          void store.interrupt()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    // Holding ⌘ for the next ⌘W fires a Meta keydown, which mustn't count as a fresh action.
    const fresh = (e: Event): void => {
      if (!(e instanceof KeyboardEvent && MODIFIERS.has(e.key))) wClosedPane = false
    }
    document.addEventListener('keydown', fresh, true)
    document.addEventListener('pointerdown', fresh, true)

    return () => {
      off()
      window.removeEventListener(OPEN_FILE_EVENT, openFile)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('keydown', fresh, true)
      document.removeEventListener('pointerdown', fresh, true)
    }
  }, [
    onNewSession,
    onNewQuickSession,
    onNewSessionInDir,
    onOpenSettings,
    onOpenPalette,
    onToggleSidebar
  ])
}
