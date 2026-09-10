/**
 * Read-only view of the user's `~/.claude/settings.json`.
 *
 * Clui NEVER writes this file; it belongs to the CLI. Clui reads it to inherit
 * what the user already told the CLI (model, effort, permission default) and to
 * find their Bedrock profile. Single reader for the whole app, so callers don't
 * each open it independently.
 *
 * Deliberately UNCACHED: the "System Default" permission report wants a live read
 * every time, and the caller that needs a stable snapshot (the settings store)
 * takes one itself.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { claudeHome } from '../lib/claude-home'
import { isEffortChoice } from '../../shared/settings'

/**
 * The subset of the CLI's settings Clui reads. Every field is optional and
 * validated: the file may be absent, partial, or hand-edited to anything.
 */
export interface CliSettings {
  /** `--model` value, usually Bedrock-prefixed (e.g. 'us.anthropic.claude-opus-5[1m]'). */
  model?: string
  /** The CLI's persisted effort. Its own enum is low/medium/high/xhigh (no 'max'). */
  effortLevel?: string
  /** `permissions.defaultMode`: what Clui's 'inherit' mode resolves to. */
  defaultMode?: string
  /**
   * Top-level `maxEffortLevel`: the CLI silently caps effort at this ceiling for every
   * model (`--effort max` under a `low` cap runs at low, no error). Clui reads it to keep
   * its picker/chip honest, never to write it.
   */
  maxEffortLevel?: string
  /** Per-model `modelSettings.<id>.maxEffortLevel`: a tighter cap for one model, taking
   *  precedence over the top-level one. */
  modelSettings?: Record<string, { maxEffortLevel?: string }>
  /** Bedrock profile/region used to query the live model list. */
  bedrock: { profile?: string; region?: string }
}

interface RawCliSettings {
  model?: unknown
  effortLevel?: unknown
  maxEffortLevel?: unknown
  modelSettings?: unknown
  permissions?: { defaultMode?: unknown }
  bedrock?: { profile?: unknown; region?: unknown }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** Effort fields are hand-edited, so drop anything that isn't a real level. */
const effort = (v: unknown): string | undefined => (isEffortChoice(v) ? v : undefined)

/** Built on a null-proto object since the keys are user-controlled model ids (a
 *  `__proto__` key must not reach the prototype). */
function parseModelSettings(v: unknown): Record<string, { maxEffortLevel?: string }> | undefined {
  if (!v || typeof v !== 'object') return undefined
  const out: Record<string, { maxEffortLevel?: string }> = Object.create(null)
  for (const [id, cfg] of Object.entries(v as Record<string, unknown>)) {
    if (!cfg || typeof cfg !== 'object') continue
    const cap = effort((cfg as { maxEffortLevel?: unknown }).maxEffortLevel)
    if (cap) out[id] = { maxEffortLevel: cap }
  }
  return Object.keys(out).length ? out : undefined
}

const cliSettingsPath = (): string => join(claudeHome(), 'settings.json')

export async function readCliSettings(): Promise<CliSettings> {
  try {
    const parsed = JSON.parse(await readFile(cliSettingsPath(), 'utf8')) as RawCliSettings
    return {
      model: str(parsed.model),
      effortLevel: str(parsed.effortLevel),
      maxEffortLevel: effort(parsed.maxEffortLevel),
      modelSettings: parseModelSettings(parsed.modelSettings),
      defaultMode: str(parsed.permissions?.defaultMode),
      bedrock: { profile: str(parsed.bedrock?.profile), region: str(parsed.bedrock?.region) }
    }
  } catch {
    return { bedrock: {} }
  }
}
