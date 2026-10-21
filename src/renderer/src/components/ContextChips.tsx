import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { CAP_NOTE, type DraftReference, type RefInput, type ReferenceInvalidation } from '../../../shared/context'
import { surfaceIdOf } from '../../../shared/surfaces'
import { placement, refsOf, useActive, useSession, type AddRefResult, type RefTarget } from '../store'
import { openFileAt } from '../lib/openLink'
import { viaOf, type Via } from '../lib/motion'
import { addedText, baseOf, BUDGET_NOTE, canReopen, noticeLead, removedText, spokenRef } from '../lib/refCopy'
import { mintedRequest } from '../lib/changeRefs'
import { requestSurfaceFocus } from '../lib/surfaceFocus'
import { ContextChip, notedChip, refChip, type ChipView } from './ContextChip'
import { usePopover } from './Popover'
import { RefCard } from './RefCard'
import { IconClose, IconWarn } from './Icon'

/** Held for --dur-stage, faded over --dur-slow. */
const FLASH_MS = 720

/** `flash` shows a chip without taking focus, for a source where focus stays in the textarea. */
type Signal = { focus?: string; flash?: string; note?: string | null }
const rows = new Map<string, (s: Signal) => void>()
const rowKey = (handleId: string, target: RefTarget): string => `${handleId}\0${target ?? ''}`

/** For a source that just added or refused a reference: focus and flash a chip, or set the row's one-line note. */
export function signalRefs(handleId: string, target: RefTarget, s: Signal): void {
  rows.get(rowKey(handleId, target))?.(s)
}

/** A surface's Add to message. `say` is the source's live region, where focus stays; a duplicate moves focus to
 *  the existing chip, so it's announced from the composer. `bytes` is a change ref's mint size. */
export function addFromSurface(handleId: string, input: RefInput, say: (t: string) => void, bytes?: number): void {
  const st = useSession.getState()
  const target = st.sessions[handleId]?.referenceEditTarget ?? null
  const r = st.addRef(handleId, input, bytes === undefined ? undefined : { bytes })
  if (r.status === 'added') say(addedText(input, target !== null))
  else if (r.status === 'duplicate') {
    signalRefs(handleId, target, { focus: r.id, note: 'Already attached.' })
    st.announceRefs(handleId, `Already attached: ${spokenRef(input)}`)
  } else if (r.status === 'cap') {
    signalRefs(handleId, target, { note: CAP_NOTE })
    say(CAP_NOTE)
  } else if (r.status === 'budget') {
    signalRefs(handleId, target, { note: BUDGET_NOTE })
    say(BUDGET_NOTE)
  } else if (target !== null) say('That queued message is gone, so nothing was added.')
}

/** Adds to the live draft from a source whose focus is in the textarea (`@` pick, drop), so nothing takes focus:
 *  the first duplicate flashes its chip. The caller announces, from the results. `bytes` is the mint size of the
 *  one change ref an `@` pick adds. */
export function addToDraft(handleId: string, inputs: readonly RefInput[], capNote: (skipped: number) => string, bytes?: number): AddRefResult[] {
  const st = useSession.getState()
  const results = inputs.map((input) => st.addRef(handleId, input, { target: null, ...(bytes === undefined ? {} : { bytes }) }))
  const dup = results.find((r) => r.status === 'duplicate')
  const skipped = results.filter((r) => r.status === 'cap').length
  const budget = results.some((r) => r.status === 'budget')
  if (!dup && !skipped && !budget) return results
  const s: Signal = { ...(dup ? { flash: dup.id } : {}), note: skipped ? capNote(skipped) : budget ? BUDGET_NOTE : 'Already attached.' }
  // The row drops its note when its chips change, which an add here is about to do, so a mixed result signals after it.
  if (results.some((r) => r.status === 'added')) requestAnimationFrame(() => signalRefs(handleId, null, s))
  else signalRefs(handleId, null, s)
  return results
}

/** Opens what a draft reference points at. A draft line reference is always current, so its lines come back
 *  selected; a change this renderer minted comes back selected at its hunk. */
