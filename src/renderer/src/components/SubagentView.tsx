/** Maximized transcript view. When a subagent's "view transcript" is clicked, this replaces the main region;
 *  the sessions sidebar persists. Full-width by design. Esc returns to the conversation.
 *  Renders `subagentMessages[parentToolUseId]` in stream order. The launching Agent tool call supplies the header. */
import { useEffect, useState } from 'react'
import {
  useActive,
  useSession,
  EMPTY_MESSAGES,
  EMPTY_SUBAGENT_MSGS,
  EMPTY_NESTED_SUBAGENTS,
  type ToolCall,
  type WorkflowState,
  type WorkflowAgent,
  type NestedSubagent
} from '../store'
import { useEscape } from '../lib/useEscape'
import { Markdown } from './Markdown'
import { ToolGroup } from './MessageView'
import { IconClose, IconWarn } from './Icon'
import type { HistoryMessage } from '../../../shared/sessions'
import type { SubagentMessage } from '../store'
import { deriveModelInfo, EFFORT_LABELS, isEffortChoice } from '../../../shared/settings'

function findAgentTool(
  messages: { tools: ToolCall[] }[],
  id: string
): ToolCall | null {
  for (const m of messages) {
    const t = m.tools.find((tc) => tc.id === id)
    if (t) return t
  }
  return null
}

/** Stable empty ref for the children map (zustand-v5 selector safety). */
const EMPTY_CHILDREN_MAP: Record<string, NestedSubagent[]> = {}
/** Stable empty ref for the subagent-messages map (zustand-v5 selector safety). */
const EMPTY_SUBAGENT_MSGS_MAP: Record<string, SubagentMessage[]> = {}

function isAgentTool(name: string): boolean {
  return name === 'Task' || name === 'Agent'
}

/** The launching Task/Agent tool call for a subagent, found by its tool_use id anywhere in the forwarded streams.
 *  A nested child has no Agent card in `messages`, but its launcher is a `kind:'tool'` entry in its parent's stream,
 *  and that entry is what `subagent-tool-result` completes, so its `result` is the child's authoritative terminal evidence. */
function findLaunchTool(
  map: Record<string, SubagentMessage[]>,
  toolUseId: string
): ToolCall | null {
  for (const entries of Object.values(map)) {
    for (const e of entries) {
      if (e.kind === 'tool' && e.tool.id === toolUseId) return e.tool
    }
  }
  return null
}

/** Resolved header metadata for a subagent at some trail depth. A top-level subagent is found on its launching
 *  Agent tool card; a nested child has no card, its metadata comes from its parent's `subagentChildren` entry. */
function resolveAgentMeta(
  id: string,
  messages: { tools: ToolCall[] }[],
  childrenByParent: Record<string, NestedSubagent[]>
): { name: string; subtype: string | null; desc: string; tool: ToolCall | null } {
  const tool = findAgentTool(messages, id)
  if (tool) {
    return {
      name: tool.name === 'Task' ? 'Agent' : tool.name,
      subtype: agentSubtype(tool.input),
      desc: agentDescription(tool.input),
      tool
    }
  }
  // Nested child: look it up in the parent's children list.
  for (const list of Object.values(childrenByParent)) {
    const child = list.find((c) => c.childToolUseId === id)
    if (child) {
      return {
        name: child.name === 'Task' ? 'Agent' : child.name,
        subtype: child.subagentType ?? null,
        desc: child.description ?? '',
        tool: null
      }
    }
  }
  return { name: 'Agent', subtype: null, desc: '', tool: null }
}

function agentDescription(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>
    if (typeof o.description === 'string') return o.description
    if (typeof o.prompt === 'string') return o.prompt
  }
  return ''
}
function agentSubtype(input: unknown): string | null {
  if (input && typeof input === 'object') {
    const t = (input as Record<string, unknown>).subagent_type
    if (typeof t === 'string' && t) return t
  }
  return null
}

function agentStatus(state: string): { cls: string; label: string } {
  if (/fail|error/i.test(state)) return { cls: 'bg-err', label: 'failed' }
  if (/done|complete|success/i.test(state)) return { cls: 'bg-ok', label: 'done' }
  if (/queue/i.test(state)) return { cls: 'bg-faint', label: 'queued' }
  return { cls: 'bg-warn', label: 'running' }
}

/** The selected workflow-agent's full transcript, read from its on-disk `agent-<agentId>.jsonl`.
 *  Re-fetches while the agent is running so it fills in as the file grows; static once done. */
