import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react'
import { FIND_MAX, findRanges, useFind } from '../components/surfaces/fileDoc'

const NOT_FOUND: { ranges: Range[]; more: boolean } = { ranges: [], more: false }
/** A transcript's buttons can carry its content, such as a spawned agent's card, so only chrome marked
 *  `data-find-skip` is passed over. */
const SKIP = '[data-num], .sr-only, [data-find-skip], [data-pointed]'

/** A match past a truncated row's ellipsis is lit off its clipped edge, so the box clipping it, the first ancestor
 *  below `stop` that overflows sideways, scrolls to show it. `shifted` holds the box last scrolled; it goes back once the
 *  match leaves it, or when `range` is undefined because find closed or nothing matched. */
export function revealAcross(shifted: MutableRefObject<HTMLElement | null>, range: Range | undefined, stop: HTMLElement | null): void {
  let box = range?.startContainer.parentElement ?? null
  while (box && box !== stop && !(box.scrollWidth > box.clientWidth && getComputedStyle(box).overflowX !== 'visible')) box = box.parentElement
  if (box === stop) box = null
  const was = shifted.current
  if (was && was !== box) {
    was.scrollLeft = 0
    delete was.dataset.findReveal
  }
  shifted.current = box
  if (!box || !range) return
  box.dataset.findReveal = ''
  box.scrollLeft = Math.max(0, range.getBoundingClientRect().right + box.scrollLeft - (box.getBoundingClientRect().right - 16))
}

/**
 * ⌘F over a tab's rendered transcript: DOM ranges marked with the Custom Highlight API, so the DOM React owns is
 * never touched. `deps` re-runs the match when the entries change, so a live transcript's matches follow the
 * stream. Esc returns focus to where it was when ⌘F was pressed, else the active tab.
 */
export function useTranscriptFind(body: RefObject<HTMLElement>, deps: readonly unknown[], canFind: () => boolean) {
  const [open, setOpen] = useState(false)
  const origin = useRef<HTMLElement | null>(null)
  const { query, setQuery, deferred, current, setCurrent, input } = useFind(
    open,
    (on) => {
      if (on) origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setOpen(on)
    },
    canFind,
    (by) => step(by)
  )
  const [found, setFound] = useState(NOT_FOUND)
  const reveal = useRef(false)
  useLayoutEffect(() => {
    const q = open ? deferred : ''
    setFound(q && body.current ? findRanges(body.current, q, SKIP) : NOT_FOUND)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, deferred, ...deps])
  useEffect(() => {
    reveal.current = true
  }, [deferred])
  const activeRange = found.ranges[Math.min(current, found.ranges.length - 1)]
  useEffect(() => {
    if (!found.ranges.length) return
    CSS.highlights.set('transcript-find', new Highlight(...found.ranges))
    if (activeRange) {
      const a = new Highlight(activeRange)
      a.priority = 1
      CSS.highlights.set('transcript-find-active', a)
    }
    return () => {
      CSS.highlights.delete('transcript-find')
      CSS.highlights.delete('transcript-find-active')
    }
  }, [found, activeRange])
  const shifted = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const el = body.current
    if (!activeRange) revealAcross(shifted, undefined, el)
    if (!reveal.current || !activeRange?.startContainer.isConnected || !el) return
    reveal.current = false
    const b = el.getBoundingClientRect()
    const r = activeRange.getBoundingClientRect()
    if (r.top < b.top || r.bottom > b.bottom) el.scrollTop += r.top - (b.top + b.height / 2)
    revealAcross(shifted, activeRange, el)
  }, [activeRange, body])

  const total = found.ranges.length
  function step(by: number): void {
    if (!total || !activeRange?.startContainer.isConnected) return
    reveal.current = true
    setCurrent((c) => (((c + by) % total) + total) % total)
  }
  const close = (): void => {
    setQuery('')
    setOpen(false)
    const back = origin.current
    requestAnimationFrame(() => (back?.isConnected ? back : document.querySelector<HTMLElement>('[data-ui="surface-tabs"] [aria-selected="true"]'))?.focus())
  }
  const of = `${current + 1} of ${found.more ? `${FIND_MAX.toLocaleString()}+` : total.toLocaleString()}`
  return {
    open,
    field: {
      inputRef: input,
      value: query,
      onChange: setQuery,
      onEnter: (shift: boolean) => step(shift ? -1 : 1),
      onClose: close,
      onPrev: () => step(-1),
      onNext: () => step(1),
      stepDisabled: !total,
      countText: !deferred ? '' : total ? of : 'No matches',
      statusText: !deferred ? '' : total ? `Match ${of}` : 'No matches'
    }
  }
}
