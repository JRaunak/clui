/** A workflow's tab: its phases and their agents as a tree, each agent opening its own tab, and the run's result. */
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { EMPTY_PENDING, loadWorkflowRun, useActive, useSession, type PendingPermission, type WorkflowAgent, type WorkflowState } from '../store'
import type { SurfaceTab } from '../../../shared/surfaces'
import { isLive, REASON_COPY, RUN_WORDS, workflowAgentStatus, workflowFaces, type RunState, type RunStatusOf } from '../lib/agents'
import { phaseState, workflowSummary } from '../lib/workflow'
import { formatElapsed } from '../lib/turnEnd'
import { focusPaneTitle } from '../lib/dive'
import { useDelayedFlag } from '../lib/useDelayedFlag'
import { findRanges, useFind } from './surfaces/fileDoc'
import { revealAcross } from '../lib/useTranscriptFind'
import { RunAnnounce, Sep, StopControl } from './AgentTab'
import { usePane } from './Stage'
import { Button } from './Button'
import { FindField } from './FindField'
import { InfoRow } from './InfoRow'
import { Markdown } from './Markdown'
import { RunMark, RunStatus } from './RunMark'
import { RunningTimer } from './InstrumentRow'
import { AgentFace } from './faces'
import { IconChevron, IconWorkflow } from './Icon'

const SPOKEN: Partial<Record<RunState, string>> = { done: 'Workflow finished', failed: 'Workflow failed', stopped: 'Workflow stopped' }
export const FIGURES = 'flex shrink-0 gap-3 font-mono text-meta tabular-nums text-dim'
export const TIME = 'w-[7ch] text-right'
const SKELETON = ['w-[60%]', 'w-[48%]', 'w-[52%]', 'w-[40%]']
const FIND_SKIP = '.sr-only, [data-find-skip]'

interface AgentRow {
  agent: WorkflowAgent
  status: RunStatusOf
}
interface Phase {
  index: number
  title: string
  state: RunState
  agents: AgentRow[]
  done: AgentRow[]
}
type Row = { id: string; kind: 'phase'; phase: Phase } | ({ id: string; kind: 'agent'; phase: number } & AgentRow)

const rowId = (a: WorkflowAgent): string => `a${a.phaseIndex}-${a.index}`

/** The tree's phases, with any phase an agent names that the snapshot didn't list yet. */
function phasesOf(w: WorkflowState, pending: readonly PendingPermission[], workflow: RunState): Phase[] {
  const listed = new Map(w.phases.map((p) => [p.index, p.title]))
  for (const a of w.agents) if (!listed.has(a.phaseIndex)) listed.set(a.phaseIndex, `Phase ${a.phaseIndex}`)
  const rows = w.agents.map((agent): AgentRow => ({ agent, status: workflowAgentStatus(agent, w.endedStatus, pending) }))
  return [...listed]
    .sort(([a], [b]) => a - b)
    .map(([index, title]) => {
      const agents = rows.filter((r) => r.agent.phaseIndex === index).sort((a, b) => a.agent.index - b.agent.index)
      return { index, title, state: phaseState(agents.map((r) => r.status.state), workflow), agents, done: agents.filter((r) => r.status.state === 'done') }
    })
}

const durationOf = (rows: AgentRow[]): number | undefined =>
  rows.reduce<number | undefined>((n, r) => (r.agent.durationMs === undefined ? n : (n ?? 0) + r.agent.durationMs), undefined)

export function Dash({ agent }: { agent?: boolean }): JSX.Element {
  return (
    <span className="text-faint" title={agent ? 'Not recorded for this agent' : undefined}>
      -
    </span>
  )
}

export function Figures({ time }: { time: ReactNode }): JSX.Element {
  return (
    <span className={FIGURES}>
      <span className={TIME}>{time}</span>
    </span>
  )
}

