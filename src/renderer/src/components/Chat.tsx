import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { useActive, useSession, EMPTY_MESSAGES, EMPTY_QUEUED, EMPTY_TASKS, type QueuedMessage } from '../store'
import { MessageView } from './MessageView'
import { WorkingStatus } from './WorkingStatus'
import { CompactSuggestion } from './CompactSuggestion'
import { FindBar } from './FindBar'
import { TaskPuck, useTaskUiActive } from './TaskPuck'
import { IconChevron, IconClose, IconEdit, IconCheck } from './Icon'

/**
 * Virtualized transcript. react-virtuoso renders only the visible
 * window, so the FULL transcript loads while staying fast on thousands of messages.
 * Scroll behaviors:
 *  - Auto-scroll to bottom on new streamed tokens, BUT only when the user is already
 *    at the bottom (followOutput gated on isAtBottom), so it never yanks a user who
 *    scrolled up to read history mid-stream.
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
  const tasks = useActive((s) => s?.tasks ?? EMPTY_TASKS)

  // Task puck: local UI state (open/pinned), reset when the session switches. The
  // gate hides it when idle+all-done (after a linger) or when the list empties.
  const [taskOpen, setTaskOpen] = useState(false)
  const [taskPinned, setTaskPinned] = useState(false)
  const taskUiActive = useTaskUiActive(tasks, busy)
  useEffect(() => {
    setTaskOpen(false)
    setTaskPinned(false)
  }, [activeHandleId])
  const tasksDone = tasks.filter((t) => t.status === 'completed').length

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
  // reduced-motion CSS rule does NOT cover it, so resolve the behavior explicitly.
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

  // Re-pin to bottom after a reflow IF the user was already there (else leave a scrolled-up
  // user where they are). Covers window resize AND the Virtuoso Footer growing: the tail
  // that holds WorkingStatus + queued drafts. followOutput only re-pins on item-count
  // change, so a Footer-height change (Claude starts thinking, a message is queued) would
  // otherwise leave that new tail a hair below the fold, under the composer.
  const repinIfAtBottom = useCallback(() => {
    if (atBottomRef.current) {
      // scrollTo the true bottom rather than the last item's edge: the Footer and its bottom
      // padding sit below the last item, so scrollToIndex('LAST') would leave a few px of
      // footer under the fold. A max scrollTop clamps to the real bottom, footer included.
      virtuosoRef.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: 'auto' })
    }
  }, [])
  useEffect(() => {
    window.addEventListener('resize', repinIfAtBottom)
    return () => window.removeEventListener('resize', repinIfAtBottom)
  }, [repinIfAtBottom])
  // Memoized so the Footer's resize effect (keyed on context) isn't rebuilt on every render.
  const footerContext = useMemo(() => ({ repin: repinIfAtBottom }), [repinIfAtBottom])

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
    // Flash duration; the highlight is opacity/color only (reduced-motion-safe: a
    // static tint that fades via a CSS transition the global reduce rule flattens).
    flashTimer.current = setTimeout(() => setFlashId(null), 1600)
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTarget?.nonce])

  // Empty / welcome state: render directly, skip Virtuoso.
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
        context={footerContext}
        followOutput={followOutput}
        atBottomStateChange={onAtBottom}
        atBottomThreshold={80}
        initialTopMostItemIndex={Math.max(0, messages.length - 1)}
        increaseViewportBy={{ top: 600, bottom: 600 }}
      />
      {/* Puck (at bottom) and JumpToLatest (scrolled up) are mutually exclusive. When
          scrolled up with active tasks, JumpToLatest absorbs the count into its label,
          UNLESS the panel is pinned-open (then it keeps rendering above and JumpToLatest
          would double the affordance, so suppress it). */}
      {taskUiActive && (
        <TaskPuck
          tasks={tasks}
          atBottom={atBottom}
          open={taskOpen && (atBottom || taskPinned)}
          pinned={taskPinned}
          onOpenChange={setTaskOpen}
          onPinnedChange={setTaskPinned}
          reduce={reduce}
        />
      )}
      {!atBottom && !(taskUiActive && taskPinned && taskOpen) && (
        <JumpToLatest
          hasNew={hasNew}
          onClick={jumpToLatest}
          taskCount={taskUiActive ? { done: tasksDone, total: tasks.length } : null}
        />
      )}
      <FindBar />
    </div>
  )
}

