/**
 * Session history reader/manager.
 *
 * Sessions live at `~/.claude/projects/<slug>/<session-id>.jsonl`. The `.jsonl`
 * format is internal and version-dependent, so we parse it defensively: we only
 * read a handful of fields, tolerate unknown record shapes, and never write to it.
 *
 * Renames are stored in an app-owned sidecar map (`<userData>/session-names.json`)
 * rather than mutating the CLI's files, so they survive resume and CLI upgrades.
 */
import { app } from 'electron'
import { createReadStream, existsSync } from 'node:fs'
import { readdir, stat, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { ProjectGroup, SessionSummary } from '../../shared/sessions'

const projectsRoot = (): string => join(homedir(), '.claude', 'projects')

const sidecarPath = (): string => join(app.getPath('userData'), 'session-names.json')

/** Fields we defensively extract while scanning a session's jsonl. */
interface ScanResult {
  cwd: string | null
  customTitle: string | null
  aiTitle: string | null
  firstUserMessage: string | null
  lastPrompt: string | null
  firstTimestamp: string | null
  lastTimestamp: string | null
  messageCount: number
}

/** Read the sidecar rename map (id → display name). Missing/corrupt → empty. */
async function readSidecar(): Promise<Record<string, string>> {
  try {
    const raw = await readFile(sidecarPath(), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

async function writeSidecar(map: Record<string, string>): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(sidecarPath(), JSON.stringify(map, null, 2), 'utf8')
}

// Serialize rename-sidecar read-modify-writes so a rename and a delete (or two renames)
// firing in the same tick can't read the same base map and clobber each other's key.
let sidecarChain: Promise<void> = Promise.resolve()
function serializeSidecar(mutate: () => Promise<void>): Promise<void> {
  const next = sidecarChain.then(mutate, mutate)
  sidecarChain = next.catch(() => {})
  return next
}

/**
 * Stream a session's jsonl and pull out summary fields without loading it all
 * into memory (some sessions are multi-MB). Only the first few fields of each
 * line are inspected; we stop scanning message content once we have a title.
 */
async function scanSession(filePath: string): Promise<ScanResult> {
  const res: ScanResult = {
    cwd: null,
    customTitle: null,
    aiTitle: null,
    firstUserMessage: null,
    lastPrompt: null,
    firstTimestamp: null,
    lastTimestamp: null,
    messageCount: 0
  }

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })

  try {
    for await (const line of rl) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let o: Record<string, unknown>
      try {
        o = JSON.parse(trimmed)
      } catch {
        continue
      }

      const type = o.type as string | undefined
      if (typeof o.cwd === 'string' && !res.cwd) res.cwd = o.cwd
      if (typeof o.customTitle === 'string') res.customTitle = o.customTitle
      if (typeof o.aiTitle === 'string') res.aiTitle = o.aiTitle
      if (typeof o.lastPrompt === 'string') res.lastPrompt = o.lastPrompt

      const ts = typeof o.timestamp === 'string' ? o.timestamp : null
      if (ts) {
        if (!res.firstTimestamp) res.firstTimestamp = ts
        res.lastTimestamp = ts
      }

      if (type === 'user' || type === 'assistant') {
        res.messageCount++
        if (type === 'user' && !res.firstUserMessage) {
          const t = extractText((o.message as Record<string, unknown>)?.content)
          // Skip CLI slash-command plumbing (<command-name>…, <local-command-caveat>…)
          // so a session whose first turn was a `/command` doesn't title itself with
          // raw XML; fall through to the next real user message.
          if (t && !isCommandPlumbing(t)) res.firstUserMessage = t
        }
      }
    }
  } finally {
    rl.close()
  }

  return res
}

/** CLI slash-command plumbing a user never typed as prose: the wrapper tags the
 *  CLI injects around a `/command`: <command-message>, <command-name>,
 *  <command-args>, <local-command-caveat>, <local-command-stdout>. */
function isCommandPlumbing(text: string): boolean {
  return /^\s*<(command-(message|name|args)|local-command-(caveat|stdout)|task-notification)>/.test(
    text
  )
}

/** Pull plain text out of a message `content` (string or array of blocks). Prefers a
 *  real prose text block over a dropped-file wrapper (`<file name="…">…</file>`), so a
 *  turn that attached a text file titles from what the user TYPED, not the file dump.
 *  If the only text is a file wrapper, returns null (fall through to the next message). */
