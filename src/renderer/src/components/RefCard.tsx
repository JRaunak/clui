import { useId, type KeyboardEvent } from 'react'
import { hostOf } from '../../../shared/annotate'
import { changeTail, refLabel, relativeTo, REF_NOTE_MAX, type ContextReference, type DraftReference } from '../../../shared/context'
import { useSession, type RefTarget } from '../store'
import { rangeText, spokenRef } from '../lib/refCopy'
import { viaOf, type Via } from '../lib/motion'
import type { usePopover } from './Popover'
import { Button } from './Button'
import { BADGE } from './ContextChip'

type Pop = ReturnType<typeof usePopover<HTMLDivElement>>

/** The counter shows from here, so it never sits on screen for a short note. */
const COUNT_FROM = 1800
const count = new Intl.NumberFormat()

function headOf(r: ContextReference, cwd: string | null): { main: string; tail: string } {
  switch (r.kind) {
    case 'file':
      return { main: relativeTo(cwd, r.path), tail: r.lines ? rangeText(r.lines) : '' }
    case 'folder':
      return { main: relativeTo(cwd, r.path), tail: '' }
    case 'browser':
      return { main: refLabel(r), tail: hostOf(r.pin.target.url) }
    case 'change':
      return { main: relativeTo(cwd, r.path), tail: changeTail(r.side, r.old, r.new) }
    default:
      return r satisfies never
  }
}

/**
 * The card a reference chip opens: what it points at, and the user's note for Claude. The panel stays mounted
 * for the popover; `d` is the reference shown, absent until one is. `onOpen` is there only when the chip opens.
 */
export function RefCard({ pop, handleId, target, d, n, cwd, onOpen }: {
  pop: Pop
  handleId: string
  target: RefTarget
  d: DraftReference | undefined
  n: number
  cwd: string | null
  onOpen?: (via: Via) => void
}): JSX.Element {
  const setRefNote = useSession((s) => s.setRefNote)
  const noteId = useId()
  const countId = useId()
  const note = d?.ref.note ?? ''
  const counted = note.length >= COUNT_FROM

  // A non-modal popover whose focus wanders off leaves a panel nobody is in, so Tab cycles inside it.
  const trap = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Tab') return
    const els = [...e.currentTarget.querySelectorAll<HTMLElement>('textarea, button')]
    const first = els[0]
    const last = els.at(-1)
    if (!first || !last) return
    const at = document.activeElement
    if (e.shiftKey && (at === first || at === e.currentTarget)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && at === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const head = d && headOf(d.ref, cwd)
  return (
    <div
      {...pop.popoverProps}
      data-ui="ref-card"
      role="dialog"
      aria-label={d ? spokenRef(d.ref) : undefined}
      tabIndex={-1}
      onKeyDown={trap}
      className="pop-base pop glass-thick w-[min(440px,calc(100vw-32px))] rounded-lg p-3"
    >
      {d && head && (
        <>
          <div className="flex min-w-0 items-center gap-2">
            <span aria-hidden="true" className={BADGE}>
              {n}
            </span>
            <span title={head.main} className="min-w-0 truncate text-xs font-medium text-content">
              {head.main}
            </span>
            {head.tail && <span className="shrink-0 font-mono text-meta text-dim">{head.tail}</span>}
          </div>
          <label htmlFor={noteId} className="mt-3 mb-1 block text-meta text-dim">
            Note for Claude
          </label>
          <textarea
            id={noteId}
            data-ui="ref-note"
            rows={2}
            maxLength={REF_NOTE_MAX}
            value={note}
            placeholder="Optional. Sent with this reference."
            aria-describedby={counted ? countId : undefined}
            onChange={(e) => setRefNote(handleId, d.ref.id, e.target.value, target)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
              e.preventDefault()
              pop.close({ via: 'keyboard' })
            }}
            className="[field-sizing:content] max-h-32 w-full resize-none rounded-md border border-control-edge bg-bg px-2 py-1.5 text-sm leading-normal text-content placeholder:text-dim"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            {counted && (
              <span id={countId} className="font-mono text-meta tabular-nums text-dim">
                {count.format(note.length)} / {count.format(REF_NOTE_MAX)}
              </span>
            )}
            {onOpen && (
              <Button
                variant="control"
                size="sm"
                onClick={(e) => {
                  onOpen(viaOf(e))
                  pop.close({ returnFocus: false })
                }}
              >
                Open
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
