import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ClipboardEvent,
  type DragEvent,
  type ChangeEvent
} from 'react'
import { useActive, useSession, EMPTY_ATTACHMENTS, type SendAttachment } from '../store'
import { useComposerAutocomplete } from './ComposerAutocomplete'
import { ModelEffortPicker } from './ModelEffortPicker'
import { UltracodeToggle } from './UltracodeToggle'
import { ContextRing } from './ContextRing'
import { Dropdown, type DropdownOption } from './Dropdown'
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
  IconPlus,
  IconFile,
  IconClose,
  IconFolder,
  IconFolderOpen,
  IconGhost
} from './Icon'
import { processDroppedFiles, toWireAttachment, type ProcessedAttachment } from '../lib/images'
import {
  PERMISSION_MODES,
  PERMISSION_MODE_LABELS,
  PERMISSION_MODE_COLORS,
  PERMISSION_MODE_DESCRIPTIONS
} from '../../../shared/settings'
import type { PermissionModeChoice } from '../../../shared/ipc'

// Directory-dropdown action sentinels. Real cwds are absolute paths, so these can't collide.
const DIR_NONE = '__clui_no_dir__'
const DIR_PICK = '__clui_pick__'

/**
 * Message textarea on top, a control row below: model/effort + permission chips on the left,
 * context gauge + send/stop on the right. The dock edge pulses while a turn streams (the
 * verb+timer itself lives in the chat footer, see WorkingStatus).
 */
