import { clipName, hostOf, pinWords } from '../../../shared/annotate'
import { changeLabel, changeTail, docPages, imagePx, imageTail, MAX_REFS, refLabel, type ChangeSide, type ContextReference, type LineRange, type RefInput, type ReferenceInvalidation } from '../../../shared/context'
import { CHANGE_BYTES_MAX, CHANGE_LINES_MAX, CHANGE_TEXT_BUDGET } from '../../../shared/changes'
import { WORKSPACE_FILE_CAP } from '../../../shared/files'

type Reason = ReferenceInvalidation['reason']

export const baseOf = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p

export const rangeText = ({ start, end }: LineRange): string => `L${start}${end > start ? `–${end}` : ''}`

const spokenRange = ({ start, end }: LineRange): string => (end > start ? `lines ${start} to ${end}` : `line ${start}`)
const bareRange = ({ start, end }: LineRange): string => (end > start ? `${start} to ${end}` : `${start}`)

type ChangeInput = Extract<RefInput, { kind: 'change' }>

/** A diff slice's lines: `lines 40 to 45 before and 41 to 53 after`, `removed lines 40 to 45`. */
function diffWords(r: Pick<ChangeInput, 'old' | 'new'>): string {
  if (r.old && r.new) return `${spokenRange(r.old)} before and ${bareRange(r.new)} after`
  return r.old ? `removed ${spokenRange(r.old)}` : r.new ? `added ${spokenRange(r.new)}` : ''
}

const sideRange = (r: Pick<ChangeInput, 'side' | 'old' | 'new'>): LineRange | undefined => (r.side === 'before' ? r.old : r.new)

/** `mcp.ts change, before side, lines 40 to 45`, `mcp.ts change, lines 40 to 45 before and 41 to 53 after`. Also
 *  speaks a selection that isn't minted yet. */
export function spokenChange(r: Pick<ChangeInput, 'path' | 'side' | 'old' | 'new'>): string {
  return `${baseOf(r.path)} change, ${changeWords(r)}`
}

/** The side and range words of a spoken change, without its file. */
export function changeWords(r: Pick<ChangeInput, 'side' | 'old' | 'new'>): string {
  if (r.side === 'diff') return diffWords(r)
  const range = sideRange(r)
  return `${r.side} side${range ? `, ${spokenRange(range)}` : ''}`
}

/** What a notice names a removed reference by: the range for a selection, the file, side and range for a change, else
 *  the chip's label. */
export function shortLabel(r: ContextReference): string {
  // A change notice gathers every file's removed refs, so each names its file.
  if (r.kind === 'change') return changeLabel(r.path, r.side, r.old, r.new)
  if (r.kind === 'image') return imageTail(r, false)
  if (r.kind === 'doc') return docWhat(r)
  return r.kind === 'file' && r.lines ? rangeText(r.lines) : refLabel(r)
}

type DocInput = Extract<RefInput, { kind: 'doc' }>

/** `text on pages 12 to 14`, `a region on page 12`, `a point on page 12`. */
export const docWhat = (r: Pick<DocInput, 'page' | 'endPage' | 'text' | 'region'>): string => `${r.text ? 'text' : r.region ? 'a region' : 'a point'} on ${docPages(r)}`

export const quoteStart = (quote: string, n: number): string => {
  const cp = [...quote]
  return cp.length > n ? `${cp.slice(0, n).join('')}…` : quote
}

/** `manager.ts`, or the page's host. */
export function resourceLabel(r: ContextReference): string {
  return r.kind === 'browser' ? hostOf(r.pin.target.url) || 'The page' : baseOf(r.path)
}

/** `manager.ts, lines 142 to 158`, `browser folder`, `button Sign in`. */
export function spokenRef(r: RefInput): string {
  switch (r.kind) {
    case 'file':
      return r.lines ? `${baseOf(r.path)}, ${spokenRange(r.lines)}` : baseOf(r.path)
    case 'folder':
      return `${baseOf(r.path)} folder`
    case 'browser':
    case 'page': {
      const { kind, name } = pinWords(r.kind === 'browser' ? r.pin.target : r.target)
      return name ? `${kind} ${clipName(name)}` : kind
    }
    case 'change':
      return spokenChange(r)
    case 'image':
      return `${baseOf(r.path)}, ${spokenImage(r)}`
    case 'doc':
      return `${baseOf(r.path)}, ${docPages(r)}, ${r.text ? `text "${quoteStart(r.text.quote, 80)}"` : r.region ? 'region' : 'point'}`
    default:
      return r satisfies never
  }
}

/** `region 640 by 320 at 120, 48`, `point at 412, 96`. */
export function spokenImage(r: Parameters<typeof imagePx>[0]): string {
  const p = imagePx(r)
  return p.w === undefined ? `point at ${p.x}, ${p.y}` : `region ${p.w} by ${p.h} at ${p.x}, ${p.y}`
}

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** `Lines 142–158 selected`. */
export const selectedText = ({ start, end }: LineRange): string => `${end > start ? `Lines ${start}–${end}` : `Line ${start}`} selected`

