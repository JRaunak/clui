/**
 * Resolve the user's LOGIN-SHELL environment so a Finder/app-drawer-launched Clui
 * spawns `claude` with the same auth context a terminal launch would have.
 *
 * WHY: macOS GUI apps inherit a minimal environment — none of the shell's exported
 * vars (`~/.zshrc`/`~/.zprofile`). The `claude` CLI authenticates from env: either
 * Bedrock (`CLAUDE_CODE_USE_BEDROCK` + `AWS_PROFILE`/`AWS_REGION`/creds), Vertex
 * (`CLAUDE_CODE_USE_VERTEX` + `GOOGLE_*`), or a direct key (`ANTHROPIC_API_KEY` /
 * `ANTHROPIC_AUTH_TOKEN`). Launched from Finder, none of those reach the spawned CLI
 * → it falls back to OAuth and reports "Not logged in · run /login" in every session.
 * `detect.ts` already resolves the CLI *path* through a login shell for the same
 * class of reason; this does the same for the auth *env*.
 *
 * Approach: run the login shell, have it emit its env as JSON, and keep only the
 * auth-relevant keys plus PATH. Curated-not-wholesale on purpose — blindly overlaying
 * the shell's entire env onto the Electron process could clobber Electron/Node-critical
 * vars. Best-effort (a failure yields {} → the CLI behaves exactly as it does today).
 *
 * NOT cached — but honestly a near-wash, not a freshness win. What's forwarded is a
 * static profile POINTER + provider flags (`AWS_PROFILE`/`AWS_REGION`/`CLAUDE_CODE_USE_BEDROCK`),
 * NEVER the hourly token: the SDK resolves + refreshes the token from `~/.aws/sso/cache/`
 * at call time, so a cached env would keep working across an `aws sso login` too. Left
 * uncached simply because the login-shell call is negligible against session-start's CLI
 * spawn+handshake, so a cache would be unjustified state for no measurable benefit.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/** Env-key prefixes that carry `claude` auth/provider config, provider-agnostic. */
const AUTH_PREFIXES = ['ANTHROPIC_', 'AWS_', 'CLAUDE_CODE_', 'GOOGLE_', 'GCLOUD_', 'CLOUD_ML_']
/**
 * Exact keys outside those prefixes worth carrying (region/provider togglers), plus PATH.
 * PATH matters because a Finder-launched app gets `/usr/bin:/bin`, which has no
 * `/opt/homebrew/bin` — so `aws` isn't found and the model list silently falls back to the
 * bundled one. Same class of problem `detect.ts` solves for `claude` by asking the shell.
 */
const AUTH_EXACT = new Set([
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'BEDROCK_REGION',
  'PATH'
])
/**
 * `CLAUDE_CODE_*` keys that are per-session RUNTIME markers, not auth — must NOT be
 * forwarded, or the spawned CLI would think it's a child/continuation of whatever
 * session set them (only present when Clui itself is launched from inside a Claude
 * Code session; harmless for a normal Finder launch, but wrong to pass through).
 */
const RUNTIME_MARKERS = new Set([
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDECODE'
])

function isAuthKey(key: string): boolean {
  if (RUNTIME_MARKERS.has(key)) return false
  return AUTH_EXACT.has(key) || AUTH_PREFIXES.some((p) => key.startsWith(p))
}

/**
 * The auth-relevant subset of the user's login-shell environment, to merge OVER
 * `process.env` when spawning the CLI. Empty object if the shell can't be read (the
 * CLI then behaves as it does when launched from a terminal without those vars).
 * Not cached — the login-shell call is negligible next to session-start's CLI spawn, so
 * a cache would be unjustified state for no measurable gain (see the module note above).
 */
export async function loginShellAuthEnv(): Promise<Record<string, string>> {
  const shell = process.env.SHELL || '/bin/zsh'
  try {
    // -l login + -i interactive so profile AND rc are sourced (matches detect.ts). Have
    // the shell hand its env to node and emit JSON — robust across shells and safe for
    // values containing newlines/`=` (BSD `printenv` has no `-0`, and delimiter-splitting
    // a raw env dump is fragile; JSON.stringify(process.env) sidesteps both).
    const { stdout } = await execFileP(
      shell,
      ['-lic', 'node -e "process.stdout.write(JSON.stringify(process.env))"'],
      { timeout: 5000, encoding: 'utf8', maxBuffer: 1024 * 1024 }
    )
    // The command output may be preceded by shell rc noise; parse the last JSON object.
    const start = stdout.indexOf('{')
    const end = stdout.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('no env json')
    const full = JSON.parse(stdout.slice(start, end + 1)) as Record<string, string>
    const out: Record<string, string> = {}
    for (const [key, val] of Object.entries(full)) {
      if (isAuthKey(key) && typeof val === 'string') out[key] = val
    }
    return out
  } catch {
    return {}
  }
}
