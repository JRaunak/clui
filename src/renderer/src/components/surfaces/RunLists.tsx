/** The Subagents and Workflows list tabs: every run in the session, live ones at once and the rest read from disk. */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { activeSlice, EMPTY_PENDING, loadRuns, useActive, useSession, type ChatMessage, type ToolCall } from '../../store'
import { activityLine, agentRows, isAgentTool, isLive, runningAgents, REASON_COPY, RUN_WORDS, STARTING, type AgentListRow } from '../../lib/agents'
import { workflowRows, workflowSummary } from '../../lib/workflow'
import { fmtTokens } from '../../lib/formatTokens'
import { formatElapsed } from '../../lib/turnEnd'
import { focusPaneTitle } from '../../lib/dive'
import { takeSurfaceFocus } from '../../lib/surfaceFocus'
import { useDelayedFlag } from '../../lib/useDelayedFlag'
import { Dash, Figures, FIGURES, TIME, TOKENS } from '../WorkflowTab'
import { RunningTimer } from '../InstrumentRow'
import { RunMark } from '../RunMark'
import { AgentFace } from '../faces'
import { Button } from '../Button'
import { IconChevron, IconWorkflow } from '../Icon'
import { knownRuns } from './PanePicker'

const SKELETON = ['w-[64%]', 'w-[52%]', 'w-[58%]']
const ROW_BOX = 'w-full rounded-md pr-4 text-left cursor-default focus-visible:-outline-offset-2 pointer-fine:hover:bg-[var(--glass-row-hover)]'
const ROW = `flex h-8 items-center gap-2 ${ROW_BOX}`
const NO_ACTIVITY: Record<string, string> = {}

type Kind = 'agents' | 'workflows'
const COPY: Record<Kind, { reading: string; failed: string; empty: string; how: string }> = {
  agents: { reading: 'Reading earlier subagents…', failed: "Couldn't read earlier subagents.", empty: 'No subagents ran in this session.', how: 'Claude starts them with the Agent tool.' },
  workflows: { reading: 'Reading earlier workflows…', failed: "Couldn't read earlier workflows.", empty: 'No workflows ran in this session.', how: 'Claude starts them with the Workflow tool.' }
}

/** Reads the session's runs when the list opens, and again after each turn, which may have launched or ended some. */
function useRuns(handleId: string): { complete: boolean; failed: boolean; reading: boolean } {
  const sessionId = useActive((s) => s?.sessionId ?? null)
  const busy = useActive((s) => !!s?.busy)
  const status = useActive((s) => s?.runs.status ?? 'idle')
  const hasData = useActive((s) => !!s?.runs.data)
  const complete = useActive((s) => !!s && knownRuns(s))
  const opened = useRef(false)
  useEffect(() => {
    if (busy && opened.current) return
    opened.current = true
    loadRuns(handleId)
  }, [handleId, sessionId, busy])
  return { complete, failed: status === 'error', reading: status === 'loading' && !hasData }
}

