import { useEffect, useRef, type RefObject } from 'react'

/**
 * Ref for a Stop button that "stopping…" replaces while the stop is in flight. Unmounting it drops
 * focus to <body>, so when the stop fails and the button returns, a keyboard user lands back on it.
 * A user whose focus has moved elsewhere is left alone.
 */
export function useStopFocus<T extends HTMLElement>(stopping: boolean): RefObject<T> {
  const ref = useRef<T>(null)
  const was = useRef(stopping)
  useEffect(() => {
    const back = was.current && !stopping
    was.current = stopping
    if (!back || document.activeElement !== document.body) return
    // The button is opacity-0 until hover or focus-visible, so the focus has to be visible.
    // TypeScript's DOM lib doesn't declare focusVisible yet; Chromium takes it.
    const opts: FocusOptions & { focusVisible?: boolean } = { focusVisible: true }
    ref.current?.focus(opts)
  }, [stopping])
  return ref
}
