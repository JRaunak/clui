import { SIDE_HOOK_ALLOW, type ApiProvider } from '../../../shared/ipc'
import { relativeTo } from '../../../shared/context'
import type { ChatMessage, PendingPermission, PerSessionState, ShownAttachment, SideRefusal, ToolCall } from '../store'
import type { ProcessedAttachment, SideMeta } from './images'
import { RUN_WORDS, type RunState } from './agents'

/** The tools the deny hook lets run, minus ToolSearch (plumbing) and WebSearch where the provider has none. Known at
 *  fork time: the side's own init only arrives with its first turn, after the read-only line is sent. */
export const sideToolsAtFork = (provider: ApiProvider | null): string[] =>
  SIDE_HOOK_ALLOW.filter((t) => t !== 'ToolSearch' && !(t === 'WebSearch' && provider === 'bedrock'))

/** Sent as the first line of the first side message, never in the system prompt, which would miss the cache. */
export const SIDE_READ_ONLY_LINE = 'This is a read-only side chat. Only {tools} will run here; any other tool call is denied.'

const andList = (xs: readonly string[]): string => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : (xs[0] ?? ''))

export const readOnlyLine = (tools: readonly string[]): string => SIDE_READ_ONLY_LINE.replace('{tools}', andList(tools))

export const SIDE_TITLE = 'Side chat'

/** `/side <question>` or `/btw <question>`, the whole draft. The question may be empty. */
export function parseSide(text: string): { question: string } | null {
  const m = /^\/(?:side|btw)(?:\s+([\s\S]*))?$/.exec(text.trim())
  return m ? { question: m[1] ?? '' } : null
}

/** Why an entry point can't open a side chat, short enough for a row's meta. */
export const SIDE_REFUSAL: Record<SideRefusal, string> = {
  'not-live': 'Session stopped',
  stopped: 'Session stopped',
  'parent-closed': 'Session closed',
  quick: 'Not available in Quick sessions',
  'hooks-off': 'Needs hooks on to stay read-only',
  'no-first-message': 'Send a message first',
  'no-transcript': "This session isn't on disk yet"
}

/** The notice an entry point shows on refusal. Hooks-off says what to do; Configuration's switch doesn't relaunch. */
export const REFUSAL_NOTICE: Record<SideRefusal, string> = {
  'not-live': "This session stopped before it was saved, so side chat can't open. Start a new session.",
  stopped: 'This session has stopped.',
  'parent-closed': 'The session closed before the side chat opened.',
  quick: "Side chat isn't available in Quick sessions.",
  'hooks-off': 'Side chat needs hooks on to stay read-only. Turn hooks on in Configuration, then start a new session.',
  'no-first-message': 'Send a message first, then open a side chat.',
  'no-transcript': 'Side chat needs this session on disk. Send a message first.'
}

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
/** When the fork was taken, which is as far as the side can see. */
export const forkedAt = (ms: number): string => CLOCK.format(ms)

export const askOf = (p: PendingPermission): string => `Allow ${p.displayName || p.toolName}`

export type SidePhase = 'starting' | 'answering' | 'stopping' | 'needs' | 'failed' | 'ended' | 'idle'

type PhaseSlice = Pick<PerSessionState, 'exited' | 'pendingPermissions' | 'interrupting' | 'busy' | 'lastError' | 'side'>

export function sidePhase(x: PhaseSlice): SidePhase {
  if (x.exited) return 'ended'
  if (x.pendingPermissions.length) return 'needs'
  if (x.interrupting) return 'stopping'
  if (!x.side?.ready) return 'starting'
  if (x.busy) return 'answering'
  return x.lastError !== null ? 'failed' : 'idle'
}

/** Each phase as the run mark it shows, the word beside it and the word an accessible name speaks. Idle shows none. */
export const SIDE_RUN: Record<Exclude<SidePhase, 'idle'>, { state: RunState; word: string; spoken: string }> = {
  starting: { state: 'running', word: 'Starting', spoken: 'starting' },
  answering: { state: 'running', word: 'Answering', spoken: 'answering' },
  stopping: { state: 'stopping', word: RUN_WORDS.stopping.word, spoken: 'stopping' },
  needs: { state: 'needs', word: RUN_WORDS.needs.word, spoken: 'needs you' },
  failed: { state: 'failed', word: RUN_WORDS.failed.word, spoken: 'failed' },
  ended: { state: 'interrupted', word: 'Ended', spoken: 'ended' }
}

/** A turn whose result came back clean with text in it. Stopped, failed and running turns don't count. */
export const isAnswer = (m: ChatMessage): boolean => m.role === 'assistant' && !!m.turnEnd && !m.turnEnd.reason && !!m.text.trim()

