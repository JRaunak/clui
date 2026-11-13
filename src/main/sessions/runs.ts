/** A session's subagent and workflow runs, read back from its files: one workflow's record for its tab, or every run
 *  for the list tabs. */
import { createReadStream, type Stats } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { workflowProgressOf } from '../../shared/events'
import type { AgentRun, SessionRuns, WorkflowRun } from '../../shared/ipc'
import { findTranscriptFile, projectsRoot, truncateResult } from './transcript'
import { isSafeComponent } from './store'

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/
const TOOL_ID = /^[A-Za-z0-9_-]{1,128}$/
const META_FILE = /^agent-([A-Za-z0-9_-]{1,64})\.meta\.json$/
const RECORD_FILE = /^wf_[A-Za-z0-9_-]{1,64}\.json$/
const RECORD_MAX = 8 * 1024 * 1024
const META_MAX = 64 * 1024
/** Per directory, so a pathological session can't turn one list open into thousands of reads. */
const FILES_MAX = 500
/** transcript.ts walks `subagents/` to the same depth. */
const NEST_MAX = 3

type Rec = Record<string, unknown>

/** The record a Workflow tool's launch result points at. Its `transcriptDir` names the session that owns the run,
 *  which for a fork is the source session, not this one. */
function launchRecord(r: unknown): { taskId: string; file: string } | null {
  if (!r || typeof r !== 'object') return null
  const { taskId, runId, transcriptDir } = r as Rec
  if (typeof taskId !== 'string' || typeof runId !== 'string' || !TASK_ID.test(runId) || typeof transcriptDir !== 'string') return null
  const dir = resolve(transcriptDir)
  if (basename(dir) !== runId || basename(dirname(dir)) !== 'workflows' || basename(dirname(dirname(dir))) !== 'subagents') return null
  const file = join(dirname(dirname(dirname(dir))), 'workflows', `${runId}.json`)
  return file.startsWith(resolve(projectsRoot()) + sep) ? { taskId, file } : null
}

async function recordFromLaunch(main: string, taskId: string): Promise<string | null> {
  const needle = `"taskId":"${taskId}"`
  const lines = createInterface({ input: createReadStream(main, { encoding: 'utf8' }), crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.includes(needle) || !line.includes('"transcriptDir"')) continue
      let r: unknown
      try {
        r = (JSON.parse(line) as { toolUseResult?: unknown }).toolUseResult
      } catch {
        continue
      }
      const hit = launchRecord(r)
      if (hit?.taskId === taskId) return hit.file
    }
  } finally {
    lines.close()
  }
  return null
}

async function readRecord(file: string): Promise<Rec | null> {
  if ((await stat(file)).size > RECORD_MAX) return null
  const raw = JSON.parse(await readFile(file, 'utf8')) as unknown
  return raw && typeof raw === 'object' ? (raw as Rec) : null
}

async function names(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).slice(0, FILES_MAX)
  } catch {
    return []
  }
}

/** This session's own records, matched by task id: one file per run, so the scan stays small. */
async function recordInDir(dir: string, taskId: string): Promise<Rec | null> {
  for (const n of await names(dir)) {
    if (!RECORD_FILE.test(n)) continue
    const rec = await readRecord(join(dir, n)).catch(() => null)
    if (rec?.taskId === taskId) return rec
  }
  return null
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** A structured result reads as a JSON block, so the Result section renders it as code rather than one long line. */
function resultOf(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  return truncateResult(typeof v === 'string' ? v : `\`\`\`json\n${JSON.stringify(v, null, 2)}\n\`\`\``)
}

function runOf(taskId: string, rec: Rec, withResult: boolean): WorkflowRun {
  const { phases, agents } = workflowProgressOf(Array.isArray(rec.workflowProgress) ? rec.workflowProgress : [])
  return {
    taskId,
    runId: str(rec.runId) ?? '',
    name: str(rec.workflowName) ?? 'workflow',
    status: str(rec.status) ?? 'completed',
    startTime: num(rec.startTime),
    durationMs: num(rec.durationMs),
    totalTokens: num(rec.totalTokens),
    summary: str(rec.summary),
    result: withResult ? resultOf(rec.result) : undefined,
    phases,
    agents
  }
}

/** Null when no record is on disk for the run; a record that exists but can't be read rejects. */
export async function readWorkflowRun(sessionId: string, taskId: string): Promise<WorkflowRun | null> {
  if (!isSafeComponent(sessionId) || !TASK_ID.test(taskId)) return null
  const main = await findTranscriptFile(sessionId)
  if (!main) return null
  const launched = await recordFromLaunch(main, taskId)
  let rec = launched ? await readRecord(launched).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : Promise.reject(e))) : null
  if (rec && rec.taskId !== taskId) rec = null
  rec ??= await recordInDir(join(dirname(main), sessionId, 'workflows'), taskId)
  return rec ? runOf(taskId, rec, true) : null
}

