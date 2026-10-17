/**
 * Claude's change ledger: what Claude's successful Edit/Write/NotebookEdit calls did to each file,
 * keyed by CLI session id. Live results are read off the raw stream before mapping; a resume
 * rebuilds from the jsonl, because `--resume` replays nothing on the stream.
 *
 * A file's edits form one segment while each edit's before-text equals the previous edit's
 * after-text. Anything else (the user, Bash, a formatter) closes the segment, so changes made
 * between Claude's edits never count as Claude's.
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { applyPatch as applyHunks, diffLines, type Change } from 'diff'
import type { FileChangeSummary, PatchHunk } from '../../shared/changes'
import { sessionTranscriptFiles } from '../sessions/transcript'

const TEXT_BUDGET = 64 * 1024 * 1024
/** Above this a segment's net count is its summed patch counts, disclosed as approximate. */
const FULL_DIFF_MAX = 1024 * 1024
/** A diff gets this long inline; a slower one continues in jsdiff's yielding mode up to the long deadline. */
const INLINE_DIFF_MS = 25
const YIELDING_DIFF_MS = 2000
/** tool_use blocks still waiting for their result; a call that never answers can't grow this. */
const PENDING_MAX = 256

// 2.1.296 has no MultiEdit, but older transcripts do. It takes the Edit path: counted from its
// patch when the result has one, else a row with unknown counts.
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

export interface ClaudeEdit {
  id: string
  origin: string
  path: string
  sourceId: string
  at: number
  before?: string
  after?: string
  created: boolean
  userModified: boolean
  added: number | null
  removed: number | null
  approximate: boolean
  /** A diff of the file's texts measures this edit. A notebook's re-serialized JSON doesn't. */
  textual: boolean
  /** The result's own hunks, with line numbers from the time of the edit. */
  patch?: PatchHunk[]
}

interface Counts {
  added: number
  removed: number
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

export function lineCount(text: string): number {
  if (!text) return 0
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

export function patchCounts(hunks: PatchHunk[]): Counts {
  let added = 0
  let removed = 0
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.startsWith('+')) added++
      else if (l.startsWith('-')) removed++
    }
  }
  return { added, removed }
}

/** The text after `hunks`, or null when they don't apply exactly to `text`. */
export function applyPatch(text: string, hunks: PatchHunk[]): string | null {
  const out = applyHunks(text, { oldFileName: undefined, newFileName: undefined, oldHeader: undefined, newHeader: undefined, hunks })
  return out === false ? null : out
}

function tally(changes: Change[] | undefined): Counts | null {
  if (!changes) return null
  let added = 0
  let removed = 0
  for (const c of changes) {
    if (c.added) added += c.count
    else if (c.removed) removed += c.count
  }
  return { added, removed }
}

const fragmentCounts = (a: string, b: string): Counts | null => tally(diffLines(a, b, { timeout: INLINE_DIFF_MS }))

/** jsdiff's callback mode yields after every step, so a big diff never blocks session input. */
async function fileCounts(a: string, b: string): Promise<Counts | null> {
  return (
    fragmentCounts(a, b) ??
    new Promise((resolve) => diffLines(a, b, { timeout: YIELDING_DIFF_MS, callback: (c) => resolve(tally(c)) }))
  )
}

function hunksOf(v: unknown): PatchHunk[] | null {
  if (!Array.isArray(v)) return null
  const ok = v.every((h) => obj(h) && Array.isArray((h as Obj).lines) && ((h as Obj).lines as unknown[]).every((l) => typeof l === 'string'))
  return ok ? (v as PatchHunk[]) : null
}

interface Where {
  origin: string
  sourceId: string
  at: number
}

/**
 * One successful edit from its tool_use input and raw result, or null when it isn't one. A
 * subagent's edit carries no result at all (verified 2.1.296), so it's counted from its input.
 */
