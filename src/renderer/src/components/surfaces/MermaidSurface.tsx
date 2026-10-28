import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { GutterNum, PointedRow } from '../Markdown'
import { DiagramContext, MermaidDiagram, type DiagramHost } from '../Mermaid'
import { SelectionBar } from './SelectionBar'
import { baseOf, DocState, rangeText, SelectionNotice, STATE_BODY, toLines, useFileDoc, viewSourceAt } from './fileDoc'
import { joinSpans, meets, type Span } from '../../lib/markdownDoc'
import { setPointing, takePoint, takeSurfaceFocus, usePointing, usePointRequest } from '../../lib/surfaceFocus'
import { POINT_BLOCK_HINT, POINT_OFF, selectedText } from '../../lib/refCopy'

const INNER = 'relative isolate py-6 pl-12 pr-6 [--gut:3rem] @max-[520px]/md:py-4 @max-[520px]/md:pl-10 @max-[520px]/md:pr-4 @max-[520px]/md:[--gut:2.5rem]'
// The diagram is the column's only block, so a band across it is the column less its padding.
const BAND = 'pointer-events-none absolute inset-x-0 top-6 bottom-6 -z-10 @max-[520px]/md:top-4 @max-[520px]/md:bottom-4'
const keep = (): void => {}

/** A `.mmd` or `.mermaid` file's Preview: one diagram, one block, from line 1 to its last line with text. */
export function MermaidSurface({ handleId, tabId }: { handleId: string; tabId: string }): JSX.Element {
  const bodyEl = useRef<HTMLDivElement>(null)
  const blockEl = useRef<HTMLDivElement>(null)
  const { tab, path, doc, slow, notice, setNotice, said, say, selection, setSelection, addSelection, inTarget, selSay, load, reopen } = useFileDoc(handleId, tabId, keep)
  const name = baseOf(path)
  const highlight = tab?.highlight?.lines ?? null
  const text = doc.t === 'text' ? doc.text : null
  const whole = useMemo<Span | null>(() => {
    const ls = text === null ? [] : toLines(text)
    for (let i = ls.length; i > 0; i--) if (ls[i - 1].trim()) return { start: 1, end: i }
    return null
  }, [text])
  const [state, setState] = useState<'pending' | 'drawn' | 'failed'>('pending')
  const drawn = state === 'drawn'
  const covered = !!selection && !!whole && selection.start <= whole.start && whole.end <= selection.end
  const pointed = !!highlight && !!whole && meets(whole, highlight)

  useLayoutEffect(() => {
    if (doc.t === 'loading' || !bodyEl.current || !takeSurfaceFocus(tabId)) return
    bodyEl.current.focus({ preventScroll: true })
  }, [doc.t, tab?.location, tabId])

  const anchor = useRef<Span | null>(null)
  const pick = (b: Span, shift: boolean): void => {
    if (shift && anchor.current) return setSelection(joinSpans(anchor.current, b))
    const again = !!selection && selection.start === b.start && selection.end === b.end
    anchor.current = again ? null : b
    setSelection(again ? null : b)
  }
  const pickRef = useRef(pick)
  pickRef.current = pick
  const [held] = useState((): DiagramHost['held'] => new Map())
  const host = useMemo<DiagramHost>(
    () => ({ selection, pointed: highlight, pick: (l, shift) => pickRef.current(l, shift), viewSource: (line, via) => viewSourceAt(handleId, tabId, line, via), held }),
    [selection, highlight, handleId, tabId, held]
  )

  useLayoutEffect(() => {
    blockEl.current?.querySelector('[data-num]')?.toggleAttribute('data-sel', covered)
  }, [covered, drawn])

  const pointing = usePointing(tabId)
  const asked = usePointRequest(tabId)
  useLayoutEffect(() => {
    if (!asked || doc.t === 'loading' || !takePoint(tabId)) return
    if (pointing) {
      setPointing(tabId, false)
      clearTimeout(selSay.current)
      return say(POINT_OFF)
    }
    if (!whole) return say('This file has no lines to point at.')
    setPointing(tabId, true)
    bodyEl.current?.focus({ preventScroll: true })
    say("Pointing. Click a block's line number, or press Shift and an arrow key, to select. Enter adds it.")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, doc.t, whole])
  useEffect(() => () => setPointing(tabId, false), [tabId])

  const onKey = (e: KeyboardEvent): void => {
    // A click on a wide diagram focuses its scroller, and Enter after it still adds.
    if (e.target !== e.currentTarget && !(e.target instanceof Element && e.target.matches('[data-ui="mermaid-scroll"]'))) return
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && selection) {
      e.preventDefault()
      return addSelection()
    }
    if (e.key === 'Escape') {
      if (!selection && !highlight && !pointing) return
      e.preventDefault()
      if (selection || highlight) {
        anchor.current = null
        return setSelection(null)
      }
      setPointing(tabId, false)
      clearTimeout(selSay.current)
      return say(POINT_OFF)
    }
    if (!e.shiftKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || !whole) return
    e.preventDefault()
    anchor.current = whole
    setSelection(whole)
  }
  const onClick = (e: MouseEvent): void => {
    const t = e.target instanceof Element ? e.target : null
    if (t?.closest('[data-num]') && whole) return pick(whole, e.shiftKey)
    if (!selection || e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || t?.closest('button')) return
    if (!window.getSelection()?.isCollapsed) return
    anchor.current = null
    setSelection(null)
  }
  const showNum = (on: boolean): void => void blockEl.current?.querySelector('[data-num]')?.toggleAttribute('data-show', on)

  let content: JSX.Element | null = null
  if (doc.t === 'loading') {
    content = slow ? (
      <div className={STATE_BODY}>
        <p className="text-meta text-dim">{`Loading ${name}`}</p>
      </div>
    ) : null
  } else if (doc.t !== 'text') {
    content = <DocState handleId={handleId} tabId={tabId} path={path} doc={doc} load={load} reopen={reopen} />
  } else if (!whole || text === null) {
    content = (
      <div className={STATE_BODY}>
        <p className="text-ui font-medium text-content">{`${name} is empty`}</p>
      </div>
    )
  } else {
    // One tree whatever the state, so the diagram never remounts as it draws; only a drawing is a selectable block.
    content = (
      <div data-pointing={pointing ? '' : undefined} className={drawn ? INNER : undefined}>
        {drawn && pointed && <PointedRow label={`Claude pointed to ${rangeText(highlight!, '–')}`} />}
        <div ref={blockEl} data-src={drawn ? `${whole.start}-${whole.end}` : undefined} onPointerEnter={(e) => e.pointerType === 'mouse' && showNum(true)} onPointerLeave={() => showNum(false)}>
          {drawn && <GutterNum line={1} />}
          <MermaidDiagram code={text} firstLine={1} lastLine={whole.end} name={name} onState={setState} />
        </div>
        {drawn && covered && <div aria-hidden="true" className={`${BAND} bg-line-selected`} />}
        {drawn && pointed && (
          <div aria-hidden="true" className={`${BAND} bg-bg-raised`}>
            <span className="absolute inset-y-0 left-[calc(var(--gut)-4px)] w-0.5 bg-dim" />
          </div>
        )}
      </div>
    )
  }

  const hasText = doc.t === 'text'
  return (
    <div data-ui="mermaid-surface" className="flex h-full min-h-0 flex-col bg-bg pt-(--top-h)">
      <div
        ref={bodyEl}
        role="region"
        aria-label={`${name}, preview`}
        aria-busy={doc.t === 'loading' || (!!whole && state === 'pending') || undefined}
        tabIndex={0}
        data-ui="mermaid-body"
        data-beside-header=""
        {...(doc.t === 'loading' ? {} : { 'data-pane-title': '' })}
        aria-keyshortcuts="Meta+Shift+A"
        onKeyDown={onKey}
        onClick={onClick}
        className="@container/md min-h-0 flex-1 overflow-y-auto"
      >
        {notice && <SelectionNotice notice={notice} onDismiss={() => setNotice(null)} />}
        <DiagramContext.Provider value={host}>{content}</DiagramContext.Provider>
      </div>
      {hasText && selection ? (
        <SelectionBar label={selectedText(selection)} attached={inTarget} onAdd={addSelection} />
      ) : pointing && hasText ? (
        <SelectionBar label={POINT_BLOCK_HINT} blocked={POINT_BLOCK_HINT} onBlocked={() => say(POINT_BLOCK_HINT)} attached={false} onAdd={addSelection} />
      ) : null}
      <span data-ui="mermaid-live" className="sr-only" aria-live="polite">
        {said}
      </span>
    </div>
  )
}
