/**
 * Maximized transcript view. When a subagent's "view transcript" is
 * clicked, this REPLACES the main region (Chat/Composer) — the sessions sidebar
 * persists (it's a sibling of <main> in App). Full-width by design (transcripts can
 * be large); ← Chat / Esc / ✕ return to the conversation.
 *
 * DATA: renders `subagentMessages[parentToolUseId]` (the subagent's forwarded
 * text/thinking AND its tool calls, streamed via `forwardSubagentText`) in stream
 * order. The launching Agent tool call (looked up by id) supplies the header: name,
 * subagent_type chip, status, and the prompt/description.
 *
 * SCOPE: subagent transcript only. A dynamic-workflow PHASE TREE slots into the
 * left rail later (its live event shape is not yet verified); this component is
 * deliberately structured so that rail can be added without reworking the
 * transcript pane.
 */
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
import { IconClose } from './Icon'
import type { HistoryMessage } from '../../../shared/sessions'
import type { SubagentMessage } from '../store'

/** Find the Agent tool call (across the active session's messages) by id. */
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

/** Resolved header metadata for a subagent at some trail depth. A top-level subagent is
 *  found on its launching Agent tool card (in `messages`, carries running/error state);
 *  a NESTED child has no card — its metadata comes from its parent's `subagentChildren`
 *  entry (found by scanning the map for the matching childToolUseId). */
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
  // Nested child: look it up in whichever parent's children list holds it.
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

/** Map a raw CLI agent state to a status dot color + label. */
function agentStatus(state: string): { cls: string; label: string } {
  if (/fail|error/i.test(state)) return { cls: 'bg-err', label: 'failed' }
  if (/done|complete|success/i.test(state)) return { cls: 'bg-ok', label: 'done' }
  if (/queue/i.test(state)) return { cls: 'bg-faint', label: 'queued' }
  return { cls: 'bg-warn', label: 'running' }
}

/**
 * The selected workflow-agent's full transcript, read from its on-disk
 * `agent-<agentId>.jsonl` (the live stream carries only progress metadata). Re-fetches
 * while the agent is running so it fills in as the file grows; static once done.
 */
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
    // Poll while running so the transcript fills in (the file grows on disk).
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

/** Render one history message (reused shape: thinking + text + tool cards). */
function HistoryBlock({ msg }: { msg: HistoryMessage }): JSX.Element {
  const isUser = msg.role === 'user'
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
      {msg.tools.map((t) => (
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

/**
 * Maximized dynamic-workflow view: a left phase-tree rail (phases → agents, grouped
 * by phaseIndex, live from `workflow_progress`) + a detail pane for the selected
 * agent. The agent's OWN transcript isn't in the stream (only progress metadata +
 * promptPreview); its full transcript is a deferred disk-fed follow-up, so the
 * detail shows the prompt preview + live status for now.
 */
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
              <span className="rounded bg-err/15 px-1.5 py-0.5 font-semibold text-err">{failed} failed</span>
            </>
          )}
          {workflow.endedStatus && <span className="ml-1 text-ok">· ended</span>}
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
                      <span className="truncate font-mono text-[11.5px]">{a.label}</span>
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

        {/* Detail pane for the selected agent — its full transcript (read from disk). */}
        <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
          {!sel ? (
            <div className="text-sm text-faint">Select an agent to see its transcript.</div>
          ) : (
            <WorkflowAgentDetail key={sel.index} agent={sel} />
          )}
        </div>
      </div>
    </div>
  )
}

/** Nesting: a card for a subagent SPAWNED BY the subagent being viewed. Clicking
 *  drills into its transcript. Mirrors the inline MessageView Agent card idiom (label +
 *  description + subagent_type chip + "→"). Shows a live dot if its transcript has begun
 *  streaming (we have forwarded messages for its tool_use id). */
