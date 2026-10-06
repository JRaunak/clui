import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { BlockedPrompt, CompactionMarker } from '../../../shared/sessions'
import { fmtTokens } from '../lib/formatTokens'
import {
  activeSlice,
  useActive,
  useSession,
  type ChatMessage,
  type HookNote,
  type MessageAttachment,
  type PeerMessage,
  type ToolCall
} from '../store'
import { Markdown } from './Markdown'
import { AnnotationChip } from './AnnotationChip'
import { Button } from './Button'
import { splitAnnotations } from '../../../shared/annotate'
import { AggregateRow, InstrumentRow } from './InstrumentRow'
import { IconChevron, IconClose, IconFile, IconChecklist, IconMessage, IconNoEntry, IconShieldOff } from './Icon'
import { highlightOf } from '../lib/toolHighlight'
import { formatCost } from '../lib/formatCost'
import type { PermissionDenial, TurnUsage } from '../../../shared/events'

export { summarizeInput } from '../lib/instrument'

/** Non-image attachments render as a file chip matching the composer pill's language. */
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
        <span className="font-mono text-meta text-faint">{meta}</span>
      </div>
    </div>
  )
}

/** >this many total tools in a message triggers aggregate header + demote per-card dots to
 *  a static running-dot. Gated on total count, not concurrent-running count. Verified against
 *  the CLI that headless stream-json serializes subagent/tool calls (peak concurrent = 1), so
 *  a "running > N" gate would never fire; a message with many tool calls is exactly when the
 *  compact tally + one static header help. */
const AGGREGATE_ABOVE = 5
/** ≥this many total tools triggers collapse completed into the header count (show only
 *  running + failed; failed pinned). */
const COLLAPSE_AT = 16

/** The composer inserts an agent mention as the literal token @"name (agent)", the quoted
 *  form the CLI needs to delegate the turn. Display-only: message.text keeps the literal
 *  token; the chip is styled by typeface + wash + @ sigil, not hue, so it can't collide
 *  with the scarce accent or the state-carrying status tones. Non-greedy up to the closing
 *  quote so agent names containing spaces still resolve. */
const AGENT_MENTION = /@"([^"]+?) \(agent\)"/g

/** Returns string runs interleaved with chip elements; the parent's whitespace-pre-wrap
 *  still governs the string runs, so newlines/spacing are preserved. */
