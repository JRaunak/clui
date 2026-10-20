/**
 * Claude changes diffs, change marks, and frozen before/after snapshots for the editor. Hunks and
 * snapshots come from the ledger's own texts; the current file is read only to report drift and to
 * project marks, so later edits by anyone can't show as Claude's.
 */
import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { diffLines, structuredPatch, type ChangeObject, type StructuredPatch } from 'diff'
import { changeSelection, type ChangeMarks, type ChangeSelection, type DiffHunk, type DiffRequest, type DiffSegment, type FileDiff, type PatchHunk } from '../../shared/changes'
import type { ChangeSide } from '../../shared/context'
import type { ChangeRefRequest } from '../../shared/ipc'
import { survivingLines } from '../../shared/lines'
import { lineCount, type SegmentView } from './ledger'

const LINES_MAX = 50_000
const CHARS_MAX = 8 * 1024 * 1024
/** Git's default, so the hunks read like `git diff`. */
const CONTEXT = 3
/** A diff gets this long synchronously; one that runs over is redone in jsdiff's async callback mode, capped at YIELDING_MS. */
const INLINE_MS = 25
const YIELDING_MS = 2000
/** Projection past these marks nothing rather than risk attributing someone else's lines to Claude. */
const PROJECT_SEGMENTS = 16
const PROJECT_CHARS = 1024 * 1024

export interface DiffSource {
  segments(handleId: string, path: string): Promise<SegmentView[] | null>
  /** The file's current text and its readText revision, through the guard; null when it can't be read as text. */
  current(handleId: string, path: string): Promise<{ text: string; revision: string } | null>
}

export type OpenDiffResult = { ok: true } | { ok: false; message: string }

const hash = (...parts: string[]): string => createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)
const chars = (lines: string[]): number => lines.reduce((n, l) => n + l.length, 0)

export function parseDiffRequest(req: unknown): DiffRequest | null {
  const r = req && typeof req === 'object' ? (req as Record<string, unknown>) : null
  if (!r || typeof r.path !== 'string' || r.path.length > 4096) return null
  if (r.segmentId !== undefined && (typeof r.segmentId !== 'string' || r.segmentId.length > 64)) return null
  return typeof r.segmentId === 'string' ? { path: r.path, segmentId: r.segmentId } : { path: r.path }
}

async function hunksBetween(a: string, b: string): Promise<PatchHunk[] | null> {
  const quick = structuredPatch('', '', a, b, undefined, undefined, { context: CONTEXT, timeout: INLINE_MS })
  if (quick) return quick.hunks
  const slow = await new Promise<StructuredPatch | undefined>((resolve) =>
    structuredPatch('', '', a, b, undefined, undefined, { context: CONTEXT, timeout: YIELDING_MS, callback: resolve })
  )
  return slow?.hunks ?? null
}

/** A segment's hunk groups: its full diff when both texts are held and the diff finishes, else its edits' own
 *  hunks when every edit has them, else none. Diff display and mint both read this, so their hunk ids agree. */
function hunksOf(seg: SegmentView, full: PatchHunk[] | null): PatchHunk[][] {
  if (full) return [full]
  return seg.patches.every(Boolean) ? (seg.patches as PatchHunk[][]) : []
}

const fullOf = (s: SegmentView): Promise<PatchHunk[] | null> => (s.before !== undefined && s.after !== undefined ? hunksBetween(s.before, s.after) : Promise.resolve(null))

