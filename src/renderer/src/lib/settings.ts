import { create } from 'zustand'
import type { ResolvedSettings } from '../../../shared/settings'

/** The renderer's copy of main's settings, null until the first read lands. Only `watchSettings` writes it. */
export const useSettings = create<ResolvedSettings | null>(() => null)

/** Pushes arrive in commit order. The first read can resolve after a push carrying a newer snapshot, so it
 *  only fills an empty mirror. */
export function watchSettings(): () => void {
  let pushed = false
  void window.clui.getSettings().then(
    (s) => pushed || useSettings.setState(s, true),
    () => {}
  )
  return window.clui.onSettingsChanged((s) => {
    pushed = true
    useSettings.setState(s, true)
  })
}