export function normalizeEdit(id: string, name: string, input: Obj, result: unknown, where: Where): ClaudeEdit | null {
  // An interrupted call's result is the bare string "User rejected tool use".
  if (typeof result === 'string') return null
  const r = obj(result)
  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(r?.filePath) ?? str(r?.notebook_path)
  if (!path) return null
  const edit: ClaudeEdit = { id, path, ...where, created: false, userModified: false, added: null, removed: null, approximate: false, textual: true }
  const counted = (c: Counts | null, approximate: boolean): ClaudeEdit =>
    c ? { ...edit, added: c.added, removed: c.removed, approximate } : edit

  if (name === 'NotebookEdit') {
    edit.textual = false
    if (!r) return edit
    edit.before = str(r.original_file)
    edit.after = str(r.updated_file)
    // Cell lines, not the file's: the CLI re-serializes the notebook JSON on every edit.
    const next = str(r.new_source) ?? str(input.new_source) ?? ''
    const prev = str(r.old_source)
    const mode = str(r.edit_mode) ?? str(input.edit_mode)
    if (mode === 'insert') return counted({ added: lineCount(next), removed: 0 }, true)
    if (prev === undefined) return edit
    return counted(mode === 'delete' ? { added: 0, removed: lineCount(prev) } : fragmentCounts(prev, next), true)
  }

  if (name === 'Write') {
    const content = str(r?.content) ?? str(input.content)
    if (!r || content === undefined) return edit
    edit.after = content
    if (r.type === 'create') return { ...edit, before: '', created: true, added: lineCount(content), removed: 0 }
    edit.before = str(r.originalFile)
    const hunks = hunksOf(r.structuredPatch)
    if (hunks?.length) edit.patch = hunks
    return counted(hunks ? patchCounts(hunks) : edit.before !== undefined ? fragmentCounts(edit.before, content) : null, false)
  }

  const hunks = hunksOf(r?.structuredPatch)
  if (!r || !hunks) {
    // replace_all hides how many places changed.
    if (input.replace_all === true) return edit
    const prev = str(input.old_string)
    const next = str(input.new_string)
    return prev !== undefined && next !== undefined ? counted(fragmentCounts(prev, next), true) : edit
  }
  edit.userModified = r.userModified === true
  if (hunks.length) edit.patch = hunks
  // The jsonl drops originalFile past 10,000 chars, so a replayed big edit has its patch only.
  edit.before = str(r.originalFile)
  if (edit.before !== undefined) edit.after = applyPatch(edit.before, hunks) ?? undefined
  const opaque = edit.before !== undefined && edit.after === undefined
  return counted(patchCounts(hunks), opaque)
}

interface Segment {
  id: string
  editIds: string[]
  /** Each edit's own hunks, null where the result had none or they were evicted. */
  patches: (PatchHunk[] | null)[]
  /** The break before this segment was a proven text mismatch rather than missing evidence. */
  provenBreak: boolean
  before?: string
  after?: string
  beforeHash?: string
  afterHash?: string
  revision: string
  created: boolean
  textual: boolean
  /** Edit counts summed, null when any edit's counts are unknown. */
  sum: Counts | null
  sumApprox: boolean
  added: number | null
  removed: number | null
  approximate: boolean
  dirty: boolean
  evicted: boolean
}

interface FileState {
  path: string
  segments: Segment[]
  lastSeq: number
}

interface Arrival {
  id: string
  name: string
  input: Obj
  result: unknown
  where: Where
}

interface SessionState {
  key: string
  files: Map<string, FileState>
  /** Every segment in creation order, the eviction order. */
  order: Segment[]
  seen: Set<string>
  pending: Map<string, { name: string; input: Obj }>
  inbox: Arrival[]
  textChars: number
  seq: number
  replay: Promise<void> | null
  flush: Promise<void> | null
}

/** A file's segment as getDiff reads it: a copy, so a later edit can't change it underneath. */
export interface SegmentView {
  id: string
  revision: string
  editIds: string[]
  patches: (PatchHunk[] | null)[]
  before?: string
  after?: string
  provenBreak: boolean
  created: boolean
}

const patchChars = (p: PatchHunk[] | null | undefined): number => p?.reduce((n, h) => n + h.lines.reduce((m, l) => m + l.length, 0), 0) ?? 0

