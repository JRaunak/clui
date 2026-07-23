/**
 * Persisted app settings, stored at `<userData>/settings.json`.
 * Read-through cache with defaults applied; writes merge over current values.
 */
import { app } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type CluiSettings } from '../../shared/settings'

let cache: CluiSettings | null = null

const settingsPath = (): string => join(app.getPath('userData'), 'settings.json')

export async function getSettings(): Promise<CluiSettings> {
  if (cache) return cache
  try {
    const raw = await readFile(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<CluiSettings>
    cache = { ...DEFAULT_SETTINGS, ...parsed }
  } catch {
    cache = { ...DEFAULT_SETTINGS }
  }
  return cache
}

/**
 * Synchronous read of the in-memory cache (or defaults if not yet loaded). Used
 * by the sync theme IPC that runs during preload, before any async load can
 * resolve. Call `getSettings()` once at startup (before window creation) to warm
 * the cache so this returns the persisted values rather than defaults.
 */
export function getSettingsSync(): CluiSettings {
  return cache ?? { ...DEFAULT_SETTINGS }
}

export async function updateSettings(patch: Partial<CluiSettings>): Promise<CluiSettings> {
  const current = await getSettings()
  const next: CluiSettings = { ...current, ...patch }
  cache = next
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(settingsPath(), JSON.stringify(next, null, 2), 'utf8')
  return next
}
