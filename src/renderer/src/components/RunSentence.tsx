import { useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from 'react'
import { useActive, type ToolCall } from '../store'
import { changeReadOf, isChangeRead, sentenceOf } from '../lib/instrument'
import { Bead } from './InstrumentRow'
import { IconChevron } from './Icon'

/** The one dim line a run's folded routine calls read as. Opening it un-hides their rows in place, so open is the
 *  full log. */
export function RunSentence({
  tools,
  open,
  onToggle,
  controls,
  placement,
  seg,
  hidden,
  buttonRef
}: {
  tools: ToolCall[]
  open: boolean
  onToggle: (e: MouseEvent) => void
  /** Space-joined ids of the folded rows. */
  controls: string
  placement: 'spine' | 'inline'
  seg: 'through' | 'end'
  hidden: boolean
  buttonRef: RefObject<HTMLButtonElement>
}): JSX.Element {
  // A change read is named by the change it points at, which only the user message that sent it knows. One string,
  // so a streaming token re-runs the selector but re-renders nothing.
  const changes = tools.filter((t) => isChangeRead(t.name))
  const labels = useActive((s) => (s ? changes.map((t) => changeReadOf(s.messages, t.input)?.label ?? '').join('\0') : '')).split('\0')
  const labelOf = new Map(changes.map((t, i) => [t.id, labels[i] || null]))
  const changeLabel = (t: ToolCall): string | null => labelOf.get(t.id) ?? null
  const full = sentenceOf(tools, { changeLabel, bashNamed: Infinity })
  const fit = useClampFit(full.commands, full.plain, hidden)
  const { parts, plain } = fit.named < full.commands ? sentenceOf(tools, { changeLabel, bashNamed: fit.named }) : full
  const n = tools.length
  return (
    <div data-ui="run-sentence" hidden={hidden} className={placement === 'spine' ? 'spine-seg' : 'relative'} data-seg={placement === 'spine' ? seg : undefined}>
      {placement === 'spine' && <Bead state="done" lit={false} placement="spine" />}
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={controls || undefined}
        aria-label={`${n} ${n === 1 ? 'call' : 'calls'}: ${plain}`}
        title={full.plain}
        aria-description={fit.named < full.commands ? full.plain : undefined}
        onClick={onToggle}
        className="group/sentence grid w-full items-start gap-2 rounded-md py-1 pl-2 pr-1.5 text-left text-meta pointer-fine:hover:bg-row-hover focus-visible:outline-offset-[-2px]"
        style={{ gridTemplateColumns: placement === 'inline' ? '8px minmax(0,1fr) 24px' : 'minmax(0,1fr) 24px' }}
      >
        {placement === 'inline' && (
          <span className="flex h-4 items-center">
            <Bead state="done" lit={false} placement="inline" bare />
          </span>
        )}
        <span ref={fit.ref} className={`line-clamp-2 break-words ${open ? 'text-content' : 'text-dim'}`}>
          {parts.map((p, i) => (p.mono ? <span key={i} className="font-mono">{p.text}</span> : <span key={i}>{p.text}</span>))}
        </span>
        <span className="flex h-4 items-center justify-center text-faint" aria-hidden="true">
          <IconChevron
            className={`h-4 w-4 transition-transform [transition-duration:var(--dur-fast)] [transition-timing-function:var(--ease-out)] ${
              open ? 'rotate-90' : 'opacity-0 pointer-fine:group-hover/sentence:opacity-100 group-focus-visible/sentence:opacity-100'
            }`}
          />
        </span>
      </button>
    </div>
  )
}

/** How many commands the sentence names before it would pass its 2-line clamp: a binary search over renders in a layout
 *  effect, so every pass lands before paint, redone when the sentence or its width changes. Measured, because the
 *  clamp's width moves between the main column, a tab and a column narrowed by the pane, and the line mixes sans and
 *  mono. When even zero names overflow, the clamp's ellipsis and the title carry the rest. */
function useClampFit(total: number, sentence: string, hidden: boolean): { named: number; ref: RefObject<HTMLSpanElement> } {
  const ref = useRef<HTMLSpanElement>(null)
  const [named, setNamed] = useState(total)
  const [resized, setResized] = useState(0)
  // `lo` names fit (0 always counts), `hi` names overflowed, `w` the width the search ran at.
  const search = useRef({ key: '', lo: 0, hi: 0, w: 0 })
  const key = `${total}\0${sentence}\0${resized}`
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || hidden || !total) return
    if (search.current.key !== key) {
      search.current = { key, lo: 0, hi: total + 1, w: el.clientWidth }
      if (named !== total) return setNamed(total)
    }
    const s = search.current
    if (el.scrollHeight > el.clientHeight) s.hi = Math.min(s.hi, named)
    else s.lo = Math.max(s.lo, named)
    const next = s.hi - s.lo > 1 ? (s.lo + s.hi) >> 1 : s.lo
    if (next !== named) setNamed(next)
  }, [key, named, hidden, total])
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !total) return
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== search.current.w) setResized((r) => r + 1)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [total])
  return { named: Math.min(named, total), ref }
}
