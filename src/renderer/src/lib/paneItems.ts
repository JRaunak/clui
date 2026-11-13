import { shownPath } from './tree'

export type PaneItemKey = 'open-file' | 'tree' | 'changes' | 'browser' | 'agents' | 'workflows'

export interface PaneItem {
  key: PaneItemKey
  label: string
  meta: string
  /** The meta is a name, so it sets in mono. */
  mono?: boolean
  description?: string
  keys?: string
}

/** A list tab's offer: how many run now, and how many the session has once its files were read. */
export interface RunCount {
  running: number
  total: number | null
}

export const fileCount = (n: number): string => `${n} ${n === 1 ? 'file' : 'files'}`

/** A list's figure for the picker and the palette: what runs now, else the count once it's known. */
export const runCountMeta = ({ running, total }: RunCount): string => (running > 0 ? `${running} running` : total !== null ? `${total}` : '')

const runItem = (key: 'agents' | 'workflows', label: string, noun: string, c: RunCount): PaneItem => {
  const meta = runCountMeta(c)
  return { key, label, meta, ...(meta ? { description: c.running > 0 ? meta : `${c.total} ${noun}${c.total === 1 ? '' : 's'} in this session` } : {}) }
}

/**
 * What the empty pane and the "+" menu offer, in one fixed order. The conditional items come last, so a session
 * gaining its first change never moves the rows above it. An open singleton isn't offered again. The Subagents and
 * Workflows lists are offered once the session has one, so `agents`/`workflows` are absent until then.
 */
export function paneItems({
  cwd,
  home,
  changes,
  browser,
  treeOpen,
  changesOpen,
  agents,
  workflows
}: {
  cwd: string
  home: string
  changes: number
  browser: boolean
  treeOpen: boolean
  changesOpen: boolean
  agents?: RunCount
  workflows?: RunCount
}): PaneItem[] {
  const name = cwd.slice(cwd.lastIndexOf('/') + 1) || cwd
  const files = fileCount(changes)
  const items: PaneItem[] = [{ key: 'open-file', label: 'Open file…', meta: '⌘P', keys: 'Meta+P' }]
  if (!treeOpen) items.push({ key: 'tree', label: 'File tree', meta: name, mono: true, description: `Folder ${shownPath(cwd, home)}` })
  if (changes > 0 && !changesOpen) items.push({ key: 'changes', label: 'Claude changes', meta: files, description: `${files} changed by Claude` })
  if (browser) items.push({ key: 'browser', label: 'New browser tab', meta: '' })
  if (agents) items.push(runItem('agents', 'Subagents', 'subagent', agents))
  if (workflows) items.push(runItem('workflows', 'Workflows', 'workflow', workflows))
  return items
}
