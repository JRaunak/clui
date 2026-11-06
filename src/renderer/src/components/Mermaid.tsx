import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent
} from 'react'
import {
  cached,
  cancel,
  contrast,
  enqueue,
  familyOf,
  hexOf,
  labelsIn,
  pageInkOn,
  themeNow,
  tokensFor,
  typeahead,
  typedAfter,
  typeName,
  wireLabels,
  wirePart,
  type Box,
  type Drawn,
  type Failure,
  type Job,
  type LabelCandidate,
  type Outcome,
  type Theme,
  type Tokens
} from '../lib/mermaid'
import { meets, parseSpan, type Span } from '../lib/markdownDoc'
import { viaOf, type Via } from '../lib/motion'
import { cropOf } from '../lib/imageView'
import { reportFound, type Found } from '../lib/pointedText'
import { useSettings } from '../lib/settings'
import { areaSelectedText, areaSpoken, diagramBlocked, PARTS_NOTICE, partOption, partsSelectedText } from '../lib/refCopy'
import { partPhrase, refKey, type DiagramLabel, type DiagramPart, type DraftReference, type DraftVisual, type RefInput } from '../../../shared/context'
import type { Region } from '../../../shared/surfaces'
import { refsOf, useActive, useSession } from '../store'
import { addFromSurface } from './ContextChips'
import { PointedRow } from './Markdown'
import { RegionPicker, type PickerHandle } from './surfaces/RegionPicker'
import { ANNOUNCE_MS, SelectionBar } from './surfaces/SelectionBar'
import { SelectionNotice, SKELETON_MS, STATE_BODY, TEXT_BTN } from './surfaces/fileDoc'

/** What a diagram selection sends, before its file and version: the diagram's block, its type and what's in it. */
export type DiagramBody = { lines: Span; type: string; parts: DiagramPart[]; labels?: undefined } | { lines: Span; type: string; labels: DiagramLabel[]; parts?: undefined }
/** A diagram's part or area selection as the host's bar shows and adds it. `spoken` is empty while a marquee drags. */
export interface DiagramOffer {
  body: DiagramBody
  label: string
  spoken: string
  crop: () => Promise<DraftVisual | null>
}
type How = 'one' | 'toggle' | 'set'

/** What a diagram needs from the surface around it: the selection and Claude's highlight, and the ways to change them. */
export interface DiagramHost {
  selection: Span | null
  pointed: Span | null
  pick: (lines: Span, shift: boolean) => void
  viewSource: (line: number, via: Via) => void
  /** Each diagram's last drawing by its first line, which outlives the remount an edit in its fence causes. */
  held: Map<number, Shown>
  /** The block of the diagram holding a part or area selection, with its part keys or its region. */
  owner: Span | null
  parts: string[] | null
  region: Region | null
  /** Claude's ids, and in a Markdown file the line that picks their diagram. */
  pointedParts: string[] | null
  pointedAt: number | null
  pickParts: (owner: Span, keys: string[], how: How) => void
  pickRegion: (owner: Span, r: Region | null) => void
  /** None of the selected parts survived a redraw. */
  partsLost: () => void
  offer: (firstLine: number, o: DiagramOffer | null) => void
  add: () => void
  report: (found: Found) => void
  /** Escape the area picker didn't need. */
  escape: () => void
}
type Shown = { key: string; out: Outcome }
export const DiagramContext = createContext<DiagramHost | null>(null)

const subscribeTheme = (cb: () => void): (() => void) => {
  const o = new MutationObserver(cb)
  o.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => o.disconnect()
}
const useTheme = (): Theme => useSyncExternalStore(subscribeTheme, themeNow)

// Under 24px at the drawn scale a node is too small a target; its click selects what encloses it, or the diagram.
const MIN_TARGET = 24
const DRAG_PX = 4
// The crop's margin round the selected parts, in the drawing's own units.
const CROP_PAD = 16
const SVG_NS = 'http://www.w3.org/2000/svg'
const HEADLINE = 'text-ui font-medium text-content'
const BOX = 'rounded-md border border-border bg-tool px-3 py-2'
// Styled as Markdown's gutter number.
const NUM = 'absolute -left-(--gut) w-(--gut) min-h-6 cursor-default select-none pr-2 text-right text-meta leading-6 tabular-nums text-faint pointer-fine:hover:text-content'
const AREA_DESCRIPTION = 'Shift and an arrow key draws an area, Option and an arrow key moves it. Enter adds it to the message.'
const PARTS_DESCRIPTION = 'Arrow keys move between parts. Space selects one, Enter adds the selection to the message.'

function detailOf(why: Failure, line: number): string | null {
  switch (why.t) {
    case 'parse':
      return `Mermaid stopped at line ${line}.`
    case 'type':
      return "The first line doesn't name a diagram type Mermaid knows, such as flowchart or sequenceDiagram."
    case 'size':
      return 'This diagram is over 50,000 characters, the most Mermaid draws.'
    case 'edges':
      return 'This diagram has over 500 links, the most Mermaid draws.'
    case 'other':
      return why.message
    case 'load':
      return null
  }
}

const boxy = (key: string): boolean => /^[ngpt]:/.test(key)
const seqId = (el: Element): string | null => /^i(\d+)$/.exec(el.getAttribute('data-id') ?? '')?.[1] ?? null
const union = (rs: DOMRect[]): DOMRect | null =>
  rs.length ? rs.reduce((a, r) => DOMRect.fromRect({ x: Math.min(a.left, r.left), y: Math.min(a.top, r.top), width: Math.max(a.right, r.right) - Math.min(a.left, r.left), height: Math.max(a.bottom, r.bottom) - Math.min(a.top, r.top) })) : null
const within = (r: DOMRect, x: number, y: number): boolean => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom

/**
 * Marks each drawn element that resolves to exactly one part with `data-part`, by the db's ids and never by splitting
 * a compound id, and clones a wide transparent hit corridor after each link, message and block border. Returns each
 * part's own elements, corridors excluded.
 */
