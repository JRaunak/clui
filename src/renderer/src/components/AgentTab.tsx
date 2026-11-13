/** Agent tabs. An agent's transcript renders through one path whether it streams live or comes back from
 *  disk, under a pinned info row that names it, its ancestors and its state. */
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { ensureAgentData, noteAgentRead, useActive, useSession, EMPTY_NESTED_SUBAGENTS, EMPTY_SUBAGENT_MSGS, type NestedSubagent, type SubagentMessage, type ToolCall } from '../store'
import { agentKey, agentRefOf, type AgentRef, type SurfaceTab } from '../../../shared/surfaces'
import { deriveModelInfo, effortLabel } from '../../../shared/settings'
import type { AgentMeta, TranscriptResult } from '../../../shared/sessions'
import { agentDescription, agentInfo, agentRunState, entriesOf, faceOf, isAgentTool, isLive, launcherOf, RUN_WORDS, stopTargetOf, subagentType, toolUsesOf, type RunState, type RunStatusOf, type StopTarget } from '../lib/agents'
import { useDelayedFlag } from '../lib/useDelayedFlag'
import { useSay } from '../lib/useSay'
import { useStopFocus } from '../lib/useStopFocus'
import { useTranscriptFind } from '../lib/useTranscriptFind'
import { Markdown } from './Markdown'
import { ToolGroup } from './MessageView'
import { subagentEffort } from './InstrumentRow'
import { usePane } from './Stage'
import { Button } from './Button'
import { FindField } from './FindField'
import { InfoRow } from './InfoRow'
import { RunMark, RunStatus } from './RunMark'
import { AgentFace } from './faces'
import { IconChevron, IconStop, IconWorkflow } from './Icon'
import { focusPaneTitle } from '../lib/dive'

export const Sep = (): JSX.Element => (
  <span aria-hidden="true" className="text-faint">
    ·
  </span>
)

/** The run status as one value per change, so a streamed token that changes nothing re-renders nothing. */
function useRunStatus(ref: AgentRef | null): RunStatusOf {
  const sig = useActive((s) => JSON.stringify(s && ref ? agentRunState(s, ref) : { state: 'interrupted', reason: 'no-result' }))
  return useMemo(() => JSON.parse(sig) as RunStatusOf, [sig])
}

type Phase = 'live' | 'loading' | 'ready' | 'gone' | 'error'

/**
 * An agent's entries: its live stream when one arrived, else its transcript on disk in the stream's shape. The disk
 * read also carries its model and effort (the stream has neither). It re-reads every 2s while the agent runs and
 * there's something the stream can't give yet.
 */
function useAgentEntries(handleId: string, ref: AgentRef, running: boolean) {
  const stream = useActive((s) => (ref.by === 'tool' ? (s?.subagentMessages[ref.id] ?? EMPTY_SUBAGENT_MSGS) : EMPTY_SUBAGENT_MSGS))
  const [disk, setDisk] = useState<{ entries: SubagentMessage[]; found: boolean } | null>(null)
  const [failed, setFailed] = useState(false)
  const [model, setModel] = useState<{ model?: string; effort?: string | null }>({})
  const [attempt, setAttempt] = useState(0)
  const need = useRef(true)
  need.current = !stream.length || !model.model
  const key = agentKey(ref)
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = (): void => {
      const read: Promise<TranscriptResult & { found: boolean; agentMeta?: AgentMeta | null }> =
        ref.by === 'tool' ? window.clui.readAgentTranscriptByToolUseId(ref.id) : window.clui.readAgentTranscript(ref.id)
      read
        .then(
          (r) => {
            if (cancelled) return
            setFailed(false)
            setDisk({ entries: entriesOf(r.messages), found: r.found })
            if (r.agentModel) setModel({ model: r.agentModel, effort: r.agentEffort })
            if (r.agentMeta !== undefined) noteAgentRead(handleId, ref.id, { messages: r.messages, agentMeta: r.agentMeta })
          },
          () => !cancelled && setFailed(true)
        )
        .finally(() => {
          if (!cancelled && running && need.current) timer = setTimeout(load, 2000)
        })
    }
    load()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, handleId, running, attempt])
  const phase: Phase = stream.length ? 'live' : !disk ? (failed ? 'error' : 'loading') : disk.found ? 'ready' : 'gone'
  return { entries: stream.length ? stream : (disk?.entries ?? EMPTY_SUBAGENT_MSGS), phase, model, retry: () => setAttempt((n) => n + 1) }
}