function renderUserText(text: string): (string | JSX.Element)[] {
  AGENT_MENTION.lastIndex = 0
  const out: (string | JSX.Element)[] = []
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  while ((m = AGENT_MENTION.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(
      <span
        key={key++}
        className="rounded bg-bg-raised px-1 py-0.5 font-mono text-[0.8125rem] font-medium text-content"
      >
        @{m[1]}
      </span>
    )
    last = m.index + m[0].length
  }
  if (out.length === 0) return [text]
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function MessageView({ message, hideThinking = false }: { message: ChatMessage; hideThinking?: boolean }): JSX.Element {
  if (message.role === 'peer' && message.peer) return <PeerMessageView message={message} peer={message.peer} />
  if (message.compaction) return <CompactionDivider marker={message.compaction} />
  const isUser = message.role === 'user'
  if (!isUser && message.hookNotes) return <HookNotes notes={message.hookNotes} />
  // An assistant turn whose only content is entering plan mode renders as a bare full-width
  // marker, not an empty "Claude" bubble.
  if (
    !isUser &&
    !message.text &&
    !message.thinking &&
    message.tools.length > 0 &&
    message.tools.some((t) => isPlanEntry(t.name)) &&
    message.tools.every((t) => isPlanEntry(t.name) || isTaskListTool(t.name))
  ) {
    return <PlanModeDivider />
  }
  const entries = isUser ? [] : spineEntries(message)
  const hasSpine = lastToolsIndex(entries) >= 0
  return (
    <div
      className="flex flex-col gap-2"
      data-ui={isUser ? 'prompt-row' : hasSpine ? 'spine' : undefined}
      id={isUser ? `msg-${message.id}` : undefined}
      tabIndex={isUser ? -1 : undefined}
    >
      <div
        className={`relative flex items-center gap-1.5 text-label font-semibold ${isUser ? 'text-dim' : 'text-accent spine-seg'}`}
        data-seg={isUser ? undefined : hasSpine ? 'head' : 'none'}
      >
        {/* The speaker dot is the top of the spine, centred on the line 15px left of the column. */}
        {!isUser && (
          <span
            className="absolute left-[-18.5px] top-1/2 h-[7px] w-[7px] -translate-y-1/2 rounded-full bg-accent"
            aria-hidden="true"
          />
        )}
        {isUser ? 'You' : 'Claude'}
      </div>
      {/* A blocked prompt read back from disk whose wording didn't parse has no text to show. */}
      {(!isUser || message.text || message.attachments?.length) && (
        <div className={isUser ? 'max-w-[80%] self-start rounded-lg rounded-tl-sm bg-user px-3.5 py-2.5' : 'flex flex-col gap-2'}>
          {message.thinking && !(hideThinking && !message.text && message.tools.length === 0) && (
            <div className={isUser ? undefined : 'spine-seg'} data-seg={isUser ? undefined : hasSpine ? 'through' : 'none'}>
              <ThinkingBlock text={message.thinking} />
            </div>
          )}
          {isUser ? (
            <UserContent message={message} />
          ) : (
            <SpineItems entries={entries} />
          )}
        </div>
      )}
      {isUser && message.hookNotes && <HookNotes notes={message.hookNotes} />}
      {isUser && message.blocked && <BlockedPromptNotice prompt={splitAnnotations(message.text).text} blocked={message.blocked} />}
      {!isUser && message.denials && message.denials.length > 0 && <BlockedActionsNotice denials={message.denials} />}
      {!isUser && message.usage && <TurnUsageTrailer usage={message.usage} id={message.id} />}
    </div>
  )
}

/** The checklist tools (surfaced by the task puck, so their inline cards are noise here).
 *  Enumerated explicitly rather than startsWith('Task'), which also swallowed TaskOutput
 *  and TaskStop (task execution/stop results the user still needs to see). */
const CHECKLIST_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TodoWrite'])
function isTaskListTool(name: string): boolean {
  return CHECKLIST_TOOLS.has(name)
}

/** Entering plan mode (EnterPlanMode, empty input) is a state transition, not a tool result
 *  worth a card. Its inline card is dropped and a divider marks the transition instead. */
function isPlanEntry(name: string): boolean {
  return name === 'EnterPlanMode'
}

/** Full-width transcript marker for the model switching into plan mode, mirroring the
 *  "resumed here" divider but carrying plan mode's info-blue identity. */
function PlanModeDivider(): JSX.Element {
  return (
    <div className="my-6 flex items-center gap-2 text-caps">
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
      <span className="flex items-center gap-1.5 text-info">
        <IconChecklist className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="uppercase">entered plan mode</span>
      </span>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  )
}

function CompactionDivider({ marker }: { marker: CompactionMarker }): JSX.Element {
  return (
    <div className="my-6 flex items-center gap-2 text-caps uppercase text-faint">
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
      <span>
        {marker.trigger === 'auto' ? 'auto-compacted' : 'compacted'}{' '}
        <span className="font-mono normal-case tracking-normal tabular-nums">
          {fmtTokens(marker.preTokens)} <span aria-hidden="true">→</span>
          <span className="sr-only">to</span> {fmtTokens(marker.postTokens)}
        </span>{' '}
        tokens
      </span>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  )
}

interface DeniedRow {
  tool: string
  target: string
  count: number
}

/** Collapse identical tool+target denials into one row with a ×count. */
function dedupeDenials(denials: PermissionDenial[]): DeniedRow[] {
  const rows: DeniedRow[] = []
  for (const d of denials) {
    const target = highlightOf(d.input)?.value ?? ''
    const row = rows.find((r) => r.tool === d.toolName && r.target === target)
    if (row) row.count++
    else rows.push({ tool: d.toolName, target, count: 1 })
  }
  return rows
}

/** Info-blue, not error: a rule enforcing as configured is not a fault. */
function BlockedActionsNotice({ denials }: { denials: PermissionDenial[] }): JSX.Element {
  const [open, setOpen] = useState(false)
  const rows = dedupeDenials(denials)
  const first = rows[0]
  return (
    <section
      className="rounded-r-md border-l-2 border-info bg-info/7 py-[9px] pl-[13px] pr-3"
      aria-label="Blocked actions"
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <IconChevron
          className={`h-3.5 w-3.5 shrink-0 text-info transition-transform ${open ? 'rotate-90' : ''}`}
          aria-hidden="true"
        />
        <IconShieldOff className="h-3.5 w-3.5 shrink-0 text-info" aria-hidden="true" />
        <span className="shrink-0 text-label font-medium text-info">
          {denials.length === 1 ? '1 action' : `${denials.length} actions`} blocked by your permission rules
        </span>
        {/* Single-denial only: on multi, a one-item preview misdirects to an arbitrary (often
            benign) entry and hides the rest, so the count alone is the headline. */}
        {!open && denials.length === 1 && first && (
          <span className="flex min-w-0 flex-1 items-baseline gap-1 text-meta">
            <span className="shrink-0 text-dim">{first.tool}</span>
            {first.target && (
              <>
                <span className="shrink-0 text-faint" aria-hidden="true">
                  ·
                </span>
                <span className="min-w-0 truncate font-mono text-content">{first.target}</span>
              </>
            )}
          </span>
        )}
      </button>
      {open && (
        <ul className="mt-1.5 flex flex-col gap-1 pl-6">
          {rows.map((r, i) => (
            <li key={i} className="flex items-baseline gap-1.5 text-meta">
              <span className="shrink-0 font-medium text-content">{r.tool}</span>
              {r.target && (
                <>
                  <span className="shrink-0 text-faint" aria-hidden="true">
                    ·
                  </span>
                  <span className="min-w-0 break-all font-mono text-content">{r.target}</span>
                </>
              )}
              {r.count > 1 && <span className="shrink-0 text-faint">×{r.count}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** True while the element's clamped content is taller than its box. Re-measured on resize, since
 *  opening a pane narrows the transcript and can clamp text that fit before. */
function useOverflows(ref: RefObject<HTMLElement>, text: string): boolean {
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => setOverflows(el.scrollHeight > el.clientHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, text])
  return overflows
}

function HookNotes({ notes }: { notes: HookNote[] }): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      {notes.map((n, i) => (
        <HookNoteRow key={i} note={n} />
      ))}
    </div>
  )
}

/** A hook's message, muted: it's context the user configured, not something to act on. */
function HookNoteRow({ note }: { note: HookNote }): JSX.Element {
  const textRef = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  // Measured clamped: once open, the clamp is off and the text always fits.
  const clamped = useOverflows(textRef, note.text)
  return (
    <div data-ui="hook-note" data-source={note.plugin ? 'plugin' : undefined} className="flex items-baseline gap-1.5 text-meta text-dim">
      {note.plugin ? (
        <span className="shrink-0 text-faint">
          <span className="font-mono">{note.plugin}</span> plugin
        </span>
      ) : note.event && (
        <span className="shrink-0 text-faint">
          <span className="font-mono">
            {note.event}
            {note.matcher && `:${note.matcher}`}
          </span>{' '}
          hook
        </span>
      )}
      <span className="flex min-w-0 flex-col items-start">
        <span ref={textRef} className={`whitespace-pre-wrap break-words ${open ? '' : 'line-clamp-3'}`}>
          {note.text}
        </span>
        {(clamped || open) && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="min-h-6 rounded text-faint transition-colors hover:text-content"
          >
            {open ? 'Show less' : 'Show more'}
          </button>
        )}
      </span>
      {note.count > 1 && (
        <span className="shrink-0 tabular-nums text-faint">
          <span aria-hidden="true">×{note.count}</span>
          <span className="sr-only">{note.count} times</span>
        </span>
      )}
    </div>
  )
}

/** Warn, not error: the hook did what it was configured to do. The prompt never reached Claude, so
 *  the way forward is editing it. */
function BlockedPromptNotice({ prompt, blocked }: { prompt: string; blocked: BlockedPrompt }): JSX.Element {
  const [open, setOpen] = useState(false)
  const reasonRef = useRef<HTMLDivElement>(null)
  const clamped = useOverflows(reasonRef, blocked.reason)
  const detailsId = useId()
  const setDraftText = useSession((s) => s.setDraftText)
  const handleId = useActive((s) => s?.handleId ?? null)

  const edit = (): void => {
    if (!handleId) return
    // Read at click time, so typing in the composer doesn't re-render every blocked notice.
    const draft = activeSlice(useSession.getState())?.draftText ?? ''
    if (draft !== prompt) setDraftText(handleId, draft.trim() ? `${prompt}\n\n${draft}` : prompt)
    requestAnimationFrame(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('[data-composer-input]')
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(ta.value.length, ta.value.length)
    })
  }

  return (
    <section
      data-ui="prompt-blocked"
      className="rounded-r-md border-l-2 border-warn bg-warn/7 py-[9px] pl-[13px] pr-3"
      aria-label="Prompt blocked"
    >
      <div className="flex items-center gap-2">
        <IconNoEntry className="h-3.5 w-3.5 shrink-0 text-warn" aria-hidden="true" />
        <span className="text-label font-medium text-warn">
          Blocked by your <span className="font-mono">UserPromptSubmit</span> hook
        </span>
      </div>
      <div ref={reasonRef} id={blocked.command ? undefined : detailsId} className={`mt-1 whitespace-pre-wrap break-words text-ui text-content ${open && !blocked.command ? '' : 'line-clamp-3'}`}>
        {blocked.reason}
      </div>
      <div className="mt-0.5 text-meta text-dim">Claude didn&apos;t receive this prompt.</div>
      {(prompt || blocked.command || clamped) && (
        <div className="mt-2 flex items-center gap-2">
          {prompt && (
            <Button data-ui="blocked-edit-prompt" variant="control" size="sm" onClick={edit}>
              Edit prompt
            </Button>
          )}
          {(blocked.command || clamped || open) && (
            <button
              type="button"
              data-ui="blocked-hook-command"
              aria-expanded={open}
              aria-controls={detailsId}
              onClick={() => setOpen((o) => !o)}
              className="flex h-6 items-center gap-1 rounded px-1.5 text-meta text-dim transition-colors hover:text-content"
            >
              <IconChevron className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
              {`${open ? 'Hide' : 'Show'} ${blocked.command ? 'hook command' : 'full message'}`}
            </button>
          )}
        </div>
      )}
      {open && blocked.command && (
        <div id={detailsId}>
          <pre className="mt-1.5 whitespace-pre-wrap break-all rounded-md border border-border px-2.5 py-1.5 font-mono text-code text-content">
            {blocked.command}
          </pre>
          {clamped && <div className="mt-1.5 whitespace-pre-wrap break-words text-ui text-content">{blocked.reason}</div>}
        </div>
      )}
    </section>
  )
}

function fmtCost(n: number | undefined): string {
  return typeof n === 'number' ? formatCost(n) : '—'
}

function UsageRow({ label, value, strong }: { label: string; value: string; strong?: boolean }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-6">
      <dt className="text-faint">{label}</dt>
      <dd className={`font-mono tabular-nums ${strong ? 'text-content' : 'text-dim'}`}>{value}</dd>
    </div>
  )
}

/** This TURN's usage (the store deltas it off the cumulative envelope), the actionable signal
 *  for spotting the turn that blew the cache. The cumulative total lives in the footer + ring.
 *  Cache read vs creation is the Bedrock money signal, so cache creation gets its own row only
 *  when this turn actually wrote cache. */
function TurnUsageTrailer({ usage, id }: { usage: TurnUsage; id: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const totalInput = usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens
  const cachedPct = totalInput > 0 ? Math.round((usage.cacheReadInputTokens / totalInput) * 100) : 0
  const n = (v: number): string => v.toLocaleString('en-US')
  const panelId = `turn-usage-${id}`
  return (
    <div className="flex flex-col items-end">
      <button
        type="button"
        className="flex min-h-[24px] items-center gap-1 rounded px-1.5 font-mono text-meta tabular-nums text-faint transition-colors hover:text-content"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Turn cost ${fmtCost(usage.costUSD)}, show breakdown`}
        onClick={() => setOpen((o) => !o)}
      >
        <IconChevron className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
        {fmtCost(usage.costUSD)}
      </button>
      {open && (
        <dl
          id={panelId}
          className="mt-1 flex w-full max-w-xs flex-col gap-1 rounded-md border border-border bg-bg-elev px-3 py-2 text-meta"
        >
          <UsageRow label="Turn cost" value={fmtCost(usage.costUSD)} strong />
          <UsageRow label="Tokens" value={`${n(usage.inputTokens)} in · ${n(usage.outputTokens)} out`} />
          <UsageRow
            label="Cache read"
            value={totalInput > 0 ? `${n(usage.cacheReadInputTokens)} · ${cachedPct}% cached` : n(usage.cacheReadInputTokens)}
          />
          {usage.cacheCreationInputTokens > 0 && (
            <UsageRow label="Cache creation" value={n(usage.cacheCreationInputTokens)} />
          )}
          {usage.thinkingTokens > 0 && <UsageRow label="Thinking" value={n(usage.thinkingTokens)} />}
          {usage.models.length > 1 &&
            usage.models.map((m, i) => (
              <div key={i} className="flex items-baseline justify-between gap-6">
                <dt className="min-w-0 truncate font-mono text-faint" title={m.model}>
                  {m.model}
                </dt>
                <dd className="shrink-0 font-mono tabular-nums text-dim">{fmtCost(m.costUSD)}</dd>
              </div>
            ))}
        </dl>
      )}
    </div>
  )
}

/** A body that fits one line renders expanded with no chevron (collapsing a one-liner is
 *  pointless friction); longer bodies collapse by default to a one-line preview. */
const PEER_COLLAPSE_OVER = 72

/**
 * An inbound cross-session peer message. Info-blue (never terracotta), with identity on the
 * glyph + @ sigil + name + verb, not hue alone. Pending is the anonymous placeholder
 * that backfills in place when the peer-origin result lands. Collapsible via ToolGroup's
 * local-state pattern; Virtuoso remeasures on the height change.
 */
function PeerMessageView({ message, peer }: { message: ChatMessage; peer: PeerMessage }): JSX.Element {
  const long = message.text.includes('\n') || message.text.length > PEER_COLLAPSE_OVER
  const [open, setOpen] = useState(!long)
  // Crossfade the resolved header only on the live pending-to-resolved flip (same mounted
  // item), not on a fresh mount of an already-resolved block (resume / scroll re-entry),
  // where prevPending starts false.
  const [justResolved, setJustResolved] = useState(false)
  const prevPending = useRef(peer.pending)
  useEffect(() => {
    if (prevPending.current && !peer.pending) {
      setJustResolved(true)
      const t = setTimeout(() => setJustResolved(false), 220)
      prevPending.current = peer.pending
      return () => clearTimeout(t)
    }
    prevPending.current = peer.pending
    return undefined
  }, [peer.pending])

  const shell = 'rounded-r-md border-l-2 border-info bg-info/7 py-[9px] pl-[13px] pr-3'
  // A fixed leading slot for the chevron; the pending and short headers hold an empty one so
  // the glyph/name column aligns across states (else stacked short + collapsed blocks don't).
  const gutter = <span className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />

  if (peer.pending) {
    return (
      <div className={`${shell} border-dashed`}>
        <div className="flex items-center gap-2">
          {gutter}
          <IconMessage className="h-3.5 w-3.5 shrink-0 text-info" aria-hidden="true" />
          {/* Accessible text is the stable sentence; the dots are decorative. */}
          <span className="text-label font-medium text-faint">
            A peer session is messaging this session
            <span className="peer-ellipsis inline-flex" aria-hidden="true">
              <b>.</b>
              <b>.</b>
              <b>.</b>
            </span>
          </span>
        </div>
      </div>
    )
  }

  const head = justResolved ? 'peer-head-in' : ''
  const glyph = <IconMessage className="h-3.5 w-3.5 shrink-0 text-info" aria-hidden="true" />
  const name = <span className="shrink-0 text-label font-semibold text-info">@{peer.from}</span>
  // Full-strength info (not reduced opacity) for the contrast margin verified.
  const verb = <span className="shrink-0 text-meta text-info">messaged</span>

  return (
    <div className={shell}>
      {long ? (
        <button
          type="button"
          className={`flex w-full items-center gap-2 text-left ${head}`}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <IconChevron
            className={`h-3.5 w-3.5 shrink-0 text-info transition-transform ${open ? 'rotate-90' : ''}`}
            aria-hidden="true"
          />
          {glyph}
          {name}
          {open ? (
            verb
          ) : (
            <span className="min-w-0 flex-1 truncate text-label italic text-dim">{message.text}</span>
          )}
        </button>
      ) : (
        <div className={`flex items-center gap-2 ${head}`}>
          {gutter}
          {glyph}
          {name}
          {verb}
        </div>
      )}
      {open && (
        <div className="mb-px mt-2 whitespace-pre-wrap pl-[43px] text-sm text-content max-w-[70ch]">
          {message.text}
        </div>
      )}
    </div>
  )
}

type SpineEntry =
  | { kind: 'text'; text: string }
  | { kind: 'divider' }
  | { kind: 'hook'; note: HookNote }
  | { kind: 'tools'; tools: ToolCall[] }

/** Flattens a message into spine entries in stream order. Consecutive tools coalesce into one run
 *  (so aggregation applies to a fan-out); entering plan mode breaks the run with a divider. */
function spineEntries(message: ChatMessage): SpineEntry[] {
  const out: SpineEntry[] = []
  if (message.blocks.length === 0) {
    // Rebuilt from disk: no stream order survives, so text, then the plan marker, then tools.
    if (message.text) out.push({ kind: 'text', text: message.text })
    if (message.tools.some((t) => isPlanEntry(t.name))) out.push({ kind: 'divider' })
    const tools = message.tools.filter((t) => !isTaskListTool(t.name) && !isPlanEntry(t.name))
    if (tools.length) out.push({ kind: 'tools', tools })
    return out
  }
  const byId = new Map(message.tools.map((t) => [t.id, t]))
  let run: ToolCall[] = []
  const flush = (): void => {
    if (run.length) out.push({ kind: 'tools', tools: run })
    run = []
  }
  for (const b of message.blocks) {
    if (b.kind === 'text') {
      flush()
      if (b.text.trim()) out.push({ kind: 'text', text: b.text })
      continue
    }
    if (b.kind === 'hook') {
      flush()
      out.push({ kind: 'hook', note: b })
      continue
    }
    const tc = byId.get(b.id)
    if (!tc) continue
    if (isPlanEntry(tc.name)) {
      flush()
      out.push({ kind: 'divider' })
    } else if (!isTaskListTool(tc.name)) run.push(tc)
  }
  flush()
  return out
}

function lastToolsIndex(entries: SpineEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].kind === 'tools') return i
  return -1
}

/** Items above the last tool run carry the line down; items after it (closing prose) don't. */
function SpineItems({ entries }: { entries: SpineEntry[] }): JSX.Element {
  const last = lastToolsIndex(entries)
  return (
    <>
      {entries.map((e, i) => {
        if (e.kind === 'tools') return <ToolGroup key={i} tools={e.tools} spine={i === last ? 'end' : 'through'} />
        return (
          <div key={i} className="spine-seg" data-seg={i < last ? 'through' : 'none'}>
            {e.kind === 'text' ? <Markdown text={e.text} /> : e.kind === 'hook' ? <HookNoteRow note={e.note} /> : <PlanModeDivider />}
          </div>
        )
      })}
    </>
  )
}

/**
 * A run of consecutive tool calls. On the spine, each row's bead sits on the line; 'end' marks the
 * run that carries the transcript item's last bead. SubagentView keeps the default 'off', which
 * puts beads inline because its column has no spine gutter.
 */
export function ToolGroup({
  tools,
  spine = 'off'
}: {
  tools: ToolCall[]
  spine?: 'off' | 'through' | 'end'
}): JSX.Element | null {
  if (tools.length === 0) return null
  const placement = spine === 'off' ? 'inline' : 'spine'
  if (tools.length <= AGGREGATE_ABOVE) {
    return (
      <>
        {tools.map((t, i) => (
          <InstrumentRow
            key={t.id}
            tool={t}
            placement={placement}
            seg={spine === 'end' && i === tools.length - 1 ? 'end' : 'through'}
          />
        ))}
      </>
    )
  }
  return (
    <AggregateRow
      tools={tools}
      placement={placement}
      seg={spine === 'end' ? 'end' : 'through'}
      collapse={tools.length >= COLLAPSE_AT}
    />
  )
}

function ThinkingBlock({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  return (
    <div className="text-xs">
      <button
        type="button"
        className="-ml-1.5 flex min-h-[24px] items-center gap-1 rounded px-1.5 text-xs text-faint transition-colors hover:text-content"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <IconChevron className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
        Reasoning
      </button>
      {open && (
        <div id={panelId} className="mt-1 border-l-2 border-border px-2.5 py-1.5 text-dim italic [&_*]:text-dim">
          <Markdown text={text} />
        </div>
      )}
    </div>
  )
}

/** A sent message's annotation block shows as chips; the block itself went to Claude only. Crops travel first
 *  among the images, in pin order, so the first ones are the chips' thumbnails. */
function UserContent({ message }: { message: ChatMessage }): JSX.Element {
  const { pins, text } = splitAnnotations(message.text)
  const all = message.attachments ?? []
  const images = all.filter((a) => a.kind === 'image')
  const thumbs = images.slice(0, pins.filter((p) => p.crop).length)
  const used = new Set<MessageAttachment>(thumbs)
  const rest = all.filter((a) => !used.has(a))
  let next = 0
  return (
    <>
      {pins.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {pins.map((p) => {
            const crop = p.crop ? thumbs[next++] : undefined
            return <AnnotationChip key={p.n} n={p.n} kind={p.kind} name={p.name} host={p.host} thumb={crop?.kind === 'image' ? crop.previewUrl : undefined} />
          })}
        </div>
      )}
      {rest.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {rest.map((att, i) => (
            <MessageAttachmentView key={i} att={att} />
          ))}
        </div>
      )}
      {text && <div className="whitespace-pre-wrap text-sm leading-relaxed text-content">{renderUserText(text)}</div>}
    </>
  )
}