/** `Added lines 142 to 158 of manager.ts to the message.` */
export function addedText(r: RefInput, queued = false): string {
  const what =
    r.kind === 'file' && r.lines ? `${spokenRange(r.lines)} of ${baseOf(r.path)}` : r.kind === 'doc' ? `${docWhat(r)} of ${baseOf(r.path)}` : r.kind === 'change' ? `${spokenRef(r)},` : spokenRef(r)
  return `Added ${what} to the ${queued ? 'queued ' : ''}message.`
}

export const couldNotAdd = (r: RefInput): string => `Couldn't add ${spokenRef(r)}.`

const count = new Intl.NumberFormat('en-US')

/** The `@` menu's footer when main stopped listing at the cap. */
export const truncatedText = `Only the first ${count.format(WORKSPACE_FILE_CAP)} files are searched. Add others from the file tree.`

export const showingText = (shown: number, total: number): string => `Showing ${shown} of ${count.format(total)} files. Keep typing to narrow them.`

export const noMatchText = (q: string): string => `No files match “${q}”.`

/** The row note when a drop ran into the cap: the rest are skipped, never sent as text instead. */
export const skippedNote = (n: number): string => `${MAX_REFS} references max. ${n} ${n === 1 ? 'file was' : 'files were'} not added.`

/** One drop's announcement: `Added 3 references to the message. 1 was already attached.` */
export function dropText(added: readonly RefInput[], mentions: { inside: number; outside: number }, dupes: readonly RefInput[], skipped: number): string {
  const { inside, outside } = mentions
  if (dupes.length === 1 && !added.length && !inside && !outside && !skipped) return `Already attached: ${spokenRef(dupes[0])}`
  return [
    added.length === 1 ? addedText(added[0]) : added.length ? `Added ${added.length} references to the message.` : '',
    outside === 1 ? '1 file outside this folder was added as an @ mention.' : outside ? `${outside} files outside this folder were added as @ mentions.` : '',
    inside === 1 ? '1 file was added as an @ mention.' : inside ? `${inside} files were added as @ mentions.` : '',
    dupes.length ? `${dupes.length} ${dupes.length === 1 ? 'was' : 'were'} already attached.` : '',
    skipped ? skippedNote(skipped) : ''
  ]
    .filter(Boolean)
    .join(' ')
}

export const BUDGET_NOTE = `${CHANGE_TEXT_BUDGET / 1024} KB of changes max per message. Remove one to make room.`

/** A note in a tooltip: its first 200 characters. */
export const noteTitle = (note: string): string => `Note: ${note.length > 200 ? `${note.slice(0, 200)}…` : note}`

export const POINT_HINT = 'Click line numbers, or press Shift and an arrow key.'
export const POINT_BLOCK_HINT = "Click a block's line number, or press Shift and an arrow key."
export const POINT_OFF = 'Pointing off.'

const kb = (bytes: number): number => Math.ceil(bytes / 1024)
const rowsText = (n: number): string => `${n} ${n === 1 ? 'row' : 'rows'}`

export const CHANGE_DENIED = "Claude can't read changes in this session"
export const CHANGE_DENIED_HERE = "Claude can't read changes here"
export const CHANGE_CLEARED = 'This change was updated, so the selection was cleared.'
export const CHANGE_REGION_HINT = 'Click line numbers, or press Shift and an arrow key, to select rows in one hunk. Enter adds them to the message.'
export const CHANGE_UNAVAILABLE = 'Claude can no longer read this change.'
export const READ_CHANGE = 'Read change'

/** The Diff bar's label: `3 rows selected`, `Whole hunk selected, 12 rows`. */
export const changeSelectedText = (rows: number, whole: boolean): string => (whole ? `Whole hunk selected, ${rowsText(rows)}` : `${rowsText(rows)} selected`)

/** The trailing announcement for a Diff selection, with the fallback's reason when the side had to move. */
export function changeSelectedSpoken(rows: number, whole: boolean, side: ChangeSide, fellFrom?: ChangeSide): string {
  if (fellFrom) return `${changeSelectedText(rows, whole)}. ${capital(fellFrom)} side has no lines here, so diff side is selected`
  return `${changeSelectedText(rows, whole)}, ${side} side`
}

/** `Too large to add: 512 lines, 400 max`. Lines win over bytes: rows are what the user can act on. */
export function tooLargeText(lines: number, bytes: number): string {
  return lines > CHANGE_LINES_MAX ? `Too large to add: ${lines} lines, ${CHANGE_LINES_MAX} max` : `Too large to add: ${kb(bytes)} KB, ${CHANGE_BYTES_MAX / 1024} KB max`
}

export const SIDE_TITLE: Record<ChangeSide, string> = {
  diff: 'The rows with their + and − signs',
  before: "These lines before Claude's change",
  after: "These lines after Claude's change"
}
export const emptySideTitle = (side: ChangeSide): string => `No ${side} lines in this selection`

