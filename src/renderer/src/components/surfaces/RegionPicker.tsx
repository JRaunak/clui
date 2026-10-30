import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, type RefObject } from 'react'
import type { Region } from '../../../../shared/surfaces'
import { round4, type Size } from '../../lib/imageView'

export type Picked = { region: Region; point?: undefined } | { point: { x: number; y: number }; region?: undefined } | null
export interface PickerHandle {
  /** Redraws the marks from the content's box now, for an owner that just moved it. */
  redraw: () => void
}

/** Under this many screen pixels a drag is a click. */
const CLICK_PX = 4
/** One Shift or ⌥ arrow press, in screen pixels, so zooming in is the precision. */
const STEP_PX = 8

type P = { x: number; y: number }
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

/**
 * Region and point selection over any content element: the drag and click while pointing, Shift and ⌥ arrows,
 * Enter and Escape, and the overlay that marks the selection. Coordinates are 0 to 1 of the content's untransformed
 * box, whose pixels are `basis`. It knows nothing of files: the owner turns a selection into a reference and takes
 * the picture. The overlay sits on the viewport untransformed, so its lines stay 1px at any zoom.
 */
export const RegionPicker = forwardRef<
  PickerHandle,
  {
    viewport: RefObject<HTMLElement>
    content: RefObject<HTMLElement>
    basis: Size
    selection: Picked
    pointing: boolean
    onChange: (next: Picked) => void
    onAdd: () => void
    /** Escape with nothing selected. */
    onEnd: () => void
    /** The owner pans instead while this holds (Space). */
    panning: () => boolean
  }
