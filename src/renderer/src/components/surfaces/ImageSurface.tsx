import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { refsOf, useActive, useSession } from '../../store'
import { CROP_MAX_EDGE } from '../../../../shared/annotate'
import { imagePx, refKey, VISUAL_MAX, type DraftReference, type DraftVisual, type RefInput, type SourceVersion } from '../../../../shared/context'
import { MAX_PIXELS, tooLarge, type ImageFormat } from '../../../../shared/imageHead'
import type { Refusal } from '../../../../shared/files'
import { Button } from '../Button'
import { IconMinus, IconPlay, IconPlus, IconStop } from '../Icon'
import { DISABLED_BTN, PANE_BTN } from './PaneHeader'
import { PreviewPointed } from './PreviewPointed'
import { ANNOUNCE_MS, SelectionBar } from './SelectionBar'
import { RegionPicker, type Picked, type PickerHandle } from './RegionPicker'
import { baseOf, DocState, openDefault, REASON, SelectionNotice, SKELETON_MS, STATE_BODY, VIEW_SETTLE_MS, setStatus, type Doc } from './fileDoc'
import { addFromSurface } from '../ContextChips'
import { useSettings } from '../../lib/settings'
import { useSay } from '../../lib/useSay'
import { cssMs, cssVar, reducedMotion, viaOf, type Via } from '../../lib/motion'
import { noteRead } from '../../lib/blockedFiles'
import { POINT_OFF } from '../../lib/refCopy'
import { setPointBlocked, setPointing, takePoint, takeSurfaceFocus, usePointing, usePointRequest } from '../../lib/surfaceFocus'
import { isSvg } from '../../../../shared/surfaces'
import {
  centreOf,
  clampScale,
  clampView,
  densityOf,
  easing,
  fileSize,
  fitScale,
  fitView,
  MAX_SCALE,
  minScale,
  overflows,
  percent,
  PIXELATED_AT,
  stepDown,
  stepUp,
  viewAt,
  zoomAt,
  type Size,
  type View
} from '../../lib/imageView'

const TURN_RELOAD_MS = 300
const MISSING_POLL_MS = 2000
const ARROW_PX = 40
const GESTURE_IDLE_MS = 150
const MIME: Record<Exclude<ImageFormat, 'svg'>, string> = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' }
export const TEXT_BUTTON =
  'h-7 shrink-0 rounded-md px-2 text-label text-dim transition-colors pointer-fine:hover:bg-[var(--glass-row-hover)] pointer-fine:hover:text-content'
const POINTING_SAID = 'Pointing. Drag across the image to select a region, or click a point. Shift and an arrow key also selects. Enter adds it.'
const POINT_HINT = 'Drag across the image, or click a point.'
const TOO_MANY_BYTES = "It's larger than 200 MB. Clui shows images up to 200 MB."
const NO_IMAGE = "There's no image here to point at."
const NOTICE = {
  cleared: 'The image changed on disk, so the selection was cleared.',
  removed: 'The image changed on disk, so the selection was cleared and removed from the message.'
}

interface Still { frames: number; canvas: HTMLCanvasElement }
type Shown =
  | { t: 'loading' }
  | { t: 'image'; img: HTMLImageElement; url: string; version: SourceVersion; bytes: number; natural: Size; format: ImageFormat; orientation?: number }
  | { t: 'empty' }
  | { t: 'unknown'; bytes: number }
  | { t: 'damaged'; bytes: number }
  | { t: 'too-large'; w: number; h: number; bytes: number }
  | { t: 'missing' }
  | { t: 'error'; reason: Refusal['reason']; message: string }

/** Frame 0 of an animated image, decoded on its own: CSS can't stop an `<img>`, so this is the only way to hold it still. */
async function stillOf(url: string, type: string): Promise<Still | null> {
  if (typeof ImageDecoder === 'undefined' || !(await ImageDecoder.isTypeSupported(type))) return null
  const res = await fetch(url)
  if (!res.ok || !res.body) return null
  const dec = new ImageDecoder({ data: res.body, type })
  try {
    await dec.tracks.ready
    const track = dec.tracks.selectedTrack
    if (!track?.animated) return null
    await dec.completed
    if (track.frameCount < 2) return null
    const { image } = await dec.decode({ frameIndex: 0 })
    const canvas = document.createElement('canvas')
    canvas.width = image.displayWidth
    canvas.height = image.displayHeight
    canvas.getContext('2d')?.drawImage(image, 0, 0)
    image.close()
    return { frames: track.frameCount, canvas }
  } finally {
    dec.close()
  }
}

/** The region's pixels as shown, from the element the user sees: `drawImage` takes an `<img>` after EXIF orientation,
 *  and draws an SVG as vectors at the size asked. */
