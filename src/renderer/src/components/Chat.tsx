import { useCallback, useEffect, useRef, useState } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { useActive, useSession, EMPTY_MESSAGES, EMPTY_QUEUED, type QueuedMessage } from '../store'
import { MessageView } from './MessageView'
import { WorkingStatus } from './WorkingStatus'
import { CompactSuggestion } from './CompactSuggestion'
import { FindBar } from './FindBar'
import { IconChevron, IconClose, IconEdit, IconCheck } from './Icon'

/**
 * Virtualized transcript. react-virtuoso renders only the visible
 * window, so the FULL transcript loads (the old 200-message render cap is gone) while
 * staying fast on thousands of messages. Key behaviors preserved from the old
 * scroll-div:
 *  - Auto-scroll to bottom on new streamed tokens, BUT only when the user is already
 *    at the bottom (followOutput gated on isAtBottom) — never yank a user who scrolled
 *    up to read history mid-stream.
 *  - Sending a new message jumps to bottom (reveal your message + the reply).
 *  - Switching/resuming a session resets to the bottom (key={activeHandleId} remount +
 *    initialTopMostItemIndex at the last message).
 *  - The "resumed here" divider renders inside the row at index === historyCount.
 *  - The working indicator / compact suggestion / error live at the transcript TAIL
 *    (scrolling with content) → Virtuoso Footer.
 *  - A "jump to latest" pill appears when scrolled up, with a "new messages" dot if a
 *    turn arrived while away.
 * Resize: Virtuoso auto-remeasures (ResizeObserver); we re-pin to bottom on resize only
 * if the user was at bottom. Theme switch is inert (colors-only, no remount).
 */