const hash = (...parts: string[]): string => createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)

export type PublishFn = (handleId: string, summaries: FileChangeSummary[]) => void

export class ChangeLedger {
  private sessions = new Map<string, SessionState>()
  private handles = new Map<string, string>()
  private publish: PublishFn
  private textBudget: number

  constructor(publish: PublishFn, textBudget = TEXT_BUDGET) {
    this.publish = publish
    this.textBudget = textBudget
  }

  /**
   * Bind a handle to its ledger key: the session id when it's known up front (a resume), else the
   * handle itself until `rekey`. A fork starts under its handle with the source's history replayed.
   */
  attach(handleId: string, key: string): void {
    this.handles.set(handleId, key)
    if (!this.sessions.has(key)) this.sessions.set(key, newState(key))
  }

  rekey(handleId: string, sessionId: string): void {
    const from = this.handles.get(handleId)
    if (!from || from === sessionId) return
    const state = this.sessions.get(from)
    this.handles.set(handleId, sessionId)
    if (!state) return
    if (![...this.handles.values()].includes(from)) this.sessions.delete(from)
    state.key = sessionId
    this.sessions.set(sessionId, state)
  }

  detach(handleId: string): void {
    const key = this.handles.get(handleId)
    this.handles.delete(handleId)
    if (key && ![...this.handles.values()].includes(key)) this.sessions.delete(key)
  }

  /** Feed one raw stream envelope. Cheap: the work runs on the next turn of the event loop. */
  wire(handleId: string, raw: unknown): void {
    const state = this.stateOf(handleId)
    const env = obj(raw)
    if (!state || !env) return
    const content = obj(env.message)?.content
    if (!Array.isArray(content)) return
    const where = { origin: str(env.session_id) ?? state.key, sourceId: str(env.parent_tool_use_id) ?? 'main', at: Date.now() }
    const before = state.inbox.length
    correlate(state.pending, content, env.tool_use_result, where, (a) => state.inbox.push(a))
    if (state.inbox.length > before) this.schedule(state)
  }

  /** Rebuild from the transcripts. Live arrivals wait in the inbox so replayed edits stay first. */
  replay(handleId: string, sessionId: string): Promise<void> {
    const state = this.stateOf(handleId)
    if (!state) return Promise.resolve()
    state.replay = readReplay(sessionId)
      .catch(() => [] as Arrival[])
      .then((arrivals) => {
        state.inbox.unshift(...arrivals)
        state.replay = null
        this.schedule(state)
      })
    return state.replay
  }

  /** Current summaries once pending work settles, or null for a handle the ledger doesn't hold. */
  async changes(handleId: string): Promise<FileChangeSummary[] | null> {
    const state = this.stateOf(handleId)
    if (!state) return null
    await state.replay
    while (state.flush) await state.flush
    return summarize(state)
  }

  /** One file's segments once pending work settles; null for a handle or path the ledger doesn't hold. */
  async segments(handleId: string, path: string): Promise<SegmentView[] | null> {
    const state = this.stateOf(handleId)
    if (!state) return null
    await state.replay
    while (state.flush) await state.flush
    const file = state.files.get(path)
    return (
      file?.segments.map((s) => ({
        id: s.id,
        revision: s.revision,
        editIds: [...s.editIds],
        patches: [...s.patches],
        before: s.before,
        after: s.after,
        provenBreak: s.provenBreak,
        created: s.created
      })) ?? null
    )
  }

  private stateOf(handleId: string): SessionState | undefined {
    const key = this.handles.get(handleId)
    return key ? this.sessions.get(key) : undefined
  }