function extractText(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() || null
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
        const t = (block as { text?: unknown }).text
        if (typeof t === 'string' && t.trim() && !/^\s*<file name=/.test(t)) return t.trim()
      }
    }
  }
  return null
}

function titleFrom(scan: ScanResult, sidecarName: string | undefined, id: string): string {
  const raw =
    sidecarName ??
    scan.customTitle ??
    scan.aiTitle ??
    scan.firstUserMessage ??
    scan.lastPrompt ??
    id
  return truncate(raw.replace(/\s+/g, ' ').trim(), 80)
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

/** List every session across all projects, grouped by workspace, newest first. */
export async function listSessions(): Promise<ProjectGroup[]> {
  const root = projectsRoot()
  const sidecar = await readSidecar()

  let slugs: string[]
  try {
    const entries = await readdir(root, { withFileTypes: true })
    slugs = entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name)
  } catch {
    return []
  }

  const summaries: SessionSummary[] = []
  for (const slug of slugs) {
    const dir = join(root, slug)
    let files: string[]
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const file of files) {
      const filePath = join(dir, file)
      const id = file.slice(0, -'.jsonl'.length)
      let st: Awaited<ReturnType<typeof stat>>
      try {
        st = await stat(filePath)
      } catch {
        continue
      }
      if (st.size === 0) continue
      const scan = await scanSession(filePath)
      summaries.push({
        id,
        title: titleFrom(scan, sidecar[id], id),
        renamed: Boolean(sidecar[id]),
        cwd: scan.cwd ?? slugToPathGuess(slug),
        projectSlug: slug,
        firstTimestamp: scan.firstTimestamp,
        lastTimestamp: scan.lastTimestamp,
        mtimeMs: st.mtimeMs,
        // Creation time: prefer file birthtime; fall back to first event ts, then mtime.
        createdMs:
          st.birthtimeMs && st.birthtimeMs > 0
            ? st.birthtimeMs
            : scan.firstTimestamp
              ? Date.parse(scan.firstTimestamp) || st.mtimeMs
              : st.mtimeMs,
        messageCount: scan.messageCount
      })
    }
  }

  return groupByProject(summaries)
}

function groupByProject(summaries: SessionSummary[]): ProjectGroup[] {
  const byCwd = new Map<string, SessionSummary[]>()
  for (const s of summaries) {
    const arr = byCwd.get(s.cwd) ?? []
    arr.push(s)
    byCwd.set(s.cwd, arr)
  }
  const groups: ProjectGroup[] = []
  for (const [cwd, sessions] of byCwd) {
    // Order by creation time (newest first). Immutable → stable across resume/delete.
    sessions.sort((a, b) => b.createdMs - a.createdMs)
    groups.push({ cwd, label: basename(cwd) || cwd, exists: existsSync(cwd), sessions })
  }
  // Groups ordered by their most-recently-created session.
  groups.sort((a, b) => (b.sessions[0]?.createdMs ?? 0) - (a.sessions[0]?.createdMs ?? 0))
  return groups
}

/**
 * Best-effort reverse of a project slug → path (only used if the jsonl had no
 * cwd, which is rare). Lossy: both `/` and `.` became `-`, so we can't perfectly
 * reconstruct; return a leading-slash guess for display.
 */
function slugToPathGuess(slug: string): string {
  return slug.startsWith('-') ? '/' + slug.slice(1).replace(/-/g, '/') : slug
}

/** Delete a session: its `.jsonl` plus any sibling per-session directory. */
export async function deleteSession(projectSlug: string, id: string): Promise<void> {
  const dir = join(projectsRoot(), projectSlug)
  await rm(join(dir, `${id}.jsonl`), { force: true })
  // The CLI also creates a sibling dir named <id> for subagent transcripts, etc.
  await rm(join(dir, id), { recursive: true, force: true })
  // Drop any sidecar rename.
  await serializeSidecar(async () => {
    const map = await readSidecar()
    if (map[id]) {
      delete map[id]
      await writeSidecar(map)
    }
  })
}

/** Rename a session via the sidecar map (empty/whitespace name clears it). */
export async function renameSession(id: string, name: string): Promise<void> {
  await serializeSidecar(async () => {
    const map = await readSidecar()
    const trimmed = name.trim()
    if (trimmed) map[id] = trimmed
    else delete map[id]
    await writeSidecar(map)
  })
}
