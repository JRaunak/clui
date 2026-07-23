/**
 * Reconstruct a renderable transcript from a session's `.jsonl` (for showing
 * history on resume). The jsonl format is internal + version-dependent, so this
 * is DEFENSIVE, display-only parsing: unknown entry/block shapes are skipped,
 * never thrown. Live streaming (documented stream-json) is the load-bearing path;
 * this is a best-effort rendering of the past.
 *
 * Output matches the renderer's ChatMessage/ToolCall (via HistoryMessage) so
 * history and new turns render identically.
 */
import { createReadStream } from 'node:fs'
import { readdir, stat, readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HistoryMessage, HistoryToolCall, TranscriptResult } from '../../shared/sessions'

const projectsRoot = (): string => join(homedir(), '.claude', 'projects')

/**
 * OOM safety ceiling, NOT a render cap. The transcript is now VIRTUALIZED
 * (react-virtuoso in Chat.tsx renders only the visible window), so we return the
 * WHOLE transcript — the old 200 render-cap is gone. This ceiling only guards
 * against a pathological/corrupt multi-hundred-MB file OOMing the main process;
 * a real human transcript never approaches it (measured corpus max ~4,600 msgs).
 */
const SAFETY_CAP = 50_000

/** A raw jsonl transcript entry (only the fields we read). */
interface RawEntry {
  type?: string
  subtype?: string
  /** For `system`/local_command entries: the raw stdout wrapper string. */
  content?: unknown
  uuid?: string
  isSidechain?: boolean
  message?: {
    role?: string
    content?: unknown
    usage?: RawUsage
  }
  usage?: RawUsage
}

/** Unwrap <local-command-stdout>…</local-command-stdout> to the inner text. */
function stripCommandStdout(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const m = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(raw)
  return (m ? m[1] : raw).trim()
}

/**
 * True when a user message is CLI plumbing that the terminal never shows: the
 * `<command-name>/x</command-name>` echo and the `<local-command-caveat>…` notice
 * the CLI injects around a slash command. Rendering them as "You" bubbles is the
 * raw-XML noise seen on resume. (The command's OUTPUT is a separate local_command
 * record, surfaced above — so hiding these loses nothing the user typed.)
 */
function isCommandPlumbing(text: string): boolean {
  // Suppress synthetic user turns the CLI injects into the transcript: slash-command
  // plumbing (<command-*>/<local-command-*>) AND background-task/workflow completion
  // notices (<task-notification> — the CLI feeds a finished bg task's result back to
  // the model as a user message; the user already sees it via the tool card + tray, so
  // rendering the raw XML as a chat bubble is noise).
  return /^\s*<(command-(message|name|args)|local-command-(caveat|stdout)|task-notification)>/.test(
    text
  )
}

interface RawUsage {
  input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** Resident context tokens from a usage record (input + cache), or 0 if none. */
function residentTokens(u: RawUsage | undefined): number {
  if (!u) return 0
  return (
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0)
  )
}

interface ContentBlock {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
  /** Image block: `{ type:'base64', media_type, data }` (Anthropic content shape). The
   *  bytes are inlined in the jsonl, so a resumed session can recover the user's own
   *  attached images. `url`-type sources are not recoverable here. */
  source?: { type?: string; media_type?: string; data?: string; url?: string }
}

/** Budget for recovered images per transcript read — full-size base64 held in the
 *  store bloats memory (unlike the LIVE path, which downscales a small preview before
 *  storing; the renderer has canvas, main does not). Clui-sent images are already
 *  ≤1568px, so this only bites on full-res images from another client. Beyond the cap
 *  the block degrades to the `[image]` text placeholder. */
const MAX_RECOVERED_IMAGES = 30
const MAX_RECOVERED_IMAGE_BYTES = 25 * 1024 * 1024

/** Locate a session's jsonl across project dirs (optionally scoped to a cwd slug). */
async function findTranscriptFile(sessionId: string): Promise<string | null> {
  const root = projectsRoot()
  let slugs: string[]
  try {
    slugs = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name)
  } catch {
    return null
  }
  for (const slug of slugs) {
    const p = join(root, slug, `${sessionId}.jsonl`)
    try {
      const st = await stat(p)
      if (st.size > 0) return p
    } catch {
      // not here; keep looking
    }
  }
  return null
}

