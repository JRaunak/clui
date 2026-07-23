/**
 * Conversation search — global content search across all on-disk sessions.
 *
 * Runs in the MAIN process over the FULL jsonl files (uncapped) — the renderer only
 * holds the active session's messages, and the 200-cap was a render limit, never a
 * data limit. Design decisions (from measured critiques):
 *
 * - REUSE the existing transcript parser (`readTranscriptAtPath`) so the `messageId`
 *   a hit reports is byte-identical to `store.messages[i].id` → jump-to-hit is a
 *   `findIndex(m => m.id === hit.messageId)`. Divergent parsing would land on the
 *   wrong bubble. (Search does pay the full parse, but the WARM CACHE means it's paid
 *   once per file, then reused across keystrokes.)
 * - WARM CACHE keyed by file identity ({mtimeMs,size}): unchanged file → reuse the
 *   extracted records; changed (the live session appends) → re-extract. BOUNDED (LRU
 *   by entry count) so it can't leak the main process.
 * - Searchable fields (FIXED for v1, no toggles): user text + assistant text + tool
 *   NAMES + curated tool-INPUT values (file_path/command/pattern/query/url/prompt).
 *   EXCLUDED: tool OUTPUTS (bulk + noise), thinking (empty/encrypted on disk),
 *   sidechain/subagent text (no jump locator — parser skips it anyway), and CLI
 *   plumbing (the parser already suppresses it, so it never reaches us).
 * - Case-insensitive SUBSTRING match (not fuzzy — fuzzy over long prose = garbage).
 * - Cooperative yielding (`setImmediate` every N files) + latest-query-wins so a
 *   cold scan never blocks the event loop or piles up behind fast keystrokes.
 */
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import { readTranscriptAtPath } from './transcript'
import type { SearchHit, SearchResults, SnippetRange } from '../../shared/sessions'

const projectsRoot = (): string => join(homedir(), '.claude', 'projects')

/** Minimum query length for a content scan (shorter → tooShort, no disk work). */
const MIN_QUERY = 2
/** Max hit rows returned per session (overflow indicated by totalHits > hits.length). */
const MAX_HITS_PER_SESSION = 5
/** Chars of context around a match in the snippet. */
const SNIPPET_RADIUS = 60
/** Warm-cache ceiling (distinct session files). LRU-evicted — bounds main-process memory. */
const CACHE_MAX = 40

/** Tool-input keys worth searching (human-meaningful; excludes huge/noisy blobs). */
const SEARCHABLE_INPUT_KEYS = ['file_path', 'command', 'pattern', 'query', 'url', 'prompt', 'description']

/** One searchable message: the message id (for jump) + role + the concatenated
 *  searchable text (user/assistant text + tool names + curated input values). */
interface SearchableMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
}

interface CacheEntry {
  mtimeMs: number
  size: number
  records: SearchableMessage[]
}

/** Module-level warm cache, LRU by insertion order (Map preserves it). */
const cache = new Map<string /* filePath */, CacheEntry>()

/** Monotonic query token — the renderer sends increasing ids; a scan bails early
 *  when a newer query has started, and stale results are dropped renderer-side. */
let latestQueryId = 0

/** Build the searchable text for one parsed message: its text, plus each tool's
 *  name and curated input values. Tool OUTPUTS deliberately excluded (bulk/noise). */
function toSearchable(m: {
  id: string
  role: 'user' | 'assistant'
  text: string
  tools: { name: string; input: unknown }[]
}): SearchableMessage {
  const parts: string[] = []
  if (m.text) parts.push(m.text)
  for (const t of m.tools) {
    if (t.name) parts.push(t.name)
    const input = t.input
    if (input && typeof input === 'object') {
      for (const key of SEARCHABLE_INPUT_KEYS) {
        const v = (input as Record<string, unknown>)[key]
        if (typeof v === 'string' && v) parts.push(v)
      }
    }
  }
  return { id: m.id, role: m.role, text: parts.join('\n') }
}

/** Get searchable records for a file, from cache if the file is unchanged. */
async function getRecords(filePath: string, mtimeMs: number, size: number): Promise<SearchableMessage[]> {
  const cached = cache.get(filePath)
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    // Refresh LRU position.
    cache.delete(filePath)
    cache.set(filePath, cached)
    return cached.records
  }
  const parsed = await readTranscriptAtPath(filePath)
  const records = parsed.messages.map(toSearchable).filter((r) => r.text.length > 0)
  cache.set(filePath, { mtimeMs, size, records })
  // LRU eviction (oldest first).
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return records
}

/**
 * Warm the content cache WITHOUT running a query — a dedicated cache-population pass
 * (NOT a throwaway search: no matching, no result allocation, no queryId pollution).
 * Called when the global-search overlay OPENS, so the parse overlaps the user's typing
 * and the first real query is usually already warm. Intent-driven (only runs when
 * search is actually invoked), so non-searchers never pay for it. Cooperative-yields
 * and bails if a real search superseded it. Best-effort: swallows per-file errors.
 */
export async function warmSearchCache(): Promise<void> {
  const files = await enumerateSessionFiles()
  let n = 0
  for (const f of files) {
    if (++n % 4 === 0) await yieldToLoop()
    try {
      await getRecords(f.filePath, f.mtimeMs, f.size)
    } catch {
      // skip unreadable file
    }
  }
}

