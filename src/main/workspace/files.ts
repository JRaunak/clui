/**
 * Workspace file listing for the composer's `@`-file picker.
 *
 * Git-aware where possible: `git ls-files` returns tracked + untracked-but-not-
 * ignored files (respecting .gitignore for free), which is exactly what a file
 * picker wants. Non-git dirs fall back to a bounded recursive walk that skips the
 * usual heavy/uninteresting dirs. Results are relative to `cwd` and capped.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const execFileP = promisify(execFile)

/** Max files returned — a huge repo shouldn't flood the picker or the IPC. */
const CAP = 3000

/** Dirs never worth walking in the fallback path (git already ignores most). */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  'build',
  'release',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  'vendor',
  '__pycache__',
  '.venv',
  'venv'
])

export interface WorkspaceFiles {
  files: string[]
  /** True if the list was capped (more files exist than returned). */
  truncated: boolean
}

export async function listWorkspaceFiles(cwd: string): Promise<WorkspaceFiles> {
  const viaGit = await gitLsFiles(cwd)
  if (viaGit) return viaGit
  return walk(cwd)
}

/** `git ls-files` (cached files + others not ignored). Null if not a git repo. */
async function gitLsFiles(cwd: string): Promise<WorkspaceFiles | null> {
  try {
    const { stdout } = await execFileP(
      'git',
      ['-C', cwd, 'ls-files', '--cached', '--others', '--exclude-standard'],
      { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }
    )
    const all = stdout.split('\n').filter(Boolean)
    return { files: all.slice(0, CAP), truncated: all.length > CAP }
  } catch {
    // Not a git repo, git missing, or timed out → caller falls back to a walk.
    return null
  }
}

/** Bounded breadth-first walk for non-git dirs. */
async function walk(root: string): Promise<WorkspaceFiles> {
  const files: string[] = []
  let truncated = false
  const queue: string[] = [root]
  while (queue.length) {
    const dir = queue.shift() as string
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (files.length >= CAP) {
        truncated = true
        return { files, truncated }
      }
      if (e.name.startsWith('.') && e.name !== '.env') continue // skip dotfiles/dirs
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(full)
      } else if (e.isFile()) {
        files.push(relative(root, full).split(sep).join('/'))
      }
    }
  }
  return { files, truncated }
}
