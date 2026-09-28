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
import { activeSlice, useSession } from '../store'
import type { PaletteMode } from '../components/CommandPalette'

/**
 * @param onNewSession start a directoryless session in the chat dir (⌘N)
 * @param onNewQuickSession start an ephemeral, not-saved session (⌥⌘N)
 * @param onNewSessionInDir pick a workspace folder, then start there (⌘⇧N)
 * @param onOpenSettings open the Settings modal (⌘,)
 */
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
    // 1. Native-menu actions (⌘N / ⌘W / ⌘,).
    const off = window.clui.onMenuAction((action) => {
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
        case 'close-session': {
          const id = store.activeHandleId
          if (id) void store.closeSession(id)
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
        // Find/search route straight to store flags (no App callback needed).
        // ⌘F only means something with a session open; ⌘⇧F is always available.
        case 'find-in-conversation':
          if (store.activeHandleId) store.setFindOpen(true)
          break
        case 'find-next':
        case 'find-prev':
          // Fallback path when focus isn't in the find input (the input handles
          // Enter/⇧Enter locally). Re-open the bar if closed; the FindBar component
          // reads these via its own menu subscription for match nav.
          if (store.activeHandleId) store.setFindOpen(true)
          break
        case 'search-global':
          store.setGlobalSearchOpen(true)
          break
        // Clicking the pane's own button reuses its focus rule, and it only exists when the Stage is
        // wide enough to split, so a narrow window or a closed pane makes this a no-op.
        case 'toggle-pane-size':
          document.querySelector<HTMLElement>('[data-ui="pane-expand"]')?.click()
          break
        case 'browser-toggle': {
          // A menu accelerator is a keyboard path, so the pane changes without a transition. With
          // focus in the native page the renderer's document doesn't have it, and a hidden page
          // can't keep it, so it goes to the composer.
          if (!activeSlice(store)?.browser) break
          const fromPage = !document.hasFocus()
          store.toggleBrowser()
          if (fromPage && !activeSlice(useSession.getState())?.browserOpen)
            document.querySelector<HTMLElement>('[data-composer-input]')?.focus()
          break
        }
        case 'browser-stop': {
          const d = activeSlice(store)?.browser?.drive
          if (d === 'driving' || d === 'user') void store.browserDrive('stop')
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

      // Each region lands on its main control.
      if (e.key === 'F6' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const REGIONS = '#app-sidebar, [data-ui="pane-primary"], [data-ui="pane-secondary"]'
        const targets = [
          document.querySelector<HTMLElement>('#app-sidebar [data-new-session]'),
          document.querySelector<HTMLElement>('[data-ui="pane-primary"] [data-composer-input]'),
          document.querySelector<HTMLElement>('[data-ui="pane-secondary"] [data-pane-title]')
        ].filter((el): el is HTMLElement => !!el && !el.closest('[inert]'))
        if (targets.length < 2) return
        e.preventDefault()
        const here = document.activeElement?.closest(REGIONS) ?? null
        const at = targets.findIndex((el) => el.closest(REGIONS) === here)
        const step = e.shiftKey ? -1 : 1
        const next = at < 0 ? (e.shiftKey ? targets.length - 1 : 0) : (at + step + targets.length) % targets.length
        targets[next].focus()
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

    return () => {
      off()
      document.removeEventListener('keydown', onKeyDown)
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
