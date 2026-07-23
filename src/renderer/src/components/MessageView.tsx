import { useEffect, useState } from 'react'
import { useSession, type ChatMessage, type MessageAttachment, type ToolCall } from '../store'
import { TypingDots } from './TypingDots'
import { Markdown } from './Markdown'
import { IconChevron, IconCheck, IconClose, IconFile } from './Icon'

/** Render one user-message attachment: an image thumbnail, or a neutral file chip
 *  (document/text) showing the filename + size. Matches the composer pill's language. */
function MessageAttachmentView({ att }: { att: MessageAttachment }): JSX.Element {
  if (att.kind === 'image') {
    return (
      <img
        src={att.previewUrl}
        alt={att.name || 'Attached image'}
        className="max-h-40 max-w-[200px] rounded-md border border-border object-contain"
      />
    )
  }
  const meta =
    att.kind === 'text' ? `${Math.max(1, Math.round(att.bytes / 1024))} KB · ${att.lines} lines` : `${Math.max(1, Math.round(att.bytes / 1024))} KB · PDF`
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-bg-raised px-2.5 py-1.5">
      <IconFile className="h-4 w-4 shrink-0 text-dim" />
      <div className="flex min-w-0 flex-col">
        <span className="max-w-[160px] truncate text-xs text-content" title={att.name}>
          {att.name}
        </span>
        <span className="font-mono text-[10px] text-faint">{meta}</span>
      </div>
    </div>
  )
}

/** >this many TOTAL tools in a message → aggregate header + demote per-card dots to
 *  a static running-dot. NOTE: gated on total count, not *concurrent-running* count
 *  — verified against the CLI that headless stream-json serializes subagent/tool
 *  calls (peak concurrent = 1), so a "running > N" gate would never fire; a message
 *  with many tool calls is exactly when the compact tally + one static header help. */
const AGGREGATE_ABOVE = 5
/** ≥this many total tools → collapse completed into the header count (show only
 *  running + failed; failed pinned). */
const COLLAPSE_AT = 16

export function MessageView({ message }: { message: ChatMessage }): JSX.Element {
  const isUser = message.role === 'user'
  return (
    <div className="flex flex-col gap-2">
      <div
        className={`flex items-center gap-1.5 font-serif text-[14px] font-semibold ${
          isUser ? 'text-dim' : 'text-accent'
        }`}
      >
        {!isUser && <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />}
        {isUser ? 'You' : 'Claude'}
      </div>
      <div
        className={
          isUser
            ? 'max-w-[80%] self-start rounded-lg rounded-tl-sm bg-user px-3.5 py-2.5'
            : 'flex flex-col gap-2 border-l border-border/70 pl-3.5'
        }
      >
        {message.thinking && <ThinkingBlock text={message.thinking} />}
        {isUser ? (
          // User input is literal text — render as-is (don't reformat what they typed).
          // Attachments (image thumbnails / file chips) render above the text.
          <>
            {message.attachments && message.attachments.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {message.attachments.map((att, i) => (
                  <MessageAttachmentView key={i} att={att} />
                ))}
              </div>
            )}
            {message.text && (
              <div className="whitespace-pre-wrap text-sm leading-relaxed text-content">
                {message.text}
              </div>
            )}
          </>
        ) : message.blocks.length > 0 ? (
          // Live path: render text + tools in true stream order (intro text → tool
          // cards → closing text), coalescing consecutive tool blocks into one group.
          <OrderedBlocks blocks={message.blocks} tools={message.tools} />
        ) : (
          // Fallback (rebuilt-from-disk): text then tools.
          <>
            {message.text && <Markdown text={message.text} />}
            <ToolGroup tools={message.tools} />
          </>
        )}
      </div>
    </div>
  )
}

/** Render an assistant message's ordered blocks: text runs as markdown, and each
 *  maximal run of consecutive tool blocks as one ToolGroup (so aggregation still
 *  applies to a fan-out) — preserving the true text/tool interleaving. */
function OrderedBlocks({
  blocks,
  tools
}: {
  blocks: import('../store').MessageBlock[]
  tools: ToolCall[]
}): JSX.Element {
  const byId = new Map(tools.map((t) => [t.id, t]))
  const out: JSX.Element[] = []
  let i = 0
  let key = 0
  while (i < blocks.length) {
    const b = blocks[i]
    if (b.kind === 'text') {
      if (b.text.trim()) out.push(<Markdown key={key++} text={b.text} />)
      i++
    } else {
      // Gather a maximal run of tool blocks so ToolGroup can aggregate them.
      const run: ToolCall[] = []
      while (i < blocks.length && blocks[i].kind === 'tool') {
        const tc = byId.get((blocks[i] as { id: string }).id)
        if (tc) run.push(tc)
        i++
      }
      out.push(<ToolGroup key={key++} tools={run} />)
    }
  }
  return <>{out}</>
}