function NestedAgentCard({
  child,
  onOpen
}: {
  child: NestedSubagent
  onOpen: () => void
}): JSX.Element {
  const hasStreamed = useActive(
    (s) => (s?.subagentMessages[child.childToolUseId]?.length ?? 0) > 0
  )
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
        <span
          className={`h-1.5 w-1.5 rounded-full ${hasStreamed ? 'bg-ok' : 'bg-warn'}`}
          aria-hidden="true"
        />
        <span className="text-faint">→</span>
      </span>
    </button>
  )
}

/** Render a subagent's forwarded stream in TRUE ORDER: text/thinking runs interleaved
 *  with its tool calls. Each consecutive run of tool entries coalesces into one
 *  ToolGroup, so the main transcript's aggregation and collapse behavior applies
 *  unchanged. Mirrors MessageView's OrderedBlocks. */
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
            // The subagent's turn INPUT (prompt), not its own output.
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
  // The full children map — lets the breadcrumb label an ancestor that is itself a
  // nested child (its metadata isn't in `messages`, only in its parent's children list).
  const childrenByParent = useActive((s) => s?.subagentChildren ?? EMPTY_CHILDREN_MAP)
  // The bg-task handle for a BACKGROUNDED subagent, joined on toolUseId === the PTU being
  // viewed. Its `status` is the only true lifecycle for one (see the status note below);
  // null for a foreground subagent, which the tool-card fallback handles. Returns a stored
  // object or a literal null, both stable refs, so no zustand-v5 selector loop.
  const bgTask = useActive((s) =>
    s && parentId
      ? (Object.values(s.backgroundTasks).find(
          (t) => t.taskType === 'local_agent' && t.toolUseId === parentId
        ) ?? null)
      : null
  )

  // Live forwarded text wins; the on-disk transcript is the fallback when none arrived,
  // located by tool_use_id via the .meta.json sidecar. Since CLI 2.1.219 `forwardSubagentText`
  // streams depth-2+ too (verified live on 2.1.220: a 3-level chain where every level's own
  // text streamed under its tool_use id), so nested children normally take the live path and
  // this fallback only covers a resumed/dormant session. Keyed by parentId; null = not loaded.
  const [diskMsgs, setDiskMsgs] = useState<HistoryMessage[] | null>(null)
  const [diskLoadedFor, setDiskLoadedFor] = useState<string | null>(null)
  const liveCount = parentId ? subMsgs.length : 0
  useEffect(() => {
    if (!parentId) return
    // Live stream present → no disk read needed (top-level subagent path).
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

  // Esc pops one level (back up the trail), closing the view at the root — LIFO stack.
  useEscape(parentId !== null, popSubagent)

  if (!parentId) return null
  // A dynamic workflow gets the phase-tree view; a plain subagent gets the transcript.
  if (workflow) return <WorkflowTreeView workflow={workflow} onClose={close} />

  // Resolve the CURRENT subagent's header metadata. A top-level subagent is found on the
  // launching Agent tool card (in `messages`); a NESTED child isn't there — its metadata
  // lives in its parent's `subagentChildren` entry. Try both.
  const meta = resolveAgentMeta(parentId, messages, childrenByParent)
  const name = meta.name
  const subtype = meta.subtype
  const desc = meta.desc
  // Status source, in order of authority:
  //  1. A BACKGROUNDED subagent's own bg-task lifecycle. Its launching Agent tool returns
  //     immediately ("Async agent launched successfully"), so the tool's `result` says
  //     nothing about the agent: reading it reports "done" seconds into a long run.
  //  2. A FOREGROUND subagent's Agent tool card, which does resolve when the agent finishes.
  //  3. A NESTED child has no card: a loaded on-disk transcript means finished; else running.
  const childLoadedFromDisk = diskLoadedFor === parentId && (diskMsgs?.length ?? 0) > 0
  const running = bgTask
    ? bgTask.status === 'running'
    : meta.tool
      ? meta.tool.result === undefined
      : subMsgs.length === 0 && !childLoadedFromDisk
  // A KILLED bg subagent was stopped on request, so it reads neutral rather than red
  // (matching how the bg tray labels its own killed rows).
  const failed = bgTask ? bgTask.status === 'failed' : (meta.tool?.isError ?? false)
  const stopped = bgTask?.status === 'killed'
  const terminalLabel = stopped ? 'stopped' : failed ? 'failed' : 'done'
  // Full class literals: Tailwind scans source text, so an interpolated `bg-${tone}`
  // would only ever work by accident of another file emitting the same class.
  const terminalDot = stopped ? 'bg-faint' : failed ? 'bg-err' : 'bg-ok'
  const terminalText = stopped ? 'text-faint' : failed ? 'text-err' : 'text-ok'
  const atRoot = subagentTrail.length <= 1

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header — ← back pops one level (Chat at root); a breadcrumb shows the nesting
          trail so you always know how deep you are and can jump up. ✕ closes entirely. */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4 text-[13px]">
        <button
          className="font-semibold text-accent hover:brightness-110"
          onClick={popSubagent}
          title={atRoot ? 'Back to chat' : 'Back to the parent subagent'}
        >
          {atRoot ? '← Chat' : '← Back'}
        </button>
        {/* Breadcrumb: Agent › Agent › … (each ancestor clickable to jump up). */}
        {subagentTrail.map((id, i) => {
          const m = resolveAgentMeta(id, messages, childrenByParent)
          const isLast = i === subagentTrail.length - 1
          return (
            <span key={id} className="flex items-center gap-2">
              <span className="text-faint">·</span>
              {isLast ? (
                <span className="font-mono text-content">{m.name}</span>
              ) : (
                <button
                  className="font-mono text-dim hover:text-content"
                  onClick={() => gotoSubagentDepth(i)}
                  title="Jump to this subagent"
                >
                  {m.name}
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
        <span className="ml-auto flex items-center gap-2 font-mono text-[12px]">
          {running ? (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden="true" />
              {/* A backgrounded subagent reads "launched": we know its Agent tool fired and
                  it hasn't reported terminal, but nothing here observes it actually working.
                  A foreground one is genuinely mid-tool-call, so "running" is true there. */}
              <span className="text-warn">{bgTask ? 'launched' : 'running'}</span>
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

      {/* Transcript — full width (a workflow phase-tree rail slots left of this later). */}
      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        {desc && (
          <div className="mb-5 max-w-3xl font-mono text-[12px] leading-relaxed text-faint">
            {desc}
          </div>
        )}
        {/* A NESTED child has no live stream — render its on-disk transcript
            (loaded by tool_use_id). Falls through to the live path for top-level. */}
        {subMsgs.length === 0 && diskLoadedFor === parentId && diskMsgs && diskMsgs.length > 0 ? (
          <div className="flex max-w-3xl flex-col gap-4">
            {diskMsgs.map((m) => (
              <HistoryBlock key={m.id} msg={m} />
            ))}
            {children.length > 0 && (
              <div className="mt-2 flex flex-col gap-1.5">
                <div className="font-serif text-[13px] text-dim">
                  Spawned {children.length === 1 ? 'subagent' : `${children.length} subagents`}
                </div>
                {children.map((c) => (
                  <NestedAgentCard
                    key={c.childToolUseId}
                    child={c}
                    onOpen={() => pushSubagent(c.childToolUseId)}
                  />
                ))}
              </div>
            )}
          </div>
        ) : subMsgs.length === 0 && children.length === 0 ? (
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
            {/* Nesting: subagents this one spawned. Each opens its own transcript
                (drills one level deeper — the breadcrumb tracks the path). */}
            {children.length > 0 && (
              <div className="mt-2 flex flex-col gap-1.5">
                <div className="font-serif text-[13px] text-dim">
                  Spawned {children.length === 1 ? 'subagent' : `${children.length} subagents`}
                </div>
                {children.map((c) => (
                  <NestedAgentCard
                    key={c.childToolUseId}
                    child={c}
                    onOpen={() => pushSubagent(c.childToolUseId)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
