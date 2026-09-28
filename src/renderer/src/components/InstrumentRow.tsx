import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useActive, useSession, type ToolCall } from '../store'
import { Lumen } from './Lumen'
import { lumenSiteOf } from '../lib/lumen'
import { viaOf } from '../lib/motion'
import { diveInto } from '../lib/dive'
import {
  STATE_TEXT,
  isBackgroundedTool,
  needsYouToolIdOf,
  rowState,
  summarizeInput,
  worstState,
  type RowState
} from '../lib/instrument'
import { IconCheck, IconChevron, IconCopy, IconOpenPane, IconSendToTray, IconWarn } from './Icon'

type Placement = 'spine' | 'inline'
type Seg = 'through' | 'end'

const BEAD_FILL: Record<RowState, string> = {
  running: 'bg-accent',
  'needs-you': 'bg-warn',
  failed: 'border-[1.5px] border-err',
  launched: 'bg-info',
  launching: 'border-[1.5px] border-info',
  done: 'border-[1.5px] border-faint'
}

/** 8px state mark. On the spine it sits outside the card, centred on the line 15px left of the
 *  card edge; inline (inside an aggregate or an off-spine list) it leads the row's grid. */
export function Bead({ state, lit, placement }: { state: RowState; lit: boolean; placement: Placement }): JSX.Element {
  const hollow = state === 'launching' || state === 'done' || state === 'failed'
  const pos = placement === 'spine' ? 'absolute left-[-19px] top-3' : 'relative'
  // A hollow ring is filled with whatever it sits on, so the spine line doesn't show through it.
  const hole = hollow ? (placement === 'spine' ? 'bg-bg' : 'bg-tool') : ''
  return (
    <span
      data-ui="row-bead"
      data-state={state}
      aria-hidden="true"
      className={`${pos} block h-2 w-2 shrink-0 rounded-full ${hole} ${BEAD_FILL[state]}`}
    >
      {state === 'failed' && <span className="absolute inset-px rounded-full bg-err" />}
      <Lumen lit={lit} />
    </span>
  )
}

function StatusText({ state, startMs }: { state: RowState; startMs?: number }): JSX.Element {
  switch (state) {
    case 'running':
      return (
        <span className="text-dim">
          running{startMs !== undefined && <> <RunningTimer startMs={startMs} /></>}
        </span>
      )
    case 'needs-you':
      return <span className="text-warn">needs you</span>
    case 'failed':
      return (
        <span className="flex items-center gap-1 text-err">
          <IconWarn className="h-3.5 w-3.5 shrink-0" />
          failed
        </span>
      )
    case 'launching':
      return <span className="text-info">launching…</span>
    case 'launched':
      return <span className="text-info">launched</span>
    default:
      return <span className="text-faint">done</span>
  }
}

const gridCols = (placement: Placement, actions: boolean): string =>
  [placement === 'inline' ? '8px' : null, 'auto', 'minmax(0,1fr)', 'auto', actions ? 'auto' : null, '24px']
    .filter(Boolean)
    .join(' ')

const CARD = 'relative overflow-hidden rounded-md border border-border surface-content bg-tool pointer-fine:hover:bg-row-hover'

