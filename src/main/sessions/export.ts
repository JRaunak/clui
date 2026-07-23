/**
 * Export a conversation to a human-readable Markdown file.
 *
 * Reads the session's transcript from disk (via the existing parser — NO resume, no
 * process spawn: this works on dormant sessions without opening them) and renders:
 *   # <title>
 *   *<workspace> · <model?> · exported <date> · <N> messages*   ← one-line provenance
 *   ## You / ## Claude   speaker headings
 *   fenced code preserved (assistant text is already markdown; user text is literal)
 *   › <Tool> · <summary>   dim one-line tool-call markers (NOT full I/O dumps — the
 *                          jsonl already holds that; a readable export shouldn't be 30MB)
 *   ![attached image] / [attached <file>]   attachment placeholders (no base64 inlined)
 *
 * Design: Markdown only, single session,
 * one-line provenance (NOT YAML front-matter — a reader skims YAML; the jsonl is the
 * structured source). Human readability + git-diff-friendliness over machine metadata.
 */
import { readTranscript } from './transcript'
import type { HistoryMessage, HistoryToolCall } from '../../shared/sessions'

export interface ExportMeta {
  title: string
  cwd: string
  model?: string
  /** ISO date (YYYY-MM-DD) stamped in the provenance line; passed in (main can use Date). */
  date: string
}

/** One-line summary of a tool call for the export (name + the human-meaningful arg). */
function toolSummary(t: HistoryToolCall): string {
  const input = t.input
  let arg = ''
  if (input && typeof input === 'object') {
    const rec = input as Record<string, unknown>
    // Prefer the most descriptive single field, mirroring the search-input allowlist.
    for (const key of ['file_path', 'command', 'pattern', 'query', 'url', 'description']) {
      const v = rec[key]
      if (typeof v === 'string' && v) {
        arg = v.length > 80 ? v.slice(0, 77) + '…' : v
        break
      }
    }
  }
  const err = t.isError ? ' (error)' : ''
  return `› ${t.name || 'tool'}${arg ? ` · ${arg}` : ''}${err}`
}

/** Render one message to Markdown blocks. */
function renderMessage(m: HistoryMessage): string {
  const heading = m.role === 'user' ? '## You' : '## Claude'
  const parts: string[] = [heading]

  // Attachment placeholders (never inline base64 — keeps the .md small + readable).
  for (const a of m.attachments ?? []) {
    if (a.kind === 'image') parts.push('![attached image]')
    else if (a.kind === 'document') parts.push(`[attached ${a.name}]`)
    else parts.push(`[attached ${a.name}]`)
  }

  if (m.text.trim()) parts.push(m.text.trim())

  // Tool calls as dim one-line markers (summary, not full I/O).
  for (const t of m.tools) parts.push(toolSummary(t))

  return parts.join('\n\n')
}

/** Build the full Markdown document for a session. */
export async function exportSessionMarkdown(sessionId: string, meta: ExportMeta): Promise<string> {
  const { messages } = await readTranscript(sessionId)
  const workspace = meta.cwd || 'unknown workspace'
  const provenance = [
    workspace,
    meta.model,
    `exported ${meta.date}`,
    `${messages.length} message${messages.length === 1 ? '' : 's'}`
  ]
    .filter(Boolean)
    .join(' · ')

  const body = messages.map(renderMessage).join('\n\n')
  return `# ${meta.title}\n\n*${provenance}*\n\n${body}\n`
}

/** Filesystem-safe filename from a session title (no ext). */
export function exportFilename(title: string): string {
  const base = title
    .trim()
    .replace(/[/\\:*?"<>|]/g, '') // strip path-illegal chars
    .replace(/\s+/g, '-')
    .slice(0, 60)
  return (base || 'conversation') + '.md'
}
