import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ClipboardEvent,
  type DragEvent,
  type CSSProperties
} from 'react'
import { chipMode, effectiveMode, sidePending, sideShown, stoppedNotice, useActive, useSession, EMPTY_ATTACHMENTS, EMPTY_NOTICES, EMPTY_REFS, type SendAttachment } from '../store'
import { askOf, parseSide, SIDE_TITLE, sideChatOf } from '../lib/side'
import { askSide } from '../lib/sideEntry'
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
  IconShield,
  IconTarget
} from './Icon'
import { imageRefusal, processDroppedFiles, toWireAttachment, type ProcessedAttachment } from '../lib/images'
import { routeDrop, splitFiles } from '../lib/composerRefs'
import { tilde } from '../lib/tree'
import { basename, useProjectDirs } from '../lib/useProjectDirs'
import { baseOf, dropText, skippedNote } from '../lib/refCopy'
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
  // Depth counter so nested dragenter/dragleave (over child elements) don't flicker the
  // drop highlight; only the outermost enter/leave toggles it.
  const dragDepth = useRef(0)
  const busy = useActive((s) => s?.busy ?? false)
  const turnStartMs = useActive((s) => s?.turnStartMs ?? null)
  const hasSession = useActive((s) => !!s)
  const exited = useActive((s) => s?.exited ?? false)
  const cwd = useActive((s) => s?.cwd ?? null)
  // Editable only before the first turn: after a message is sent, the CLI has fixed the
  // transcript's folder-slug at process-create, so changing the dir would be a lie (that's a
  // fork/new session, out of scope). A directoryless session runs in the chat dir.
  const noMessages = useActive((s) => (s?.messages.length ?? 0) === 0)
  const chatDir = useSession((s) => s.chatDir)
  const projectDirs = useProjectDirs()
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
  //  - A pathful file or folder main would let a message point at becomes a reference chip. Any other path becomes a
  //    path-only chip. Never @ text: the CLI inlines an @ mention's whole content.
  //  - A file with no resolvable path (a pasted screenshot Blob) can't be referenced by path, so
  //    fall back to inlining its bytes so paste still works.
  // `h` is the handle the drop started on, so a conversion that finishes after the user switched sessions lands in
  // this session's draft. False when that session is gone.
  const attach = async (h: string, inline: File[], paths: string[], refused: string[] = []): Promise<boolean> => {
    const [kinds, processed] = await Promise.all([
      paths.length ? window.clui.classifyRefPaths(h, paths).catch(() => []) : [],
      inline.length ? processDroppedFiles(inline) : null
    ])
    if (!useSession.getState().sessions[h]) return false
    const inputs = routeDrop(paths, kinds)
    const results = addToDraft(h, inputs, skippedNote)
    const said = dropText(
      inputs.filter((_, i) => results[i].status === 'added'),
      inputs.filter((_, i) => results[i].status === 'duplicate'),
      results.filter((r) => r.status === 'cap').length
    )
    if (said) useSession.getState().announceRefs(h, said)
    if (processed?.attachments.length) addDraftAttachments(h, processed.attachments)
    const lost = paths.filter((_, i) => !kinds[i]).map((p) => `Couldn't add ${baseOf(p)}. It's missing or isn't a file or folder.`)
    const errors = [...refused, ...lost, ...(processed?.errors ?? [])]
    if (errors.length) setNotice(errors.join(' '))
    return true
  }

  // A stopped session's process is gone, so an attach asks main nothing and offers Resume instead.
  const stopped = (focus: boolean): boolean => {
    const slice = handleId ? useSession.getState().sessions[handleId] : undefined
    if (!slice?.exited) return false
    stoppedNotice(slice, focus)
    return true
  }

  const addFiles = (files: File[]): void => {
    if (!files.length || !handleId || stopped(false)) return
    const { inline, paths } = splitFiles(files, window.clui.getPathForFile)
    void attach(handleId, inline, paths)
  }

  const pickFiles = async (keyed: boolean): Promise<void> => {
    if (!handleId || stopped(keyed)) return
    const h = handleId
    const picked = await window.clui.pickAttachments(h).catch(() => null)
    if (!picked) return
    const images = picked.images.map((i) => new File([i.bytes], i.name, { type: i.mime }))
    const alive = await attach(h, images, picked.paths, picked.refused.map(imageRefusal))
    if (alive && h === useSession.getState().activeHandleId) textareaRef.current?.focus()
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
    addFiles(files)
  }

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    dragDepth.current = 0
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    addFiles(files)
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

  // The chat dir never lists as a project; picking it is "No project".
  const dirOptions = useMemo<DropdownOption<string>[]>(
    () => [
      ...projectDirs.map((d) => ({ value: d, label: basename(d), description: d })),
      { value: DIR_PICK, label: 'Choose a folder…', icon: <IconFolderOpen className="h-4 w-4" /> },
      {
        value: DIR_NONE,
        label: 'No project',
        ...(chatDir ? { description: `Runs in ${tilde(chatDir, window.clui.homeDir)}` } : {}),
        divider: true
      }
    ],
    [projectDirs, chatDir]
  )

  const onSelectDir = (v: string): void => {
    if (v === DIR_PICK) {
      void chooseDirectory()
      return
    }
    const target = v === DIR_NONE ? chatDir : v
    if (target) void respawnIn(target)
  }

  const submit = async (now = false, keyed = false): Promise<void> => {
    const typed = text.trim()
    if ((!typed && attachments.length === 0 && refs.length === 0) || !handleId) return
    // Side input is text only, so attachments and chips stay here for the next message.
    const side = parseSide(typed)
    if (side) return void askSide(handleId, side.question, keyed)
    const files: SendAttachment[] = attachments.map((a) => ({
      wire: toWireAttachment(a),
      display:
        a.kind === 'image'
          ? { kind: 'image', previewUrl: a.previewUrl, name: a.name, w: a.w, h: a.h }
          : a.kind === 'document'
            ? { kind: 'document', name: a.name, bytes: a.bytes }
            : a.origin === 'side'
              ? { kind: 'text', name: a.name, bytes: a.bytes, lines: a.lines, origin: a.origin, side: a.side, text: a.text }
              : { kind: 'text', name: a.name, bytes: a.bytes, lines: a.lines }
    }))
    // A stopped session keeps the draft; the notice's Resume sends it.
    if (exited) return sendMessage(typed, files.length ? files : undefined, { now, refs, keyed })
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
      void submit(e.metaKey, true)
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
          <SideNeedsYou />
          {/* Drag-to-attach overlay: accent is legit here (a live, transient state cue). */}
          {dragOver && (
            <div data-ui="drop-overlay" className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-bg-elev/85">
              <div className="flex flex-col items-center gap-1">
                <div className="flex items-center gap-2 text-sm font-medium text-accent">
                  <IconPlus className="h-5 w-5" />
                  Drop to add to the message
                </div>
                <div className="text-meta text-dim">Images go as pictures. Files and folders go as references Claude opens itself.</div>
              </div>
            </div>
          )}
          {handleId && (
            <ContextChips
              handleId={handleId}
              target={null}
              refs={refs}
              notices={notices}
              attachments={attachments.map((a) => ({ view: attachmentChip(a.id, a), chat: sideChatOf(a), onRemove: () => removeAttachment(a.id) }))}
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
            <button
              type="button"
              data-ui="attach-button"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-control text-dim transition-colors pointer-fine:hover:bg-control-hover pointer-fine:hover:text-content disabled:cursor-default disabled:opacity-50"
              onClick={(e) => void pickFiles(e.detail === 0)}
              disabled={!hasSession}
              title="Attach files or folders"
              aria-label="Attach files or folders"
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
              <SendStop
                busy={busy}
                inert={!busy && !text.trim() && attachments.length === 0 && refs.length === 0}
                turnStartMs={turnStartMs}
                onStop={() => void interrupt()}
                onSend={() => void submit()}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Send and Stop as one element, so focus survives a turn starting and ending; only the glyph crossfades. `ui`
 *  prefixes its data-ui, and `title` replaces Send's while it's inert for a reason. */
export function SendStop({ busy, inert, turnStartMs, onStop, onSend, ui = '', title }: { busy: boolean; inert: boolean; turnStartMs: number | null; onStop: () => void; onSend: () => void; ui?: string; title?: string }): JSX.Element {
  return (
    <button
      type="button"
      data-ui={`${ui}${busy ? 'stop-button' : 'send-button'}`}
      aria-label={busy ? 'Stop' : 'Send'}
      aria-disabled={(!busy && inert) || undefined}
      aria-description={!busy && inert ? title : undefined}
      title={busy ? 'Stop  ⌃C' : (title ?? 'Send  ↵')}
      onClick={() => {
        if (busy) {
          // The second click of a double-click lands here once the first has started the
          // turn; ignoring the first 400ms keeps it from stopping the turn it just began.
          if (turnStartMs !== null && Date.now() - turnStartMs < 400) return
          onStop()
        } else if (!inert) onSend()
      }}
      className={`relative flex h-[28px] w-[28px] items-center justify-center rounded-full transition-transform active:scale-95 ${
        busy ? 'bg-err text-on-err' : inert ? 'cursor-default bg-border text-faint' : 'bg-accent text-on-accent hover:bg-accent-hover'
      }`}
    >
      <IconArrowUp className={`absolute h-3 w-3 translate-y-[0.5px] transition-opacity duration-[var(--dur-fast)] ${busy ? 'opacity-0' : 'opacity-100'}`} />
      <IconStop className={`absolute h-3 w-3 transition-opacity duration-[var(--dur-fast)] ${busy ? 'opacity-100' : 'opacity-0'}`} />
    </button>
  )
}

/** A side chat's gate waits while its tab is out of sight. The line shows it from main's dock and leads to it. */
function SideNeedsYou(): JSX.Element | null {
  const handleId = useSession((s) => s.activeHandleId)
  const ask = useSession((s) => {
    const p = handleId && !sideShown(s, handleId) ? sidePending(s, handleId) : null
    return p ? askOf(p) : null
  })
  if (!handleId || !ask) return null
  const show = (): void => {
    useSession.getState().openSurface(handleId, { kind: 'side', key: '', title: SIDE_TITLE }, 'focus', 'user', 'user')
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-ui="side-dock"] [data-ui="gate-title"]')?.focus())
  }
  return (
    <button
      type="button"
      data-ui="side-needs-you"
      aria-label={`Side chat needs you: ${ask}. Show request`}
      onClick={show}
      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-meta transition-opacity duration-fast ease-out starting:opacity-0 motion-reduce:transition-none pointer-fine:hover:bg-[var(--glass-row-hover)]"
    >
      <IconShield className="h-3.5 w-3.5 shrink-0 text-warn" />
      <span className="min-w-0 truncate text-dim">
        <span className="font-medium text-content">Side chat needs you</span>: {ask}
      </span>
      <span className="ml-auto shrink-0 text-content">Show</span>
    </button>
  )
}

/**
 * The session's working directory, state legible by glyph AND text. Before the first turn
 * it's a dropdown to bind/rebind/unbind the dir
 * (recent dirs · choose a folder · "No project"); after, the folder is locked at the CLI's
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
      ariaLabel={`Project: ${options.find((o) => o.value === value)?.label ?? value}`}
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