/**
 * Resolved agent-transcript paths, keyed by `agent:<agentId>` / `tool:<toolUseId>`. The
 * finders below run a depth-5 readdir DFS over the whole projects tree; while a subagent
 * panel is open the UI re-calls them every ~2s, and once a transcript file exists its path
 * never moves — so cache the resolved path and revalidate with a single `stat` on the next
 * lookup, collapsing the steady-state to one syscall instead of re-walking the tree. A
 * stale entry (file gone) falls back to a fresh walk.
 */
const agentPathCache = new Map<string, string>()
async function cachedFind(key: string, walk: () => Promise<string | null>): Promise<string | null> {
  const hit = agentPathCache.get(key)
  if (hit) {
    try {
      if ((await stat(hit)).size >= 0) return hit
    } catch {
      agentPathCache.delete(key) // moved/deleted — fall through to a fresh walk
    }
  }
  const found = await walk()
  if (found) agentPathCache.set(key, found)
  return found
}

/**
 * Find an agent transcript `agent-<agentId>.jsonl` anywhere under the projects tree
 * (it lives in a per-session `subagents/` dir, possibly nested under `workflows/<wf>`).
 * Bounded recursive walk (depth-limited; only descends `subagents`/`workflows`/session
 * dirs) so it stays cheap even with many projects. Returns the first match.
 */
function findAgentFile(agentId: string): Promise<string | null> {
  const target = `agent-${agentId}.jsonl`
  const root = projectsRoot()
  // Depth-limited DFS: projects/<slug>/<session>/subagents/[workflows/<wf>/]<file>.
  async function walk(dir: string, depth: number): Promise<string | null> {
    if (depth > 5) return null
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return null
    }
    for (const e of entries) {
      if (e.isFile()) {
        if (e.name === target) return join(dir, e.name)
      } else if (e.isDirectory() || e.isSymbolicLink()) {
        // Only descend dirs that could hold agent transcripts (keeps the walk cheap).
        const found = await walk(join(dir, e.name), depth + 1)
        if (found) return found
      }
    }
    return null
  }
  return cachedFind(`agent:${agentId}`, () => walk(root, 0))
}

/**
 * Nesting: locate an agent transcript by its Agent `tool_use_id` rather than its
 * agentId. Needed for NESTED subagents — the UI only knows a nested child's tool_use_id
 * (from the parent's forwarded `tool_use` block), not its taskId, and `forwardSubagentText`
 * only streams ONE level deep (a grandchild's text never streams live, so disk is the
 * only source). Each `agent-<id>.jsonl` has a sibling `agent-<id>.meta.json` carrying
 * `{toolUseId, parentAgentId, spawnDepth, …}`; we scan those sidecars for the matching
 * toolUseId and return the paired transcript path.
 */
function findAgentFileByToolUseId(toolUseId: string): Promise<string | null> {
  const root = projectsRoot()
  async function walk(dir: string, depth: number): Promise<string | null> {
    if (depth > 5) return null
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return null
    }
    for (const e of entries) {
      if (e.isFile()) {
        if (e.name.startsWith('agent-') && e.name.endsWith('.meta.json')) {
          try {
            const meta = JSON.parse(await readFile(join(dir, e.name), 'utf8')) as {
              toolUseId?: string
            }
            if (meta.toolUseId === toolUseId) {
              // The transcript is the sibling .jsonl (same base name).
              return join(dir, e.name.replace(/\.meta\.json$/, '.jsonl'))
            }
          } catch {
            // Unreadable/partial sidecar — skip it, keep scanning.
          }
        }
      } else if (e.isDirectory() || e.isSymbolicLink()) {
        const found = await walk(join(dir, e.name), depth + 1)
        if (found) return found
      }
    }
    return null
  }
  return cachedFind(`tool:${toolUseId}`, () => walk(root, 0))
}

/** tool_result content can be a string or blocks; normalize to text. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .join('')
  }
  if (content == null) return ''
  try {
    return JSON.stringify(content)
  } catch {
    return ''
  }
}

/**
 * Read + reconstruct the FULL transcript for `sessionId` (virtualized in the UI, so
 * no render cap). `cap` is only the OOM safety ceiling; `capped` is essentially
 * always false now (only a pathological file could trip it).
 */
export async function readTranscript(
  sessionId: string,
  cap = SAFETY_CAP
): Promise<TranscriptResult> {
  const file = await findTranscriptFile(sessionId)
  if (!file) return { messages: [], total: 0, capped: false, contextTokens: null }
  return parseTranscriptFile(file, cap)
}

