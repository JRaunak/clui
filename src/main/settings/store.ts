/**
 * Persisted app settings, stored at `<userData>/settings.json`.
 *
 * The file holds ONLY explicit overrides. A key that is absent means "inherit":
 * resolve it from the user's ~/.claude/settings.json when that file speaks to it
 * (model, effort), else from DEFAULT_SETTINGS. Same philosophy as the existing
 * `permissionMode: 'inherit'` sentinel, applied to every field.
 *
 * Overrides-only so "the user chose dark" and "dark is the default" stay
 * distinguishable, which per-field reset needs. Persisting the whole merged object
 * would freeze every key as a concrete value on the first Save, including a model the
 * user never picked, silently overriding their CLI config.
 */
import { app } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_SETTINGS,
  THEME_CHOICES,
  PERMISSION_MODES,
  clampEffort,
  isEffortChoice,
  type CluiSettings,
  type ResolvedSettings,
  type SettingsKey
} from '../../shared/settings'
import { atomicWriteFile } from '../lib/atomic'
import { readCliSettings, type CliSettings } from './cli-settings'

/** Persisted shape: a partial, keys present only where the user overrode a default. */
type StoredSettings = Partial<CluiSettings>

/** Bumped only when the persisted-file semantics change. Its presence marks a file the
 *  current code wrote (overrides-only), so the one-time legacy migration never re-runs
 *  and re-strips a user's explicit picks. */
const SCHEMA_VERSION = 1

/** Validate a value against its key's allowed domain, not just its primitive type: an
 *  off-enum `theme`/`permissionMode`/`effort` (hand-edited or from another version) must
 *  be dropped, not passed through to CLI flags or `THEME_BG[...]`. Model ids stay open
 *  (any nonempty string; Bedrock ids are provider-defined). */
function isValidValue(key: SettingsKey, v: unknown): boolean {
  if (typeof v !== typeof DEFAULT_SETTINGS[key]) return false
  if (key === 'theme') return (THEME_CHOICES as readonly string[]).includes(v as string)
  if (key === 'permissionMode') return (PERMISSION_MODES as readonly string[]).includes(v as string)
  if (key === 'effort') return isEffortChoice(v)
  return true
}

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
 *    lists Bedrock's ids unshortened, so shortening here would match nothing, and the
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
const LEGACY_DEFAULTS: Partial<CluiSettings> = {
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
  // Start from a full COPY so keys the legacy schema never knew about (e.g.
  // `sidebarCollapsed`) survive; only DROP the ones that merely echo an old default.
  // Rebuilding from LEGACY_DEFAULTS' keys instead would erase newer fields.
  const pruned: StoredSettings = { ...input }
  let changed = false
  for (const key of Object.keys(LEGACY_DEFAULTS) as SettingsKey[]) {
    if (key in pruned && pruned[key] === LEGACY_DEFAULTS[key]) {
      delete pruned[key]
      changed = true
    }
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
    if (v === undefined || !isValidValue(key, v)) continue
    Object.assign(out, { [key]: v })
  }
  return out
}

/** True if the raw file was already written by the current schema (so the one-time legacy
 *  migration must not re-run on it). */
function isStamped(raw: string): boolean {
  try {
    const p = JSON.parse(raw) as { schemaVersion?: unknown }
    return p?.schemaVersion === SCHEMA_VERSION
  } catch {
    return false
  }
}

async function persist(next: StoredSettings): Promise<void> {
  // Stamp the schema version + write atomically (temp+rename) so a crash/failed write
  // can't leave a truncated file that reads as "no settings".
  await atomicWriteFile(settingsPath(), JSON.stringify({ ...next, schemaVersion: SCHEMA_VERSION }, null, 2))
}

// Serialize settings writes so two overlapping saves can't race at the file and lose one
// another's fields.
let settingsChain: Promise<void> = Promise.resolve()
function serializeSettings<T>(mutate: () => Promise<T>): Promise<T> {
  const run = settingsChain.then(mutate, mutate)
  settingsChain = run.then(
    () => {},
    () => {}
  )
  return run
}

/**
 * Load, migrate once, and resolve. The migration writes back only when it actually
 * pruned something, so a steady-state launch performs no write.
 */
async function load(): Promise<ResolvedSettings> {
  let raw: string | null = null
  try {
    raw = await readFile(settingsPath(), 'utf8')
  } catch {
    // No file yet (or unreadable): everything inherits. Do NOT write one here, since an
    // empty override file is the same as no file, and writing on read is a surprise.
    raw = null
  }
  let partial: StoredSettings = raw ? parseStored(raw) : {}

  // One-time legacy migration: the ORIGINAL persistence wrote the whole merged object
  // (all eight legacy keys), so a key equal to its old default there was never a choice,
  // so drop it so it starts inheriting. Run this ONLY on an unstamped file that still has
  // all legacy keys (a genuine whole-object write); an already-overrides-only file is left
  // alone and merely stamped, so we never re-strip a user's explicit picks.
  if (raw && !isStamped(raw)) {
    const isWholeObjectLegacy = (Object.keys(LEGACY_DEFAULTS) as SettingsKey[]).every((k) => k in partial)
    if (isWholeObjectLegacy) partial = pruneLegacyDefaults(partial).pruned
    // Stamp (and, if migrated, persist the pruned set) so the inference never repeats.
    // Best-effort: a failed write is retried next launch; `partial` is already correct.
    await serializeSettings(() => persist(partial)).catch(() => {})
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
 * into the file.
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
  const cleared = new Set(clear)

  for (const key of clear) delete next[key]

  // Iterate in DEFAULT_SETTINGS order rather than the patch's own key order, so
  // `model` is always resolved before `effort` (whose clamp depends on it) and the
  // result never depends on how the renderer happened to build the object.
  for (const key of Object.keys(DEFAULT_SETTINGS) as SettingsKey[]) {
    if (!(key in patch)) continue
    // A key being reset THIS save must not be re-applied from the full-settings patch the
    // UI submits: the patch still carries the field's old value, and re-adding it would
    // undo the reset.
    if (cleared.has(key)) continue
    const v = patch[key]
    if (v === undefined || !isValidValue(key, v)) continue
    delete next[key]
    // `next` has the key removed, so this is the value the user would see after a
    // reset, including the clamp, since that clamped value is what the picker shows.
    // Re-picking it means "inherit", not "override with the same thing".
    if (v === resolveInherited(next, cli).values[key]) continue
    Object.assign(next, { [key]: v })
  }

  // Publish in-memory state only AFTER a successful atomic write, serialized against other
  // saves so a failed/racing write can't leave memory ahead of disk.
  await serializeSettings(() => persist(next))
  stored = next
  cache = resolveInherited(next, cli)
  return cache
}
