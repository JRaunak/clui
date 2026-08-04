/**
 * ⌘⇧F global search. A centered overlay (with scrim) that searches message
 * CONTENT across ALL on-disk sessions (main-process engine: src/main/sessions/search).
 * Distinct chrome from ⌘F (scrim + title + grouped results) so the two scopes never
 * feel like the same thing.
 *
 * Cold-start: the FIRST content scan parses every jsonl (~1s once, then ~9ms warm via
 * the main-side cache). We hide it by (a) warming the cache the moment this overlay
 * OPENS — intent-driven, not at launch — so the parse overlaps the user's typing, and
 * (b) a loading state for any query that still hasn't warmed. Latest-query-wins: each
 * query carries a monotonic id; a stale response is dropped.
 *
 * Navigation: click a hit → activate (if live) or resume the session, then request
 * Chat scroll to + flash the matched message (requestScrollTo). Because the transcript
 * is now uncapped, the target message is always in the list.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from '../store'
import { useEscape } from '../lib/useEscape'
import { highlightRuns } from '../lib/fuzzy'
import { Dropdown } from './Dropdown'
import { IconSearch, IconClose } from './Icon'
import type { SearchResults, SearchHit, WorkspaceOption } from '../../../shared/sessions'

const DEBOUNCE_MS = 150
const MIN_QUERY = 2

/** Sentinel scope value = search everywhere (Dropdown needs a non-empty string). */
const SCOPE_ALL = '__all__'

