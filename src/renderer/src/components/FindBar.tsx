/**
 * ⌘F find-in-conversation. A thin bar docked top-right of the transcript (no
 * scrim; the chat scrolls live underneath, since it belongs to the current
 * conversation, unlike the ⌘⇧F global overlay). Operates entirely on the active
 * session's `messages` already in renderer memory: no disk read, no IPC, instant.
 *
 * Matches are per-MESSAGE (a message either contains the query or not). Enter / ⇧Enter
 * (and the ⌘G / ⌘⇧G menu fallbacks) step between matching messages; each step requests
 * Chat scroll to + flash that message (requestScrollTo). "N of M" shows the position.
 * Inline term-highlight INSIDE rendered markdown is deferred (v1 flashes the card);
 * this is the settled scope.
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useActive, useSession, EMPTY_MESSAGES } from '../store'
import { useEscape } from '../lib/useEscape'
import { IconSearch, IconClose, IconChevron } from './Icon'

/** The searchable text of a message: its own text + tool names + tool outputs, so
 *  find covers what the user can see in the transcript (mirrors the card content). */
function messageText(m: {
  text: string
  tools: { name: string; result?: string }[]
}): string {
  const parts = [m.text]
  for (const t of m.tools) {
    if (t.name) parts.push(t.name)
    if (t.result) parts.push(t.result)
  }
  return parts.join('\n')
}

export function FindBar(): JSX.Element | null {
  const open = useSession((s) => s.findOpen)
  const setFindOpen = useSession((s) => s.setFindOpen)
  const requestScrollTo = useSession((s) => s.requestScrollTo)
  const messages = useActive((s) => s?.messages ?? EMPTY_MESSAGES)
  const [query, setQuery] = useState('')
  // Defer the query that drives filtering + scroll so fast typing over a long conversation
  // doesn't refilter (and jump the transcript) on every keystroke. The input stays bound to
  // the immediate `query`, so typing stays responsive while matches lag a beat behind.
  const deferredQuery = useDeferredValue(query)
  const [current, setCurrent] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const matches = useMemo<string[]>(() => {
    const q = deferredQuery.trim().toLowerCase()
    if (!q) return []
    return messages.filter((m) => messageText(m).toLowerCase().includes(q)).map((m) => m.id)
  }, [deferredQuery, messages])

  const close = useCallback(() => {
    setFindOpen(false)
    setQuery('')
    setCurrent(0)
  }, [setFindOpen])

  useEscape(open, close)

  // Focus + select the input whenever the bar opens (⌘F again re-focuses/selects).
  useEffect(() => {
    if (open) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [open])

  const goTo = useCallback(
    (idx: number) => {
      if (matches.length === 0) return
      const n = ((idx % matches.length) + matches.length) % matches.length
      setCurrent(n)
      requestScrollTo(matches[n])
    },
    [matches, requestScrollTo]
  )

  // On a real query change, jump to the LAST match rather than the first: it sits nearest
  // where the user is already reading (the transcript tail), so a long conversation doesn't
  // scroll all the way up to a top-most hit. Keyed on the deferred query, which changes only
  // on real input, never on the fresh `messages` array a streamed token produces, so an
  // active turn can't re-fire this and hijack the scroll.
  useEffect(() => {
    if (matches.length > 0) {
      const last = matches.length - 1
      setCurrent(last)
      requestScrollTo(matches[last])
    } else {
      setCurrent(0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferredQuery])

  // Keep `current` in range as matches stream in/out mid-turn WITHOUT scrolling, so the
  // "N of M" count stays honest (M can grow) but the user's position isn't hijacked.
  useEffect(() => {
    if (current >= matches.length) setCurrent(Math.max(0, matches.length - 1))
  }, [matches.length, current])

  const next = useCallback(() => goTo(current + 1), [goTo, current])
  const prev = useCallback(() => goTo(current - 1), [goTo, current])

  // ⌘G / ⌘⇧G menu fallbacks (when focus left the input). Only while open.
  useEffect(() => {
    if (!open) return
    const off = window.clui.onMenuAction((a) => {
      if (a === 'find-next') next()
      else if (a === 'find-prev') prev()
    })
    return off
  }, [open, next, prev])

  if (!open) return null

  const count = matches.length
  return (
    <div className="absolute right-5 top-3 z-30 flex items-center gap-1.5 rounded-lg border border-border-strong bg-bg-elev px-2 py-1.5 shadow-lg">
      <IconSearch className="h-3.5 w-3.5 shrink-0 text-dim" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (e.shiftKey) prev()
            else next()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            close()
          }
        }}
        placeholder="Find in conversation"
        aria-label="Find in conversation"
        className="w-52 bg-transparent text-sm text-content placeholder:text-faint focus:outline-none"
      />
      <span
        className="min-w-[3.5rem] shrink-0 text-right font-mono text-[11px] tabular-nums text-dim"
        aria-live="polite"
      >
        {deferredQuery.trim() ? (count ? `${current + 1} of ${count}` : 'No results') : ''}
      </span>
      <div className="flex items-center">
        <button
          type="button"
          onClick={prev}
          disabled={count === 0}
          aria-label="Previous match"
          className="rounded p-1 text-dim transition-colors hover:text-content disabled:opacity-40"
        >
          <IconChevron className="h-3.5 w-3.5 -rotate-90" />
        </button>
        <button
          type="button"
          onClick={next}
          disabled={count === 0}
          aria-label="Next match"
          className="rounded p-1 text-dim transition-colors hover:text-content disabled:opacity-40"
        >
          <IconChevron className="h-3.5 w-3.5 rotate-90" />
        </button>
        <button
          type="button"
          onClick={close}
          aria-label="Close find"
          className="rounded p-1 text-dim transition-colors hover:text-content"
        >
          <IconClose className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
