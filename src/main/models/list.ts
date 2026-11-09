/**
 * Live model discovery (avoids a stale hardcoded list). Two sources, asked in parallel:
 * the CLI's own model catalog (its initialize response, zero tokens, which also names the
 * provider), and on Bedrock the account's inference profiles via the AWS CLI. Bedrock's
 * profiles win on Bedrock because the catalog is only the CLI's /model picker list, not the
 * account's inventory; every other provider takes the catalog. Ids are returned unchanged,
 * since only the full id is a valid `--model` value. With neither source, Clui's bundled list
 * comes back flagged `live: false` so the UI can say so instead of claiming a live list. Only
 * a full live result is cached, so a transient failure retries rather than pinning the
 * fallback for the process.
 */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { app } from 'electron'
import type { ApiProvider, ModelListResult } from '../../shared/ipc'
import { FALLBACK_MODEL_IDS, catalogIds, deriveModelInfo, takes1mSuffix } from '../../shared/settings'
import { detectCli } from '../cli/detect'
import { NdjsonParser } from '../cli/ndjson'
import { childEnv } from '../cli/session'
import { loginShellAuthEnv } from '../cli/shell-env'
import { awsTarget, readCliSettings } from '../settings/cli-settings'
import { getSettings } from '../settings/store'

const execFileP = promisify(execFile)

let cache: ModelListResult | null = null

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

const API_PROVIDERS: ApiProvider[] = [
  'firstParty',
  'bedrock',
  'vertex',
  'foundry',
  'anthropicAws',
  'anthropicGoogleCloud',
  'mantle',
  'gateway'
]

type InitReply =
  | { type?: unknown; response?: { subtype?: unknown; response?: { account?: { apiProvider?: unknown }; models?: unknown } } }
  | null

const isApiProvider = (p: string | null): p is ApiProvider => (API_PROVIDERS as (string | null)[]).includes(p)

/** Initialize answered in 3 to 5s warm and 10.4s on a cold first start (CLI 2.1.319, this machine). */
const PROBE_TIMEOUT_MS = 20000

/**
 * The CLI's provider and catalog from its initialize response, or null if it didn't answer. No `--model`:
 * a session's catalog echoes its own `--model` as an extra row, which must not reach the shared list. Hooks
 * and MCP servers are off and nothing is persisted, so the probe costs no tokens and leaves no transcript.
 */