>(function RegionPicker({ viewport, content, basis, selection, pointing, onChange, onAdd, onEnd, panning }, ref) {
  const svg = useRef<SVGSVGElement>(null)
  const live = useRef<Picked | undefined>(undefined)
  // The keyboard's fixed corner and moving corner; a drag's press point is its anchor.
  const ends = useRef<{ a: P; b: P } | null>(null)
  const own = useRef<Picked>(null)
  const latest = useRef({ selection, pointing, basis, onChange, onAdd, onEnd, panning })
  latest.current = { selection, pointing, basis, onChange, onAdd, onEnd, panning }

  const boxes = (): { v: DOMRect; c: DOMRect } | null => {
    const v = viewport.current?.getBoundingClientRect()
    const c = content.current?.getBoundingClientRect()
    return v && c && c.width > 0 && c.height > 0 ? { v, c } : null
  }

  const redraw = useCallback(() => {
    const el = svg.current
    const b = boxes()
    if (!el || !b) return
    const sel = live.current === undefined ? latest.current.selection : live.current
    const [veil, outer, inner, ring, ringIn, dot, dotIn] = [...el.children] as SVGElement[]
    const show = (on: boolean, ...els: SVGElement[]): void => els.forEach((x) => x.setAttribute('visibility', on ? 'visible' : 'hidden'))
    const set = (x: SVGElement, a: Record<string, number | string>): void => Object.entries(a).forEach(([k, v]) => x.setAttribute(k, String(v)))
    const ox = b.c.left - b.v.left
    const oy = b.c.top - b.v.top
    show(!!sel?.region, veil, outer, inner)
    show(!!sel?.point, ring, ringIn, dot, dotIn)
    if (sel?.region) {
      const r = sel.region
      const x = Math.round(ox + r.x * b.c.width)
      const y = Math.round(oy + r.y * b.c.height)
      const w = Math.max(1, Math.round(r.w * b.c.width))
      const h = Math.max(1, Math.round(r.h * b.c.height))
      set(veil, { d: `M0 0H${b.v.width}V${b.v.height}H0Z M${x} ${y}h${w}v${h}h${-w}Z` })
      set(outer, { x: x - 0.5, y: y - 0.5, width: w + 1, height: h + 1 })
      set(inner, { x: x + 0.5, y: y + 0.5, width: Math.max(0, w - 1), height: Math.max(0, h - 1) })
    }
    if (sel?.point) {
      const cx = ox + sel.point.x * b.c.width
      const cy = oy + sel.point.y * b.c.height
      for (const c of [ring, ringIn, dot, dotIn]) set(c, { cx, cy })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useImperativeHandle(ref, () => ({ redraw }), [redraw])
  useLayoutEffect(redraw, [selection, redraw])

  const emit = (next: Picked): void => {
    own.current = next
    latest.current.onChange(next)
  }
  const regionOf = (a: P, b: P): Picked => {
    const { basis } = latest.current
    const minW = 1 / basis.w
    const minH = 1 / basis.h
    let x = Math.min(a.x, b.x)
    let y = Math.min(a.y, b.y)
    const w = Math.max(minW, Math.abs(a.x - b.x))
    const h = Math.max(minH, Math.abs(a.y - b.y))
    x = Math.min(x, 1 - w)
    y = Math.min(y, 1 - h)
    const rx = round4(x)
    const ry = round4(y)
    return { region: { x: rx, y: ry, w: Math.min(round4(w), round4(1 - rx)), h: Math.min(round4(h), round4(1 - ry)) } }
  }
  const pointOf = (p: P): Picked => ({ point: { x: round4(clamp01(p.x)), y: round4(clamp01(p.y)) } })

  // A selection the owner set (a restore, an open from a chip) anchors the keyboard at its top left. Its own comes back
  // as a copy, which keeps the corners it was made from: a region's 1px minimum isn't a corner.
  useEffect(() => {
    if (JSON.stringify(selection) === JSON.stringify(own.current)) return
    own.current = selection
    ends.current = selection?.region
      ? { a: { x: selection.region.x, y: selection.region.y }, b: { x: selection.region.x + selection.region.w, y: selection.region.y + selection.region.h } }
      : selection?.point
        ? { a: selection.point, b: selection.point }
        : null
  }, [selection])

  useEffect(() => {
    const vp = viewport.current
    if (!vp) return
    let drag: { id: number; sx: number; sy: number; a: P; moved: boolean } | null = null
    const norm = (e: PointerEvent, b: { c: DOMRect }): P => ({ x: (e.clientX - b.c.left) / b.c.width, y: (e.clientY - b.c.top) / b.c.height })
    const onDown = (e: PointerEvent): void => {
      const { pointing, panning } = latest.current
      if (!pointing || e.button !== 0 || panning() || e.defaultPrevented) return
      const b = boxes()
      if (!b) return
      e.preventDefault()
      vp.setPointerCapture(e.pointerId)
      const p = norm(e, b)
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, a: { x: clamp01(p.x), y: clamp01(p.y) }, moved: false }
    }
    const onMove = (e: PointerEvent): void => {
      if (!drag || e.pointerId !== drag.id) return
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < CLICK_PX) return
      const b = boxes()
      if (!b) return
      drag.moved = true
      const p = norm(e, b)
      live.current = regionOf(drag.a, { x: clamp01(p.x), y: clamp01(p.y) })
      redraw()
    }
    const onUp = (e: PointerEvent): void => {
      if (!drag || e.pointerId !== drag.id) return
      const d = drag
      drag = null
      const b = boxes()
      const picked = live.current
      live.current = undefined
      if (!b) return redraw()
      if (d.moved && picked) {
        const p = norm(e, b)
        ends.current = { a: d.a, b: { x: clamp01(p.x), y: clamp01(p.y) } }
        return emit(picked)
      }
      const p = norm(e, b)
      const onImage = p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1
      ends.current = onImage ? { a: p, b: p } : null
      emit(onImage ? pointOf(p) : null)
    }
    const cancel = (): boolean => {
      if (!drag) return false
      if (vp.hasPointerCapture(drag.id)) vp.releasePointerCapture(drag.id)
      drag = null
      live.current = undefined
      redraw()
      return true
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.target !== vp || e.metaKey || e.ctrlKey) return
      const { selection: sel, pointing } = latest.current
      if (e.key === 'Escape') {
        if (cancel()) return void e.preventDefault()
        if (sel) {
          e.preventDefault()
          ends.current = null
          return emit(null)
        }
        if (pointing) {
          e.preventDefault()
          latest.current.onEnd()
        }
        return
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
        if (!sel) return
        e.preventDefault()
        return latest.current.onAdd()
      }
      const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]
      if (!dir || e.shiftKey === e.altKey) return
      const b = boxes()
      if (!b) return
      e.preventDefault()
      const dx = (dir[0] * STEP_PX) / b.c.width
      const dy = (dir[1] * STEP_PX) / b.c.height
      const move = (p: P): P => ({ x: clamp01(p.x + dx), y: clamp01(p.y + dy) })
      const cur = ends.current
      if (e.shiftKey) {
        if (!sel || !cur) {
          // The centre of the part of the image that shows.
          const l = Math.max(b.c.left, b.v.left)
          const t = Math.max(b.c.top, b.v.top)
          const r = Math.min(b.c.right, b.v.right)
          const btm = Math.min(b.c.bottom, b.v.bottom)
          const c = { x: clamp01(((l + r) / 2 - b.c.left) / b.c.width), y: clamp01(((t + btm) / 2 - b.c.top) / b.c.height) }
          ends.current = { a: c, b: c }
          return emit(pointOf(c))
        }
        ends.current = { a: cur.a, b: move(cur.b) }
        return emit(regionOf(ends.current.a, ends.current.b))
      }
      if (!sel || !cur) return
      if (sel.point) {
        const p = move(sel.point)
        ends.current = { a: p, b: p }
        return emit(pointOf(p))
      }
      const r = sel.region
      const x = Math.min(1 - r.w, Math.max(0, r.x + dx)) - r.x
      const y = Math.min(1 - r.h, Math.max(0, r.y + dy)) - r.y
      ends.current = { a: { x: cur.a.x + x, y: cur.a.y + y }, b: { x: cur.b.x + x, y: cur.b.y + y } }
      emit({ region: { x: round4(r.x + x), y: round4(r.y + y), w: r.w, h: r.h } })
    }
    vp.addEventListener('pointerdown', onDown)
    vp.addEventListener('pointermove', onMove)
    vp.addEventListener('pointerup', onUp)
    vp.addEventListener('pointercancel', cancel)
    vp.addEventListener('keydown', onKey)
    const ro = new ResizeObserver(redraw)
    ro.observe(vp)
    return () => {
      vp.removeEventListener('pointerdown', onDown)
      vp.removeEventListener('pointermove', onMove)
      vp.removeEventListener('pointerup', onUp)
      vp.removeEventListener('pointercancel', cancel)
      vp.removeEventListener('keydown', onKey)
      ro.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport, redraw])

  // The two-tone edge is black and white: against any pixel one of them clears 4.58:1.
  return (
    <svg ref={svg} aria-hidden="true" data-ui="region-overlay" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
      <path fill="var(--scrim)" fillRule="evenodd" visibility="hidden" />
      <rect fill="none" strokeWidth="1" visibility="hidden" className="stroke-edge-dark" />
      <rect fill="none" strokeWidth="1" visibility="hidden" className="stroke-edge-light" />
      <circle r="6" fill="none" strokeWidth="4" visibility="hidden" className="stroke-edge-dark" />
      <circle r="6" fill="none" strokeWidth="2" visibility="hidden" className="stroke-edge-light" />
      <circle r="2" visibility="hidden" className="fill-edge-dark" />
      <circle r="1" visibility="hidden" className="fill-edge-light" />
    </svg>
  )
})