/**
 * Locate + read a WORKFLOW/SUBAGENT agent transcript by its agentId. These live at
 * `projects/<slug>/<session>/subagents/[workflows/<wf>/]agent-<id>.jsonl` — same
 * record shape as a session transcript, so it reuses the same parser. Returns empty
 * if not found (still streaming, or the CLI changed the layout — degrade gracefully).
 */
export async function readAgentTranscript(
  agentId: string,
  cap = SAFETY_CAP
): Promise<TranscriptResult> {
  const file = await findAgentFile(agentId)
  if (!file) return { messages: [], total: 0, capped: false, contextTokens: null }
  // An agent transcript's OWN records are all `isSidechain:true` (they ARE the
  // sidechain) — so we must NOT skip them here, unlike a main-session read where
  // sidechain records are a subagent's output to be excluded.
  return parseTranscriptFile(file, cap, { includeSidechain: true })
}

/**
 * Nesting: read a subagent transcript located by its Agent `tool_use_id` (via the
 * `.meta.json` sidecar), for NESTED children whose taskId the UI never learns and whose
 * text never streams live. Same sidechain-inclusive parse as `readAgentTranscript`.
 */
export async function readAgentTranscriptByToolUseId(
  toolUseId: string,
  cap = SAFETY_CAP
): Promise<TranscriptResult> {
  const file = await findAgentFileByToolUseId(toolUseId)
  if (!file) return { messages: [], total: 0, capped: false, contextTokens: null }
  return parseTranscriptFile(file, cap, { includeSidechain: true })
}

/**
 * Parse a transcript at a KNOWN path (skips the dir scan `readTranscript` does).
 * Used by the search engine so it reuses the EXACT same parser — guaranteeing the
 * message ids (`h-<seq>-<uuid>`) it returns match `store.messages` for jump-to-hit.
 */
export async function readTranscriptAtPath(file: string): Promise<TranscriptResult> {
  return parseTranscriptFile(file, SAFETY_CAP)
}