function WorkflowAgentDetail({ agent }: { agent: WorkflowAgent }): JSX.Element {
  const [msgs, setMsgs] = useState<HistoryMessage[] | null>(null)
  const status = agentStatus(agent.state)
  const running = status.label === 'running' || status.label === 'queued'

  useEffect(() => {
    if (!agent.agentId) {
      setMsgs([])
      return
    }
    let cancelled = false
    const load = (): void => {
      void window.clui.readAgentTranscript(agent.agentId as string).then((r) => {
        if (!cancelled) setMsgs(r.messages)
      })
    }
    load()
    // Poll while running so the transcript fills in.
    const t = running ? setInterval(load, 2000) : null
    return () => {
      cancelled = true
      if (t) clearInterval(t)
    }
  }, [agent.agentId, running])

  return (
    <div className="max-w-3xl">
      <div className="mb-4 flex items-center gap-2.5">
        <span className="font-mono text-[14px] font-semibold text-accent">{agent.label}</span>
        <span className="flex items-center gap-1.5 font-mono text-[12px]">
          <span className={`h-1.5 w-1.5 rounded-full ${status.cls}`} aria-hidden="true" />
          <span className="text-dim">{status.label}</span>
        </span>
      </div>
      {msgs === null ? (
        <div className="text-sm text-faint">Loading transcript…</div>
      ) : msgs.length === 0 ? (
        <div className="text-sm text-faint">
          {running ? 'Waiting for the agent to write its transcript…' : 'No transcript found for this agent.'}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {msgs.map((m) => (
            <HistoryBlock key={m.id} msg={m} />
          ))}
          {running && <div className="text-[12px] text-faint">••• still running…</div>}
        </div>
      )}
    </div>
  )
}

function HistoryBlock({
  msg,
  hideAgentTools = false
}: {
  msg: HistoryMessage
  /** Skip Task/Agent tool rows: on a resumed subagent they're surfaced as drill-down cards below the transcript. */
  hideAgentTools?: boolean
}): JSX.Element {
  const isUser = msg.role === 'user'
  const tools = hideAgentTools ? msg.tools.filter((t) => !isAgentTool(t.name)) : msg.tools
  return (
    <div>
      <div className="mb-1.5 font-serif text-[13px] text-dim">
        {isUser ? 'Prompt' : <span className="text-accent">Agent</span>}
      </div>
      {msg.thinking && (
        <div className="mb-2 border-l-2 border-border pl-3 text-[12.5px] italic text-dim [&_*]:text-dim">
          <Markdown text={msg.thinking} />
        </div>
      )}
      {msg.text && (isUser ? (
        <div className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-dim">{msg.text}</div>
      ) : (
        <Markdown text={msg.text} />
      ))}
      {tools.map((t) => (
        <div key={t.id} className="my-1.5 rounded-md border border-border bg-tool px-3 py-1.5 font-mono text-[11.5px]">
          <span className="font-semibold text-accent">{t.name}</span>
          {toolSummary(t.input) && <span className="ml-2 text-dim">{toolSummary(t.input)}</span>}
        </div>
      ))}
    </div>
  )
}

function toolSummary(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>
    for (const k of ['command', 'file_path', 'path', 'pattern', 'description'] as const) {
      if (typeof o[k] === 'string') return o[k] as string
    }
  }
  return ''
}

/** Maximized dynamic-workflow view: a left phase-tree rail (phases → agents, grouped by phaseIndex, live from
 *  `workflow_progress`) + a detail pane for the selected agent. The agent's own transcript is read from disk. */
