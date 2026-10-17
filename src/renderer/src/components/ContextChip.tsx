import type { KeyboardEvent, MouseEvent, Ref } from 'react'
import { hostOf, pinWords, clipName } from '../../../shared/annotate'
import { refLabel, type ContextReference } from '../../../shared/context'
import type { ProcessedAttachment } from '../lib/images'
import type { ShownAttachment } from '../store'
import { baseOf, rangeText, spokenRef } from '../lib/refCopy'
import { FileIcon } from './FileIcon'
import { IconClose, IconFile, IconTarget } from './Icon'

/** What one chip shows and says. References carry a number; attachments don't. */
export interface ChipView {
  key: string
  n?: number
  glyph: 'file' | 'folder' | 'target' | 'attachment'
  thumb?: string
  line1: string
  line2: string
  /** Data that goes to the model with the reference, shown after line2 and never truncated. */
  disclose?: string
  title: string
  label: string
  /** For the remove button and announcements. */
  spoken: string
}

const parentOf = (p: string): string => {
  const i = p.replace(/\/+$/, '').lastIndexOf('/')
  return i <= 0 ? './' : `${p.slice(0, i)}/`
}

const relTo = (cwd: string | null, p: string): string => (cwd && p.startsWith(`${cwd.replace(/\/+$/, '')}/`) ? p.slice(cwd.replace(/\/+$/, '').length + 1) : p)

/** `dupe`: another chip in the row shares this basename, so line 2 leads with the parent folder. */
export function refChip(ref: ContextReference, n: number, cwd: string | null, thumb: string | undefined, dupe: boolean): ChipView {
  const key = ref.id
  switch (ref.kind) {
    case 'file': {
      const rel = relTo(cwd, ref.path)
      const dir = parentOf(rel)
      const folder = baseOf(dir.slice(0, -1) || './')
      const line2 = ref.lines ? `${dupe ? `${folder}/ · ` : ''}${rangeText(ref.lines)}` : dir
      const where = dir === './' ? '' : `, in ${dir.slice(0, -1)}`
      const title = ref.lines ? `${rel} · ${rangeText(ref.lines)}` : rel
      return { key, n, glyph: 'file', line1: baseOf(ref.path), line2, title, label: `Reference ${n}: ${spokenRef(ref)}${where}`, spoken: spokenRef(ref) }
    }
    case 'folder': {
      const rel = relTo(cwd, ref.path)
      const dir = parentOf(rel)
      const where = dir === './' ? '' : `, in ${dir.slice(0, -1)}`
      return { key, n, glyph: 'folder', line1: refLabel(ref), line2: dir, title: rel, label: `Reference ${n}: ${spokenRef(ref)}${where}`, spoken: spokenRef(ref) }
    }
    case 'browser': {
      const t = ref.pin.target
      const host = hostOf(t.url)
      const { kind, name } = pinWords(t)
      return {
        key,
        n,
        glyph: 'target',
        thumb,
        line1: refLabel(ref),
        line2: host,
        ...(thumb ? { disclose: 'with picture' } : {}),
        title: `${name ? `${kind} "${name}"` : kind}${host ? ` on ${host}` : ''}${thumb ? ' · with picture' : ''}`,
        label: `Reference ${n}: ${spokenRef(ref)}${host ? `, on ${host}` : ''}${thumb ? ', with picture' : ''}`,
        spoken: spokenRef(ref)
      }
    }
    default:
      return ref satisfies never
  }
}

/** The chip for a pin read back from a legacy `<clui-annotations>` block: display only. */
export function legacyChip(key: string, n: number, kind: string, name: string, host: string, thumb: string | undefined): ChipView {
  const line1 = name ? `${kind} "${clipName(name)}"` : kind
  const spoken = name ? `${kind} ${clipName(name)}` : kind
  return { key, n, glyph: 'target', thumb, line1, line2: host, title: name ? `${kind} "${name}"` : kind, label: `Reference ${n}: ${spoken}${host ? `, on ${host}` : ''}`, spoken }
}

const kb = (bytes: number): number => Math.max(1, Math.round(bytes / 1024))