/** Find all case-insensitive substring match start offsets of `q` in `text`. */
function findMatches(text: string, qLower: string): number[] {
  const hay = text.toLowerCase()
  const offsets: number[] = []
  let from = 0
  for (;;) {
    const i = hay.indexOf(qLower, from)
    if (i === -1) break
    offsets.push(i)
    from = i + qLower.length
  }
  return offsets
}

/** Extract a readable snippet centered on the FIRST match, with all match ranges that
 *  fall inside the window mapped to snippet-relative coordinates for highlighting. */
function makeSnippet(text: string, offsets: number[], qLen: number): { snippet: string; ranges: SnippetRange[] } {
  const first = offsets[0]
  let start = Math.max(0, first - SNIPPET_RADIUS)
  let end = Math.min(text.length, first + qLen + SNIPPET_RADIUS)
  // Snap to word boundaries so we don't cut mid-word (best-effort, bounded look).
  if (start > 0) {
    const ws = text.lastIndexOf(' ', start)
    if (ws > start - 15 && ws !== -1) start = ws + 1
  }
  if (end < text.length) {
    const we = text.indexOf(' ', end)
    if (we !== -1 && we < end + 15) end = we
  }
  let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim()
  const prefix = start > 0 ? '… ' : ''
  const suffix = end < text.length ? ' …' : ''
  // Re-find matches inside the trimmed snippet (indices shift after collapse/trim), so
  // highlight ranges are always correct relative to the final displayed string.
  const qLower = text.slice(first, first + qLen).toLowerCase()
  const inSnippet = findMatches(snippet, qLower)
  snippet = prefix + snippet + suffix
  const ranges: SnippetRange[] = inSnippet.map((i) => ({
    start: i + prefix.length,
    end: i + prefix.length + qLen
  }))
  return { snippet, ranges }
}

/** Enumerate on-disk session files (like listSessions), newest-first by mtime.
 *  `scopeSlug` restricts to one workspace dir — the scope facet's perf win: other
 *  project dirs are never read/parsed. */
async function enumerateSessionFiles(
  scopeSlug?: string
): Promise<{ filePath: string; sessionId: string; slug: string; mtimeMs: number; size: number }[]> {
  const root = projectsRoot()
  let slugs: string[]
  try {
    slugs = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name)
  } catch {
    return []
  }
  if (scopeSlug) slugs = slugs.filter((s) => s === scopeSlug)
  const out: { filePath: string; sessionId: string; slug: string; mtimeMs: number; size: number }[] = []
  for (const slug of slugs) {
    const dir = join(root, slug)
    let files: string[]
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const f of files) {
      const filePath = join(dir, f)
      try {
        const st = await stat(filePath)
        if (st.size === 0) continue
        out.push({ filePath, sessionId: f.slice(0, -6), slug, mtimeMs: st.mtimeMs, size: st.size })
      } catch {
        // vanished mid-scan; skip
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

/**
 * Global content search. `titleFor` resolves a session id → display title (passed in
 * from the caller which already has the sidecar/scan data). `queryId` is the caller's
 * monotonic token for latest-wins cancellation.
 */
export async function searchSessions(
  query: string,
  queryId: number,
  titleFor: (sessionId: string) => { title: string; cwd: string },
  opts: { scopeSlug?: string; userOnly?: boolean } = {}
): Promise<SearchResults> {
  latestQueryId = Math.max(latestQueryId, queryId)
  const q = query.trim()
  if (q.length < MIN_QUERY) return { sessions: [], tooShort: true }
  const qLower = q.toLowerCase()

  const files = await enumerateSessionFiles(opts.scopeSlug)
  const groups: SearchResults['sessions'] = []
  let processed = 0

  for (const f of files) {
    // Latest-query-wins: a newer query started → abandon this (now-stale) scan.
    if (queryId !== latestQueryId) return { sessions: [], tooShort: false }
    // Yield to the event loop periodically so a cold scan never blocks streaming.
    if (++processed % 4 === 0) await yieldToLoop()

    let records: SearchableMessage[]
    try {
      records = await getRecords(f.filePath, f.mtimeMs, f.size)
    } catch {
      continue
    }

    const hits: SearchHit[] = []
    let totalHits = 0
    const meta = titleFor(f.sessionId)
    for (const r of records) {
      // Role facet: "You only" restricts to user messages (pure subtraction — the
      // cache stores all roles, so toggling never re-parses).
      if (opts.userOnly && r.role !== 'user') continue
      const offsets = findMatches(r.text, qLower)
      if (offsets.length === 0) continue
      totalHits += 1
      if (hits.length < MAX_HITS_PER_SESSION) {
        const { snippet, ranges } = makeSnippet(r.text, offsets, q.length)
        hits.push({
          sessionId: f.sessionId,
          cwd: meta.cwd,
          title: meta.title,
          messageId: r.id,
          role: r.role,
          snippet,
          ranges,
          matchCount: offsets.length
        })
      }
    }
    if (hits.length > 0) {
      groups.push({
        sessionId: f.sessionId,
        cwd: meta.cwd,
        title: meta.title,
        label: basename(meta.cwd) || meta.cwd,
        mtimeMs: f.mtimeMs,
        hits,
        totalHits
      })
    }
  }

  return { sessions: groups, tooShort: false }
}