/** The file's segments oldest first. A segment whose full diff times out falls back to its edits' own hunks. */
export async function getDiff(src: DiffSource, handleId: string, req: DiffRequest): Promise<FileDiff | null> {
  const segs = await src.segments(handleId, req.path)
  if (!segs) return null
  const last = segs.at(-1)?.after
  const current = last === undefined ? null : await src.current(handleId, req.path)
  const fulls = await Promise.all(segs.map(fullOf))
  const where = current ? await project(segs, current.text, async (k) => fulls[k]) : null
  let lines = LINES_MAX
  let left = CHARS_MAX
  let truncated = false
  const take = (seg: SegmentView, hunks: PatchHunk[], mapped: boolean): DiffHunk[] => {
    const out: DiffHunk[] = []
    for (const h of hunks) {
      const n = chars(h.lines)
      if (truncated || h.lines.length > lines || n > left) {
        truncated = true
        break
      }
      lines -= h.lines.length
      left -= n
      const id = hunkId(seg.revision, h)
      const at = mapped ? where?.get(id) : undefined
      const range = at && !at.stale ? (at.bars.length ? { start: at.bars[0][0], end: at.bars.at(-1)![1] } : at.wedge ? { start: at.wedge.line, end: at.wedge.line } : undefined) : undefined
      out.push({ ...h, id, segmentId: seg.id, revision: seg.revision, ...(range ? { current: range } : {}) })
    }
    return out
  }
  const segments: DiffSegment[] = []
  for (const [i, seg] of segs.entries()) {
    if (truncated) break
    const full = fulls[i]
    // Some edits' hunks missing would show part of the segment as if it were all of it.
    const hunks = hunksOf(seg, full)
    const mode = full ? 'full' : hunks.length ? 'patch' : 'none'
    const groups = full ? [take(seg, full, true)] : hunks.map((p) => take(seg, p, false)).filter((g) => g.length)
    // The cap cut this segment off whole: the list ends before it, at the truncated row.
    if (truncated && !groups.some((g) => g.length)) break
    const snapshot = seg.before !== undefined && seg.after !== undefined
    segments.push({ id: seg.id, revision: seg.revision, mode, groups, outsideBefore: i > 0 && seg.provenBreak, snapshot })
  }
  return { path: req.path, segments, changedSince: current !== null && current.text !== last, truncated }
}

const HEX32 = /^[0-9a-f]{32}$/
const SIDES = new Set<unknown>(['diff', 'before', 'after'])
const row = (v: unknown, lo: number): v is number => Number.isSafeInteger(v) && (v as number) >= lo && (v as number) <= 100_000

export function parseChangeRefRequest(req: unknown): ChangeRefRequest | null {
  const r = req && typeof req === 'object' ? (req as Record<string, unknown>) : null
  if (!r || typeof r.path !== 'string' || !r.path.startsWith('/') || r.path.length > 4096 || r.path.includes('\0')) return null
  const ids = [r.segmentId, r.revision, r.hunkId]
  if (!ids.every((v) => typeof v === 'string' && HEX32.test(v)) || !SIDES.has(r.side)) return null
  const out: ChangeRefRequest = { path: r.path, segmentId: r.segmentId as string, revision: r.revision as string, hunkId: r.hunkId as string, side: r.side as ChangeSide }
  if (r.rows === undefined) return out
  const rows = r.rows && typeof r.rows === 'object' ? (r.rows as Record<string, unknown>) : null
  if (!rows || !row(rows.start, 1) || !row(rows.end, rows.start as number)) return null
  return { ...out, rows: { start: rows.start, end: rows.end } }
}

/** One hunk slice for mint, from ledger memory only: never the current file, Git or the disk. */
export async function selectChange(
  src: Pick<DiffSource, 'segments'>,
  handleId: string,
  req: ChangeRefRequest
): Promise<{ ok: true; sel: Extract<ChangeSelection, { ok: true }> } | { ok: false; reason: 'changed' | 'empty' | 'too-large'; lines?: number; bytes?: number }> {
  const seg = (await src.segments(handleId, req.path))?.find((s) => s.id === req.segmentId)
  if (!seg || seg.revision !== req.revision) return { ok: false, reason: 'changed' }
  const h = hunksOf(seg, await fullOf(seg))
    .flat()
    .find((x) => hunkId(seg.revision, x) === req.hunkId)
  if (!h) return { ok: false, reason: 'changed' }
  const sel = changeSelection(h, req.side, req.rows)
  return sel.ok ? { ok: true, sel } : { ok: false, reason: sel.reason, lines: sel.lines, bytes: sel.bytes }
}

const hunkId = (revision: string, h: PatchHunk): string => hash(revision, `${h.oldStart},${h.oldLines},${h.newStart},${h.newLines}`, h.lines.join('\n'))

