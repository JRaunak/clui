import { LinkedText } from '../lib/openLink'
import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react'
import { activeSlice, useActive, useSession, type ToolCall } from '../store'
import { formatElapsed } from '../lib/turnEnd'
import { Lumen } from './Lumen'
import { lumenSiteOf } from '../lib/lumen'
import { viaOf } from '../lib/motion'
import { diveInto, setBrowserPaneVia } from '../lib/dive'
import {
  STATE_TEXT,
  browserLabel,
  browserResultCopy,
  isBackgroundedTool,
  isBrowserTool,
  needsYouToolIdOf,
  rowState,
  summarizeInput,
  TURN_LINE_PX,
  worstState,
  type RowState
} from '../lib/instrument'
import { effortLabel } from '../../../shared/settings'
import { IconAgentBrowser, IconCheck, IconChevron, IconCircle, IconCopy, IconOpenPane, IconSendToTray, IconShield, IconWarn } from './Icon'

type Placement = 'spine' | 'inline'
type Seg = 'through' | 'end'

const BEAD_FILL: Record<RowState, string> = {
  running: 'bg-accent',
  // The call is still in flight from the user's side, so it keeps the running bead.
  checking: 'bg-accent',
  'needs-you': 'bg-warn',
  failed: 'border-[1.5px] border-err',
  'not-run': 'border-[1.5px] border-faint',
  launched: 'bg-info',
  launching: 'border-[1.5px] border-info',
  done: 'border-[1.5px] border-faint'
}

/** 8px state mark. On the spine it sits outside the card, centred on the line 15px left of the
 *  card edge; inline (inside an aggregate or an off-spine list) it leads the row's grid. */
