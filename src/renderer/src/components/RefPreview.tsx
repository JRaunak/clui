import { useEffect, useState, type CSSProperties } from 'react'
import { hostOf, pinWords, type SentPin } from '../../../shared/annotate'
import { refKey, type ContextReference, type LineRange } from '../../../shared/context'
import type { Refusal, TextRead } from '../../../shared/files'
import { highlightTexts, langForPath } from '../lib/highlight'
import { baseOf, changeWords } from '../lib/refCopy'
import { changeRows, fileLines, fileWindow, PEEK_ROWS, type PeekRow } from '../lib/peek'
import { Code, DiffLine } from './surfaces/HunkView'
import { IconWarn } from './Icon'

/** What a card's preview holds. `gone` hides Open and Add; `plain` keeps both; `lost` is a change Clui no longer holds.
 *  Folder, browser and legacy previews show the record and never leave `loading`. */
export type Peek =
  | { t: 'loading' }
  | { t: 'code'; rows: PeekRow[]; html: (string | null)[] | null; diff: boolean; label: string; footer: string; bytes?: number }
  | { t: 'stale' }
  | { t: 'gone'; text: string }
  | { t: 'plain'; text: string }
  | { t: 'lost' }

export const STALE_TEXT = 'Source changed. Select it again.'
const LOST_TEXT = 'Not available. Clui no longer has this change.'
const SLOW_MS = 400
const lines = (n: number): string => `${n.toLocaleString()} ${n === 1 ? 'line' : 'lines'}`
const spokenLines = ({ start, end }: LineRange): string => (end > start ? `Lines ${start} to ${end}` : `Line ${start}`)

type FileRef = Extract<ContextReference, { kind: 'file' }>

/** A read of a file reference's source, as the card shows it. Highlighting comes after. */
export function readPeek(read: TextRead | Refusal | null, r: FileRef): Exclude<Peek, { t: 'loading' | 'lost' }> {
  const name = baseOf(r.path)
  if (!read) return { t: 'gone', text: 'Not available.' }
  if (!read.ok) {
    if (read.reason === 'missing') return { t: 'gone', text: `Not available. ${name} no longer exists.` }
    return read.reason === 'too-large' ? { t: 'plain', text: 'No preview: the file is too large.' } : { t: 'gone', text: 'Not available.' }
  }
  // A line reference names lines of one revision; another revision's lines under its name would be a replacement.
  if (r.lines && `sha256:${read.revision}` !== r.sourceVersion) return { t: 'stale' }
  if (read.binary || read.unsupportedEncoding) return { t: 'plain', text: 'No preview for this file.' }
  const all = fileLines(read.text)
  const w = fileWindow(all.length, r.lines)
  if (r.lines && read.truncated && r.lines.end > all.length) return { t: 'plain', text: 'No preview: the file is too large.' }
  const sel = r.lines
  const rows = all.slice(w.start - 1, w.end).map((text, i): PeekRow => {
    const n = w.start + i
    return { kind: ' ', text, n, selected: !!sel && n >= sel.start && n <= sel.end }
  })
  if (!sel) return { t: 'code', rows, html: null, diff: false, label: `First ${lines(rows.length)} of ${name}.`, footer: all.length > PEEK_ROWS ? `${lines(all.length)}. Open to see all.` : '' }
  const more = sel.end - sel.start + 1 - PEEK_ROWS
  return {
    t: 'code',
    rows,
    html: null,
    diff: false,
    label: `${spokenLines(w)} of ${name}. ${spokenLines(sel)} ${sel.end > sel.start ? 'are' : 'is'} selected.`,
    footer: more > 0 ? `${more} more ${more === 1 ? 'line' : 'lines'} selected. Open to see all.` : ''
  }
}

/** Rows the well will hold, so it keeps its height while the read is out. A file shorter than the window is the
 *  one case that shrinks once it lands. */
