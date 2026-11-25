import { fileLinkTitle, LinkedText, openFileLink, useLinkTarget } from '../lib/openLink'
import { openFileLabel, toolPathIn } from '../lib/fileLinks'
import { useEffect, useId, useRef, useState, type MouseEvent } from 'react'
import { useActive, useSession, type MonitorRecord, type ToolCall } from '../store'
import { formatElapsed } from '../lib/turnEnd'
import { useDelayedFlag } from '../lib/useDelayedFlag'
import { useStopFocus } from '../lib/useStopFocus'
import { formatCost } from '../lib/formatCost'
import { Lumen } from './Lumen'
import { lumenSiteOf } from '../lib/lumen'
import { viaOf } from '../lib/motion'
import { diveInto, setPaneVia } from '../lib/dive'
import {
  STATE_TEXT,
  browserLabel,
  browserResultCopy,
  changeReadOf,
  editPathOf,
  failureReason,
  bashExit,
  isBackgroundedTool,
  isBrowserTool,
  isChangeRead,
  monitorMeta,
  monitorRowState,
  needsYouToolIdOf,
  rowState,
  summarizeInput,
  tierOf,
  toolLabel,
  TURN_LINE_PX,
  type RowState,
  type Tier
} from '../lib/instrument'
import { effortLabel } from '../../../shared/settings'
import { activityLine, agentInfo, agentRunState, findAgentTool, sendInputOf, sendResultOf, sendTargetOf, STARTING, subagentType } from '../lib/agents'
import { workflowTaskOf } from '../lib/workflow'
import { IconAgentBrowser, IconCheck, IconChevron, IconCircle, IconCopy, IconFile, IconOpenPane, IconSendToTray, IconShield, IconStop, IconWarn } from './Icon'

type Placement = 'spine' | 'inline'
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write'])
type Seg = 'through' | 'end'

const BEAD_FILL: Record<RowState, string> = {
  running: 'bg-accent',
  // The call is still in flight from the user's side, so it keeps the running bead.
  checking: 'bg-accent',
  'needs-you': 'bg-warn',
  failed: 'border-[1.5px] border-err',
  'not-run': 'border-[1.5px] border-faint',
  stopped: 'border-[1.5px] border-faint',
  launched: 'bg-info',
  launching: 'border-[1.5px] border-info',
  watching: 'bg-info',
  sent: 'border-[1.5px] border-faint',
  done: 'border-[1.5px] border-faint',
  ended: 'border-[1.5px] border-faint'
}

/** 8px state mark. On the spine it sits outside the row, centred on the line 15px left of the
 *  row edge at the run's `--bead-c`; inline (an off-spine run) it leads the row's grid. `bare`
 *  marks a bead that sits on the page rather than a card. */
export function Bead({ state, lit, placement, bare = false }: { state: RowState; lit: boolean; placement: Placement; bare?: boolean }): JSX.Element {
  const hollow = state === 'launching' || state === 'sent' || state === 'done' || state === 'ended' || state === 'failed' || state === 'not-run' || state === 'stopped'
  const pos = placement === 'spine' ? 'absolute left-[-19px] top-[calc(var(--bead-c)-4px)]' : 'relative'
  // A hollow ring is filled with whatever it sits on, so the spine line doesn't show through it.
  const hole = hollow ? (placement === 'spine' || bare ? 'bg-bg' : 'bg-tool') : ''
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

function StatusText({ state, startMs, reason, exit }: { state: RowState; startMs?: number; reason?: string; exit?: string | null }): JSX.Element {
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
    case 'stopped':
      return (
        <span className="flex items-center gap-1 text-faint">
          <IconStop className="h-3 w-3 shrink-0" />
          stopped
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
          {exit && <span className="text-dim">· exit {exit}</span>}
        </span>
      )
    case 'launching':
      return <span className="text-info">launching…</span>
    case 'launched':
      return <span className="text-info">launched</span>
    case 'watching':
      return (
        <span className="text-info">
          watching{startMs !== undefined && <> <RunningTimer startMs={startMs} /></>}
        </span>
      )
    case 'ended':
      return <span className="text-faint">ended</span>
    case 'sent':
      return <span className="text-faint">sent</span>
    default:
      return <span className="text-faint">done</span>
  }
}

