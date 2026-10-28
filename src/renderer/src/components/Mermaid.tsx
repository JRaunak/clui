import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent, type PointerEvent } from 'react'
import { cached, cancel, enqueue, hexOf, pageInkOn, themeNow, tokensFor, typeName, type Failure, type Job, type Outcome, type Theme } from '../lib/mermaid'
import { parseSpan, type Span } from '../lib/markdownDoc'
import { viaOf, type Via } from '../lib/motion'
import { SKELETON_MS, STATE_BODY, TEXT_BTN } from './surfaces/fileDoc'

/** What a diagram needs from the surface around it: the selection and Claude's highlight, and the ways to change them. */
export interface DiagramHost {
  selection: Span | null
  pointed: Span | null
  pick: (lines: Span, shift: boolean) => void
  viewSource: (line: number, via: Via) => void
  /** Each diagram's last drawing by its first line, which outlives the remount an edit in its fence causes. */
  held: Map<number, Shown>
}
type Shown = { key: string; out: Outcome }
export const DiagramContext = createContext<DiagramHost | null>(null)

const subscribeTheme = (cb: () => void): (() => void) => {
  const o = new MutationObserver(cb)
  o.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => o.disconnect()
}
const useTheme = (): Theme => useSyncExternalStore(subscribeTheme, themeNow)

// Under 24px at the drawn scale a node is too small a target; its click selects the whole diagram.
const MIN_TARGET = 24
const HEADLINE = 'text-ui font-medium text-content'
const BOX = 'rounded-md border border-border bg-tool px-3 py-2'
// Styled as Markdown's gutter number.
const NUM = 'absolute -left-(--gut) w-(--gut) min-h-6 cursor-default select-none pr-2 text-right text-meta leading-6 tabular-nums text-faint pointer-fine:hover:text-content'

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

/**
 * One Mermaid diagram, drawn in the document's ink: in a Markdown fence, or as a `.mmd` file's whole Preview when
 * `name` is set. `firstLine` is the file line of the diagram's first line, so every line it reports is the file's.
 */
export function MermaidDiagram({ code, firstLine, lastLine, name, onState }: { code: string; firstLine: number; lastLine: number; name?: string; onState?: (s: 'pending' | 'drawn' | 'failed') => void }): JSX.Element {
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
  const [hot, setHot] = useState<{ g: SVGGElement; line: number; top: number } | null>(null)

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
  useEffect(() => void onState?.(state), [state, onState])

  const svgHost = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const svg = svgHost.current?.querySelector('svg')
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
    const t = tokensFor(theme)
    // A drawing held through a theme change has the old theme's colours, which would all read as an author's.
    const current = !!shown?.key.startsWith(`${theme}\0`)
    for (const g of current ? svg.querySelectorAll<SVGGElement>('g.node, g.cluster') : []) {
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
    setWidth(svg.viewBox.baseVal?.width || parseFloat(svg.getAttribute('width') ?? '') || null)
    setHot(null)
  }, [drawn, firstLine, lastLine, theme])

  // Node marks: a selection that covers the diagram is the surface's band; one inside it marks the nodes on its lines.
  const whole = (): Span | null => parseSpan(root.current?.closest<HTMLElement>('[data-src]')?.dataset.src)
  const selection = host?.selection ?? null
  const pointed = host?.pointed ?? null
  useLayoutEffect(() => {
    const svg = svgHost.current?.querySelector('svg')
    if (!svg) return
    const w = whole()
    const covered = !!selection && !!w && selection.start <= w.start && w.end <= selection.end
    for (const g of svg.querySelectorAll<SVGGElement>('g.node[data-line]')) {
      const n = Number(g.dataset.line)
      g.toggleAttribute('data-sel', !!selection && !covered && selection.start <= n && n <= selection.end)
      g.toggleAttribute('data-pointed', !!pointed && pointed.start <= n && n <= pointed.end)
    }
  }, [drawn, selection, pointed])

  // Hover shows a proven node's line in the gutter at its centre. Moving left to that number crosses empty drawing,
  // so the node stays while the pointer is level with it.
  const nodeAt = (t: EventTarget | null): SVGGElement | null => {
    const g = t instanceof Element ? t.closest<SVGGElement>('g.node[data-line]') : null
    if (!g || !svgHost.current?.contains(g)) return null
    const r = g.getBoundingClientRect()
    return r.width >= MIN_TARGET && r.height >= MIN_TARGET ? g : null
  }
  const heat = (g: SVGGElement | null): void => {
    if (g === hot?.g) return
    hot?.g.removeAttribute('data-hot')
    g?.setAttribute('data-hot', '')
    const r = g?.getBoundingClientRect()
    const top = r && root.current ? r.top + r.height / 2 - root.current.getBoundingClientRect().top - 12 : 0
    setHot(g ? { g, line: Number(g.dataset.line), top } : null)
  }
  // A node number near the diagram's top would sit on the block's own, so the block's steps aside while it shows.
  useLayoutEffect(() => {
    const num = root.current?.closest('[data-src]')?.querySelector<HTMLElement>(':scope > [data-num]')
    if (!num || !hot || hot.top >= 24) return
    num.style.visibility = 'hidden'
    return () => void (num.style.visibility = '')
  }, [hot])
  const onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse' || !host) return
    const g = nodeAt(e.target)
    if (g) return heat(g)
    if (e.target instanceof Element && e.target.closest('[data-node-num]')) return
    const r = hot?.g.getBoundingClientRect()
    if (r && e.clientY >= r.top && e.clientY < r.bottom && e.clientX < r.right) return
    heat(null)
  }

  const down = useRef<{ x: number; y: number } | null>(null)
  const onClick = (e: MouseEvent): void => {
    // The surface's own click rules, which clear a selection, don't apply on the drawing.
    e.stopPropagation()
    const d = down.current
    down.current = null
    if (!host || !d || Math.hypot(e.clientX - d.x, e.clientY - d.y) >= 4) return
    const g = nodeAt(e.target)
    const lines = g ? { start: Number(g.dataset.line), end: Number(g.dataset.line) } : whole()
    if (lines) host.pick(lines, e.shiftKey)
  }

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
    body = (
      <>
        {hot && (
          <span
            aria-hidden="true"
            data-node-num=""
            className={NUM}
            style={{ top: hot.top }}
            onClick={(e) => {
              e.stopPropagation()
              host?.pick({ start: hot.line, end: hot.line }, e.shiftKey)
            }}
          >
            {hot.line}
          </span>
        )}
        <div data-ui="mermaid-scroll" className="overflow-x-auto">
          <div
            ref={svgHost}
            className={`select-none [&>svg]:block [&>svg]:h-auto [&>svg]:w-[clamp(calc(var(--w)*0.8),100%,var(--w))] ${standalone ? '[&>svg]:mx-auto' : ''}`}
            style={width ? ({ '--w': `${width}px` } as CSSProperties) : undefined}
            onPointerDown={(e) => {
              down.current = { x: e.clientX, y: e.clientY }
            }}
            onClick={onClick}
            // The SVG is mermaid's, already through its DOMPurify, so Clui only annotates it.
            dangerouslySetInnerHTML={{ __html: out.drawn.svg }}
          />
        </div>
      </>
    )
  }
  return (
    <div ref={root} data-ui="mermaid" data-find-skip="" aria-busy={!out || undefined} className="relative" onPointerMove={onPointerMove} onPointerLeave={() => heat(null)}>
      {body}
    </div>
  )
}
