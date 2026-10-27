import { useEffect, useState, type RefObject } from 'react'
import { getStage } from './stage'
import { onOcclusion } from './nativeOcclusion'
import type { PaneBounds } from '../../../shared/browser'

/**
 * Reports the element's rect, once a frame at most, whenever it can have moved, so main can lay a
 * native view over it. A new `report` re-subscribes. Returns whether an overlay occludes the views.
 */
export function useNativeSlot(ref: RefObject<HTMLElement>, report: (b: PaneBounds) => void): boolean {
  useEffect(() => {
    const el = ref.current
    const stage = getStage()
    if (!el) return
    let raf = 0
    const schedule = (): void => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const r = el.getBoundingClientRect()
        report({
          x: Math.round(r.left),
          y: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height)
        })
      })
    }
    schedule()
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    window.addEventListener('resize', schedule)
    stage?.addEventListener('transitionend', schedule)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', schedule)
      stage?.removeEventListener('transitionend', schedule)
      cancelAnimationFrame(raf)
    }
  }, [ref, report])

  const [occluded, setOccluded] = useState(false)
  useEffect(() => onOcclusion(setOccluded), [])
  return occluded
}
