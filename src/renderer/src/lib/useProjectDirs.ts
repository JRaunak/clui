import { useMemo } from 'react'
import { useActive, useSession } from '../store'
import { useSettings } from './settings'
import { unfirmlink } from './tree'

/** Basename of an absolute path. Pure string math, no node `path` in the renderer. */
export function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

/**
 * Project folders the user has worked in, most relevant first: the active session's cwd (forced in
 * so it lists before it has an on-disk row), then the distinct cwds the sidebar knows, then any folder
 * holding switched-off config, so a project with no sessions left can still be switched back on. The
 * chat dir is excluded because it means "no project".
 */
export function useProjectDirs(): string[] {
  const cwd = useActive((s) => s?.cwd ?? null)
  const chatDir = useSession((s) => s.chatDir)
  const sessionGroups = useSession((s) => s.sessionGroups)
  const disabledProjects = useSettings((s) => s?.values.disabledConfig.projects)
  return useMemo(
    () => projectDirs([...(cwd ? [cwd] : []), ...sessionGroups.map((g) => g.cwd), ...Object.keys(disabledProjects ?? {})], chatDir),
    [cwd, chatDir, sessionGroups, disabledProjects]
  )
}

/** `dirs` in order, minus the chat dir, one per folder: the CLI reports /tmp/x as /private/tmp/x after a turn,
 *  so both spellings are one entry, under the first one seen. */
export function projectDirs(dirs: string[], chatDir: string | null): string[] {
  const seen = new Set(chatDir ? [unfirmlink(chatDir)] : [])
  return dirs.filter((d) => {
    const key = unfirmlink(d)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
