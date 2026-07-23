/**
 * Theme application (light/dark/system) in the renderer.
 *
 * The preload already sets `<html data-theme>` before first paint (no flash).
 * This module keeps it in sync afterwards: it re-applies on demand (e.g. when the
 * user changes the Settings toggle) and, while following the OS ('system'),
 * listens to `prefers-color-scheme` so a live OS switch flips the app instantly.
 *
 * Only `data-theme` is touched; the light palette is a pure CSS re-map of the
 * semantic tokens (see styles.css `:root[data-theme='light']`).
 */
import type { ThemeChoice } from '../../../shared/settings'

const media = window.matchMedia('(prefers-color-scheme: dark)')

/** Resolve a preference to a concrete theme, consulting the OS for 'system'. */
function resolve(pref: ThemeChoice): 'dark' | 'light' {
  if (pref === 'system') return media.matches ? 'dark' : 'light'
  return pref
}

let systemListener: ((e: MediaQueryListEvent) => void) | null = null

/**
 * Apply a theme preference to `<html data-theme>`. When the preference is
 * 'system', (re)installs a media listener so OS changes propagate live; otherwise
 * removes any prior listener. Idempotent — safe to call on every settings change.
 */
export function applyTheme(pref: ThemeChoice): void {
  document.documentElement.setAttribute('data-theme', resolve(pref))

  if (systemListener) {
    media.removeEventListener('change', systemListener)
    systemListener = null
  }
  if (pref === 'system') {
    systemListener = (e) => {
      document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light')
    }
    media.addEventListener('change', systemListener)
  }
}
