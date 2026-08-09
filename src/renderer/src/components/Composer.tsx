import {
  useRef,
  useState,
  type KeyboardEvent,
  type ClipboardEvent,
  type DragEvent,
  type ChangeEvent
} from 'react'
import { useActive, useSession, type SendAttachment } from '../store'
import { useComposerAutocomplete } from './ComposerAutocomplete'
import { ModelEffortPicker } from './ModelEffortPicker'
import { UltracodeToggle } from './UltracodeToggle'
import { ContextRing } from './ContextRing'
import { Dropdown } from './Dropdown'
import {
  IconArrowUp,
  IconStop,
  IconSettings,
  IconNoEntry,
  IconHand,
  IconSparkles,
  IconEdit,
  IconChecklist,
  IconShieldOff,
  IconImage,
  IconFile,
  IconClose
} from './Icon'
import { processDroppedFiles, toWireAttachment, type ProcessedAttachment } from '../lib/images'
import {
  PERMISSION_MODES,
  PERMISSION_MODE_LABELS,
  PERMISSION_MODE_COLORS,
  PERMISSION_MODE_DESCRIPTIONS
} from '../../../shared/settings'
import type { PermissionModeChoice } from '../../../shared/ipc'

/**
 * Message textarea on top, a control row below: model/effort + permission chips
 * on the left, context gauge + send/stop on the right. The dock edge pulses while
 * a turn streams (the verb+timer itself lives in the chat footer, see WorkingStatus).
 */