export function GlobalSearch(): JSX.Element | null {
  const open = useSession((s) => s.globalSearchOpen)
  const setOpen = useSession((s) => s.setGlobalSearchOpen)
  const requestScrollTo = useSession((s) => s.requestScrollTo)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResults | null>(null)
  const [loading, setLoading] = useState(false)
  // Facets: scope (workspace slug or SCOPE_ALL) + userOnly (role). Default = broadest.
  const [scope, setScope] = useState<string>(SCOPE_ALL)
  const [userOnly, setUserOnly] = useState(false)
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const queryIdRef = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
    setResults(null)
    setLoading(false)
    setScope(SCOPE_ALL)
    setUserOnly(false)
  }, [setOpen])

  useEscape(open, close)

  // On open: focus, warm the content cache (intent-driven — overlaps typing), and
  // load the workspace list for the scope dropdown.
  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    void window.clui.warmSearchCache()
    void window.clui.listWorkspaces().then(setWorkspaces)
  }, [open])

  // Debounced search. Re-runs when the query OR a facet changes. Latest-query-wins via
  // queryIdRef (drop stale responses). Facet changes re-query instantly (no debounce
  // needed — they're deliberate clicks, not keystrokes — but sharing the path keeps it
  // simple and the cache makes it ~9ms anyway).
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (q.length < MIN_QUERY) {
      setResults(null)
      setLoading(false)
      return
    }
    setLoading(true)
    debounceRef.current = setTimeout(() => {
      const id = ++queryIdRef.current
      const opts = { scopeSlug: scope === SCOPE_ALL ? undefined : scope, userOnly }
      void window.clui.searchSessions(q, id, opts).then((res) => {
        if (id !== queryIdRef.current) return // a newer query superseded this
        setResults(res)
        setLoading(false)
      })
    }, DEBOUNCE_MS)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, open, scope, userOnly])

  // Navigate to a hit: activate (live) or resume the session, then scroll to the
  // message. resumeSession awaits the transcript load before setting messages, so
  // requestScrollTo after the await lands on a populated list; Chat's findIndex maps
  // the id → index.
  const openHit = useCallback(
    async (hit: SearchHit) => {
      const store = useSession.getState()
      const live = Object.values(store.sessions).find((s) => s.sessionId === hit.sessionId && !s.exited)
      if (live) {
        store.activateSession(live.handleId)
      } else {
        await store.resumeSession(hit.cwd, hit.sessionId)
      }
      requestScrollTo(hit.messageId)
      close()
    },
    [requestScrollTo, close]
  )

  const totalHits = useMemo(
    () => (results?.sessions ?? []).reduce((n, g) => n + g.totalHits, 0),
    [results]
  )

  // Which result sessions are currently LIVE (a running process) vs dormant (on disk).
  // Clicking a dormant hit RESUMES → spawns a process; a live one just switches. We
  // surface that so the resume cost isn't a surprise (matches ⌘K/sidebar grammar:
  // TONE + a verb, never a status dot — the sidebar owns live-monitoring).
  // ⚠️ zustand-v5: select a STABLE PRIMITIVE (sorted id string), not a fresh Set —
  // a new Set/array each call trips useSyncExternalStore's Object.is → React #185 loop.
  const liveSig = useSession((s) =>
    Object.values(s.sessions)
      .filter((v) => !v.exited && v.sessionId)
      .map((v) => v.sessionId as string)
      .sort()
      .join(',')
  )
  const liveSessionIds = useMemo(() => new Set(liveSig ? liveSig.split(',') : []), [liveSig])

  if (!open) return null

  const q = query.trim()
  const groups = results?.sessions ?? []

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search all conversations"
        className="flex max-h-[70vh] w-[min(680px,100%)] flex-col overflow-hidden rounded-xl border border-border-strong bg-bg-elev shadow-2xl"
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <IconSearch className="h-4 w-4 shrink-0 text-dim" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search all conversations"
            aria-label="Search all conversations"
            className="flex-1 bg-transparent text-base text-content placeholder:text-faint focus:outline-none"
          />
          <button
            type="button"
            onClick={close}
            aria-label="Close search"
            className="rounded p-1 text-dim transition-colors hover:text-content"
          >
            <IconClose className="h-4 w-4" />
          </button>
        </div>

        {/* Facet bar — appears only once there's a query (no chrome on the empty
            state). Scope = a workspace SELECTOR (dropdown, variable-length list, works
            with no active session + can pick ANY workspace); Role = a single "You only"
            toggle (agent-only was cut as low-value; the noise is assistant/tool text). */}
        {q.length >= MIN_QUERY && (
          <div className="flex items-center gap-4 border-b border-border px-4 py-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-wide text-faint">Scope</span>
              <Dropdown<string>
                value={scope}
                options={[
                  { value: SCOPE_ALL, label: 'All conversations' },
                  ...workspaces.map((w) => ({
                    value: w.slug,
                    label: `${w.label} · ${w.count}`
                  }))
                ]}
                onChange={setScope}
                className="min-w-[11rem]"
              />
            </div>
            <button
              type="button"
              onClick={() => setUserOnly((v) => !v)}
              aria-pressed={userOnly}
              className={`flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors ${
                userOnly
                  ? 'border-border-strong bg-bg-raised text-content'
                  : 'border-border text-dim hover:text-content hover:border-border-strong'
              }`}
            >
              You only
            </button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {q.length < MIN_QUERY ? (
            <p className="px-4 py-8 text-center text-sm text-faint">
              Search across all your conversations — try a word or phrase.
            </p>
          ) : loading && groups.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-faint">Searching…</p>
          ) : groups.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-faint">
              No conversations match “{q}”.
            </p>
          ) : (
            <>
              <div className="px-4 pb-1 pt-3 text-[11px] uppercase tracking-wide text-faint">
                {totalHits} match{totalHits === 1 ? '' : 'es'} in {groups.length} conversation
                {groups.length === 1 ? '' : 's'}
              </div>
              {groups.map((g) => {
                const isLive = liveSessionIds.has(g.sessionId)
                return (
                <div key={g.sessionId} className="px-2 pb-2">
                  <div className="flex items-baseline gap-2 px-2 py-1.5">
                    {/* Tone tier (⌘K grammar): live = full strength, dormant = dim. */}
                    <span className={`truncate text-sm font-medium ${isLive ? 'text-content' : 'text-dim'}`}>
                      {g.title}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-faint">{g.label}</span>
                    {/* Name the click consequence so the resume cost isn't a surprise. */}
                    <span className="shrink-0 text-[11px] text-faint">
                      {isLive ? 'live · opens' : 'resumes on open'}
                    </span>
                    <span className="ml-auto shrink-0 text-[11px] text-faint">
                      {g.totalHits} hit{g.totalHits === 1 ? '' : 's'}
                    </span>
                  </div>
                  {g.hits.map((hit) => (
                    <button
                      key={hit.messageId}
                      type="button"
                      onClick={() => void openHit(hit)}
                      className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-user focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                    >
                      <span className="text-[11px] font-medium uppercase tracking-wide text-faint">
                        {hit.role === 'user' ? 'You' : 'Claude'}
                      </span>
                      <span className="text-sm leading-snug text-dim">
                        {highlightRuns(hit.snippet, rangesToIndices(hit)).map((run, i) =>
                          run.match ? (
                            <mark key={i} className="bg-accent/25 text-content">
                              {run.text}
                            </mark>
                          ) : (
                            <span key={i}>{run.text}</span>
                          )
                        )}
                      </span>
                    </button>
                  ))}
                  {g.totalHits > g.hits.length && (
                    <div className="px-2 py-1 text-[11px] text-faint">
                      +{g.totalHits - g.hits.length} more in this conversation
                    </div>
                  )}
                </div>
                )
              })}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** Expand a hit's {start,end} snippet ranges into the flat char-index array
 *  highlightRuns expects. */
function rangesToIndices(hit: SearchHit): number[] {
  const idx: number[] = []
  for (const r of hit.ranges) for (let i = r.start; i < r.end; i++) idx.push(i)
  return idx
}