function cropOf(src: CanvasImageSource, natural: Size, r: NonNullable<Picked>['region'] & {}, svg: boolean): DraftVisual | null {
  const sx = r.x * natural.w
  const sy = r.y * natural.h
  const sw = Math.max(1, r.w * natural.w)
  const sh = Math.max(1, r.h * natural.h)
  const long = Math.max(sw, sh)
  let k = svg ? Math.min(CROP_MAX_EDGE, 4 * long) / long : Math.min(1, CROP_MAX_EDGE / long)
  for (let i = 0; i < 6; i++, k *= 0.75) {
    const w = Math.max(1, Math.round(sw * k))
    const h = Math.max(1, Math.round(sh * k))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const g = c.getContext('2d', { willReadFrequently: true })
    if (!g) return null
    g.drawImage(src, sx, sy, sw, sh, 0, 0, w, h)
    const px = g.getImageData(0, 0, w, h).data
    let alpha = false
    for (let j = 3; j < px.length && !alpha; j += 4) alpha = px[j] !== 255
    const mimeType = alpha ? 'image/png' : 'image/jpeg'
    const url = alpha ? c.toDataURL(mimeType) : c.toDataURL(mimeType, 0.85)
    const data = url.slice(url.indexOf(',') + 1)
    // A noisy region with transparency can encode past the packet's limit; a smaller copy still shows it.
    if (data.length <= VISUAL_MAX) return { id: crypto.randomUUID(), data, mimeType, w, h }
  }
  return null
}

const sameSel = (a: Picked, b: Picked): boolean => JSON.stringify(a) === JSON.stringify(b)

/** The toolbar's zoom controls: out, the readout, in, and the surface's fit button after them. `max` is the largest
 *  zoom, which the disabled title names. */
export function ZoomGroup({ s, atMin, atMax, max, onStep, children }: { s: number; atMin: boolean; atMax: boolean; max: number; onStep: (dir: 1 | -1) => void; children: ReactNode }): JSX.Element {
  return (
    <div role="group" aria-label="Zoom" className="flex items-center gap-0.5">
      <button
        type="button"
        data-ui="image-zoom-out"
        aria-label="Zoom out"
        aria-disabled={atMin || undefined}
        title={atMin ? `Zoom out. Already at ${percent(s)}, the smallest.` : 'Zoom out ⌘−'}
        onClick={() => onStep(-1)}
        className={`${PANE_BTN} ${DISABLED_BTN}`}
      >
        <IconMinus className="h-4 w-4" />
      </button>
      <span data-ui="image-zoom" aria-hidden="true" className="min-w-[5ch] text-center text-label tabular-nums text-dim">
        {percent(s)}
      </span>
      <button
        type="button"
        data-ui="image-zoom-in"
        aria-label="Zoom in"
        aria-disabled={atMax || undefined}
        title={atMax ? `Zoom in. Already at ${percent(max)}, the largest.` : 'Zoom in ⌘+'}
        onClick={() => onStep(1)}
        className={`${PANE_BTN} ${DISABLED_BTN}`}
      >
        <IconPlus className="h-4 w-4" />
      </button>
      {children}
    </div>
  )
}

/**
 * An image or an SVG's Preview: the picture in a viewport that zooms and pans by transform only, under a toolbar that
 * holds every control, so nothing sits over its pixels. Pointing selects a region or a point of it for the message.
 */