interface Launch {
  id: string
  description: string
  subagentType?: string
  background: boolean
  startedAt?: number
}
interface Scan {
  launches: Launch[]
  /** Agent tool results, by tool_use id. */
  results: Map<string, { isError: boolean; rejected: boolean; r: Rec | null }>
  /** The last completion notice per tool_use id: a resumed background agent can notify more than once. */
  notes: Map<string, { status: string; tokens?: number; durationMs?: number }>
  workflows: { taskId: string; file: string }[]
}

const tag = (s: string, name: string): string | undefined => new RegExp(`<${name}>([^<]*)</${name}>`).exec(s)?.[1]?.trim() || undefined
const numTag = (s: string, name: string): number | undefined => num(Number(tag(s, name) ?? NaN))
const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => (b && typeof b === 'object' && typeof (b as Rec).text === 'string' ? (b as Rec).text : '')).join('') : ''

function scanRecord(scan: Scan, rec: Rec, main: boolean): void {
  if (main && rec.isSidechain === true) return
  const msg = rec.message as Rec | undefined
  const content = msg?.content
  if (rec.type === 'assistant' && Array.isArray(content)) {
    const at = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN
    for (const b of content as Rec[]) {
      if (b?.type !== 'tool_use' || (b.name !== 'Agent' && b.name !== 'Task') || typeof b.id !== 'string' || !TOOL_ID.test(b.id)) continue
      const input = (b.input ?? {}) as Rec
      scan.launches.push({
        id: b.id,
        description: str(input.description) ?? '',
        subagentType: str(input.subagent_type),
        background: input.run_in_background === true,
        ...(Number.isFinite(at) ? { startedAt: at } : {})
      })
    }
    return
  }
  if (rec.type !== 'user') return
  // A completion notice is a plain-text user record; a tool result quoting one is a block, and isn't one.
  if (typeof content === 'string') {
    for (const n of content.split('<task-notification>').slice(1)) {
      const id = tag(n, 'tool-use-id')
      const status = tag(n, 'status')
      if (id && status) scan.notes.set(id, { status, tokens: numTag(n, 'subagent_tokens'), durationMs: numTag(n, 'duration_ms') })
    }
    return
  }
  if (!Array.isArray(content)) return
  const r = rec.toolUseResult && typeof rec.toolUseResult === 'object' ? (rec.toolUseResult as Rec) : null
  if (main && r?.taskType === 'local_workflow') {
    const hit = launchRecord(r)
    if (hit) scan.workflows.push(hit)
  }
  for (const b of content as Rec[]) {
    if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string' || !scan.launches.some((l) => l.id === b.tool_use_id)) continue
    const said = textOf(b.content)
    scan.results.set(b.tool_use_id, { isError: b.is_error === true, rejected: said === 'User rejected tool use' || said.startsWith("The user doesn't want to proceed"), r })
  }
}

const emptyScan = (): Scan => ({ launches: [], results: new Map(), notes: new Map(), workflows: [] })

/** Scans by path, kept while the file's size and mtime hold, so reopening a list re-reads only what grew. */
const scans = new Map<string, { size: number; mtimeMs: number; scan: Scan }>()

async function scanFile(file: string, main: boolean): Promise<Scan> {
  let st: Stats
  try {
    st = await stat(file)
  } catch {
    return emptyScan()
  }
  const hit = scans.get(file)
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.scan
  const scan = emptyScan()
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"') && !line.includes('<task-notification>')) continue
    let rec: unknown
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (rec && typeof rec === 'object') scanRecord(scan, rec as Rec, main)
  }
  // ponytail: whole-file cache per path, capped by count; cache by byte offset if long sessions make rescans slow
  if (scans.size >= 64) scans.delete(scans.keys().next().value!)
  scans.set(file, { size: st.size, mtimeMs: st.mtimeMs, scan })
  return scan
}

interface Meta {
  agentId: string
  description: string
  agentType?: string
  background: boolean
  finished: boolean
  stoppedByUser: boolean
}

/** The sidecars in `subagents/`, by tool_use id. Workflow agents' sit under `subagents/workflows/`, so they never
 *  show. */