async function changesBetween(a: string, b: string): Promise<ChangeObject<string>[] | null> {
  const quick = diffLines(a, b, { timeout: INLINE_MS })
  if (quick) return quick
  return (await new Promise<ChangeObject<string>[] | undefined>((resolve) => diffLines(a, b, { timeout: YIELDING_MS, callback: resolve }))) ?? null
}

async function lineMap(a: string, b: string): Promise<Int32Array | null> {
  if (a === b) return new Int32Array(lineCount(a)).map((_, i) => i)
  const changes = await changesBetween(a, b)
  return changes && survivingLines(changes, lineCount(a))
}

const compose = (first: Int32Array, then: Int32Array): Int32Array => first.map((i) => (i < 0 ? -1 : then[i]))

/** 1-based runs of consecutive line numbers. */
function runs(lines: number[]): [number, number][] {
  const out: [number, number][] = []
  for (const n of [...lines].sort((a, b) => a - b)) {
    const last = out.at(-1)
    if (last && n === last[1] + 1) last[1] = n
    else if (!last || n > last[1]) out.push([n, n])
  }
  return out
}

interface Placed {
  bars: [number, number][]
  wedge?: { line: number; count: number }
  /** Some of the hunk's added lines, or the spot of its removal, no longer exist as Claude left them. */
  stale: boolean
}

/**
 * Each hunk of every segment placed in the current text: its added lines and the spot of each pure
 * removal are carried through every later change (outside edits and Claude's own), and only what
 * survives unchanged is placed. Null when the record can't support it: a segment without both
 * texts, too many segments, a text too big, or a diff that runs out of time.
 */
async function project(segs: SegmentView[], current: string, patchOf: (k: number) => Promise<PatchHunk[] | null>): Promise<Map<string, Placed> | null> {
  const full = (s: SegmentView): boolean => s.before !== undefined && s.after !== undefined && Math.max(s.before.length, s.after.length) <= PROJECT_CHARS
  if (!segs.length || segs.length > PROJECT_SEGMENTS || !segs.every(full) || current.length > PROJECT_CHARS) return null
  // Right to left: each segment's after-text mapped into the current text.
  const toCurrent: Int32Array[] = []
  let next = await lineMap(segs.at(-1)!.after!, current)
  if (!next) return null
  toCurrent[segs.length - 1] = next
  for (let k = segs.length - 2; k >= 0; k--) {
    const outside = await lineMap(segs[k].after!, segs[k + 1].before!)
    const claude = await lineMap(segs[k + 1].before!, segs[k + 1].after!)
    if (!outside || !claude) return null
    next = compose(compose(outside, claude), next)
    toCurrent[k] = next
  }
  const currentLines = lineCount(current)
  const placed = new Map<string, Placed>()
  for (const [k, seg] of segs.entries()) {
    const patch = await patchOf(k)
    if (!patch) return null
    const map = toCurrent[k]
    for (const h of patch) {
      const bars: number[] = []
      let wedge: { line: number; count: number } | undefined
      let stale = false
      // 0-based index into the segment's after-text of the next new-side line.
      let n = h.newLines === 0 ? h.newStart : h.newStart - 1
      let removed = 0
      const flush = (followedByAdd: boolean): void => {
        if (removed && !followedByAdd) {
          const at = n < map.length ? map[n] : n > 0 && map[n - 1] >= 0 && map[n - 1] + 1 < currentLines ? map[n - 1] + 1 : -1
          if (at < 0) stale = true
          else wedge ??= { line: at + 1, count: removed }
        }
        removed = 0
      }
      for (const l of h.lines) {
        const c = l[0]
        if (c === '-') removed++
        else if (c === '+') {
          flush(true)
          if (map[n] >= 0) bars.push(map[n] + 1)
          else stale = true
          n++
        } else if (c === ' ') {
          flush(false)
          n++
        }
      }
      flush(false)
      placed.set(hunkId(seg.revision, h), { bars: runs(bars), ...(wedge ? { wedge } : {}), stale })
    }
  }
  return placed
}

/** An edit's first changed line from its own first hunk, numbered as the file stood after it. A later edit above it can
 *  have moved it since. Null when the edit isn't held or its hunks were evicted. */