function expectedRows(r: ContextReference): number {
  if (r.kind === 'file') return PEEK_ROWS
  if (r.kind !== 'change') return 0
  const len = (x?: LineRange): number => (x ? x.end - x.start + 1 : 0)
  return Math.min(PEEK_ROWS, r.side === 'before' ? len(r.old) : r.side === 'after' ? len(r.new) : Math.max(len(r.old), len(r.new)))
}

/** Reads what a file or change reference points at, from the record (never the ledger's current hunk), each time
 *  the card opens: the source can move on between two looks. `abs` is its resolved path. Folder, browser and legacy
 *  references read nothing. */
export function usePeek(handleId: string, r: ContextReference | null, abs: string, open: boolean): [Peek, (p: Peek) => void] {
  const [peek, setPeek] = useState<Peek>({ t: 'loading' })
  const key = r ? `${refKey(r)}\0${abs}` : ''
  useEffect(() => {
    // Reset on close, so the next open never paints the last look's preview.
    if (!open || !r || (r.kind !== 'file' && r.kind !== 'change')) return setPeek({ t: 'loading' })
    let live = true
    setPeek({ t: 'loading' })
    // The whole text is highlighted, not the slice, so a slice starting inside a block comment still colours right.
    const highlight = (p: Peek, texts: string[], from: number): void => {
      if (!live) return
      setPeek(p)
      if (p.t !== 'code') return
      void highlightTexts(langForPath(abs), [texts.join('\n')]).then(([out]) => {
        if (live && out) setPeek({ ...p, html: p.rows.map((_, i) => out[from + i] ?? null) })
      })
    }
    if (r.kind === 'file') {
      window.clui
        .readText(handleId, abs)
        .catch(() => null)
        .then((read) => {
          const p = readPeek(read, r)
          highlight(p, read?.ok ? fileLines(read.text) : [], p.t === 'code' ? (p.rows[0]?.n ?? 1) - 1 : 0)
        })
    } else {
      window.clui
        .changeRefPeek(handleId, r.changeRef)
        .catch(() => ({ ok: false }) as const)
        .then((s) => {
          if (!s.ok) return live && setPeek({ t: 'lost' })
          const all = changeRows(s.text, s.side, s.old, s.new)
          const more = all.length - PEEK_ROWS
          highlight(
            {
              t: 'code',
              rows: all.slice(0, PEEK_ROWS),
              html: null,
              diff: s.side === 'diff',
              label: `Claude's change to ${baseOf(r.path)}, ${changeWords(r)}.`,
              footer: more > 0 ? `${more} more ${more === 1 ? 'line' : 'lines'}. Open to see all.` : '',
              bytes: s.bytes
            },
            all.map((row) => row.text),
            0
          )
        })
    }
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleId, key, open])
  return [peek, setPeek]
}

const WELL = 'max-h-[min(20rem,40vh)] overflow-auto rounded-md border border-border bg-bg'
const NOTE = 'text-meta text-dim'

