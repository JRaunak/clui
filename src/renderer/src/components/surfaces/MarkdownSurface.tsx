import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactElement } from 'react'
import { useSession } from '../../store'
import { IMAGE_PATHS_MAX, type ImageCap } from '../../../../shared/files'
import type { BackPlace, SurfaceLocation } from '../../../../shared/surfaces'
import { CodeBlock, DocContext, docRow, FileLinkContext, GutterNum, PointedRow, type DocLinks } from '../Markdown'
import { FindField } from '../FindField'
import { SelectionBar } from './SelectionBar'
import { BANNER, baseOf, DocState, FIND_MAX, FLASH_MS, rangeText, SelectionNotice, STATE_BODY, TEXT_BTN, useFileDoc, useFind, VIEW_SETTLE_MS, viewSourceAt } from './fileDoc'
import { DiagramContext, type DiagramHost } from '../Mermaid'
import { blockFor, docTree, frontMatter, joinSpans, meets, nextChunk, parseSpan, pointAt, previewEnd, rowOf, rowWithId, type DocTree, type Span } from '../../lib/markdownDoc'
import { findRe } from '../../lib/find'
import { latestParse } from '../../lib/markdownParse'
import { markNoPreview } from '../../lib/presentation'
import { useLinkRoot } from '../../lib/openLink'
import { setPointing, takePoint, takeSurfaceFocus, usePointing, usePointRequest } from '../../lib/surfaceFocus'
import { reducedMotion, type Via } from '../../lib/motion'
import { POINT_BLOCK_HINT, POINT_OFF, selectedText } from '../../lib/refCopy'

/** How long an anchor, a line or a restored place keeps its top while images above it load. */
const HOLD_MS = 2000
const COLUMN =
  'relative isolate mx-auto w-full max-w-[calc(72ch+4.5rem)] py-6 pl-12 pr-6 text-base text-content [--gut:3rem] @max-[520px]/md:py-4 @max-[520px]/md:pl-10 @max-[520px]/md:pr-4 @max-[520px]/md:[--gut:2.5rem]'
const WASH = 'bg-bg-raised animate-[turn-flash-out_var(--dur-slow)_var(--ease-in)_var(--dur-stage)_both]'
const SKIP = '[data-num], .sr-only, button, [data-find-skip], [data-pointed]'
// Over this a document parses in the worker; under it a parse costs less than the hop.
const SYNC_MAX = 8 * 1024
// Elements per render: a paragraph row measured ~26 µs to render, a linked list item more, so this keeps a commit
// near 10–20 ms with room for slower machines.
const CHUNK = 400
const BACK_MAX = 50
const NOT_FOUND: { ranges: Range[]; more: boolean } = { ranges: [], more: false }

type Band = { kind: 'pointed' | 'sel' | 'wash'; top: number; height: number }
interface Blocks {
  els: HTMLElement[]
  spans: Span[]
}

const numOf = (el: HTMLElement | null): HTMLElement | null => el?.querySelector<HTMLElement>('[data-num]') ?? null
/** A selection inside a drawn diagram marks its nodes instead; only one that covers the diagram marks its block. */
const marksBlock = (el: HTMLElement, block: Span, sel: Span): boolean =>
  meets(block, sel) && ((sel.start <= block.start && block.end <= sel.end) || !el.querySelector(':scope > [data-ui="mermaid"] svg'))

/**
 * The rows covered by the blocks in `els` that meet `span`, relative to the column. Consecutive blocks in the span
 * make one band through the margin between them, so one range never reads as two.
 */
function bandsOf(kind: Band['kind'], b: Blocks, span: Span, top: number): Band[] {
  const out: Band[] = []
  let joined = false
  for (let i = 0; i < b.els.length; i++) {
    if (kind === 'sel' ? !marksBlock(b.els[i], b.spans[i], span) : !meets(b.spans[i], span)) {
      joined = false
      continue
    }
    const r = b.els[i].getBoundingClientRect()
    const last = out.at(-1)
    if (last && (joined || r.top - top <= last.top + last.height)) last.height = Math.max(last.height, r.bottom - top - last.top)
    else out.push({ kind, top: r.top - top, height: r.height })
    joined = true
  }
  return out
}

/** Every rendered text node's matches of `q`, case-insensitively, as ranges. Gutter numbers and labels aren't text the
 *  reader reads, and no match runs from one block into the next. */