/**
 * Renders a message's tool calls with progressive aggregation (gated on TOTAL
 * tool count — the CLI serializes subagent calls in headless mode, so a
 * concurrent-running gate would never fire):
 *  - ≤AGGREGATE_ABOVE total: individual cards, per-card dots+timer (the baseline).
 *  - more: a STATIC aggregate header ("M done · N running · K failed" — no spinner;
 *    the chat footer owns the single fg animation) and per-card dots demote to a
 *    static running-dot (timers kept).
 *  - ≥COLLAPSE_AT total: completed cards fold into the header count (collapsible);
 *    only running + failed cards show, failed pinned first.
 */
function ToolGroup({ tools }: { tools: ToolCall[] }): JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  if (tools.length === 0) return null

  const running = tools.filter((t) => t.result === undefined).length
  const errored = tools.filter((t) => t.result !== undefined && t.isError).length
  const done = tools.length - running - errored
  const aggregate = tools.length > AGGREGATE_ABOVE
  const collapse = tools.length >= COLLAPSE_AT

  if (!aggregate) {
    // Baseline: individual cards with their own dots + timer.
    return (
      <>
        {tools.map((t) => (
          <ToolCallView key={t.id} tool={t} showDots />
        ))}
      </>
    )
  }

  // Which cards to show: when collapsing, only running + failed (failed pinned).
  const visible =
    collapse && !expanded
      ? [...tools.filter((t) => t.result !== undefined && t.isError), ...tools.filter((t) => t.result === undefined)]
      : tools

  return (
    <div className="flex flex-col gap-1.5">
      <button
        className="flex items-center gap-2.5 rounded-md border border-border bg-bg-raised/60 px-3 py-2 text-left"
        onClick={() => setExpanded((v) => !v)}
        aria-label={`Subagents and tools: ${done} done, ${running} running${errored ? `, ${errored} failed` : ''}`}
      >
        {collapse && (
          <IconChevron className={`h-3.5 w-3.5 text-faint transition-transform ${expanded ? 'rotate-90' : ''}`} />
        )}
        {/* STATIC dot — the chat footer is the single animated element per turn. */}
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden="true" />
        <span className="text-xs font-semibold text-content">Tasks</span>
        <span className="ml-auto flex items-center gap-2 font-mono text-[11px]">
          <span className="text-ok">{done} done</span>
          <span className="text-faint">·</span>
          <span className="text-warn">{running} running</span>
          {errored > 0 && (
            <>
              <span className="text-faint">·</span>
              <span className="rounded bg-err/15 px-1.5 py-0.5 font-semibold text-err">{errored} failed</span>
            </>
          )}
        </span>
      </button>
      <div className="flex flex-col gap-1.5 pl-3">
        {collapse && !expanded && done > 0 && (
          <div className="px-1 text-[11px] text-faint">{done} completed hidden — click to expand</div>
        )}
        {visible.map((t) => (
          <ToolCallView key={t.id} tool={t} showDots={false} />
        ))}
      </div>
    </div>
  )
}

function ThinkingBlock({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="text-xs">
      <button className="cursor-pointer text-xs text-dim" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} Thinking
      </button>
      {open && (
        <div className="mt-1 border-l-2 border-border px-2.5 py-1.5 text-dim italic [&_*]:text-dim">
          <Markdown text={text} />
        </div>
      )}
    </div>
  )
}