export function Chat(): JSX.Element {
  const messages = useActive((s) => s?.messages ?? EMPTY_MESSAGES)
  const busy = useActive((s) => s?.busy ?? false)
  const resumed = useActive((s) => s?.resumed ?? false)
  const historyCount = useActive((s) => s?.historyCount ?? 0)
  const activeHandleId = useActive((s) => s?.handleId ?? null)

  const scrollTarget = useSession((s) => s.scrollTarget)
  const [flashId, setFlashId] = useState<string | null>(null)

  const virtuosoRef = useRef<VirtuosoHandle>(null)
  // atBottom lives in a ref (read by streaming/resize logic without re-subscribing) AND
  // state (drives the jump-to-latest pill's visibility).
  const atBottomRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const [hasNew, setHasNew] = useState(false)
  const prevLen = useRef(messages.length)

  // Virtuoso animates scroll in JS, so the global `scroll-behavior:auto !important`
  // reduced-motion CSS rule does NOT cover it — resolve the behavior explicitly.
  const reduce =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const behavior: 'smooth' | 'auto' = reduce ? 'auto' : 'smooth'

  // Pin to bottom on new streamed CONTENT only when already at bottom (followOutput
  // fires on item-count change; intra-message token growth is handled by Virtuoso's
  // own bottom-stick, also gated by atBottom).
  const followOutput = useCallback(
    (isAtBottom: boolean): 'smooth' | 'auto' | false => (isAtBottom ? behavior : false),
    [behavior]
  )

  const onAtBottom = useCallback((b: boolean) => {
    atBottomRef.current = b
    setAtBottom(b)
    if (b) setHasNew(false) // caught up → clear the "new messages" mark
  }, [])

  // A new message arrived. If it's the USER's own send, force-jump to bottom (reveal
  // it). If a turn arrived while the user was scrolled up, flag "new messages" instead
  // of yanking them down.
  useEffect(() => {
    const grew = messages.length > prevLen.current
    const last = messages[messages.length - 1]
    if (grew && last?.role === 'user') {
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior })
    } else if (grew && !atBottomRef.current) {
      setHasNew(true)
    }
    prevLen.current = messages.length
  }, [messages, behavior])

  // Re-pin to bottom on window resize IF the user was at bottom (reflow can otherwise
  // leave a gap). If scrolled up, Virtuoso's own anchoring keeps their position.
  useEffect(() => {
    const onResize = (): void => {
      if (atBottomRef.current) {
        virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' })
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const jumpToLatest = useCallback(() => {
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior })
    setHasNew(false)
  }, [behavior])

  // Consume a scroll-to-message request (from ⌘F find or a ⌘⇧F global hit). Map
  // the messageId → index (works because the transcript is uncapped, so every message
  // is in the list) and scroll to it centered, then flash-highlight the card. Keyed on
  // nonce so repeated jumps to the same id re-fire. Does NOT touch atBottom/follow.
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!scrollTarget) return
    const idx = messages.findIndex((m) => m.id === scrollTarget.messageId)
    if (idx < 0) return
    virtuosoRef.current?.scrollToIndex({ index: idx, align: 'center', behavior })
    setFlashId(scrollTarget.messageId)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    // Flash duration; the highlight is opacity/color only (reduced-motion-safe — it's a
    // static tint that fades via a CSS transition the global reduce rule flattens).
    flashTimer.current = setTimeout(() => setFlashId(null), 1600)
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTarget?.nonce])

  // Empty / welcome state — render directly, skip Virtuoso.
  if (messages.length === 0 && !busy) {
    return (
      <div className="flex flex-1 flex-col overflow-y-auto px-7 py-6">
        <div className="m-auto flex max-w-sm flex-col items-center gap-2 text-center">
          <span className="h-2 w-2 rounded-full bg-accent/70" aria-hidden="true" />
          <p className="font-serif text-lg italic text-dim">
            {resumed ? 'Resumed session' : 'A fresh session'}
          </p>
          <p className="text-sm leading-relaxed text-faint">
            {resumed
              ? 'Continue the conversation below — Claude still has the full context.'
              : 'Type a message below to begin. Claude runs in this workspace.'}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="relative min-h-0 flex-1">
      <Virtuoso
        ref={virtuosoRef}
        key={activeHandleId ?? 'none'}
        className="h-full"
        data={messages}
        computeItemKey={(_i, m) => m.id}
        itemContent={(index, m) => (
          // Horizontal padding lives on the ITEM, never on the Virtuoso scroller:
          // padding on the scroll container makes its scrollWidth exceed clientWidth
          // by that padding (a react-virtuoso width-math quirk) → a spurious 28px
          // horizontal scrollbar that clips right-aligned card content. Keep the
          // scroller padding-free; the Footer + empty state carry their own px-7.
          <div className="px-7 pb-6 [&:first-child]:pt-6">
            {resumed && historyCount > 0 && index === historyCount && (
              <div className="mb-6 flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-faint">
                <span className="h-px flex-1 bg-border" />
                resumed here
                <span className="h-px flex-1 bg-border" />
              </div>
            )}
            {/* Flash-highlight the jumped-to message (search hit). A tinted ring that
                fades out; color-only so reduced-motion loses nothing. */}
            <div
              className={
                flashId === m.id
                  ? 'rounded-lg ring-2 ring-accent/60 transition-shadow duration-700'
                  : 'rounded-lg ring-0 ring-transparent transition-shadow duration-700'
              }
            >
              <MessageView message={m} />
            </div>
          </div>
        )}
        components={{ Footer: ChatFooter }}
        followOutput={followOutput}
        atBottomStateChange={onAtBottom}
        atBottomThreshold={80}
        initialTopMostItemIndex={Math.max(0, messages.length - 1)}
        increaseViewportBy={{ top: 600, bottom: 600 }}
      />
      {!atBottom && <JumpToLatest hasNew={hasNew} onClick={jumpToLatest} />}
      <FindBar />
    </div>
  )
}

/** Transcript-tail chrome (scrolls with content, like the old layout): the streaming
 *  indicator, the compact suggestion, and the last error. Reads the store itself so it
 *  stays reactive as a Virtuoso Footer without prop threading. */
function ChatFooter(): JSX.Element {
  const busy = useActive((s) => s?.busy ?? false)
  const lastError = useActive((s) => s?.lastError ?? null)
  return (
    <div className="px-7 pb-6">
      {busy && (
        <div className="border-l border-border/70 pl-3.5">
          <WorkingStatus />
        </div>
      )}
      {/* Queued messages live at the very TAIL (below the streaming response), because
          they aren't committed transcript yet — they're pending until their turn starts.
          Editable + cancelable here (renderer-held, not yet sent to the CLI). */}
      <QueuedMessages />
      <CompactSuggestion />
      {lastError && (
        <div className="mt-2 whitespace-pre-wrap rounded-md border border-err/60 bg-err/10 px-3 py-2 text-xs text-err">
          {lastError}
        </div>
      )}
    </div>
  )
}