export function attachmentChip(key: string, a: ProcessedAttachment | ShownAttachment): ChipView {
  const name = a.kind === 'image' ? a.name || 'pasted image' : a.name
  const size = 'bytes' in a && a.bytes !== undefined ? kb(a.bytes) : null
  if (a.kind === 'image') {
    const dims = a.w && a.h ? `${a.w}×${a.h}` : ''
    const line2 = [dims, size ? `${size} KB` : ''].filter(Boolean).join(' · ')
    const spoken = [a.w && a.h ? `${a.w} by ${a.h}` : '', size ? `${size} KB` : ''].filter(Boolean).join(', ')
    return { key, glyph: 'attachment', thumb: a.previewUrl, line1: name, line2, title: name, label: `Attachment: ${name}${spoken ? `, ${spoken}` : ''}`, spoken: name }
  }
  const line2 = a.kind === 'text' ? `${kb(a.bytes)} KB · ${a.lines} lines` : `${kb(a.bytes)} KB · PDF`
  return { key, glyph: 'attachment', line1: name, line2, title: name, label: `Attachment: ${name}, ${line2.replace(' · ', ', ')}`, spoken: name }
}

/**
 * One reference or attachment. A reference carries its position as a neutral badge; the accent stays for the
 * focus ring and the duplicate flash, which stands in for focus. In the composer's row (`onKeyDown` given) the
 * chip is a list item that opens on click; in a sent bubble it's a button when `openLabel` is given, else inert.
 */
export function ContextChip({
  view,
  onOpen,
  openLabel,
  onRemove,
  chipRef,
  tabIndex,
  describedBy,
  flash,
  onKeyDown,
  onFocus
}: {
  view: ChipView
  onOpen?: (e: MouseEvent) => void
  openLabel?: string
  onRemove?: () => void
  chipRef?: Ref<HTMLDivElement>
  tabIndex?: number
  describedBy?: string
  flash?: boolean
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void
  onFocus?: () => void
}): JSX.Element {
  const { n, glyph, thumb } = view
  const box = `relative flex items-center gap-2 rounded-md border border-border bg-bg-raised py-1 pl-1 text-left ${onRemove ? 'pr-2' : 'pr-3'} ${
    onOpen ? 'cursor-pointer pointer-fine:hover:border-border-strong' : ''
  }`
  const body = (
    <>
      <span className="relative h-10 w-10 shrink-0">
        {thumb ? (
          <img src={thumb} alt="" className="h-10 w-10 rounded bg-tool object-cover" />
        ) : (
          <span className="flex h-10 w-10 items-center justify-center rounded bg-tool text-dim">
            {glyph === 'file' || glyph === 'folder' ? (
              <FileIcon name={view.line1} kind={glyph} className="h-5 w-5" />
            ) : glyph === 'target' ? (
              <IconTarget className="h-5 w-5" />
            ) : (
              <IconFile className="h-5 w-5" />
            )}
          </span>
        )}
        {n !== undefined && (
          <span aria-hidden="true" className="absolute -left-1 -top-1 flex size-4.5 items-center justify-center rounded-full bg-content text-badge font-semibold text-bg-elev">
            {n}
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-col" aria-hidden="true">
        <span className="max-w-40 truncate text-xs text-content">{view.line1}</span>
        {/* The host gives way first: what goes to the model is never cut. */}
        <span className="flex min-w-0 max-w-40 font-mono text-meta text-faint">
          <span className="truncate">{view.line2}</span>
          {view.disclose && <span className="shrink-0 whitespace-pre">{`${view.line2 ? ' · ' : ''}${view.disclose}`}</span>}
        </span>
      </span>
    </>
  )
  if (openLabel)
    return (
      <button type="button" data-ui="context-chip" title={view.title} aria-label={openLabel} onClick={onOpen} className={box}>
        {body}
      </button>
    )
  const row = !!onKeyDown
  return (
    <div
      ref={chipRef}
      data-ui="context-chip"
      data-ref={n === undefined ? undefined : view.key}
      role={row ? 'listitem' : 'img'}
      tabIndex={tabIndex}
      aria-label={view.label}
      aria-describedby={describedBy}
      title={view.title}
      onClick={onOpen}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      className={box}
    >
      {body}
      {onRemove && (
        <button
          type="button"
          tabIndex={-1}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-dim pointer-fine:hover:bg-bg-elev pointer-fine:hover:text-content"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          aria-label={`Remove ${view.spoken}`}
        >
          <IconClose className="h-3.5 w-3.5" />
        </button>
      )}
      {flash && <span aria-hidden="true" className="ref-flash pointer-events-none absolute -inset-px rounded-md ring-2 ring-accent" />}
    </div>
  )
}