export function openRef(handleId: string, d: DraftReference, via: Via): void {
  const st = useSession.getState()
  const r = d.ref
  switch (r.kind) {
    case 'file':
      openFileAt(handleId, r.path, { line: r.lines?.start }, false, via)
      if (r.lines) st.setSurfaceView(handleId, surfaceIdOf({ kind: 'file', key: r.path }), { selection: { lines: r.lines, sourceVersion: r.sourceVersion } })
      return
    case 'folder':
      return openFileAt(handleId, r.path, {}, true, via)
    case 'browser':
      if (handleId === st.activeHandleId && !st.sessions[handleId]?.paneOpen) st.setPane('half')
      return st.activateSurface(handleId, placement(r.pin.source.tabId))
    case 'change': {
      const req = mintedRequest(handleId, r.changeRef)
      requestSurfaceFocus('diff', via)
      st.openSurface(handleId, { kind: 'diff', key: '', title: 'Claude changes', location: { file: r.path, ...(req ? { hunk: req.hunkId } : {}) } }, 'focus', 'user', 'user')
      if (req) st.setSurfaceView(handleId, 'diff', { selection: { change: { ...req, ...(r.old ? { old: r.old } : {}), ...(r.new ? { new: r.new } : {}), fits: true } } })
      return
    }
    default:
      return r satisfies never
  }
}

export interface RowAttachment {
  view: ChipView
  onRemove: () => void
}

/**
 * Everything going with a message: persistent notices, then one numbered chip row (references, then attachments),
 * then a one-line note. One tab stop with roving focus. Announcements go to the composer's live region.
 */