export function editLine(segs: SegmentView[], editId: string): number | null {
  for (const s of segs) {
    const i = s.editIds.indexOf(editId)
    if (i < 0) continue
    const h = s.patches[i]?.[0]
    if (!h) return null
    return Math.max(1, h.newStart + Math.max(0, h.lines.findIndex((l) => !l.startsWith(' '))))
  }
  return null
}

/** Where Claude's changes survive in the file's current text, per Claude changes hunk; null when the path isn't held or can't be read. */
export async function changeMarks(src: DiffSource, handleId: string, path: string): Promise<ChangeMarks | null> {
  const [segs, current] = await Promise.all([src.segments(handleId, path), src.current(handleId, path)])
  if (!segs?.length || !current) return null
  const only = segs[0]
  if (segs.length === 1 && only.created && only.after === current.text) {
    const hunks = (await hunksBetween(only.before ?? '', only.after ?? '')) ?? []
    return { revision: current.revision, state: 'created', hunks: hunks.slice(0, 1).map((h) => ({ id: hunkId(only.revision, h), bars: [] })) }
  }
  const placed = await project(segs, current.text, (k) => hunksBetween(segs[k].before!, segs[k].after!))
  if (!placed) return { revision: current.revision, state: 'unavailable', hunks: [] }
  const hunks: ChangeMarks['hunks'] = []
  for (const [id, p] of placed) if (p.bars.length || p.wedge) hunks.push({ id, bars: p.bars, ...(p.wedge ? { wedge: p.wedge } : {}) })
  return { revision: current.revision, state: 'marked', hunks }
}

/**
 * Before/after files of a segment revision under `root`, read-only and written once per run, so
 * the editor compares exactly what Claude did. `root` is emptied when this starts and by `clear`.
 */
export function diffSnapshots(root: string, src: DiffSource, register: (handleId: string, path: string) => Promise<string | null>) {
  const cleared = rm(root, { recursive: true, force: true }).catch(() => {})
  const pairs = new Map<string, Promise<[string, string]>>()
  const registered = new Set<string>()

  const write = async (path: string, text: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text, { mode: 0o444 })
  }

  function freeze(revision: string, path: string, before: string, after: string): Promise<[string, string]> {
    let pair = pairs.get(revision)
    if (!pair) {
      const raw = basename(path)
      const name = raw === '.' || raw === '..' || !raw ? 'file' : raw
      const a = join(root, revision, 'a', name)
      const b = join(root, revision, 'b', name)
      pair = cleared.then(() => Promise.all([write(a, before), write(b, after)])).then((): [string, string] => [a, b])
      pairs.set(revision, pair)
      pair.catch(() => pairs.delete(revision))
    }
    return pair
  }

  /** Opens the request's segment, the file's latest by default, with `launch`. Never throws. */
  async function open(handleId: string, req: DiffRequest, editor: string, launch: (a: string, b: string) => Promise<void>): Promise<OpenDiffResult> {
    const name = basename(req.path)
    const segs = await src.segments(handleId, req.path).catch(() => null)
    const seg = req.segmentId ? segs?.find((s) => s.id === req.segmentId) : segs?.at(-1)
    if (!seg || seg.before === undefined || seg.after === undefined) {
      return { ok: false, message: `Couldn't open the diff for ${name}. The session record doesn't include the whole file from before and after Claude's changes.` }
    }
    let pair: [string, string]
    try {
      pair = await freeze(seg.revision, req.path, seg.before, seg.after)
    } catch (e) {
      return { ok: false, message: `Couldn't open the diff for ${name}. ${(e as Error).message}` }
    }
    const key = `${handleId}\0${seg.revision}`
    if (!registered.has(key)) {
      const ids = await Promise.all(pair.map((p) => register(handleId, p))).catch(() => null)
      if (!ids?.every(Boolean)) return { ok: false, message: `Couldn't open the diff for ${name}. Clui couldn't prepare the before and after copies for your editor. Try again.` }
      registered.add(key)
    }
    try {
      await launch(...pair)
      return { ok: true }
    } catch {
      return {
        ok: false,
        message: `Couldn't open the diff for ${name} in your editor. Clui runs "${editor}" with --diff; check it's on your PATH, or change Editor command in Settings.`
      }
    }
  }

  const clear = (): void => rmSync(root, { recursive: true, force: true })
  return { open, clear }
}
