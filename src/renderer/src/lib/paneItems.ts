import { tilde } from './tree'

export type PaneItemKey = 'open-file' | 'tree' | 'changes' | 'browser'

export interface PaneItem {
  key: PaneItemKey
  label: string
  meta: string
  /** The meta is a name, so it sets in mono. */
  mono?: boolean
  description?: string
  keys?: string
}

export const fileCount = (n: number): string => `${n} ${n === 1 ? 'file' : 'files'}`

/**
 * What the empty pane and the "+" menu offer, in one fixed order. The conditional items come last, so a session
 * gaining its first change never moves the rows above it.
 */
export function paneItems({ cwd, home, changes, browser }: { cwd: string; home: string; changes: number; browser: boolean }): PaneItem[] {
  const name = cwd.slice(cwd.lastIndexOf('/') + 1) || cwd
  const files = fileCount(changes)
  const items: PaneItem[] = [
    { key: 'open-file', label: 'Open file…', meta: '⌘P', keys: 'Meta+P' },
    { key: 'tree', label: 'File tree', meta: name, mono: true, description: `Folder ${tilde(cwd, home)}` }
  ]
  if (changes > 0) items.push({ key: 'changes', label: 'Claude changes', meta: files, description: `${files} changed by Claude` })
  if (browser) items.push({ key: 'browser', label: 'New browser tab', meta: '' })
  return items
}
