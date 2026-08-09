/**
 * Locate the installed `claude` binary.
 *
 * macOS GUI apps launched from Finder inherit a minimal PATH that usually omits
 * Homebrew / npm-global / ~/.local/bin, so `which claude` from `process.env.PATH`
 * often fails. We therefore resolve through a login shell first, then fall back to
 * probing common install locations, then to a user-configured override.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { CliInfo } from '../../shared/ipc'

const execFileP = promisify(execFile)

/** Common absolute locations to probe, in priority order. */
function commonPaths(): string[] {
  const home = homedir()
  return [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    join(home, '.local/bin/claude'),
    join(home, '.claude/local/claude'),
    '/usr/bin/claude'
  ]
}

/** Ask the user's login shell where `claude` is (picks up their real PATH). */
async function resolveViaLoginShell(): Promise<string | null> {
  const shell = process.env.SHELL || '/bin/zsh'
  try {
    // -l = login (loads profile/rc), -i = interactive (loads .zshrc) so PATH is complete.
    const { stdout } = await execFileP(shell, ['-lic', 'command -v claude'], {
      timeout: 5000,
      encoding: 'utf8'
    })
    const path = stdout.trim().split('\n').pop()?.trim()
    if (path && existsSync(path)) return path
  } catch {
    // ignore; fall through to common paths
  }
  return null
}

async function getVersion(binPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(binPath, ['--version'], {
      timeout: 5000,
      encoding: 'utf8'
    })
    // e.g. "2.1.206 (Claude Code)"
    return stdout.trim().split(/\s+/)[0] || stdout.trim() || null
  } catch {
    return null
  }
}

// Detect the CLI. If `override` is set (from app settings) and exists, it wins.
export async function detectCli(override?: string | null): Promise<CliInfo> {
  if (override && existsSync(override)) {
    return { path: override, version: await getVersion(override), source: 'settings' }
  }

  const viaShell = await resolveViaLoginShell()
  if (viaShell) {
    return { path: viaShell, version: await getVersion(viaShell), source: 'login-shell' }
  }

  for (const candidate of commonPaths()) {
    if (existsSync(candidate)) {
      return { path: candidate, version: await getVersion(candidate), source: 'common-path' }
    }
  }

  return { path: null, version: null, source: 'not-found' }
}
