/**
 * Read-only view of the user's `~/.claude/settings.json`.
 *
 * Clui NEVER writes this file; it belongs to the CLI. Clui reads it to inherit
 * what the user already told the CLI (model, effort, permission default) and to
 * find the AWS profile/region a Bedrock model query should use. Single reader for the whole app, so callers don't
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
  /** Legacy `bedrock` profile/region: the last resort for the Bedrock model query (see awsTarget). */
  bedrock: { profile?: string; region?: string }
  /** The AWS keys of the top-level `env`, which the CLI applies over the shell env. */
  env: AwsEnv
}

type AwsEnv = Partial<Record<'AWS_PROFILE' | 'AWS_REGION' | 'AWS_DEFAULT_REGION' | 'CLAUDE_CODE_USE_BEDROCK', string>>

interface RawCliSettings {
  model?: unknown
  effortLevel?: unknown
  maxEffortLevel?: unknown
  modelSettings?: unknown
  permissions?: { defaultMode?: unknown }
  bedrock?: { profile?: unknown; region?: unknown }
  env?: Record<string, unknown>
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
      bedrock: { profile: str(parsed.bedrock?.profile), region: str(parsed.bedrock?.region) },
      env: {
        AWS_PROFILE: str(parsed.env?.AWS_PROFILE),
        AWS_REGION: str(parsed.env?.AWS_REGION),
        AWS_DEFAULT_REGION: str(parsed.env?.AWS_DEFAULT_REGION),
        CLAUDE_CODE_USE_BEDROCK: str(parsed.env?.CLAUDE_CODE_USE_BEDROCK)
      }
    }
  } catch {
    return { bedrock: {}, env: {} }
  }
}

/**
 * The AWS profile/region the CLI itself would run with, for querying Bedrock's model list. The settings
 * `env` beats the shell because the CLI applies it over the shell; the legacy `bedrock` key goes last.
 * `useBedrock` reads the CLI's provider switch the same way, or the legacy key as an explicit opt-in.
 */
export function awsTarget(
  cli: CliSettings,
  shell: Record<string, string | undefined>
): { profile?: string; region?: string; useBedrock: boolean } {
  const { env, bedrock } = cli
  const flag = env.CLAUDE_CODE_USE_BEDROCK ?? shell.CLAUDE_CODE_USE_BEDROCK
  return {
    profile: env.AWS_PROFILE ?? (shell.AWS_PROFILE || undefined) ?? bedrock.profile,
    region:
      env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? (shell.AWS_REGION || shell.AWS_DEFAULT_REGION || undefined) ?? bedrock.region,
    useBedrock: /^(1|true|yes|on)$/i.test(flag?.trim() ?? '') || !!bedrock.profile
  }
}