export function ImageSurface({ handleId, tabId }: { handleId: string; tabId: string }): JSX.Element {
  const tab = useActive((s) => s?.surfaces.tabs[tabId])
  const path = tab?.key ?? ''
  const name = baseOf(path)
  const owner = `image:${tabId}`
  const busy = useActive((s) => !!s?.busy)
  const setView = useSession((s) => s.setSurfaceView)
  const picture = useSettings((s) => s?.values.annotateScreenshots ?? true)
  const [said, say] = useSay()

  const [shown, setShown] = useState<Shown>({ t: 'loading' })
  const shownRef = useRef(shown)
  shownRef.current = shown
  const [still, setStill] = useState<Still | null>(null)
  const [playing, setPlaying] = useState(() => !reducedMotion())
  const [slow, setSlow] = useState(false)
  const [notice, setNotice] = useState<'cleared' | 'removed' | null>(null)
  const [watchGen, setWatchGen] = useState(0)
  const [adding, setAdding] = useState(false)

  const viewportEl = useRef<HTMLDivElement>(null)
  const contentEl = useRef<HTMLDivElement>(null)
  const hostEl = useRef<HTMLDivElement>(null)
  const picker = useRef<PickerHandle>(null)
  const stateEl = useRef<HTMLDivElement>(null)
  // The newest cap for the bytes on screen; an unchanged reload swaps it in without redrawing.
  const capUrl = useRef('')
  const loadGen = useRef(0)
  const captureGen = useRef(0)

  const image = shown.t === 'image' ? shown : null
  const svg = image?.format === 'svg'
  const density = svg ? 1 : densityOf(name)
  const box = useMemo<Size | null>(() => (image ? { w: image.natural.w / density, h: image.natural.h / density } : null), [image, density])
  const animated = !!still

  // Kept the same object while its values are, so effects keyed on it run only on a real change.
  const raw = tab?.selection
  const selJson = JSON.stringify(raw?.region ? { region: raw.region } : raw?.point ? { point: raw.point } : null)
  const selection = useMemo<Picked>(() => JSON.parse(selJson), [selJson])
  const selVersion = raw?.sourceVersion

  const [vp, setVp] = useState<Size | null>(null)
  const view = useRef<View>({ s: 1, x: 0, y: 0 })
  const mode = useRef<number | 'fit'>(tab?.viewState?.kind === 'image' ? tab.viewState.zoom : 'fit')
  const place = useRef(tab?.viewState?.kind === 'image' ? { x: tab.viewState.panX, y: tab.viewState.panY } : { x: 0.5, y: 0.5 })
  const [zoomed, setZoomed] = useState<{ s: number; fit: number; isFit: boolean } | null>(null)
  const tween = useRef(0)
  const idle = useRef<ReturnType<typeof setTimeout>>()
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()

  const write = useCallback(
    (v: View) => {
      const el = contentEl.current
      if (!el) return
      el.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.s})`
      el.style.setProperty('--z', String(v.s))
      if (!svg && v.s >= PIXELATED_AT) el.dataset.pixelated = ''
      else delete el.dataset.pixelated
      picker.current?.redraw()
    },
    [svg]
  )
  const gesture = (): void => {
    const el = contentEl.current
    if (!el) return
    el.style.willChange = 'transform'
    clearTimeout(idle.current)
    // Off at rest, so Chromium rasterizes an SVG crisp again rather than keep a scaled layer.
    idle.current = setTimeout(() => {
      if (contentEl.current) contentEl.current.style.willChange = ''
    }, GESTURE_IDLE_MS)
  }
  const zoomSay = useRef<ReturnType<typeof setTimeout>>()
  const announceZoom = (s: number, fit: number, isFit: boolean): void => {
    clearTimeout(zoomSay.current)
    const text = isFit ? `Fit, ${percent(s)}` : s === 1 && mode.current === 1 ? 'Actual size, 100%' : s >= MAX_SCALE ? `Zoom ${percent(s)}, the largest` : s <= minScale(fit) ? `Zoom ${percent(s)}, the smallest` : `Zoom ${percent(s)}`
    zoomSay.current = setTimeout(() => say(text), ANNOUNCE_MS)
  }
  /** Shows `v` and records it; `announce` for a zoom change. */
  const apply = (v: View, announce = false): void => {
    if (!box || !vp) return
    cancelAnimationFrame(tween.current)
    view.current = v
    write(v)
    place.current = centreOf(v, box, vp)
    const fit = fitScale(box, vp)
    const isFit = mode.current === 'fit'
    setZoomed((z) => (z && z.s === v.s && z.fit === fit && z.isFit === isFit ? z : { s: v.s, fit, isFit }))
    if (announce) announceZoom(v.s, fit, isFit)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      setView(handleId, tabId, { viewState: { kind: 'image', zoom: mode.current, panX: place.current.x, panY: place.current.y } })
    }, VIEW_SETTLE_MS)
  }
  const applyRef = useRef(apply)
  applyRef.current = apply

  // A pane resize keeps Fit as Fit and any other zoom on the same image point.
  useLayoutEffect(() => {
    const el = viewportEl.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => {
      const { width: w, height: h } = e.contentRect
      setVp((p) => (p && p.w === w && p.h === h ? p : { w, h }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const hides = (sel: Picked, v: View, b: Size, p: Size): boolean => {
    const at = sel?.region ? { x: sel.region.x + sel.region.w / 2, y: sel.region.y + sel.region.h / 2 } : sel?.point
    return !!at && (Math.abs(at.x * b.w * v.s + v.x - p.w / 2) > p.w / 2 || Math.abs(at.y * b.h * v.s + v.y - p.h / 2) > p.h / 2)
  }
  // A selection the view would hide, set from outside (a chip, a restore), brings the whole image back.
  const placed = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!box || !vp || !image) return
    const v = viewAt(mode.current, place.current, box, vp)
    const first = placed.current !== image.url
    placed.current = image.url
    const hidden = first && hides(selection, v, box, vp)
    if (hidden) mode.current = 'fit'
    applyRef.current(hidden ? fitView(box, vp) : v)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box, vp, image?.url])
  const emitted = useRef<Picked>(null)
  useLayoutEffect(() => {
    if (!box || !vp || !image || !selection || sameSel(selection, emitted.current) || !hides(selection, view.current, box, vp)) return
    mode.current = 'fit'
    applyRef.current(fitView(box, vp))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection])

  const zoomTo = (s: number): void => {
    if (!box || !vp) return
    const next = clampScale(s, fitScale(box, vp))
    mode.current = next
    apply(zoomAt(view.current, next, vp.w / 2, vp.h / 2, box, vp), true)
  }
  const step = (dir: 1 | -1): void => {
    if (!box || !vp) return
    const fit = fitScale(box, vp)
    const s = view.current.s
    if ((dir > 0 && s >= MAX_SCALE - 1e-6) || (dir < 0 && s <= minScale(fit) + 1e-6)) return announceZoom(s, fit, mode.current === 'fit')
    zoomTo(dir > 0 ? stepUp(s) : stepDown(s, fit))
  }
  /** Fit to Actual size from Fit, else to Fit; a pointer click animates the one large jump. */
  const toggle = (via: Via): void => {
    if (!box || !vp) return
    const toActual = mode.current === 'fit'
    mode.current = toActual ? 1 : 'fit'
    const to = toActual ? zoomAt(view.current, 1, vp.w / 2, vp.h / 2, box, vp) : fitView(box, vp)
    if (via === 'keyboard' || reducedMotion()) return apply(to, true)
    const from = view.current
    const ease = easing(cssVar('--ease-snap'))
    const dur = cssMs('--dur-base') || 220
    const t0 = performance.now()
    const el = contentEl.current
    if (el) el.style.willChange = 'transform'
    cancelAnimationFrame(tween.current)
    const frame = (now: number): void => {
      const k = ease(Math.min(1, (now - t0) / dur))
      const v = { s: from.s + (to.s - from.s) * k, x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k }
      view.current = v
      write(v)
      if (k < 1) return void (tween.current = requestAnimationFrame(frame))
      if (el) el.style.willChange = ''
      apply(to, true)
    }
    tween.current = requestAnimationFrame(frame)
  }
  const keys = useRef({ step, toggle })
  keys.current = { step, toggle }
  useEffect(
    () =>
      window.clui.onMenuAction((a) => {
        if (a === 'image-zoom-in') keys.current.step(1)
        else if (a === 'image-zoom-out') keys.current.step(-1)
        else if (a === 'image-zoom-toggle') keys.current.toggle('keyboard')
      }),
    []
  )

  const settle = (next: Shown): void => {
    setStatus(`${handleId}\0${path}`, next.t === 'missing' ? 'missing' : 'binary')
    setShown(next)
  }
  const selRef = useRef({ selection, attached: false })
  const lastLoad = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const load = useCallback(async (): Promise<void> => {
    const gen = ++loadGen.current
    lastLoad.current = Date.now()
    const r = await window.clui.imageOpen(handleId, owner, path).catch((): Refusal => ({ ok: false, reason: 'unreadable' }))
    if (gen !== loadGen.current) return
    noteRead(handleId, path, r.ok ? null : r.reason)
    const prev = shownRef.current
    const clearSel = (): void => {
      if (!selRef.current.selection) return
      const inMessage = selRef.current.attached
      captureGen.current++
      setView(handleId, tabId, { selection: undefined })
      setNotice(inMessage ? 'removed' : 'cleared')
      say(NOTICE[inMessage ? 'removed' : 'cleared'])
    }
    let next: Shown
    if (!r.ok) next = r.reason === 'missing' ? { t: 'missing' } : { t: 'error', reason: r.reason, message: REASON[r.reason] }
    else if (!r.head) next = { t: 'empty' }
    else if (!r.head.format) next = { t: 'unknown', bytes: r.size }
    else if (tooLarge(r.head) && r.head.w && r.head.h) next = { t: 'too-large', w: r.head.w, h: r.head.h, bytes: r.size }
    else if (!r.cap) next = { t: 'damaged', bytes: r.size }
    else if (prev.t === 'image' && prev.version === r.cap.version) {
      capUrl.current = r.cap.url
      return
    } else {
      const { url, version } = r.cap
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.decoding = 'async'
      img.draggable = false
      img.alt = name
      img.className = 'block h-full w-full'
      img.src = url
      const ok = await img.decode().then(
        () => true,
        () => false
      )
      if (gen !== loadGen.current) return
      // The cap serves only the bytes it was minted for, so a file that changed under the decode fails it; read again.
      if (!ok) {
        const v = await window.clui.imageVersion(handleId, path).catch(() => null)
        if (gen !== loadGen.current) return
        if (v?.ok && v.version !== version) return void load()
      }
      const format = r.head.format
      const maybe = r.head.animated && format !== 'svg' && format !== 'jpeg'
      // Under reduced motion an animated file opens on its still, so it waits for frame 0 rather than play first.
      const s = ok && maybe && reducedMotion() ? await stillOf(url, MIME[format]).catch(() => null) : null
      if (gen !== loadGen.current) return
      next = ok
        ? { t: 'image', img, url, version, bytes: r.size, natural: { w: img.naturalWidth, h: img.naturalHeight }, format, ...(r.head.orientation ? { orientation: r.head.orientation } : {}) }
        : { t: 'damaged', bytes: r.size }
      if (ok) {
        capUrl.current = url
        captureGen.current++
        if (prev.t === 'image') {
          if (prev.natural.w !== img.naturalWidth || prev.natural.h !== img.naturalHeight) mode.current = 'fit'
          clearSel()
        } else if (selRef.current.selection && selVersionRef.current && selVersionRef.current !== version) clearSel()
        setStill(s)
        if (maybe && !s && !reducedMotion())
          void stillOf(url, MIME[format])
            .catch(() => null)
            .then((x) => gen === loadGen.current && setStill(x))
      }
    }
    if (next.t !== 'image') {
      clearSel()
      setStill(null)
    }
    settle(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleId, owner, path, tabId, name])
  const selVersionRef = useRef(selVersion)
  selVersionRef.current = selVersion

  const scheduleLoad = useCallback(() => {
    if (timer.current) return
    const wait = busyRef.current ? Math.max(0, TURN_RELOAD_MS - (Date.now() - lastLoad.current)) : 0
    timer.current = setTimeout(() => {
      timer.current = null
      void load()
    }, wait)
  }, [load])
  const busyRef = useRef(busy)
  busyRef.current = busy

  useEffect(() => {
    const t = setTimeout(() => setSlow(true), SKELETON_MS)
    void load().finally(() => clearTimeout(t))
    return () => {
      clearTimeout(t)
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
    }
  }, [load])
  useEffect(
    () => () => {
      loadGen.current++
      captureGen.current++
      clearTimeout(saveTimer.current)
      clearTimeout(idle.current)
      clearTimeout(zoomSay.current)
      cancelAnimationFrame(tween.current)
      setStatus(`${handleId}\0${path}`, null)
      void window.clui.imageCapsRevoke(handleId, owner)
    },
    [handleId, owner, path]
  )

  // Watched while shown; watch events are hints, so focus reconciles too.
  useEffect(() => {
    let id: string | null = null
    let live = true
    const off = window.clui.onFileChanged((e) => {
      if (e.handleId === handleId && e.id === id) scheduleLoad()
    })
    void window.clui.watchFile(handleId, path).then((w) => {
      if (!w.ok) return
      if (live) id = w.id
      else void window.clui.unwatchFile(handleId, w.id)
    })
    window.addEventListener('focus', scheduleLoad)
    return () => {
      live = false
      off()
      window.removeEventListener('focus', scheduleLoad)
      if (id) void window.clui.unwatchFile(handleId, id)
    }
  }, [handleId, path, watchGen, scheduleLoad])
  useEffect(() => {
    if (shown.t !== 'missing') return
    const t = setInterval(() => {
      void window.clui.statFile(handleId, path).then((s) => {
        if (!s.ok) return
        void load()
        setWatchGen((n) => n + 1)
      })
    }, MISSING_POLL_MS)
    return () => clearInterval(t)
  }, [shown.t, handleId, path, load])
  const reopen = (): void => {
    void load()
    setWatchGen((n) => n + 1)
  }

  // The decoded element goes into the content box as is, so what the user sees is what a crop draws from.
  const showStill = animated && !playing
  useLayoutEffect(() => {
    const host = hostEl.current
    if (!host) return
    const el: HTMLElement | null = showStill ? (still?.canvas ?? null) : (image?.img ?? null)
    if (!el) return void host.replaceChildren()
    if (el instanceof HTMLCanvasElement) {
      el.className = 'block h-full w-full'
      el.setAttribute('role', 'img')
      el.setAttribute('aria-label', name)
    }
    host.replaceChildren(el)
  }, [showStill, still, image, name])

  const sel = image ? selection : null
  const input = useMemo<RefInput | null>(() => {
    if (!image || !sel) return null
    return {
      kind: 'image',
      path,
      sourceVersion: image.version,
      size: { w: image.natural.w, h: image.natural.h },
      ...(sel.region ? { region: sel.region } : { point: sel.point }),
      ...(animated ? { frame: 0 as const } : {}),
      ...(image.orientation ? { orientation: image.orientation } : {})
    }
  }, [image, sel, path, animated])
  const key = input ? refKey(input) : null
  const isThis = (d: DraftReference): boolean => !!key && refKey(d.ref) === key
  const attached = useActive((s) => !!s && !!key && [s.contextRefs, ...s.queuedMessages.map((q) => q.refs)].some((l) => l.some(isThis)))
  const inTarget = useActive((s) => !!s && !!key && !!refsOf(s, s.referenceEditTarget)?.some(isThis))
  selRef.current = { selection, attached }
  // The store clears the selection as it removes its stale reference, so both going at once means the change reached
  // it before this tab's own read.
  const refsHere = useActive((s) => (s ? [s.contextRefs, ...s.queuedMessages.map((q) => q.refs)].flat().filter(({ ref: r }) => r.kind === 'image' && r.path === path).length : 0))
  const prevHere = useRef({ selection, refsHere })
  useEffect(() => {
    const prev = prevHere.current
    prevHere.current = { selection, refsHere }
    if (prev.selection && !selection && refsHere < prev.refsHere) setNotice('removed')
  }, [selection, refsHere])

  const pointing = usePointing(tabId)
  const asked = usePointRequest(tabId)
  const selSay = useRef<ReturnType<typeof setTimeout>>()
  const stopOnFirst = (): void => {
    if (animated && playing) setPlaying(false)
  }
  const setSelection = (next: Picked): void => {
    if (!image || sameSel(next, sel)) return
    emitted.current = next
    captureGen.current++
    setAdding(false)
    setNotice(null)
    if (next) stopOnFirst()
    setView(handleId, tabId, { selection: next ? { ...next, sourceVersion: image.version } : undefined, highlight: undefined })
  }
  useEffect(() => setPointBlocked(tabId, shown.t === 'loading' || image ? null : NO_IMAGE), [tabId, shown.t, image])
  useEffect(() => () => setPointBlocked(tabId, null), [tabId])
  useLayoutEffect(() => {
    if (!asked || shown.t === 'loading' || !takePoint(tabId)) return
    if (pointing) {
      setPointing(tabId, false)
      clearTimeout(selSay.current)
      return say(POINT_OFF)
    }
    if (!image) return say(NO_IMAGE)
    setPointing(tabId, true)
    stopOnFirst()
    viewportEl.current?.focus({ preventScroll: true })
    say(POINTING_SAID)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, shown.t, image])
  useEffect(() => () => setPointing(tabId, false), [tabId])
  useEffect(() => {
    if (!image && pointing) setPointing(tabId, false)
  }, [image, pointing, tabId])

  const px = input?.kind === 'image' ? imagePx(input) : null
  const first = animated ? ' on the first frame' : ''
  const barLabel = !px
    ? ''
    : px.w === undefined
      ? `Point ${px.x}, ${px.y}${first} selected`
      : `Region ${px.w}×${px.h} at ${px.x}, ${px.y}${first} selected${picture ? ' · with picture' : ''}`
  const spoken = !px ? '' : px.w === undefined ? `Point ${px.x}, ${px.y}${first} selected` : `Region ${px.w} by ${px.h} at ${px.x}, ${px.y}${first} selected`
  const hadSel = useRef(false)
  useEffect(() => {
    if (!spoken && !hadSel.current) return
    hadSel.current = !!spoken
    const t = (selSay.current = setTimeout(() => say(spoken || 'Selection cleared'), ANNOUNCE_MS))
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spoken])

  const add = async (): Promise<void> => {
    if (!image || !input || input.kind !== 'image') return
    clearTimeout(selSay.current)
    const gen = ++captureGen.current
    setAdding(true)
    const v = await window.clui.imageVersion(handleId, path).catch(() => null)
    if (gen !== captureGen.current) return
    setAdding(false)
    if (!v?.ok || v.version !== input.sourceVersion || input.size.w !== image.natural.w || input.size.h !== image.natural.h) {
      setView(handleId, tabId, { selection: undefined })
      setNotice('cleared')
      say(NOTICE.cleared)
      return scheduleLoad()
    }
    // An animated image's reference is to frame 0, whichever frame is playing.
    const visual = input.region && picture ? cropOf(still ? still.canvas : image.img, image.natural, input.region, svg) : null
    addFromSurface(handleId, input, say, visual ? { visual } : undefined)
  }
  const addRef = useRef(add)
  addRef.current = add

  const space = useRef(false)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [grabbing, setGrabbing] = useState(false)
  const latest = useRef({ box, vp, pointing })
  latest.current = { box, vp, pointing }
  useEffect(() => {
    const el = viewportEl.current
    if (!el) return
    let drag: { id: number; sx: number; sy: number; v: View } | null = null
    const over = (): { x: boolean; y: boolean } | null => {
      const { box, vp } = latest.current
      return box && vp ? overflows(view.current, box, vp) : null
    }
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0 || (latest.current.pointing && !space.current)) return
      const o = over()
      if (!o || (!o.x && !o.y)) return
      e.preventDefault()
      el.setPointerCapture(e.pointerId)
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, v: view.current }
      setGrabbing(true)
      gesture()
    }
    const onMove = (e: PointerEvent): void => {
      const { box, vp } = latest.current
      if (!drag || e.pointerId !== drag.id || !box || !vp) return
      gesture()
      applyRef.current(clampView({ s: drag.v.s, x: drag.v.x + e.clientX - drag.sx, y: drag.v.y + e.clientY - drag.sy }, box, vp))
    }
    const onUp = (e: PointerEvent): void => {
      if (!drag || e.pointerId !== drag.id) return
      drag = null
      setGrabbing(false)
    }
    const onWheel = (e: WheelEvent): void => {
      const { box, vp } = latest.current
      if (!box || !vp) return
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        gesture()
        const r = el.getBoundingClientRect()
        const fit = fitScale(box, vp)
        const s = clampScale(view.current.s * Math.exp(-e.deltaY * 0.01), fit)
        mode.current = s
        applyRef.current(zoomAt(view.current, s, e.clientX - r.left, e.clientY - r.top, box, vp), true)
        return
      }
      const o = overflows(view.current, box, vp)
      if (!o.x && !o.y) return
      e.preventDefault()
      gesture()
      const v = view.current
      applyRef.current(clampView({ s: v.s, x: v.x - (o.x ? e.deltaX : 0), y: v.y - (o.y ? e.deltaY : 0) }, box, vp))
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.target !== el) return
      if (e.key === ' ') {
        e.preventDefault()
        if (!space.current) setSpaceHeld((space.current = true))
        return
      }
      const dir = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key]
      const { box, vp } = latest.current
      if (!dir || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey || !box || !vp) return
      const o = overflows(view.current, box, vp)
      if (!(dir[0] && o.x) && !(dir[1] && o.y)) return
      e.preventDefault()
      const v = view.current
      applyRef.current(clampView({ s: v.s, x: v.x + dir[0] * ARROW_PX, y: v.y + dir[1] * ARROW_PX }, box, vp))
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === ' ' && space.current) setSpaceHeld((space.current = false))
    }
    const onBlur = (): void => {
      if (space.current) setSpaceHeld((space.current = false))
    }
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('keydown', onKey)
    el.addEventListener('keyup', onKeyUp)
    el.addEventListener('blur', onBlur)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('keydown', onKey)
      el.removeEventListener('keyup', onKeyUp)
      el.removeEventListener('blur', onBlur)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A user open focuses whatever the open settles into: the image, else the state's first action.
  useEffect(() => {
    if (shown.t === 'loading') return
    const via = takeSurfaceFocus(tabId)
    if (!via) return
    const el = image ? viewportEl.current : (stateEl.current?.querySelector<HTMLElement>('button') ?? viewportEl.current)
    // TypeScript's DOM lib doesn't declare focusVisible yet; Chromium takes it.
    const opts: FocusOptions & { focusVisible?: boolean } = { preventScroll: true, focusVisible: via === 'keyboard' }
    el?.focus(opts)
  }, [shown.t, image, tabId])

  const togglePlay = (): void => {
    const next = !playing
    // A new URL, so the animation is fetched again and restarts at frame 0; the cap reads only the path.
    if (next && image) image.img.src = `${capUrl.current}?play=${Date.now()}`
    setPlaying(next)
    say(next ? 'Playing animation' : 'Stopped on the first frame')
  }

  const openApp = (): void => void openDefault(handleId, path)
  const bytes = 'bytes' in shown ? shown.bytes : null
  const readout = image
    ? [`${image.natural.w}×${image.natural.h}`, density > 1 && `@${density}x`, still && `${still.frames} frames`, fileSize(image.bytes)].filter(Boolean).join(' · ')
    : shown.t === 'too-large'
      ? `${shown.w}×${shown.h} · ${fileSize(shown.bytes)}`
      : bytes !== null
        ? fileSize(bytes)
        : ''
  const z = zoomed
  const atMin = !!z && z.s <= minScale(z.fit) + 1e-6
  const atMax = !!z && z.s >= MAX_SCALE - 1e-6
  const actualIsFit = !!z && z.isFit && Math.abs(z.fit - 1) < 1e-6
  const toggleLabel = z?.isFit ? 'Actual size' : 'Fit'
  const o = box && vp && z ? overflows(view.current, box, vp) : { x: false, y: false }
  const canPan = o.x || o.y
  const description = image ? `${image.natural.w} by ${image.natural.h} pixels.${still ? ` Animated, ${still.frames} frames.` : ''}` : undefined

  const state = ((): JSX.Element | null => {
    if (shown.t === 'loading') return slow ? <p className="text-meta text-dim">{`Loading ${name}`}</p> : null
    if (shown.t === 'image') return null
    const head = (title: string, body?: string): JSX.Element => (
      <>
        <p className="text-ui font-medium text-content">{title}</p>
        {body && <p className="max-w-[60ch] text-meta text-dim">{body}</p>}
      </>
    )
    const app = (
      <Button variant="secondary" size="sm" onClick={openApp}>
        Open in default app
      </Button>
    )
    switch (shown.t) {
      case 'empty':
        return head(`${name} is empty`)
      case 'damaged':
        return (
          <>
            {head(`Couldn't show ${name}`, 'The image data is damaged or incomplete.')}
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => void load()}>
                Try again
              </Button>
              {app}
            </div>
          </>
        )
      case 'unknown':
        return (
          <>
            {head(`Clui can't show ${name}`, "Its contents aren't a PNG, JPEG, GIF, WebP, AVIF or SVG image.")}
            <div className="flex gap-2">
              {app}
              {isSvg(path) ? (
                <Button variant="secondary" size="sm" onClick={() => setView(handleId, tabId, { mode: 'source' })}>
                  Show source
                </Button>
              ) : null}
            </div>
          </>
        )
      case 'too-large':
        return (
          <>
            {head(`${name} is too large to show here`, `It's ${shown.w}×${shown.h}, ${Math.round((shown.w * shown.h) / 1e5) / 10} megapixels. Clui shows images up to ${MAX_PIXELS / 1e6} megapixels.`)}
            <div className="flex gap-2">{app}</div>
          </>
        )
      default: {
        if (shown.t === 'error' && shown.reason === 'too-large')
          return (
            <>
              {head(`${name} is too large to show here`, TOO_MANY_BYTES)}
              <div className="flex gap-2">{app}</div>
            </>
          )
        const doc: Doc = shown.t === 'missing' ? { t: 'missing' } : { t: 'error', reason: shown.reason, message: shown.message }
        return <DocState handleId={handleId} tabId={tabId} path={path} doc={doc} load={load} reopen={reopen} />
      }
    }
  })()

  const cursor = pointing && !spaceHeld ? 'cursor-crosshair' : canPan ? (grabbing ? 'cursor-grabbing' : 'cursor-grab') : ''
  return (
    <div data-ui="image-surface" className="flex h-full min-h-0 flex-col bg-bg pt-(--top-h)">
      <div data-ui="image-toolbar" className="flex min-h-9 shrink-0 flex-wrap items-center gap-1 border-b border-border px-1">
        <span data-ui="image-readout" title={readout} className="min-w-0 flex-1 truncate px-2 text-label tabular-nums text-dim">
          {readout}
        </span>
        {image && z && (
          <div className="flex shrink-0 items-center gap-0.5">
            {still && (
              <button
                type="button"
                data-ui="image-play"
                aria-label={playing ? 'Stop animation' : 'Play animation'}
                title={playing ? 'Stop animation. Shows the first frame.' : 'Play animation'}
                onClick={togglePlay}
                className={PANE_BTN}
              >
                {playing ? <IconStop className="h-4 w-4" /> : <IconPlay className="h-4 w-4" />}
              </button>
            )}
            <ZoomGroup s={z.s} atMin={atMin} atMax={atMax} max={MAX_SCALE} onStep={step}>
              <button
                type="button"
                data-ui="image-fit"
                aria-disabled={actualIsFit || undefined}
                title={actualIsFit ? 'Already at actual size.' : `${toggleLabel} ⌘0`}
                onClick={(e: ReactMouseEvent) => !actualIsFit && toggle(viaOf(e))}
                className={`${TEXT_BUTTON} ${DISABLED_BTN}`}
              >
                {toggleLabel}
              </button>
            </ZoomGroup>
          </div>
        )}
      </div>
      <PreviewPointed handleId={handleId} tabId={tabId} />
      <div
        ref={viewportEl}
        role="region"
        aria-label={`${name}, preview`}
        aria-description={description}
        aria-busy={shown.t === 'loading' || undefined}
        aria-keyshortcuts="Meta+Shift+A Meta+Equal Meta+Minus Meta+0"
        tabIndex={0}
        data-ui="image-viewport"
        data-beside-header=""
        data-pointing={pointing || undefined}
        {...(shown.t === 'loading' ? {} : { 'data-pane-title': '' })}
        className={`image-viewport relative min-h-0 flex-1 touch-none select-none overflow-hidden bg-bg focus-visible:outline-none ${cursor}`}
      >
        {image && box && (
          <div
            ref={contentEl}
            data-ui="image-content"
            data-checker={image.format === 'jpeg' ? undefined : ''}
            className="image-content absolute left-0 top-0 origin-top-left"
            style={{ width: box.w, height: box.h }}
          >
            <div ref={hostEl} className="h-full w-full" />
          </div>
        )}
        {image && box && (
          <RegionPicker
            ref={picker}
            viewport={viewportEl}
            content={contentEl}
            basis={image.natural}
            selection={sel}
            pointing={pointing}
            onChange={setSelection}
            onAdd={() => void addRef.current()}
            onEnd={() => {
              setPointing(tabId, false)
              clearTimeout(selSay.current)
              say(POINT_OFF)
            }}
            panning={() => space.current}
          />
        )}
        {state && (
          <div ref={stateEl} className={STATE_BODY}>
            {state}
          </div>
        )}
      </div>
      {notice && <SelectionNotice notice={notice} copy={NOTICE} onDismiss={() => setNotice(null)} />}
      {image && sel ? (
        <SelectionBar label={barLabel} attached={inTarget} onAdd={() => void add()} busy={adding} />
      ) : image && pointing ? (
        <SelectionBar label={POINT_HINT} blocked={POINT_HINT} onBlocked={() => say(POINT_HINT)} attached={false} onAdd={() => {}} />
      ) : null}
      <span data-ui="image-live" className="sr-only" aria-live="polite">
        {said}
      </span>
    </div>
  )
}
