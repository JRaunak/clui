/**
 * Live model discovery (avoids a stale hardcoded list). Queries Bedrock inference
 * profiles via the AWS CLI using the user's configured profile/region (from
 * ~/.claude/settings.json `bedrock`), dedupes the us./global. prefixes, and
 * returns raw model ids. Falls back to a bundled list if the query fails (no aws
 * CLI, non-Bedrock provider, etc.). Result is cached for the process lifetime.
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { FALLBACK_MODEL_IDS, deriveModelInfo } from '../../shared/settings'
import { loginShellAuthEnv } from '../cli/shell-env'

const execFileP = promisify(execFile)

let cache: string[] | null = null

/** Read the bedrock profile/region from ~/.claude/settings.json (best-effort). */
async function bedrockConfig(): Promise<{ profile?: string; region?: string }> {
  try {
    const raw = await readFile(join(homedir(), '.claude', 'settings.json'), 'utf8')
    const parsed = JSON.parse(raw) as { bedrock?: { profile?: string; region?: string } }
    return parsed.bedrock ?? {}
  } catch {
    return {}
  }
}

/**
 * Reduce Bedrock inference-profile ids to the model ids we pass to `--model`.
 * e.g. 'us.anthropic.claude-opus-4-8' / 'global.anthropic.claude-opus-4-8' →
 * 'claude-opus-4-8'. Keeps only claude-* Anthropic models; drops v1 date suffixes.
 */
function normalizeProfileIds(ids: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of ids) {
    // Strip the us./global. region prefix and the anthropic. vendor segment.
    const m = raw.match(/anthropic\.(claude-[a-z0-9-]+)/i)
    if (!m) continue
    let id = m[1]
    // Drop date/version stamps like -20251001 and -v1:0 to get the alias-ish id.
    id = id.replace(/-\d{8}(-v\d+(?::\d+)?)?$/i, '').replace(/-v\d+(?::\d+)?$/i, '')
    // Skip legacy claude-3 family (not effort-capable, rarely wanted).
    if (/^claude-3-/.test(id)) continue
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
  const { profile, region } = await bedrockConfig()
  try {
    // A Finder-launched app inherits a minimal env, so `aws` here fails with
    // NoCredentials and every list silently degrades to FALLBACK_MODEL_IDS. Re-source
    // the login shell for the same auth vars the CLI subprocess gets.
    const authEnv = await loginShellAuthEnv()
    const env = { ...process.env, ...authEnv, ...(profile ? { AWS_PROFILE: profile } : {}) }
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
