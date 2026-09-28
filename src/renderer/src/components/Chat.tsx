import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso, type StateSnapshot, type VirtuosoHandle } from 'react-virtuoso'
import { useActive, useSession, EMPTY_MESSAGES, EMPTY_QUEUED, EMPTY_TASKS, type QueuedMessage, type SendAttachment } from '../store'
import { MessageView } from './MessageView'
import { WorkingStatus } from './WorkingStatus'
import { CompactSuggestion } from './CompactSuggestion'
import { TaskPuck, useTaskUiActive } from './TaskPuck'
import { IconChevron, IconClose, IconEdit, IconCheck, IconFile } from './Icon'
import { deriveModelInfo } from '../../../shared/settings'
import { TURN_LINE_PX, currentTurnAt } from '../lib/instrument'
import type { PermissionModeChoice } from '../../../shared/ipc'
import type { Via } from '../lib/motion'

// --dur-stage hold plus the --dur-slow fade of .turn-flash in styles.css.
const FLASH_MS = 720

// A full pane unmounts the transcript. These outlive it, so the transcript comes back where the reader
// left it, and a jump already handled isn't replayed on the next mount.
let parked: { handleId: string; snapshot: StateSnapshot } | null = null
let seenTarget: object | null = null

/** Quick-session permission phrase, keyed to the four modes Settings scopes quick sessions to.
 *  Anything else falls back to the System Default phrasing. */
const QUICK_PERMISSION_PHRASE: Partial<Record<PermissionModeChoice, string>> = {
  default: 'asks before each action',
  auto: 'decides per action',
  bypassPermissions: 'runs without asking',
  inherit: 'uses your default permissions'
}

/**
 * Virtualized transcript. react-virtuoso renders only the visible window, so the full
 * transcript loads while staying fast on thousands of messages.
 * Scroll behaviors:
 *  - Follow the tail while streaming until the reader scrolls up, and resume once they
 *    return to the bottom, so it never yanks a user reading history mid-stream.
 *  - Sending a new message jumps to bottom (reveal your message + the reply).
 *  - Switching/resuming a session resets to the bottom (key remount + initialTopMostItemIndex).
 *  - The "resumed here" divider renders inside the row at index === historyCount.
 *  - The working indicator / compact suggestion / error live at the transcript tail (Virtuoso Footer).
 *  - A "jump to latest" pill appears when scrolled up, with a "new messages" dot if a turn arrived.
 * Resize: Virtuoso auto-remeasures; we re-pin to bottom on resize only while following.
 */
