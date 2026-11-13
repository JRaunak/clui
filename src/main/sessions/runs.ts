/** A workflow run's record, read from `<session>/workflows/<runId>.json` for a tab that outlived the live stream. */
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { workflowProgressOf } from '../../shared/events'
import type { WorkflowRun } from '../../shared/ipc'
import { findTranscriptFile, projectsRoot, truncateResult } from './transcript'
import { isSafeComponent } from './store'

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/
const RECORD_MAX = 8 * 1024 * 1024

/**
 * The record the Workflow tool's launch result points at. Its `transcriptDir` names the session that owns the run,
 * which for a fork is the source session, not this one.
 */
async function recordFromLaunch(main: string, taskId: string): Promise<string | null> {
  const needle = `"taskId":"${taskId}"`
  const lines = createInterface({ input: createReadStream(main, { encoding: 'utf8' }), crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.includes(needle) || !line.includes('"transcriptDir"')) continue
      let r: { taskId?: unknown; runId?: unknown; transcriptDir?: unknown } | undefined
      try {
        r = (JSON.parse(line) as { toolUseResult?: typeof r }).toolUseResult
      } catch {
        continue
      }
      if (r?.taskId !== taskId || typeof r.runId !== 'string' || !TASK_ID.test(r.runId) || typeof r.transcriptDir !== 'string') continue
      const dir = resolve(r.transcriptDir)
      if (basename(dir) !== r.runId || basename(dirname(dir)) !== 'workflows' || basename(dirname(dirname(dir))) !== 'subagents') continue
      const file = join(dirname(dirname(dirname(dir))), 'workflows', `${r.runId}.json`)
      if (file.startsWith(resolve(projectsRoot()) + sep)) return file
    }
  } finally {
    lines.close()
  }
  return null
}

async function readRecord(file: string): Promise<Record<string, unknown> | null> {
  if ((await stat(file)).size > RECORD_MAX) return null
  const raw = JSON.parse(await readFile(file, 'utf8')) as unknown
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
}

/** This session's own records, matched by task id: one file per run, so the scan stays small. */
async function recordInDir(dir: string, taskId: string): Promise<Record<string, unknown> | null> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return null
  }
  for (const n of names) {
    if (!n.startsWith('wf_') || !n.endsWith('.json')) continue
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

/** Null when no record is on disk for the run; a record that exists but can't be read rejects. */
export async function readWorkflowRun(sessionId: string, taskId: string): Promise<WorkflowRun | null> {
  if (!isSafeComponent(sessionId) || !TASK_ID.test(taskId)) return null
  const main = await findTranscriptFile(sessionId)
  if (!main) return null
  const launched = await recordFromLaunch(main, taskId)
  let rec = launched ? await readRecord(launched).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : Promise.reject(e))) : null
  if (rec && rec.taskId !== taskId) rec = null
  rec ??= await recordInDir(join(dirname(main), sessionId, 'workflows'), taskId)
  if (!rec) return null
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
    result: resultOf(rec.result),
    phases,
    agents
  }
}
