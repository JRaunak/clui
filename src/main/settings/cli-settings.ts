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
import { homedir } from 'node:os'
import { join } from 'node:path'

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
  /** Bedrock profile/region used to query the live model list. */
  bedrock: { profile?: string; region?: string }
}

interface RawCliSettings {
  model?: unknown
  effortLevel?: unknown
  permissions?: { defaultMode?: unknown }
  bedrock?: { profile?: unknown; region?: unknown }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

const cliSettingsPath = (): string => join(homedir(), '.claude', 'settings.json')

export async function readCliSettings(): Promise<CliSettings> {
  try {
    const parsed = JSON.parse(await readFile(cliSettingsPath(), 'utf8')) as RawCliSettings
    return {
      model: str(parsed.model),
      effortLevel: str(parsed.effortLevel),
      defaultMode: str(parsed.permissions?.defaultMode),
      bedrock: { profile: str(parsed.bedrock?.profile), region: str(parsed.bedrock?.region) }
    }
  } catch {
    return { bedrock: {} }
  }
}
