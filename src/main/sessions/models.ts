/**
 * Per-session model+effort sidecar (`<userData>/session-models.json`).
 *
 * WHY: the CLI reads model/effort from ~/.claude/settings.json on `--resume` — a
 * mid-session `set_model`/effort change does NOT persist (verified: switch to
 * sonnet-5, resume → the CLI reports the settings default again). So a user's
 * mid-session switch would be silently lost on resume. Clui remembers each
 * session's last-used model+effort here and passes them as `--model`/`--effort`
 * on resume (both ARE honored on a resume spawn), so the switch survives.
 *
 * Same pattern as the cost/name sidecars: app-owned, never touches ~/.claude.
 * Map shape: { "<cli-session-id>": { model?: string, effort?: string } }.
 */
import { app } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface SessionModelPrefs {
  model?: string
  effort?: string
  ultracode?: boolean
}

const modelsPath = (): string => join(app.getPath('userData'), 'session-models.json')

/** Read the map (sessionId → {model,effort}). Missing/corrupt → empty. */
export async function readSessionModels(): Promise<Record<string, SessionModelPrefs>> {
  try {
    const raw = await readFile(modelsPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, SessionModelPrefs> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v && typeof v === 'object') {
        const rec = v as Record<string, unknown>
        const prefs: SessionModelPrefs = {}
        if (typeof rec.model === 'string') prefs.model = rec.model
        if (typeof rec.effort === 'string') prefs.effort = rec.effort
        if (typeof rec.ultracode === 'boolean') prefs.ultracode = rec.ultracode
        if (prefs.model || prefs.effort || prefs.ultracode !== undefined) out[k] = prefs
      }
    }
    return out
  } catch {
    return {}
  }
}

async function writeSessionModels(map: Record<string, SessionModelPrefs>): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(modelsPath(), JSON.stringify(map, null, 2), 'utf8')
}

// Serialize read-modify-write mutations so two concurrent switches (background sessions
// finishing turns in the same tick) can't read the same base map and clobber each other's
// key on write — preserves last-writer-per-KEY. Same guard as the cost sidecar.
let writeChain: Promise<void> = Promise.resolve()
function serialize(mutate: () => Promise<void>): Promise<void> {
  const next = writeChain.then(mutate, mutate)
  writeChain = next.catch(() => {})
  return next
}

/** Merge one session's model/effort (only the provided fields are updated). */
export async function setSessionModel(sessionId: string, prefs: SessionModelPrefs): Promise<void> {
  if (!sessionId) return
  return serialize(async () => {
    const map = await readSessionModels()
    const cur = map[sessionId] ?? {}
    map[sessionId] = {
      model: prefs.model ?? cur.model,
      effort: prefs.effort ?? cur.effort,
      ultracode: prefs.ultracode ?? cur.ultracode
    }
    await writeSessionModels(map)
  })
}

/** Remove one session's prefs (on permanent delete). */
export async function deleteSessionModel(sessionId: string): Promise<void> {
  return serialize(async () => {
    const map = await readSessionModels()
    if (sessionId in map) {
      delete map[sessionId]
      await writeSessionModels(map)
    }
  })
}