/** The preview a chip card shows between its header and its note: the code well, a state line, or the record. */
export function RefPreview({ r, legacy, crop, alt, peek, stateId }: {
  r: ContextReference | null
  legacy?: SentPin
  crop?: string
  alt: string
  peek: Peek
  stateId: string
}): JSX.Element | null {
  const [slow, setSlow] = useState(false)
  // Keyed on the object: every open sets a fresh `loading`, so the clock restarts with each read.
  useEffect(() => {
    setSlow(false)
    if (peek.t !== 'loading') return
    const t = setTimeout(() => setSlow(true), SLOW_MS)
    return () => clearTimeout(t)
  }, [peek])

  const img = crop ? <img src={crop} alt={alt} className="max-h-60 w-full rounded-md border border-border bg-bg object-contain" /> : null
  if (legacy)
    return (
      <div className="mt-3 flex flex-col gap-2">
        {img}
        {legacy.host && <Facts rows={[['Page', legacy.host, 'truncate font-mono text-content']]} />}
        <p className={NOTE}>Older message: only the element and the site were kept.</p>
      </div>
    )
  if (!r) return null
  if (r.kind === 'folder') return <p className={`mt-3 ${NOTE}`}>Folder. Claude lists it with its own tools.</p>
  if (r.kind === 'browser') {
    const t = r.pin.target
    let page = ''
    try {
      const u = new URL(t.url)
      page = `${u.host}${u.pathname === '/' ? '' : u.pathname}`
    } catch {
      page = hostOf(t.url)
    }
    const facts: Fact[] = []
    if (page) facts.push(['Page', page, 'truncate font-mono text-content'])
    if (t.text && t.text !== pinWords(t).name) facts.push(['Text', t.text, 'line-clamp-2 break-words text-content'])
    if (t.selector) facts.push(['Selector', t.selector, 'truncate font-mono text-faint'])
    if (!img && !facts.length) return null
    return (
      <div className="mt-3 flex flex-col gap-2">
        {img}
        {facts.length > 0 && <Facts rows={facts} />}
      </div>
    )
  }

  switch (peek.t) {
    case 'loading':
      return (
        <div
          role="region"
          tabIndex={0}
          aria-label="Loading preview"
          aria-busy="true"
          className={`mt-3 flex items-center justify-center ${WELL}`}
          style={{ minHeight: `min(calc(${expectedRows(r) * 1.25}rem + 2px), 20rem, 40vh)` }}
        >
          {slow && <span className={NOTE}>Loading…</span>}
        </div>
      )
    case 'code': {
      const last = peek.rows.at(-1)
      const widest = peek.diff ? Math.max(...peek.rows.map((x) => Math.max(x.oldNo ?? 0, x.newNo ?? 0))) : (last?.n ?? 1)
      return (
        <>
          <div
            role="region"
            tabIndex={0}
            aria-label={peek.label}
            data-ui="ref-well"
            className={`mt-3 ${WELL}`}
            style={{ '--num-ch': `${String(Math.max(widest, 1)).length}ch` } as CSSProperties}
          >
            {peek.rows.map((row, i) =>
              peek.diff ? (
                <DiffLine key={i} kind={row.kind} oldNo={row.oldNo} newNo={row.newNo} text={row.text} html={peek.html?.[i]} />
              ) : (
                <div key={i} data-line={row.n} className={`flex font-mono text-code ${row.selected ? 'bg-line-selected' : ''}`}>
                  <span aria-hidden="true" className={`box-content w-(--num-ch) shrink-0 select-none pl-3 pr-1 text-right tabular-nums ${row.selected ? 'text-content' : 'text-faint'}`}>
                    {row.n}
                  </span>
                  <span aria-hidden="true" className="w-3 shrink-0" />
                  <Code kind=" " text={row.text} html={peek.html?.[i]} />
                </div>
              )
            )}
          </div>
          {peek.footer && <p className={`mt-1 ${NOTE}`}>{peek.footer}</p>}
        </>
      )
    }
    case 'stale':
      return (
        <div id={stateId} data-ui="ref-stale" className="mt-3 flex min-h-8 items-center gap-2 rounded-md bg-warn/10 px-2 py-1 text-meta text-content">
          <IconWarn className="h-3.5 w-3.5 shrink-0 text-warn" aria-hidden="true" />
          {STALE_TEXT}
        </div>
      )
    case 'gone':
    case 'plain':
      return (
        <p id={stateId} className={`mt-3 ${NOTE}`}>
          {peek.text}
        </p>
      )
    case 'lost':
      return (
        <p id={stateId} className={`mt-3 ${NOTE}`}>
          {LOST_TEXT}
        </p>
      )
    default:
      return peek satisfies never
  }
}

type Fact = [label: string, value: string, tone: string]

function Facts({ rows }: { rows: Fact[] }): JSX.Element {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-meta">
      {rows.map(([label, value, tone]) => (
        <div key={label} className="contents">
          <dt className="text-dim">{label}</dt>
          <dd title={value} className={`min-w-0 ${tone}`}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  )
}