export function Composer(): JSX.Element {
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [attachments, setAttachments] = useState<ProcessedAttachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Depth counter so nested dragenter/dragleave (over child elements) don't flicker
  // the drop highlight; only the outermost enter/leave toggles it.
  const dragDepth = useRef(0)
  const busy = useActive((s) => s?.busy ?? false)
  const hasSession = useActive((s) => !!s)
  const cwd = useActive((s) => s?.cwd ?? null)
  const modeChoice = useActive((s) => s?.modeChoice ?? 'inherit')
  const contextPercent = useActive((s) => s?.contextPercent ?? null)
  const contextTokens = useActive((s) => s?.contextTokens ?? null)
  const contextWindow = useActive((s) => s?.contextWindow ?? null)
  const sendMessage = useSession((s) => s.sendMessage)
  const interrupt = useSession((s) => s.interrupt)
  const setPermissionMode = useSession((s) => s.setPermissionMode)
  const setNotice = useSession((s) => s.setNotice)

  // Drop/paste/pick routing:
  //  - IMAGES inline as thumbnails (the model can't `@`-read pixels; it needs the block).
  //  - EVERY OTHER FILE becomes an `@path` TOKEN in the composer (relative if under the
  //    workspace cwd, else absolute). The CLI expands `@` and the model Reads it ON
  //    DEMAND (verified: @relative, @absolute both resolve). This is token-cheap (a
  //    pointer, not the re-billed contents), handles files we can't inline (.xlsx/.zip),
  //    reflects live edits, and works in- or out-of-cwd.
  //  - A file with NO resolvable path (a pasted screenshot Blob) can't be referenced by
  //    path → fall back to inlining its bytes (image/pdf/text) so paste still works.
  const addFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0) return
    const inlineFallback: File[] = []
    const tokens: string[] = []
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        inlineFallback.push(file) // images always inline
        continue
      }
      const abs = window.clui.getPathForFile(file)
      if (abs) tokens.push('@' + toWorkspaceRef(abs, cwd))
      else inlineFallback.push(file) // no path (e.g. pasted Blob) → inline the bytes
    }
    if (tokens.length) insertAtCaret(tokens.join(' ') + ' ')
    if (inlineFallback.length) {
      const { attachments: added, errors } = await processDroppedFiles(inlineFallback)
      if (added.length) setAttachments((prev) => [...prev, ...added])
      if (errors.length) setNotice(errors.join(' '))
    }
  }

  // Splice text at the caret (reused for the @path tokens), then restore the caret.
  const insertAtCaret = (insert: string): void => {
    const at = Math.min(caret, text.length)
    const next = text.slice(0, at) + insert + text.slice(at)
    applyPick(next, at + insert.length)
  }

  const removeAttachment = (id: string): void => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    // Only intercept when the clipboard carries FILES (e.g. a screenshot / a file copied
    // in Finder). A normal text/rich-text paste has no files → let it proceed untouched.
    const files = Array.from(e.clipboardData.files)
    if (files.length === 0) return
    e.preventDefault()
    void addFiles(files)
  }

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    dragDepth.current = 0
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length) void addFiles(files)
  }

  const onDragEnter = (e: DragEvent<HTMLDivElement>): void => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    dragDepth.current += 1
    setDragOver(true)
  }

  const onDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault()
  }

  const onDragLeave = (): void => {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragOver(false)
  }

  const onPickFiles = (e: ChangeEvent<HTMLInputElement>): void => {
    const files = e.target.files ? Array.from(e.target.files) : []
    void addFiles(files)
    e.target.value = '' // allow re-picking the same file
  }

  // Apply an autocomplete pick: set text + restore the caret to just after the
  // inserted token (async so React commits the value before we move the caret).
  const applyPick = (nextText: string, nextCaret: number): void => {
    setText(nextText)
    setCaret(nextCaret)
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (ta) {
        ta.focus()
        ta.setSelectionRange(nextCaret, nextCaret)
      }
    })
  }

  const ac = useComposerAutocomplete(text, caret, applyPick)

  const submit = async (): Promise<void> => {
    const t = text.trim()
    if (!t && attachments.length === 0) return
    const send: SendAttachment[] = attachments.map((a) => ({
      wire: toWireAttachment(a),
      display:
        a.kind === 'image'
          ? { kind: 'image', previewUrl: a.previewUrl, name: a.name, w: a.w, h: a.h }
          : a.kind === 'document'
            ? { kind: 'document', name: a.name, bytes: a.bytes }
            : { kind: 'text', name: a.name, bytes: a.bytes, lines: a.lines }
    }))
    setText('')
    setCaret(0)
    setAttachments([])
    await sendMessage(t, send.length ? send : undefined)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // When the autocomplete menu is open, let it consume ↑/↓/Enter/Tab/Esc first.
    if (ac.onKeyDown(e)) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  // Track the caret after any interaction so the autocomplete sees the right token.
  const syncCaret = (): void => {
    const ta = textareaRef.current
    if (ta) setCaret(ta.selectionStart ?? 0)
  }

  const permOptions = PERMISSION_MODES.map((m) => ({
    value: m,
    label: PERMISSION_MODE_LABELS[m],
    color: PERMISSION_MODE_COLORS[m],
    description: PERMISSION_MODE_DESCRIPTIONS[m],
    icon: <PermissionIcon mode={m} />
  }))

  return (
    <div className="px-4 pb-4">
      <div
        className={`relative flex flex-col gap-2 rounded-xl border bg-bg-elev p-2 shadow-md transition-colors ${
          dragOver
            ? 'border-accent'
            : busy
              ? 'border-accent/40'
              : 'border-border focus-within:border-accent'
        }`}
        style={busy ? { animation: 'var(--animate-dock-pulse)' } : undefined}
        onDrop={onDrop}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
      >
        {/* Drag-to-attach overlay: accent is legit here (a live, transient state cue). */}
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-bg-elev/85">
            <div className="flex items-center gap-2 text-sm font-medium text-accent">
              <IconImage className="h-5 w-5" />
              Drop to attach — images inline, other files as @references
            </div>
          </div>
        )}
        {/* Attachment thumbnails: a strip above the textarea, neutral surfaces. */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-1 pt-1">
            {attachments.map((a) => (
              <AttachmentPill key={a.id} att={a} onRemove={() => removeAttachment(a.id)} />
            ))}
          </div>
        )}
        <div className="relative">
          {ac.render()}
          <textarea
            ref={textareaRef}
            data-composer-input
            className="max-h-48 min-h-[52px] w-full resize-none bg-transparent px-2 pt-1.5 text-sm leading-normal text-content outline-none placeholder:text-dim focus-visible:outline-none"
            placeholder="Message Claude…  (Enter to send, Shift+Enter for newline · / for commands, @ for files, paste or drop images)"
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setCaret(e.target.selectionStart ?? e.target.value.length)
            }}
            onKeyDown={onKeyDown}
            onKeyUp={syncCaret}
            onClick={syncCaret}
            onPaste={onPaste}
            rows={2}
          />
        </div>
        <div className="flex items-center gap-2">
          {/* Attach-file button (keyboard/a11y affordance for paste + drop). Accepts the
              same set the drop handler routes: images, PDFs, and common text files. */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,.md,.csv,.tsv,.json,.jsonl,.yaml,.yml,.toml,.log,.xml,.ts,.tsx,.js,.jsx,.py,.rs,.go,.sh,.sql,.c,.cpp,.java"
            multiple
            className="hidden"
            onChange={onPickFiles}
            tabIndex={-1}
            aria-hidden="true"
          />
          <button
            type="button"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border text-dim transition-colors hover:border-border-strong hover:text-content disabled:cursor-default disabled:opacity-50"
            onClick={() => fileInputRef.current?.click()}
            disabled={!hasSession}
            title="Attach a file — images, PDFs & text files"
            aria-label="Attach a file"
          >
            <IconImage className="h-4 w-4" />
          </button>
          {/* Attach is a message-content action; everything to its right is run
              configuration. This is the only divider in the row: peers within the
              run-config group are not separated, so one rule marks the one real boundary. */}
          <span className="h-6 w-px shrink-0 bg-border-strong" aria-hidden="true" />
          {/* C3: instrument control chips, model/effort + permission grouped. */}
          <ModelEffortPicker />
          <Dropdown<PermissionModeChoice>
            value={modeChoice}
            options={permOptions}
            onChange={(m) => void setPermissionMode(m)}
            title="Permission mode — this session only; never writes settings.json"
            direction="up"
            menuClassName="w-64"
            icon={<PermissionIcon mode={modeChoice} />}
          />
          <UltracodeToggle />

          <div className="ml-auto flex items-center gap-3">
            {/* The verb+timer lives in the chat footer (WorkingStatus) for CLI-parity,
                so the transcript tail is the single foreground activity signal. Here the
                dock keeps only the context gauge + Stop; the dock-edge pulse is ambient. */}
            <ContextRing
              percent={contextPercent}
              usedTokens={contextTokens}
              contextWindow={contextWindow}
            />
            {/* C2: send/stop morph. */}
            {busy ? (
              <button
                className="flex h-9 w-9 items-center justify-center rounded-lg bg-err text-on-err transition-transform hover:scale-105 active:scale-95"
                onClick={() => void interrupt()}
                title="Stop"
              >
                <IconStop className="h-4 w-4" />
              </button>
            ) : (
              <button
                className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-on-accent transition-[background-color,transform] hover:bg-accent-hover active:scale-95 disabled:cursor-default disabled:bg-border disabled:text-faint"
                onClick={() => void submit()}
                disabled={!text.trim() && attachments.length === 0}
                title="Send"
              >
                <IconArrowUp className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Turn a dropped file's absolute path into the reference the CLI expands after `@`:
 *  a workspace-RELATIVE path when the file is under `cwd` (matches the @-picker + is the
 *  token-cheap common case), else the ABSOLUTE path (out-of-cwd, the CLI/Read still
 *  resolves it). Pure string math (no node `path` in the renderer); POSIX separators. */
function toWorkspaceRef(abs: string, cwd: string | null): string {
  if (cwd) {
    const base = cwd.endsWith('/') ? cwd : cwd + '/'
    if (abs === cwd) return abs // a directory dropped onto itself; just reference it
    if (abs.startsWith(base)) return abs.slice(base.length)
  }
  return abs
}

/** Per-mode glyph so the mode is legible by SHAPE, not color alone (two modes share
 *  green; WCAG 1.4.1, never state-by-color-alone). Each metaphor: gear=inherit config,
 *  no-entry=deny-by-default, hand=asks-you, sparkles=classifier-decides, pencil=auto-edits,
 *  checklist=plan, slashed-shield=danger/unguarded. The color class carries the risk tier
 *  for the collapsed chip; in the open menu the icon inherits the option row's color via
 *  currentColor. */
const PERMISSION_MODE_ICONS: Record<
  PermissionModeChoice,
  (p: { className?: string }) => JSX.Element
> = {
  inherit: IconSettings,
  dontAsk: IconNoEntry,
  default: IconHand,
  auto: IconSparkles,
  acceptEdits: IconEdit,
  plan: IconChecklist,
  bypassPermissions: IconShieldOff
}

function PermissionIcon({ mode }: { mode: PermissionModeChoice }): JSX.Element {
  const Glyph = PERMISSION_MODE_ICONS[mode]
  return <Glyph className={`h-3.5 w-3.5 shrink-0 ${PERMISSION_MODE_COLORS[mode]}`} />
}

/** A thumbnail chip for one staged attachment: image preview + filename + remove ✕.
 *  Neutral surfaces (accent-scarcity); the ✕ is a ≥24px keyboard-reachable target. */
function AttachmentPill({
  att,
  onRemove
}: {
  att: ProcessedAttachment
  onRemove: () => void
}): JSX.Element {
  const kb = Math.max(1, Math.round(att.bytes / 1024))
  const label = att.kind === 'image' ? att.name || 'pasted image' : att.name
  const meta =
    att.kind === 'image'
      ? `${att.w}×${att.h} · ${kb} KB`
      : att.kind === 'text'
        ? `${kb} KB · ${att.lines} lines`
        : `${kb} KB · PDF`
  return (
    <div className="group relative flex items-center gap-2 rounded-md border border-border bg-bg-raised py-1 pl-1 pr-2">
      {att.kind === 'image' ? (
        <img src={att.previewUrl} alt={label} className="h-10 w-10 rounded bg-tool object-cover" />
      ) : (
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-tool text-dim">
          <IconFile className="h-5 w-5" />
        </span>
      )}
      <div className="flex min-w-0 flex-col">
        <span className="max-w-[120px] truncate text-xs text-content" title={label}>
          {label}
        </span>
        <span className="font-mono text-[10px] text-faint">{meta}</span>
      </div>
      <button
        type="button"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-dim transition-colors hover:bg-bg-elev hover:text-content"
        onClick={onRemove}
        title="Remove attachment"
        aria-label={`Remove ${label}`}
      >
        <IconClose className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
