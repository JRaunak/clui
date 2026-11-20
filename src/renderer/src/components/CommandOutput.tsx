/**
 * Clui-native rendering of the CLI's `/usage` and `/cost` reports.
 *
 * WHY THIS EXISTS: the CLI emits that report as preformatted, column-aligned text
 * (newlines + runs of spaces). Piping it through react-markdown collapses the
 * whitespace into one unreadable run-on line. A raw <pre> looks like terminal
 * spillover, so instead we parse the key/value lines into a Clui-native stat card.
 *
 * Parsing is best-effort. parseUsageReport returns null if the text doesn't look like
 * the report (the CLI could change its wording on an upgrade); callers fall back to a
 * formatting-preserving <pre> so output is never lost. Worst case it looks plain, never
 * blank or scrambled.
 */
import { Fragment } from 'react'
import type { UsageReport } from '../lib/usageReport'

// ─────────────────────────────────────────────────────────────────────────────
// /context report: parsed into a native card with a fill gauge + category bars
// ─────────────────────────────────────────────────────────────────────────────

/** A parsed `/context` report. On 2.1.209 the CLI emits GFM markdown: a **Tokens:**
 *  X / Y (Z%) line + a "usage by category" table. Fields optional; render what we found. */
export interface ContextReport {
  model?: string
  usedLabel?: string // "16.9k"
  totalLabel?: string // "1m"
  percent?: number // 2
  categories: { name: string; tokens: string; percent: number }[]
}

/**
 * Detect + parse the `/context` report. Gated on the "## Context Usage" heading (stable
 * across the versions verified). Returns null when it doesn't match, so the caller falls
 * back to normal markdown and output is never lost.
 */
export function parseContextReport(text: string): ContextReport | null {
  if (!/^\s*##\s+Context Usage/m.test(text)) return null
  const report: ContextReport = { categories: [] }

  const model = /\*\*Model:\*\*\s*(.+?)\s*$/m.exec(text)
  if (model) report.model = model[1].trim()

  // **Tokens:** 16.9k / 1m (2%)
  const tok = /\*\*Tokens:\*\*\s*([\d.]+[kmb]?)\s*\/\s*([\d.]+[kmb]?)\s*\((\d+)%\)/i.exec(text)
  if (tok) {
    report.usedLabel = tok[1]
    report.totalLabel = tok[2]
    report.percent = Number(tok[3])
  }

  // Category table rows: "| System prompt | 2.1k | 0.2% |". Scan only the "Estimated
  // usage by category" section (from its heading to the next "### " sibling) so other
  // token tables can never leak in as phantom bars.
  const catSection =
    /###\s+Estimated usage by category([\s\S]*?)(?=\n###\s|$)/i.exec(text)?.[1] ?? text
  const rowRe = /^\|\s*([^|]+?)\s*\|\s*([\d.]+[kmb]?)\s*\|\s*([\d.]+)%\s*\|\s*$/gim
  let m: RegExpExecArray | null
  while ((m = rowRe.exec(catSection)) !== null) {
    const name = m[1].trim()
    if (/^category$/i.test(name)) continue
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
  // The fill gauge tone escalates like the ContextRing: calm, amber near the 80% warning,
  // red near the ~96.7% auto-compact point, so the card carries the same meaning as the
  // composer's ring (state by position + tone, not color alone).
  const fillTone = pct >= 90 ? 'bg-err' : pct >= 80 ? 'bg-warn' : 'bg-ok'
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-tool">
      <div className="flex items-center justify-between border-b border-border/60 px-3.5 py-2">
        <span className="text-caps uppercase text-dim">
          Context
        </span>
        {report.model && (
          <span className="truncate font-mono text-meta text-faint" title={report.model}>
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
          {/* Fill gauge: a horizontal echo of the composer's context ring. */}
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
      <span className="text-caps uppercase text-faint">{label}</span>
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
        <span className="text-caps uppercase text-dim">Usage</span>
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
          <span className="text-caps uppercase text-faint">By model</span>
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
      {report.promptCache.length > 0 && (
        <div className="border-t border-border/60 px-3.5 py-2.5">
          <span className="text-caps uppercase text-faint">Prompt cache</span>
          <div className="mt-1.5 flex flex-col gap-1">
            {report.promptCache.map((c, i) => (
              <div key={i} className="flex flex-col gap-0.5 font-mono text-xs sm:flex-row sm:gap-2">
                <span className="shrink-0 font-semibold text-content">{c.scope}</span>
                <span className="text-dim">
                  {c.segments.map((seg, j) => (
                    <Fragment key={j}>
                      {j > 0 && <span className="text-faint"> · </span>}
                      {seg}
                    </Fragment>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
