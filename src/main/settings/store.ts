/**
 * Persisted app settings, stored at `<userData>/settings.json`.
 *
 * The file holds ONLY explicit overrides. A key that is absent means "inherit":
 * resolve it from the user's ~/.claude/settings.json when that file speaks to it
 * (model, effort), else from DEFAULT_SETTINGS. Same philosophy as the existing
 * `permissionMode: 'inherit'` sentinel, applied to every field.
 *
 * This matters because the previous write path persisted the whole merged object,
 * so the first Save froze all eight keys as concrete values, including a model the
 * user never picked, which then silently overrode what their CLI config said. With
 * overrides-only, "the user chose dark" and "dark is the default" are distinguishable,
 * which is what a per-field reset needs.
 */
import { app } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_SETTINGS,
  clampEffort,
  isEffortChoice,
  type CluiSettings,
  type ResolvedSettings,
  type SettingsKey
} from '../../shared/settings'
import { readCliSettings, type CliSettings } from './cli-settings'

/** Persisted shape: a partial, keys present only where the user overrode a default. */
type StoredSettings = Partial<CluiSettings>

/** Last-resolved snapshot. Written on every load/update so the sync read is honest. */
let cache: ResolvedSettings | null = null
/** The raw persisted partial, kept so a write never re-materializes resolved values. */
let stored: StoredSettings | null = null

const settingsPath = (): string => join(app.getPath('userData'), 'settings.json')

/**
 * Resolve model + effort from what the user already told the CLI.
 *
 * Two traps here, both load-bearing:
 *  - The CLI's stored id ('us.anthropic.claude-opus-5[1m]') is taken VERBATIM. The picker
 *    lists Bedrock's ids unshortened, so shortening here would match nothing — and the
 *    shortened form isn't a valid `--model` value anyway.
 *  - Effort is gated per model, and the CLI's own enum has no 'max', so an inherited
 *    effort still gets clamped against the RESOLVED model, otherwise Clui could pass
 *    an `--effort` that model rejects.
 */
function resolveInherited(storedPartial: StoredSettings, cli: CliSettings): ResolvedSettings {
  const values = { ...DEFAULT_SETTINGS, ...storedPartial }
  const sources = {} as ResolvedSettings['sources']
  for (const key of Object.keys(DEFAULT_SETTINGS) as SettingsKey[]) {
    sources[key] = key in storedPartial ? 'override' : 'default'
  }

  if (sources.model === 'default') {
    if (cli.model) {
      values.model = cli.model
      sources.model = 'cli'
    }
  }
  if (sources.effort === 'default' && isEffortChoice(cli.effortLevel)) {
    values.effort = cli.effortLevel
    sources.effort = 'cli'
  }
  // Clamp whenever EITHER side was inherited: an inherited effort can exceed an
  // overridden model's ceiling just as easily as the reverse.
  values.effort = clampEffort(values.model, values.effort)

  return { values, sources }
}

/**
 * Old hardcoded defaults, frozen at the commit that introduced overrides-only
 * persistence. A file written by the previous code holds all eight keys; any key
 * still equal to its old default was never a choice, it was carried along by the
 * whole-object write, so it is dropped and starts inheriting. Keys that differ are
 * genuine picks and survive untouched.
 *
 * This is a snapshot on purpose: comparing against the LIVE DEFAULT_SETTINGS would
 * silently re-run as a different migration every time a default changes.
 */
const LEGACY_DEFAULTS: CluiSettings = {
  cliPath: '',
  editorCommand: 'code',
  permissionMode: 'inherit',
  model: 'claude-opus-4-8[1m]',
  effort: 'high',
  defaultWorkspace: '',
  theme: 'dark',
  onboarded: false
}

/**
 * Drop keys that merely echo a legacy default. Idempotent: a file already pruned has
 * nothing left matching, so re-running is a no-op and `changed` comes back false;
 * which is also what keeps a steady-state launch from writing.
 *
 * Input is already schema-filtered by `parseStored`, so every key here is known.
 *
 * `onboarded: true` is deliberately NOT dropped despite being a boolean flag: its
 * legacy default is `false`, so a stored `true` differs and survives. Dropping it
 * would replay onboarding for an existing user.
 */
export function pruneLegacyDefaults(input: StoredSettings): {
  pruned: StoredSettings
  changed: boolean
} {
  const pruned: StoredSettings = {}
  let changed = false
  for (const key of Object.keys(LEGACY_DEFAULTS) as SettingsKey[]) {
    if (!(key in input)) continue
    if (input[key] === LEGACY_DEFAULTS[key]) {
      changed = true
      continue
    }
    Object.assign(pruned, { [key]: input[key] })
  }
  return { pruned, changed }
}

