/**
 * Read a live session's task list (Task tool family) from disk. The CLI writes one
 * JSON file per task at `~/.claude/tasks/<sessionId>/N.json` while the session is
 * LIVE, and clears the dir when it goes dormant, so this is a live-session-only
 * signal. Defensive, display-only parsing (mirrors transcript.ts): a missing dir or
 * a malformed file yields an empty/partial list, never a throw.
 */
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SessionTask } from '../../shared/events'

const tasksRoot = (): string => join(homedir(), '.claude', 'tasks')

/** A raw task file (only the fields the checklist reads). */
interface RawTask {
  id?: unknown
  subject?: unknown
  status?: unknown
  activeForm?: unknown
  blockedBy?: unknown
}

const VALID_STATUS = new Set(['created', 'pending', 'in_progress', 'completed'])

/** Numeric sort key from a task filename (`12.json` → 12), or +Inf if it doesn't
 *  parse (sorts unknown names last rather than throwing off the order). */
function fileOrder(name: string): number {
  const n = Number.parseInt(name, 10)
  return Number.isNaN(n) ? Infinity : n
}

/**
 * Read + normalize the task list for `sessionId`, sorted by numeric filename (the
 * CLI's creation order). Returns `[]` for a missing dir or unreadable files.
 */
export async function readTasks(sessionId: string): Promise<SessionTask[]> {
  if (!sessionId) return []
  const dir = join(tasksRoot(), sessionId)
  let names: string[]
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json'))
  } catch {
    return [] // dir absent (dormant session) or unreadable
  }
  names.sort((a, b) => fileOrder(a) - fileOrder(b))

  const tasks: SessionTask[] = []
  for (const name of names) {
    let raw: RawTask
    try {
      raw = JSON.parse(await readFile(join(dir, name), 'utf8'))
    } catch {
      continue // partial write / malformed; skip this one, keep the rest
    }
    if (typeof raw.id !== 'string' || typeof raw.subject !== 'string') continue
    if (typeof raw.status !== 'string' || !VALID_STATUS.has(raw.status)) continue
    tasks.push({
      id: raw.id,
      subject: raw.subject,
      status: raw.status as SessionTask['status'],
      activeForm: typeof raw.activeForm === 'string' ? raw.activeForm : undefined,
      blockedBy: Array.isArray(raw.blockedBy)
        ? raw.blockedBy.filter((x): x is string => typeof x === 'string')
        : undefined
    })
  }
  return tasks
}