function WorkflowTreeView({
  workflow,
  onClose
}: {
  workflow: WorkflowState
  onClose: () => void
}): JSX.Element {
  const [selIdx, setSelIdx] = useState<number | null>(null)
  const sel = workflow.agents.find((a) => a.index === selIdx) ?? null
  const done = workflow.agents.filter((a) => /done|complete|success/i.test(a.state)).length
  const failed = workflow.agents.filter((a) => /fail|error/i.test(a.state)).length
  const running = workflow.agents.length - done - failed

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4 text-[13px]">
        <button className="font-semibold text-accent hover:brightness-110" onClick={onClose}>
          ← Chat
        </button>
        <span className="text-faint">·</span>
        <span className="text-info">◆</span>
        <span className="font-mono text-content">{workflow.name}</span>
        <span className="ml-auto flex items-center gap-2 font-mono text-[12px]">
          <span className="text-ok">{done} done</span>
          <span className="text-faint">·</span>
          <span className="text-warn">{running} running</span>
          {failed > 0 && (
            <>
              <span className="text-faint">·</span>
              {/* text-err on the plain header strip is 4.66:1; an err/15 tint drops it to 3.93:1. */}
              <span className="flex items-center gap-1 font-semibold text-err">
                <IconWarn className="h-3.5 w-3.5" aria-hidden="true" />
                {failed} failed
              </span>
            </>
          )}
          {workflow.endedStatus && <span className="ml-1 text-faint">· ended</span>}
        </span>
        <button
          className="ml-1 rounded-md p-1 text-dim hover:bg-bg-raised hover:text-content"
          onClick={onClose}
          title="Close (Esc)"
        >
          <IconClose className="h-4 w-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Phase tree rail */}
        <div className="w-64 shrink-0 overflow-y-auto border-r border-border bg-bg-elev p-2">
          <div className="px-2 pb-2 pt-1 font-mono text-[11px] text-faint">{workflow.description}</div>
          {workflow.phases.map((ph) => {
            const inPhase = workflow.agents.filter((a) => a.phaseIndex === ph.index)
            return (
              <div key={ph.index} className="mt-1">
                <div className="flex items-center gap-1.5 px-2 py-1.5 text-[12px] font-semibold text-dim">
                  {ph.title}
                  <span className="font-normal text-faint">({inPhase.length})</span>
                </div>
                {inPhase.map((a) => {
                  const st = agentStatus(a.state)
                  const selected = a.index === selIdx
                  return (
                    <button
                      key={a.index}
                      onClick={() => setSelIdx(a.index)}
                      className={`flex w-full items-center gap-2 rounded-md py-1.5 pl-5 pr-2 text-left text-[12px] ${
                        selected ? 'bg-accent-surface text-content' : 'text-dim hover:bg-bg-raised'
                      } ${/fail|error/i.test(a.state) ? 'text-content' : ''}`}
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${st.cls}`} aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{a.label}</span>
                      <span className="shrink-0 font-mono text-[11px] text-faint">{st.label}</span>
                    </button>
                  )
                })}
              </div>
            )
          })}
          {workflow.agents.length === 0 && (
            <div className="px-2 py-3 text-[12px] text-faint">Starting workflow…</div>
          )}
        </div>

        {/* Detail pane for the selected agent: its full transcript. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
          {sel ? (
            <WorkflowAgentDetail key={sel.index} agent={sel} />
          ) : workflow.agents.length > 0 ? (
            <div className="text-sm text-faint">Select an agent to see its transcript.</div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-faint">
              Starting workflow…
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Nesting: a card for a subagent spawned by the subagent being viewed. Clicking drills into its transcript.
 *  Shows a live dot if its transcript has begun streaming. */
function NestedAgentCard({
  child,
  onOpen
}: {
  child: NestedSubagent
  onOpen: () => void
}): JSX.Element {
  // Streaming-started is not "done": take the child's real lifecycle from its bg-task handle
  // (if backgrounded) or its launching tool's result, so a still-running child never reads teal.
  const status = useActive((s): 'running' | 'done' | 'failed' | 'stopped' => {
    if (!s) return 'running'
    const bg = Object.values(s.backgroundTasks).find(
      (t) => t.taskType === 'local_agent' && t.toolUseId === child.childToolUseId
    )
    if (bg) return bg.status === 'killed' ? 'stopped' : bg.status === 'failed' ? 'failed' : bg.status === 'running' ? 'running' : 'done'
    const tool = findLaunchTool(s.subagentMessages, child.childToolUseId)
    if (tool) return tool.result === undefined ? 'running' : tool.isError ? 'failed' : 'done'
    return 'running'
  })
  const dot =
    status === 'done' ? 'bg-ok' : status === 'failed' ? 'bg-err' : status === 'stopped' ? 'bg-faint' : 'bg-info'
  const label = child.name === 'Task' ? 'Agent' : child.name
  return (
    <button
      className="group flex w-full items-center gap-2.5 rounded-md border border-border bg-tool px-3 py-2 text-left hover:border-border-strong hover:bg-bg-raised focus-visible:border-accent focus-visible:outline-none"
      onClick={onOpen}
      title="Open this nested subagent's transcript"
    >
      <span className="font-mono text-xs font-semibold text-accent">{label}</span>
      {child.description && (
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-dim" title={child.description}>
          {child.description}
        </span>
      )}
      {child.subagentType && (
        <span className="shrink-0 rounded bg-bg-raised px-1.5 py-0.5 font-mono text-[10px] text-faint">
          {child.subagentType}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[11px]">
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden="true" />
        <span className="text-faint">{status}</span>
        <span className="text-faint">→</span>
      </span>
    </button>
  )
}

/** The "Spawned N subagents" list of drill-down cards. Fed live children or the ones recovered from a resumed transcript's Task/Agent tool calls. */
function SpawnedChildren({
  items,
  onOpen
}: {
  items: NestedSubagent[]
  onOpen: (childToolUseId: string) => void
}): JSX.Element | null {
  if (items.length === 0) return null
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <div className="font-serif text-[13px] text-dim">
        Spawned {items.length === 1 ? 'subagent' : `${items.length} subagents`}
      </div>
      {items.map((c) => (
        <NestedAgentCard key={c.childToolUseId} child={c} onOpen={() => onOpen(c.childToolUseId)} />
      ))}
    </div>
  )
}

/** Render a subagent's forwarded stream in true order: text/thinking runs interleaved with its tool calls.
 *  Each consecutive run of tool entries coalesces into one ToolGroup. */
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
        <div className="mb-1.5 flex items-center gap-1.5 font-serif text-[13px] text-dim">
          {e.role === 'user' ? (
            // The subagent's turn input (prompt).
            <span className="text-dim">Prompt</span>
          ) : (
            <span className="flex items-center gap-1.5 text-accent">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
              Subagent
            </span>
          )}
          {e.kind === 'thinking' && <span className="text-faint">· thinking</span>}
        </div>
        {e.kind === 'thinking' ? (
          <div className="border-l-2 border-border pl-3 text-[12.5px] italic text-dim [&_*]:text-dim">
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

export function SubagentView(): JSX.Element | null {
  const subagentTrail = useSession((s) => s.subagentTrail)
  const parentId = useSession((s) => s.viewingSubagent)
  const close = useSession((s) => s.closeSubagentView)
  const popSubagent = useSession((s) => s.popSubagent)
  const gotoSubagentDepth = useSession((s) => s.gotoSubagentDepth)
  const pushSubagent = useSession((s) => s.pushSubagent)
  const messages = useActive((s) => s?.messages ?? EMPTY_MESSAGES)
  const workflow = useActive((s) => (parentId ? (s?.workflows[parentId] ?? null) : null))
  const subMsgs = useActive((s) =>
    parentId ? (s?.subagentMessages[parentId] ?? EMPTY_SUBAGENT_MSGS) : EMPTY_SUBAGENT_MSGS
  )
  const children = useActive((s) =>
    parentId ? (s?.subagentChildren[parentId] ?? EMPTY_NESTED_SUBAGENTS) : EMPTY_NESTED_SUBAGENTS
  )
  // The full children map, letting the breadcrumb label an ancestor that is itself a nested child.
  const childrenByParent = useActive((s) => s?.subagentChildren ?? EMPTY_CHILDREN_MAP)
  // Full forwarded-stream map, to find a nested child's launching tool for its terminal status. Foreground `busy` is the fallback liveness.
  const subMsgsMap = useActive((s) => s?.subagentMessages ?? EMPTY_SUBAGENT_MSGS_MAP)
  const busy = useActive((s) => s?.busy ?? false)
  // The bg-task handle for a backgrounded subagent, joined on toolUseId. Its `status` is the only true lifecycle;
  // null for a foreground subagent. Returns a stored object or literal null, both stable refs.
  const bgTask = useActive((s) =>
    s && parentId
      ? (Object.values(s.backgroundTasks).find(
          (t) => t.taskType === 'local_agent' && t.toolUseId === parentId
        ) ?? null)
      : null
  )

  // Live forwarded text wins; the on-disk transcript is the fallback when none arrived, located by tool_use_id
  // via the .meta.json sidecar. `forwardSubagentText` streams depth-2+ too, so nested children normally take
  // the live path and this fallback only covers a resumed/dormant session. Keyed by parentId; null = not loaded.
  const [diskMsgs, setDiskMsgs] = useState<HistoryMessage[] | null>(null)
  const [diskLoadedFor, setDiskLoadedFor] = useState<string | null>(null)
  const liveCount = parentId ? subMsgs.length : 0
  useEffect(() => {
    if (!parentId) return
    // Live stream present: no disk read needed.
    if (liveCount > 0) {
      setDiskMsgs(null)
      setDiskLoadedFor(null)
      return
    }
    let cancelled = false
    void window.clui.readAgentTranscriptByToolUseId(parentId).then((r) => {
      if (!cancelled) {
        setDiskMsgs(r.messages)
        setDiskLoadedFor(parentId)
      }
    })
    return () => {
      cancelled = true
    }
  }, [parentId, liveCount])

  // The subagent's model + effort for the header chip, read from its on-disk transcript (the live stream carries neither).
  // Separate from the diskMsgs fallback above, which is skipped on the live path.
  const [agentMeta, setAgentMeta] = useState<{ model?: string; effort?: string | null }>({})
  useEffect(() => {
    setAgentMeta({})
    if (!parentId) return
    let cancelled = false
    let tries = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const load = (): void => {
      void window.clui.readAgentTranscriptByToolUseId(parentId).then((r) => {
        if (cancelled) return
        if (r.agentModel) {
          setAgentMeta({ model: r.agentModel, effort: r.agentEffort })
        } else if (tries++ < 12) {
          // A live subagent's on-disk jsonl lags its stream, so its first assistant record can take several seconds to land.
          timer = setTimeout(load, 1500)
        }
      })
    }
    load()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [parentId])

  // Esc pops one level, closing the view at the root. LIFO stack.
  useEscape(parentId !== null, popSubagent)

  if (!parentId) return null
  // A dynamic workflow gets the phase-tree view; a plain subagent gets the transcript.
  if (workflow) return <WorkflowTreeView workflow={workflow} onClose={close} />

  // Resolve the current subagent's header metadata. A top-level subagent is found on the launching Agent tool card;
  // a nested child isn't there, so its metadata lives in its parent's `subagentChildren` entry.
  const meta = resolveAgentMeta(parentId, messages, childrenByParent)
  const name = meta.name
  const subtype = meta.subtype
  const desc = meta.desc
  // Humanize the raw model id; effort falls back to the raw word if a CLI bump adds a level the labels don't know.
  const modelLabel = agentMeta.model ? deriveModelInfo(agentMeta.model).label : null
  const effortLabel =
    agentMeta.effort && isEffortChoice(agentMeta.effort)
      ? EFFORT_LABELS[agentMeta.effort]
      : (agentMeta.effort ?? null)
  // Status source, in order of authority: (1) A backgrounded subagent's own bg-task lifecycle. Its launching Agent tool
  // returns immediately, so the tool's `result` says nothing about the agent. (2) A foreground subagent's Agent tool card,
  // which does resolve when the agent finishes. (3) A nested child has no card: a loaded on-disk transcript means finished.
  const childLoadedFromDisk = diskLoadedFor === parentId && (diskMsgs?.length ?? 0) > 0
  // A nested foreground child takes its lifecycle from its launching tool's result, not "any message arrived".
  const nestedTool = !bgTask && !meta.tool ? findLaunchTool(subMsgsMap, parentId) : null
  const running = bgTask
    ? bgTask.status === 'running'
    : meta.tool
      ? meta.tool.result === undefined
      : nestedTool
        ? nestedTool.result === undefined
        : childLoadedFromDisk
          ? false
          : busy
  // A killed bg subagent was stopped on request, so it reads neutral rather than red.
  const failed = bgTask
    ? bgTask.status === 'failed'
    : meta.tool
      ? (meta.tool.isError ?? false)
      : (nestedTool?.isError ?? false)
  const stopped = bgTask?.status === 'killed'
  const terminalLabel = stopped ? 'stopped' : failed ? 'failed' : 'done'
  // Full class literals: Tailwind scans source text, so an interpolated `bg-${tone}` would only work by accident.
  const terminalDot = stopped ? 'bg-faint' : failed ? 'bg-err' : 'bg-ok'
  const terminalText = stopped ? 'text-faint' : failed ? 'text-err' : 'text-ok'
  const atRoot = subagentTrail.length <= 1

  // Resume seeds `subagentChildren` empty, so a resumed subagent's nested agents would render as inert history rows.
  // Recover them from the disk transcript's Task/Agent tool calls. Live children win when present.
  const diskChildren: NestedSubagent[] =
    diskMsgs && diskLoadedFor === parentId
      ? diskMsgs.flatMap((m) =>
          m.tools
            .filter((t) => isAgentTool(t.name))
            .map((t) => ({
              childToolUseId: t.id,
              name: t.name,
              description: agentDescription(t.input),
              subagentType: agentSubtype(t.input) ?? undefined
            }))
        )
      : []
  const shownChildren = children.length ? children : diskChildren

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Breadcrumb (clickable to jump up). Back button pops one level. */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4 text-[13px]">
        <button
          className="font-semibold text-accent hover:brightness-110"
          onClick={popSubagent}
          title={atRoot ? 'Back to chat' : 'Back to the parent subagent'}
        >
          {atRoot ? '← Chat' : '← Back'}
        </button>
        {/* Breadcrumb: Agent › Agent › … (each ancestor clickable). */}
        {subagentTrail.map((id, i) => {
          const m = resolveAgentMeta(id, messages, childrenByParent)
          const isLast = i === subagentTrail.length - 1
          // Ancestors carry the task name (desc) so a deep trail reads its work, not "Agent · Agent".
          const crumb = m.desc.trim() || m.subtype || 'Agent'
          const short = crumb.length > 24 ? `${crumb.slice(0, 23)}…` : crumb
          return (
            <span key={id} className="flex items-center gap-2">
              <span className="text-faint">·</span>
              {isLast ? (
                <span className="font-mono text-content">{m.name}</span>
              ) : (
                <button
                  className="font-mono text-dim hover:text-content"
                  onClick={() => gotoSubagentDepth(i)}
                  title={crumb}
                >
                  {short}
                </button>
              )}
            </span>
          )
        })}
        {subtype && (
          <span className="rounded bg-bg-raised px-1.5 py-0.5 font-mono text-[11px] text-faint">
            {subtype}
          </span>
        )}
        {modelLabel && (
          <span
            className="shrink-0 whitespace-nowrap rounded bg-bg-raised px-1.5 py-0.5 font-mono text-[11px] text-faint"
            title={`Ran on ${modelLabel}${effortLabel ? ` at ${effortLabel} effort` : ''}`}
          >
            {modelLabel}
            {effortLabel && <>{' · '}{effortLabel}</>}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2 font-mono text-[12px]">
          {running ? (
            <>
              {/* A backgrounded subagent reads ambient info-blue "launched" (its Agent tool fired);
                  a foreground one is mid-tool-call and reads live amber "running". */}
              <span
                className={`h-1.5 w-1.5 rounded-full ${bgTask ? 'bg-info' : 'bg-warn'}`}
                aria-hidden="true"
              />
              <span className={bgTask ? 'text-info' : 'text-warn'}>{bgTask ? 'launched' : 'running'}</span>
            </>
          ) : (
            <>
              <span className={`h-1.5 w-1.5 rounded-full ${terminalDot}`} aria-hidden="true" />
              <span className={terminalText}>{terminalLabel}</span>
            </>
          )}
        </span>
        <button
          className="ml-1 rounded-md p-1 text-dim transition-colors hover:bg-bg-raised hover:text-content"
          onClick={close}
          title="Close (Esc)"
        >
          <IconClose className="h-4 w-4" />
        </button>
      </div>

      {/* Transcript: full width. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        {desc && (
          <div className="mb-5 max-w-3xl font-mono text-[12px] leading-relaxed text-faint">
            {desc}
          </div>
        )}
        {/* A nested child has no live stream; render its on-disk transcript (loaded by tool_use_id). */}
        {subMsgs.length === 0 && diskLoadedFor === parentId && diskMsgs && diskMsgs.length > 0 ? (
          <div className="flex max-w-3xl flex-col gap-4">
            {diskMsgs.map((m) => (
              <HistoryBlock key={m.id} msg={m} hideAgentTools />
            ))}
            <SpawnedChildren items={shownChildren} onOpen={pushSubagent} />
          </div>
        ) : subMsgs.length === 0 && shownChildren.length === 0 ? (
          <div className="text-sm text-faint">
            {diskMsgs === null && !running
              ? 'Loading transcript…'
              : running
                ? 'Waiting for the subagent to stream…'
                : 'No transcript was captured for this subagent.'}
          </div>
        ) : (
          <div className="flex max-w-3xl flex-col gap-4">
            <SubagentStream entries={subMsgs} />
            {running && (
              <div className="text-[12px] text-faint">••• streaming from subagent…</div>
            )}
            <SpawnedChildren items={shownChildren} onOpen={pushSubagent} />
          </div>
        )}
      </div>
    </div>
  )
}