export function Bead({ state, lit, placement }: { state: RowState; lit: boolean; placement: Placement }): JSX.Element {
  const hollow = state === 'launching' || state === 'done' || state === 'failed' || state === 'not-run'
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

function StatusText({ state, startMs, reason }: { state: RowState; startMs?: number; reason?: string }): JSX.Element {
  switch (state) {
    case 'running':
      return (
        <span className="text-dim">
          running{startMs !== undefined && <> <RunningTimer startMs={startMs} /></>}
        </span>
      )
    case 'checking':
      return (
        <span className="flex items-center gap-1 text-dim" title="Auto mode is checking whether this action is safe to run">
          <IconShield className="h-3.5 w-3.5 shrink-0" />
          checking{startMs !== undefined && <> <RunningTimer startMs={startMs} /></>}
        </span>
      )
    case 'not-run':
      return (
        <span className="flex items-center gap-1 text-faint" title={reason || undefined}>
          <IconCircle className="h-3.5 w-3.5 shrink-0" />
          not run
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
  const browser = isBrowserTool(tool.name)
  // Once the session has had a second tab every browser row names its tab, earlier rows included.
  const tabNo = useActive((s) => (browser && s?.browser?.multi ? (s.browser.toolTabs[tool.id] ?? 0) : 0))
  const tabGone = useActive((s) => !!tabNo && !s?.browser?.tabs.some((t) => t.id === tabNo))
  const viewTab = useSession((s) => s.viewBrowserTab)
  const summary = browser ? browserLabel(tool.name, tool.input, tabNo) : summarizeInput(tool.input)
  const counted = browser && !tool.isError ? browserResultCopy(tool.result) : null
  // The header already shows the summary, so Input starts collapsed when there is one.
  const [inputOpen, setInputOpen] = useState(() => !summary)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current)
  }, [])
  const bodyId = useId()
  const bodyRef = useRef<HTMLDivElement>(null)
  // A body opened under the dock scrolls up by its overflow, never so far that the row's own top goes under the band.
  useEffect(() => {
    const body = bodyRef.current
    if (!open || !animateBody || !body) return
    const sc = body.closest<HTMLElement>('[data-testid="virtuoso-scroller"]')
    const row = body.closest<HTMLElement>('[data-ui="instrument-row"]')
    if (!sc || !row) return
    // The row's box, not the body's: the body is mid enter transform when this runs.
    const s = sc.getBoundingClientRect()
    const r = row.getBoundingClientRect()
    const dock = parseFloat(getComputedStyle(sc).getPropertyValue('--dock-h')) || 0
    const by = Math.min(r.bottom - (s.bottom - dock), r.top - (s.top + TURN_LINE_PX))
    if (by > 0) sc.scrollBy({ top: by, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [open, animateBody])
  const sendToBackground = useSession((s) => s.backgroundTask)
  // Boolean selectors: a streaming token re-runs them but only re-renders the row whose answer flips.
  const needsYou = useActive((s) => needsYouToolIdOf(s) === tool.id)
  const checking = useDelayedFlag(useActive((s) => !!s?.checkingTools[tool.id]))
  const lit = useActive((s) => {
    if (!lumen || !s) return false
    const site = lumenSiteOf(s)
    return site?.kind === 'tool' && site.toolId === tool.id
  })
  const state = rowState(tool, needsYou, checking)
  // Task was renamed Agent in CLI 2.1.63; both mean a subagent.
  const isSubagent = tool.name === 'Task' || tool.name === 'Agent'
  const subType = subagentType(tool.input)
  const effort = subagentEffort(tool.input)
  const name = isSubagent ? 'Agent' : browser ? 'Browser' : tool.name
  const lastOpen = useSession((s) => (activeSlice(s)?.browser ? (s.browserPaneFull ? 'full' : 'half') : null))
  // Only a foreground Bash is worth moving; other tools finish too fast to bother.
  const canSendToBackground = tool.result === undefined && !isBackgroundedTool(tool) && tool.name === 'Bash'
  const actions = isSubagent || canSendToBackground || (browser && !!lastOpen)
  const errLine = tool.isError ? firstLine(tool.result ?? '') : ''
  const failed = state === 'failed'
  const toggleBody = (e: MouseEvent): void => {
    setAnimateBody(viaOf(e) === 'pointer')
    setOpen((o) => !o)
  }
  const chevron = (
    <IconChevron
      className={`h-4 w-4 transition-transform [transition-duration:var(--dur-fast)] [transition-timing-function:var(--ease-out)] ${
        open ? 'rotate-90' : ''
      }`}
    />
  )
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
      {/* On an Agent row the fill means "opens the transcript", so it stays off while the pointer is on the
          chevron, which only discloses the result. */}
      <div className={isSubagent ? `${CARD} group/row pointer-fine:has-[[data-ui=row-disclose]:hover]:bg-tool` : CARD}>
        <div className="relative">
          {/* The whole header is one button laid under the visible grid, so the action buttons can sit
              inside the row without nesting a button in a button. An Agent row's opens its transcript;
              every other row's is the disclosure. */}
          {isSubagent ? (
            <button
              type="button"
              data-ui="row-open-transcript"
              data-tool-id={tool.id}
              className="absolute inset-0 rounded-md focus-visible:outline-offset-[-2px]"
              aria-label={`${name}${summary ? ` ${summary}` : ''}, ${STATE_TEXT[state]}, open transcript`}
              title={summary ? `${summary}\nOpen transcript` : 'Open transcript'}
              onClick={(e) => diveInto(tool.id, viaOf(e))}
            />
          ) : (
            <button
              type="button"
              className="absolute inset-0 rounded-md focus-visible:outline-offset-[-2px]"
              aria-expanded={open}
              aria-controls={bodyId}
              aria-label={`${name}${summary ? ` ${summary}` : ''}${counted ? `, ${counted.copy}` : ''}, ${STATE_TEXT[state]}`}
              title={summary || undefined}
              onClick={toggleBody}
            />
          )}
          <div
            className="pointer-events-none relative grid h-8 items-center gap-2 px-2.5"
            style={{ gridTemplateColumns: gridCols(placement, actions) }}
          >
            {placement === 'inline' && <Bead state={state} lit={lit} placement="inline" />}
            <span className={`text-label font-semibold ${state === 'not-run' ? 'text-dim' : 'text-content'}`}>{name}</span>
            <span className="flex min-w-0 items-center gap-1.5">
              {summary && <span className="truncate text-code text-dim">{summary}</span>}
              {counted && (
                <span className="shrink-0 text-meta">
                  <span className="text-faint">· </span>
                  {counted.flagged ? <Flagged copy={counted.copy} /> : <span className="text-dim">{counted.copy}</span>}
                </span>
              )}
              {isSubagent && subType && (
                <span
                  className="shrink-0 rounded bg-bg-raised px-1.5 py-0.5 font-mono text-badge text-faint"
                  title={effort ? `${subType} subagent at ${effort} effort` : undefined}
                >
                  {subType}
                  {effort && <>{' · '}{effort}</>}
                </span>
              )}
            </span>
            <span className="text-meta">
              <StatusText state={state} startMs={tool.startMs} reason={errLine} />
            </span>
            {isSubagent ? (
              // Not a button: a click here falls through to the row. It's the one sign that this row
              // opens a pane where every other row expands in place.
              <span className="flex h-7 w-7 items-center justify-center">
                <IconOpenPane className="h-4 w-4 text-dim transition-colors pointer-fine:group-hover/row:text-content pointer-fine:group-has-[[data-ui=row-disclose]:hover]/row:text-dim" />
              </span>
            ) : actions && (
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
                {browser && lastOpen && (
                  <button
                    type="button"
                    data-ui="row-open-browser"
                    aria-disabled={tabGone || undefined}
                    onClick={(e) => {
                      if (tabGone) return
                      if (tabNo) viewTab(tabNo)
                      setBrowserPaneVia(lastOpen, viaOf(e))
                    }}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-dim transition-colors hover:text-content focus-visible:outline-offset-[-2px] aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:text-dim"
                    title={tabGone ? `Tab ${tabNo} is closed` : tabNo ? `Show tab ${tabNo} in browser` : 'Show in browser'}
                    aria-label={tabGone ? `Tab ${tabNo} is closed` : tabNo ? `Show tab ${tabNo} in browser` : 'Show in browser'}
                  >
                    <IconAgentBrowser className="h-4 w-4" />
                  </button>
                )}
              </span>
            )}
            {isSubagent ? (
              <button
                type="button"
                data-ui="row-disclose"
                aria-expanded={open}
                aria-controls={bodyId}
                aria-label="Agent result"
                title={open ? 'Hide result' : 'Show result'}
                onClick={toggleBody}
                className="pointer-events-auto flex h-6 w-6 items-center justify-center rounded text-faint transition-colors pointer-fine:hover:text-content focus-visible:text-content focus-visible:outline-offset-[-2px]"
              >
                {chevron}
              </button>
            ) : (
              <span className="flex h-6 w-6 items-center justify-center text-faint" aria-hidden="true">
                {chevron}
              </span>
            )}
          </div>
        </div>
        {/* A collapsed failure keeps its reason visible. err text on the tool fill has the least
            contrast headroom, so the reason itself stays dim. */}
        {failed && !open && (
          <div
            className="truncate border-t border-border px-2.5 py-1.5 font-mono text-meta text-dim"
            title={errLine || undefined}
          >
            {errLine || 'View error'}
          </div>
        )}
        {open && (
          <div ref={bodyRef} id={bodyId} className={`${animateBody ? 'row-body-in ' : ''}max-h-80 overflow-auto border-t border-border p-2.5`}>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-caps uppercase text-faint">{state === 'not-run' ? 'Reason' : 'Output'}</span>
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
                <LinkedText text={truncate(tool.result, 4000)} truncated={tool.result.length > 4000} />
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
  const checkingMap = useActive((s) => s?.checkingTools)
  // Delayed across the group, so a quick check on one row can't flash the word.
  const anyChecking = useDelayedFlag(tools.some((t) => !!checkingMap?.[t.id]))
  const lit = useActive((s) => {
    if (!s) return false
    const site = lumenSiteOf(s)
    return site?.kind === 'tool' && ids.has(site.toolId)
  })
  const states = tools.map((t) => rowState(t, t.id === needsYouId, anyChecking && !!checkingMap?.[t.id]))
  const worst = worstState(states)
  const done = states.filter((s) => s === 'done' || s === 'launched').length
  const failed = states.filter((s) => s === 'failed').length
  const notRun = states.filter((s) => s === 'not-run').length
  // One activity word at most, the most urgent first, so a lit or amber bead always has text too.
  const activity: { text: string; cls: string } | null = states.includes('needs-you')
    ? { text: 'needs you', cls: 'text-warn' }
    : states.includes('checking')
      ? { text: 'checking', cls: 'text-dim' }
      : states.includes('running')
      ? { text: 'running', cls: 'text-dim' }
      : states.includes('launching')
        ? { text: 'launching…', cls: 'text-info' }
        : null
  const names = [
    ...new Set(tools.map((t) => (t.name === 'Task' || t.name === 'Agent' ? 'Agent' : isBrowserTool(t.name) ? 'Browser' : t.name)))
  ].join(', ')
  // Collapsed, only what still matters shows: failures pinned first, then anything unresolved.
  const visible =
    collapse && !expanded
      ? [...tools.filter((t) => t.result !== undefined && t.isError && !t.notRun), ...tools.filter((t) => t.result === undefined)]
      : tools
  const label = [
    `${tools.length} tool calls`,
    failed > 0 ? `${failed} failed` : null,
    notRun > 0 ? `${notRun} not run` : null,
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
        {notRun > 0 && (
          <>
            <span className="text-faint">·</span>
            <span className="flex items-center gap-1 text-faint">
              <IconCircle className="h-3.5 w-3.5 shrink-0" />
              {notRun} not run
            </span>
          </>
        )}
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

/** `on`, once it has held for `ms`. A check that resolves within that never changes the row. */
function useDelayedFlag(on: boolean, ms = 400): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!on) {
      setShown(false)
      return
    }
    const t = setTimeout(() => setShown(true), ms)
    return () => clearTimeout(t)
  }, [on, ms])
  return on && shown
}

/** Text updates once a second; nothing animates. */
export function RunningTimer({ startMs }: { startMs: number }): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return <span className="font-mono tabular-nums text-dim">{formatElapsed(now - startMs)}</span>
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

export function subagentType(input: unknown): string | null {
  if (input && typeof input === 'object') {
    const t = (input as Record<string, unknown>).subagent_type
    if (typeof t === 'string' && t) return t
  }
  return null
}

/** The CLI ignores `effort` on a fork, so showing it there would lie. */
export function subagentEffort(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const { effort, subagent_type } = input as Record<string, unknown>
  return typeof effort === 'string' && effort && subagent_type !== 'fork' ? effortLabel(effort) : null
}

/** In "16 messages, 8 errors" the problem is the last clause, so only it takes the emphasis. */
function Flagged({ copy }: { copy: string }): JSX.Element {
  const cut = copy.lastIndexOf(', ')
  if (cut < 0) return <span className="font-medium text-content">{copy}</span>
  return (
    <span className="text-dim">
      {copy.slice(0, cut + 2)}
      <span className="font-medium text-content">{copy.slice(cut + 2)}</span>
    </span>
  )
}