function bindParts(svg: SVGSVGElement, d: Drawn): Map<string, Element[]> {
  for (const x of svg.querySelectorAll('[data-hit]')) x.remove()
  const out = new Map<string, Element[]>()
  if (!d.parts) return out
  const keys = new Set(d.parts.map((p) => p.key))
  const tag = (el: Element, key: string | null): void => {
    if (!key || !keys.has(key)) return el.removeAttribute('data-part')
    el.setAttribute('data-part', key)
    out.set(key, [...(out.get(key) ?? []), el])
  }
  const all = (sel: string): Element[] => [...svg.querySelectorAll(sel)]
  const family = familyOf(d.type)
  if (family === 'sequence') {
    for (const el of all('[data-et="participant"][data-id], line[data-et="life-line"][data-id]')) tag(el, `p:${el.getAttribute('data-id')}`)
    // Mermaid tags only the header box, so a footer takes the participant of the lifeline nearest its centre. Nearest
    // rather than equal: a boundary's and a collection's boxes sit off their lifelines (16px and 3px in Mermaid 12.2).
    const lives = all('line[data-et="life-line"][data-id]').map((l) => {
      const r = l.getBoundingClientRect()
      return { id: l.getAttribute('data-id'), x: r.left + r.width / 2 }
    })
    for (const g of new Set(all('.actor-bottom').map((el) => el.closest('g')))) {
      const r = g?.getBoundingClientRect()
      // An undrawn footer measures zero and would land on the first lifeline.
      if (!g || !r?.width || !lives.length) continue
      const x = r.left + r.width / 2
      const near = lives.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a))
      g.setAttribute('data-et', 'participant')
      tag(g, `p:${near.id}`)
    }
    const messages = all('[data-et="message"][data-id]')
    for (const el of messages) tag(el, seqId(el) && `m:${seqId(el)}`)
    for (const el of all('[data-et="note"][data-id]')) tag(el, seqId(el) && `t:${seqId(el)}`)
    const texts = all('text.messageText')
    if (texts.length === messages.length) texts.forEach((t, i) => tag(t, messages[i].getAttribute('data-part')))
    for (const el of all('g[data-et="control-structure"][data-id]')) tag(el, seqId(el) && `b:${seqId(el)}`)
  } else {
    const prefix = `${d.id}-${family === 'flowchart' ? 'flowchart-' : family === 'class' ? 'classId-' : family === 'state' ? 'state-' : 'entity-'}`
    for (const g of all('g.node[id]')) tag(g, g.id.startsWith(prefix) ? `n:${g.id.slice(prefix.length).replace(/-\d+$/, '')}` : null)
    if (family === 'state') for (const g of all('g.statediagram-cluster[data-id]')) tag(g, `g:${g.getAttribute('data-id')}`)
    else for (const g of all('g.cluster[id]')) tag(g, g.id.startsWith(`${d.id}-`) ? `g:${g.id.slice(d.id.length + 1)}` : null)
    for (const el of all('path[data-edge][data-id]')) tag(el, `e:${el.getAttribute('data-id')}`)
    for (const g of all('g.edgeLabel')) {
      const id = g.querySelector(':scope > g.label[data-id]')?.getAttribute('data-id')
      if (id) tag(g, `e:${id}`)
    }
  }
  const corridor = (el: Element, key: string): void => {
    const c = document.createElementNS(SVG_NS, el.localName)
    for (const a of ['d', 'x1', 'y1', 'x2', 'y2']) {
      const v = el.getAttribute(a)
      if (v !== null) c.setAttribute(a, v)
    }
    c.setAttribute('data-hit', '')
    c.setAttribute('data-part', key)
    c.setAttribute('aria-hidden', 'true')
    el.after(c)
  }
  for (const el of all('path[data-edge][data-part], line[data-et="message"][data-part]')) corridor(el, el.getAttribute('data-part')!)
  for (const g of all('g[data-et="control-structure"][data-part]')) for (const l of g.querySelectorAll('line.loopLine')) corridor(l, g.getAttribute('data-part')!)
  return out
}

/**
 * Mermaid draws edge labels outside their subgraph's group, so each one's chip is matched to the innermost cluster
 * under its centre and takes the fill painted there (`--seat`), when a label reads on that fill in either ink.
 * Returns each seated label's cluster, whose marks the chip then mirrors.
 */
function seatEdgeLabels(svg: SVGSVGElement, t: Tokens): Map<SVGGElement, Element> {
  const out = new Map<SVGGElement, Element>()
  const labels = [...svg.querySelectorAll<SVGGElement>('g.edgeLabel')]
  for (const g of labels) {
    for (const a of ['data-seat', 'data-seat-mark', 'data-ink']) g.removeAttribute(a)
    g.style.removeProperty('--seat')
  }
  const clusters = [...svg.querySelectorAll('g.cluster, g.statediagram-cluster')]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter((c) => c.r.width)
  if (!clusters.length) return out
  const holds = (r: DOMRect, x: number, y: number): boolean => r.left <= x && x <= r.right && r.top <= y && y <= r.bottom
  for (const g of labels) {
    if (!g.querySelector('rect.background')) continue
    const r = g.getBoundingClientRect()
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    const seat = clusters.filter((c) => holds(c.r, x, y)).sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height)[0]
    if (!seat) continue
    // The last shape under the centre paints on top: a state composite's inner rect over its outer one.
    const shape = [...seat.el.querySelectorAll(':is(rect, polygon, path):not(.label *, .cluster-label *)')]
      .filter((s) => holds(s.getBoundingClientRect(), x, y))
      .at(-1)
    const cs = shape && getComputedStyle(shape)
    if (!cs || cs.fill === 'none' || cs.fill.startsWith('url') || cs.fillOpacity !== '1' || /rgba|\//.test(cs.fill)) continue
    const fill = hexOf(cs.fill)
    const ink = contrast(t.content, fill) < 4.5
    // A page chip on a fill neither ink reads on beats an illegible label.
    if (ink && !(pageInkOn(fill, t.content, t.bg) && contrast(t.bg, fill) >= 4.5)) continue
    g.setAttribute('data-seat', '')
    g.toggleAttribute('data-ink', ink)
    g.style.setProperty('--seat', fill)
    out.set(g, seat.el)
  }
  return out
}