async function parseTranscriptFile(
  file: string,
  cap: number,
  opts: { includeSidechain?: boolean } = {}
): Promise<TranscriptResult> {
  const messages: HistoryMessage[] = []
  /** tool_use id → the ToolCall object, so tool_results can be attached later. */
  const toolCallsById = new Map<string, HistoryToolCall>()
  let seq = 0
  // Recovered-image budget across the whole transcript (see the cap consts).
  let recoveredImages = 0
  let recoveredImageBytes = 0
  // Track the LAST usage seen so the context ring reflects the real fill on resume
  // (assistant entries carry usage; the final one is the resident context).
  let lastContextTokens = 0

  const rl = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })

  try {
    for await (const line of rl) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let entry: RawEntry
      try {
        entry = JSON.parse(trimmed)
      } catch {
        continue
      }
      // Only render the main thread; skip subagent sidechains — UNLESS we're reading
      // an agent's own transcript (whose records are all sidechains).
      if (entry.isSidechain && !opts.includeSidechain) continue
      // Capture usage (main thread only) — the last one is the resident context.
      const usedNow = residentTokens(entry.message?.usage ?? entry.usage)
      if (usedNow > 0) lastContextTokens = usedNow

      // Slash-command output is logged as a `system` record of subtype
      // `local_command` carrying <local-command-stdout>…</local-command-stdout>
      // (e.g. the /usage report) — NOT as an assistant message. Surface it as an
      // assistant bubble so resumed history shows the command's result instead of
      // dropping it (the "commands don't work on resume" symptom). Live turns get
      // this via the assistant snapshot; this is the resume-only path.
      if (entry.type === 'system' && entry.subtype === 'local_command') {
        const out = stripCommandStdout(entry.content)
        if (out) {
          messages.push({ id: `h-${seq++}-${entry.uuid ?? ''}`, role: 'assistant', text: out, thinking: '', tools: [] })
        }
        continue
      }

      const role = entry.message?.role
      if (entry.type !== 'user' && entry.type !== 'assistant') continue
      if (role !== 'user' && role !== 'assistant') continue

      const content = entry.message?.content
      const blocks: ContentBlock[] =
        typeof content === 'string'
          ? [{ type: 'text', text: content }]
          : Array.isArray(content)
            ? (content as ContentBlock[])
            : []

      // A user entry that is ONLY tool_results carries no visible user text — we
      // attach those results to prior tool calls and don't emit a user bubble.
      const isToolResultOnly =
        role === 'user' && blocks.length > 0 && blocks.every((b) => b?.type === 'tool_result')

      if (isToolResultOnly) {
        for (const b of blocks) {
          if (b.type === 'tool_result' && b.tool_use_id) {
            const call = toolCallsById.get(b.tool_use_id)
            if (call) {
              call.result = resultText(b.content)
              call.isError = Boolean(b.is_error)
            }
          }
        }
        continue
      }

      const msg: HistoryMessage = {
        id: `h-${seq++}-${entry.uuid ?? ''}`,
        role,
        text: '',
        thinking: '',
        tools: []
      }
      for (const b of blocks) {
        switch (b.type) {
          case 'text':
            if (typeof b.text === 'string') {
              // A dropped TEXT FILE was inlined as a `<file name="…">…</file>` text block
              // (drop-file feature). On resume, recover it as a metadata-only chip rather
              // than dumping the raw wrapper + full contents into the bubble.
              const fileMatch = /^<file name="([^"]*)">\n([\s\S]*)\n<\/file>$/.exec(b.text.trim())
              if (fileMatch) {
                const [, name, body] = fileMatch
                ;(msg.attachments ??= []).push({
                  kind: 'text',
                  name: name || 'file.txt',
                  bytes: body.length,
                  lines: body.split('\n').length
                })
              } else {
                msg.text += b.text
              }
            }
            break
          case 'thinking':
            if (typeof b.thinking === 'string') msg.thinking += b.thinking
            break
          case 'tool_use': {
            if (b.id) {
              const call: HistoryToolCall = {
                id: b.id,
                name: b.name ?? '',
                input: b.input ?? {}
              }
              msg.tools.push(call)
              toolCallsById.set(b.id, call)
            }
            break
          }
          case 'tool_result': {
            // A tool_result mixed into an assistant/other message — attach it.
            if (b.tool_use_id) {
              const call = toolCallsById.get(b.tool_use_id)
              if (call) {
                call.result = resultText(b.content)
                call.isError = Boolean(b.is_error)
              }
            }
            break
          }
          case 'image': {
            // Recover the user's own inlined image. Only base64 sources
            // are recoverable; fall back to the placeholder for url-type or over-budget.
            const src = b.source
            const data = src?.data
            const mediaType = src?.media_type
            const bytes = data ? Math.round((data.length * 3) / 4) : 0
            if (
              src?.type === 'base64' &&
              typeof data === 'string' &&
              typeof mediaType === 'string' &&
              recoveredImages < MAX_RECOVERED_IMAGES &&
              recoveredImageBytes + bytes <= MAX_RECOVERED_IMAGE_BYTES
            ) {
              ;(msg.attachments ??= []).push({ kind: 'image', dataUrl: `data:${mediaType};base64,${data}` })
              recoveredImages += 1
              recoveredImageBytes += bytes
            } else {
              msg.text += (msg.text ? '\n' : '') + '[image]'
            }
            break
          }
          case 'document': {
            // A dropped PDF was inlined as a base64 `document` block (drop-file). We do
            // NOT re-inline its (large) bytes into the store on resume — recover a
            // metadata-only chip so the bubble honestly shows a PDF was attached.
            const src = b.source
            const bytes = typeof src?.data === 'string' ? Math.round((src.data.length * 3) / 4) : 0
            ;(msg.attachments ??= []).push({ kind: 'document', name: 'document.pdf', bytes })
            break
          }
          default:
            // Unknown block type — skip defensively.
            break
        }
      }

      // Skip empty shells (e.g. an assistant entry that was only signatures). An
      // attachments-only user turn is NOT empty — it has chips/thumbnails to render.
      if (!msg.text && !msg.thinking && msg.tools.length === 0 && !msg.attachments?.length) continue
      // Drop CLI slash-command plumbing user-bubbles (<command-name>/<caveat>) —
      // noise the terminal never shows; the command's output is surfaced separately.
      if (role === 'user' && msg.tools.length === 0 && !msg.thinking && isCommandPlumbing(msg.text)) {
        continue
      }
      messages.push(msg)
    }
  } finally {
    rl.close()
  }

  const contextTokens = lastContextTokens > 0 ? lastContextTokens : null
  const total = messages.length
  // Only trips at the OOM safety ceiling (SAFETY_CAP), never in normal use — the UI
  // is virtualized, so the full transcript renders fine. `capped` stays for shape.
  if (total > cap) {
    return { messages: messages.slice(total - cap), total, capped: true, contextTokens }
  }
  return { messages, total, capped: false, contextTokens }
}