/**
 * Read + validate the persisted partial. Clui is the file's only writer, so anything
 * off-schema is either hand-edited or left by another version; it is dropped rather
 * than carried, and a mistyped value must never reach a typed field.
 */
function parseStored(raw: string): StoredSettings {
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: StoredSettings = {}
  for (const key of Object.keys(DEFAULT_SETTINGS) as SettingsKey[]) {
    const v = (parsed as Record<string, unknown>)[key]
    if (v === undefined || typeof v !== typeof DEFAULT_SETTINGS[key]) continue
    Object.assign(out, { [key]: v })
  }
  return out
}

async function persist(next: StoredSettings): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(settingsPath(), JSON.stringify(next, null, 2), 'utf8')
}

/**
 * Load, migrate once, and resolve. The migration writes back only when it actually
 * pruned something, so a steady-state launch performs no write.
 */
async function load(): Promise<ResolvedSettings> {
  let partial: StoredSettings = {}
  try {
    partial = parseStored(await readFile(settingsPath(), 'utf8'))
  } catch {
    // No file yet (or unreadable): everything inherits. Do NOT write one here, since an
    // empty override file is the same as no file, and writing on read is a surprise.
    partial = {}
  }
  const { pruned, changed } = pruneLegacyDefaults(partial)
  if (changed) {
    // Adopt the pruned set in memory even if the write fails: a failed migration must
    // not leave `partial` empty, or the next successful write would persist that empty
    // set and erase the real overrides still sitting on disk. Retried next launch.
    partial = pruned
    await persist(partial).catch(() => {})
  }
  stored = partial
  cache = resolveInherited(partial, await readCliSettings())
  return cache
}

export async function getSettings(): Promise<CluiSettings> {
  return (await getResolvedSettings()).values
}

/** Resolved values + per-key provenance. Backs the reset affordance in Settings. */
export async function getResolvedSettings(): Promise<ResolvedSettings> {
  return cache ?? load()
}

/**
 * Synchronous read of the in-memory cache (or defaults if not yet loaded). Used
 * by the sync theme IPC that runs during preload, before any async load can
 * resolve. Call `getSettings()` once at startup (before window creation) to warm
 * the cache so this returns the persisted values rather than defaults.
 */
export function getSettingsSync(): CluiSettings {
  return cache?.values ?? { ...DEFAULT_SETTINGS }
}

/**
 * Apply a patch and/or clear keys, then persist the overrides-only file.
 *
 * A key is persisted iff its value differs from what the key resolves to with NO
 * override present. So re-picking the inherited value un-overrides the key, which is
 * exactly what a reset does; and a value that merely echoes a default is never frozen
 * into the file (the bug this whole change exists to kill).
 *
 * `clear` is a separate channel because a clear CANNOT be expressed as
 * `patch: {key: undefined}`: JSON.stringify would drop the key from disk, but the
 * in-memory cache would hold a real `undefined` in a field typed non-optional, so
 * every consumer would read undefined until the next restart. A clear has to go back
 * through the resolver, which is what this does.
 */
export async function updateSettings(
  patch: Partial<CluiSettings>,
  clear: SettingsKey[] = []
): Promise<ResolvedSettings> {
  await getResolvedSettings()
  const cli = await readCliSettings()
  const next: StoredSettings = { ...stored }

  for (const key of clear) delete next[key]

  // Iterate in DEFAULT_SETTINGS order rather than the patch's own key order, so
  // `model` is always resolved before `effort` (whose clamp depends on it) and the
  // result never depends on how the renderer happened to build the object.
  for (const key of Object.keys(DEFAULT_SETTINGS) as SettingsKey[]) {
    if (!(key in patch)) continue
    const v = patch[key]
    if (v === undefined || typeof v !== typeof DEFAULT_SETTINGS[key]) continue
    delete next[key]
    // `next` has the key removed, so this is the value the user would see after a
    // reset, including the clamp, since that clamped value is what the picker shows.
    // Re-picking it means "inherit", not "override with the same thing".
    if (v === resolveInherited(next, cli).values[key]) continue
    Object.assign(next, { [key]: v })
  }

  stored = next
  cache = resolveInherited(next, cli)
  await persist(next)
  return cache
}
