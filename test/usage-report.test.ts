// The /usage and /cost report becomes a stat card only when the whole document is the CLI's report.
import { parseUsageReport } from '../src/renderer/src/lib/usageReport.ts'
import { equal, ok } from './support/harness.mjs'

// 2.1.329's template: "Estimated cost:" leads, and "Mods' model calls:" is an unknown row the card skips.
const current = `Estimated cost:        $1.23
Mods' model calls:     $0.10 of the total
Total duration (API):  2m 3.4s
Total duration (wall): 10m 2.0s
Total code changes:    12 lines added, 3 lines removed
Usage by model:
  claude-sonnet-4-6:  774.3k input, 12.1k output, 1.2m cache read, 40.0k cache write ($1.23)
Prompt cache (main):   14 requests · 92% of input tokens from cache · no misses`

const r = parseUsageReport(current)
equal(r?.cost, '$1.23', 'usage: "Estimated cost:" leads the report and fills the cost')
equal(r?.wallDuration, '10m 2.0s', 'usage: the one-space wall row still parses')
equal(r?.models[0]?.model, 'claude-sonnet-4-6', 'usage: per-model rows parse')
equal(r?.promptCache[0]?.segments.length, 3, 'usage: prompt cache segments split')
equal(parseUsageReport(current.replace('Estimated cost:', 'Total cost:    '))?.cost, '$1.23', 'usage: an older "Total cost:" report still parses')
ok(parseUsageReport(`Some prose first.\n${current}`) === null, 'usage: a report after prose is not the report')
ok(parseUsageReport(`${current}\nand a sentence with no colon`) === null, 'usage: stray prose falls back')
