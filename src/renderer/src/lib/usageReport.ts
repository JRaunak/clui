/** A parsed usage/cost report. Fields are optional; we render whatever we found. */
export interface UsageReport {
  cost?: string
  apiDuration?: string
  wallDuration?: string
  codeChanges?: string
  /** Per-model usage lines, e.g. "claude-opus-4-8" → "774.3k input, … ($235.91)". */
  models: { model: string; detail: string }[]
  promptCache: { scope: string; segments: string[] }[]
}

/**
 * Detect + parse the `/usage` report. Recognized by its leading cost line: "Estimated cost:"
 * on 2.1.329, "Total cost:" on older CLIs and in transcripts they wrote.
 * Returns null when it doesn't match, so the caller can fall back. Tolerant of extra/missing
 * lines and variable spacing.
 */
export function parseUsageReport(text: string): UsageReport | null {
  // Gate on the whole-document shape, not a cost line anywhere: the real report is what the
  // CLI emits verbatim, so the first non-empty line must be the cost line. Otherwise ordinary
  // prose or an approval plan that merely mentions a cost would be replaced by a stats card,
  // dropping its surrounding content.
  const firstNonEmpty = text.split('\n').find((l) => l.trim() !== '')
  if (!firstNonEmpty || !/^\s*(Estimated|Total) cost:/.test(firstNonEmpty)) return null

  const report: UsageReport = { models: [], promptCache: [] }
  const lines = text.split('\n')
  let inModels = false
  // A real report is entirely "Label: value" rows / model rows / blanks. A non-blank line
  // with no colon is free prose, so this isn't a pure report; don't hijack the document.
  let strayProse = false

  for (const line of lines) {
    if (line.trim() !== '' && !line.includes(':')) strayProse = true
    // Value column is aligned to len(longest label)+1, so the longest label (e.g.
    // "Total duration (wall):") gets exactly one space before its value. Don't tighten
    // this to \s{2,}: it silently drops that row. \s+ matches it; the gate above + the
    // known-key allowlist below keep prose out.
    const kv = /^\s*([^:]+?):\s+(.+?)\s*$/.exec(line)
    // "Usage by model:" is a section header (value empty); following indented lines
    // are per-model rows until a non-indented / non-model line.
    if (/^\s*Usage by model:\s*$/.test(line)) {
      inModels = true
      continue
    }
    if (inModels) {
      // Model rows look like "     claude-opus-4-8:  774.3k input, … ($x)".
      const m = /^\s+([\w.\-[\]]+):\s+(.+?)\s*$/.exec(line)
      if (m) {
        report.models.push({ model: m[1], detail: m[2] })
        continue
      }
      if (line.trim() === '') continue
      inModels = false
    }
    const cache = /^\s*Prompt cache \(([^)]+)\):\s+(.+?)\s*$/.exec(line)
    if (cache) {
      report.promptCache.push({ scope: cache[1], segments: cache[2].split(' · ') })
      continue
    }
    if (!kv) continue
    const key = kv[1].trim().toLowerCase()
    const val = kv[2].trim()
    if (key === 'estimated cost' || key === 'total cost') report.cost = val
    else if (key === 'total duration (api)') report.apiDuration = val
    else if (key === 'total duration (wall)') report.wallDuration = val
    else if (key === 'total code changes') report.codeChanges = val
    // A single-line "Usage:" (no per-model breakdown) is treated as one anonymous row.
    else if (key === 'usage') report.models.push({ model: '', detail: val })
  }

  // Free prose mixed in is not a pure report; fall back so no document content is lost.
  if (strayProse) return null

  // If we matched the gate but extracted nothing useful, signal "not parseable" so
  // the caller shows the raw text rather than an empty card.
  if (
    !report.cost &&
    !report.apiDuration &&
    !report.wallDuration &&
    !report.codeChanges &&
    report.models.length === 0 &&
    report.promptCache.length === 0
  ) {
    return null
  }
  return report
}