async function probeCatalog(authEnv: Record<string, string>): Promise<{ provider: string; models: unknown } | null> {
  const { cliPath } = await getSettings()
  const cli = (await detectCli(cliPath || null)).path
  if (!cli) return null
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
  args.push('--no-session-persistence', '--strict-mcp-config', '--settings', '{"disableAllHooks":true}')
  return new Promise((resolve) => {
    const child = spawn(cli, args, { cwd: app.getPath('userData'), env: childEnv({ env: authEnv }) })
    const parser = new NdjsonParser()
    const done = (v: { provider: string; models: unknown } | null): void => {
      clearTimeout(timer)
      child.kill()
      resolve(v)
    }
    const timer = setTimeout(() => done(null), PROBE_TIMEOUT_MS)
    child.on('error', () => done(null))
    child.on('close', () => done(null))
    child.stdin.on('error', () => {})
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      for (const msg of parser.push(chunk) as InitReply[]) {
        if (msg?.type !== 'control_response') continue
        const res = msg.response?.subtype === 'success' ? msg.response.response : undefined
        const provider = res?.account?.apiProvider
        return done(typeof provider === 'string' ? { provider, models: res?.models } : null)
      }
    })
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'models-probe', request: { subtype: 'initialize' } })}\n`)
  })
}

type BedrockOutcome = { ids: string[] } | { reason: NonNullable<ModelListResult['reason']> }

/**
 * Which list a query returns. `provider` is null when the CLI didn't answer; `hinted` is whether the
 * config names Bedrock, which decides if Bedrock's ids stand in for the CLI's answer.
 */
export function pickModelList({
  provider,
  catalog,
  bedrock,
  hinted
}: {
  provider: string | null
  catalog: string[]
  bedrock: BedrockOutcome
  hinted: boolean
}): ModelListResult {
  const known = isApiProvider(provider) ? { provider } : {}
  if ((provider === 'bedrock' || (provider === null && hinted)) && 'ids' in bedrock) {
    return { ids: withVariants(bedrock.ids), live: true, ...known }
  }
  if (catalog.length && provider !== null) {
    return provider === 'bedrock' && 'reason' in bedrock
      ? { ids: catalog, live: true, ...known, partial: true, reason: bedrock.reason }
      : { ids: catalog, live: true, ...known }
  }
  return { ids: withVariants(FALLBACK_MODEL_IDS), live: false, ...known, reason: 'reason' in bedrock ? bedrock.reason : 'other' }
}

async function queryBedrock(env: NodeJS.ProcessEnv, region: string | undefined): Promise<BedrockOutcome> {
  try {
    const args = ['bedrock', 'list-inference-profiles']
    if (region) args.push('--region', region)
    args.push('--query', 'inferenceProfileSummaries[].inferenceProfileId', '--output', 'text')
    const { stdout } = await execFileP(await resolveAws(), args, { env, timeout: 15000, encoding: 'utf8' })
    const ids = pickableProfileIds(stdout.split(/\s+/).filter(Boolean))
    if (ids.length === 0) throw new Error('no anthropic models returned')
    return { ids }
  } catch (e) {
    return { reason: failureReason(e) }
  }
}

/** The app's warm-up and an opening Settings page ask at once, so one query answers both. */
let pending: Promise<ModelListResult> | null = null

/**
 * List available model ids. Caches ONLY a full live result; a fallback or partial list is
 * returned WITHOUT caching, so a transient failure (aws not yet on PATH, creds refreshing,
 * network blip) is retried on the next call instead of pinning a worse list for the whole
 * process lifetime. `live` is therefore a per-call fact, never a process-wide "offline" state.
 */
export function listModels(refresh = false): Promise<ModelListResult> {
  if (cache && !refresh) return Promise.resolve(cache)
  pending ??= query().finally(() => (pending = null))
  return pending
}

async function query(): Promise<ModelListResult> {
  // A Finder-launched app inherits a minimal env, so the CLI and `aws` would miss the user's
  // auth vars. Re-source the login shell for the same vars a session's CLI gets.
  const [cli, authEnv] = await Promise.all([readCliSettings(), loginShellAuthEnv()])
  const shell = { ...process.env, ...authEnv }
  const { profile, region, useBedrock } = awsTarget(cli, shell)
  const awsEnv = {
    ...shell,
    // When no credentials resolve, botocore probes the EC2 metadata service: two attempts
    // at a hard-coded 1s connect timeout against 169.254.169.254, which macOS blackholes
    // via ARP rather than refusing. That is ~2.4s of a ~2.6s doomed call; without it the
    // failure path is ~0.5s, most of which is `aws` startup. Clui ships macOS-only, so
    // instance metadata can never be a real credential source here.
    AWS_EC2_METADATA_DISABLED: 'true',
    ...(profile ? { AWS_PROFILE: profile } : {})
  }
  // The provider is unknown until the CLI answers, so Bedrock is asked regardless and discarded off it.
  const [probe, bedrock] = await Promise.all([probeCatalog(authEnv).catch(() => null), queryBedrock(awsEnv, region)])
  const result = pickModelList({
    provider: probe?.provider ?? null,
    catalog: catalogIds(probe?.models),
    bedrock,
    hinted: useBedrock
  })
  if (result.live && !result.partial) cache = result
  return result
}

/**
 * One picker entry per model at its real max context: a `takes1mSuffix` model becomes only its
 * `${id}[1m]` id (Bedrock exposes its 1M only via the suffix, never as a separate profile), every other
 * keeps its base id. Never append `[1m]` to a 200K model: Haiku 400s the suffix.
 */
function withVariants(ids: string[]): string[] {
  return ids.map((id) => {
    const { family, version } = deriveModelInfo(id)
    return takes1mSuffix(family, version) && !/\[1m\]$/.test(id) ? `${id}[1m]` : id
  })
}