/** With an aside (agent badge, monitor meta) the target takes only its own width and the aside the rest, so the aside
 *  sits right after the target; under 520px of run width the target spans both and the aside drops to a second row. */
const gridCols = (placement: Placement, actions: boolean, aside: boolean): string =>
  [placement === 'inline' ? '8px' : null, 'auto', aside ? 'minmax(0,max-content) 1fr' : 'minmax(0,1fr)', 'auto', actions ? 'auto' : null, '24px']
    .filter(Boolean)
    .join(' ')

/** The container is the tier: a filled card needs a look, an outline is still working elsewhere, a bare line changed or
 *  only looked at something. A loud card's hover is in styles.css, because its fill can't change. */
const CONTAINER: Record<Tier, string> = {
  loud: 'relative overflow-hidden rounded-md bg-tool',
  calm: 'relative overflow-hidden rounded-md shadow-[inset_0_0_0_1px_var(--color-border-strong)] pointer-fine:hover:bg-row-hover',
  legible: 'relative overflow-hidden rounded-md pointer-fine:hover:bg-row-hover',
  routine: 'relative overflow-hidden rounded-md pointer-fine:hover:bg-row-hover'
}

export function InstrumentRow({
  tool,
  placement,
  seg = 'through',
  open,
  onToggle,
  hidden,
  id,
  reveal,
  edits
}: {
  tool: ToolCall
  placement: Placement
  /** Spine slice for a spine-placed row: 'end' on the run's last visible row. */
  seg?: Seg
  /** Open state lives in the run, because an open row never folds. */
  open: boolean
  onToggle: () => void
  hidden: boolean
  id: string
  /** A row the sentence revealed by pointer animates in. */
  reveal: boolean
  /** The edits a merged edit row stands for, itself last. */
  edits?: ToolCall[]
}): JSX.Element {
  // A pointer-opened body animates in; a keyboard toggle is instant.
  const [animateBody, setAnimateBody] = useState(false)
  const browser = isBrowserTool(tool.name)
  // Once the session has had a second tab every browser row names its tab, earlier rows included.
  const tabNo = useActive((s) => (browser && s?.browser?.multi ? (s.browser.toolTabs[tool.id] ?? 0) : 0))
  const tabGone = useActive((s) => !!tabNo && !s?.browser?.tabs.some((t) => t.id === tabNo))
  // A change read is labelled by the change it names, which only the user message that sent it knows.
  const history = isChangeRead(tool.name)
  const [change = '', changeSpoken = ''] = useActive((s) => {
    const c = history && s ? changeReadOf(s.messages, tool.input) : null
    return c ? `${c.label}\0${c.spoken}` : ''
  }).split('\0')
  const send = tool.name === 'SendMessage' ? sendInputOf(tool.input) : null
  const sent = send ? sendResultOf(tool.result) : null
  const [targetId = '', targetLabel = ''] = useActive((s) => {
    const t = send && s ? sendTargetOf(s, send, sent?.pinId ?? null) : null
    return t && s ? `${t.id}\0${agentInfo(s, t.id).label}` : ''
  }).split('\0')
  const to = targetLabel || send?.to
  const counted = browser && !tool.isError ? browserResultCopy(tool.result) : null
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
  // A subagent's own gate names its tool (Bash, Edit), never the Agent call, so the card asks the agent's run state.
  const needsYou = useActive(
    (s) => needsYouToolIdOf(s) === tool.id || (!!s && (tool.name === 'Task' || tool.name === 'Agent') && (tool.result === undefined || isBackgroundedTool(tool)) && agentRunState(s, { by: 'tool', id: tool.id }).state === 'needs')
  )
  const gateReason = useActive((s) => (needsYouToolIdOf(s) === tool.id ? (s?.pendingPermissions[0]?.decisionReason?.trim() ?? '') : ''))
  const checking = useDelayedFlag(useActive((s) => !!s?.checkingTools[tool.id]))
  const lit = useActive((s) => {
    if (!s) return false
    const site = lumenSiteOf(s)
    return site?.kind === 'tool' && site.toolId === tool.id
  })
  const monitor = tool.name === 'Monitor'
  const rec = useActive((s) => (monitor ? s?.monitors[tool.id] : undefined))
  const stopping = useActive((s) => !!rec && !!s?.backgroundTasks[rec.taskId]?.stopping)
  const handleId = useActive((s) => s?.handleId ?? '')
  const stopTask = useSession((s) => s.stopBackgroundTask)
  const state = monitor ? monitorRowState(tool, needsYou, checking, rec) : rowState(tool, needsYou, checking)
  const tier = tierOf(tool, state)
  const input = (tool.input && typeof tool.input === 'object' ? tool.input : {}) as Record<string, unknown>
  // A row names a command the way the sentence does, so one call reads the same folded or not.
  const command = tool.name === 'Bash' && typeof input.command === 'string' ? input.command : ''
  const summary = send ? `to ${to}: ${firstLine(send.text)}` : browser ? browserLabel(tool.name, tool.input, tabNo) : history ? change : command || summarizeInput(tool.input)
  const title = send ? `to ${to}: ${send.text}` : command && typeof input.description === 'string' ? `${input.description}\n${command}` : summary
  // A description or a message is prose; commands, paths and patterns are code.
  const prose = !!send || (!!summary && summary === input.description)
  // An agent the session can't place is still named as one, so the id doesn't read as a person or a team.
  const spokenSummary = send ? `to ${targetLabel || (send.kind === null || send.kind === 'agent' ? `agent ${send.to}` : send.to)}` : changeSpoken || summary
  const watching = state === 'watching'
  const meta = rec && tool.result !== undefined && !tool.isError ? monitorMeta(rec, watching) : ''
  const canStopMonitor = watching && !stopping && !!rec
  const stopRef = useStopFocus<HTMLButtonElement>(stopping)
  // Task was renamed Agent in CLI 2.1.63; both mean a subagent.
  const isSubagent = tool.name === 'Task' || tool.name === 'Agent'
  const line = useActive((s) => {
    // A finished foreground call is never live; a backgrounded one keeps running past its result. A nested agent's
    // card sits in its parent's tab, whose transcript already shows each step.
    if (!isSubagent || !s || (tool.result !== undefined && !isBackgroundedTool(tool)) || !findAgentTool(s.messages, tool.id)) return ''
    return activityLine(needsYou ? 'needs' : agentRunState(s, { by: 'tool', id: tool.id }).state, s.agentActivity[tool.id], true)
  })
  const lineId = useId()
  const reasonId = useId()
  const wfTask = useActive((s) => (tool.name === 'Workflow' && s ? workflowTaskOf(s, tool) : null))
  const wfName = useActive((s) => (wfTask ? (s?.workflows[wfTask]?.name ?? null) : null)) ?? summary
  // Agent and openable Workflow rows open a tab, as does a Message row whose agent got the message; every other row
  // discloses in place.
  const opensAgent = !!targetId && state !== 'failed' && state !== 'not-run' && state !== 'stopped'
  const opens = isSubagent || !!wfTask || opensAgent
  const subType = subagentType(tool.input)
  const effort = subagentEffort(tool.input)
  const name = toolLabel(tool.name)
  const hasBrowser = useActive((s) => !!s?.browser)
  const revealBrowser = useSession((s) => s.revealBrowser)
  // Only a foreground Bash is worth moving; other tools finish too fast to bother.
  const canSendToBackground = tool.result === undefined && !isBackgroundedTool(tool) && tool.name === 'Bash'
  // A failed call's file may not exist, and a Quick session has no folder to open it in.
  const cwd = useActive((s) => (FILE_TOOLS.has(tool.name) && s && !s.ephemeral ? s.cwd : null))
  const filePath = state === 'done' ? toolPathIn(tool.input, cwd) : null
  const actions = opens || canSendToBackground || canStopMonitor || (browser && hasBrowser) || !!filePath
  const errLine = sent && !tool.isError ? (sent.ok ? '' : sent.note) : tool.isError ? firstLine(tool.result ?? '') : ''
  const output = sent ? sent.note : tool.result
  const loud = tier === 'loud'
  // Checking says why in its word; needs-you only when the CLI gave a reason, never an invented one.
  const exit = state === 'failed' && tool.isError && tool.name === 'Bash' ? bashExit(tool.result ?? '') : null
  const failure = exit?.code ? failureReason(exit.rest) || 'No output' : (tool.isError ? failureReason(tool.result ?? '') : errLine) || 'View error'
  const reason = state === 'failed' ? failure : state === 'not-run' ? errLine : state === 'needs-you' ? gateReason : ''
  const showReason = !!reason && !open
  const aside = (isSubagent && !!subType) || !!meta
  const editPath = tier === 'legible' ? editPathOf(tool) : null
  const relPath = editPath && cwd && editPath.startsWith(`${cwd}/`) ? editPath.slice(cwd.length + 1) : editPath
  const cut = relPath ? relPath.lastIndexOf('/') + 1 : 0
  const toggleBody = (e: MouseEvent): void => {
    setAnimateBody(viaOf(e) === 'pointer')
    onToggle()
  }
  const chevron = (
    <IconChevron
      className={`h-4 w-4 transition-transform [transition-duration:var(--dur-fast)] [transition-timing-function:var(--ease-out)] ${
        open ? 'rotate-90' : ''
      }`}
    />
  )
  const describedBy = [line && lineId, showReason && reasonId].filter(Boolean).join(' ') || undefined
  const targetCls =
    tier === 'routine' ? 'font-mono text-meta text-faint' : `${prose ? '' : 'font-mono '}text-code ${tier === 'calm' ? 'text-dim' : 'text-content'}`

  return (
    <div
      data-ui="instrument-row"
      data-state={state}
      data-tier={tier}
      data-row-id={tool.id}
      id={id}
      hidden={hidden}
      className={`${placement === 'spine' ? 'spine-seg' : 'relative'}${tier === 'loud' || tier === 'calm' ? ' py-0.5' : ''}${reveal ? ' row-body-in' : ''}`}
      data-seg={placement === 'spine' ? seg : undefined}
    >
      {placement === 'spine' && <Bead state={state} lit={lit} placement="spine" />}
      {/* On a row that opens a tab the fill means "opens it", so it stays off while the pointer is on the
          chevron, which only discloses the result. */}
      <div
        data-ui="row-card"
        className={`${CONTAINER[tier]} group/row${opens && !loud ? ' pointer-fine:has-[[data-ui=row-disclose]:hover]:bg-transparent' : ''}`}
      >
        <div className="relative">
          {/* The whole header is one button laid under the visible grid, so the action buttons can sit
              inside the row without nesting a button in a button. An Agent row's opens its transcript, a
              Workflow row's its workflow; every other row's is the disclosure. */}
          {isSubagent || opensAgent ? (
            <button
              type="button"
              data-ui="row-open-transcript"
              data-tool-id={tool.id}
              className="absolute inset-0 rounded-md focus-visible:outline-offset-[-2px]"
              aria-label={`${name}${spokenSummary ? ` ${spokenSummary}` : ''}, ${STATE_TEXT[state]}, open transcript`}
              aria-describedby={describedBy}
              title={[title, line !== STARTING && line, 'Open transcript'].filter(Boolean).join('\n')}
              onClick={(e) => diveInto(targetId || tool.id, viaOf(e), undefined, tool.id)}
            />
          ) : wfTask ? (
            <button
              type="button"
              data-ui="row-open-workflow"
              data-tool-id={tool.id}
              className="absolute inset-0 rounded-md focus-visible:outline-offset-[-2px]"
              aria-label={`Workflow${wfName ? ` ${wfName}` : ''}, ${STATE_TEXT[state]}, open workflow`}
              aria-describedby={describedBy}
              title={wfName ? `${wfName}\nOpen workflow` : 'Open workflow'}
              onClick={(e) => diveInto(tool.id, viaOf(e), { taskId: wfTask, title: wfName || 'Workflow' })}
            />
          ) : (
            <button
              type="button"
              className="absolute inset-0 rounded-md focus-visible:outline-offset-[-2px]"
              aria-expanded={open}
              aria-controls={bodyId}
              aria-label={`${name}${spokenSummary ? ` ${spokenSummary}` : ''}${edits ? `, ${edits.length} edits` : ''}${counted ? `, ${counted.copy}` : ''}, ${stopping && watching ? 'stopping' : STATE_TEXT[state]}${exit?.code ? `, exit code ${exit.code}` : ''}${meta ? `, ${meta.replace(' · ', ', ')}` : ''}`}
              aria-describedby={describedBy}
              title={title || undefined}
              onClick={toggleBody}
            />
          )}
          <div
            className="pointer-events-none relative grid items-center gap-x-2 pl-2 pr-1.5"
            style={{ gridTemplateColumns: gridCols(placement, actions, aside), gridTemplateRows: loud || tier === 'calm' ? '28px' : '24px' }}
          >
            {placement === 'inline' && <Bead state={state} lit={lit} placement="inline" bare={!loud} />}
            <span
              className={
                tier === 'routine' ? 'text-meta font-medium text-faint' : `text-label font-semibold ${state === 'not-run' ? 'text-dim' : 'text-content'}`
              }
            >
              {name}
            </span>
            <span className={`flex min-w-0 items-center gap-1.5${aside ? ' @max-[520px]:col-span-2' : ''}`}>
              {relPath ? (
                <span data-ui="row-target" className="flex min-w-0 items-baseline gap-1.5 font-mono">
                  <span className="shrink-0 text-code text-content">{relPath.slice(cut)}</span>
                  {cut > 0 && <span className="truncate text-meta text-faint">{relPath.slice(0, cut)}</span>}
                </span>
              ) : (
                summary && (
                  <span data-ui="row-target" className={`truncate ${targetCls}`}>
                    {summary}
                  </span>
                )
              )}
              {!!edits && <span className="shrink-0 text-meta text-faint">{edits.length} edits</span>}
              {counted && (
                <span className="shrink-0 text-meta">
                  <span className="text-faint">· </span>
                  {counted.flagged ? <Flagged copy={counted.copy} /> : <span className="text-dim">{counted.copy}</span>}
                </span>
              )}
            </span>
            {aside && (
              <span
                data-ui="row-aside"
                className={`flex items-center gap-1.5 whitespace-nowrap text-meta @max-[520px]:row-start-2 @max-[520px]:-mt-1 @max-[520px]:pb-1.5 ${
                  placement === 'inline' ? '@max-[520px]:col-[2/-1]' : '@max-[520px]:col-[1/-1]'
                }`}
              >
                {meta && (
                  <span data-ui="monitor-meta">
                    <span className="text-faint">· </span>
                    <span className="text-dim">{meta}</span>
                  </span>
                )}
                {isSubagent && subType && (
                  <span
                    className="rounded bg-bg-raised px-1.5 py-0.5 font-mono text-badge text-faint"
                    title={effort ? `${subType} subagent at ${effort} effort` : undefined}
                  >
                    {subType}
                    {effort && <>{' · '}{effort}</>}
                  </span>
                )}
              </span>
            )}
            <span className="text-meta">
              {stopping && watching ? (
                <span className="text-dim">stopping…</span>
              ) : (
                state !== 'done' && <StatusText state={state} startMs={watching ? rec?.startMs : tool.startMs} reason={errLine} exit={exit?.code} />
              )}
            </span>
            {opens ? (
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
                {canStopMonitor && (
                  <button
                    ref={stopRef}
                    type="button"
                    data-ui="row-stop-monitor"
                    onClick={() => void stopTask(handleId, rec.taskId)}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-faint transition-colors hover:text-content focus-visible:text-content focus-visible:outline-offset-[-2px]"
                    title="Stop this monitor"
                    aria-label={`Stop monitor: ${rec.description}`}
                  >
                    <IconStop className="h-3.5 w-3.5" />
                  </button>
                )}
                {browser && hasBrowser && (
                  <button
                    type="button"
                    data-ui="row-open-browser"
                    aria-disabled={tabGone || undefined}
                    onClick={(e) => {
                      if (tabGone) return
                      const via = viaOf(e)
                      void revealBrowser(tabNo || null, (next) => setPaneVia(next, via))
                    }}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-dim transition-colors hover:text-content focus-visible:outline-offset-[-2px] aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:text-dim"
                    title={tabGone ? `Tab ${tabNo} is closed` : tabNo ? `Show tab ${tabNo} in browser` : 'Show in browser'}
                    aria-label={tabGone ? `Tab ${tabNo} is closed` : tabNo ? `Show tab ${tabNo} in browser` : 'Show in browser'}
                  >
                    <IconAgentBrowser className="h-4 w-4" />
                  </button>
                )}
                {filePath && cwd && <OpenFileButton tool={tool} path={filePath} cwd={cwd} />}
              </span>
            )}
            {opens ? (
              <button
                type="button"
                data-ui="row-disclose"
                aria-expanded={open}
                aria-controls={bodyId}
                aria-label={isSubagent ? 'Agent result' : wfTask ? 'Workflow result' : 'Message result'}
                title={open ? 'Hide result' : 'Show result'}
                onClick={toggleBody}
                className="pointer-events-auto flex h-6 w-6 items-center justify-center rounded text-faint transition-colors pointer-fine:hover:text-content focus-visible:text-content focus-visible:outline-offset-[-2px]"
              >
                {chevron}
              </button>
            ) : (
              <span
                className={`flex h-6 w-6 items-center justify-center text-faint${
                  tier === 'routine' && !open ? ' opacity-0 pointer-fine:group-hover/row:opacity-100 group-has-[:focus-visible]/row:opacity-100' : ''
                }`}
                aria-hidden="true"
              >
                {chevron}
              </span>
            )}
          </div>
          {line && (
            <div
              id={lineId}
              aria-hidden="true"
              data-ui="agent-activity"
              className={`pointer-events-none relative -mt-1 truncate pb-1.5 pr-[34px] text-meta text-dim ${placement === 'inline' ? 'pl-6' : 'pl-2'}`}
            >
              {line}
            </div>
          )}
        </div>
        {/* A collapsed loud card keeps its reason in view. err text on the tool fill has the least contrast
            headroom, so the reason itself stays dim. */}
        {showReason && (
          <div
            id={reasonId}
            data-ui="row-reason"
            className="border-t border-border px-2.5 pb-[5px] pt-1 font-mono text-meta text-dim"
            title={(state === 'needs-you' ? reason : (output ?? reason)).slice(0, 500)}
          >
            {/* The clamp sits inside the padding, which would otherwise show the top of a fourth line. */}
            <p className="line-clamp-3 whitespace-pre-line break-words [overflow-wrap:anywhere]">{reason}</p>
          </div>
        )}
        {open && (
          <div ref={bodyRef} id={bodyId} className={`${animateBody ? 'row-body-in ' : ''}max-h-80 overflow-auto border-t border-border p-2.5${loud || tier === 'calm' ? '' : ' border-b'}`}>
            {monitor && <MonitorDetail input={tool.input} rec={rec} />}
            {send && <SendDetail to={to ?? send.to} text={send.text} />}
            {edits ? (
              edits.map((e, i) => (
                <div key={e.id} role="group" aria-labelledby={`${bodyId}-${i}`} className={i ? 'mt-3 border-t border-border pt-2.5' : undefined}>
                  <div id={`${bodyId}-${i}`} className="mb-1.5 text-meta text-dim">
                    {toolLabel(e.name)} {i + 1} of {edits.length}
                  </div>
                  <ToolBody tool={e} output={e.result} label="Output" />
                </div>
              ))
            ) : (
              <ToolBody tool={tool} output={output} label={state === 'not-run' ? 'Reason' : 'Output'} inputOpen={!summary} />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function ToolBody({ tool, output, label, inputOpen: initialInput = false }: { tool: ToolCall; output: string | undefined; label: string; inputOpen?: boolean }): JSX.Element {
  const [inputOpen, setInputOpen] = useState(initialInput)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current)
  }, [])
  const onCopy = (): void => {
    void navigator.clipboard.writeText(output ?? '')
    setCopied(true)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), 1500)
  }
  return (
    <>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-caps uppercase text-faint">{label}</span>
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
      {output !== undefined && (
        <pre className="whitespace-pre-wrap break-words font-mono text-code text-content">
          <LinkedText text={truncate(output, 4000)} truncated={output.length > 4000} />
        </pre>
      )}
      <button
        type="button"
        data-find-skip=""
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
    </>
  )
}

const DETAIL_LIST = 'grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 text-meta text-dim'

function DetailRow({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <>
      <dt className="text-caps uppercase text-faint">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  )
}

function MonitorDetail({ input, rec }: { input: unknown; rec: MonitorRecord | undefined }): JSX.Element {
  const { command, timeout_ms } = (input && typeof input === 'object' ? input : {}) as { command?: unknown; timeout_ms?: unknown }
  return (
    <div data-ui="monitor-detail" className="mb-2.5 flex flex-col gap-1.5">
      <dl className={DETAIL_LIST}>
        {typeof command === 'string' && (
          <DetailRow label="Command">
            <span className="whitespace-pre-wrap break-words font-mono text-code text-content">{command}</span>
          </DetailRow>
        )}
        {typeof timeout_ms === 'number' && <DetailRow label="Timeout">{formatElapsed(timeout_ms)}</DetailRow>}
        {rec && (
          <DetailRow label="Wakes">
            {`${rec.wakes}${rec.sharedWakes ? ` (${rec.sharedWakes} shared with another monitor, so they may belong to either)` : ''}`}
          </DetailRow>
        )}
        {rec && <DetailRow label="Wake cost">{`${formatCost(rec.costUsd)}${rec.estimated ? ' estimated at list price' : ''}`}</DetailRow>}
      </dl>
      <p className="text-meta text-dim">Each event wakes Claude for a billed turn that re-reads this conversation.</p>
    </div>
  )
}

function SendDetail({ to, text }: { to: string; text: string }): JSX.Element {
  return (
    <dl data-ui="send-detail" className={`mb-2.5 ${DETAIL_LIST}`}>
      <DetailRow label="To">{to}</DetailRow>
      <DetailRow label="Message">
        <span className="whitespace-pre-wrap break-words text-content">{text}</span>
      </DetailRow>
    </dl>
  )
}

/** A file tool card's way to its file. The header is already the disclosure button, so this sits beside it rather
 *  than as a link inside it. Read opens at its offset, Edit at the first line it changed, Write at the top. */
function OpenFileButton({ tool, path, cwd }: { tool: ToolCall; path: string; cwd: string }): JSX.Element {
  const handleId = useActive((s) => s?.handleId ?? '')
  const target = useLinkTarget((s) => s.file)
  const editor = useLinkTarget((s) => s.editor)
  const [edited, setEdited] = useState<number | null>(null)
  useEffect(() => {
    if (tool.name !== 'Edit' || !handleId) return
    let live = true
    window.clui.editLine(handleId, path, tool.id).then((n) => live && setEdited(n), () => {})
    return () => {
      live = false
    }
  }, [tool.name, tool.id, handleId, path])
  const offset = tool.name === 'Read' ? (tool.input as { offset?: unknown }).offset : undefined
  const line = typeof offset === 'number' && Number.isSafeInteger(offset) && offset > 0 ? offset : (edited ?? undefined)
  const name = path.slice(path.lastIndexOf('/') + 1)
  const label = openFileLabel(name, line, target, editor)
  const title = fileLinkTitle(path.slice(cwd.length + 1), { line }, false, target, editor)
  return (
    <button
      type="button"
      data-ui="row-open-file"
      onClick={(e) => openFileLink(handleId, path, { line }, false, e)}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-dim transition-colors hover:text-content focus-visible:outline-offset-[-2px]"
      title={title}
      aria-label={label}
      aria-description={title}
    >
      <IconFile className="h-4 w-4" />
    </button>
  )
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