/** The tail of a running agent's transcript. Running is a neutral shape, never the accent. */
function WorkingTail({ bg, starting }: { bg: boolean; starting: boolean }): JSX.Element {
  return (
    <span data-ui="subagent-working" className="flex items-center gap-2 text-label">
      <RunMark state={bg ? 'background' : 'running'} />
      {starting ? <span className="text-dim">Starting…</span> : <span className="font-medium text-content">{bg ? 'Working in the background' : 'Working…'}</span>}
    </span>
  )
}

const SPOKEN: Partial<Record<RunState, string>> = { done: 'Subagent finished', failed: 'Subagent failed', stopped: 'Subagent stopped', needs: 'Subagent needs you' }
// Only a workflow stop ends a workflow agent, and the tab's Stop control speaks for that.
const WORKFLOW_AGENT_SPOKEN: Partial<Record<RunState, string>> = { ...SPOKEN, stopped: undefined }

/** Speaks when the viewed run stops running or starts waiting on the user, never on mount. */
export function RunAnnounce({ state, spoken = SPOKEN }: { state: RunState; spoken?: Partial<Record<RunState, string>> }): JSX.Element {
  const [text, setText] = useState('')
  const prev = useRef(state)
  useEffect(() => {
    const was = prev.current
    prev.current = state
    const say = spoken[state]
    if (say && was !== state && (state === 'needs' || (isLive(was) && !isLive(state)))) setText(say)
  }, [state])
  return (
    <span className="sr-only" role="status" aria-live="polite">
      {text}
    </span>
  )
}

function stopCopy(target: StopTarget, tab: SurfaceTab, ancestor: string): { label: string; description: string } {
  if (target.kind === 'turn') return { label: 'Stop and interrupt Claude', description: "Claude is waiting on this agent, so stopping it ends Claude's current turn." }
  if (target.kind === 'workflow')
    return tab.kind === 'workflow'
      ? { label: 'Stop workflow', description: 'Stops every agent in this workflow.' }
      : { label: 'Stop workflow', description: "Stops the whole workflow, this agent and every other one in it. A single workflow agent can't be stopped on its own." }
  if (target.ancestor) return { label: 'Stop parent agent', description: `This agent runs inside ${ancestor}. Stopping stops ${ancestor} and everything it started.` }
  return { label: 'Stop', description: "Stops this background agent. Claude's turn keeps going." }
}

/** The info row's Stop. It names what it ends before the press, and once the run ends hands focus to the active tab
 *  so it never falls to the body. Stays mounted so its announcements outlive the button. */
