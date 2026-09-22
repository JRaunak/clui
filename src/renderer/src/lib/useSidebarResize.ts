import { useCallback, useEffect, useState, type KeyboardEvent, type PointerEvent } from 'react'

// Row grammar (title + kebab + close) stops fitting below this.
export const SIDEBAR_MIN = 240
// Ceiling on any display: past this a session list is a wasteful second column.
export const SIDEBAR_MAX_ABS = 520
export const SIDEBAR_DEFAULT = 288
const KEY_STEP = 16
const KEY_STEP_LARGE = 48

// 0.40 keeps main ≥60% of the window, so the sidebar never starves it.
export const sidebarMaxFor = (winW: number): number => Math.min(SIDEBAR_MAX_ABS, Math.round(0.4 * winW))

export const clampSidebarWidth = (w: number, winW: number): number =>
  Math.min(sidebarMaxFor(winW), Math.max(SIDEBAR_MIN, w))

interface Args {
  /** The user's persisted width. */
  width: number
  /** Commit a width on release or keyboard end, never per-frame; App persists it. */
  setWidth: (w: number) => void
  collapsed: boolean
}

interface SeparatorProps {
  role: 'separator'
  'aria-orientation': 'vertical'
  'aria-controls': string
  'aria-valuemin': number
  'aria-valuemax': number
  'aria-valuenow': number
  'aria-label': string
  tabIndex: number
  onPointerDown: (e: PointerEvent) => void
  onKeyDown: (e: KeyboardEvent) => void
}

interface SidebarResize {
  appliedWidth: number
  dragging: boolean
  separatorProps: SeparatorProps
}

/**
 * Drag/keyboard resize for the left sidebar. Stored width is the user's intent; the applied width
 * re-clamps to the live window, so a width saved on a wide monitor fits a laptop and grows back.
 * A drag clamps at MIN; collapsing to the rail is the toggle's job, not the drag's.
 */
export function useSidebarResize({ width, setWidth, collapsed }: Args): SidebarResize {
  const [winW, setWinW] = useState(() => window.innerWidth)
  // Live pointer width during a drag; null when not dragging.
  const [dragWidth, setDragWidth] = useState<number | null>(null)

  useEffect(() => {
    const onResize = (): void => setWinW(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const max = sidebarMaxFor(winW)
  const appliedWidth = dragWidth ?? clampSidebarWidth(width, winW)

  const onPointerDown = useCallback(
    (e: PointerEvent): void => {
      if (collapsed) return
      e.preventDefault()
      const startX = e.clientX
      const startW = clampSidebarWidth(width, winW)
      const curMax = sidebarMaxFor(window.innerWidth)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      const rawAt = (ev: globalThis.PointerEvent): number => startW + (ev.clientX - startX)
      const onMove = (ev: globalThis.PointerEvent): void => {
        setDragWidth(Math.min(curMax, Math.max(SIDEBAR_MIN, rawAt(ev))))
      }
      const onUp = (ev: globalThis.PointerEvent): void => {
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        setDragWidth(null)
        setWidth(Math.min(curMax, Math.max(SIDEBAR_MIN, rawAt(ev))))
      }
      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
    },
    [collapsed, width, winW, setWidth]
  )

  const onKeyDown = useCallback(
    (e: KeyboardEvent): void => {
      const cur = clampSidebarWidth(width, winW)
      let target: number
      if (e.key === 'ArrowLeft') target = cur - (e.shiftKey ? KEY_STEP_LARGE : KEY_STEP)
      else if (e.key === 'ArrowRight') target = cur + (e.shiftKey ? KEY_STEP_LARGE : KEY_STEP)
      else if (e.key === 'Home') target = SIDEBAR_MIN
      else if (e.key === 'End') target = max
      else return
      e.preventDefault()
      setWidth(Math.min(max, Math.max(SIDEBAR_MIN, target)))
    },
    [width, winW, max, setWidth]
  )

  return {
    appliedWidth,
    dragging: dragWidth !== null,
    separatorProps: {
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-controls': 'app-sidebar',
      'aria-valuemin': SIDEBAR_MIN,
      'aria-valuemax': max,
      'aria-valuenow': Math.round(appliedWidth),
      'aria-label': 'Resize sidebar',
      tabIndex: 0,
      onPointerDown,
      onKeyDown
    }
  }
}
