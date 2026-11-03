import { clipName, hostOf, pinWords } from '../../../shared/annotate'
import { changeLabel, changeTail, DIAGRAM_LABELS_MAX, DIAGRAM_PARTS_MAX, diagramTail, docPages, fitsRecord, imagePx, imageTail, isRefInput, MAX_REFS, partPhrase, partWord, refLabel, type ChangeSide, type ContextReference, type DiagramPart, type LineRange, type RefInput, type ReferenceInvalidation } from '../../../shared/context'
import { CHANGE_BYTES_MAX, CHANGE_LINES_MAX, CHANGE_TEXT_BUDGET } from '../../../shared/changes'
import { WORKSPACE_FILE_CAP } from '../../../shared/files'
import { parseA1, qualified, spokenA1 } from '../../../shared/sheets'

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
  if (r.kind === 'sheet') return qualified(r.range, r.sheet)
  if (r.kind === 'docx') return r.part === 'body' && r.heading ? `under "${clipName(r.heading)}"` : 'text'
  if (r.kind === 'diagram') return diagramTail(r)
  return r.kind === 'file' && r.lines ? rangeText(r.lines) : refLabel(r)
}

type DocInput = Extract<RefInput, { kind: 'doc' }>

/** `A18 to D24`, `sheet Summary, rows 18 to 24`. */
export const sheetWhat = (r: Pick<Extract<RefInput, { kind: 'sheet' }>, 'range' | 'sheet'>): string => {
  const a = parseA1(r.range)
  return `${r.sheet === undefined ? '' : `sheet ${r.sheet}, `}${a ? spokenA1(a) : r.range}`
}

/** `text under Scope of work`, `text`, `footnote text`, as a screen reader hears a Word reference's place. */
export const docxWords = (r: Pick<Extract<RefInput, { kind: 'docx' }>, 'part' | 'heading'>): string =>
  r.part !== 'body' ? `${r.part === 'footnotes' ? 'footnote' : 'endnote'} text` : r.heading ? `text under ${clipName(r.heading)}` : 'text'

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
    case 'sheet':
      return `${baseOf(r.path)}, ${sheetWhat(r)}${r.values === undefined ? '' : ', with values'}`
    case 'docx':
      return `${baseOf(r.path)}, ${docxWords(r)}, "${quoteStart(r.text.quote, 80)}"`
    case 'diagram':
      return `${baseOf(r.path)}, ${diagramWords(r)}`
    default:
      return r satisfies never
  }
}

type DiagramInput = Extract<RefInput, { kind: 'diagram' }>
const end = (id: string, label: string | undefined, side: 'from' | 'to'): string => clipName(label ?? (id === '[*]' ? (side === 'from' ? 'start' : 'end') : id))
const labelsText = (n: number): string => (n ? `${n} ${n === 1 ? 'label' : 'labels'}` : 'no labels')

/** `node Start`, `link from Start to Do it`, `loop Every min`, as a screen reader hears one part. */
export function spokenPart(type: string, p: DiagramPart): string {
  const word = partWord(type, p)
  switch (p.kind) {
    case 'node':
    case 'group':
    case 'participant':
      return `${word} ${clipName(p.label ?? p.id)}`
    case 'edge':
    case 'message':
      return `${word} from ${end(p.from, p.fromLabel, 'from')} to ${end(p.to, p.toLabel, 'to')}`
    case 'note':
    case 'block':
      return p.label ? `${word} ${clipName(p.label)}` : word
  }
}

/** `node Start`, `3 diagram parts`, `diagram area, 3 labels`. */
export const diagramWords = (r: Pick<DiagramInput, 'type' | 'parts' | 'labels'>): string =>
  r.labels ? `diagram area, ${labelsText(r.labels.length)}` : r.parts!.length === 1 ? spokenPart(r.type, r.parts![0]) : `${r.parts!.length} diagram parts`

const SECTION_WORD: Record<string, string> = { alt: 'else', par: 'and', critical: 'option' }

/** A part as its listbox option says it: `Node Start, line 5`, `Link from Start to Do it, labelled yes`, `Alt ok, else
 *  fail, lines 7 to 11`. */
export function partOption(type: string, p: DiagramPart): string {
  const head = capital(spokenPart(type, p))
  switch (p.kind) {
    case 'node':
    case 'group':
    case 'participant':
      return p.line === undefined ? head : `${head}, line ${p.line}`
    case 'edge':
    case 'message':
      return p.label ? `${head}, labelled ${clipName(p.label)}` : head
    case 'note':
      return `Note, ${clipName(p.label)}`
    case 'block': {
      const sections = (p.sections ?? []).map((t) => `${SECTION_WORD[p.keyword] ?? 'else'} ${clipName(t)}`)
      return [head, ...sections, ...(p.lines ? [spokenRange(p.lines)] : [])].join(', ')
    }
  }
}