export function StopControl({ handleId, tab }: { handleId: string; tab: SurfaceTab }): JSX.Element {
  const sig = useActive((s) => JSON.stringify(s ? stopTargetOf(s, tab) : null))
  const target = useMemo(() => JSON.parse(sig) as StopTarget | null, [sig])
  const ancestorId = target?.kind === 'task' ? target.ancestor : undefined
  const ancestor = useActive((s) => (s && ancestorId ? (s.surfaces.tabs[ancestorId]?.title ?? agentInfo(s, ancestorId.replace(/^agent:tool:/, '')).label) : ''))
  const interrupting = useActive((s) => !!s?.interrupting)
  const stopRef = useStopFocus<HTMLButtonElement>(!!target?.stopping)
  const [said, say] = useSay()
  const pressed = useRef<StopTarget['kind'] | null>(null)
  useEffect(() => {
    const kind = pressed.current
    if (!kind) return
    // Still there and no longer stopping: the stop failed and the button is back.
    if (target) {
      if (!target.stopping) pressed.current = null
      return
    }
    if (kind === 'turn' && interrupting) return
    pressed.current = null
    if (document.activeElement === document.body) document.querySelector<HTMLElement>('[data-ui="surface-tabs"] [aria-selected="true"]')?.focus()
    if (kind === 'turn') say("Claude's turn ended")
    else if (kind === 'workflow' && tab.kind === 'agent') say('Workflow stopped')
  }, [target, interrupting, tab.kind, say])
  const copy = target && stopCopy(target, tab, ancestor)
  // A stop aimed at this tab's own run already reads Stopping in the row; one that reaches past it says what's stopping.
  const reach = target?.kind === 'task' && target.ancestor ? 'Stopping parent agent…' : target?.kind === 'workflow' && tab.kind === 'agent' ? 'Stopping workflow…' : null
  const press = (t: StopTarget): void => {
    pressed.current = t.kind
    say(t.kind === 'workflow' ? 'Stopping workflow' : 'Stopping subagent')
    void useSession.getState().stopRun(handleId, t)
  }
  return (
    <>
      <span className="sr-only" role="status" aria-live="polite">
        {said}
      </span>
      {target?.stopping ? (
        reach && (
          <span data-ui="agent-stop" className="ml-auto text-meta text-dim">
            {reach}
          </span>
        )
      ) : target && copy ? (
        <Button ref={stopRef} data-ui="agent-stop" variant="control" size="sm" className="-my-1.5 ml-auto" aria-label={copy.label} aria-description={copy.description} title={copy.description} onClick={() => press(target)}>
          <IconStop className="h-3.5 w-3.5" />
          {copy.label}
        </Button>
      ) : null}
    </>
  )
}

/** A subagent launched by the one being read: a card that opens its own tab. */
function NestedAgentCard({ child, onOpen }: { child: NestedSubagent; onOpen: () => void }): JSX.Element {
  const status = useRunStatus({ by: 'tool', id: child.childToolUseId })
  const label = child.description?.trim() || child.subagentType || 'Agent'
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2.5 rounded-md border border-border bg-tool px-3 py-2 text-left hover:border-border-strong hover:bg-bg-raised"
      onClick={onOpen}
      aria-label={`${label}, ${RUN_WORDS[status.state].spoken}, open transcript`}
      title="Open this subagent's transcript"
    >
      <span className="min-w-0 flex-1 truncate text-label text-content">{label}</span>
      {child.subagentType && <span className="shrink-0 rounded bg-bg-raised px-1.5 py-0.5 font-mono text-badge text-faint">{child.subagentType}</span>}
      <span className="ml-auto">
        <RunStatus {...status} />
      </span>
    </button>
  )
}

function SpawnedChildren({ items, onOpen }: { items: NestedSubagent[]; onOpen: (child: NestedSubagent) => void }): JSX.Element | null {
  if (!items.length) return null
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <div className="text-label font-medium text-dim">Spawned {items.length === 1 ? 'subagent' : `${items.length} subagents`}</div>
      {items.map((c) => (
        <NestedAgentCard key={c.childToolUseId} child={c} onOpen={() => onOpen(c)} />
      ))}
    </div>
  )
}

/** An agent's entries in stream order: text and thinking runs between its tool calls, each run of consecutive tool
 *  calls in one ToolGroup. */