/** Why a Diff add didn't happen, for the source's live region. */
export function changeRefusedText(reason: 'changed' | 'empty' | 'too-large' | 'denied' | 'unavailable', size?: { lines: number; bytes: number }): string {
  switch (reason) {
    case 'changed':
      return `${CHANGE_CLEARED} Select it again.`
    case 'denied':
      return `${CHANGE_DENIED}. Nothing was added.`
    case 'too-large':
      return `${tooLargeText(size?.lines ?? 0, size?.bytes ?? 0)}. Select fewer rows.`
    case 'empty':
      return 'There are no lines on that side to add.'
    case 'unavailable':
      return "The session isn't running, so nothing was added."
  }
}

const isChangeNotice = (n: ReferenceInvalidation): boolean => n.resourceId.startsWith('change:')
const isPinNotice = (n: ReferenceInvalidation): boolean => /^(browser|page):/.test(n.resourceId)

/** Change refs lose access as a set, never per file: Claude's tool went, or the draft moved to another session. */
const changeLead = (reason: Reason): string => (reason === 'session' ? "Changes can't move to a new session" : CHANGE_DENIED)

/** `The before side of mcp.ts lines 40 to 45`. */
function changeWhat(r: ChangeInput): string {
  if (r.side === 'diff') {
    const what = r.old && r.new ? diffWords(r) : r.old ? `deleting ${spokenRange(r.old)}` : r.new ? `adding ${spokenRange(r.new)}` : ''
    return `The diff of ${baseOf(r.path)} ${what}`
  }
  const range = sideRange(r)
  return `The ${r.side} side of ${baseOf(r.path)}${range ? ` ${spokenRange(range)}` : ''}`
}

/** Only a source that is still there can be opened to pick again. */
export const canReopen = (reason: Reason): boolean => reason === 'changed' || reason === 'out-of-range' || reason === 'navigated'

/** What happened to the source, with no full stop: `manager.ts changed`. `label` is a basename, a host, or
 *  `The page` for a page with no host. */
function leadOf(label: string, reason: Reason): string {
  const host = label === 'The page' ? '' : label
  switch (reason) {
    case 'missing':
      return `${label} was deleted or moved`
    case 'denied':
      return `This session can't read ${label}`
    case 'closed':
      return host ? `The ${host} tab was closed` : 'The tab was closed'
    case 'session':
      return `${label} was open in the previous session`
    default:
      return `${label} changed`
  }
}

/** `manager.ts changed. Lines 142 to 158 were removed from the message.` */
export function removalSpoken(lost: readonly ContextReference[], reason: Reason): string {
  const first = lost[0]
  if (first.kind === 'change') return `${changeLead(reason)}. ${lost.length > 1 ? `${lost.length} changes were` : `${changeWhat(first)} was`} removed from the message.`
  const page = first.kind === 'browser' || first.kind === 'page'
  const what =
    lost.length > 1
      ? `${lost.length} ${page ? 'elements' : 'selections'} were`
      : first.kind === 'file' && first.lines
        ? `${capital(spokenRange(first.lines))} ${first.lines.end > first.lines.start ? 'were' : 'was'}`
        : `${capital(first.kind === 'doc' ? docWhat(first) : spokenRef(first))} was`
  return `${leadOf(resourceLabel(first), reason)}. ${what} removed from the message.`
}

/** `Removed L142–158 and L200–210.` */
export function removedText(n: ReferenceInvalidation): string {
  const labels = n.removed.map((r) => r.label)
  const many = isPinNotice(n) ? 'elements' : isChangeNotice(n) ? 'changes' : 'selections'
  const list = labels.length > 2 ? `${labels.length} ${many}` : labels.join(' and ')
  return `Removed ${list}.${n.removed.some((r) => r.note) ? ' Your note is kept.' : ''}`
}

/** The notice's lead: `manager.ts changed. Select it again.` */
export function noticeLead(n: ReferenceInvalidation): string {
  if (isChangeNotice(n)) return `${changeLead(n.reason)}.`
  const lead = `${leadOf(n.label, n.reason)}.`
  if (!canReopen(n.reason)) return lead
  return `${lead} ${isPinNotice(n) ? 'Pick it again.' : 'Select it again.'}`
}

/** A paused queued row's sentence: `manager.ts changed, so L142–158 was removed.` */
export function pausedText(n: ReferenceInvalidation): string {
  const labels = n.removed.map((r) => r.label)
  const many = isPinNotice(n) ? 'elements' : isChangeNotice(n) ? 'changes' : 'selections'
  const what = labels.length > 2 ? `${labels.length} ${many} were` : `${labels.join(' and ')} ${labels.length > 1 ? 'were' : 'was'}`
  return `${isChangeNotice(n) ? changeLead(n.reason) : leadOf(n.label, n.reason)}, so ${what} removed.`
}