export function ContextChips({
  handleId,
  target,
  refs,
  attachments = [],
  notices = [],
  dismissible = true,
  focusText
}: {
  handleId: string
  target: RefTarget
  refs: DraftReference[]
  attachments?: RowAttachment[]
  notices?: ReferenceInvalidation[]
  dismissible?: boolean
  focusText: () => void
}): JSX.Element | null {
  const cwd = useActive((s) => s?.cwd ?? null)
  const changes = useActive((s) => s?.changes)
  const removeRef = useSession((s) => s.removeRef)
  const moveRef = useSession((s) => s.moveRef)
  const announce = useSession((s) => s.announceRefs)
  const dismiss = useSession((s) => s.dismissReferenceNotice)
  const [active, setActive] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const chips = useRef(new Map<string, HTMLDivElement>())
  const refHint = useId()
  const attHint = useId()
  const setRefNote = useSession((s) => s.setRefNote)
  const [card, setCard] = useState<{ key: string; via: Via } | null>(null)
  const cardKey = useRef<string | null>(null)
  cardKey.current = card?.key ?? null
  /** The chip whose open card a pointerdown just light-dismissed, so its click doesn't reopen it. */
  const dismissedBy = useRef<string | null>(null)
  // A note is kept as typed while its card is open and trimmed once it closes, or another chip's card replaces it.
  const settle = (id: string | null): void => {
    const slice = useSession.getState().sessions[handleId]
    const note = id && slice ? refsOf(slice, target)?.find((d) => d.ref.id === id)?.ref.note : undefined
    if (id && note !== undefined && note !== note.trim()) setRefNote(handleId, id, note.trim() || undefined, target)
  }
  const pop = usePopover<HTMLDivElement>({
    placement: 'up',
    align: 'start',
    above: target === null ? '--composer-dock' : undefined,
    onOpenChange: (open) => !open && settle(cardKey.current)
  })

  const names = new Map<string, number>()
  for (const d of refs) if (d.ref.kind === 'file' || d.ref.kind === 'change') names.set(baseOf(d.ref.path), (names.get(baseOf(d.ref.path)) ?? 0) + 1)
  const views = refs.map((d, i) => {
    const thumb = d.visual ? `data:image/jpeg;base64,${d.visual.data}` : undefined
    return notedChip(refChip(d.ref, i + 1, cwd, thumb, (d.ref.kind === 'file' || d.ref.kind === 'change') && (names.get(baseOf(d.ref.path)) ?? 0) > 1), d.ref.note)
  })
  // A change to a file no longer in the session's changes has nothing to show: the Diff tab would show another file.
  const openable = ({ ref: r }: DraftReference): boolean => r.kind !== 'change' || !!changes?.some((c) => c.path === r.path)
  const keys = [...views.map((v) => v.key), ...attachments.map((a) => a.view.key)]
  const current = active && keys.includes(active) ? active : keys[0]
  const signature = keys.join('\0')

  useLayoutEffect(() => {
    if (!card) return
    pop.triggerRef.current = chips.current.get(card.key) ?? null
    pop.show(card.via)
    pop.popRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card])

  // A chip that leaves while its card is open takes the card with it.
  const cardGone = !!card && !refs.some((d) => d.ref.id === card.key)
  useEffect(() => {
    if (!cardGone || !pop.open) return
    pop.close({ returnFocus: false })
    focusText()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardGone])

  const showCard = (key: string, via: Via): void => {
    if (card && card.key !== key) settle(card.key)
    setCard({ key, via })
  }

  const focusKey = (key: string): void => {
    setActive(key)
    const el = chips.current.get(key)
    el?.focus()
    el?.scrollIntoView({ block: 'nearest' })
  }

  // The note answers the last add; the next change to the row makes it stale.
  useEffect(() => setNote(null), [signature])

  useEffect(() => {
    const key = rowKey(handleId, target)
    rows.set(key, (s) => {
      if (s.note !== undefined) setNote(s.note)
      if (s.flash) {
        chips.current.get(s.flash)?.scrollIntoView({ block: 'nearest' })
        setFlash(s.flash)
      }
      if (!s.focus) return
      focusKey(s.focus)
      setFlash(s.focus)
    })
    return () => void rows.delete(key)
  })

  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), FLASH_MS)
    return () => clearTimeout(t)
  }, [flash])

  const after = (key: string, fn: () => void): void => {
    requestAnimationFrame(() => chips.current.has(key) && fn())
  }

  const remove = (key: string, spoken: string): void => {
    const i = keys.indexOf(key)
    const next = keys[i + 1] ?? keys[i - 1]
    const att = attachments.find((a) => a.view.key === key)
    if (att) att.onRemove()
    else removeRef(handleId, key, target)
    announce(handleId, `Removed ${spoken}`)
    if (next) after(next, () => focusKey(next))
    else focusText()
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>, v: ChipView, d: DraftReference | undefined): void => {
    const i = keys.indexOf(v.key)
    const go = (j: number): void => {
      e.preventDefault()
      const k = keys[Math.max(0, Math.min(keys.length - 1, j))]
      if (k) focusKey(k)
    }
    if (e.altKey && d && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault()
      const delta = e.key === 'ArrowLeft' ? -1 : 1
      const to = i + delta
      if (to < 0 || to >= refs.length) return
      moveRef(handleId, v.key, delta, target)
      announce(handleId, `${spokenRef(d.ref)}, moved to ${to + 1} of ${refs.length}`)
      after(v.key, () => chips.current.get(v.key)?.focus())
      return
    }
    switch (e.key) {
      case 'ArrowLeft':
        return go(i - 1)
      case 'ArrowRight':
        return go(i + 1)
      case 'Home':
        return go(0)
      case 'End':
        return go(keys.length - 1)
      case 'Delete':
      case 'Backspace':
        e.preventDefault()
        return remove(v.key, v.spoken)
      case 'Enter':
        if (!d || !openable(d)) return
        e.preventDefault()
        return openRef(handleId, d, 'keyboard')
      case ' ':
        if (!d) return
        e.preventDefault()
        return showCard(v.key, 'keyboard')
      case 'Escape':
      case 'ArrowDown':
        e.preventDefault()
        return focusText()
    }
  }

  const bind = (key: string) => ({
    chipRef: (el: HTMLDivElement | null) => void (el ? chips.current.set(key, el) : chips.current.delete(key)),
    tabIndex: key === current ? 0 : -1,
    onFocus: () => setActive(key),
    flash: flash === key
  })

  const shown = card ? refs.find((d) => d.ref.id === card.key) : undefined
  if (!keys.length && !notices.length && !note) return null
  return (
    <>
      {notices.map((n) => (
        <div key={n.resourceId} data-ui="reference-notice" className="flex min-h-8 flex-wrap items-center gap-x-2 rounded-md bg-warn/10 px-2 py-1 text-meta text-content">
          <IconWarn className="h-3.5 w-3.5 shrink-0 text-warn" aria-hidden="true" />
          <span>{noticeLead(n)}</span>
          <span className="text-dim">{removedText(n)}</span>
          <span className="ml-auto flex items-center">
            {canReopen(n.reason) && (
              <button
                type="button"
                className="h-6 rounded px-2 text-content pointer-fine:hover:bg-control-hover"
                onClick={(e) => openNotice(handleId, n, viaOf(e))}
              >
                Open
              </button>
            )}
            {dismissible && (
              <button
                type="button"
                className="flex h-6 w-6 items-center justify-center rounded text-dim pointer-fine:hover:bg-control-hover pointer-fine:hover:text-content"
                onClick={() => dismiss(handleId, n.resourceId)}
                aria-label={`Dismiss notice for ${n.label}`}
              >
                <IconClose className="h-3.5 w-3.5" />
              </button>
            )}
          </span>
        </div>
      ))}
      {keys.length > 0 && (
        <div
          role="list"
          aria-label="Message context"
          data-ui="context-chips"
          className="flex max-h-40 flex-wrap gap-2 overflow-y-auto p-1"
          onPointerDownCapture={() => void (dismissedBy.current = pop.open ? card?.key ?? null : null)}
        >
          {views.map((v, i) => (
            <ContextChip
              key={v.key}
              view={v}
              describedBy={refHint}
              onKeyDown={(e) => onKey(e, v, refs[i])}
              onOpen={(e) => {
                if (dismissedBy.current === v.key) return void (dismissedBy.current = null)
                if (!e.metaKey) return showCard(v.key, viaOf(e))
                if (openable(refs[i])) openRef(handleId, refs[i], viaOf(e))
              }}
              style={card?.key === v.key ? pop.triggerProps.style : undefined}
              onRemove={() => {
                removeRef(handleId, v.key, target)
                announce(handleId, `Removed ${v.spoken}`)
                focusText()
              }}
              {...bind(v.key)}
            />
          ))}
          {attachments.map((a) => (
            <ContextChip
              key={a.view.key}
              view={a.view}
              describedBy={attHint}
              onKeyDown={(e) => onKey(e, a.view, undefined)}
              onRemove={() => {
                a.onRemove()
                focusText()
              }}
              {...bind(a.view.key)}
            />
          ))}
        </div>
      )}
      <span id={refHint} hidden>
        Enter opens. Space shows details. Delete removes. Option and arrow keys reorder.
      </span>
      <span id={attHint} hidden>
        Delete removes.
      </span>
      {note && <p className="truncate px-1 text-meta text-dim">{note}</p>}
      <RefCard
        pop={pop}
        handleId={handleId}
        target={target}
        d={shown}
        n={shown ? refs.indexOf(shown) + 1 : 0}
        cwd={cwd}
        onOpen={shown && openable(shown) ? (via) => openRef(handleId, shown, via) : undefined}
      />
    </>
  )
}

/** A notice's Open: the file with no selection, or the page's tab. */
function openNotice(handleId: string, n: ReferenceInvalidation, via: Via): void {
  const [kind, ...rest] = n.resourceId.split(':')
  if (kind === 'browser') {
    const tab = Number(rest[0])
    const st = useSession.getState()
    if (handleId === st.activeHandleId && !st.sessions[handleId]?.paneOpen) st.setPane('half')
    return st.activateSurface(handleId, placement(tab))
  }
  openFileAt(handleId, rest.join(':'), {}, kind === 'folder', via)
}