function SubagentStream({ entries }: { entries: SubagentMessage[] }): JSX.Element {
  const out: JSX.Element[] = []
  let i = 0
  while (i < entries.length) {
    const e = entries[i]
    if (e.kind === 'tool') {
      const run: ToolCall[] = []
      while (i < entries.length) {
        const t = entries[i]
        if (t.kind !== 'tool') break
        run.push(t.tool)
        i++
      }
      out.push(
        <div key={`t${i}`} className="flex flex-col gap-1.5">
          <ToolGroup tools={run} />
        </div>
      )
      continue
    }
    out.push(
      <div key={`m${i}`}>
        <div className="mb-1.5 flex items-center gap-1.5 text-label font-semibold text-dim">
          {e.role === 'user' ? (
            <span className="text-dim">Prompt</span>
          ) : (
            <span className="flex items-center gap-1.5 text-content">
              <span className="h-1.5 w-1.5 rounded-full bg-dim" aria-hidden="true" />
              Agent
            </span>
          )}
          {e.kind === 'thinking' && <span className="text-faint">· thinking</span>}
        </div>
        {e.kind === 'thinking' ? (
          <div className="border-l-2 border-border pl-3 text-label italic text-dim [&_*]:text-dim">
            <Markdown text={e.text} />
          </div>
        ) : (
          <Markdown text={e.text} />
        )}
      </div>
    )
    i++
  }
  return <>{out}</>
}

/** The children an agent launched: its live record, else the Agent calls its transcript holds. */
function childrenFrom(live: NestedSubagent[], entries: SubagentMessage[]): NestedSubagent[] {
  if (live.length) return live
  return entries.flatMap((e) =>
    e.kind === 'tool' && isAgentTool(e.tool.name)
      ? [{ childToolUseId: e.tool.id, name: e.tool.name, description: agentDescription(e.tool.input), subagentType: subagentType(e.tool.input) ?? undefined }]
      : []
  )
}

/** A transcript's body in every state: live, loading, unreadable, gone, empty. */
function TranscriptBody({
  bodyRef,
  onScrolled,
  entries,
  phase,
  status,
  children,
  onRetry,
  onOpenChild
}: {
  bodyRef: RefObject<HTMLDivElement>
  onScrolled: (on: boolean) => void
  entries: SubagentMessage[]
  phase: Phase
  status: RunStatusOf
  children: NestedSubagent[]
  onRetry: () => void
  onOpenChild: (child: NestedSubagent) => void
}): JSX.Element {
  const live = isLive(status.state)
  const skeleton = useDelayedFlag(phase === 'loading' && !live)
  let body: JSX.Element | null
  if (phase === 'error') {
    body = (
      <div role="alert" className="flex flex-col items-start gap-1">
        <p className="text-ui text-content">Couldn&apos;t read this agent&apos;s transcript.</p>
        <p className="text-meta text-dim">The file may have moved or been cleared.</p>
        <Button data-find-skip="" variant="control" size="sm" className="mt-2" onClick={onRetry}>
          Try again
        </Button>
      </div>
    )
  } else if (!entries.length && live) {
    body = <WorkingTail bg={status.state === 'background'} starting />
  } else if (phase === 'loading') {
    body = skeleton ? (
      <div className="flex flex-col gap-2" aria-hidden="true">
        <div className="h-8 rounded bg-bg-raised" />
        <div className="h-4 w-[92%] rounded bg-bg-raised" />
        <div className="h-4 w-[76%] rounded bg-bg-raised" />
        <div className="h-4 w-[54%] rounded bg-bg-raised" />
      </div>
    ) : null
  } else if (phase === 'gone') {
    body = <p className="text-ui text-dim">This agent&apos;s transcript isn&apos;t on disk anymore.</p>
  } else if (!entries.length && !children.length) {
    body = <p className="text-ui text-dim">This agent finished without writing anything.</p>
  } else {
    body = (
      <>
        <SubagentStream entries={entries} />
        {live && <WorkingTail bg={status.state === 'background'} starting={false} />}
        <SpawnedChildren items={children} onOpen={onOpenChild} />
      </>
    )
  }
  return (
    <div data-beside-header="" ref={bodyRef} onScroll={(e) => onScrolled(e.currentTarget.scrollTop > 0)} className="min-h-0 flex-1 overflow-y-auto px-8 pb-6 pt-2">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">{body}</div>
    </div>
  )
}

