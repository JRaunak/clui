import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ClipboardEvent,
  type DragEvent,
  type ChangeEvent,
  type CSSProperties
} from 'react'
import { chipMode, effectiveMode, useActive, useSession, EMPTY_ATTACHMENTS, EMPTY_NOTICES, EMPTY_REFS, type SendAttachment } from '../store'
import { attachmentChip } from './ContextChip'
import { addToDraft, ContextChips, signalRefs } from './ContextChips'
import { useComposerAutocomplete } from './ComposerAutocomplete'
import { ModelEffortPicker } from './ModelEffortPicker'
import { UltracodeToggle } from './UltracodeToggle'
import { ContextRing } from './ContextRing'
import { GateHost } from './Gate'
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
  IconFolder,
  IconFolderOpen,
  IconGhost,
  IconTarget
} from './Icon'
import { processDroppedFiles, toWireAttachment, type ProcessedAttachment } from '../lib/images'
import { routeDrop } from '../lib/composerRefs'
import { dropText, skippedNote } from '../lib/refCopy'
import {
  PERMISSION_MODES,
  PERMISSION_MODE_LABELS,
  PERMISSION_MODE_COLORS,
  PERMISSION_MODE_DESCRIPTIONS,
  deriveModelInfo
} from '../../../shared/settings'
import type { PermissionModeChoice } from '../../../shared/ipc'

// Directory-dropdown action sentinels. Real cwds are absolute paths, so these can't collide.
const DIR_NONE = '__clui_no_dir__'
const DIR_PICK = '__clui_pick__'