export function Chat({ onScrollbarWidth }: { onScrollbarWidth?: (w: number) => void }): JSX.Element {
  const messages = useActive((s) => s?.messages ?? EMPTY_MESSAGES)
  const thinkingLive = useActive((s) => s?.thinkingTokens != null)
  const busy = useActive((s) => s?.busy ?? false)
  const resumed = useActive((s) => s?.resumed ?? false)
  const historyCount = useActive((s) => s?.historyCount ?? 0)
  const activeHandleId = useActive((s) => s?.handleId ?? null)
  const activeHandleIdRef = useRef(activeHandleId)
  activeHandleIdRef.current = activeHandleId
  const tasks = useActive((s) => s?.tasks ?? EMPTY_TASKS)
  // Empty-state copy varies by session shape: quick (ephemeral), directoryless, or folder-bound.
  const cwd = useActive((s) => s?.cwd ?? null)
  const ephemeral = useActive((s) => s?.ephemeral ?? false)
  const modeChoice = useActive((s) => s?.modeChoice ?? 'inherit')
  const modelChoice = useActive((s) => s?.modelChoice ?? '')
  const chatDir = useSession((s) => s.chatDir)
  const setPrimaryScrolled = useSession((s) => s.setPrimaryScrolled)
  const isDirectoryless = !!cwd && cwd === chatDir

  // Task puck: local UI state (open/pinned), reset when the session switches. The gate
  // hides it when idle+all-done (after a linger) or when the list empties.
  const [taskOpen, setTaskOpen] = useState(false)
  const [taskPinned, setTaskPinned] = useState(false)
  const taskUiActive = useTaskUiActive(tasks, busy)
  useEffect(() => {
    setTaskOpen(false)
    setTaskPinned(false)
  }, [activeHandleId])
  const tasksDone = tasks.filter((t) => t.status === 'completed').length

  const scrollTarget = useSession((s) => s.scrollTarget)
  // Persistent "you are here" for the current find match (moves on Enter/⇧Enter, cleared
  // when find closes). Distinct from `flash`, the transient wash a pointer or keyboard jump leaves.
  const activeMatchId = useSession((s) => s.findActiveId)
  const [flash, setFlash] = useState<{ id: string; via: Via; nonce: number } | null>(null)

  const virtuosoRef = useRef<VirtuosoHandle>(null)
  // The first Virtuoso restores the parked position with its measured row sizes, so a transition that
  // reveals the transcript captures it already in place instead of scrolling there afterwards. Null
  // starts at the bottom.
  const restore = useRef<StateSnapshot | null | undefined>(undefined)
  if (restore.current === undefined) {
    restore.current = parked?.handleId === useSession.getState().activeHandleId ? parked.snapshot : null
    parked = null
  }
  const setCurrentTurn = useSession((s) => s.setCurrentTurn)
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const scrollerEl = useRef<HTMLElement | null>(null)
  // The owning row is read from the DOM at the band line: rangeChanged reports the rendered range,
  // which extends 600px past the viewport, and the band covers the scroller's top.
  const syncTurn = useCallback(() => {
    const sc = scrollerEl.current
    if (!sc) return
    // scrollTop is whole pixels and rows sit at fractional offsets, so a jump to a prompt lands it up
    // to about 1.5px past the line; the slack keeps the reply above it from reading as visible.
    const line = sc.getBoundingClientRect().top + TURN_LINE_PX + 2
    let top = -1
    for (const el of sc.querySelectorAll<HTMLElement>('[data-testid="virtuoso-item-list"] > [data-index]')) {
      if (el.getBoundingClientRect().bottom > line) {
        top = Number(el.dataset.index)
        break
      }
    }
    if (top < 0) return
    const ct = currentTurnAt(messagesRef.current, top)
    // The store is the dedupe: scrolling changes nothing until the owning prompt does.
    if ((ct?.messageId ?? null) === (useSession.getState().currentTurn?.messageId ?? null)) return
    setCurrentTurn(ct)
  }, [setCurrentTurn])
  const empty = messages.length === 0 && !busy
  // Leaving this transcript (session switch, full pane, empty state) must not strand a header.
  useEffect(() => () => setCurrentTurn(null), [activeHandleId, empty, setCurrentTurn])
  // atBottom lives in a ref (read by the new-message effect without re-subscribing) and
  // state (drives the jump-to-latest pill's visibility).
  const atBottomRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const [hasNew, setHasNew] = useState(false)
  const prevLen = useRef(messages.length)

  // Virtuoso animates scroll in JS, so the global scroll-behavior:auto reduced-motion CSS
  // rule does not cover it; resolve the behavior explicitly.
  const reduce =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const behavior: 'smooth' | 'auto' = reduce ? 'auto' : 'smooth'

  // Following the tail is the reader's intent, not a distance from the bottom: a reader scrolling up in
  // small steps stays inside any threshold and would be snapped back on every streamed line. An upward
  // input detaches; reaching the bottom, jump-to-latest or a send re-attaches. The pin is a plain
  // scrollTo because Virtuoso's followOutput and scrollToIndex('LAST') retry on every resize while
  // text streams, and nothing outside Virtuoso can cancel that retry.
  const followingRef = useRef(true)
  // Set while a smooth jump is in flight, so a resize doesn't cut it to an instant one.
  const smoothJumpRef = useRef(false)

  // Park only a reader who had left the tail; one who was following comes back to the bottom. Layout
  // cleanup, because Virtuoso's handle is gone by the time a passive one runs.
  useLayoutEffect(
    () => () => {
      const handleId = activeHandleIdRef.current
      if (followingRef.current || !handleId) return
      virtuosoRef.current?.getState((snapshot) => {
        parked = { handleId, snapshot }
      })
    },
    []
  )

  const onAtBottom = useCallback((b: boolean) => {
    atBottomRef.current = b
    setAtBottom(b)
    if (b) setHasNew(false) // caught up, so clear the "new messages" mark
  }, [])

  // scrollTo the true bottom, not the last item's edge: the Footer sits below it.
  const repin = useCallback(() => {
    if (!followingRef.current || smoothJumpRef.current) return
    virtuosoRef.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: 'auto' })
  }, [])

  const smoothTimer = useRef(0)
  useEffect(() => () => clearTimeout(smoothTimer.current), [])
  const toLatest = useCallback(() => {
    followingRef.current = true
    const sc = scrollerEl.current
    // No scrollend fires for a scroll that doesn't move, so only a real smooth trip waits for one.
    smoothJumpRef.current = behavior === 'smooth' && !!sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight > 2
    virtuosoRef.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior })
    // A trip cut off with no scrollend (the transcript hidden mid-trip) must not leave pinning off.
    clearTimeout(smoothTimer.current)
    if (smoothJumpRef.current) {
      smoothTimer.current = window.setTimeout(() => {
        if (!smoothJumpRef.current) return
        smoothJumpRef.current = false
        repin()
      }, 800)
    }
  }, [behavior, repin])

  // A send re-attaches and jumps even when scrolled up; any other arrival while scrolled up only
  // sets the "new messages" mark.
  useEffect(() => {
    const grew = messages.length > prevLen.current
    const last = messages[messages.length - 1]
    if (grew && last?.role === 'user') {
      toLatest()
    } else if (grew && !atBottomRef.current) {
      setHasNew(true)
    }
    prevLen.current = messages.length
  }, [messages, toLatest])

  useEffect(() => {
    window.addEventListener('resize', repin)
    return () => window.removeEventListener('resize', repin)
  }, [repin])
  useEffect(() => {
    const sc = scrollerEl.current
    followingRef.current = !restore.current
    restore.current = null
    if (!sc) return
    smoothJumpRef.current = false
    let raf = 0
    let lastTop = sc.scrollTop
    const onScroll = (): void => {
      // A trackpad gesture's first 1px steps upward still land inside the band, so only a downward
      // scroll may re-attach.
      const down = sc.scrollTop > lastTop
      lastTop = sc.scrollTop
      if (down && sc.scrollHeight - sc.scrollTop - sc.clientHeight <= 2) followingRef.current = true
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(syncTurn)
    }
    const onScrollEnd = (): void => {
      if (!smoothJumpRef.current) return
      // Rows measured on the way down can leave a smooth trip short of the new bottom.
      smoothJumpRef.current = false
      repin()
    }
    const detach = (): void => {
      followingRef.current = false
    }
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY < 0) detach()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home' || (e.key === ' ' && e.shiftKey)) detach()
    }
    // Rows cover the content area, so a press on the scroller itself is on its scrollbar, where a drag
    // can go either way.
    const onPointer = (e: PointerEvent): void => {
      if (e.target === sc) detach()
    }
    // A click on a row is the reader settling on it. A disclosure grows or shrinks the list under that
    // row and a re-pin would carry it off by the body's height; an Agent row is where its pane morphs
    // back to on close. This runs before React's root handler acts on the click.
    const onClick = (e: MouseEvent): void => {
      if (e.target instanceof Element && e.target.closest('[aria-expanded], [data-ui="row-open-transcript"]')) detach()
    }
    sc.addEventListener('scroll', onScroll, { passive: true })
    sc.addEventListener('scrollend', onScrollEnd)
    sc.addEventListener('wheel', onWheel, { passive: true })
    sc.addEventListener('touchmove', detach, { passive: true })
    sc.addEventListener('keydown', onKey)
    sc.addEventListener('pointerdown', onPointer)
    sc.addEventListener('click', onClick)
    // Rows re-measured after landing move the top row without a scroll event, and a streaming message
    // grows the list. Re-pin here outside the rAF: the observer runs after layout and before paint, so
    // a new line never paints under the dock. The scroller itself is observed for a shrinking viewport.
    const list = sc.querySelector('[data-testid="virtuoso-item-list"]')
    const ro = new ResizeObserver(() => {
      repin()
      onScroll()
    })
    if (list) ro.observe(list, { box: 'border-box' })
    ro.observe(sc)
    return () => {
      sc.removeEventListener('scroll', onScroll)
      sc.removeEventListener('scrollend', onScrollEnd)
      sc.removeEventListener('wheel', onWheel)
      sc.removeEventListener('touchmove', detach)
      sc.removeEventListener('keydown', onKey)
      sc.removeEventListener('pointerdown', onPointer)
      sc.removeEventListener('click', onClick)
      ro.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [activeHandleId, empty, syncTurn, repin])
  // Memoized so the Footer's resize effect isn't rebuilt on every render.
  const footerContext = useMemo(() => ({ repin }), [repin])

  const jumpToLatest = useCallback(() => {
    toLatest()
    setHasNew(false)
  }, [toLatest])

  // Keyed on nonce so repeated jumps to the same id re-fire. Detaches so a streaming reply doesn't
  // pull the view back to the bottom. The caller decides whether the landing is marked.
  const flashTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(flashTimer.current), [])
  useEffect(() => {
    if (!scrollTarget || scrollTarget === seenTarget) return
    seenTarget = scrollTarget
    const idx = messages.findIndex((m) => m.id === scrollTarget.messageId)
    if (idx < 0) return
    followingRef.current = false
    const id = scrollTarget.messageId
    if (scrollTarget.align === 'start') {
      // Instant, because a smooth scroll to a far unrendered index lands short in react-virtuoso.
      virtuosoRef.current?.scrollToIndex({ index: idx, align: 'start', offset: -TURN_LINE_PX, behavior: 'auto' })
      requestAnimationFrame(() =>
        requestAnimationFrame(() => document.getElementById(`msg-${id}`)?.focus({ preventScroll: true }))
      )
    } else {
      virtuosoRef.current?.scrollToIndex({ index: idx, align: 'center', behavior })
    }
    if (scrollTarget.flash) {
      setFlash({ id, via: scrollTarget.flash, nonce: scrollTarget.nonce })
      clearTimeout(flashTimer.current)
      flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTarget?.nonce])
  if (messages.length === 0 && !busy) {
    const title = resumed ? 'Resumed session' : ephemeral ? 'Quick session' : 'A fresh session'
    const body = resumed
      ? 'No messages were saved yet. Continue below; the CLI still has its context.'
      : ephemeral
        ? 'A quick, unsaved chat. Nothing is written to disk.'
        : isDirectoryless
          ? 'Type a message below to begin. Not tied to a project folder.'
          : 'Type a message below to begin. Claude runs in this directory.'
    const family = deriveModelInfo(modelChoice).family
    const familyWord = family.charAt(0).toUpperCase() + family.slice(1)
    return (
      <div
        className="scroll-edge flex flex-1 flex-col overflow-y-auto px-7 py-6"
        style={{ paddingBottom: 'calc(var(--dock-h, 0px) + 1.5rem)' }}
      >
        <div aria-hidden="true" className="shrink-0" style={{ height: 'calc(var(--bar-h, 44px) + var(--notice-h, 0px))' }} />
        {/* A failed transcript read collapses to empty history, indistinguishable from a session
            with nothing saved. So the resumed copy claims context (which the CLI holds) without
            asserting what was saved. */}
        <div className="m-auto flex max-w-sm flex-col items-center gap-2 text-center" aria-live="polite">
          <span className="h-2 w-2 rounded-full bg-accent/70" aria-hidden="true" />
          <p className="text-title text-content">{title}</p>
          <p className="text-sm leading-relaxed text-faint">{body}</p>
          {!resumed && ephemeral && (
            <p className="text-xs leading-relaxed text-faint">
              {familyWord} at high effort. Claude{' '}
              {QUICK_PERMISSION_PHRASE[modeChoice] ?? 'uses your default permissions'}, with a limited tool set.
            </p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="relative min-h-0 flex-1">
      <Virtuoso
        ref={virtuosoRef}
        key={activeHandleId ?? 'none'}
        className="scroll-edge h-full [scrollbar-gutter:stable]"
        // Report the reserved gutter width so the composer dock can pad to match this column.
        scrollerRef={(el) => {
          const node = el as HTMLElement | null
          scrollerEl.current = node
          if (node && onScrollbarWidth)
            requestAnimationFrame(() => onScrollbarWidth(node.offsetWidth - node.clientWidth))
        }}
        data={messages}
        computeItemKey={(_i, m) => m.id}
        itemContent={(index, m) => (
          // H-padding on the item, never the Virtuoso scroller: scroller padding inflates
          // scrollWidth past clientWidth (a react-virtuoso quirk), producing a spurious h-scrollbar.
          <div className="mx-auto max-w-5xl px-7 py-6">
            {resumed && historyCount > 0 && index === historyCount && (
              <div className="mb-6 flex items-center gap-2 text-caps uppercase text-faint">
                <span className="h-px flex-1 bg-border" />
                resumed here
                <span className="h-px flex-1 bg-border" />
              </div>
            )}
            <div className="relative isolate">
              {/* Drawn behind the message like the jump wash, so marking a match never shifts the text. */}
              {activeMatchId === m.id && (
                <span
                  aria-hidden="true"
                  data-ui="find-match"
                  className="pointer-events-none absolute -left-6 -right-3 -inset-y-2 -z-10 rounded-lg bg-flash before:absolute before:inset-y-2.5 before:left-[1.0625rem] before:w-0.5 before:rounded-full before:bg-dim"
                />
              )}
              {/* Behind the message inside its isolate, so bubbles and cards keep their own fills and
                  only the floor around them washes. The key restarts the fade on a repeat jump. */}
              {flash?.id === m.id && (
                <span
                  key={flash.nonce}
                  aria-hidden="true"
                  data-ui="turn-flash"
                  data-via={flash.via}
                  className="turn-flash pointer-events-none absolute -left-6 -right-3 -inset-y-2 -z-10 rounded-lg"
                />
              )}
              <MessageView message={m} hideThinking={thinkingLive && index === messages.length - 1} />
            </div>
          </div>
        )}
        components={{ Header: TopSpacer, Footer: ChatFooter }}
        context={footerContext}
        atBottomStateChange={onAtBottom}
        // After the rows commit, so a re-window or streamed rows re-read the top row from fresh DOM.
        itemsRendered={syncTurn}
        atTopStateChange={(atTop) => setPrimaryScrolled(!atTop)}
        atBottomThreshold={80}
        // Both props feed Virtuoso's initial location, and the index would win over the restore.
        {...(restore.current ? { restoreStateFrom: restore.current } : { initialTopMostItemIndex: Math.max(0, messages.length - 1) })}
        increaseViewportBy={{ top: 600, bottom: 600 }}
      />
      {/* Puck (at bottom) and JumpToLatest (scrolled up) are mutually exclusive. When scrolled
          up with active tasks, JumpToLatest absorbs the count into its label, unless the panel
          is pinned-open (then it keeps rendering above and JumpToLatest would double the affordance). */}
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
    </div>
  )
}

/** Reserves the top band's and any notice's height, so the first message starts below them. A Virtuoso
 *  Header, not scroller padding, because Virtuoso mis-measures a padded scroller. */
function TopSpacer(): JSX.Element {
  return <div aria-hidden="true" style={{ height: 'calc(var(--bar-h, 44px) + var(--notice-h, 0px))' }} />
}

interface FooterContext {
  repin: () => void
}

/** Reads the store itself so it stays reactive as a Virtuoso Footer without prop threading. */
function ChatFooter({ context }: { context: FooterContext }): JSX.Element {
  const busy = useActive((s) => s?.busy ?? false)
  const compacting = useActive((s) => s?.compacting ?? false)
  const compactAnnounce = useActive((s) => s?.compactAnnounce ?? '')
  const lastError = useActive((s) => s?.lastError ?? null)
  // Merge the verb away while the puck shows: it already narrates the work, so the verb would
  // compete. Gated on the same condition as the puck, so they stay in lockstep.
  const tasks = useActive((s) => s?.tasks ?? EMPTY_TASKS)
  const taskMerged = useTaskUiActive(tasks, busy)
  // The Footer grows for non-list-items (WorkingStatus, a queued draft) that Chat's list observer
  // can't see, so observe our height and ask Chat to re-pin. rAF sidesteps the ResizeObserver-loop warning.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    let raf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(context.repin)
    })
    // Border box: the dock height arrives as padding (--dock-h), which the content box doesn't see.
    ro.observe(el, { box: 'border-box' })
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [context])
  return (
    // Bottom clearance = the floating composer stack's height, so the tail scrolls clear of it.
    <div
      ref={rootRef}
      className="mx-auto max-w-5xl px-7"
      style={{ paddingBottom: 'calc(var(--dock-h, 0px) + 1.5rem)' }}
    >
      <span className="sr-only" role="status" aria-live="polite">
        {compactAnnounce}
      </span>
      {(busy || compacting) && <WorkingStatus taskMerged={taskMerged} />}
      {/* Queued messages live at the tail, below the response: renderer-held drafts, not committed
          transcript, so they stay editable and cancelable before reaching the CLI. */}
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
function QueuedMessages(): JSX.Element | null {
  const queued = useActive((s) => s?.queuedMessages ?? EMPTY_QUEUED)
  if (queued.length === 0) return null
  return (
    <div className="mt-4 flex flex-col gap-2" role="list" aria-label="Queued messages">
      <div className="flex items-center gap-1.5 text-caps uppercase text-info">
        <span className="h-1.5 w-1.5 rounded-full bg-info" aria-hidden="true" />
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
        {q.attachments && q.attachments.length > 0 && (
          <div className="mb-1.5">
            <QueuedAttachments atts={q.attachments} />
          </div>
        )}
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
        <div className="mt-1.5 flex items-center justify-end gap-1.5 text-meta text-faint">
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
      /* Dashed info-tinted border distinguishes a still-queued message (editable, not committed
         history) from a sent user bubble, which is solid. */
      className="group flex max-w-[80%] items-start gap-2 self-start rounded-lg rounded-tl-sm border border-dashed border-info/40 bg-user px-3.5 py-2.5"
      role="listitem"
    >
      {/* Attachment-only queued turns have no text; render their thumbnails/chips so the row
          is identifiable and cancelable, not an empty bubble. */}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {q.attachments && q.attachments.length > 0 && <QueuedAttachments atts={q.attachments} />}
        {q.text && (
          <span className="whitespace-pre-wrap text-sm leading-relaxed text-content">{q.text}</span>
        )}
      </div>
      {/* Shown at opacity-70 at rest, not hover-only: hover-only edit/cancel is undiscoverable,
          so a user may not realize a queued message is still editable. */}
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

/** Thumbnails/chips for a queued message's attachments, sharing the wire payload's display
 *  metadata so a queued turn shows the same content it will send. */
function QueuedAttachments({ atts }: { atts: SendAttachment[] }): JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5">
      {atts.map((a, i) => {
        const d = a.display
        return d.kind === 'image' ? (
          <img
            key={i}
            src={d.previewUrl}
            alt={d.name || 'attached image'}
            className="h-9 w-9 rounded bg-tool object-cover"
          />
        ) : (
          <span
            key={i}
            className="flex items-center gap-1 rounded border border-border bg-bg-raised px-1.5 py-0.5 font-mono text-meta text-dim"
            title={d.name}
          >
            <IconFile className="h-3 w-3 shrink-0" />
            <span className="max-w-[120px] truncate">{d.name}</span>
          </span>
        )
      })}
    </div>
  )
}

/** Accent stays scarce: only the focus ring and the "new" dot use it. When tasks are active
 *  the pill widens to absorb the progress count. */
function JumpToLatest({
  hasNew,
  onClick,
  taskCount
}: {
  hasNew: boolean
  onClick: () => void
  taskCount: { done: number; total: number } | null
}): JSX.Element {
  const label = hasNew ? 'Jump to latest (new messages below)' : 'Jump to latest messages'
  const taskLabel = taskCount ? `, ${taskCount.done} of ${taskCount.total} tasks done` : ''
  return (
    <button
      type="button"
      data-ui="jump-latest"
      onClick={onClick}
      aria-label={label + taskLabel}
      style={{ bottom: 'calc(1rem + var(--dock-h, 0px))' }}
      className={`absolute right-5 z-20 flex h-11 items-center justify-center rounded-full glass-thick text-dim transition-colors hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
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
