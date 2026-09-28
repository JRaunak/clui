import { useEffect, useRef, useState } from 'react'
import { useActive, useSession, sessionDisplayTitle } from '../store'
import { BackgroundTasks } from './BackgroundTasks'
import { WorkflowTray } from './WorkflowTray'
import { IconFolder } from './Icon'
import { formatCost } from '../lib/formatCost'

/** The session's status line at the bottom of the Stage, spanning both panes. Solid, because nothing
 *  scrolls beneath it. It's a container so it can shed detail as the window narrows. */
export function StatusBar(): JSX.Element {
  const cwd = useActive((s) => s?.cwd ?? null)
  const sessionId = useActive((s) => s?.sessionId ?? null)
  const costUsd = useActive((s) => s?.costUsd ?? null)
  const hasTasks = useActive((s) => Object.keys(s?.backgroundTasks ?? {}).length > 0)
  const sessionGroups = useSession((s) => s.sessionGroups)
  const sliceTitle = useActive((s) => sessionDisplayTitle(s))
  const activeTitle = useActive((s) => s?.title ?? null)
  const chatDir = useSession((s) => s.chatDir)
  // Live title wins so a rename shows instantly; else the on-disk resolved title so the bar matches
  // the sidebar row; else the slice's own title before the jsonl lands.
  const displayTitle =
    activeTitle ??
    sessionGroups.flatMap((g) => g.sessions).find((s) => s.id === sessionId)?.title ??
    sliceTitle
  // "Untitled" is a placeholder, not a name.
  const showTitle = !!displayTitle && displayTitle !== 'Untitled'
  const cost = costUsd !== null ? formatCost(costUsd) : null

  return (
    <div
      data-ui="status-bar"
      className="@container relative flex h-8 shrink-0 items-center gap-2.5 border-t border-border bg-bg px-4"
    >
      <div className="flex min-w-[min(24ch,45cqw)] flex-1 items-center gap-2.5">
        {showTitle && (
          <span
            data-ui="session-title"
            className="min-w-0 max-w-[40ch] truncate text-label font-medium text-content"
            title={cost ? `${displayTitle} · ${cost}` : displayTitle}
          >
            {displayTitle}
          </span>
        )}
        {cwd && cwd !== chatDir && (
          <span
            data-ui="session-project"
            className="flex shrink-0 items-center gap-1 text-meta text-dim"
            title={cwd}
            aria-label={`Working directory: ${cwd}`}
          >
            <IconFolder className="h-3.5 w-3.5 shrink-0" />
            <span className="max-w-[20ch] truncate @max-[560px]:hidden">{basename(cwd)}</span>
          </span>
        )}
        {sessionId && <SessionIdButton id={sessionId} />}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        {hasTasks && <BackgroundTasks />}
        <WorkflowTray />
        {cost && (
          <span
            data-ui="session-cost"
            className="font-mono text-meta tabular-nums text-dim @max-[560px]:hidden"
            title="Cumulative session cost (from the CLI result event)"
          >
            {cost}
          </span>
        )}
      </div>
    </div>
  )
}

/** The short session id, copied on click. The label itself confirms the copy, the way the code-block
 *  copy buttons do, because the toast stack only carries delete-undo. */
function SessionIdButton({ id }: { id: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  const copy = (): void => {
    void navigator.clipboard.writeText(id)
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1500)
  }
  return (
    <>
      <button
        type="button"
        data-ui="session-id"
        onClick={copy}
        title={`Session ${id}. Click to copy.`}
        aria-label={`Copy session id ${id}`}
        className="-ml-1.5 flex h-6 min-w-[calc(8ch+0.75rem)] shrink-0 items-center justify-start rounded-md px-1.5 font-mono text-meta tabular-nums text-dim transition-colors hover:bg-bg-raised hover:text-content @max-[720px]:hidden"
      >
        {copied ? 'Copied' : id.slice(0, 8)}
      </button>
      <span className="sr-only" role="status">
        {copied ? 'Session id copied' : ''}
      </span>
    </>
  )
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}