/** The bar's label: `Node "Start" selected`, `3 parts selected`. */
export const partsSelectedText = (type: string, parts: readonly DiagramPart[]): string =>
  parts.length === 1 ? `${capital(partPhrase(type, parts[0]))} selected` : `${parts.length} parts selected`

/** `Area selected · 3 labels`. */
export const areaSelectedText = (n: number): string => `Area selected · ${labelsText(n)}`

/** `Area selected, 3 labels: Design, Code, Release`, five at most and then how many more. */
export function areaSpoken(texts: readonly string[]): string {
  if (!texts.length) return 'Area selected, no labels'
  const more = texts.length - 5
  return `Area selected, ${labelsText(texts.length)}: ${texts.slice(0, 5).map((t) => clipName(t)).join(', ')}${more > 0 ? ` and ${more} more` : ''}`
}

export const tooManyParts = (n: number, max: number): string => `Too many to add: ${n} parts, ${max} max`
export const tooManyLabels = (n: number, max: number): string => `Too many labels: ${n}, ${max} max. Draw a smaller area.`
export const NO_LABELS = 'No labels inside. Draw around some text.'
export const PARTS_TOO_LARGE = 'Too large to add. Select fewer parts.'
export const AREA_TOO_LARGE = 'Too large to add. Draw a smaller area.'
export const PARTS_NOTICE = {
  cleared: 'The diagram changed on disk, so the selection was cleared.',
  removed: 'The diagram changed on disk, so the selection was cleared and removed from the message.'
}

/** Why a diagram selection can't be added, or undefined when it can. */
export function diagramBlocked(input: DiagramInput, picture: boolean): string | undefined {
  if (input.parts && input.parts.length > DIAGRAM_PARTS_MAX) return tooManyParts(input.parts.length, DIAGRAM_PARTS_MAX)
  if (input.labels && input.labels.length > DIAGRAM_LABELS_MAX) return tooManyLabels(input.labels.length, DIAGRAM_LABELS_MAX)
  if (input.labels && !input.labels.length && !picture) return NO_LABELS
  if (!isRefInput(input) || !fitsRecord(input)) return input.parts ? PARTS_TOO_LARGE : AREA_TOO_LARGE
}

/** `region 640 by 320 at 120, 48`, `point at 412, 96`. */
export function spokenImage(r: Parameters<typeof imagePx>[0]): string {
  const p = imagePx(r)
  return p.w === undefined ? `point at ${p.x}, ${p.y}` : `region ${p.w} by ${p.h} at ${p.x}, ${p.y}`
}

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** `Lines 142–158 selected`. */
export const selectedText = ({ start, end }: LineRange): string => `${end > start ? `Lines ${start}–${end}` : `Line ${start}`} selected`

/** `Added lines 142 to 158 of manager.ts to the message.` `unpictured`: the bar promised a picture that couldn't be made. */
export function addedText(r: RefInput, queued = false, unpictured = false): string {
  const what =
    r.kind === 'file' && r.lines
      ? `${spokenRange(r.lines)} of ${baseOf(r.path)}`
      : r.kind === 'doc'
        ? `${docWhat(r)} of ${baseOf(r.path)}`
        : r.kind === 'sheet'
          ? `${sheetWhat(r)} of ${baseOf(r.path)}`
          : r.kind === 'docx'
            ? `text from ${baseOf(r.path)}`
          : r.kind === 'diagram'
            ? r.labels
              ? `a diagram area of ${baseOf(r.path)}`
              : `${r.parts.length === 1 ? spokenPart(r.type, r.parts[0]) : `${r.parts.length} diagram parts`} of ${baseOf(r.path)}`
          : r.kind === 'change'
            ? `${spokenRef(r)},`
            : spokenRef(r)
  return `Added ${what} to the ${queued ? 'queued ' : ''}message${unpictured ? ', without picture' : ''}.`
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
export const SHEET_POINT_HINT = 'Click a cell, or press Shift and an arrow key.'
export const POINT_BLOCK_HINT = "Click a block's line number, or press Shift and an arrow key."
export const POINT_PARTS_HINT = 'Click a part, or Tab to the parts and press Space.'
export const POINT_AREA_HINT = 'Drag across the diagram, or press Shift and an arrow key.'
export const POINT_PARTS_SAID = 'Pointing. Click a part of the diagram, or Tab to its parts and press Space. Enter adds it.'
export const POINT_AREA_SAID = 'Pointing. Drag across the diagram to select an area, or click it for the whole diagram. Shift and an arrow key also draws one. Enter adds it.'
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
        : `${capital(first.kind === 'doc' ? docWhat(first) : first.kind === 'sheet' ? sheetWhat(first) : first.kind === 'docx' ? docxWords(first) : first.kind === 'diagram' ? diagramWords(first) : spokenRef(first))} was`
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
