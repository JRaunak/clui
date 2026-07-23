/**
 * Fuzzy subsequence matching for the command palette (⌘K).
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