function ToolCallView({ tool, showDots }: { tool: ToolCall; showDots: boolean }): JSX.Element {
  const [open, setOpen] = useState(false)
  const viewSubagent = useSession((s) => s.viewSubagent)
  const summary = summarizeInput(tool.input)
  const running = tool.result === undefined
  // Task (renamed → Agent in CLI 2.1.63; Task kept as alias) both mean "subagent";
  // show a friendly label + the subagent_type chip when present.
  const isSubagent = tool.name === 'Task' || tool.name === 'Agent'
  const subType = subagentType(tool.input)
  // A backgrounded tool returns its result AT LAUNCH while the real work continues
  // asynchronously (tracked in the tray), so its terminal state reads "launched", not
  // "done". Two cases: Bash `run_in_background`, AND the dynamic `Workflow` tool (it
  // returns immediately, then the workflow runs via task_progress — showing "done" the
  // instant it launches was the reported bug).
  const isBackgrounded =
    tool.name === 'Workflow' ||
    Boolean(tool.input && typeof tool.input === 'object' &&
      (tool.input as { run_in_background?: unknown }).run_in_background === true)
  return (
    <div
      className={`overflow-hidden rounded-md border bg-tool ${
        tool.isError ? 'border-err/60' : 'border-border'
      }`}
    >
      {/* Head row. For a SUBAGENT the card is the actual content, so clicking it
          opens the maximized transcript view (the inline JSON expand is near-useless
          for a subagent — its input is a huge prompt, its result one blob). A PLAIN
          TOOL keeps the lightweight inline expand (input/output is the right detail;
          a full-screen takeover for a one-line Bash result would be overkill). */}
      <div className="flex w-full items-center">
      <button
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-3 py-2 text-left text-[14px]"
        onClick={() => (isSubagent ? viewSubagent(tool.id) : setOpen((o) => !o))}
      >
        <span className="font-mono text-xs font-semibold text-accent">
          {isSubagent ? 'Agent' : tool.name}
        </span>
        {summary && (
          <span className="truncate font-mono text-xs text-dim">{summary}</span>
        )}
        {isSubagent && subType && (
          <span className="shrink-0 rounded bg-bg-raised px-1.5 py-0.5 font-mono text-[10px] text-faint">
            {subType}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5 text-[11px]">
          {running && isBackgrounded ? (
            // A backgrounded tool (Workflow / run_in_background Bash) returns its result
            // almost immediately, then the real work continues in the tray. In the brief
            // gap before its result lands, the in-flight state is "launching…", NOT
            // "running" (+ no elapsed timer — that wrongly implies you're waiting on THIS
            // call). Info-blue matches the terminal "launched" state so it doesn't flip
            // color. Fixes the reported "running…"→"launched" flash.
            <>
              {showDots ? (
                <TypingDots className="scale-[0.7] text-info" />
              ) : (
                <span className="h-1.5 w-1.5 rounded-full bg-info" aria-hidden="true" />
              )}
              <span className="text-info">launching…</span>
            </>
          ) : running ? (
            <>
              {/* Per-card dots animate ONLY in the baseline (few tools); when the
                  aggregate header is shown (showDots=false) the dot goes static so
                  the chat footer is the single moving element. Timer always shown. */}
              {showDots ? (
                <TypingDots className="scale-[0.7] text-dim" />
              ) : (
                <span className="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden="true" />
              )}
              <span className="text-dim">running</span>
              {/* Elapsed timer — the load-bearing "not frozen" signal for long
                  tool/subagent calls that emit nothing until they finish. */}
              {tool.startMs !== undefined && <RunningTimer startMs={tool.startMs} />}
            </>
          ) : isBackgrounded && !tool.isError ? (
            // A run_in_background tool returns its result at LAUNCH (the task keeps
            // running in the bg tray). "done" would wrongly imply the WORK finished,
            // so label it "launched" and point at the tray with an info-blue dot.
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-info" aria-hidden="true" />
              <span className="text-info">launched</span>
            </>
          ) : (
            <>
              <span className={`h-1.5 w-1.5 rounded-full ${tool.isError ? 'bg-err' : 'bg-ok'}`} />
              <span className={tool.isError ? 'text-err' : 'text-ok'}>
                {tool.isError ? 'error' : 'done'}
              </span>
            </>
          )}
        </span>
        {/* subagent: a hint that the card opens the transcript (→). */}
        {isSubagent && <span className="ml-2 shrink-0 font-mono text-[11px] text-faint">→</span>}
      </button>
      </div>
      {/* Inline expand is for PLAIN tools only; subagents open the transcript view. */}
      {open && !isSubagent && (
        <div className="border-t border-border px-3 py-2.5">
          <pre className="mb-2 whitespace-pre-wrap break-words font-mono text-xs text-dim">
            {JSON.stringify(tool.input, null, 2)}
          </pre>
          {tool.result !== undefined && (
            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-content">
              {truncate(tool.result, 4000)}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

function summarizeInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>
    // Task (subagent) calls carry a short human description — surface it so the
    // card reads "Task  research palette UX" rather than a bare "Task" (Labor
    // Illusion: showing WHAT is running raises perceived progress + patience).
    if (typeof o.description === 'string') return o.description
    if (typeof o.command === 'string') return o.command
    if (typeof o.file_path === 'string') return o.file_path
    if (typeof o.path === 'string') return o.path
    if (typeof o.pattern === 'string') return o.pattern
  }
  return ''
}

/** The subagent kind (e.g. "Explore", "general-purpose") from a Task/Agent input,
 *  when present — rendered as a chip. Additive parse of the opaque tool input. */
function subagentType(input: unknown): string | null {
  if (input && typeof input === 'object') {
    const t = (input as Record<string, unknown>).subagent_type
    if (typeof t === 'string' && t) return t
  }
  return null
}

/** Live elapsed timer for a running tool call. Ticks each second from startMs and
 *  formats as `12s` / `1m 04s` / `1h 02m`. No verb — the TypingDots + this timer
 *  are the whole signal (per the design decision). */
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
