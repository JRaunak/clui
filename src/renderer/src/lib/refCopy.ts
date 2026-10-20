import { clipName, hostOf, pinWords } from '../../../shared/annotate'
import { MAX_REFS, refLabel, type ContextReference, type LineRange, type RefInput, type ReferenceInvalidation } from '../../../shared/context'
import { WORKSPACE_FILE_CAP } from '../../../shared/files'

type Reason = ReferenceInvalidation['reason']

export const baseOf = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p

export const rangeText = ({ start, end }: LineRange): string => `L${start}${end > start ? `–${end}` : ''}`

const spokenRange = ({ start, end }: LineRange): string => (end > start ? `lines ${start} to ${end}` : `line ${start}`)

/** What a notice names a removed reference by: the range for a selection, else the chip's label. */
export const shortLabel = (r: ContextReference): string => (r.kind === 'file' && r.lines ? rangeText(r.lines) : refLabel(r))

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
    case 'browser': {
      const { kind, name } = pinWords(r.pin.target)
      return name ? `${kind} ${clipName(name)}` : kind
    }
    case 'change':
      return refLabel(r)
    default:
      return r satisfies never
  }
}

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** `Lines 142–158 selected`. */
export const selectedText = ({ start, end }: LineRange): string => `${end > start ? `Lines ${start}–${end}` : `Line ${start}`} selected`

/** `Added lines 142 to 158 of manager.ts to the message.` */
export function addedText(r: RefInput, queued = false): string {
  const what = r.kind === 'file' && r.lines ? `${spokenRange(r.lines)} of ${baseOf(r.path)}` : spokenRef(r)
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
  const page = first.kind === 'browser'
  const what =
    lost.length > 1
      ? `${lost.length} ${page ? 'elements' : 'selections'} were`
      : first.kind === 'file' && first.lines
        ? `${capital(spokenRange(first.lines))} ${first.lines.end > first.lines.start ? 'were' : 'was'}`
        : `${capital(spokenRef(first))} was`
  return `${leadOf(resourceLabel(first), reason)}. ${what} removed from the message.`
}

/** `Removed L142–158 and L200–210.` */
export function removedText(n: ReferenceInvalidation): string {
  const labels = n.removed.map((r) => r.label)
  const page = n.resourceId.startsWith('browser:')
  const list = labels.length > 2 ? `${labels.length} ${page ? 'elements' : 'selections'}` : labels.join(' and ')
  return `Removed ${list}.${n.removed.some((r) => r.note) ? ' Your note is kept.' : ''}`
}

/** The notice's lead: `manager.ts changed. Select it again.` */
export function noticeLead(n: ReferenceInvalidation): string {
  const lead = `${leadOf(n.label, n.reason)}.`
  if (!canReopen(n.reason)) return lead
  return `${lead} ${n.resourceId.startsWith('browser:') ? 'Pick it again.' : 'Select it again.'}`
}

/** A paused queued row's sentence: `manager.ts changed, so L142–158 was removed.` */
export function pausedText(n: ReferenceInvalidation): string {
  const labels = n.removed.map((r) => r.label)
  const page = n.resourceId.startsWith('browser:')
  const what = labels.length > 2 ? `${labels.length} ${page ? 'elements were' : 'selections were'}` : `${labels.join(' and ')} ${labels.length > 1 ? 'were' : 'was'}`
  return `${leadOf(n.label, n.reason)}, so ${what} removed.`
}