const modelText = (model: { model?: string; effort?: string | null }, fallbackEffort: string | null): string | null => {
  const label = model.model ? deriveModelInfo(model.model).label : null
  const effort = model.effort ? effortLabel(model.effort) : fallbackEffort
  return label ? `${label}${effort ? ` · ${effort}` : ''}` : effort ? `${effort} effort` : null
}

type Crumb = { id: string; label: string; face: number | null | 'workflow' }

/** The trail's labels and faces: an open tab's title, else what the session knows of the agent. */
function useCrumbs(trail: readonly string[]): Crumb[] {
  const sig = useActive((s) =>
    !s || !trail.length
      ? '[]'
      : JSON.stringify(
          trail.map((id, i): Crumb => {
            const open = s.surfaces.tabs[id]
            if (id.startsWith('workflow:')) return { id, label: open?.title ?? s.workflows[id.slice(9)]?.name ?? 'Workflow', face: 'workflow' }
            const key = id.replace(/^agent:/, '')
            const ref = agentRefOf(key)
            return { id, label: open?.title ?? (ref?.by === 'tool' ? agentInfo(s, ref.id).label : 'Agent'), face: faceOf(s, { key, trail: trail.slice(0, i) }) }
          })
        )
  )
  return useMemo(() => JSON.parse(sig) as Crumb[], [sig])
}

function Breadcrumb({ handleId, label, trail }: { handleId: string; label: string; trail: readonly string[] }): JSX.Element {
  const crumbs = useCrumbs(trail)
  const current = (
    <span className="min-w-0 flex-1 truncate text-ui font-semibold text-content" title={label}>
      {label}
    </span>
  )
  if (!crumbs.length) return current
  const reopen = (c: Crumb): void => {
    const st = useSession.getState()
    const ref = agentRefOf(c.id.replace(/^agent:/, ''))
    if (c.face === 'workflow') st.openWorkflowTab(handleId, c.id.slice(9), c.label)
    else if (ref) st.openAgentTab(handleId, ref, { title: c.label, trail: trail.slice(0, trail.indexOf(c.id)) })
    requestAnimationFrame(focusPaneTitle)
  }
  const crumb = (c: Crumb): JSX.Element => (
    <button
      key={c.id}
      type="button"
      data-ui="agent-crumb"
      aria-label={`Open ${c.label}`}
      title={c.label}
      onClick={() => reopen(c)}
      className="inline-flex h-6 min-w-0 max-w-[30%] shrink items-center gap-1.5 rounded-sm px-1 text-ui text-dim pointer-fine:hover:bg-[var(--glass-row-hover)] pointer-fine:hover:text-content"
    >
      <span aria-hidden="true" className="flex shrink-0">
        {c.face === 'workflow' ? <IconWorkflow className="h-3.5 w-3.5" /> : <AgentFace face={c.face} className="h-3.5 w-3.5" />}
      </span>
      <span className="min-w-0 truncate">{c.label}</span>
    </button>
  )
  const chevron = (k: string): JSX.Element => <IconChevron key={k} className="h-3 w-3 shrink-0 text-faint" />
  const hidden = crumbs.slice(1, -1)
  return (
    <nav aria-label="Agent trail" className="flex min-w-0 flex-1 items-center gap-0.5">
      {crumb(crumbs[0])}
      {chevron('c0')}
      {hidden.length > 0 && (
        <>
          <span aria-hidden="true" className="shrink-0 px-1 text-faint" title={hidden.map((c) => c.label).join(' › ')}>
            …
          </span>
          {chevron('c1')}
        </>
      )}
      {crumbs.length > 1 && (
        <>
          {crumb(crumbs[crumbs.length - 1])}
          {chevron('c2')}
        </>
      )}
      {current}
    </nav>
  )
}