function agentName({ agent, status }: AgentRow): string {
  const done = status.state === 'done'
  const time = done && agent.durationMs !== undefined ? `, ${formatElapsed(agent.durationMs)}` : ''
  const unstarted = !agent.agentId && status.state !== 'unrun' && status.state !== 'queued' ? ', not started' : ''
  return `${agent.label}, ${agent.agentType ? `${agent.agentType} agent` : 'agent'}, ${RUN_WORDS[status.state].spoken}${time}${unstarted}`
}

/** The run's result, six lines until asked for the rest. */
function Result({ text, open, onToggle }: { text: string; open: boolean; onToggle: () => void }): JSX.Element {
  const body = useRef<HTMLDivElement>(null)
  const [over, setOver] = useState(false)
  useLayoutEffect(() => {
    const el = body.current
    if (el && !open) setOver(el.scrollHeight > el.clientHeight + 1)
  }, [text, open])
  return (
    <>
      <div
        ref={body}
        data-find="result"
        className={`text-sm leading-relaxed ${open ? '' : 'max-h-[6lh] overflow-hidden'} ${over && !open ? '[mask-image:linear-gradient(to_bottom,#000_calc(100%-1lh),transparent)]' : ''}`}
      >
        <Markdown text={text} />
      </div>
      {(over || open) && (
        <Button data-find-skip="" variant="ghost" size="sm" className="mt-1" aria-expanded={open} onClick={onToggle}>
          {open ? 'Show less' : 'Show full result'}
        </Button>
      )}
    </>
  )
}

