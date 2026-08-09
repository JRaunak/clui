/**
 * Per-session cost sidecar (`<userData>/session-costs.json`).
 *
 * The CLI's `total_cost_usd` is per-invocation (it resets across a `--resume`) and
 * is NOT written to the jsonl, so Clui accumulates a running total itself. This
 * sidecar persists that total across app relaunches, the same pattern as the rename
 * sidecar (`session-names.json`); app-owned, never touches ~/.claude.
 *
 * Map shape: { "<cli-session-id>": <cumulative-usd> }.
 */
import { app } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const costsPath = (): string => join(app.getPath('userData'), 'session-costs.json')

/** Read the cost map (sessionId → USD). Missing/corrupt → empty. */
export async function readCosts(): Promise<Record<string, number>> {
  try {
    const raw = await readFile(costsPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    // Keep only finite numbers (defensive against manual edits / corruption).
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

async function writeCosts(map: Record<string, number>): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(costsPath(), JSON.stringify(map, null, 2), 'utf8')
}

// Serialize read-modify-write mutations. Background sessions can finish turns in the same
// tick; the read/write awaits are yield points, so two concurrent upserts would both read
// the same base map and the later write would clobber the earlier session's key. Chaining
// every mutation preserves last-writer-per-KEY instead of last-writer-wins on the file.
let writeChain: Promise<void> = Promise.resolve()
function serialize(mutate: () => Promise<void>): Promise<void> {
  const next = writeChain.then(mutate, mutate)
  writeChain = next.catch(() => {})
  return next
}

/** Upsert one session's cumulative cost. */
export async function setCost(sessionId: string, usd: number): Promise<void> {
  if (!sessionId || !Number.isFinite(usd)) return
  return serialize(async () => {
    const map = await readCosts()
    map[sessionId] = usd
    await writeCosts(map)
  })
}

/** Remove one session's cost (on permanent delete). */
export async function deleteCost(sessionId: string): Promise<void> {
  return serialize(async () => {
    const map = await readCosts()
    if (sessionId in map) {
      delete map[sessionId]
      await writeCosts(map)
    }
  })
}