/**
 * Message textarea on top, a control row below: model/effort + permission chips on the left,
 * context gauge + send/stop on the right. A running turn's light and timer live at the transcript
 * tail (WorkingStatus), not on the dock.
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
  const refs = useActive((s) => s?.contextRefs ?? EMPTY_REFS)
  const noticeMap = useActive((s) => s?.referenceNotices ?? EMPTY_NOTICES)
  const notices = useMemo(() => Object.values(noticeMap), [noticeMap])
  const refAnnounce = useActive((s) => s?.refAnnounce ?? '')
  const clearRefs = useSession((s) => s.clearRefs)
  const carryRefs = useSession((s) => s.carryRefs)
  const dockRef = useRef<HTMLDivElement>(null)
  const [caret, setCaret] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Depth counter so nested dragenter/dragleave (over child elements) don't flicker the
  // drop highlight; only the outermost enter/leave toggles it.
  const dragDepth = useRef(0)
  const busy = useActive((s) => s?.busy ?? false)
  const turnStartMs = useActive((s) => s?.turnStartMs ?? null)
  const hasSession = useActive((s) => !!s)
  const cwd = useActive((s) => s?.cwd ?? null)
  // Main gives a folder at or above home no workspace scope, so a drop there can only become @ text.
  const scoped = !!cwd && !`${window.clui.homeDir}/`.startsWith(cwd.endsWith('/') ? cwd : `${cwd}/`)
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
  // The chip shows the mode in effect (the model's plan, or what the CLI runs a pick as) without
  // rewriting the user's pick, so it comes back when the session can honor it.
  const modelMode = useActive((s) => s?.modelMode ?? null)
  const permissionMode = useActive((s) => s?.permissionMode ?? null)
  const effect = effectiveMode({ modelMode, modeChoice, permissionMode })
  const { downgraded } = effect
  const { mode: displayMode, raw: unknownMode } = chipMode(effect.mode, permissionMode)
  // From modelChoice: the init-reported model never updates on a live switch.
  const modelLabel = useActive((s) => (s ? deriveModelInfo(s.modelChoice).label : null))
  // Auto is the one pick a model can refuse; any other mismatch just shows the mode in effect.
  const unavailableOn = downgraded && modeChoice === 'auto' ? modelLabel : null
  const pickLabel = PERMISSION_MODE_LABELS[modeChoice]
  const effectLabel = unknownMode ?? PERMISSION_MODE_LABELS[displayMode]
  const permTitle = unavailableOn
    ? `Permissions: ${effectLabel}, ${pickLabel} isn't available on ${unavailableOn}`
    : `Permissions: ${effectLabel}`
  const contextPercent = useActive((s) => s?.contextPercent ?? null)
  const contextTokens = useActive((s) => s?.contextTokens ?? null)
  const contextWindow = useActive((s) => s?.contextWindow ?? null)
  const sendMessage = useSession((s) => s.sendMessage)
  const interrupt = useSession((s) => s.interrupt)
  const setPermissionMode = useSession((s) => s.setPermissionMode)
  const setNotice = useSession((s) => s.setNotice)

  // Drop/paste/pick routing:
  //  - Images inline as thumbnails (the model can't @-read pixels; it needs the block).
  //  - A pathful file or folder main would let a message point at becomes a reference chip. Any other path stays
  //    an @path token at the caret (relative under cwd, else absolute), which the CLI resolves itself.
  //  - A file with no resolvable path (a pasted screenshot Blob) can't be referenced by path, so
  //    fall back to inlining its bytes so paste still works.
  const addFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0 || !handleId) return
    // Bind to the handle the drop started on, so a conversion that finishes after the user
    // switched sessions lands in this session's draft, not whichever is active then.
    const h = handleId
    const inline: File[] = []
    const paths: string[] = []
    for (const file of files) {
      const abs = file.type.startsWith('image/') ? '' : window.clui.getPathForFile(file)
      if (abs) paths.push(abs)
      else inline.push(file)
    }
    const [kinds, processed] = await Promise.all([
      paths.length ? window.clui.classifyRefPaths(h, paths).catch(() => []) : [],
      inline.length ? processDroppedFiles(inline) : null
    ])
    const slice = useSession.getState().sessions[h]
    if (!slice) return
    const { refs: inputs, mentions, outside } = routeDrop(paths, kinds, slice.cwd)
    const results = addToDraft(h, inputs, skippedNote)
    if (mentions.length) insertText(h, mentions.join(' ') + ' ')
    const said = dropText(
      inputs.filter((_, i) => results[i].status === 'added'),
      { inside: mentions.length - outside, outside },
      inputs.filter((_, i) => results[i].status === 'duplicate'),
      results.filter((r) => r.status === 'cap').length
    )
    if (said) useSession.getState().announceRefs(h, said)
    if (processed?.attachments.length) addDraftAttachments(h, processed.attachments)
    if (processed?.errors.length) setNotice(processed.errors.join(' '))
  }

  // After an await: reads the draft now, so typing during the IPC isn't overwritten. Splices at the textarea's
  // caret while `h` is still the active session, else appends to its draft.
  const insertText = (h: string, insert: string): void => {
    const st = useSession.getState()
    const cur = st.sessions[h]?.draftText ?? ''
    const ta = textareaRef.current
    if (h !== st.activeHandleId || !ta) return setDraftText(h, cur + (cur && !/\s$/.test(cur) ? ' ' : '') + insert)
    const at = Math.min(ta.selectionStart ?? cur.length, cur.length)
    setDraftText(h, cur.slice(0, at) + insert + cur.slice(at))
    setCaret(at + insert.length)
    requestAnimationFrame(() => ta.setSelectionRange(at + insert.length, at + insert.length))
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

  // Rebind a still-empty session to `dir`, carrying its draft. The CLI fixes the transcript folder
  // at process-create, so a pre-message dir change must respawn, not set_cwd; the jsonl is lazy, so
  // nothing is lost. A quick session stays ephemeral across the respawn so its "not saved" contract
  // isn't silently dropped by picking a folder.
  const respawnIn = async (dir: string): Promise<void> => {
    if (!handleId || dir === cwd) return
    const cur = useSession.getState().sessions[handleId]
    const draft = cur?.draftText ?? ''
    const carriedAttachments = cur?.draftAttachments ?? []
    const carriedRefs = cur?.contextRefs ?? []
    const wasEphemeral = cur?.ephemeral ?? false
    await closeSession(handleId)
    await startSession(dir, undefined, wasEphemeral ? { ephemeral: true } : undefined)
    const next = useSession.getState().activeHandleId
    if (!next) return
    if (draft) setDraftText(next, draft)
    if (carriedAttachments.length) addDraftAttachments(next, carriedAttachments)
    await carryRefs(next, carriedRefs)
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

  const submit = async (now = false): Promise<void> => {
    const typed = text.trim()
    if ((!typed && attachments.length === 0 && refs.length === 0) || !handleId) return
    const files: SendAttachment[] = attachments.map((a) => ({
      wire: toWireAttachment(a),
      display:
        a.kind === 'image'
          ? { kind: 'image', previewUrl: a.previewUrl, name: a.name, w: a.w, h: a.h }
          : a.kind === 'document'
            ? { kind: 'document', name: a.name, bytes: a.bytes }
            : { kind: 'text', name: a.name, bytes: a.bytes, lines: a.lines }
    }))
    // Consumed by id in this tick, so a reference added while the send awaits stays in the draft.
    clearDraft(handleId)
    clearRefs(handleId, refs.map((d) => d.ref.id))
    setCaret(0)
    await sendMessage(typed, files.length ? files : undefined, { now, refs })
  }

  const focusText = (): void => textareaRef.current?.focus()

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // When the autocomplete menu is open, let it consume ↑/↓/Enter/Tab/Esc first.
    if (ac.onKeyDown(e)) return
    // Backspace moves into the row rather than deleting: a chip is removed only by its own Delete.
    if (e.key === 'Backspace' && !text && refs.length + attachments.length > 0) {
      e.preventDefault()
      return void [...(dockRef.current?.querySelectorAll<HTMLElement>('[data-ui="context-chips"] [role="listitem"]') ?? [])].at(-1)?.focus()
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      // ⌘↵ during a turn sends into it instead of queuing; when idle it's a plain send.
      void submit(e.metaKey)
    }
  }

  // Track the caret after any interaction so the autocomplete sees the right token.
  const syncCaret = (): void => {
    const ta = textareaRef.current
    if (ta) setCaret(ta.selectionStart ?? 0)
  }

  // System Default lives in Settings only: mid-session the chip shows the concrete mode Claude runs under.
  const permOptions = PERMISSION_MODES.filter((m) => m !== 'inherit').map((m) => ({
    value: m,
    label: PERMISSION_MODE_LABELS[m],
    color: PERMISSION_MODE_COLORS[m],
    description:
      unavailableOn && m === modeChoice
        ? `Unavailable on ${unavailableOn}, so ${effectLabel} is in effect`
        : PERMISSION_MODE_DESCRIPTIONS[m],
    icon: <PermissionIcon mode={m} className="h-4 w-4" />,
    // Autonomous (bypassPermissions) is the full-access danger tier: the whole row goes err,
    // not a new hue (terracotta stays scarce).
    tone: m === 'bypassPermissions' ? ('danger' as const) : undefined
  }))

  return (
    <div className="@container/composer w-full">
      <div className="mx-auto w-full max-w-5xl px-7">
        <div
          ref={dockRef}
          data-ui="composer-dock"
          className={`dock-fade-both relative flex flex-col gap-2 rounded-xl border bg-bg-elev p-2 ${
            dragOver ? 'border-accent' : 'border-border has-[textarea[data-composer-input]:focus]:border-control-edge'
          }`}
          style={{ anchorName: '--composer-dock' } as CSSProperties}
          onDrop={onDrop}
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
        >
          <GateHost />
          {/* Drag-to-attach overlay: accent is legit here (a live, transient state cue). */}
          {dragOver && (
            <div data-ui="drop-overlay" className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-bg-elev/85">
              <div className="flex flex-col items-center gap-1">
                <div className="flex items-center gap-2 text-sm font-medium text-accent">
                  <IconPlus className="h-5 w-5" />
                  Drop to add to the message
                </div>
                {scoped && <div className="text-meta text-dim">Images go as pictures. Files and folders go as references Claude opens itself.</div>}
              </div>
            </div>
          )}
          {handleId && (
            <ContextChips
              handleId={handleId}
              target={null}
              refs={refs}
              notices={notices}
              attachments={attachments.map((a) => ({ view: attachmentChip(a.id, a), onRemove: () => removeAttachment(a.id) }))}
              focusText={focusText}
            />
          )}
          <span className="sr-only" aria-live="polite">
            {refAnnounce}
          </span>
          <div className="relative">
            {ac.render()}
            <textarea
              ref={textareaRef}
              data-composer-input
              aria-keyshortcuts="Meta+Enter"
              className="max-h-48 min-h-[52px] w-full resize-none bg-transparent [field-sizing:content] px-2 pt-1.5 text-sm leading-normal text-content outline-none placeholder:text-dim focus-visible:outline-none"
              placeholder="Message Claude…"
              aria-label="Message Claude"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={ac.open}
              aria-controls={ac.listboxId}
              aria-activedescendant={ac.activeId}
              aria-describedby={ac.describedBy}
              value={text}
              onChange={(e) => {
                if (handleId) {
                  setDraftText(handleId, e.target.value)
                  signalRefs(handleId, null, { note: null })
                }
                setCaret(e.target.selectionStart ?? e.target.value.length)
              }}
              onKeyDown={onKeyDown}
              onKeyUp={syncCaret}
              onClick={syncCaret}
              onPaste={onPaste}
              rows={2}
            />
          </div>
          <div className="flex min-w-0 items-center">
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
              data-ui="attach-button"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-control text-dim transition-colors hover:bg-control-hover hover:text-content disabled:cursor-default disabled:opacity-50"
              onClick={() => fileInputRef.current?.click()}
              disabled={!hasSession}
              title="Attach an image or file"
              aria-label="Attach an image or file"
            >
              <IconPlus className="h-4 w-4" />
            </button>
            <div className="ml-3 flex min-w-0 items-center gap-1.5 @max-[560px]/composer:ml-2">
              {ephemeral ? (
                <>
                  {/* A quick session trims the control row to its contract: not saved. */}
                  <span
                    className="flex h-8 items-center gap-1.5 whitespace-nowrap px-1 text-xs text-dim"
                    title="Not saved · discarded when you close it"
                  >
                    <IconGhost className="h-3.5 w-3.5 shrink-0" />
                    Not saved
                  </span>
                  {displayMode === 'bypassPermissions' && (
                    <span
                      className="flex h-8 items-center gap-1.5 whitespace-nowrap px-1 text-xs text-err"
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
                    dataUi="permission-chip"
                    // On a downgrade the check marks the held pick rather than the mode in effect.
                    value={unavailableOn ? modeChoice : displayMode}
                    options={permOptions}
                    onChange={(m) => void setPermissionMode(m)}
                    title={permTitle}
                    ariaLabel={permTitle}
                    triggerLabel={
                      unavailableOn ? (
                        <>
                          {effectLabel}
                          <span className="font-normal text-faint"> · {pickLabel} unavailable</span>
                        </>
                      ) : (
                        unknownMode ?? undefined
                      )
                    }
                    direction="up"
                    variant="pill"
                    menuClassName="w-72"
                    labelClassName="@max-[660px]/composer:sr-only"
                    chevronClassName="@max-[480px]/composer:hidden"
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
            <div className="ml-auto flex shrink-0 items-center gap-4 pl-2 pr-[2px] @max-[560px]/composer:gap-2">
              <ContextRing
                percent={contextPercent}
                usedTokens={contextTokens}
                contextWindow={contextWindow}
              />
              {(() => {
                const empty = !text.trim() && attachments.length === 0 && refs.length === 0
                const inert = !busy && empty
                return (
                  <button
                    type="button"
                    data-ui={busy ? 'stop-button' : 'send-button'}
                    aria-label={busy ? 'Stop' : 'Send'}
                    aria-disabled={inert || undefined}
                    title={busy ? 'Stop  ⌃C' : 'Send  ↵'}
                    onClick={() => {
                      if (busy) {
                        // The second click of a double-click lands here once the first has started the
                        // turn; ignoring the first 400ms keeps it from stopping the turn it just began.
                        if (turnStartMs !== null && Date.now() - turnStartMs < 400) return
                        void interrupt()
                      } else if (!inert) void submit()
                    }}
                    className={`relative flex h-[28px] w-[28px] items-center justify-center rounded-full transition-transform active:scale-95 ${
                      busy
                        ? 'bg-err text-on-err'
                        : inert
                          ? 'cursor-default bg-border text-faint'
                          : 'bg-accent text-on-accent hover:bg-accent-hover'
                    }`}
                  >
                    {/* One element for both states so focus survives the turn starting and ending; only the glyph crossfades. */}
                    <IconArrowUp
                      className={`absolute h-3 w-3 translate-y-[0.5px] transition-opacity duration-[var(--dur-fast)] ${busy ? 'opacity-0' : 'opacity-100'}`}
                    />
                    <IconStop
                      className={`absolute h-3 w-3 transition-opacity duration-[var(--dur-fast)] ${busy ? 'opacity-100' : 'opacity-0'}`}
                    />
                  </button>
                )
              })()}
            </div>
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
      dataUi="dir-chip"
      value={value}
      options={options}
      onChange={onSelect}
      ariaLabel={`Session directory: ${options.find((o) => o.value === value)?.label ?? value}`}
      title={directoryless ? undefined : (cwd ?? undefined)}
      direction="up"
      variant="pill"
      checkTone="neutral"
      menuClassName="w-64"
      labelClassName="@max-[800px]/composer:sr-only"
      chevronClassName="@max-[480px]/composer:hidden"
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

export function PermissionIcon({
  mode,
  className = 'h-3.5 w-3.5'
}: {
  mode: PermissionModeChoice
  className?: string
}): JSX.Element {
  const Glyph = PERMISSION_MODE_ICONS[mode]
  return <Glyph className={`${className} shrink-0 ${PERMISSION_MODE_COLORS[mode]}`} />
}