  private schedule(state: SessionState): void {
    if (state.flush || state.replay) return
    state.flush = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.drain(state))
      .catch((err) => console.error('[ledger] recount failed:', err))
      .finally(() => {
        state.flush = null
        if (state.inbox.length) this.schedule(state)
      })
  }

  private async drain(state: SessionState): Promise<void> {
    for (let a = state.inbox.shift(); a; a = state.inbox.shift()) {
      if (state.seen.has(a.id)) continue
      const edit = normalizeEdit(a.id, a.name, a.input, a.result, a.where)
      if (!edit) continue
      state.seen.add(a.id)
      this.add(state, edit)
    }
    for (const seg of state.order) {
      if (!seg.dirty) continue
      seg.dirty = false
      await recount(seg)
      // A replay can recount hundreds of segments; let stdout and IPC through between file diffs.
      if (seg.editIds.length > 1) await new Promise((resolve) => setImmediate(resolve))
    }
    if (this.sessions.get(state.key) !== state) return
    const summaries = summarize(state)
    for (const [handleId, key] of this.handles) if (key === state.key) this.publish(handleId, summaries)
  }

  private add(state: SessionState, e: ClaudeEdit): void {
    let file = state.files.get(e.path)
    if (!file) state.files.set(e.path, (file = { path: e.path, segments: [], lastSeq: 0 }))
    file.lastSeq = ++state.seq
    const last = file.segments.at(-1)
    if (last && last.after !== undefined && e.before === last.after && !e.userModified) {
      last.editIds.push(e.id)
      // An evicted segment can't show its edits whole, so it keeps no new hunks either.
      const patch = last.evicted ? null : (e.patch ?? null)
      last.patches.push(patch)
      state.textChars += (e.after?.length ?? 0) - last.after.length + patchChars(patch)
      last.after = e.after
      last.sum = last.sum && e.added !== null && e.removed !== null ? { added: last.sum.added + e.added, removed: last.sum.removed + e.removed } : null
      last.sumApprox ||= e.approximate
      last.textual &&= e.textual
      last.dirty = true
    } else {
      const seg: Segment = {
        id: hash(e.origin, e.path, e.id),
        editIds: [e.id],
        patches: [e.patch ?? null],
        provenBreak: !last || (last.after !== undefined && e.before !== undefined),
        before: e.before,
        after: e.after,
        revision: '',
        created: e.created,
        textual: e.textual,
        sum: e.added !== null && e.removed !== null ? { added: e.added, removed: e.removed } : null,
        sumApprox: e.approximate,
        added: null,
        removed: null,
        approximate: false,
        dirty: true,
        evicted: false
      }
      state.textChars += (e.before?.length ?? 0) + (e.after?.length ?? 0) + patchChars(e.patch)
      file.segments.push(seg)
      state.order.push(seg)
    }
    this.evict(state)
  }

  /**
   * Over budget, drop texts oldest first, keeping counts. Closed segments go before open ones,
   * and an open segment keeps its after-text, which the next edit's continuity check needs.
   */
  private evict(state: SessionState): void {
    if (state.textChars <= this.textBudget) return
    const open = new Set([...state.files.values()].map((f) => f.segments.at(-1)))
    for (const pass of [false, true]) {
      for (const seg of state.order) {
        if (state.textChars <= this.textBudget) return
        const isOpen = open.has(seg)
        if (isOpen !== pass || seg.evicted) continue
        seg.beforeHash ??= seg.before === undefined ? '' : hash(seg.before)
        state.textChars -= (seg.before?.length ?? 0) + seg.patches.reduce((n, p) => n + patchChars(p), 0)
        seg.before = undefined
        seg.patches = seg.patches.map(() => null)
        if (!isOpen) {
          seg.afterHash = seg.after === undefined ? '' : hash(seg.after)
          state.textChars -= seg.after?.length ?? 0
          seg.after = undefined
        }
        seg.evicted = true
      }
    }
  }
}

function newState(key: string): SessionState {
  return { key, files: new Map(), order: [], seen: new Set(), pending: new Map(), inbox: [], textChars: 0, seq: 0, replay: null, flush: null }
}