export function WorkflowTab({ handleId, tab }: { handleId: string; tab: SurfaceTab }): JSX.Element {
  const pane = usePane()
  const workflow = useActive((s) => s?.workflows[tab.key] ?? null)
  const read = useActive((s) => s?.workflowReads[tab.key] ?? null)
  const sessionId = useActive((s) => s?.sessionId ?? null)
  const pending = useActive((s) => s?.pendingPermissions ?? EMPTY_PENDING)
  const ended = !!workflow && workflow.endedStatus !== null
  useEffect(() => loadWorkflowRun(handleId, tab.key), [handleId, tab.key, sessionId, ended])
  const sum = useMemo(() => (workflow ? workflowSummary(workflow, pending) : null), [workflow, pending])
  const phases = useMemo(() => (workflow && sum ? phasesOf(workflow, pending, sum.state.state) : []), [workflow, pending, sum])
  const faces = useMemo(() => (workflow ? workflowFaces(workflow) : null), [workflow])
  const view = workflow ? 'ready' : read === 'error' ? 'error' : read === 'gone' ? 'gone' : 'loading'
  const skeleton = useDelayedFlag(view === 'loading')

  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set())
  const [focusId, setFocusId] = useState<string | null>(null)
  const [resultOpen, setResultOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const treeRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  const rows = phases.flatMap((p): Row[] => [
    { id: `p${p.index}`, kind: 'phase', phase: p },
    ...(collapsed.has(p.index) ? [] : p.agents.map((r): Row => ({ id: rowId(r.agent), kind: 'agent', phase: p.index, ...r })))
  ])
  const stop = rows.some((r) => r.id === focusId) ? focusId : (rows[0]?.id ?? null)
  const focusRow = (id: string): void => {
    setFocusId(id)
    treeRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`)?.focus()
  }
  const toggle = (index: number): void =>
    setCollapsed((c) => {
      const next = new Set(c)
      if (!next.delete(index)) next.add(index)
      return next
    })
  const open = (a: WorkflowAgent): void => {
    if (!a.agentId) return
    useSession.getState().openAgentTab(handleId, { by: 'agent', id: a.agentId }, { title: a.label, trail: [tab.id] })
    requestAnimationFrame(focusPaneTitle)
  }
  const onKey = (e: KeyboardEvent, r: Row, i: number): void => {
    const go = (to: Row | undefined): void => {
      e.preventDefault()
      if (to) focusRow(to.id)
    }
    if (e.key === 'ArrowDown') return go(rows[i + 1])
    if (e.key === 'ArrowUp') return go(rows[i - 1])
    if (e.key === 'Home') return go(rows[0])
    if (e.key === 'End') return go(rows[rows.length - 1])
    if (e.key === 'ArrowRight' && r.kind === 'phase') {
      if (collapsed.has(r.phase.index)) {
        e.preventDefault()
        return toggle(r.phase.index)
      }
      return go(rows[i + 1]?.kind === 'agent' ? rows[i + 1] : undefined)
    }
    if (e.key === 'ArrowLeft') {
      if (r.kind === 'agent') return go(rows.find((x) => x.kind === 'phase' && x.phase.index === r.phase))
      e.preventDefault()
      if (!collapsed.has(r.phase.index)) toggle(r.phase.index)
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (r.kind === 'phase') toggle(r.phase.index)
      else open(r.agent)
    }
  }

  // Find: the match unit is a row (a phase, an agent, or the result), searched in the data so a collapsed phase or
  // a clamped result still counts; the shown text is then marked as transcript find marks it.
  const [findOpen, setFindOpen] = useState(false)
  const origin = useRef<HTMLElement | null>(null)
  const reveal = useRef(false)
  const { query, setQuery, deferred, current, setCurrent, input } = useFind(
    findOpen,
    (on) => {
      if (on) origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setFindOpen(on)
    },
    () => !!workflow,
    (by) => step(by)
  )
  const resultText = workflow?.result ?? ''
  const q = findOpen ? deferred.trim().toLowerCase() : ''
  const matches = useMemo(() => {
    if (!q) return []
    const units = phases.flatMap((p) => [{ id: `p${p.index}`, phase: p.index, text: p.title }, ...p.agents.map((r) => ({ id: rowId(r.agent), phase: p.index, text: r.agent.label }))])
    if (ended && resultText) units.push({ id: 'result', phase: -1, text: resultText })
    return units.filter((u) => u.text.toLowerCase().includes(q))
  }, [q, phases, ended, resultText])
  const hit = matches[Math.min(current, matches.length - 1)]
  function step(by: number): void {
    const n = matches.length
    if (!n) return
    reveal.current = true
    setCurrent((c) => (((c + by) % n) + n) % n)
  }
  const hitId = hit?.id
  const hitPhase = hit?.phase
  useEffect(() => {
    if (hitId === 'result') setResultOpen(true)
    else if (hitId?.startsWith('a')) setCollapsed((c) => (hitPhase !== undefined && c.has(hitPhase) ? new Set([...c].filter((x) => x !== hitPhase)) : c))
  }, [hitId, hitPhase])
  const searched = useRef('')
  const shifted = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const root = bodyRef.current
    if (searched.current !== q) reveal.current = true
    searched.current = q
    if (!q || !root) return revealAcross(shifted, undefined, root)
    const ranges: Range[] = []
    let active: Range[] = []
    for (const m of matches) {
      const el = root.querySelector<HTMLElement>(`[data-find="${CSS.escape(m.id)}"]`)
      if (!el) continue
      const found = findRanges(el, deferred.trim(), FIND_SKIP).ranges
      ranges.push(...found)
      if (m === hit) {
        active = found
        // A hit in a collapsed phase or clamped result is revealed once its row is in the DOM.
        if (reveal.current) {
          el.scrollIntoView({ block: 'nearest' })
          revealAcross(shifted, found[0], root)
        }
        reveal.current = false
      }
    }
    CSS.highlights.set('transcript-find', new Highlight(...ranges))
    const a = new Highlight(...active)
    a.priority = 1
    CSS.highlights.set('transcript-find-active', a)
    return () => {
      CSS.highlights.delete('transcript-find')
      CSS.highlights.delete('transcript-find-active')
    }
  })
  const closeFind = (): void => {
    setQuery('')
    setFindOpen(false)
    const back = origin.current
    requestAnimationFrame(() => (back?.isConnected ? back : treeRef.current?.querySelector<HTMLElement>('[tabindex="0"]'))?.focus())
  }
  const of = hit ? `${matches.indexOf(hit) + 1} of ${matches.length}` : ''

  const name = workflow?.name ?? tab.title
  const failedEnd = sum?.state.state === 'failed'
  return (
    <div data-ui="workflow-tab" className="flex min-h-0 flex-1 flex-col bg-bg">
      <RunAnnounce state={sum?.state.state ?? 'queued'} spoken={SPOKEN} />
      <InfoRow
        ui="workflow-info"
        scrolled={scrolled}
        lead={<IconWorkflow className="h-4 w-4" />}
        line1={
          <span className="min-w-0 flex-1 truncate text-ui font-semibold text-content" title={workflow?.description ? `${name}\n${workflow.description}` : name}>
            {name}
          </span>
        }
        line2={
          sum && (
            <>
              <RunStatus {...sum.state} />
              {sum.state.state === 'needs' && (
                <>
                  <Sep />
                  <button type="button" onClick={pane.resolveNeedsYou} className="py-1 text-content underline decoration-faint underline-offset-2">
                    Show request
                  </button>
                </>
              )}
              <Sep />
              <span>
                {sum.done} of {sum.total} agents done
              </span>
              {sum.failed > 0 && (
                <>
                  <Sep />
                  <span className="text-content">{sum.failed} failed</span>
                </>
              )}
              {sum.stopped > 0 && (
                <>
                  <Sep />
                  <span>{sum.stopped} stopped</span>
                </>
              )}
              <StopControl handleId={handleId} tab={tab} />
            </>
          )
        }
      />
      {findOpen && (
        <div className="shrink-0 px-4 pb-2">
          <FindField
            ui="workflow-find"
            inputRef={input}
            value={query}
            onChange={setQuery}
            onEnter={(shift) => step(shift ? -1 : 1)}
            onClose={closeFind}
            onPrev={() => step(-1)}
            onNext={() => step(1)}
            stepDisabled={!matches.length}
            countText={!deferred ? '' : hit ? of : 'No matches'}
            statusText={!deferred ? '' : hit ? `Match ${of} rows` : 'No matches'}
            placeholder="Find in workflow"
            label="Find in workflow"
          />
        </div>
      )}
      <div data-beside-header="" ref={bodyRef} onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)} className="@container min-h-0 flex-1 overflow-y-auto pb-6">
        {view === 'error' ? (
          <div role="alert" className="flex flex-col items-start gap-1 px-4 pt-2">
            <p className="text-ui text-content">Couldn&apos;t read this workflow&apos;s record.</p>
            <p className="text-meta text-dim">The file may have moved or been cleared.</p>
            <Button variant="control" size="sm" className="mt-2" onClick={() => loadWorkflowRun(handleId, tab.key)}>
              Try again
            </Button>
          </div>
        ) : view === 'gone' ? (
          <p className="px-4 pt-2 text-ui text-dim">This workflow&apos;s record isn&apos;t on disk anymore.</p>
        ) : (
          <>
            {view === 'loading' ? (
              skeleton && (
                <div aria-hidden="true">
                  {SKELETON.map((w, i) => (
                    <div key={w} className={`flex h-8 items-center ${i ? 'pl-10 pr-4' : 'px-4'}`}>
                      <div className={`h-3 rounded bg-bg-raised ${w}`} />
                    </div>
                  ))}
                </div>
              )
            ) : (
              <div ref={treeRef} role="tree" aria-label="Phases">
                {rows.map((r, i) => {
                  if (r.kind === 'phase') {
                    const p = r.phase
                    const expanded = !collapsed.has(p.index)
                    const running = p.agents.some((a) => isLive(a.status.state))
                    const empty = ended ? 'No agents ran in this phase' : 'No agents yet'
                    const time = durationOf(p.done)
                    return (
                      <Fragment key={r.id}>
                        <div
                          data-row={r.id}
                          role="treeitem"
                          aria-level={1}
                          aria-expanded={expanded}
                          aria-label={`${p.index}. ${p.title}, ${RUN_WORDS[p.state].spoken}, ${p.done.length} of ${p.agents.length} agents done${p.agents.length ? '' : `, ${empty.toLowerCase()}`}`}
                          tabIndex={stop === r.id ? 0 : -1}
                          onFocus={() => setFocusId(r.id)}
                          onKeyDown={(e) => onKey(e, r, i)}
                          className="flex h-8 items-center gap-2 px-4 focus-visible:-outline-offset-2"
                        >
                          <button
                            type="button"
                            data-ui="row-disclose"
                            tabIndex={-1}
                            aria-hidden="true"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              if (expanded) setFocusId(r.id)
                              toggle(p.index)
                            }}
                            className="-ml-2 flex h-6 w-6 shrink-0 items-center justify-center rounded text-faint pointer-fine:hover:text-content"
                          >
                            <IconChevron className={`h-4 w-4 transition-transform [transition-duration:var(--dur-fast)] [transition-timing-function:var(--ease-out)] ${expanded ? 'rotate-90' : ''}`} />
                          </button>
                          <RunMark state={p.state} />
                          <span className="w-3 shrink-0 font-mono text-meta tabular-nums text-faint">{p.index}</span>
                          <span data-find={r.id} className="min-w-0 flex-1 truncate text-label font-medium text-content">
                            {p.title}
                          </span>
                          {running ? (
                            <Figures time={<span className="text-faint">…</span>} />
                          ) : (
                            <Figures time={time !== undefined ? formatElapsed(time) : <Dash />} />
                          )}
                        </div>
                        {expanded && !p.agents.length && (
                          <div aria-hidden="true" className="flex h-8 items-center pl-10 text-meta text-dim">
                            {empty}
                          </div>
                        )}
                      </Fragment>
                    )
                  }
                  const { agent: a, status } = r
                  const done = status.state === 'done'
                  const face = a.agentId ? (faces?.get(a.agentId) ?? null) : null
                  return (
                    <div
                      key={r.id}
                      data-row={r.id}
                      role="treeitem"
                      aria-level={2}
                      aria-disabled={a.agentId ? undefined : true}
                      aria-label={agentName(r)}
                      title={status.state === 'unrun' ? 'Its workflow ended before this agent started' : status.reason ? REASON_COPY[status.reason] : undefined}
                      tabIndex={stop === r.id ? 0 : -1}
                      onFocus={() => setFocusId(r.id)}
                      onKeyDown={(e) => onKey(e, r, i)}
                      onClick={() => open(a)}
                      className={`flex h-8 items-center gap-2 rounded-md pl-10 pr-4 focus-visible:-outline-offset-2 ${a.agentId ? 'cursor-default pointer-fine:hover:bg-[var(--glass-row-hover)]' : ''}`}
                    >
                      <span aria-hidden="true" className="flex shrink-0 items-center gap-1 text-content">
                        <AgentFace face={face} className="h-4 w-4" />
                        <RunMark state={status.state} />
                      </span>
                      <span data-find={r.id} className={`min-w-0 flex-1 truncate text-label ${status.state === 'queued' || status.state === 'unrun' ? 'text-dim' : 'text-content'}`}>
                        {a.label}
                      </span>
                      {a.agentType && <span className="shrink-0 rounded bg-bg-raised px-1.5 py-0.5 font-mono text-badge text-faint @max-[420px]:hidden">{a.agentType}</span>}
                      <Figures
                        time={done && a.durationMs !== undefined ? formatElapsed(a.durationMs) : isLive(status.state) && status.startMs !== undefined ? <RunningTimer startMs={status.startMs} /> : <Dash agent />}
                      />
                    </div>
                  )
                })}
              </div>
            )}
            {ended && (resultText || failedEnd) && (
              <section className="mt-4 px-4">
                <h3 className="text-label font-semibold text-content">Result</h3>
                {resultText ? (
                  <Result text={resultText} open={resultOpen} onToggle={() => setResultOpen((o) => !o)} />
                ) : (
                  <p className="text-ui text-dim">The workflow failed before it wrote a result.</p>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}
