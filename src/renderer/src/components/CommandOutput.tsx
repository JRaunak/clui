/**
 * Clui-native rendering of the CLI's `/usage` (and `/cost`) report.
 *
 * WHY THIS EXISTS: the CLI emits that report as PREFORMATTED, column-aligned text
 * (newlines + runs of spaces). Piping it through react-markdown collapses the
 * whitespace → one unreadable run-on line (the reported bug). Rather than a raw
 * <pre> that looks like terminal spillover, we parse the key/value lines into a
 * Clui-native stat card — labeled rows + a per-model usage table.
 *
 * DEFENSIVE / DRIFT-SAFE: parsing is best-effort. `parseUsageReport` returns null
 * if the text doesn't look like the report (the CLI could change its wording on an
 * upgrade); callers fall back to a formatting-preserving <pre> so output is NEVER
 * lost — worst case it looks plain, never blank or scrambled. This mirrors the
 * transcript reader's "defensive, display-only" stance.
 */

/** A parsed usage/cost report. Fields are optional — we render whatever we found. */
export interface UsageReport {
  cost?: string
  apiDuration?: string
  wallDuration?: string
  codeChanges?: string
  /** Per-model usage lines, e.g. "claude-opus-4-8" → "774.3k input, … ($235.91)". */
  models: { model: string; detail: string }[]
}

/**
 * Detect + parse the `/usage` report. Recognized by the leading "Total cost:" line
 * (stable across the versions we verified). Returns null when it doesn't match, so
 * the caller can fall back. Tolerant of extra/missing lines and variable spacing.
 */
export function parseUsageReport(text: string): UsageReport | null {
  // Cheap gate first — must look like the report, not arbitrary assistant prose.
  if (!/^\s*Total cost:/m.test(text)) return null

  const report: UsageReport = { models: [] }
  const lines = text.split('\n')
  let inModels = false

  for (const line of lines) {
    // NOTE: value column is aligned to `len(longest label)+1`, so the LONGEST
    // label (e.g. "Total duration (wall):") gets exactly ONE space before its
    // value — `\s{2,}` silently dropped that row. `\s+` recovers it; the gate
    // above + the known-key allowlist below keep prose from matching.
    const kv = /^\s*([^:]+?):\s+(.+?)\s*$/.exec(line)
    // "Usage by model:" is a section header (value empty) — following indented lines
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
      inModels = false // fell out of the model block
    }
    if (!kv) continue
    const key = kv[1].trim().toLowerCase()
    const val = kv[2].trim()
    if (key === 'total cost') report.cost = val
    else if (key === 'total duration (api)') report.apiDuration = val
    else if (key === 'total duration (wall)') report.wallDuration = val
    else if (key === 'total code changes') report.codeChanges = val
    // A single-line "Usage:" (no per-model breakdown) → treat as one anonymous row.
    else if (key === 'usage') report.models.push({ model: '', detail: val })
  }

  // If we matched the gate but extracted nothing useful, signal "not parseable" so
  // the caller shows the raw text rather than an empty card.
  if (
    !report.cost &&
    !report.apiDuration &&
    !report.wallDuration &&
    !report.codeChanges &&
    report.models.length === 0
  ) {
    return null
  }
  return report
}

// ─────────────────────────────────────────────────────────────────────────────
// /context report — parsed into a native card with a fill gauge + category bars
// ─────────────────────────────────────────────────────────────────────────────

/** A parsed `/context` report. On 2.1.209 the CLI emits GFM markdown: a `**Tokens:**
 *  X / Y (Z%)` line + a "usage by category" table. Fields optional; render what we found. */
export interface ContextReport {
  model?: string
  usedLabel?: string // "16.9k"
  totalLabel?: string // "1m"
  percent?: number // 2
  categories: { name: string; tokens: string; percent: number }[]
}

/**
 * Detect + parse the `/context` report. Gated on the "## Context Usage" heading (stable
 * across the versions verified). Returns null when it doesn't match → the caller falls
 * back to normal markdown, so output is never lost (mirrors parseUsageReport).
 */
