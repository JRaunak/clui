import { useId, type KeyboardEvent } from 'react'
import { hostOf, type SentPin } from '../../../shared/annotate'
import { changeTail, imageTail, refLabel, relativeTo, REF_NOTE_MAX, type ContextReference, type DraftReference, type RefInput } from '../../../shared/context'
import { useActive, useSession, type RefTarget } from '../store'
import { rangeText, spokenRef } from '../lib/refCopy'
import { viaOf, type Via } from '../lib/motion'
import { absOf } from '../lib/peek'
import { openFileAt } from '../lib/openLink'
import type { usePopover } from './Popover'
import { Button } from './Button'
import { BADGE, legacyChip } from './ContextChip'
import { addFromSurface } from './ContextChips'
import { readPeek, RefPreview, STALE_TEXT, usePeek } from './RefPreview'

type Pop = Pick<ReturnType<typeof usePopover>, 'popoverProps' | 'close' | 'open'>

/** What a card shows: a draft reference (its note editable), a sent record, or a legacy pin read back. A sent
 *  change chip main already called unavailable is not `addable`. */
export type CardRef =
  | { form: 'draft'; d: DraftReference; target: RefTarget }
  | { form: 'sent'; ref: ContextReference; crop?: string; addable: boolean }
  | { form: 'legacy'; pin: SentPin; crop?: string }

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
    case 'page':
      return { main: refLabel(r), tail: relativeTo(cwd, r.path) }
    case 'change':
      return { main: relativeTo(cwd, r.path), tail: changeTail(r.side, r.old, r.new) }
    case 'image':
      return { main: relativeTo(cwd, r.path), tail: imageTail(r) }
    default:
      return r satisfies never
  }
}

/**
 * The card a reference chip opens: what it points at, previewed from the record that went or will go to Claude,
 * and the user's note. The panel stays mounted for the popover; `shown` is absent until a chip opens it.
 * `onOpen` is there only when the chip opens something.
 */
