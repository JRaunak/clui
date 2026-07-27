/**
 * Live model discovery (avoids a stale hardcoded list). Queries Bedrock inference
 * profiles via the AWS CLI using the user's configured profile/region (from
 * ~/.claude/settings.json `bedrock`), dedupes the us./global. prefixes, and
 * returns raw model ids. Falls back to a bundled list if the query fails (no aws
 * CLI, non-Bedrock provider, etc.). Only a SUCCESSFUL result is cached, so a
 * transient failure retries rather than pinning the fallback for the process.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { FALLBACK_MODEL_IDS, deriveModelInfo, normalizeModelId } from '../../shared/settings'
import { loginShellAuthEnv } from '../cli/shell-env'
import { readCliSettings } from '../settings/cli-settings'

const execFileP = promisify(execFile)

let cache: string[] | null = null

/**
 * Reduce Bedrock inference-profile ids to the model ids we pass to `--model`, deduped
 * in list order. e.g. 'us.anthropic.claude-opus-4-8' → 'claude-opus-4-8'. Non-Anthropic
 * profiles and the legacy claude-3 family (not effort-capable) are dropped.
 */
function normalizeProfileIds(ids: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of ids) {
    const id = normalizeModelId(raw)
    if (!id || /^claude-3-/.test(id)) continue
    if (!seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

/**
 * List available model ids. Live-queries Bedrock; caches ONLY successful results;
 * falls back to the bundled list on failure WITHOUT caching it — so a transient
 * failure (aws not yet on PATH, creds refreshing, network blip) is retried on the
 * next call instead of pinning the stale fallback for the whole process lifetime.
 * The 1M Opus variant is appended when the base opus-4-8 is present (Bedrock
 * doesn't list [1m] as a separate profile, but the CLI accepts the suffix).
 */
export async function listModels(refresh = false): Promise<string[]> {
  if (cache && !refresh) return cache
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
    const { stdout } = await execFileP('aws', args, { env, timeout: 15000, encoding: 'utf8' })
    const ids = normalizeProfileIds(stdout.split(/\s+/).filter(Boolean))
    if (ids.length === 0) throw new Error('no anthropic models returned')
    cache = withVariants(ids)
    return cache
  } catch {
    // Do NOT cache the fallback — leave `cache` null so the next call retries the
    // live query. Return the bundled list for this call only.
    return FALLBACK_MODEL_IDS
  }
}

/** Add the [1m] Opus variants (accepted by --model though Bedrock never lists them). */
function withVariants(ids: string[]): string[] {
  const out: string[] = []
  for (const id of ids) {
    // Surface the 1M variant right before the base for large-context Opus. Derived
    // from the parsed version (like the effort gates) so a new Opus qualifies without
    // an edit here — the base id alone caps at 200K even on Opus 5, where the CLI
    // still requires the [1m] suffix to unlock 1M (verified live on 2.1.220).
    const { family, version } = deriveModelInfo(id)
    if (family === 'opus' && version >= 4.7 && !/\[1m\]$/.test(id)) out.push(`${id}[1m]`)
    out.push(id)
  }
  return out
}