async function readMetas(dir: string): Promise<Map<string, Meta>> {
  const out = new Map<string, Meta>()
  for (const n of await names(dir)) {
    const agentId = META_FILE.exec(n)?.[1]
    if (!agentId) continue
    try {
      const file = join(dir, n)
      if ((await stat(file)).size > META_MAX) continue
      const m = JSON.parse(await readFile(file, 'utf8')) as Rec
      if (typeof m.toolUseId !== 'string' || !TOOL_ID.test(m.toolUseId)) continue
      out.set(m.toolUseId, { agentId, description: str(m.description) ?? '', agentType: str(m.agentType), background: m.requestShape === 'background', finished: m.finished === true, stoppedByUser: m.stoppedByUser === true })
    } catch {
      // A sidecar mid-write or unreadable: the launch in its parent's transcript still lists the agent.
    }
  }
  return out
}

const NOTED: Record<string, AgentRun['outcome']> = { completed: 'done', failed: 'failed', killed: 'stopped', stopped: 'stopped' }

function runOfLaunch(l: Launch, scan: Scan, meta: Meta | undefined, parent: string | undefined): AgentRun {
  const res = scan.results.get(l.id)
  const r = res?.r
  const note = scan.notes.get(l.id)
  const background = l.background || r?.isAsync === true || !!meta?.background
  const base = { toolUseId: l.id, agentId: str(r?.agentId) ?? meta?.agentId, ...(parent ? { parent } : {}), description: l.description || meta?.description || '', subagentType: l.subagentType ?? meta?.agentType, background, startedAt: l.startedAt }
  if (note) return { ...base, outcome: NOTED[note.status] ?? 'done', durationMs: note.durationMs, tokens: note.tokens }
  if (res && r?.isAsync !== true) return { ...base, outcome: res.rejected ? 'stopped' : res.isError ? 'failed' : 'done', durationMs: num(r?.totalDurationMs), tokens: num(r?.totalTokens) }
  return { ...base, outcome: meta?.finished ? (meta.stoppedByUser ? 'stopped' : 'done') : 'open' }
}

/**
 * Every Agent-tool subagent and workflow this session's files record, oldest first. The sidecars in `subagents/` say
 * which agents ran; the main transcript says how main's own launches went; a nested agent's launch and outcome live
 * in its parent's transcript, which is read only when a sidecar names an agent main didn't launch.
 */
export async function listRuns(sessionId: string): Promise<SessionRuns> {
  if (!isSafeComponent(sessionId)) return { agents: [], workflows: [] }
  const main = await findTranscriptFile(sessionId)
  if (!main) return { agents: [], workflows: [] }
  const dir = join(dirname(main), sessionId)
  const subagents = join(dir, 'subagents')
  const [scan, metas, own] = await Promise.all([scanFile(main, true), readMetas(subagents), names(join(dir, 'workflows'))])

  const rows = new Map<string, AgentRun>()
  const add = (s: Scan, parent?: string): AgentRun[] =>
    s.launches.flatMap((l) => {
      if (rows.has(l.id)) return []
      const row = runOfLaunch(l, s, metas.get(l.id), parent)
      rows.set(l.id, row)
      return [row]
    })
  let level = add(scan)
  for (let depth = 1; depth <= NEST_MAX && [...metas.keys()].some((id) => !rows.has(id)); depth++) {
    const next: AgentRun[] = []
    for (const p of level) if (p.agentId) next.push(...add(await scanFile(join(subagents, `agent-${p.agentId}.jsonl`), false), p.toolUseId))
    level = next
  }
  // Agents a sidecar names but no transcript launched: their parent's transcript is gone, so they show at the top
  // level as the oldest.
  const orphans: AgentRun[] = []
  for (const [id, m] of metas) {
    if (rows.has(id)) continue
    orphans.push({ toolUseId: id, agentId: m.agentId, description: m.description, subagentType: m.agentType, background: m.background, outcome: m.finished ? (m.stoppedByUser ? 'stopped' : 'done') : 'open' })
  }

  const files = new Map<string, string | null>(scan.workflows.map((w) => [w.file, w.taskId]))
  for (const n of own) {
    const file = join(dir, 'workflows', n)
    if (RECORD_FILE.test(n) && !files.has(file)) files.set(file, null)
  }
  const workflows = new Map<string, WorkflowRun>()
  for (const [file, launched] of files) {
    const rec = await readRecord(file).catch(() => null)
    const taskId = rec?.taskId
    if (!rec || typeof taskId !== 'string' || !TASK_ID.test(taskId) || (launched && launched !== taskId) || workflows.has(taskId)) continue
    workflows.set(taskId, runOf(taskId, rec, false))
  }
  return { agents: [...orphans, ...rows.values()], workflows: [...workflows.values()].sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0)) }
}