interface FooterContext {
  repin: () => void
}

/** Reads the store itself so it stays reactive as a Virtuoso Footer without prop threading. */
function ChatFooter({ context }: { context: FooterContext }): JSX.Element {
  const busy = useActive((s) => s?.busy ?? false)
  const lastError = useActive((s) => s?.lastError ?? null)
  // Merge the verb away while the puck is present: the puck's activeForm line already
  // narrates the work, so the whimsical verb would be a competing status. Gated on the
  // SAME condition the puck uses (non-empty task list), so they stay in lockstep.
  const tasks = useActive((s) => s?.tasks ?? EMPTY_TASKS)
  const taskMerged = useTaskUiActive(tasks, busy)
  // The Footer grows when WorkingStatus mounts or a queued draft appears; neither is a
  // list item, so Virtuoso's followOutput never re-pins for them. Observe our own height and
  // ask Chat to re-stick to the bottom (a no-op unless the user was already there). rAF
  // coalesces bursts and sidesteps the ResizeObserver-loop warning.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    let raf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(context.repin)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [context])
  return (
    <div ref={rootRef} className="px-7 pb-6">
      {busy && (
        <div className="border-l border-border/70 pl-3.5">
          <WorkingStatus taskMerged={taskMerged} />
        </div>
      )}
      {/* Queued messages live at the very TAIL, below the streaming response: they aren't
          committed transcript yet, just renderer-held drafts pending until their turn starts,
          so they stay editable and cancelable here before anything reaches the CLI. */}
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

/** They dispatch FIFO at turn boundaries. */
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
      /* Dashed info-tinted border distinguishes a still-queued message (editable,
         not committed history) from a sent user bubble, which is solid. */
      className="group flex max-w-[80%] items-start gap-2 self-start rounded-lg rounded-tl-sm border border-dashed border-info/40 bg-user px-3.5 py-2.5"
      role="listitem"
    >
      <span className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-relaxed text-content">
        {q.text}
      </span>
      {/* Shown at opacity-70 at rest, not hover-only: hover-only edit/cancel is
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

/** Accent stays scarce here: only the focus ring and the single "new" dot use it. 44px
 *  target. Reduced-motion is honored by the caller's `behavior`. When tasks are active
 *  the pill widens to absorb the progress count (the puck is hidden while scrolled up). */
function JumpToLatest({
  hasNew,
  onClick,
  taskCount
}: {
  hasNew: boolean
  onClick: () => void
  taskCount: { done: number; total: number } | null
}): JSX.Element {
  const label = hasNew ? 'Jump to latest — new messages below' : 'Jump to latest messages'
  const taskLabel = taskCount ? `, ${taskCount.done} of ${taskCount.total} tasks done` : ''
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label + taskLabel}
      className={`absolute bottom-4 right-5 z-20 flex h-11 items-center justify-center rounded-full border border-border bg-bg-raised text-dim shadow-md transition-colors hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        taskCount ? 'gap-1.5 px-3' : 'w-11'
      }`}
    >
      <IconChevron className="h-5 w-5 rotate-90" />
      {taskCount && (
        <span className="font-mono text-xs tabular-nums" aria-hidden="true">
          <span className="text-content">{taskCount.done}</span>
          <span className="text-dim">/{taskCount.total}</span>
        </span>
      )}
      {hasNew && (
        <span
          className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-accent ring-2 ring-bg"
          aria-hidden="true"
        />
      )}
    </button>
  )
}