export function RefCard({ pop, handleId, shown, n, cwd, onOpen }: {
  pop: Pop
  handleId: string
  shown: CardRef | undefined
  n: number
  cwd: string | null
  onOpen?: (via: Via) => void
}): JSX.Element {
  const setRefNote = useSession((s) => s.setRefNote)
  const announce = useSession((s) => s.announceRefs)
  const queued = useActive((s) => (s?.referenceEditTarget ?? null) !== null)
  const changeRead = useActive((s) => s?.changeRead ?? null)
  const noteId = useId()
  const countId = useId()
  const stateId = useId()
  const r = shown?.form === 'draft' ? shown.d.ref : shown?.form === 'sent' ? shown.ref : null
  const abs = r && r.kind !== 'browser' ? absOf(cwd, r.path) : ''
  const [peek, setPeek] = usePeek(handleId, r, abs, pop.open)
  const note = r?.note ?? ''
  const counted = shown?.form === 'draft' && note.length >= COUNT_FROM

  // A non-modal popover whose focus wanders off leaves a panel nobody is in, so Tab cycles inside it.
  const trap = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Tab') return
    const els = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="region"], textarea, button')]
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

  const stale = peek.t === 'stale'
  const open = onOpen && peek.t !== 'gone' ? (stale ? (via: Via) => openFileAt(handleId, abs, {}, false, via) : onOpen) : undefined
  const openLabel = stale ? 'Open current' : r?.kind === 'folder' ? 'Show in Tree' : 'Open'

  // The note belongs to the message it went with, so a sent reference comes back without it.
  const addInput = (): RefInput | null => {
    if (shown?.form !== 'sent' || !r) return null
    switch (r.kind) {
      case 'file':
        return peek.t === 'loading' || peek.t === 'gone' || stale ? null : r.lines ? { kind: 'file', path: abs, lines: r.lines, sourceVersion: r.sourceVersion } : { kind: 'file', path: abs }
      case 'folder':
        return { kind: 'folder', path: abs }
      case 'change':
        return peek.t !== 'code' || !shown.addable || changeRead === false
          ? null
          : { kind: 'change', changeRef: r.changeRef, path: abs, side: r.side, ...(r.old ? { old: r.old } : {}), ...(r.new ? { new: r.new } : {}) }
      // A sent picture can't be taken again from the record, so these don't re-add. An image reference would also need
      // its bytes checked against the sent version, which only the image tab does.
      case 'browser':
      case 'page':
      case 'image':
        return null
      default:
        return r satisfies never
    }
  }
  const input = addInput()

  const add = async (): Promise<void> => {
    if (!input) return
    const say = (t: string): void => announce(handleId, t)
    // The sent revision is only worth adding while the file still has it.
    if (input.kind === 'file' && input.lines) {
      const read = await window.clui.readText(handleId, abs).catch(() => null)
      const next = readPeek(read, { ...input, id: '' })
      if (next.t === 'stale' || next.t === 'gone') {
        setPeek(next)
        return next.t === 'stale' ? say(STALE_TEXT) : undefined
      }
    }
    const res = addFromSurface(handleId, input, say, input.kind === 'change' && peek.t === 'code' ? { bytes: peek.bytes } : undefined)
    // A duplicate has already moved focus to the composer chip it matched.
    if (res.status === 'added') pop.close()
    else if (res.status === 'duplicate') pop.close({ returnFocus: false })
  }

  const legacy = shown?.form === 'legacy' ? legacyChip('', n, shown.pin.kind, shown.pin.name, shown.pin.host, undefined) : null
  const head = r ? headOf(r, cwd) : legacy && { main: legacy.line1, tail: legacy.line2 }
  const spoken = r ? spokenRef(r) : legacy?.spoken
  const crop = shown?.form === 'draft' ? (shown.d.visual ? `data:${shown.d.visual.mimeType};base64,${shown.d.visual.data}` : undefined) : shown?.crop
  const described = peek.t === 'stale' || peek.t === 'gone' || peek.t === 'plain' || peek.t === 'lost'
  return (
    <div
      {...pop.popoverProps}
      data-ui="ref-card"
      role="dialog"
      aria-label={spoken}
      aria-describedby={described ? stateId : undefined}
      tabIndex={-1}
      onKeyDown={trap}
      className="pop-base pop glass-thick w-[min(480px,calc(100vw-32px))] rounded-lg p-3"
    >
      {shown && head && (
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
          {r?.kind === 'change' && peek.t !== 'lost' && <p className="mt-1 text-meta text-dim">Claude&apos;s change, as it was when you selected it.</p>}
          <RefPreview
            r={r}
            legacy={shown.form === 'legacy' ? shown.pin : undefined}
            crop={crop}
            alt={`Picture of ${spoken}`}
            peek={peek}
            stateId={stateId}
          />
          {shown.form === 'draft' ? (
            <>
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
                onChange={(e) => setRefNote(handleId, shown.d.ref.id, e.target.value, shown.target)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
                  e.preventDefault()
                  pop.close({ via: 'keyboard' })
                }}
                className="[field-sizing:content] max-h-32 w-full resize-none rounded-md border border-control-edge bg-bg px-2 py-1.5 text-sm leading-normal text-content placeholder:text-dim"
              />
            </>
          ) : (
            note && (
              <>
                <p className="mt-3 mb-1 text-meta text-dim">Note for Claude</p>
                <p className="whitespace-pre-wrap break-words text-sm text-content">{note}</p>
              </>
            )
          )}
          {(counted || open || input) && (
            <div className="mt-2 flex items-center justify-end gap-2">
              {counted && (
                <span id={countId} className="font-mono text-meta tabular-nums text-dim">
                  {count.format(note.length)} / {count.format(REF_NOTE_MAX)}
                </span>
              )}
              {input && (
                <Button variant="control" size="sm" data-ui="ref-add" onClick={() => void add()}>
                  {queued ? 'Add to queued message' : 'Add to message'}
                </Button>
              )}
              {open && (
                <Button
                  variant="control"
                  size="sm"
                  data-ui="ref-open"
                  onClick={(e) => {
                    open(viaOf(e))
                    pop.close({ returnFocus: false })
                  }}
                >
                  {openLabel}
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