function findRanges(col: HTMLElement, q: string): { ranges: Range[]; more: boolean } {
  const walker = document.createTreeWalker(col, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  })
  const nodes: Text[] = []
  const starts: number[] = []
  let all = ''
  let block: Element | null = null
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const b = n.parentElement?.closest('[data-src]') ?? null
    if (b !== block) {
      all += '\n'
      block = b
    }
    starts.push(all.length)
    nodes.push(n as Text)
    all += (n as Text).data
  }
  const at = (off: number): number => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= off) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  const ranges: Range[] = []
  for (const m of all.matchAll(findRe(q))) {
    if (ranges.length === FIND_MAX) return { ranges, more: true }
    const i = m.index
    const e = i + m[0].length
    const a = at(i)
    const z = at(e - 1)
    const r = document.createRange()
    r.setStart(nodes[a], i - starts[a])
    r.setEnd(nodes[z], e - starts[z])
    ranges.push(r)
  }
  return { ranges, more: false }
}

/**
 * A Markdown file's Preview. Every rendered block carries the source lines it came from, so the selection, Claude's
 * highlight and the reader's place are all in the Source's own lines.
 */
export function MarkdownSurface({ handleId, tabId }: { handleId: string; tabId: string }): JSX.Element {
  const bodyEl = useRef<HTMLDivElement | null>(null)
  const colEl = useRef<HTMLDivElement | null>(null)
  // State too, so the observer follows a column that mounts after the first read, like an empty file's.
  const [col, setCol] = useState<HTMLDivElement | null>(null)
  const colRef = useCallback((el: HTMLDivElement | null) => {
    colEl.current = el
    setCol(el)
  }, [])
  const blocks = useRef<Blocks>({ els: [], spans: [] })
  const keepLine = useRef<number | null>(null)

  // Blocks are in document order, so their tops only grow: the first one below y is a binary search away.
  const firstBelow = (y: number): number => {
    const { els } = blocks.current
    let lo = 0
    let hi = els.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (els[mid].getBoundingClientRect().top <= y) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  // The innermost block at the body's top, or the first one under it. -1 with no blocks.
  const blockAtTop = (): number => {
    const { els } = blocks.current
    if (!bodyEl.current || !els.length) return -1
    const y = bodyEl.current.getBoundingClientRect().top + 1
    const lo = firstBelow(y)
    // A container comes before what it holds, so the nearest one back that reaches past y is the innermost.
    for (let i = lo - 1; i >= Math.max(0, lo - 50); i--) if (els[i].getBoundingClientRect().bottom > y) return i
    return Math.min(lo, els.length - 1)
  }
  const topLine = (): number => blocks.current.spans[blockAtTop()]?.start ?? 1

  const { tab, path, doc, slow, notice, setNotice, said, say, selection, setSelection, addSelection, inTarget, selSay, load, reopen } = useFileDoc(handleId, tabId, (moved) => {
    keepLine.current = bodyEl.current && bodyEl.current.scrollTop > 0 ? moved(topLine()) : null
  })
  const setView = useSession((s) => s.setSurfaceView)
  const root = useLinkRoot(true)
  const name = baseOf(path)
  const highlight = tab?.highlight?.lines ?? null
  const location = tab?.location
  const text = doc.t === 'text' ? doc.text : null
  const revision = doc.t === 'text' ? doc.revision : null

  const end = useMemo(() => (text === null ? null : previewEnd(text)), [text])
  // Only the first read decides: a file that grows past 1 MB while previewed keeps its Preview, cut short.
  const sized = useRef<boolean | null>(null)
  if (text !== null && sized.current === null) sized.current = end !== null
  const toSource = !!sized.current && tab?.mode !== 'preview'
  useLayoutEffect(() => {
    if (toSource) markNoPreview(handleId, path, 'too-large')
  }, [toSource, handleId, path])

  const parsed = useMemo(() => {
    if (text === null || toSource) return null
    const shown = end === null ? text : text.slice(0, end)
    const fm = frontMatter(shown)
    return { fm, body: fm ? fm.body : shown, cut: end !== null }
  }, [text, end, toSource])
  const pointed = useMemo(() => (highlight ? { ...highlight, label: `Claude pointed to ${rangeText(highlight, '–')}` } : null), [highlight])

  // The tree: parsed here when small, in the worker otherwise. A reparse keeps showing the tree it replaces.
  const [parse] = useState(() => latestParse())
  const big = !!parsed && parsed.body.length > SYNC_MAX
  const [worked, setWorked] = useState<(DocTree & { body: string }) | null>(null)
  const small = useMemo(() => (parsed && !big ? { ...docTree(parsed.body), body: parsed.body } : null), [parsed, big])
  useEffect(() => {
    // A small tree is the one a regrown document's parse replaces.
    if (small) return setWorked(small)
    if (!parsed || !big) return
    const { body } = parsed
    void parse(body).then((t) => t && setWorked({ ...t, body }))
  }, [parsed, big, parse, small])
  const base = small ?? (parsed ? worked : null)

  // The rows render a chunk at a time: the first at once, the rest when the thread is idle. A reparse keeps every row
  // it built before, by key, so React skips them, and builds a chunk of the new ones.
  const built = useRef(new Map<string, ReactElement>())
  const [shown, setShown] = useState(0)
  const [shownOf, setShownOf] = useState<DocTree | null>(null)
  if (base !== shownOf) {
    setShownOf(base)
    setShown(base ? nextChunk(base.weights, 0, CHUNK, (i) => built.current.has(base.keys[i])) : 0)
  }
  // What waits on a row not rendered yet; it runs once the commit that renders the row is in.
  const goal = useRef<{ row: number; go: () => void } | null>(null)
  useEffect(() => {
    if (!base || shown >= base.rows.length) return
    const next = (): void => setShown((s) => nextChunk(base.weights, s, CHUNK))
    // Toward a row something waits on, a chunk a task, so no jump is one long task however deep it goes.
    if (goal.current) {
      const t = setTimeout(next, 0)
      return () => clearTimeout(t)
    }
    const id = requestIdleCallback(next, { timeout: 100 })
    return () => cancelIdleCallback(id)
  }, [base, shown])
  const busy = !!parsed && (base?.body !== parsed.body || shown < base.rows.length)
  const point = useMemo(() => (base ? pointAt(base.rows, pointed) : null), [base, pointed])
  const rendered = useMemo(() => {
    if (!base) return null
    const keep = new Map<string, ReactElement>()
    const out = base.rows.slice(0, shown).flatMap((r, i) => {
      const key = base.keys[i]
      if (i === point?.at) return point.nodes.map((n) => docRow(n, n.type === 'element' && n.properties.dataPointed ? 'pointed' : key))
      const el = built.current.get(key) ?? docRow(r, key)
      keep.set(key, el)
      return [el]
    })
    built.current = keep
    return out
  }, [base, shown, point])
  const reach = (row: number, go: () => void): void => {
    if (!base || row < shown) return go()
    goal.current = { row, go }
    setShown((s) => nextChunk(base.weights, s, CHUNK))
  }

  // Images: the rendered document marks every local image path; main answers each with a cap or a refusal.
  const [images, setImages] = useState<{ revision: string; map: Map<string, ImageCap | 'too-many'> } | null>(null)
  useLayoutEffect(() => {
    const col = colEl.current
    // Asked once the whole document has rendered, since one ask covers every image and a new one revokes the last.
    if (!parsed || !col || revision === null || busy || images?.revision === revision) return
    const all = [...new Set(Array.from(col.querySelectorAll<HTMLElement>('[data-img]'), (e) => e.dataset.img ?? ''))].filter(Boolean)
    const paths = all.slice(0, IMAGE_PATHS_MAX)
    let live = true
    // Minting again, for no paths too, revokes the earlier revision's caps.
    void window.clui.imageCaps(handleId, tabId, paths).catch((): ImageCap[] => []).then((caps) => {
      if (live) setImages({ revision, map: new Map(all.map((p, i) => [p, i < IMAGE_PATHS_MAX ? (caps[i] ?? { ok: false, outside: false }) : 'too-many'])) })
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, revision, busy])
  useEffect(() => () => void window.clui.imageCapsRevoke(handleId, tabId), [handleId, tabId])

  // Selection, Claude's highlight and the wash, drawn as rows behind the blocks they cover.
  const [bands, setBands] = useState<Band[]>([])
  const [flash, setFlash] = useState<HTMLElement | null>(null)
  const marked = useRef<HTMLElement[]>([])
  const measure = (): void => {
    const col = colEl.current
    if (!col) return
    const top = col.getBoundingClientRect().top
    const b = blocks.current
    for (const n of marked.current) n.removeAttribute('data-sel')
    marked.current = []
    if (selection) {
      for (let i = 0; i < b.els.length; i++) {
        const n = marksBlock(b.els[i], b.spans[i], selection) ? numOf(b.els[i]) : null
        if (!n) continue
        n.setAttribute('data-sel', '')
        marked.current.push(n)
      }
    }
    const r = flash?.isConnected ? flash.getBoundingClientRect() : null
    const next = [
      ...(highlight ? bandsOf('pointed', b, highlight, top) : []),
      ...(r ? [{ kind: 'wash' as const, top: r.top - top, height: r.height }] : []),
      ...(selection ? bandsOf('sel', b, selection, top) : [])
    ]
    // Measured after every render, so an unchanged layout must not render again.
    setBands((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
  }
  const measureRef = useRef(measure)
  measureRef.current = measure

  // The blocks in document order, read again after every render of the document. Images keep the last caps until the
  // next ask answers, since that ask is what revokes them.
  const images0 = images?.map ?? null
  useLayoutEffect(() => {
    const col = colEl.current
    const els = col ? Array.from(col.querySelectorAll<HTMLElement>('[data-src]')) : []
    const spans = els.map((el) => parseSpan(el.dataset.src) ?? { start: 0, end: 0 })
    blocks.current = { els, spans }
  }, [parsed, rendered, images0])
  useLayoutEffect(() => measure())
  useLayoutEffect(() => {
    const g = goal.current
    if (!g || g.row >= shown) return
    goal.current = null
    g.go()
  }, [shown])

  const hold = useRef<{ el: HTMLElement; until: number } | null>(null)
  const toTop = (el: Element): void => {
    const body = bodyEl.current
    if (!body) return
    const m = parseFloat(getComputedStyle(el).scrollMarginTop) || 0
    body.scrollTop += el.getBoundingClientRect().top - body.getBoundingClientRect().top - m
  }
  const pin = (el: HTMLElement): void => {
    toTop(el)
    hold.current = { el, until: Date.now() + HOLD_MS }
  }
  const unpin = (): void => {
    hold.current = null
  }
  const blockForLine = (n: number): HTMLElement | null => blocks.current.els[blockFor(blocks.current.spans, n)] ?? null

  useEffect(() => {
    if (!col) return
    const ro = new ResizeObserver(() => {
      const h = hold.current
      if (h && Date.now() < h.until && h.el.isConnected) toTop(h.el)
      else hold.current = null
      measureRef.current()
    })
    ro.observe(col)
    return () => ro.disconnect()
  }, [col])

  const wash = (el: HTMLElement, via: Via): void => {
    if (via !== 'pointer' || reducedMotion()) return
    setFlash(el)
  }
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), FLASH_MS)
    return () => clearTimeout(t)
  }, [flash])

  // Back: the link a click or Enter activated in the column, for the jump it starts.
  const followed = useRef<HTMLAnchorElement | null>(null)
  const backOf = (): { revision: string; places: BackPlace[] } | undefined => useSession.getState().sessions[handleId]?.surfaces.tabs[tabId]?.back
  const placeOf = (a: HTMLAnchorElement): BackPlace | null => {
    const href = a.getAttribute('href')
    const body = bodyEl.current
    if (!href || !body || !colEl.current) return null
    const nth = Array.from(colEl.current.querySelectorAll(`a[href="${CSS.escape(href)}"]`)).indexOf(a)
    return { line: body.scrollTop > 0 ? topLine() : 0, link: { line: spanAt(a)?.start ?? 0, href, nth } }
  }
  const goBack = (): void => {
    const b = backOf()
    const p = b?.places.at(-1)
    if (!p || !base || b?.revision !== revision) return
    setView(handleId, tabId, { back: b.places.length > 1 ? { revision: b.revision, places: b.places.slice(0, -1) } : undefined })
    reach(Math.max(rowOf(base.rows, p.line), rowOf(base.rows, p.link.line)), () => {
      const body = bodyEl.current
      if (!body) return
      const el = p.line ? blockForLine(p.line) : null
      if (el) pin(el)
      else {
        unpin()
        body.scrollTop = 0
      }
      const a = colEl.current?.querySelectorAll<HTMLElement>(`a[href="${CSS.escape(p.link.href)}"]`)[p.link.nth]
      ;(a ?? body).focus({ preventScroll: true })
    })
  }
  const backRef = useRef(goBack)
  backRef.current = goBack
  useEffect(
    () =>
      window.clui.onMenuAction((a) => {
        if (a === 'pane-back') backRef.current()
      }),
    []
  )
  // Entries are source lines, which a change can move, so Back never outlives the revision it was made in.
  const back = tab?.back
  useEffect(() => {
    if (back && revision !== null && back.revision !== revision) setView(handleId, tabId, { back: undefined })
  }, [back, revision, handleId, tabId, setView])

  const jump = (frag: string, via: Via, focus: boolean, from: HTMLAnchorElement | null): void => {
    const col = colEl.current
    const t = col?.querySelector<HTMLElement>(`[id="${CSS.escape(frag)}"]`) ?? col?.querySelector<HTMLElement>(`[id="${CSS.escape(`user-content-${frag}`)}"]`)
    if (!t) {
      const at = base ? rowWithId(base.rows, frag) : -1
      const row = at >= 0 || !base ? at : rowWithId(base.rows, `user-content-${frag}`)
      if (row >= shown) return reach(row, () => jumpRef.current(frag, via, focus, from))
      return say(`There's no heading "${frag}" in this file.`)
    }
    const place = from?.isConnected ? placeOf(from) : null
    const before = bodyEl.current?.scrollTop
    pin(t)
    if (place && revision !== null && bodyEl.current?.scrollTop !== before) {
      const b = backOf()
      setView(handleId, tabId, { back: { revision, places: [...(b?.revision === revision ? b.places : []), place].slice(-BACK_MAX) } })
    }
    if (focus) {
      if (!t.hasAttribute('tabindex') && t.tabIndex < 0) t.tabIndex = -1
      t.focus({ preventScroll: true })
    }
    wash(t.closest<HTMLElement>('[data-src]') ?? t, via)
  }
  const jumpRef = useRef(jump)
  jumpRef.current = jump
  const links = useMemo<DocLinks | null>(
    () => (path ? { base: path.slice(0, path.lastIndexOf('/')) || '/', images: images0, jump: (frag, via) => jumpRef.current(frag, via, true, followed.current) } : null),
    [path, images0]
  )

  // A re-render keeps the reader on the block they were at; a user open focuses the body.
  useLayoutEffect(() => {
    const n = keepLine.current
    if (n === null || !base) return
    keepLine.current = null
    reach(rowOf(base.rows, n), () => {
      const el = blockForLine(n)
      if (el) pin(el)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base])
  const openVia = useRef<Via>('keyboard')
  // A file going to Source leaves the request to Source.
  useLayoutEffect(() => {
    if (toSource || doc.t === 'loading' || !bodyEl.current) return
    const via = takeSurfaceFocus(tabId)
    if (!via) return
    openVia.current = via
    bodyEl.current.focus({ preventScroll: true })
  }, [doc.t, location, tabId, toSource])

  // A destination: an anchor from another file's link, or a line, which scrolls to its block and washes it.
  // Without one, a restored or swapped tab lands on the line it was left at.
  const applied = useRef<SurfaceLocation | null>(null)
  const placed = useRef(false)
  useLayoutEffect(() => {
    if (!base) return
    const first = !placed.current
    placed.current = true
    if (location && applied.current !== location) {
      applied.current = location
      const via = openVia.current
      openVia.current = 'keyboard'
      if (location.anchor) return jump(location.anchor, via, false, followed.current)
      const { line, endLine } = location
      if (line) {
        return reach(rowOf(base.rows, line), () => {
          const el = blockForLine(line)
          if (!el) return
          const claudes = !!highlight && highlight.start === line && highlight.end === (endLine ?? line)
          // Claude's range keeps its "pointed to" row in view: that row is what says the band is Claude's.
          const label = (claudes && colEl.current?.querySelector<HTMLElement>('[data-pointed]')) || el
          pin(label)
          if (!claudes) wash(el, via)
        })
      }
    }
    const v = useSession.getState().sessions[handleId]?.surfaces.tabs[tabId]?.viewState
    if (!first || v?.kind !== 'file' || v.topLine <= 1) return
    const top = v.topLine
    reach(rowOf(base.rows, top), () => {
      const el = blockForLine(top)
      if (el) pin(el)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, location])

  // A settled scroll and unmounting save the top block's line, the field Source keeps its place in.
  const viewTimer = useRef<ReturnType<typeof setTimeout>>()
  const saveTop = (): void => {
    if (!blocks.current.els.length) return
    const n = topLine()
    const v = useSession.getState().sessions[handleId]?.surfaces.tabs[tabId]?.viewState
    if (v?.kind === 'file' && v.topLine === n) return
    setView(handleId, tabId, { viewState: { kind: 'file', topLine: n, offsetPx: 0, scrollLeft: 0 } })
  }
  const saveRef = useRef(saveTop)
  saveRef.current = saveTop
  const flushTop = (): void => {
    clearTimeout(viewTimer.current)
    saveRef.current()
  }
  useLayoutEffect(() => flushTop, [])
  // Source reads its place as it mounts, which is before this unmounts, so a swap saves the place first.
  useEffect(
    () =>
      useSession.subscribe((s, prev) => {
        const mode = (st: typeof s): string | undefined => st.sessions[handleId]?.surfaces.tabs[tabId]?.mode
        if (mode(s) !== mode(prev)) flushTop()
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [handleId, tabId]
  )

  // Point waits for the read, since only text has blocks to point at. It never ends on blur: the button is outside.
  const pointing = usePointing(tabId)
  const asked = usePointRequest(tabId)
  useLayoutEffect(() => {
    if (toSource || !asked || doc.t === 'loading' || (!!parsed && !base) || !takePoint(tabId)) return
    if (pointing) {
      setPointing(tabId, false)
      clearTimeout(selSay.current)
      return say(POINT_OFF)
    }
    if (doc.t !== 'text' || !blocks.current.els.length) return say('This file has no lines to point at.')
    setPointing(tabId, true)
    bodyEl.current?.focus({ preventScroll: true })
    say("Pointing. Click a block's line number, or press Shift and an arrow key, to select. Enter adds it.")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, doc.t, base, toSource])
  useEffect(() => () => setPointing(tabId, false), [tabId])

  // Block selection: the File tab's line-number gestures, a block at a time.
  const anchor = useRef<Span | null>(null)
  const active = useRef<Span | null>(null)
  const down = useRef<{ x: number; y: number } | null>(null)
  const clearSelection = (): void => {
    anchor.current = active.current = null
    setSelection(null)
  }
  const pick = (b: Span, shift: boolean): void => {
    if (shift && anchor.current) {
      active.current = b
      return setSelection(joinSpans(anchor.current, b))
    }
    if (selection && selection.start === b.start && selection.end === b.end) return clearSelection()
    anchor.current = active.current = b
    setSelection(b)
  }
  const pickRef = useRef(pick)
  pickRef.current = pick
  const [held] = useState((): DiagramHost['held'] => new Map())
  const diagrams = useMemo<DiagramHost>(
    () => ({ selection, pointed: highlight, pick: (l, shift) => pickRef.current(l, shift), viewSource: (line, via) => viewSourceAt(handleId, tabId, line, via), held }),
    [selection, highlight, handleId, tabId, held]
  )
  const spanAt = (node: Node | null): Span | null => {
    const el = node instanceof Element ? node : node?.parentElement
    const b = el?.closest<HTMLElement>('[data-src]')
    return b && colEl.current?.contains(b) ? parseSpan(b.dataset.src) : null
  }

  const onColumnClick = (e: MouseEvent): void => {
    const num = e.target instanceof Element ? e.target.closest('[data-num]') : null
    const b = num ? spanAt(num) : null
    if (b) pick(b, e.shiftKey)
  }
  const onMouseUp = (): void => {
    const s = window.getSelection()
    if (!s || s.isCollapsed) return
    const a = spanAt(s.anchorNode)
    const b = spanAt(s.focusNode)
    if (!a || !b) return
    anchor.current = a
    active.current = b
    setSelection(joinSpans(a, b))
  }
  const onBodyClick = (e: MouseEvent): void => {
    const at = down.current
    down.current = null
    if (!selection || !at || e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    if (Math.hypot(e.clientX - at.x, e.clientY - at.y) > 3) return
    if (e.target instanceof Element && e.target.closest('[data-num], button, a, input, textarea')) return
    if (!window.getSelection()?.isCollapsed) return
    clearSelection()
  }

  // Hover shows one block's number. Moving left from a nested block crosses its container's padding on the way to the
  // gutter, so the inner block stays while the pointer is on its rows.
  const hovered = useRef<HTMLElement | null>(null)
  const hover = (next: HTMLElement | null): void => {
    if (next === hovered.current) return
    numOf(hovered.current)?.removeAttribute('data-show')
    numOf(next)?.setAttribute('data-show', '')
    hovered.current = next
  }
  const onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return
    const cur = hovered.current
    let next = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-src]') : null
    if (cur?.isConnected && (!next || next.contains(cur))) {
      const r = cur.getBoundingClientRect()
      if (e.clientY >= r.top && e.clientY < r.bottom) next = cur
    }
    hover(next)
  }

  const onRegionKey = (e: KeyboardEvent): void => {
    unpin()
    // A click on a wide diagram focuses its scroller, and Enter after it still adds.
    if (e.target !== e.currentTarget && !(e.target instanceof Element && e.target.matches('[data-ui="mermaid-scroll"]'))) return
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && selection) {
      e.preventDefault()
      return addSelection()
    }
    if (e.key === 'Escape') {
      if (!selection && !highlight && !pointing) return
      e.preventDefault()
      if (selection || highlight) return clearSelection()
      setPointing(tabId, false)
      clearTimeout(selSay.current)
      return say(POINT_OFF)
    }
    const { els, spans } = blocks.current
    if (!e.shiftKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || !els.length) return
    e.preventDefault()
    const body = bodyEl.current!
    if (!selection) {
      // The first block whose top is in view.
      const j = Math.min(firstBelow(body.getBoundingClientRect().top - 1), els.length - 1)
      anchor.current = active.current = spans[j]
      return setSelection(spans[j])
    }
    const from = active.current ?? selection
    const at = spans.findIndex((s) => s.start === from.start && s.end === from.end)
    const i = at >= 0 ? at : blockFor(spans, e.key === 'ArrowUp' ? selection.start : selection.end)
    const j = Math.max(0, Math.min(els.length - 1, i + (e.key === 'ArrowUp' ? -1 : 1)))
    anchor.current ??= { start: selection.start, end: selection.end }
    active.current = spans[j]
    setSelection(joinSpans(anchor.current, spans[j]))
    const r = els[j].getBoundingClientRect()
    const b = body.getBoundingClientRect()
    if (r.top < b.top || r.bottom > b.bottom) els[j].scrollIntoView({ block: 'nearest' })
  }

  // Find: the rendered text, marked with the Custom Highlight API so the DOM React owns is never touched.
  const [findOpen, setFindOpen] = useState(false)
  const { query, setQuery, deferred, current, setCurrent, input: findInput } = useFind(findOpen, setFindOpen, () => doc.t === 'text', (by) => stepFind(by))
  const [found, setFound] = useState(NOT_FOUND)
  const reveal = useRef(false)
  useLayoutEffect(() => {
    const q = findOpen ? deferred : ''
    // Each chunk would walk all the text again, so Find waits for the last.
    if (q && busy) return
    setFound(q && colEl.current ? findRanges(colEl.current, q) : NOT_FOUND)
  }, [findOpen, deferred, busy, rendered, images0])
  useEffect(() => {
    reveal.current = true
  }, [deferred])
  const activeRange = found.ranges[Math.min(current, found.ranges.length - 1)]
  useEffect(() => {
    if (!found.ranges.length) return
    CSS.highlights.set('md-find', new Highlight(...found.ranges))
    if (activeRange) {
      const a = new Highlight(activeRange)
      a.priority = 1
      CSS.highlights.set('md-find-active', a)
    }
    return () => {
      CSS.highlights.delete('md-find')
      CSS.highlights.delete('md-find-active')
    }
  }, [found, activeRange])
  useLayoutEffect(() => {
    const body = bodyEl.current
    // A reparse replaces rows before Find walks them again, and a range in a replaced row measures nothing.
    if (!reveal.current || !activeRange?.startContainer.isConnected || !body) return
    reveal.current = false
    const x = activeRange.startContainer.parentElement?.closest<HTMLElement>('.overflow-x-auto')
    const m = activeRange.getBoundingClientRect()
    if (x) {
      const xr = x.getBoundingClientRect()
      if (m.left < xr.left || m.right > xr.right) x.scrollLeft += m.left - xr.left - xr.width / 2
    }
    const b = body.getBoundingClientRect()
    const r = activeRange.getBoundingClientRect()
    if (r.top < b.top || r.bottom > b.bottom) body.scrollTop += r.top - (b.top + b.height / 2)
  }, [activeRange])

  const stepFind = (by: number): void => {
    const total = found.ranges.length
    if (!total || !activeRange?.startContainer.isConnected) return
    reveal.current = true
    setCurrent((c) => (((c + by) % total) + total) % total)
  }
  const closeFind = (): void => {
    setQuery('')
    setFindOpen(false)
    requestAnimationFrame(() => bodyEl.current?.focus())
  }
  const hasText = doc.t === 'text'

  const total = found.ranges.length
  const of = `${current + 1} of ${found.more ? '10,000+' : total.toLocaleString()}`
  const empty = text === ''
  const cut = !!parsed?.cut

  let content: JSX.Element | null = null
  if (doc.t === 'loading') {
    content = slow ? (
      <div className={STATE_BODY}>
        <p className="text-meta text-dim">{`Loading ${name}`}</p>
      </div>
    ) : null
  } else if (doc.t !== 'text') {
    content = <DocState handleId={handleId} tabId={tabId} path={path} doc={doc} load={load} reopen={reopen} />
  } else if (empty) {
    content = (
      <div className={STATE_BODY}>
        <p className="text-ui font-medium text-content">{`${name} is empty`}</p>
      </div>
    )
  } else if (parsed && links) {
    content = (
      <div
        ref={colRef}
        data-ui="markdown-column"
        data-pointing={pointing ? '' : undefined}
        className={COLUMN}
        onClick={onColumnClick}
        onClickCapture={(e) => {
          followed.current = e.target instanceof Element ? e.target.closest('a') : null
          // A self-link's anchor reaches the location effect within this task; no later jump may claim the link.
          setTimeout(() => (followed.current = null))
        }}
        onMouseDown={(e) => {
          // A gutter click picks lines, so a text selection left from earlier would claim different ones and ⌘C copy it.
          if (!(e.target instanceof Element && e.target.closest('[data-num]'))) return
          e.preventDefault()
          window.getSelection()?.removeAllRanges()
        }}
        onPointerMove={onPointerMove}
        onPointerLeave={() => hover(null)}
      >
        {notice && <SelectionNotice notice={notice} onDismiss={() => setNotice(null)} />}
        {parsed.fm && (
          <>
            {pointed && meets({ start: 1, end: parsed.fm.lines }, pointed) && <PointedRow label={pointed.label} />}
            <div data-src={`1-${parsed.fm.lines}`} className="my-4 first:mt-0">
              <GutterNum line={1} />
              <CodeBlock code={parsed.fm.code} lang="yaml" label="front matter" />
            </div>
          </>
        )}
        <DocContext.Provider value={links}>
          <FileLinkContext.Provider value={root}>
            <DiagramContext.Provider value={diagrams}>{rendered}</DiagramContext.Provider>
          </FileLinkContext.Provider>
        </DocContext.Provider>
        <div aria-hidden="true" data-bands="" className="pointer-events-none absolute inset-0 -z-10">
          {bands.map((b, i) => (
            <div key={i} className={`absolute inset-x-0 ${b.kind === 'sel' ? 'bg-line-selected' : b.kind === 'pointed' ? 'bg-bg-raised' : WASH}`} style={{ top: b.top, height: b.height }}>
              {b.kind === 'pointed' && <span className="absolute inset-y-0 left-[calc(var(--gut)-4px)] w-0.5 bg-dim" />}
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div data-ui="markdown-surface" className="flex h-full min-h-0 flex-col bg-bg pt-(--top-h)">
      {findOpen && (
        <div className="flex h-9 shrink-0 items-center border-b border-border bg-bg px-1">
          <FindField
            ui="markdown-find"
            inputRef={findInput}
            value={query}
            onChange={setQuery}
            onEnter={(shift) => stepFind(shift ? -1 : 1)}
            onClose={closeFind}
            onPrev={() => stepFind(-1)}
            onNext={() => stepFind(1)}
            stepDisabled={!total}
            countText={!deferred ? '' : total ? of : 'No matches'}
            statusText={!deferred ? '' : total ? `Match ${of}` : 'No matches'}
            placeholder="Find in preview"
            label={`Find in ${name}`}
          />
        </div>
      )}
      {cut && (
        <div data-ui="markdown-banner-top" className={BANNER}>
          Previewing the first 1 MB. The file is too large to preview in full.
          <button type="button" className={TEXT_BTN} onClick={() => setView(handleId, tabId, { mode: 'source' })}>
            Show source
          </button>
        </div>
      )}
      <div
        ref={bodyEl}
        role="region"
        aria-label={`${name}, preview`}
        aria-busy={doc.t === 'loading' || busy || undefined}
        tabIndex={0}
        data-ui="markdown-body"
        data-beside-header=""
        {...(doc.t === 'loading' ? {} : { 'data-pane-title': '' })}
        aria-keyshortcuts="Meta+Shift+A Meta+F Meta+["
        onKeyDown={onRegionKey}
        onWheel={unpin}
        onMouseDown={(e) => {
          unpin()
          down.current = { x: e.clientX, y: e.clientY }
        }}
        onMouseUp={onMouseUp}
        onClick={onBodyClick}
        onScroll={() => {
          clearTimeout(viewTimer.current)
          viewTimer.current = setTimeout(saveTop, VIEW_SETTLE_MS)
        }}
        className="@container/md min-h-0 flex-1 overflow-y-auto"
      >
        {content}
        {/* After the last block, so it says where the preview ends rather than claim the end from the top. */}
        {cut && !busy && (
          <div data-ui="markdown-banner-bottom" className={BANNER}>
            {"The rest of the file isn't previewed."}
            <button type="button" className={TEXT_BTN} onClick={() => setView(handleId, tabId, { mode: 'source' })}>
              Show source
            </button>
          </div>
        )}
      </div>
      {hasText && selection ? (
        <SelectionBar label={selectedText(selection)} attached={inTarget} onAdd={addSelection} />
      ) : pointing && hasText ? (
        <SelectionBar label={POINT_BLOCK_HINT} blocked={POINT_BLOCK_HINT} onBlocked={() => say(POINT_BLOCK_HINT)} attached={false} onAdd={addSelection} />
      ) : null}
      <span data-ui="markdown-live" className="sr-only" aria-live="polite">
        {said}
      </span>
    </div>
  )
}