export function InstrumentRow({
  tool,
  placement,
  seg = 'through',
  lumen = true
}: {
  tool: ToolCall
  placement: Placement
  /** Spine slice for a spine-placed row: 'end' on the transcript item that carries the last bead. */
  seg?: Seg
  /** Rows inside an aggregate never light; the aggregate's own bead carries the Lumen. */
  lumen?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  // A pointer-opened body animates in; a keyboard toggle is instant.
  const [animateBody, setAnimateBody] = useState(false)
  const summary = summarizeInput(tool.input)
  // The header already shows the summary, so Input starts collapsed when there is one.
  const [inputOpen, setInputOpen] = useState(() => !summary)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current)
  }, [])
  const bodyId = useId()
  const sendToBackground = useSession((s) => s.backgroundTask)
  // Boolean selectors: a streaming token re-runs them but only re-renders the row whose answer flips.
  const needsYou = useActive((s) => needsYouToolIdOf(s) === tool.id)
  const lit = useActive((s) => {
    if (!lumen || !s) return false
    const site = lumenSiteOf(s)
    return site?.kind === 'tool' && site.toolId === tool.id
  })
  const state = rowState(tool, needsYou)
  // Task was renamed Agent in CLI 2.1.63; both mean a subagent.
  const isSubagent = tool.name === 'Task' || tool.name === 'Agent'
  const subType = subagentType(tool.input)
  const name = isSubagent ? 'Agent' : tool.name
  // Only a foreground Bash is worth moving; other tools finish too fast to bother.
  const canSendToBackground = tool.result === undefined && !isBackgroundedTool(tool) && tool.name === 'Bash'
  const actions = isSubagent || canSendToBackground
  const errLine = tool.isError ? firstLine(tool.result ?? '') : ''
  const onCopy = (): void => {
    void navigator.clipboard.writeText(tool.result ?? '')
    setCopied(true)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div
      data-ui="instrument-row"
      data-state={state}
      className={placement === 'spine' ? 'spine-seg' : 'relative'}
      data-seg={placement === 'spine' ? seg : undefined}
    >
      {placement === 'spine' && <Bead state={state} lit={lit} placement="spine" />}
      <div className={CARD}>
        <div className="relative">
          {/* The whole header is one disclosure button laid under the visible grid, so the action
              buttons can sit inside the row without nesting a button in a button. */}
          <button
            type="button"
            className="absolute inset-0 rounded-md focus-visible:outline-offset-[-2px]"
            aria-expanded={open}
            aria-controls={bodyId}
            aria-label={`${name}${summary ? ` ${summary}` : ''}, ${STATE_TEXT[state]}`}
            title={summary || undefined}
            onClick={(e) => {
              setAnimateBody(viaOf(e) === 'pointer')
              setOpen((o) => !o)
            }}
          />
          <div
            className="pointer-events-none relative grid h-8 items-center gap-2 px-2.5"
            style={{ gridTemplateColumns: gridCols(placement, actions) }}
          >
            {placement === 'inline' && <Bead state={state} lit={lit} placement="inline" />}
            <span className="text-label font-semibold text-content">{name}</span>
            <span className="flex min-w-0 items-center gap-1.5">
              {summary && <span className="truncate text-code text-dim">{summary}</span>}
              {isSubagent && subType && (
                <span className="shrink-0 rounded bg-bg-raised px-1.5 py-0.5 font-mono text-badge text-faint">
                  {subType}
                </span>
              )}
            </span>
            <span className="text-meta">
              <StatusText state={state} startMs={tool.startMs} />
            </span>
            {actions && (
              <span className="pointer-events-auto relative flex items-center gap-0.5">
                {canSendToBackground && (
                  <button
                    type="button"
                    onClick={() => void sendToBackground(tool.id)}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-faint transition-colors hover:text-content focus-visible:text-content focus-visible:outline-offset-[-2px]"
                    title="Send to background"
                    aria-label="Send to background"
                  >
                    <IconSendToTray className="h-3.5 w-3.5" />
                  </button>
                )}
                {isSubagent && (
                  <button
                    type="button"
                    data-ui="row-open-transcript"
                    data-tool-id={tool.id}
                    onClick={(e) => diveInto(tool.id, viaOf(e))}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-dim transition-colors hover:text-content focus-visible:outline-offset-[-2px]"
                    title="Open transcript"
                    aria-label="Open transcript"
                  >
                    <IconOpenPane className="h-4 w-4" />
                  </button>
                )}
              </span>
            )}
            <span className="flex h-6 w-6 items-center justify-center text-faint" aria-hidden="true">
              <IconChevron
                className={`h-4 w-4 transition-transform [transition-duration:var(--dur-fast)] [transition-timing-function:var(--ease-out)] ${
                  open ? 'rotate-90' : ''
                }`}
              />
            </span>
          </div>
        </div>
        {/* A collapsed failure keeps its reason visible. err text on the tool fill has the least
            contrast headroom, so the reason itself stays dim. */}
        {tool.isError && !open && (
          <div
            className="truncate border-t border-border px-2.5 py-1.5 font-mono text-meta text-dim"
            title={errLine || undefined}
          >
            {errLine || 'View error'}
          </div>
        )}
        {open && (
          <div id={bodyId} className={`${animateBody ? 'row-body-in ' : ''}max-h-80 overflow-auto border-t border-border p-2.5`}>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-caps uppercase text-faint">Output</span>
              <button
                type="button"
                onClick={onCopy}
                className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded text-faint transition-colors hover:text-content focus-visible:text-content focus-visible:outline-offset-[-2px]"
                aria-label="Copy output"
              >
                {copied ? <IconCheck className="h-4 w-4" /> : <IconCopy className="h-4 w-4" />}
              </button>
              <span className="sr-only" role="status" aria-live="polite">
                {copied ? 'Copied' : ''}
              </span>
            </div>
            {tool.result !== undefined && (
              <pre className="whitespace-pre-wrap break-words font-mono text-code text-content">
                {truncate(tool.result, 4000)}
              </pre>
            )}
            <button
              type="button"
              onClick={() => setInputOpen((o) => !o)}
              aria-expanded={inputOpen}
              className="mt-2.5 flex min-h-6 items-center gap-1.5 text-caps uppercase text-faint transition-colors hover:text-dim"
            >
              <IconChevron className={`h-3 w-3 transition-transform ${inputOpen ? 'rotate-90' : ''}`} aria-hidden="true" />
              Input
            </button>
            {inputOpen && (
              <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono text-code text-dim">
                {JSON.stringify(tool.input, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * More than AGGREGATE_ABOVE tools collapse into one row with the most urgent child's bead; at
 * COLLAPSE_AT and above, completed children hide until the header is opened. The gates count all
 * tools, not concurrent ones, because headless stream-json serializes subagent calls.
 */
export function AggregateRow({
  tools,
  placement,
  seg = 'through',
  collapse
}: {
  tools: ToolCall[]
  placement: Placement
  seg?: Seg
  collapse: boolean
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const ids = useMemo(() => new Set(tools.map((t) => t.id)), [tools])
  const needsYouId = useActive((s) => needsYouToolIdOf(s))
  const lit = useActive((s) => {
    if (!s) return false
    const site = lumenSiteOf(s)
    return site?.kind === 'tool' && ids.has(site.toolId)
  })
  const states = tools.map((t) => rowState(t, t.id === needsYouId))
  const worst = worstState(states)
  const done = states.filter((s) => s === 'done' || s === 'launched').length
  const failed = states.filter((s) => s === 'failed').length
  // One activity word at most, the most urgent first, so a lit or amber bead always has text too.
  const activity: { text: string; cls: string } | null = states.includes('needs-you')
    ? { text: 'needs you', cls: 'text-warn' }
    : states.includes('running')
      ? { text: 'running', cls: 'text-dim' }
      : states.includes('launching')
        ? { text: 'launching…', cls: 'text-info' }
        : null
  const names = [...new Set(tools.map((t) => (t.name === 'Task' || t.name === 'Agent' ? 'Agent' : t.name)))].join(', ')
  // Collapsed, only what still matters shows: failures pinned first, then anything unresolved.
  const visible =
    collapse && !expanded
      ? [...tools.filter((t) => t.result !== undefined && t.isError), ...tools.filter((t) => t.result === undefined)]
      : tools
  const label = [
    `${tools.length} tool calls`,
    failed > 0 ? `${failed} failed` : null,
    activity?.text ?? null,
    `${done} of ${tools.length} done`
  ]
    .filter(Boolean)
    .join(', ')
  const grid = (
    <div
      className="pointer-events-none relative grid h-8 items-center gap-2 px-2.5"
      style={{ gridTemplateColumns: gridCols(placement, false) }}
    >
      {placement === 'inline' && <Bead state={worst} lit={lit} placement="inline" />}
      <span className="text-label font-semibold text-content">{tools.length} tool calls</span>
      <span className="truncate text-code text-dim">{names}</span>
      <span className="flex items-center gap-1 text-meta">
        {failed > 0 && (
          <>
            <span className="flex items-center gap-1 text-err">
              <IconWarn className="h-3.5 w-3.5 shrink-0" />
              {failed} failed
            </span>
            <span className="text-faint">·</span>
          </>
        )}
        {activity && (
          <>
            <span className={activity.cls}>{activity.text}</span>
            <span className="text-faint">·</span>
          </>
        )}
        <span className="text-faint">
          {done} of {tools.length} done
        </span>
      </span>
      <span className="flex h-6 w-6 items-center justify-center text-faint" aria-hidden="true">
        {collapse && (
          <IconChevron className={`h-4 w-4 transition-transform [transition-duration:var(--dur-fast)] ${expanded ? 'rotate-90' : ''}`} />
        )}
      </span>
    </div>
  )
  return (
    <div
      data-ui="row-aggregate"
      data-state={worst}
      className={placement === 'spine' ? 'spine-seg' : 'relative'}
      data-seg={placement === 'spine' ? seg : undefined}
    >
      {placement === 'spine' && <Bead state={worst} lit={lit} placement="spine" />}
      <div className={CARD}>
        {collapse ? (
          <div className="relative">
            <button
              type="button"
              className="absolute inset-0 rounded-md focus-visible:outline-offset-[-2px]"
              aria-expanded={expanded}
              aria-label={label}
              onClick={() => setExpanded((v) => !v)}
            />
            {grid}
          </div>
        ) : (
          <div role="group" aria-label={label}>
            {grid}
          </div>
        )}
      </div>
      <div className="mt-1.5 flex flex-col gap-1.5 pl-3">
        {collapse && !expanded && done > 0 && (
          <div className="px-1 text-meta text-faint">{done} completed, hidden</div>
        )}
        {visible.map((t) => (
          <InstrumentRow key={t.id} tool={t} placement="inline" lumen={false} />
        ))}
      </div>
    </div>
  )
}

/** Text updates once a second; nothing animates. */
function RunningTimer({ startMs }: { startMs: number }): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return <span className="font-mono tabular-nums text-dim">{formatElapsed(now - startMs)}</span>
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m`
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s
}

function firstLine(s: string): string {
  for (const line of s.split('\n')) {
    const t = line.trim()
    if (t) return t
  }
  return ''
}

function subagentType(input: unknown): string | null {
  if (input && typeof input === 'object') {
    const t = (input as Record<string, unknown>).subagent_type
    if (typeof t === 'string' && t) return t
  }
  return null
}
