import { useMemo, type MouseEvent } from 'react'
import { diffLines } from 'diff'
import { escapeHtml } from '../../lib/highlightLines'
import { highlightNow, langForPath } from '../../lib/highlight'

export type LineKind = ' ' | '+' | '-'

const SIGN: Record<LineKind, string> = { ' ': '', '+': '+', '-': '−' }
const TINT: Record<LineKind, string> = { ' ': '', '+': 'bg-add-surface', '-': 'bg-del-surface' }
const SAID: Record<LineKind, string> = { ' ': '', '+': 'Added: ', '-': 'Removed: ' }
const LONG_LINE = 2000
/** The Gate highlights synchronously so it paints complete before the user decides; past this many lines it stays plain rather than block. */
const GATE_SYNC_LINES = 200
const GATE_ROWS = 40
const NUM = 'box-content w-(--num-ch) shrink-0 select-none px-1.5 text-right tabular-nums'
/** The Claude changes surface's selection mark on rows and hunk headers, contiguous so a range reads as one bar. */
export const SELECTED_MARK = 'before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-content'
const SIGN_TONE: Record<LineKind, string> = { ' ': 'text-dim', '+': 'text-diff-add-sign', '-': 'text-diff-del-sign' }
const signCell = (kind: LineKind): string => `w-5 shrink-0 select-none text-center ${SIGN_TONE[kind]}`

/** A line's code: its highlighted HTML when there is some, else the escaped text. A very long line shows its head. */
export function Code({ kind, text, html }: { kind: LineKind; text: string; html?: string | null }): JSX.Element {
  const long = text.length > LONG_LINE
  const body = long || !html ? escapeHtml(long ? text.slice(0, LONG_LINE) : text) : html
  return (
    <span className="hljs min-w-0 flex-1 whitespace-pre-wrap pr-3 [overflow-wrap:anywhere] [tab-size:4]">
      {SAID[kind] && <span className="sr-only select-none">{SAID[kind]}</span>}
      {/* highlight.js escapes the source it marks up; plain text goes through escapeHtml. */}
      <span dangerouslySetInnerHTML={{ __html: body }} />
      {long && <span className="select-none text-faint">{` … ${(text.length - LONG_LINE).toLocaleString()} more characters`}</span>}
    </span>
  )
}

/** One numbered row of a Claude changes diff, tinted across the gutter too. Its three gutter cells select it;
 *  `row` names it for a drag across code. A selected row keeps its tint: a fill would hide what it removed or added. */
export function DiffLine({
  kind,
  oldNo,
  newNo,
  text,
  html,
  selected = false,
  onGutter,
  row
}: {
  kind: LineKind
  oldNo?: number
  newNo?: number
  text: string
  html?: string | null
  selected?: boolean
  onGutter?: (shift: boolean) => void
  row?: { hunk: string; j: number }
}): JSX.Element {
  const gutter = onGutter
    ? { onClick: (e: MouseEvent) => onGutter(e.shiftKey), onMouseDown: (e: MouseEvent) => e.shiftKey && e.preventDefault() }
    : {}
  const num = `${NUM} cursor-default ${selected ? 'text-content' : 'text-faint'}`
  return (
    <div data-row-hunk={row?.hunk} data-row={row?.j} className={`relative flex min-h-5 font-mono text-code ${TINT[kind]} ${selected ? SELECTED_MARK : ''}`}>
      <span aria-hidden="true" className={num} {...gutter}>{oldNo}</span>
      <span aria-hidden="true" className={num} {...gutter}>{newNo}</span>
      <span aria-hidden="true" className={`${signCell(kind)} cursor-default`} {...gutter}>{SIGN[kind]}</span>
      <Code kind={kind} text={text} html={html} />
    </div>
  )
}

export interface GateEdit {
  label?: string
  before: string
  after: string
}

interface Row {
  kind: LineKind
  text: string
  html: string | null
}

const splitLines = (value: string): string[] => {
  const ls = value.split('\n')
  if (ls.at(-1) === '') ls.pop()
  return ls
}

function rowsOf(lang: string | null, before: string, after: string): Row[] {
  const sync = splitLines(before).length + splitLines(after).length <= GATE_SYNC_LINES
  const oldHtml = sync ? highlightNow(lang, before) : null
  const newHtml = sync ? highlightNow(lang, after) : null
  const rows: Row[] = []
  let o = 0
  let n = 0
  for (const c of diffLines(before, after)) {
    for (const text of splitLines(c.value)) {
      if (c.removed) rows.push({ kind: '-', text, html: oldHtml?.[o] ?? null })
      else if (c.added) rows.push({ kind: '+', text, html: newHtml?.[n] ?? null })
      else rows.push({ kind: ' ', text, html: newHtml?.[n] ?? null })
      if (!c.added) o++
      if (!c.removed) n++
    }
  }
  return rows
}

/** The permission Gate's diff of a pending edit: interleaved rows with signs, no line numbers (a snippet has no file coordinates). */
export function HunkView({ path, edits }: { path: string; edits: GateEdit[] }): JSX.Element {
  const lang = langForPath(path)
  const sections = useMemo(() => edits.map((e) => rowsOf(lang, e.before, e.after)), [lang, edits])
  return (
    <div className="max-h-[32vh] overflow-auto rounded-md border border-border bg-tool">
      {sections.map((rows, i) => {
        const more = rows.length - GATE_ROWS
        return (
          <div key={i} className={i > 0 ? 'border-t border-border' : ''}>
            {edits[i].label && <div className="px-3 py-1 text-caps uppercase text-dim">{edits[i].label}</div>}
            {rows.slice(0, GATE_ROWS).map((r, j) => (
              <div key={j} className={`flex min-h-5 font-mono text-code ${TINT[r.kind]}`}>
                <span aria-hidden="true" className={signCell(r.kind)}>{SIGN[r.kind]}</span>
                <Code kind={r.kind} text={r.text} html={r.html} />
              </div>
            ))}
            {more > 0 && <div className="px-3 py-1 text-meta text-faint">{`${more} more ${more === 1 ? 'line' : 'lines'}`}</div>}
          </div>
        )
      })}
    </div>
  )
}