/** The thread holds answers Claude hasn't seen. Hand back's enabled rule, both confirms and the dock line read it. */
export const unhanded = (x: Pick<PerSessionState, 'messages'>): boolean => x.messages.some(isAnswer)

/** What the fork could run, from its own init; the tool list Clui guessed at fork time until one arrives. */
export const sideTools = (initTools: readonly string[], provider: ApiProvider | null): string[] =>
  initTools.length ? SIDE_HOOK_ALLOW.filter((t) => t !== 'ToolSearch' && initTools.includes(t)) : sideToolsAtFork(provider)

export interface SideTurn {
  question: string
  answer: string
  evidence: string[]
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** A call that ran and came back clean, as its evidence line. Denials arrive as errors; the hook-error prefix is a
 *  second guard in case one ever doesn't. */
function evidenceOf(t: ToolCall, cwd: string): string | null {
  if (t.result === undefined || t.isError || t.stopped || t.notRun) return null
  if (t.result.startsWith('PreToolUse:') && t.result.includes(' hook error: ')) return null
  const i = (t.input ?? {}) as Record<string, unknown>
  const where = str(i.path)
  const at = where ? ` in ${relativeTo(cwd, where)}` : ''
  switch (t.name) {
    case 'Read': {
      const p = str(i.file_path)
      if (!p) return null
      const a = num(i.offset)
      const n = num(i.limit)
      const from = a ?? 1
      const range = n !== null ? (n === 1 ? `line ${from}` : `lines ${from}-${from + n - 1}`) : a !== null ? `from line ${a}` : ''
      return `Read ${relativeTo(cwd, p)}${range ? `, ${range}` : ''}`
    }
    case 'Grep':
    case 'Glob': {
      const p = str(i.pattern)
      return p && `${t.name} ${t.name === 'Grep' ? `"${p}"` : p}${at}`
    }
    case 'WebFetch': {
      const u = str(i.url)
      return u && `WebFetch ${u}`
    }
    case 'WebSearch': {
      const q = str(i.query)
      return q && `WebSearch "${q}"`
    }
    default:
      return null
  }
}

/** Each question with the first completed answer after it. The read-only line the first one was sent with isn't the
 *  user's, so it never goes back. */
export function sideTurns(x: Pick<PerSessionState, 'messages' | 'cwd' | 'side'>): SideTurn[] {
  const lead = x.side ? `${x.side.readOnly}\n\n` : null
  const out: SideTurn[] = []
  let q: string | null = null
  for (const m of x.messages) {
    if (m.role === 'user') q = lead && m.text.startsWith(lead) ? m.text.slice(lead.length) : m.text
    if (q === null || !isAnswer(m)) continue
    const texts = m.blocks.flatMap((b) => (b.kind === 'text' && b.text.trim() ? [b.text.trim()] : []))
    const evidence = [...new Set(m.tools.map((t) => evidenceOf(t, x.cwd)).filter((e) => e !== null))]
    out.push({ question: q.trim(), answer: texts.join('\n\n'), evidence })
    q = null
  }
  return out
}

const OPENING =
  "The user asked {asked} in a side chat: a read-only fork of this conversation with the same model. It saw this conversation only up to when it was opened, and it could only use {tools}. The evidence under each answer lists what the side read: it records where the answer came from, not that the answer is right. Build on the answers instead of redoing the side's work. Read a source yourself before you edit it, when an answer conflicts with something in this conversation, or when this conversation has changed that file."

/** The exact text handed back: the chip's card shows it and the wire carries it, so nothing reformats it later. */
export function sideThreadText(turns: readonly SideTurn[], tools: readonly string[]): string {
  const one = turns.length === 1
  const head = OPENING.replace('{asked}', one ? 'this question' : 'these questions').replace('{tools}', andList(tools))
  const body = turns.map((t, i) => {
    const n = one ? '' : ` ${i + 1}`
    const ev = t.evidence.length ? `Evidence${n}:\n${t.evidence.map((e) => `- ${e}`).join('\n')}` : `Evidence${n}: none, answered from the conversation.`
    return `Question${n}: ${t.question}\n\nAnswer${n}:\n${t.answer}\n\n${ev}`
  })
  return [head, ...body].join('\n\n')
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
export const sideCounts = ({ answers, sources }: SideMeta): string => [plural(answers, 'answer'), sources ? plural(sources, 'source') : ''].filter(Boolean).join(' · ')

export interface SideChat {
  text: string
  bytes: number
  side: SideMeta
}

/** A handed-back side chat that still carries its text, in the draft or a bubble sent this run. */
export const sideChatOf = (a: ProcessedAttachment | ShownAttachment): SideChat | null =>
  a.kind === 'text' && a.origin === 'side' && a.side && a.text !== undefined ? { text: a.text, bytes: a.bytes, side: a.side } : null