export function Composer(): JSX.Element {
  // Draft (text + attachments) lives in the session slice, not local state, so it survives
  // switching sessions and the Composer unmounting for a detail view. Caret and drag-highlight
  // stay local: they're ephemeral per-mount UI, not per-session content.
  const handleId = useActive((s) => s?.handleId ?? null)
  const text = useActive((s) => s?.draftText ?? '')
  const attachments = useActive((s) => s?.draftAttachments ?? EMPTY_ATTACHMENTS)
  const setDraftText = useSession((s) => s.setDraftText)
  const addDraftAttachments = useSession((s) => s.addDraftAttachments)
  const removeDraftAttachment = useSession((s) => s.removeDraftAttachment)
  const clearDraft = useSession((s) => s.clearDraft)
  const [caret, setCaret] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Depth counter so nested dragenter/dragleave (over child elements) don't flicker the
  // drop highlight; only the outermost enter/leave toggles it.
  const dragDepth = useRef(0)
  const busy = useActive((s) => s?.busy ?? false)
  const hasSession = useActive((s) => !!s)
  const cwd = useActive((s) => s?.cwd ?? null)
  // Editable only before the first turn: after a message is sent, the CLI has fixed the
  // transcript's folder-slug at process-create, so changing the dir would be a lie (that's a
  // fork/new session, out of scope). A directoryless session runs in the chat dir.
  const noMessages = useActive((s) => (s?.messages.length ?? 0) === 0)
  const chatDir = useSession((s) => s.chatDir)
  const sessionGroups = useSession((s) => s.sessionGroups)
  const closeSession = useSession((s) => s.closeSession)
  const startSession = useSession((s) => s.startSession)
  const isDirectoryless = !!cwd && cwd === chatDir
  const ephemeral = useActive((s) => s?.ephemeral ?? false)
  const modeChoice = useActive((s) => s?.modeChoice ?? 'inherit')
  // A mode the model switched into (e.g. plan) shadows the user's pick on the chip only,
  // so the chip reflects the session's actual mode without rewriting their selection.
  const modelMode = useActive((s) => s?.modelMode ?? null)
  const displayMode = modelMode ?? modeChoice
  const contextPercent = useActive((s) => s?.contextPercent ?? null)
  const contextTokens = useActive((s) => s?.contextTokens ?? null)
  const contextWindow = useActive((s) => s?.contextWindow ?? null)
  const sendMessage = useSession((s) => s.sendMessage)
  const interrupt = useSession((s) => s.interrupt)
  const setPermissionMode = useSession((s) => s.setPermissionMode)
  const setNotice = useSession((s) => s.setNotice)

  // Drop/paste/pick routing:
  //  - Images inline as thumbnails (the model can't @-read pixels; it needs the block).
  //  - Every other file becomes an @path token in the composer (relative if under the workspace
  //    cwd, else absolute). The CLI expands @ and the model Reads it on demand. This is token-cheap
  //    (a pointer, not the re-billed contents), handles files we can't inline, reflects live edits,
  //    and works in- or out-of-cwd.
  //  - A file with no resolvable path (a pasted screenshot Blob) can't be referenced by path, so
  //    fall back to inlining its bytes so paste still works.
  const addFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0 || !handleId) return
    // Bind to the handle the drop started on, so a conversion that finishes after the user
    // switched sessions lands in this session's draft, not whichever is active then.
    const h = handleId
    const inlineFallback: File[] = []
    const tokens: string[] = []
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        inlineFallback.push(file)
        continue
      }
      const abs = window.clui.getPathForFile(file)
      if (abs) tokens.push('@' + toWorkspaceRef(abs, cwd))
      else inlineFallback.push(file)
    }
    if (tokens.length) insertAtCaret(tokens.join(' ') + ' ')
    if (inlineFallback.length) {
      const { attachments: added, errors } = await processDroppedFiles(inlineFallback)
      if (added.length) addDraftAttachments(h, added)
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
    if (handleId) removeDraftAttachment(handleId, id)
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    // Only intercept when the clipboard carries files (e.g. a screenshot / a file copied in
    // Finder). A normal text/rich-text paste has no files, so let it proceed untouched.
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
    e.target.value = ''
  }

  // Apply an autocomplete pick: set text + restore the caret to just after the inserted
  // token (async so React commits the value before we move the caret).
  const applyPick = (nextText: string, nextCaret: number): void => {
    if (handleId) setDraftText(handleId, nextText)
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

  // Land focus in the composer when a FRESH session opens (no turn sent yet), so the user's first
  // keystrokes are the message, never the sidebar rename box. Keyed on handleId only: a session
  // with history (resume / switch) keeps its own scroll and focus, and sending a message (0 → 1)
  // doesn't re-grab focus.
  useEffect(() => {
    if (handleId && noMessages) textareaRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleId])

  // Keyed on `text` so it re-measures on programmatic changes too (autocomplete insert, draft
  // restore, empty-after-send reset), not just typing. The ResizeObserver handles width changes
  // (a sidebar toggle rewraps the text); guarded to width-only so setting height can't loop it.
  useLayoutEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    const measure = (): void => {
      ta.style.height = 'auto'
      ta.style.height = `${ta.scrollHeight}px`
      // 192px = max-h-48; keep in sync.
      ta.style.overflowY = ta.scrollHeight > 192 ? 'auto' : 'hidden'
    }
    measure()
    let width = ta.clientWidth
    const ro = new ResizeObserver(() => {
      if (ta.clientWidth === width) return
      width = ta.clientWidth
      measure()
    })
    ro.observe(ta)
    return () => ro.disconnect()
  }, [text])

  // Rebind a still-empty session to `dir`, carrying its draft. The CLI fixes the transcript folder
  // at process-create, so a pre-message dir change must respawn, not set_cwd; the jsonl is lazy, so
  // nothing is lost. A quick session stays ephemeral across the respawn so its "not saved" contract
  // isn't silently dropped by picking a folder.
  const respawnIn = async (dir: string): Promise<void> => {
    if (!handleId || dir === cwd) return
    const cur = useSession.getState().sessions[handleId]
    const draft = cur?.draftText ?? ''
    const carriedAttachments = cur?.draftAttachments ?? []
    const wasEphemeral = cur?.ephemeral ?? false
    await closeSession(handleId)
    await startSession(dir, undefined, wasEphemeral ? { ephemeral: true } : undefined)
    const next = useSession.getState().activeHandleId
    if (!next) return
    if (draft) setDraftText(next, draft)
    if (carriedAttachments.length) addDraftAttachments(next, carriedAttachments)
  }

  const chooseDirectory = async (): Promise<void> => {
    const dir = await window.clui.pickWorkspace()
    if (dir) await respawnIn(dir)
  }

  // The current cwd is forced in first so its ✓ shows even before it has an on-disk row; the rest
  // are the distinct project cwds the sidebar knows, minus the chat dir (that's "Workbench").
  const dirOptions = useMemo<DropdownOption<string>[]>(() => {
    const seen = new Set<string>()
    const recents: DropdownOption<string>[] = []
    if (!isDirectoryless && cwd) {
      seen.add(cwd)
      recents.push({ value: cwd, label: basename(cwd), description: cwd })
    }
    for (const g of sessionGroups) {
      if (g.cwd === chatDir || seen.has(g.cwd)) continue
      seen.add(g.cwd)
      recents.push({ value: g.cwd, label: basename(g.cwd), description: g.cwd })
    }
    return [
      ...recents,
      { value: DIR_PICK, label: 'Choose a directory…', icon: <IconFolderOpen className="h-4 w-4" /> },
      { value: DIR_NONE, label: 'Workbench', divider: true }
    ]
  }, [sessionGroups, chatDir, cwd, isDirectoryless])

  const onSelectDir = (v: string): void => {
    if (v === DIR_PICK) {
      void chooseDirectory()
      return
    }
    const target = v === DIR_NONE ? chatDir : v
    if (target) void respawnIn(target)
  }

  const submit = async (): Promise<void> => {
    const t = text.trim()
    if ((!t && attachments.length === 0) || !handleId) return
    const send: SendAttachment[] = attachments.map((a) => ({
      wire: toWireAttachment(a),
      display:
        a.kind === 'image'
          ? { kind: 'image', previewUrl: a.previewUrl, name: a.name, w: a.w, h: a.h }
          : a.kind === 'document'
            ? { kind: 'document', name: a.name, bytes: a.bytes }
            : { kind: 'text', name: a.name, bytes: a.bytes, lines: a.lines }
    }))
    // Clear only THIS session's draft, the one the send consumed.
    clearDraft(handleId)
    setCaret(0)
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
    icon: <PermissionIcon mode={m} className="h-4 w-4" />,
    // Autonomous (bypassPermissions) is the full-access danger tier: the whole row goes err,
    // not a new hue (terracotta stays scarce).
    tone: m === 'bypassPermissions' ? ('danger' as const) : undefined
  }))

  return (
    <div className="mx-auto w-full max-w-5xl px-7">
      <div
        className={`dock-fade-both relative flex flex-col gap-2 rounded-xl border bg-bg-elev p-2 transition-colors ${
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
              <IconPlus className="h-5 w-5" />
              Drop to attach · images inline, other files as @references
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
            placeholder="Message Claude…"
            aria-label="Message Claude"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={ac.open}
            aria-controls={ac.listboxId}
            aria-activedescendant={ac.activeId}
            value={text}
            onChange={(e) => {
              if (handleId) setDraftText(handleId, e.target.value)
              setCaret(e.target.selectionStart ?? e.target.value.length)
            }}
            onKeyDown={onKeyDown}
            onKeyUp={syncCaret}
            onClick={syncCaret}
            onPaste={onPaste}
            rows={2}
          />
        </div>
        <div className="flex items-center">
           {/* Attach-file button (keyboard/a11y affordance for paste + drop). */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={onPickFiles}
            tabIndex={-1}
            aria-hidden="true"
          />
          <button
            type="button"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-control text-dim transition-colors hover:bg-control-hover hover:text-content disabled:cursor-default disabled:opacity-50"
            onClick={() => fileInputRef.current?.click()}
            disabled={!hasSession}
            title="Attach an image or file"
            aria-label="Attach an image or file"
          >
            <IconPlus className="h-4 w-4" />
          </button>
          <div className="ml-3 flex items-center gap-1.5">
            {ephemeral ? (
              <>
                {/* A quick session trims the control row to its contract: not saved. */}
                <span
                  className="flex h-8 items-center gap-1.5 px-1 text-xs text-dim"
                  title="Not saved · discarded when you close it"
                >
                  <IconGhost className="h-3.5 w-3.5 shrink-0" />
                  Not saved
                </span>
                {modeChoice === 'bypassPermissions' && (
                  <span
                    className="flex h-8 items-center gap-1.5 px-1 text-xs text-err"
                    title="Autonomous · runs tools without asking · change in Settings → Quick sessions"
                  >
                    <IconShieldOff className="h-3.5 w-3.5 shrink-0" />
                    runs without asking
                  </span>
                )}
              </>
            ) : (
              <>
                <ModelEffortPicker />
                <Dropdown<PermissionModeChoice>
                  value={displayMode}
                  options={permOptions}
                  onChange={(m) => void setPermissionMode(m)}
                  title="Change permissions"
                  direction="up"
                  variant="pill"
                  menuClassName="w-72"
                  icon={<PermissionIcon mode={displayMode} />}
                />
                <UltracodeToggle />
                <DirectoryChip
                  directoryless={isDirectoryless}
                  editable={noMessages}
                  cwd={cwd}
                  value={isDirectoryless ? DIR_NONE : (cwd ?? DIR_NONE)}
                  options={dirOptions}
                  onSelect={onSelectDir}
                />
              </>
            )}
          </div>
          <div className="ml-auto flex items-center gap-4 pr-[2px]">
            <ContextRing
              percent={contextPercent}
              usedTokens={contextTokens}
              contextWindow={contextWindow}
            />
            {busy ? (
              <button
                className="flex h-[28px] w-[28px] items-center justify-center rounded-full bg-err text-on-err transition-transform active:scale-95"
                onClick={() => void interrupt()}
                title="Stop"
              >
                <IconStop className="h-3 w-3" />
              </button>
            ) : (
              <button
                className="flex h-[28px] w-[28px] items-center justify-center rounded-full bg-accent text-on-accent transition-[background-color,transform] hover:bg-accent-hover active:scale-95 disabled:cursor-default disabled:bg-border disabled:text-faint"
                onClick={() => void submit()}
                disabled={!text.trim() && attachments.length === 0}
                title="Send"
              >
                <IconArrowUp className="h-3 w-3 translate-y-[0.5px]" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Basename of an absolute path. Pure string math, no node `path` in the renderer. */
function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

/**
 * The session's working directory, state legible by glyph AND text. Before the first turn 
 * it's a dropdown to bind/rebind/unbind the dir
 * (recent dirs · choose a folder · "Workbench"); after, the folder is locked at the CLI's
 * spawn-time slug, so it renders a static bound label or nothing when directoryless.
 */
function DirectoryChip({
  directoryless,
  editable,
  cwd,
  value,
  options,
  onSelect
}: {
  directoryless: boolean
  editable: boolean
  cwd: string | null
  value: string
  options: DropdownOption<string>[]
  onSelect: (v: string) => void
}): JSX.Element | null {
  // Once locked (after the first message) the bottom bar carries the cwd, so the composer shows no
  // chip; a second static copy above the footer is redundant. Only the editable picker below shows.
  if (!editable) return null
  return (
    <Dropdown<string>
      value={value}
      options={options}
      onChange={onSelect}
      ariaLabel="Session directory"
      title={directoryless ? undefined : (cwd ?? undefined)}
      direction="up"
      variant="pill"
      checkTone="neutral"
      menuClassName="w-64"
      icon={
        directoryless ? (
          <IconFolderOpen className="h-3.5 w-3.5 shrink-0 text-dim" />
        ) : (
          <IconFolder className="h-3.5 w-3.5 shrink-0 text-dim" />
        )
      }
    />
  )
}

/** The @-reference for a dropped file: workspace-relative when under cwd (matches the
 *  @-picker), else absolute. Pure string math. No node `path` in the renderer. */
function toWorkspaceRef(abs: string, cwd: string | null): string {
  if (cwd) {
    const base = cwd.endsWith('/') ? cwd : cwd + '/'
    if (abs === cwd) return abs
    if (abs.startsWith(base)) return abs.slice(base.length)
  }
  return abs
}

// Per-mode glyph so the mode is legible by shape, not color alone 
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

function PermissionIcon({
  mode,
  className = 'h-3.5 w-3.5'
}: {
  mode: PermissionModeChoice
  className?: string
}): JSX.Element {
  const Glyph = PERMISSION_MODE_ICONS[mode]
  return <Glyph className={`${className} shrink-0 ${PERMISSION_MODE_COLORS[mode]}`} />
}

// A thumbnail chip for one staged attachment: image preview + filename + remove button.
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
        <span className="font-mono text-meta text-faint">{meta}</span>
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