/** The tail-pinned list of not-yet-dispatched queued messages (sent while busy). Each is
 *  editable/cancelable before its turn starts; they dispatch FIFO at turn boundaries. */
function QueuedMessages(): JSX.Element | null {
  const queued = useActive((s) => s?.queuedMessages ?? EMPTY_QUEUED)
  if (queued.length === 0) return null
  return (
    <div className="mt-4 flex flex-col gap-2" role="list" aria-label="Queued messages">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.12em] text-info">
        <span
          className="h-1.5 w-1.5 rounded-full bg-info"
          style={{ animation: 'var(--animate-breathe)' }}
          aria-hidden="true"
        />
        Queued · sends when the current turn finishes
      </div>
      {queued.map((q) => (
        <QueuedRow key={q.id} q={q} />
      ))}
    </div>
  )
}

function QueuedRow({ q }: { q: QueuedMessage }): JSX.Element {
  const edit = useSession((s) => s.editQueuedMessage)
  const cancel = useSession((s) => s.cancelQueuedMessage)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(q.text)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (editing) {
      const ta = taRef.current
      if (ta) {
        ta.focus()
        ta.setSelectionRange(ta.value.length, ta.value.length)
      }
    }
  }, [editing])

  const commit = (): void => {
    const t = draft.trim()
    if (t && t !== q.text) edit(q.id, t)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="rounded-lg border border-info/50 bg-user px-3 py-2" role="listitem">
        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setDraft(q.text)
              setEditing(false)
            }
          }}
          rows={Math.min(6, Math.max(1, draft.split('\n').length))}
          className="w-full resize-none bg-transparent text-sm leading-relaxed text-content focus-visible:outline-none"
        />
        <div className="mt-1.5 flex items-center justify-end gap-1.5 text-[11px] text-faint">
          <span className="mr-auto">Enter to save · Esc to discard</span>
          <button
            className="rounded p-1 text-faint hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            onClick={() => { setDraft(q.text); setEditing(false) }}
            aria-label="Discard edit"
          >
            <IconClose className="h-3.5 w-3.5" />
          </button>
          <button
            className="rounded p-1 text-info hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            onClick={commit}
            aria-label="Save edit"
          >
            <IconCheck className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      /* Dashed info-tinted border distinguishes a still-queued message from a sent
         user bubble (solid) — these are editable/cancelable, not committed history. */
      className="group flex max-w-[80%] items-start gap-2 self-start rounded-lg rounded-tl-sm border border-dashed border-info/40 bg-user px-3.5 py-2.5"
      role="listitem"
    >
      <span className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-relaxed text-content">
        {q.text}
      </span>
      {/* Persistent at-rest affordance (opacity-70) — hover-only edit/cancel is
          undiscoverable, so a user may not realize a queued message is still editable. */}
      <div className="flex shrink-0 items-center gap-1 opacity-70 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <button
          className="rounded p-1 text-faint hover:text-content focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          onClick={() => { setDraft(q.text); setEditing(true) }}
          aria-label="Edit queued message"
          title="Edit before it sends"
        >
          <IconEdit className="h-3.5 w-3.5" />
        </button>
        <button
          className="rounded p-1 text-faint hover:text-err focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          onClick={() => cancel(q.id)}
          aria-label="Cancel queued message"
          title="Remove before it sends"
        >
          <IconClose className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}

/** Floating "jump to latest" pill — appears only when scrolled up. Neutral raised
 *  surface + down chevron; accent is scarce (focus ring + a single "new" dot). 44px
 *  target. Reduced-motion is honored by the caller's `behavior`. */
function JumpToLatest({ hasNew, onClick }: { hasNew: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={hasNew ? 'Jump to latest — new messages below' : 'Jump to latest messages'}
      className="absolute bottom-4 right-5 z-20 flex h-11 w-11 items-center justify-center rounded-full border border-border bg-bg-raised text-dim shadow-md transition-colors hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <IconChevron className="h-5 w-5 rotate-90" />
      {hasNew && (
        <span
          className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-accent ring-2 ring-bg"
          aria-hidden="true"
        />
      )}
    </button>
  )
}