export function AgentTab({ handleId, tab }: { handleId: string; tab: SurfaceTab }): JSX.Element {
  const ref = agentRefOf(tab.key)
  const pane = usePane()
  const status = useRunStatus(ref)
  const face = useActive((s) => (s ? faceOf(s, tab) : null))
  const type = useActive((s) => (s && ref?.by === 'tool' ? agentInfo(s, ref.id).subtype : null))
  const input = useActive((s) => (s && ref?.by === 'tool' ? agentInfo(s, ref.id).input : null))
  const toolUses = useActive((s) => (s && ref ? toolUsesOf(s, ref) : undefined))
  const resolvedModel = useActive((s) => (s && ref?.by === 'tool' ? launcherOf(s, ref.id)?.resolvedModel : undefined))
  const live = isLive(status.state)
  useEffect(() => ensureAgentData(handleId, tab), [handleId, tab])
  const { entries, phase, model, retry } = useAgentEntries(handleId, ref ?? { by: 'tool', id: '' }, live)
  const liveChildren = useActive((s) => (ref?.by === 'tool' ? (s?.subagentChildren[ref.id] ?? EMPTY_NESTED_SUBAGENTS) : EMPTY_NESTED_SUBAGENTS))
  const children = useMemo(() => childrenFrom(liveChildren, entries), [liveChildren, entries])
  const bodyRef = useRef<HTMLDivElement>(null)
  const [scrolled, setScrolled] = useState(false)
  const find = useTranscriptFind(bodyRef, [entries], () => entries.length > 0)
  const ran = modelText(model.model ? model : { ...model, model: resolvedModel }, subagentEffort(input))
  const openChild = (c: NestedSubagent): void => {
    useSession.getState().openAgentTab(handleId, { by: 'tool', id: c.childToolUseId }, { title: c.description?.trim() || c.subagentType || 'Agent', trail: [...(tab.trail ?? []), tab.id] })
    requestAnimationFrame(focusPaneTitle)
  }
  return (
    <div data-ui="agent-tab" className="flex min-h-0 flex-1 flex-col bg-bg">
      <RunAnnounce state={status.state} spoken={ref?.by === 'agent' ? WORKFLOW_AGENT_SPOKEN : SPOKEN} />
      <InfoRow
        ui="agent-info"
        scrolled={scrolled}
        lead={<AgentFace face={face} className="h-4 w-4" />}
        line1={<Breadcrumb handleId={handleId} label={tab.title} trail={tab.trail ?? []} />}
        line2={
          <>
            <RunStatus {...status} />
            {status.state === 'needs' && (
              <>
                <Sep />
                <button type="button" onClick={pane.resolveNeedsYou} className="py-1 text-content underline decoration-faint underline-offset-2">
                  Show request
                </button>
              </>
            )}
            {type && (
              <>
                <Sep />
                <span className="rounded bg-bg-raised px-1.5 py-0.5 font-mono text-badge text-faint">{type}</span>
              </>
            )}
            {ran && (
              <>
                <Sep />
                <span className="min-w-0 truncate">{ran}</span>
              </>
            )}
            {toolUses !== undefined && (
              <>
                <Sep />
                <span className="shrink-0">
                  {toolUses} {toolUses === 1 ? 'tool call' : 'tool calls'}
                </span>
              </>
            )}
            <StopControl handleId={handleId} tab={tab} />
          </>
        }
      />
      {find.open && (
        <div className="shrink-0 px-4 pb-2">
          <FindField ui="agent-find" {...find.field} placeholder="Find in agent transcript" label="Find in agent transcript" />
        </div>
      )}
      {ref ? (
        <TranscriptBody bodyRef={bodyRef} onScrolled={setScrolled} entries={entries} phase={phase} status={status} children={children} onRetry={retry} onOpenChild={openChild} />
      ) : (
        <p className="px-8 pt-2 text-ui text-dim">This agent&apos;s transcript isn&apos;t on disk anymore.</p>
      )}
    </div>
  )
}
