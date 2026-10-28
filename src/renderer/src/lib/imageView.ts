// The image surface's view model: a content box at its CSS size, shown under translate(x, y) scale(s) in a viewport.
// Pure, so the zoom steps, the clamp and the saved place are testable without a DOM.

export interface Size { w: number; h: number }
export interface View { s: number; x: number; y: number }

export const STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16]
export const MAX_SCALE = 16
export const FIT_MARGIN = 16
/** From here a raster shows its pixels as squares, for inspection. */
export const PIXELATED_AT = 4
const EPS = 1e-6

/** `@2x` and `@3x` names are made for that density, so 100% shows them at their point size. */
export const densityOf = (name: string): number => Number(/@([23])x\.[^.]+$/i.exec(name)?.[1] ?? 1)

/** Contain inside the viewport less the margin, never above 100%. */
export const fitScale = (box: Size, vp: Size): number =>
  Math.max(EPS, Math.min(1, (vp.w - 2 * FIT_MARGIN) / box.w, (vp.h - 2 * FIT_MARGIN) / box.h))

export const minScale = (fit: number): number => Math.min(fit, STEPS[0])

export const clampScale = (s: number, fit: number): number => Math.min(MAX_SCALE, Math.max(minScale(fit), s))

/** The next stop above `s`, so from Fit at 42% it's 50%. */
export const stepUp = (s: number): number => STEPS.find((v) => v > s + EPS) ?? MAX_SCALE

export const stepDown = (s: number, fit: number): number => Math.max(minScale(fit), [...STEPS].reverse().find((v) => v < s - EPS) ?? minScale(fit))

/** An axis that overflows stops at the viewport's edges; one that fits stays centred. */
export function clampView(v: View, box: Size, vp: Size): View {
  const axis = (at: number, content: number, room: number): number => (content <= room ? (room - content) / 2 : Math.min(0, Math.max(room - content, at)))
  return { s: v.s, x: axis(v.x, box.w * v.s, vp.w), y: axis(v.y, box.h * v.s, vp.h) }
}

/** `s` with the content point under viewport point `(px, py)` held still. */
export function zoomAt(v: View, s: number, px: number, py: number, box: Size, vp: Size): View {
  const cx = (px - v.x) / v.s
  const cy = (py - v.y) / v.s
  return clampView({ s, x: px - cx * s, y: py - cy * s }, box, vp)
}

export const fitView = (box: Size, vp: Size): View => clampView({ s: fitScale(box, vp), x: 0, y: 0 }, box, vp)

/** The normalized image point at the viewport's centre: a saved place that lands right at any pane size. */
export const centreOf = (v: View, box: Size, vp: Size): { x: number; y: number } => ({ x: (vp.w / 2 - v.x) / v.s / box.w, y: (vp.h / 2 - v.y) / v.s / box.h })

export function viewAt(zoom: number | 'fit', pan: { x: number; y: number }, box: Size, vp: Size): View {
  if (zoom === 'fit') return fitView(box, vp)
  const s = clampScale(zoom, fitScale(box, vp))
  return clampView({ s, x: vp.w / 2 - pan.x * box.w * s, y: vp.h / 2 - pan.y * box.h * s }, box, vp)
}

export const overflows = (v: View, box: Size, vp: Size): { x: boolean; y: boolean } => ({ x: box.w * v.s > vp.w + EPS, y: box.h * v.s > vp.h + EPS })

/** Whole percent; under 10%, one decimal. */
export function percent(s: number): string {
  const p = s * 100
  return p < 10 ? `${Math.round(p * 10) / 10}%` : `${Math.round(p)}%`
}

/** `84 KB` under 1 MB, rounded as the attachment chip rounds KB; `2.4 MB` above. */
export const fileSize = (bytes: number): string => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`)

/** A cubic-bezier easing for a `cubic-bezier(a, b, c, d)` token, solved for x by Newton's method. */
export function easing(token: string): (t: number) => number {
  const m = /cubic-bezier\(([^)]+)\)/.exec(token)
  const [x1, y1, x2, y2] = m ? m[1].split(',').map(Number) : [0.2, 0, 0, 1]
  const at = (a: number, b: number, t: number): number => 3 * a * (1 - t) ** 2 * t + 3 * b * (1 - t) * t ** 2 + t ** 3
  return (x) => {
    if (x <= 0 || x >= 1) return Math.min(1, Math.max(0, x))
    let t = x
    for (let i = 0; i < 8; i++) {
      const d = 3 * x1 * (1 - t) ** 2 + 6 * (x2 - x1) * (1 - t) * t + 3 * (1 - x2) * t ** 2
      if (Math.abs(d) < EPS) break
      t -= (at(x1, x2, t) - x) / d
      t = Math.min(1, Math.max(0, t))
    }
    return at(y1, y2, t)
  }
}

export const round4 = (v: number): number => Math.round(v * 1e4) / 1e4
