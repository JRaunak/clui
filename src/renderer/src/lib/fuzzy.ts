/**
 * Fuzzy subsequence matching for the command palette (⌘K), and the path ranker the file pickers share.
 *
 * VS Code-style: query characters may match non-contiguously ("clw" → "CLui
 * DevelopmentW…"), and we return the matched character indices so the UI can
 * highlight them. Scoring rewards contiguous runs, word-boundary starts, and
 * early matches, so the most relevant item ranks first. Case-insensitive.
 */

export interface FuzzyResult {
  /** Higher is better. Null when the query is not a subsequence of the text. */
  score: number | null
  /** Indices in the ORIGINAL text that matched, for highlighting. */
  matches: number[]
}

/**
 * Match `query` against `text` as a subsequence. Empty query → score 0 (matches
 * everything, no highlights), so an empty palette input lists all items in their
 * caller-provided order.
 */
export function fuzzyMatch(query: string, text: string): FuzzyResult {
  const q = query.trim().toLowerCase()
  if (!q) return { score: 0, matches: [] }
  const t = text.toLowerCase()

  const matches: number[] = []
  let score = 0
  let qi = 0
  let prevMatch = -2 // for contiguity bonus
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue
    matches.push(ti)
    // Base point for a match.
    score += 1
    // Contiguous with the previous matched char → strong bonus.
    if (ti === prevMatch + 1) score += 5
    // Word-boundary start (begin, or after a non-alphanumeric) → bonus.
    if (ti === 0 || /[^a-z0-9]/i.test(t[ti - 1])) score += 3
    // Earlier matches slightly preferred.
    score += Math.max(0, 2 - ti * 0.01)
    prevMatch = ti
    qi++
  }
  if (qi < q.length) return { score: null, matches: [] } // not a full subsequence
  return { score, matches }
}

/** Split `text` into alternating {text, match} runs for highlight rendering. */
export function highlightRuns(
  text: string,
  matches: number[]
): { text: string; match: boolean }[] {
  if (!matches.length) return [{ text, match: false }]
  const set = new Set(matches)
  const runs: { text: string; match: boolean }[] = []
  let buf = ''
  let cur = set.has(0)
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i)
    if (m !== cur) {
      runs.push({ text: buf, match: cur })
      buf = ''
      cur = m
    }
    buf += text[i]
  }
  if (buf) runs.push({ text: buf, match: cur })
  return runs
}

/** The lowest score of a name match (substring or better). Below it, the query's letters only lie scattered along the path. */
export const NAME_TIER = 1000

export interface Ranked<T> {
  item: T
  score: number
  /** Indices in the path, for highlighting. */
  matches: number[]
}

const span = (from: number, n: number): number[] => Array.from({ length: n }, (_, k) => from + k)

/**
 * One path against `query`: exact, prefix, then substring on its last segment, then a subsequence of the whole
 * path. The tiers sit NAME_TIER apart so a lower one can't add up into a higher one. A query with a `/` can't
 * match a segment, so it ranks on the whole path alone. Null when the query isn't a subsequence of the path.
 */
export function scorePath(query: string, path: string): { score: number; matches: number[] } | null {
  const whole = fuzzyMatch(query, path)
  if (whole.score === null) return null
  const q = query.trim().toLowerCase()
  if (!q) return { score: 0, matches: [] }
  const at = path.lastIndexOf('/') + 1
  const name = path.slice(at).toLowerCase()
  if (name === q) return { score: 3 * NAME_TIER, matches: span(at, q.length) }
  const bm = fuzzyMatch(q, name)
  if (bm.score === null) return { score: whole.score, matches: whole.matches }
  if (name.startsWith(q)) return { score: 2 * NAME_TIER + bm.score, matches: span(at, q.length) }
  const i = name.indexOf(q)
  if (i >= 0) return { score: NAME_TIER + bm.score, matches: span(at + i, q.length) }
  return bm.score >= whole.score ? { score: bm.score, matches: bm.matches.map((m) => m + at) } : { score: whole.score, matches: whole.matches }
}

/**
 * The app's one path ranker, so a query orders files the same in the composer's @ picker and in Open file. Best
 * first, ties to the shorter path. Scattered matches drop out once any path matches by name: a short query on a
 * deep tree is a subsequence of nearly every path. With no name match they stay, so a deliberately deep query
 * still finds its file. An empty query keeps the input order. `lift` raises an item's name match above every
 * plain path's.
 */
export function rankPaths<T = string>(
  query: string,
  items: readonly T[],
  pathOf: (item: T) => string = (item) => item as string,
  lift: (item: T) => number = () => 0
): Ranked<T>[] {
  const out: Ranked<T>[] = []
  for (const item of items) {
    const r = scorePath(query, pathOf(item))
    if (r) out.push({ item, score: r.score >= NAME_TIER ? r.score + lift(item) : r.score, matches: r.matches })
  }
  if (!query.trim()) return out
  out.sort((a, b) => b.score - a.score || pathOf(a.item).length - pathOf(b.item).length)
  return out.some((r) => r.score >= NAME_TIER) ? out.filter((r) => r.score >= NAME_TIER) : out
}

/** `store.ts:142` or `store.ts:142:5`: the name to match and the line to open at. The column is dropped. */
export function splitLine(query: string): { query: string; line: number | null } {
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(query.trim())
  return m && m[1] && +m[2] > 0 ? { query: m[1], line: +m[2] } : { query, line: null }
}
