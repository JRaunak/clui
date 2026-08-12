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
 *
 * All bindings use modifiers, so they stay active even while the composer
 * textarea is focused (the macOS convention: ⌘/⌃ shortcuts are global). We never
 * bind a plain key, which is the actual safety guarantee against hijacking typing.
 */
import { useEffect } from 'react'
import { useSession } from '../store'

/**
 * @param onNewSession open the workspace picker / start a session (⌘N)
 * @param onNewNamedSession open the name-this-session dialog (⌘⇧N)
 * @param onOpenSettings open the Settings modal (⌘,)
 */
export function useKeyboardShortcuts(opts: {
  onNewSession: () => void
  onNewNamedSession: () => void
  onOpenSettings: () => void
  onOpenPalette: () => void
  onToggleSidebar: () => void
}): void {
  const { onNewSession, onNewNamedSession, onOpenSettings, onOpenPalette, onToggleSidebar } = opts

  useEffect(() => {
    // 1. Native-menu actions (⌘N / ⌘W / ⌘,).
    const off = window.clui.onMenuAction((action) => {
      const store = useSession.getState()
      switch (action) {
        case 'new-session':
          onNewSession()
          break
        case 'new-named-session':
          onNewNamedSession()
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
          onOpenPalette()
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
  }, [onNewSession, onNewNamedSession, onOpenSettings, onOpenPalette, onToggleSidebar])
}