/** Pair tool_use blocks with their tool_result blocks across envelopes. */
function correlate(
  pending: Map<string, { name: string; input: Obj }>,
  content: unknown[],
  result: unknown,
  where: Where,
  emit: (a: Arrival) => void
): void {
  // The envelope's result belongs to its tool_result only when there's exactly one.
  const results = content.filter((b) => obj(b)?.type === 'tool_result').length
  for (const raw of content) {
    const b = obj(raw)
    if (!b) continue
    if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string' && EDIT_TOOLS.has(b.name)) {
      if (pending.size >= PENDING_MAX) pending.delete(pending.keys().next().value as string)
      pending.set(b.id, { name: b.name, input: obj(b.input) ?? {} })
    } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      const call = pending.get(b.tool_use_id)
      if (!call) continue
      pending.delete(b.tool_use_id)
      if (b.is_error === true) continue
      emit({ id: b.tool_use_id, ...call, result: results === 1 ? result : undefined, where })
    }
  }
}

async function recount(seg: Segment): Promise<void> {
  const single = seg.editIds.length === 1
  let counts = seg.sum
  let approximate = seg.sumApprox || (!single && !!seg.sum)
  if (!single && seg.textual && seg.before !== undefined && seg.after !== undefined && Math.max(seg.before.length, seg.after.length) <= FULL_DIFF_MAX) {
    const net = await fileCounts(seg.before, seg.after)
    if (net) {
      counts = net
      approximate = false
    }
  }
  seg.added = counts?.added ?? null
  seg.removed = counts?.removed ?? null
  seg.approximate = !!counts && approximate
  seg.beforeHash ??= seg.before === undefined ? '' : hash(seg.before)
  seg.revision = hash(seg.id, seg.editIds.join(','), seg.beforeHash, seg.after === undefined ? (seg.afterHash ?? '') : hash(seg.after))
}

function summarize(state: SessionState): FileChangeSummary[] {
  return [...state.files.values()]
    .sort((a, b) => b.lastSeq - a.lastSeq)
    .map(({ path, segments }) => {
      const known = segments.filter((s) => s.added !== null)
      const total = (k: 'added' | 'removed'): number | null => (known.length ? known.reduce((n, s) => n + (s[k] ?? 0), 0) : null)
      return {
        path,
        added: total('added'),
        removed: total('removed'),
        created: segments[0].created,
        missingOnDisk: !existsSync(path),
        approximate:
          known.length > 0 &&
          (known.length < segments.length || segments.some((s, i) => s.approximate || (i > 0 && !s.provenBreak))),
        diffAvailable: segments.every((s) => (s.before !== undefined && s.after !== undefined) || s.patches.every(Boolean)),
        snapshot: segments.at(-1)?.before !== undefined && segments.at(-1)?.after !== undefined,
        segments: segments.length,
        editIds: segments.flatMap((s) => s.editIds)
      }
    })
}

/** Replay arrivals from the main transcript and every subagent/workflow-agent transcript, merged by time. */
async function readReplay(sessionId: string): Promise<Arrival[]> {
  const { main, agents } = await sessionTranscriptFiles(sessionId)
  const all: Arrival[] = []
  for (const file of main ? [main, ...agents] : agents) all.push(...(await readArrivals(file)))
  // Stable, so records with equal stamps keep their order within a source.
  return all.sort((a, b) => a.where.at - b.where.at)
}

async function readArrivals(file: string): Promise<Arrival[]> {
  const out: Arrival[] = []
  const pending = new Map<string, { name: string; input: Obj }>()
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      // Cheap prefilter: only records naming a tool block can carry an edit.
      if (!line.includes('"tool_')) continue
      let rec: Obj | null
      try {
        rec = obj(JSON.parse(line))
      } catch {
        continue
      }
      // api-request-blob records (2.1.300+) repeat a turn's tool blocks with no timestamp or
      // toolUseResult. Their zero stamp sorts them first, so they would claim the ids and the
      // real records would be dropped as repeats.
      if (rec?.type !== 'user' && rec?.type !== 'assistant') continue
      const content = obj(rec.message)?.content
      if (!Array.isArray(content)) continue
      const where = { origin: str(rec.sessionId) ?? '', sourceId: str(rec.agentId) ?? 'main', at: Date.parse(str(rec.timestamp) ?? '') || 0 }
      correlate(pending, content, rec.toolUseResult, where, (a) => out.push(a))
    }
  } finally {
    rl.close()
  }
  return out
}
