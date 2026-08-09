/**
 * Live model discovery (avoids a stale hardcoded list). Queries Bedrock inference
 * profiles via the AWS CLI using the user's configured profile/region (from
 * ~/.claude/settings.json `bedrock`) and returns their ids unchanged, since only the
 * full id is a valid `--model` value. Falls back to a bundled list if the query fails (no aws
 * CLI, non-Bedrock provider, etc.), flagged `live: false` so the UI can say so
 * instead of claiming a live list. Only a SUCCESSFUL result is cached, so a
 * transient failure retries rather than pinning the fallback for the process.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ModelListResult } from '../../shared/ipc'
import { FALLBACK_MODEL_IDS, deriveModelInfo } from '../../shared/settings'
import { loginShellAuthEnv } from '../cli/shell-env'
import { readCliSettings } from '../settings/cli-settings'

const execFileP = promisify(execFile)

let cache: string[] | null = null

/**
 * Bedrock's inference-profile ids, kept VERBATIM as `--model` values and deduped in list
 * order. Non-Anthropic profiles and the legacy claude-3 family (not effort-capable) are
 * dropped. Shortening the id here is what broke half the picker: strip the prefix off a
 * date-suffixed profile and you get 'claude-haiku-4-5', which is not a model name the API
 * knows. Shortening is a DISPLAY concern, and `labelFor` already parses the full id.
 *
 * Bedrock lists most models twice, once per region scope ('us.' and 'global.'), so the
 * dedupe key is the id WITHOUT its prefix while the value stays the full id (first scope
 * seen wins). Keying on the raw id instead would show every model twice.
 */
function pickableProfileIds(ids: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of ids) {
    const key = raw.replace(/^(?:[a-z0-9-]+\.)*anthropic\./i, '')
    if (!key || key === raw || /^claude-3-/.test(key)) continue
    if (!seen.has(key)) {
      seen.add(key)
      out.push(raw)
    }
  }
  return out
}

/**
 * Absolute path to `aws`, asked of the login shell, which knows the user's real PATH where a
 * Finder-launched app does not. Pinned for the process so a later PATH change can't swap the
 * executable out from under a query.
 */
let awsPath: string | null = null
async function resolveAws(): Promise<string> {
  if (awsPath) return awsPath
  const shell = process.env.SHELL || '/bin/zsh'
  // `command -v` exits 1 when the binary is absent, which means the same thing as an ENOENT
  // from exec'ing it. Swallow the rejection so the reason stays 'no-cli', not 'other'.
  const stdout = await execFileP(shell, ['-lic', 'command -v aws'], {
    timeout: 5000,
    encoding: 'utf8'
  }).then(
    (r) => r.stdout,
    () => ''
  )
  // rc noise can precede the answer; take the last absolute path the shell printed.
  const hit = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('/'))
    .pop()
  if (!hit) throw Object.assign(new Error('aws not found'), { code: 'ENOENT' })
  awsPath = hit
  return hit
}

/** Coarse cause of a failed live query, so the UI can name the fix (or stay vague). */
function failureReason(e: unknown): NonNullable<ModelListResult['reason']> {
  const err = e as { code?: unknown; stderr?: unknown; message?: unknown }
  if (err?.code === 'ENOENT') return 'no-cli'
  const text = `${typeof err?.stderr === 'string' ? err.stderr : ''} ${
    typeof err?.message === 'string' ? err.message : ''
  }`
  return /expired|ExpiredToken|sso/i.test(text) ? 'expired-creds' : 'other'
}

/**
 * List available model ids. Live-queries Bedrock; caches ONLY successful results;
 * falls back to the bundled list on failure WITHOUT caching it, so a transient
 * failure (aws not yet on PATH, creds refreshing, network blip) is retried on the
 * next call instead of pinning the stale fallback for the whole process lifetime.
 * `live` is therefore a per-call fact, never a process-wide "offline" state.
 * The 1M Opus variant is appended when the base opus-4-8 is present (Bedrock
 * doesn't list [1m] as a separate profile, but the CLI accepts the suffix).
 */
export async function listModels(refresh = false): Promise<ModelListResult> {
  if (cache && !refresh) return { ids: cache, live: true }
  const { profile, region } = (await readCliSettings()).bedrock
  try {
    // A Finder-launched app inherits a minimal env, so `aws` here fails with
    // NoCredentials and every list silently degrades to FALLBACK_MODEL_IDS. Re-source
    // the login shell for the same auth vars the CLI subprocess gets.
    const authEnv = await loginShellAuthEnv()
    const env = {
      ...process.env,
      ...authEnv,
      // When no credentials resolve, botocore probes the EC2 metadata service: two attempts
      // at a hard-coded 1s connect timeout against 169.254.169.254, which macOS blackholes
      // via ARP rather than refusing. That is ~2.4s of a ~2.6s doomed call; without it the
      // failure path is ~0.5s, most of which is `aws` startup. Clui ships macOS-only, so
      // instance metadata can never be a real credential source here.
      AWS_EC2_METADATA_DISABLED: 'true',
      ...(profile ? { AWS_PROFILE: profile } : {})
    }
    const args = ['bedrock', 'list-inference-profiles']
    if (region) args.push('--region', region)
    args.push('--query', 'inferenceProfileSummaries[].inferenceProfileId', '--output', 'text')
    const { stdout } = await execFileP(await resolveAws(), args, {
      env,
      timeout: 15000,
      encoding: 'utf8'
    })
    const ids = pickableProfileIds(stdout.split(/\s+/).filter(Boolean))
    if (ids.length === 0) throw new Error('no anthropic models returned')
    cache = withVariants(ids)
    return { ids: cache, live: true }
  } catch (e) {
    // Do NOT cache the fallback: leave `cache` null so the next call retries the
    // live query. Return the bundled list for this call only.
    return { ids: FALLBACK_MODEL_IDS, live: false, reason: failureReason(e) }
  }
}

/** Add the [1m] Opus variants (accepted by --model though Bedrock never lists them). */
function withVariants(ids: string[]): string[] {
  const out: string[] = []
  for (const id of ids) {
    // Surface the 1M variant right before the base for large-context Opus. Derived
    // from the parsed version (like the effort gates) so a new Opus qualifies without
    // an edit here. The base id alone caps at 200K even on Opus 5, where the CLI
    // still requires the [1m] suffix to unlock 1M (verified live on 2.1.220).
    const { family, version } = deriveModelInfo(id)
    if (family === 'opus' && version >= 4.7 && !/\[1m\]$/.test(id)) out.push(`${id}[1m]`)
    out.push(id)
  }
  return out
}