/** The line over a list, the column head, and what shows around the rows while history loads or fails. */
function ListFrame({ kind, handleId, rows, total, running, cols, children }: { kind: Kind; handleId: string; rows: number; total: number; running: number; cols: ReactNode; children: ReactNode }): JSX.Element {
  const { complete, failed, reading } = useRuns(handleId)
  const skeleton = useDelayedFlag(reading)
  const copy = COPY[kind]
  const lead = running ? `${running} running · ` : ''
  const empty = complete && !failed && !rows
  const summary = empty ? '' : failed ? `${lead}${total} shown` : complete ? `${lead}${total} in this session` : ''
  const body = useRef<HTMLDivElement>(null)
  return (
    <div data-ui={`${kind}-list`} className="flex min-h-0 flex-1 flex-col bg-bg">
      <div className="shrink-0 pt-(--top-h)">
        <p className="flex h-8 items-center px-4 text-meta text-dim">{summary}</p>
      </div>
      <div ref={body} data-beside-header="" className="@container min-h-0 flex-1 overflow-y-auto pb-6">
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
            <p className="text-ui text-dim">{copy.empty}</p>
            <p className="text-meta text-dim">{copy.how}</p>
          </div>
        ) : (
          <>
            {(rows > 0 || skeleton) && (
              <div aria-hidden="true" className="sticky top-0 z-10 flex h-6 items-center justify-end gap-3 bg-bg pr-4 text-caps uppercase text-faint">
                {cols}
                <span className={TIME}>Time</span>
                <span className={TOKENS}>Tokens</span>
              </div>
            )}
            {children}
            {skeleton && (
              <div aria-hidden="true">
                {SKELETON.map((w) => (
                  <div key={w} className="flex h-8 items-center px-4">
                    <div className={`h-3 rounded bg-bg-raised ${w}`} />
                  </div>
                ))}
              </div>
            )}
            <p aria-live="polite" className={skeleton ? 'px-4 pt-2 text-meta text-dim' : 'sr-only'}>
              {skeleton ? copy.reading : ''}
            </p>
            {failed && (
              <div role="alert" className="flex items-center gap-3 px-4 pt-2">
                <p className="text-ui text-content">{copy.failed}</p>
                <Button variant="ghost" size="sm" onClick={() => {
                    // The alert unmounts while the read runs, so focus moves off it first.
                    if (!focusStop(body.current)) focusPaneTitle()
                    loadRuns(handleId)
                  }}
                >
                  Try again
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

interface Flat {
  row: AgentListRow
  level: number
  parent: string | null
  setsize: number
  posinset: number
}

const inside = (r: AgentListRow): number => r.children.reduce((n, c) => n + 1 + inside(c), 0)
const countAll = (rows: readonly AgentListRow[]): number => rows.reduce((n, r) => n + 1 + inside(r), 0)

let agentTools: ToolCall[] = []
let agentToolsSig = ''
/** Main's Agent calls, the same array while none changed, so streamed text doesn't rebuild the tree. The store ends a
 *  call by writing its result onto the same object, so a call's outcome is part of the comparison, not just its identity. */
function agentToolsOf(messages: readonly ChatMessage[]): ToolCall[] {
  const next = messages.flatMap((m) => m.tools.filter((t) => isAgentTool(t.name)))
  const sig = next.map((t) => `${t.id}:${t.result !== undefined}:${!!t.isError}:${!!t.stopped}:${!!t.sentToBackground}`).join(' ')
  if (sig === agentToolsSig) return agentTools
  agentToolsSig = sig
  return (agentTools = next)
}

function agentName(r: AgentListRow, n: number): string {
  const { state, durationMs } = r.status
  const time = !isLive(state) && durationMs !== undefined ? `, ${formatElapsed(durationMs)}` : ''
  const tokens = r.tokens !== undefined ? `, ${fmtTokens(r.tokens)} tokens` : ''
  return `${r.label}, ${r.type ? `${r.type} agent` : 'agent'}, ${RUN_WORDS[state].spoken}${time}${tokens}${n ? `, ${n} ${n === 1 ? 'subagent' : 'subagents'} inside` : ''}`
}

/** Moves focus to the row a list keeps as its one tab stop, and returns whether there was one. */
function focusStop(root: HTMLElement | null): boolean {
  const el = root?.querySelector<HTMLElement>('[tabindex="0"]')
  el?.focus()
  return !!el
}

export function AgentsList({ handleId }: { handleId: string }): JSX.Element {
  // What the rows read, minus streamed text: a subagent's own tool calls aren't Agent launches.
  const deps = useActive(
    useShallow((s) =>
      s ? [agentToolsOf(s.messages), s.backgroundTasks, s.subagentChildren, s.nestedLaunches, s.agentMetas, s.agentUsage, s.runs.data, s.pendingPermissions, s.workflows, s.busy, s.interrupting] : []
    )
  )
  const tree = useMemo(() => {
    const s = activeSlice(useSession.getState())
    return s ? agentRows(s, s.runs.data?.agents ?? null) : []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  const running = useActive((s) => (s ? runningAgents(s, s.runs.data?.agents ?? null) : 0))
  const activity = useActive((s) => s?.agentActivity ?? NO_ACTIVITY)
  const lineIds = useId()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [focusId, setFocusId] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  const rows: Flat[] = []
  const walk = (list: readonly AgentListRow[], level: number, parent: string | null): void =>
    list.forEach((row, i) => {
      rows.push({ row, level, parent, setsize: list.length, posinset: i + 1 })
      if (expanded.has(row.id)) walk(row.children, level + 1, row.id)
    })
  walk(tree, 1, null)
  const stop = rows.some((r) => r.row.id === focusId) ? focusId : (rows[0]?.row.id ?? null)

  const some = rows.length > 0
  useEffect(() => {
    if (some && takeSurfaceFocus('agents')) focusStop(ref.current)
  }, [some])

  const focusRow = (id: string): void => {
    setFocusId(id)
    ref.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`)?.focus()
  }
  const setOpen = (ids: readonly string[], on: boolean): void =>
    setExpanded((cur) => {
      const next = new Set(cur)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })
  const open = (r: AgentListRow): void => {
    useSession.getState().openAgentTab(handleId, { by: 'tool', id: r.id }, { title: r.label, trail: r.trail })
    requestAnimationFrame(focusPaneTitle)
  }
  const onKey = (e: KeyboardEvent, f: Flat, i: number): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const go = (to: Flat | undefined): void => {
      e.preventDefault()
      if (to) focusRow(to.row.id)
    }
    const parent = (): Flat | undefined => rows.find((x) => x.row.id === f.parent)
    const has = f.row.children.length > 0
    const on = expanded.has(f.row.id)
    switch (e.key) {
      case 'ArrowDown':
        return go(rows[i + 1])
      case 'ArrowUp':
        return go(rows[i - 1])
      case 'Home':
        return go(rows[0])
      case 'End':
        return go(rows[rows.length - 1])
      case 'ArrowRight':
        if (!has) return go(undefined)
        if (!on) {
          e.preventDefault()
          return setOpen([f.row.id], true)
        }
        return go(rows[i + 1])
      case 'ArrowLeft':
        if (has && on) {
          e.preventDefault()
          return setOpen([f.row.id], false)
        }
        return go(parent())
      case '*':
        e.preventDefault()
        return setOpen(
          rows.filter((x) => x.parent === f.parent && x.row.children.length).map((x) => x.row.id),
          true
        )
      case 'Enter':
      case ' ':
        e.preventDefault()
        return open(f.row)
    }
  }

  return (
    <ListFrame kind="agents" handleId={handleId} rows={rows.length} total={countAll(tree)} running={running} cols={null}>
      {some && (
        <div ref={ref} role="tree" aria-label="Subagents">
          {rows.map((f, i) => {
            const { row: r, level } = f
            const n = r.children.length ? inside(r) : 0
            const on = expanded.has(r.id)
            const { state, startMs, durationMs, reason } = r.status
            // Main's own launches hold the slot from launch; a nested one may never report a step, so it waits for one.
            const line = activityLine(state, activity[r.id], level === 1)
            const lineId = `${lineIds}${r.id}`
            return (
              <div
                key={r.id}
                data-row={r.id}
                role="treeitem"
                aria-level={level}
                aria-setsize={f.setsize}
                aria-posinset={f.posinset}
                aria-expanded={n ? on : undefined}
                aria-label={agentName(r, n)}
                aria-describedby={line ? lineId : undefined}
                title={reason ? REASON_COPY[reason] : line && line !== STARTING ? line : undefined}
                tabIndex={stop === r.id ? 0 : -1}
                {...(stop === r.id ? { 'data-pane-title': '' } : {})}
                onFocus={() => setFocusId(r.id)}
                onKeyDown={(e) => onKey(e, f, i)}
                onClick={() => open(r)}
                style={{ paddingLeft: 16 + 20 * (level - 1) }}
                className={`flex flex-col ${ROW_BOX}`}
              >
                <div className="flex h-8 items-center gap-2">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center">
                    {n > 0 && (
                      <button
                        type="button"
                        data-ui="row-disclose"
                        tabIndex={-1}
                        aria-hidden="true"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => {
                          e.stopPropagation()
                          setFocusId(r.id)
                          setOpen([r.id], !on)
                        }}
                        className="flex h-6 w-6 items-center justify-center rounded text-faint pointer-fine:hover:text-content"
                      >
                        <IconChevron className={`h-4 w-4 transition-transform [transition-duration:var(--dur-fast)] [transition-timing-function:var(--ease-out)] motion-reduce:transition-none ${on ? 'rotate-90' : ''}`} />
                      </button>
                    )}
                  </span>
                  <span aria-hidden="true" className="flex shrink-0 items-center gap-1 text-content">
                    <AgentFace face={r.face} className="h-4 w-4" />
                    <RunMark state={state} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-label text-content">{r.label}</span>
                  {r.type && <span className="shrink-0 rounded bg-bg-raised px-1.5 py-0.5 font-mono text-badge text-faint @max-[520px]:hidden">{r.type}</span>}
                  <span className="w-[8ch] shrink-0 text-right text-meta text-faint">{n > 0 && !on ? `${n} inside` : ''}</span>
                  <Figures
                    time={isLive(state) ? (startMs !== undefined ? <RunningTimer startMs={startMs} /> : <Dash />) : durationMs !== undefined ? formatElapsed(durationMs) : <Dash agent />}
                    tokens={r.tokens !== undefined ? fmtTokens(r.tokens) : isLive(state) ? <Dash /> : <Dash agent />}
                  />
                </div>
                {line && (
                  <div id={lineId} aria-hidden="true" data-ui="agent-activity" className="-mt-1 mb-1 flex h-4 items-center text-meta text-dim">
                    <span className="w-[72px] shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{line}</span>
                    <span className={`ml-2 ${FIGURES}`}>
                      <span className={TIME} />
                      <span className={TOKENS} />
                    </span>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </ListFrame>
  )
}

export function WorkflowsList({ handleId }: { handleId: string }): JSX.Element {
  const workflows = useActive((s) => s?.workflows ?? null)
  const disk = useActive((s) => s?.runs.data?.workflows ?? null)
  const pending = useActive((s) => s?.pendingPermissions ?? EMPTY_PENDING)
  const rows = useMemo(() => (workflows ? workflowRows({ workflows }, disk).map((w) => ({ w, sum: workflowSummary(w, pending) })) : []), [workflows, disk, pending])
  const [focusId, setFocusId] = useState<string | null>(null)
  const ref = useRef<HTMLUListElement>(null)
  const stop = rows.some((r) => r.w.taskId === focusId) ? focusId : (rows[0]?.w.taskId ?? null)

  const some = rows.length > 0
  useEffect(() => {
    if (some && takeSurfaceFocus('workflows')) focusStop(ref.current)
  }, [some])

  const onKey = (e: KeyboardEvent, i: number): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: rows.length - 1 }[e.key]
    if (to === undefined) return
    e.preventDefault()
    const id = rows[to]?.w.taskId
    if (!id) return
    setFocusId(id)
    ref.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`)?.focus()
  }

  return (
    <ListFrame
      kind="workflows"
      handleId={handleId}
      rows={rows.length}
      total={rows.length}
      running={rows.filter((r) => isLive(r.sum.state.state)).length}
      cols={<span className="w-[7ch] text-right">Agents</span>}
    >
      {some && (
        <ul ref={ref} role="list" aria-label="Workflows">
          {rows.map(({ w, sum }, i) => {
            const { state, startMs, durationMs, reason } = sum.state
            const live = isLive(state)
            const time = !live && durationMs !== undefined ? `, ${formatElapsed(durationMs)}` : ''
            const tokens = sum.tokens !== undefined ? `, ${fmtTokens(sum.tokens)} tokens` : ''
            return (
              <li key={w.taskId}>
                <button
                  type="button"
                  data-row={w.taskId}
                  aria-label={`${w.name}, workflow, ${RUN_WORDS[state].spoken}, ${sum.done} of ${sum.total} agents done${time}${tokens}`}
                  title={reason ? REASON_COPY[reason] : undefined}
                  tabIndex={stop === w.taskId ? 0 : -1}
                  {...(stop === w.taskId ? { 'data-pane-title': '' } : {})}
                  onFocus={() => setFocusId(w.taskId)}
                  onKeyDown={(e) => onKey(e, i)}
                  onClick={() => {
                    useSession.getState().openWorkflowTab(handleId, w.taskId, w.name)
                    requestAnimationFrame(focusPaneTitle)
                  }}
                  className={`${ROW} pl-4`}
                >
                  <span aria-hidden="true" className="flex shrink-0 items-center gap-1 text-content">
                    <IconWorkflow className="h-4 w-4" />
                    <RunMark state={state} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-label text-content">{w.name}</span>
                  <span className="w-[7ch] shrink-0 text-right font-mono text-meta tabular-nums text-dim">
                    {sum.done} of {sum.total}
                  </span>
                  <Figures
                    time={live && startMs !== undefined ? <RunningTimer startMs={startMs} /> : durationMs !== undefined ? formatElapsed(durationMs) : <Dash />}
                    tokens={sum.tokens !== undefined ? fmtTokens(sum.tokens) : <Dash />}
                  />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </ListFrame>
  )
}