/** The drawing's visible labels as candidates for an area, boxes from the SVG's top left. */
function candidates(svg: SVGSVGElement): LabelCandidate[] {
  const at = svg.getBoundingClientRect()
  return [...svg.querySelectorAll('text, foreignObject')]
    .filter((el) => !el.closest('defs, marker, title, desc'))
    .map((el) => {
      const tspans = [...el.children].filter((c) => c.localName === 'tspan')
      const text = tspans.length ? tspans.map((t) => t.textContent ?? '').join(' ') : (el.textContent ?? '')
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return { text, x: r.left - at.left, y: r.top - at.top, w: r.width, h: r.height, shown: cs.display !== 'none' && cs.visibility === 'visible' && cs.opacity !== '0' }
    })
}

/** Mermaid's drawing of `region` (0 to 1 of the viewBox), without Clui's marks or corridors: what the user saw drawn. */
async function picture(svg: SVGSVGElement, region: Region): Promise<DraftVisual | null> {
  const vb = svg.viewBox.baseVal
  if (!vb?.width || !vb.height) return null
  const copy = svg.cloneNode(true) as SVGSVGElement
  for (const x of copy.querySelectorAll('[data-hit]')) x.remove()
  copy.setAttribute('xmlns', SVG_NS)
  copy.setAttribute('width', String(vb.width))
  copy.setAttribute('height', String(vb.height))
  const img = new Image()
  // The renderer's CSP allows data: images, not blob: ones.
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`
  try {
    await img.decode()
    return cropOf(img, { w: vb.width, h: vb.height }, region, true)
  } catch {
    return null
  }
}

/**
 * One Mermaid diagram, drawn in the document's ink: in a Markdown fence, or as a `.mmd` file's whole Preview when
 * `name` is set. `firstLine` is the file line of the diagram's first line, so every line it reports is the file's.
 * On a type with stable ids its parts are selectable, by pointer or by its parts listbox; on the rest a drag draws an
 * area.
 */
export function MermaidDiagram({
  code,
  firstLine,
  lastLine,
  name,
  onState
}: {
  code: string
  firstLine: number
  lastLine: number
  name?: string
  onState?: (s: 'pending' | 'drawn' | 'failed', mode: 'parts' | 'area' | null) => void
}): JSX.Element {
  const host = useContext(DiagramContext)
  const theme = useTheme()
  const key = `${theme}\0${code}`
  const [shown, setShown] = useState<Shown | null>(() => {
    const hit = cached(code, theme)
    return hit ? { key, out: hit } : (host?.held.get(firstLine) ?? null)
  })
  useEffect(() => {
    if (shown) host?.held.set(firstLine, shown)
  }, [shown, host, firstLine])
  const [slow, setSlow] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const near = useRef(false)
  const job = useRef<Job | null>(null)
  const [hot, setHot] = useState<{ key: string | null; el: Element; line: number | null; top: number } | null>(null)

  useEffect(() => {
    const el = root.current
    if (!el) return
    const io = new IntersectionObserver(
      (es) => {
        near.current = es.some((e) => e.isIntersecting)
        if (job.current) job.current.near = near.current
      },
      { rootMargin: '100%' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  // The drawing on screen stays until its replacement is ready, so a theme change or an edit never blanks it.
  useEffect(() => {
    const hit = cached(code, theme)
    if (hit) return setShown({ key, out: hit })
    setSlow(false)
    const t = setTimeout(() => setSlow(true), SKELETON_MS)
    const j = (job.current = enqueue(code, theme, near.current, (out) => setShown({ key, out })))
    return () => {
      clearTimeout(t)
      cancel(j)
      if (job.current === j) job.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt])

  const out = shown?.out ?? null
  const drawn = out?.ok ? out.drawn : null
  const state = !out ? 'pending' : out.ok ? 'drawn' : 'failed'
  // A drawing held through an edit shows text that no longer matches, so it can't be pointed at; one held through a
  // theme change can, since its parts are the same.
  const current = !!shown && shown.key.slice(shown.key.indexOf('\0') + 1) === code
  const mode = drawn && current && host ? (drawn.parts ? 'parts' : 'area') : null
  useEffect(() => void onState?.(state, mode), [state, mode, onState])

  const table = useMemo(() => new Map((drawn?.parts ?? []).map((p) => [p.key, p])), [drawn])

  const svgHost = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const els = useRef<Map<string, Element[]>>(new Map())
  const seats = useRef<Map<SVGGElement, Element>>(new Map())
  const [view, setView] = useState<{ width: number; height: number; label: string } | null>(null)
  useLayoutEffect(() => {
    const svg = svgHost.current?.querySelector('svg')
    svgRef.current = svg ?? null
    if (!drawn || !svg) return
    const title = svg.querySelector(':scope > title')?.textContent?.trim()
    const desc = svg.querySelector(':scope > desc')?.textContent?.trim()
    svg.setAttribute('role', 'img')
    svg.removeAttribute('aria-roledescription')
    svg.removeAttribute('aria-labelledby')
    svg.removeAttribute('aria-describedby')
    svg.setAttribute('aria-label', title || typeName(drawn.type))
    svg.setAttribute('aria-description', desc || `Drawn from lines ${firstLine} to ${lastLine}. Show source to read its text.`)
    const prefix = `${drawn.id}-flowchart-`
    for (const g of svg.querySelectorAll<SVGGElement>('g.node[id]')) {
      const at = g.id.startsWith(prefix) ? drawn.nodes.get(g.id.slice(prefix.length).replace(/-\d+$/, '')) : undefined
      if (at === undefined) delete g.dataset.line
      else g.dataset.line = String(firstLine + at)
    }
    els.current = bindParts(svg, drawn)
    for (const [k, list] of els.current) {
      const p = table.get(k)
      const at = p?.line ?? p?.lines?.start
      if (at !== undefined) for (const el of list) (el as SVGElement).dataset.line = String(firstLine + at)
    }
    const t = tokensFor(theme)
    // A drawing held through a theme change has the old theme's colours, which would all read as an author's.
    const themed = !!shown?.key.startsWith(`${theme}\0`)
    for (const g of themed ? svg.querySelectorAll<SVGGElement>('g.node, g.cluster') : []) {
      const shape = g.querySelector(':is(rect, polygon, path, circle, ellipse):not(.label *, .cluster-label *)')
      const label = [...g.querySelectorAll('text, tspan')].findLast((x) => x.textContent?.trim())
      const fill = shape ? getComputedStyle(shape).fill : 'none'
      // An author's fill or stroke outranks Clui's node marks, so those nodes are marked another way.
      if (shape && g.matches('.node')) g.toggleAttribute('data-authored', hexOf(fill) !== t.bg || hexOf(getComputedStyle(shape).stroke) !== t.dim)
      if (!label || fill === 'none' || fill.startsWith('url')) continue
      // An author's own text colour is theirs to keep, even where it fails.
      if (hexOf(getComputedStyle(label).fill) !== t.content) continue
      g.toggleAttribute('data-ink', pageInkOn(hexOf(fill), t.content, t.bg))
    }
    seats.current = themed ? seatEdgeLabels(svg, t) : new Map()
    const vb = svg.viewBox.baseVal
    const width = vb?.width || parseFloat(svg.getAttribute('width') ?? '') || 0
    setView(width ? { width, height: vb?.height || 0, label: title || typeName(drawn.type) } : null)
    setHot(null)
  }, [drawn, firstLine, lastLine, theme])

  const whole = (): Span | null => parseSpan(root.current?.closest<HTMLElement>('[data-src]')?.dataset.src)
  const owns = !!host?.owner && host.owner.start <= firstLine && firstLine <= host.owner.end
  const keys = owns && mode === 'parts' ? host.parts : null
  const region = owns && mode === 'area' ? host.region : null
  const pointedIds = host?.pointedParts && (host.pointedAt === null || (firstLine - 1 <= host.pointedAt && host.pointedAt <= lastLine + 1)) ? host.pointedParts : null
  const pointedLines = host?.pointed ?? null
  const selection = host?.selection ?? null

  // Claude's ids name nodes, groups and participants; its lines mark whatever a line proves, and a block it covers.
  const pointedKeys = useMemo(() => {
    const out = new Set<string>()
    for (const id of pointedIds ?? []) for (const k of [`n:${id}`, `g:${id}`, `p:${id}`]) if (table.has(k)) out.add(k)
    if (pointedLines)
      for (const p of table.values()) {
        const l = p.line !== undefined ? firstLine + p.line : null
        if ((l !== null && pointedLines.start <= l && l <= pointedLines.end) || (p.lines && pointedLines.start <= firstLine + p.lines.start && firstLine + p.lines.end <= pointedLines.end)) out.add(p.key)
      }
    return out
  }, [pointedIds, pointedLines, table, firstLine])

  // Marks: a selection that covers the diagram is the surface's band; one inside it marks the nodes on its lines.
  useLayoutEffect(() => {
    const svg = svgRef.current
    const el = root.current
    if (!svg || !el) return
    const w = whole()
    const covered = !!selection && !!w && selection.start <= w.start && w.end <= selection.end
    const band = covered ? 'selected' : pointedLines && w && meets(w, pointedLines) ? 'pointed' : null
    if (band) el.dataset.band = band
    else delete el.dataset.band
    const sel = new Set(keys ?? [])
    for (const g of svg.querySelectorAll<SVGElement>('[data-part]:not([data-hit]), g.node[data-line]')) {
      const k = g.dataset.part
      const n = g.matches('g.node') && g.dataset.line ? Number(g.dataset.line) : NaN
      g.toggleAttribute('data-sel', (!!selection && !covered && selection.start <= n && n <= selection.end) || (!!k && sel.has(k)))
      g.toggleAttribute('data-pointed', (!!pointedLines && g.matches('g.node') && pointedLines.start <= n && n <= pointedLines.end) || (!!k && pointedKeys.has(k)))
    }
    for (const [label, cluster] of seats.current) {
      const mark = cluster.hasAttribute('data-sel') ? 'sel' : cluster.hasAttribute('data-pointed') ? 'pointed' : null
      if (mark) label.dataset.seatMark = mark
      else delete label.dataset.seatMark
    }
    // A theme or line-span change reseats the labels above, which clears their marks, so it reruns this too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawn, selection, pointedLines, keys, pointedKeys, theme, firstLine, lastLine])

  // Claude's parts: what the drawing doesn't have goes back in the reply, once per highlight, and the first found part
  // comes into view.
  const reported = useRef<string[] | null>(null)
  const report = host?.report
  useEffect(() => {
    if (!pointedIds || !drawn || !current || reported.current === pointedIds) return
    reported.current = pointedIds
    const found = pointedIds.filter((id) => [`n:${id}`, `g:${id}`, `p:${id}`].some((k) => table.has(k)))
    report?.(pointedIds.filter((id) => !found.includes(id)))
    const first = found.length ? [`n:${found[0]}`, `g:${found[0]}`, `p:${found[0]}`].find((k) => els.current.has(k)) : null
    if (first) els.current.get(first)?.[0]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [pointedIds, drawn, current, table, report])
  const pointedRow = useMemo(() => {
    if (!pointedIds || !drawn || !current) return null
    const found = drawn.parts ? [...pointedKeys].filter((k) => /^[ngp]:/.test(k) && pointedIds.includes(k.slice(2))) : []
    if (!found.length) return "Claude pointed to parts that aren't in this diagram."
    const p = table.get(found[0])
    return found.length === 1 && p ? `Claude pointed to ${partPhrase(drawn.keyword, wirePart(p, firstLine))}` : `Claude pointed to ${found.length} parts`
  }, [pointedIds, pointedKeys, drawn, current, table, firstLine])

  // A redraw of new text keeps the parts that are still there; theme-only redraws keep every key.
  useEffect(() => {
    if (!keys || !drawn?.parts) return
    const kept = keys.filter((k) => table.has(k))
    if (kept.length === keys.length) return
    if (!kept.length) return host?.partsLost()
    const w = whole()
    if (w) host?.pickParts(w, kept, 'set')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawn])

  const partBox = (k: string): DOMRect | null => union((els.current.get(k) ?? []).map((e) => e.getBoundingClientRect()))
  // The innermost group or block whose box holds the point: box interiors have no fill to hit.
  const enclosing = (x: number, y: number): string | null => {
    let best: { k: string; area: number } | null = null
    for (const k of els.current.keys()) {
      if (!/^[gb]:/.test(k)) continue
      const r = partBox(k)
      if (!r || !within(r, x, y) || r.width < MIN_TARGET || r.height < MIN_TARGET) continue
      if (!best || r.width * r.height < best.area) best = { k, area: r.width * r.height }
    }
    return best?.k ?? null
  }
  const partAt = (t: EventTarget | null, x: number, y: number): string | null => {
    const el = t instanceof Element ? t.closest('[data-part]') : null
    let k = el && svgHost.current?.contains(el) ? el.getAttribute('data-part') : null
    if (k && boxy(k)) {
      const r = partBox(k)
      if (!r || r.width < MIN_TARGET || r.height < MIN_TARGET) k = null
    }
    return k ?? enclosing(x, y)
  }
  // A drawing that can't be pointed at gives a proven node's line, else the whole diagram.
  const nodeAt = (t: EventTarget | null): SVGGElement | null => {
    const g = t instanceof Element ? t.closest<SVGGElement>('g.node[data-line]') : null
    if (!g || !svgHost.current?.contains(g)) return null
    const r = g.getBoundingClientRect()
    return r.width >= MIN_TARGET && r.height >= MIN_TARGET ? g : null
  }

  // Hover shows a part's line in the gutter, level with its box, title row or label tab. Moving left to that number
  // crosses empty drawing, so the part stays while the pointer is level with it.
  const heat = (k: string | null, g: Element | null): void => {
    if (g === hot?.el && k === hot?.key) return
    for (const x of hot?.key ? (els.current.get(hot.key) ?? []) : hot ? [hot.el] : []) x.removeAttribute('data-hot')
    for (const x of k ? (els.current.get(k) ?? []) : g ? [g] : []) x.setAttribute('data-hot', '')
    if (!g || !root.current) return setHot(null)
    const line = (g as SVGElement).dataset.line ? Number((g as SVGElement).dataset.line) : null
    const rootTop = root.current.getBoundingClientRect().top
    const own = k ? (els.current.get(k) ?? []).filter((x) => x.localName !== 'line') : []
    const r = (own[0] ?? g).getBoundingClientRect()
    const tab = k?.startsWith('b:') ? own[0]?.querySelector('polygon.labelBox')?.getBoundingClientRect() : null
    const mid = tab ? tab.top + tab.height / 2 : k?.startsWith('g:') ? r.top + 12 : r.top + r.height / 2
    setHot({ key: k, el: g, line, top: mid - rootTop - 12 })
  }
  // A node number near the diagram's top would sit on the block's own, so the block's steps aside while it shows.
  useLayoutEffect(() => {
    const num = root.current?.closest('[data-src]')?.querySelector<HTMLElement>(':scope > [data-num]')
    if (!num || !hot?.line || hot.top >= 24) return
    num.style.visibility = 'hidden'
    return () => void (num.style.visibility = '')
  }, [hot])

  const drag = useRef<{ id: number; x: number; y: number; on: boolean; before: { keys: string[] | null; lines: Span | null }; shift: boolean } | null>(null)
  const [marquee, setMarquee] = useState<Box | null>(null)
  const onPointerMove = (e: PointerEvent): void => {
    const d = drag.current
    if (d && e.pointerId === d.id) return dragTo(e)
    if (e.pointerType !== 'mouse' || !host) return
    if (mode === 'parts') {
      const k = partAt(e.target, e.clientX, e.clientY)
      if (k) return heat(k, els.current.get(k)?.[0] ?? null)
    } else if (!mode) {
      const g = nodeAt(e.target)
      if (g) return heat(null, g)
    }
    if (e.target instanceof Element && e.target.closest('[data-node-num]')) return
    const r = hot?.el.getBoundingClientRect()
    if (r && e.clientY >= r.top && e.clientY < r.bottom && e.clientX < r.right) return
    heat(null, null)
  }

  // Marquee: a drag picks the parts whose whole box it covers, live, and leaves no rectangle behind.
  const inside = (box: DOMRect): string[] =>
    (drawn?.parts ?? []).flatMap((p) => {
      const r = partBox(p.key)
      return r && r.left >= box.left && r.right <= box.right && r.top >= box.top && r.bottom <= box.bottom ? [p.key] : []
    })
  const dragTo = (e: PointerEvent): void => {
    const d = drag.current!
    // A press released outside the drawing before it became a drag never sent its pointerup here.
    if (!d.on && !(e.buttons & 1)) return void (drag.current = null)
    const w = whole()
    const at = svgHost.current?.parentElement?.getBoundingClientRect()
    if (!w || !at || !host) return
    if (!d.on) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_PX) return
      d.on = true
      svgHost.current?.setPointerCapture(d.id)
      heat(null, null)
    }
    const box = DOMRect.fromRect({ x: Math.min(d.x, e.clientX), y: Math.min(d.y, e.clientY), width: Math.abs(e.clientX - d.x), height: Math.abs(e.clientY - d.y) })
    setMarquee({ x: box.left - at.left, y: box.top - at.top, w: box.width, h: box.height })
    const got = inside(box)
    const base = d.shift ? (d.before.keys ?? []) : []
    host.pickParts(w, [...new Set([...base, ...got])], 'set')
  }
  const endDrag = (restore: boolean): void => {
    const d = drag.current
    drag.current = null
    if (!d?.on) return
    if (svgHost.current?.hasPointerCapture(d.id)) svgHost.current.releasePointerCapture(d.id)
    setMarquee(null)
    const w = whole()
    if (!restore || !w || !host) return
    if (d.before.lines) host.pick(d.before.lines, false)
    else host.pickParts(w, d.before.keys ?? [], 'set')
  }
  useEffect(() => {
    if (!marquee) return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      endDrag(true)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!marquee])

  const down = useRef<{ x: number; y: number } | null>(null)
  const onPointerDown = (e: PointerEvent): void => {
    down.current = { x: e.clientX, y: e.clientY }
    if (mode !== 'parts' || e.button !== 0 || e.pointerType === 'touch') return
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, on: false, before: { keys: keys ? [...keys] : null, lines: selection }, shift: e.shiftKey }
  }
  const onClick = (e: MouseEvent): void => {
    // The surface's own click rules, which clear a selection, don't apply on the drawing.
    e.stopPropagation()
    const d = down.current
    down.current = null
    if (!host || !d || Math.hypot(e.clientX - d.x, e.clientY - d.y) >= DRAG_PX) return
    const w = whole()
    if (mode === 'parts' && w) {
      const k = partAt(e.target, e.clientX, e.clientY)
      if (k) return host.pickParts(w, [k], e.shiftKey ? 'toggle' : 'one')
    }
    const g = mode ? null : nodeAt(e.target)
    const lines = g ? { start: Number(g.dataset.line), end: Number(g.dataset.line) } : w
    if (lines) host.pick(lines, e.shiftKey)
  }

  // The listbox: one tab stop for every part, with the active one marked on the drawing.
  const uid = useId()
  const parts = mode === 'parts' ? (drawn?.parts ?? []) : []
  const [active, setActive] = useState(0)
  const [focused, setFocused] = useState<false | 'key' | 'pointer'>(false)
  const typed = useRef({ text: '', at: 0 })
  // An outline on the part itself loses its top and bottom under a link's nodes, so the ring sits above the drawing.
  // ponytail: measured on focus and on each move; remeasure on resize if the pane resizes under keyboard focus.
  const [ring, setRing] = useState<Box | null>(null)
  useLayoutEffect(() => {
    const k = focused === 'key' ? parts[active]?.key : null
    const r = k ? partBox(k) : null
    const at = svgHost.current?.parentElement?.getBoundingClientRect()
    setRing(r && at ? { x: r.left - at.left - 3, y: r.top - at.top - 3, w: r.width + 6, h: r.height + 6 } : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, active, drawn, mode])
  const goTo = (i: number): void => {
    const n = Math.max(0, Math.min(parts.length - 1, i))
    setActive(n)
    if (parts[n]) els.current.get(parts[n].key)?.[0]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  const onListKey = (e: KeyboardEvent<HTMLUListElement>): void => {
    if (e.metaKey || e.ctrlKey || e.altKey || !host) return
    const w = whole()
    const k = parts[active]?.key
    if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key]
    if (step) {
      e.preventDefault()
      return goTo(active + step)
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      return goTo(e.key === 'Home' ? 0 : parts.length - 1)
    }
    if (e.key === ' ') {
      e.preventDefault()
      if (k && w) host.pickParts(w, [k], 'toggle')
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (keys?.length) host.add()
      return
    }
    if (e.key === 'Escape') {
      if (!keys?.length || !w) return
      e.preventDefault()
      return host.pickParts(w, [], 'set')
    }
    if (e.key.length !== 1) return
    typed.current = typedAfter(typed.current, e.key, Date.now())
    const hit = typeahead(parts, active, typed.current.text)
    if (hit >= 0) goTo(hit)
  }
  const selected = new Set(keys ?? [])

  // What the host's bar shows and adds for a part or area selection here.
  const picks = useMemo(() => (keys ? (drawn?.parts ?? []).filter((p) => keys.includes(p.key)) : null), [keys, drawn])
  const [labels, setLabels] = useState<string[] | null>(null)
  useLayoutEffect(() => {
    const svg = svgRef.current
    if (!region || !svg) return setLabels(null)
    const at = svg.getBoundingClientRect()
    setLabels(labelsIn(candidates(svg), { x: region.x * at.width, y: region.y * at.height, w: region.w * at.width, h: region.h * at.height }))
  }, [region, drawn])
  const offer = useMemo((): DiagramOffer | null => {
    const w = host?.owner
    const svg = svgRef.current
    if (!drawn || !w || !svg) return null
    if (picks?.length) {
      const wire = picks.map((p) => wirePart(p, firstLine))
      const label = partsSelectedText(drawn.keyword, wire)
      const crop = (): Promise<DraftVisual | null> => {
        const box = union(picks.flatMap((p) => partBox(p.key) ?? []))
        const at = svg.getBoundingClientRect()
        const vb = svg.viewBox.baseVal
        if (!box || !vb?.width || !at.width) return Promise.resolve(null)
        const k = vb.width / at.width
        const x0 = Math.max(0, (box.left - at.left) * k - CROP_PAD)
        const y0 = Math.max(0, (box.top - at.top) * k - CROP_PAD)
        const x1 = Math.min(vb.width, (box.right - at.left) * k + CROP_PAD)
        const y1 = Math.min(vb.height, (box.bottom - at.top) * k + CROP_PAD)
        return picture(svg, { x: x0 / vb.width, y: y0 / vb.height, w: (x1 - x0) / vb.width, h: (y1 - y0) / vb.height })
      }
      return { body: { lines: w, type: drawn.keyword, parts: wire }, label, spoken: marquee ? '' : label, crop }
    }
    if (region && labels) {
      const wire = wireLabels(code, labels, firstLine)
      return { body: { lines: w, type: drawn.keyword, labels: wire }, label: areaSelectedText(wire.length), spoken: areaSpoken(labels), crop: () => picture(svg, region) }
    }
    return null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picks, region, labels, drawn, host?.owner, firstLine, code, !!marquee])
  const offerTo = host?.offer
  useEffect(() => {
    if (owns) offerTo?.(firstLine, offer)
  }, [offerTo, owns, offer, firstLine])
  useEffect(() => () => offerTo?.(firstLine, null), [offerTo, firstLine])

  const picker = useRef<PickerHandle>(null)
  const source = (line: number, e: MouseEvent): void => host?.viewSource(line, viaOf(e))
  const standalone = name !== undefined

  let body: JSX.Element
  if (!out) {
    body = standalone ? <div className={STATE_BODY}>{slow && <p className="text-meta text-dim">{`Drawing ${name}`}</p>}</div> : <div className="min-h-12">{slow && <p className="text-meta text-dim">Drawing diagram</p>}</div>
  } else if (!out.ok) {
    const why = out.why
    const at = why.t === 'parse' ? firstLine + why.line - 1 : firstLine
    const detail = detailOf(why, at)
    const headline =
      why.t === 'load' ? "Couldn't load the diagram renderer." : standalone ? `Couldn't draw ${name}` : `Couldn't draw this diagram.${why.t === 'parse' ? ` ${detail}` : ''}`
    const sentence = why.t === 'load' || (!standalone && why.t === 'parse') ? null : detail
    body = (
      <div className={standalone ? STATE_BODY : `flex flex-col items-start gap-2 ${BOX}`}>
        <p className={HEADLINE}>{headline}</p>
        {sentence && <p className="max-w-[60ch] text-ui text-dim">{sentence}</p>}
        {why.t === 'parse' && (
          <>
            <pre className={`max-w-full overflow-x-auto whitespace-pre font-mono text-code text-content ${standalone ? BOX : ''}`}>{`${why.excerpt}\n${why.caret}`}</pre>
            {why.expecting && <p className="max-w-[60ch] text-ui text-dim">{why.expecting}</p>}
          </>
        )}
        <div className="-ml-2 flex gap-2 text-ui">
          {why.t === 'load' && (
            <button type="button" className={TEXT_BTN} onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          )}
          <button type="button" className={TEXT_BTN} onClick={(e) => source(at, e)}>
            View source
          </button>
        </div>
      </div>
    )
  } else {
    const hotPart = hot?.key ? table.get(hot.key) : null
    body = (
      <>
        {pointedRow && <PointedRow label={pointedRow} />}
        {hot?.line && (
          <span
            aria-hidden="true"
            data-node-num=""
            className={NUM}
            style={{ top: hot.top }}
            onClick={(e) => {
              e.stopPropagation()
              const end = hotPart?.lines ? firstLine + hotPart.lines.end : hot.line!
              host?.pick({ start: hot.line!, end }, e.shiftKey)
            }}
          >
            {hot.line}
          </span>
        )}
        <div className="relative">
          <div
            ref={scroller}
            data-ui="mermaid-scroll"
            className="overflow-x-auto"
            onScroll={() => picker.current?.redraw()}
            {...(mode === 'area' && view ? { tabIndex: 0, role: 'group', 'aria-label': `${view.label}, drawing`, 'aria-description': AREA_DESCRIPTION } : {})}
          >
            {parts.length > 0 && (
              <ul
                role="listbox"
                aria-multiselectable="true"
                tabIndex={0}
                data-ui="mermaid-parts"
                className="sr-only"
                aria-label={`${view?.label ?? typeName(out.drawn.type)} parts`}
                aria-description={PARTS_DESCRIPTION}
                aria-activedescendant={focused ? `${uid}-${active}` : undefined}
                onKeyDown={onListKey}
                onFocus={(e) => {
                  setFocused(e.currentTarget.matches(':focus-visible') ? 'key' : 'pointer')
                  const first = parts.findIndex((p) => selected.has(p.key))
                  goTo(first >= 0 ? first : 0)
                }}
                onBlur={() => setFocused(false)}
              >
                {parts.map((p, i) => (
                  <li key={p.key} id={`${uid}-${i}`} role="option" aria-selected={selected.has(p.key)} aria-label={partOption(out.drawn.keyword, wirePart(p, firstLine))} />
                ))}
              </ul>
            )}
            <div className="relative">
              <div
                ref={svgHost}
                className={`select-none [&>svg]:block [&>svg]:h-auto [&>svg]:w-[clamp(calc(var(--w)*0.8),100%,var(--w))] ${standalone ? '[&>svg]:mx-auto' : ''}`}
                style={view ? ({ '--w': `${view.width}px` } as CSSProperties) : undefined}
                onPointerDown={onPointerDown}
                onPointerUp={() => endDrag(false)}
                onPointerCancel={() => endDrag(true)}
                onClick={onClick}
                // The SVG is mermaid's, already through its DOMPurify, so Clui only annotates it.
                dangerouslySetInnerHTML={{ __html: out.drawn.svg }}
              />
              {(marquee || ring) && (
                <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
                  {marquee && (
                    <>
                      <rect x={marquee.x - 0.5} y={marquee.y - 0.5} width={marquee.w + 1} height={marquee.h + 1} fill="none" strokeWidth="1" className="stroke-edge-dark" />
                      <rect x={marquee.x + 0.5} y={marquee.y + 0.5} width={Math.max(0, marquee.w - 1)} height={Math.max(0, marquee.h - 1)} fill="none" strokeWidth="1" className="stroke-edge-light" />
                    </>
                  )}
                  {ring && <rect data-ui="mermaid-ring" x={ring.x} y={ring.y} width={ring.w} height={ring.h} fill="none" strokeWidth="2" className="stroke-ring" />}
                </svg>
              )}
            </div>
          </div>
          {mode === 'area' && !!view?.height && host && (
            <RegionPicker
              ref={picker}
              viewport={scroller}
              content={svgRef}
              basis={{ w: view.width, h: view.height }}
              selection={region ? { region } : null}
              pointing
              points={false}
              onChange={(next) => {
                const w = whole()
                if (w) host.pickRegion(w, next?.region ?? null)
              }}
              onAdd={host.add}
              onEnd={host.escape}
              panning={() => false}
            />
          )}
        </div>
      </>
    )
  }
  return (
    <div ref={root} data-ui="mermaid" data-find-skip="" aria-busy={!out || undefined} className="relative" onPointerMove={onPointerMove} onPointerLeave={() => {
        if (!drag.current) heat(null, null)
      }}>
      {body}
    </div>
  )
}

/**
 * A surface's half of its diagrams' part and area selections: the tab's selection as `{ lines, parts }` or
 * `{ lines, region }`, the bar, the announcement, and the add with its picture. `lines` is the owning diagram's block.
 */
export function useDiagramSelection({
  handleId,
  tabId,
  path,
  revision,
  say,
  selSay,
  escape
}: {
  handleId: string
  tabId: string
  path: string
  revision: string | null
  say: (t: string) => void
  selSay: { current: ReturnType<typeof setTimeout> | undefined }
  escape: () => void
}) {
  const tab = useActive((s) => s?.surfaces.tabs[tabId])
  const setView = useSession((s) => s.setSurfaceView)
  const picture = useSettings((s) => s?.values.annotateScreenshots ?? true)
  const sel = tab?.selection
  const owner = sel?.lines && (sel.parts || sel.region) ? sel.lines : null
  const parts = owner ? (sel?.parts ?? null) : null
  const region = owner ? (sel?.region ?? null) : null
  const [offered, setOffered] = useState<{ at: number; o: DiagramOffer } | null>(null)
  const [lost, setLost] = useState(false)
  const offer = owner && offered && owner.start <= offered.at && offered.at <= owner.end ? offered.o : null
  const input = useMemo((): Extract<RefInput, { kind: 'diagram' }> | null => (offer && revision ? { kind: 'diagram', path, sourceVersion: `sha256:${revision}`, ...offer.body } : null), [offer, revision, path])
  const blocked = input ? diagramBlocked(input, picture) : undefined
  const key = input ? refKey(input) : null
  const isThis = ({ ref }: DraftReference): boolean => !!key && ref.kind === 'diagram' && refKey(ref) === key
  const inTarget = useActive((s) => !!s && !!key && !!refsOf(s, s.referenceEditTarget)?.some(isThis))

  const write = (next: { parts?: string[]; region?: Region } | null, lines: Span): void => {
    setLost(false)
    setView(handleId, tabId, { selection: next && revision ? { lines, sourceVersion: `sha256:${revision}`, ...next } : undefined, highlight: undefined })
  }
  const add = async (): Promise<void> => {
    if (!input || !offer) return
    if (blocked) return say(blocked)
    clearTimeout(selSay.current)
    const visual = picture ? await offer.crop() : null
    addFromSurface(handleId, input, say, visual ? { visual } : { unpictured: picture })
  }
  const latest = useRef({ owner, parts, write, add, escape })
  latest.current = { owner, parts, write, add, escape }
  const had = useRef(false)
  // Stable, so a diagram's effects don't rerun on every render of its surface.
  const [fns] = useState(() => ({
    pickParts: (w: Span, keys: string[], how: How): void => {
      const { owner: o, parts: p } = latest.current
      // Another diagram's selection doesn't carry over to this one.
      const cur = o && o.start === w.start ? (p ?? []) : []
      const next = how === 'set' ? keys : how === 'one' ? (cur.length === 1 && cur[0] === keys[0] ? [] : keys) : cur.includes(keys[0]) ? cur.filter((k) => k !== keys[0]) : [...cur, keys[0]]
      latest.current.write(next.length ? { parts: next } : null, w)
    },
    pickRegion: (w: Span, r: Region | null): void => latest.current.write(r ? { region: r } : null, w),
    partsLost: (): void => {
      setView(handleId, tabId, { selection: undefined })
      setLost(true)
      had.current = false
      say(PARTS_NOTICE.cleared)
    },
    offer: (at: number, o: DiagramOffer | null): void => setOffered((prev) => (o ? (prev?.at === at && prev.o === o ? prev : { at, o }) : prev?.at === at ? null : prev)),
    add: (): void => void latest.current.add(),
    report: (found: Found): void => reportFound(tabId, found),
    escape: (): void => latest.current.escape()
  }))

  // The count surface_state reports for an area.
  const labels = input?.labels?.length
  useEffect(() => {
    if (!region || labels === undefined || sel?.labels === labels || !sel) return
    setView(handleId, tabId, { selection: { ...sel, labels } })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labels, region])

  const disclose = picture && !blocked
  const label = offer ? `${offer.label}${disclose ? ' · with picture' : ''}` : ''
  const spoken = offer ? (blocked ?? (offer.spoken && `${offer.spoken}${disclose ? ', with picture' : ''}`)) : ''
  useEffect(() => {
    if (spoken) {
      had.current = true
      const t = (selSay.current = setTimeout(() => say(spoken), ANNOUNCE_MS))
      return () => clearTimeout(t)
    }
    // Empty while a marquee drags, or because a line selection replaced it, which speaks for itself.
    if (!had.current || owner) return
    had.current = false
    if (tab?.selection?.lines) return
    const t = (selSay.current = setTimeout(() => say('Selection cleared'), ANNOUNCE_MS))
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spoken])

  const pointedParts = tab?.highlight?.parts ?? null
  const pointedAt = pointedParts ? (tab?.highlight?.lines?.start ?? null) : null
  const host = useMemo(() => ({ owner, parts, region, pointedParts, pointedAt, ...fns }), [owner, parts, region, pointedParts, pointedAt, fns])

  const bar = input ? <SelectionBar label={label} attached={inTarget} onAdd={fns.add} blocked={blocked} onBlocked={() => say(blocked ?? '')} /> : null
  const notice = lost ? <SelectionNotice notice="cleared" copy={PARTS_NOTICE} onDismiss={() => setLost(false)} /> : null
  return { host, bar, notice, active: !!owner }
}