export function parseContextReport(text: string): ContextReport | null {
  if (!/^\s*##\s+Context Usage/m.test(text)) return null
  const report: ContextReport = { categories: [] }

  const model = /\*\*Model:\*\*\s*(.+?)\s*$/m.exec(text)
  if (model) report.model = model[1].trim()

  // "**Tokens:** 16.9k / 1m (2%)"
  const tok = /\*\*Tokens:\*\*\s*([\d.]+[kmb]?)\s*\/\s*([\d.]+[kmb]?)\s*\((\d+)%\)/i.exec(text)
  if (tok) {
    report.usedLabel = tok[1]
    report.totalLabel = tok[2]
    report.percent = Number(tok[3])
  }

  // Category table rows: "| System prompt | 2.1k | 0.2% |". Scan ONLY the "Estimated
  // usage by category" section — from its heading to the next "### " sibling — so other
  // token tables ("### Custom Agents", "### Skills") can never leak in as phantom bars.
  const catSection =
    /###\s+Estimated usage by category([\s\S]*?)(?=\n###\s|$)/i.exec(text)?.[1] ?? text
  const rowRe = /^\|\s*([^|]+?)\s*\|\s*([\d.]+[kmb]?)\s*\|\s*([\d.]+)%\s*\|\s*$/gim
  let m: RegExpExecArray | null
  while ((m = rowRe.exec(catSection)) !== null) {
    const name = m[1].trim()
    if (/^category$/i.test(name)) continue // header row
    report.categories.push({ name, tokens: m[2], percent: Number(m[3]) })
  }

  if (report.percent === undefined && report.categories.length === 0) return null
  return report
}

/** Category → bar color. Free space is neutral; the rest use the tool-surface content
 *  ramp so the card reads as one system (no new accent spend). */
function catColor(name: string): string {
  if (/free space/i.test(name)) return 'bg-border-strong'
  return 'bg-dim'
}

export function ContextCard({ report }: { report: ContextReport }): JSX.Element {
  const pct = report.percent ?? 0
  // The fill gauge tone escalates like the ContextRing: calm → amber near the 80%
  // warning → red near the ~96.7% auto-compact point (1M) so the card carries the
  // same meaning as the composer's ring (state by position + tone, not color alone).
  const fillTone = pct >= 90 ? 'bg-err' : pct >= 80 ? 'bg-warn' : 'bg-ok'
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-tool">
      <div className="flex items-center justify-between border-b border-border/60 px-3.5 py-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-accent">
          Context
        </span>
        {report.model && (
          <span className="truncate font-mono text-[11px] text-faint" title={report.model}>
            {report.model}
          </span>
        )}
      </div>
      {report.usedLabel && report.totalLabel && (
        <div className="px-3.5 pt-3">
          <div className="flex items-baseline justify-between font-mono text-sm tabular-nums">
            <span className="text-content">
              {report.usedLabel} <span className="text-faint">/ {report.totalLabel}</span>
            </span>
            <span className="text-dim">{pct}%</span>
          </div>
          {/* Fill gauge — a horizontal echo of the composer's context ring. */}
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-bg-raised">
            <div className={`h-full rounded-full ${fillTone}`} style={{ width: `${Math.max(1, pct)}%` }} />
          </div>
        </div>
      )}
      {report.categories.length > 0 && (
        <div className="flex flex-col gap-1.5 px-3.5 py-3">
          {report.categories.map((c) => (
            <div key={c.name} className="flex items-center gap-2 text-xs">
              <span className="w-40 shrink-0 truncate text-dim" title={c.name}>
                {c.name}
              </span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-raised">
                <div
                  className={`h-full rounded-full ${catColor(c.name)}`}
                  style={{ width: `${Math.max(1, Math.min(100, c.percent))}%` }}
                />
              </div>
              <span className="w-14 shrink-0 text-right font-mono tabular-nums text-faint">
                {c.tokens}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-faint">{label}</span>
      <span className="font-mono text-sm tabular-nums text-content">{value}</span>
    </div>
  )
}

export function UsageCard({ report }: { report: UsageReport }): JSX.Element {
  const stats = [
    report.cost && { label: 'Cost', value: report.cost },
    report.apiDuration && { label: 'API time', value: report.apiDuration },
    report.wallDuration && { label: 'Wall time', value: report.wallDuration },
    report.codeChanges && { label: 'Code changes', value: report.codeChanges }
  ].filter(Boolean) as { label: string; value: string }[]

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-tool">
      <div className="border-b border-border/60 px-3.5 py-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-accent">Usage</span>
      </div>
      {stats.length > 0 && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 px-3.5 py-3 sm:grid-cols-4">
          {stats.map((s) => (
            <Stat key={s.label} label={s.label} value={s.value} />
          ))}
        </div>
      )}
      {report.models.length > 0 && (
        <div className="border-t border-border/60 px-3.5 py-2.5">
          <span className="text-[11px] uppercase tracking-wide text-faint">By model</span>
          <div className="mt-1.5 flex flex-col gap-1">
            {report.models.map((m, i) => (
              <div key={i} className="flex flex-col gap-0.5 font-mono text-xs sm:flex-row sm:gap-2">
                {m.model && <span className="shrink-0 font-semibold text-content">{m.model}</span>}
                <span className="text-dim">{m.detail}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
