/** AskUserQuestion picker: the model asking the user a structured question. The CLI fires
 *  it as `can_use_tool` with `requires_user_interaction: true` (fires even in bypassPermissions).
 *  Multiple questions, numbered options + free-text, Submit enables only when every question
 *  is answered. Wire format: allow + updatedInput = { questions, answers }. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSession, type PendingPermission } from '../store'
import { useEscape } from '../lib/useEscape'
import { useDialogFocus } from '../lib/useDialogFocus'
import { Button } from './Button'
import { IconCheck } from './Icon'

interface QOption {
  label: string
  description?: string
  // Optional per-option preview (a code snippet / ASCII mock) the CLI shows beside
  // the options so you can compare them. Display-only; never part of the answer.
  preview?: string
}
interface Question {
  question: string
  header?: string
  options: QOption[]
  multiSelect?: boolean
}

const FREE_TEXT = ' free-text' // sentinel selection meaning "use the typed value"

/** Validate one option: a non-null object with a string label. Non-string label/description/preview
 *  would crash the dialog when reaching `o.preview` reads and React children. */
function parseOption(o: unknown): QOption | null {
  if (!o || typeof o !== 'object') return null
  const r = o as Record<string, unknown>
  if (typeof r.label !== 'string') return null
  return {
    label: r.label,
    description: typeof r.description === 'string' ? r.description : undefined,
    preview: typeof r.preview === 'string' ? r.preview : undefined
  }
}

function parseQuestions(input: unknown): Question[] {
  if (input && typeof input === 'object' && Array.isArray((input as { questions?: unknown }).questions)) {
    return ((input as { questions: unknown[] }).questions as unknown[])
      .map((q): Question | null => {
        if (!q || typeof q !== 'object') return null
        const r = q as Record<string, unknown>
        if (typeof r.question !== 'string' || !Array.isArray(r.options)) return null
        const options = (r.options as unknown[]).map(parseOption).filter((o): o is QOption => o !== null)
        if (options.length === 0) return null
        return {
          question: r.question,
          header: typeof r.header === 'string' ? r.header : undefined,
          options,
          multiSelect: r.multiSelect === true
        }
      })
      .filter((q): q is Question => q !== null)
  }
  return []
}

export function QuestionDialog({ request }: { request: PendingPermission }): JSX.Element {
  const respond = useSession((s) => s.respondPermission)
  const questions = parseQuestions(request.input)
  const [tab, setTab] = useState(0) // active question index (== questions.length → Submit tab)
  // Per-question chosen option labels or the FREE_TEXT sentinel.
  const [picked, setPicked] = useState<Record<number, string[]>>({})
  const [freeText, setFreeText] = useState<Record<number, string>>({})
  // Optional per-question note, folded into the answer on submit. Never gates submit.
  const [note, setNote] = useState<Record<number, string>>({})
  // Which option's preview fills the side pane. Resolved to hovered → selected → first.
  const [hovered, setHovered] = useState<number | null>(null)
  const freeRef = useRef<HTMLInputElement>(null)

  const isAnswered = useCallback(
    (qi: number): boolean => {
      const p = picked[qi] ?? []
      if (p.includes(FREE_TEXT)) return (freeText[qi]?.trim().length ?? 0) > 0
      return p.length > 0
    },
    [picked, freeText]
  )
  const allAnswered = questions.length > 0 && questions.every((_, qi) => isAnswered(qi))

  const choose = (qi: number, label: string, multi: boolean): void => {
    setPicked((prev) => {
      const cur = prev[qi] ?? []
      if (multi) {
        // Custom text is EXCLUSIVE in multi-select: picking "Something else" clears the
        // normal picks, and picking a normal option clears the custom sentinel. If both
        // stay selected, submit sends ONLY the free text, silently dropping the
        // visibly-selected option.
        if (label === FREE_TEXT) {
          return { ...prev, [qi]: cur.includes(FREE_TEXT) ? cur.filter((l) => l !== FREE_TEXT) : [FREE_TEXT] }
        }
        const normal = cur.filter((l) => l !== FREE_TEXT)
        return {
          ...prev,
          [qi]: normal.includes(label) ? normal.filter((l) => l !== label) : [...normal, label]
        }
      }
      return { ...prev, [qi]: [label] }
    })
    if (label === FREE_TEXT) setTimeout(() => freeRef.current?.focus(), 0)
  }

  const submit = (): void => {
    if (!allAnswered) return
    const answers: Record<string, string | string[]> = {}
    questions.forEach((q, qi) => {
      const p = picked[qi] ?? []
      // The note folds into the answer value: the only channel the model receives.
      const n = note[qi]?.trim()
      const withNote = (v: string): string => (n ? `${v} (note: ${n})` : v)
      if (p.includes(FREE_TEXT)) {
        answers[q.question] = withNote(freeText[qi].trim())
      } else if (q.multiSelect) {
        // Carry the note as a trailing element so each pick stays clean.
        answers[q.question] = n ? [...p, `(note: ${n})`] : p
      } else {
        answers[q.question] = withNote(p[0])
      }
    })
    void respond({ requestId: request.requestId, behavior: 'allow', updatedInput: { questions, answers } })
  }

  // "Chat about this": deny the structured question so the user can free-type a reply.
  const chatInstead = (): void => {
    void respond({
      requestId: request.requestId,
      behavior: 'deny',
      message: 'The user chose to chat about this instead of answering the question.'
    })
  }

  // Cancel: neutral skip (allow + empty answers). Distinct from "chat": no message to the model.
  const cancel = useCallback((): void => {
    void respond({ requestId: request.requestId, behavior: 'allow', updatedInput: { questions, answers: {} } })
  }, [respond, request.requestId, questions])

  useEscape(true, cancel)

  // Switching questions clears the hovered option so stale hover-index can't drive the new preview.
  useEffect(() => setHovered(null), [tab])

  const tablistRef = useRef<HTMLDivElement>(null)

  // Tab stays native so options, free text, and footer are reachable in DOM order. Enter submits
  // when every question is answered, but not while an option button or free-text input has focus.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'INPUT' || tag === 'BUTTON') return
    if (e.key === 'Enter' && allAnswered) {
      e.preventDefault()
      submit()
    }
  }

  // W3C tabs pattern: Left/Right move both selected tab and DOM focus; roving tabindex keeps the tablist a single Tab stop.
  const onTablistKeyDown = (e: React.KeyboardEvent): void => {
    const last = questions.length - 1
    let next = tab
    if (e.key === 'ArrowRight') next = tab === last ? 0 : tab + 1
    else if (e.key === 'ArrowLeft') next = tab === 0 ? last : tab - 1
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = last
    else return
    e.preventDefault()
    setTab(next)
    tablistRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }

  if (questions.length === 0) {
    // Degenerate input: just let the user dismiss.
    return (
      <Shell>
        <div className="px-5 py-4 text-sm text-dim">Claude asked a question, but it couldn’t be parsed.</div>
        <Footer onCancel={cancel} onChat={chatInstead} submitDisabled onSubmit={submit} />
      </Shell>
    )
  }

  const q = questions[Math.min(tab, questions.length - 1)]
  const qi = Math.min(tab, questions.length - 1)
  // Tab-bar only shows when there's more than one question.
  const showTabs = questions.length > 1

  // Pane follows hovered → selected → first option, so it's never empty. No previews keeps compact layout.
  const hasPreviews = q.options.some((o) => !!o.preview)
  const selectedIdx = q.options.findIndex((o) => (picked[qi] ?? []).includes(o.label))
  const activeIdx = hovered ?? (selectedIdx >= 0 ? selectedIdx : 0)
  // Coerce non-string preview to '' so the pane never shows `[object Object]`.
  const rawPreview = q.options[activeIdx]?.preview
  const activePreview = typeof rawPreview === 'string' ? rawPreview : ''

  const optionList = (
    <>
      {q.options.map((opt, oi) => (
        <OptionRow
          key={opt.label}
          index={oi + 1}
          label={opt.label}
          description={opt.description}
          multi={Boolean(q.multiSelect)}
          selected={(picked[qi] ?? []).includes(opt.label)}
          onClick={() => choose(qi, opt.label, Boolean(q.multiSelect))}
          onHover={hasPreviews ? () => setHovered(oi) : undefined}
        />
      ))}
      {/* Type something: this row itself becomes the text input when chosen. */}
      {(picked[qi] ?? []).includes(FREE_TEXT) ? (
        <div className="flex items-center gap-2.5 rounded-md border border-accent bg-accent-surface px-3 py-2">
          <span className="w-4 shrink-0 text-center font-mono text-[11px] text-faint">
            {q.options.length + 1}
          </span>
          <input
            ref={freeRef}
            value={freeText[qi] ?? ''}
            onChange={(e) => setFreeText((p) => ({ ...p, [qi]: e.target.value }))}
            placeholder="Type your answer…"
            className="min-w-0 flex-1 bg-transparent text-sm text-content outline-none placeholder:text-faint"
          />
          <IconCheck className="h-3.5 w-3.5 shrink-0 text-accent" />
        </div>
      ) : (
        <OptionRow
          index={q.options.length + 1}
          label="Something else…"
          multi={Boolean(q.multiSelect)}
          selected={false}
          onClick={() => choose(qi, FREE_TEXT, false)}
          onHover={hasPreviews ? () => setHovered(null) : undefined}
        />
      )}
    </>
  )

  return (
    <Shell onKeyDown={onKeyDown} wide={hasPreviews}>
      {/* Tab uses no leading circle and no filled pill because those misread as a
          single-select control. */}
      {showTabs && (
        <div
          ref={tablistRef}
          role="tablist"
          aria-label="Questions"
          onKeyDown={onTablistKeyDown}
          className="flex items-stretch gap-1 overflow-x-auto border-b border-border px-4"
        >
          {questions.map((qq, i) => (
            <button
              key={i}
              role="tab"
              aria-selected={i === tab}
              tabIndex={i === tab ? 0 : -1}
              onClick={() => setTab(i)}
              className={`-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                i === tab
                  ? 'border-accent font-medium text-accent'
                  : 'border-transparent text-dim hover:text-content'
              }`}
            >
              {qq.header || `Q${i + 1}`}
              {/* title (not aria-label): Svg renders it as a real <title> so "answered" reaches AT. */}
              {isAnswered(i) && <IconCheck className="h-3 w-3 text-ok" title="answered" />}
            </button>
          ))}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
        <div className="font-serif text-base font-semibold text-content">{q.question}</div>
        {q.multiSelect && <div className="text-[11px] text-faint">Select all that apply</div>}
        {hasPreviews ? (
          <div className="flex items-start gap-4">
            <div
              role={q.multiSelect ? 'group' : 'radiogroup'}
              aria-label={q.question}
              className="flex w-[300px] shrink-0 flex-col gap-1.5"
            >
              {optionList}
            </div>
            <PreviewPane text={activePreview} />
          </div>
        ) : (
          <div
            role={q.multiSelect ? 'group' : 'radiogroup'}
            aria-label={q.question}
            className="flex flex-col gap-1.5"
          >
            {optionList}
          </div>
        )}
        {hasPreviews && (
          <label className="mt-1 flex flex-col gap-1.5">
            <span className="text-[11px] text-faint">Note (optional)</span>
            <input
              value={note[qi] ?? ''}
              onChange={(e) => setNote((p) => ({ ...p, [qi]: e.target.value }))}
              placeholder="Add a note for Claude…"
              className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-content outline-none placeholder:text-faint focus:border-accent"
            />
          </label>
        )}
      </div>

      <Footer onCancel={cancel} onChat={chatInstead} submitDisabled={!allAnswered} onSubmit={submit} />
    </Shell>
  )
}

function OptionRow({
  index,
  label,
  description,
  multi,
  selected,
  onClick,
  onHover
}: {
  index: number
  label: string
  description?: string
  // multi-select → checkbox semantics, single → radio; the pressed state reaches AT.
  multi: boolean
  selected: boolean
  onClick: () => void
  // When previews exist, hovering/focusing a row drives the side pane. onFocus so tabbing updates the preview.
  onHover?: () => void
}): JSX.Element {
  return (
    <button
      role={multi ? 'checkbox' : 'radio'}
      aria-checked={selected}
      onClick={onClick}
      onMouseEnter={onHover}
      onFocus={onHover}
      className={`flex items-start gap-2.5 rounded-md border px-3 py-2 text-left transition-colors ${
        selected ? 'border-accent bg-accent-surface' : 'border-border hover:border-border-strong hover:bg-bg-raised'
      }`}
    >
      <span className="mt-0.5 w-4 shrink-0 text-center font-mono text-[11px] text-faint">{index}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-content">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-dim">{description}</span>}
      </span>
      {selected && <IconCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />}
    </button>
  )
}

/** Preview side-panel. Reuses the existing surface styling so it doesn't read as a separate widget. */
function PreviewPane({ text }: { text: string }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-tool">
      <div className="border-b border-border/60 px-3 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">Preview</span>
      </div>
      {text ? (
        <pre className="max-h-[46vh] overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-xs text-content">
          {text}
        </pre>
      ) : (
        // This option carries no preview; say so rather than showing an empty box.
        <div className="px-3 py-2.5 text-xs text-faint">No preview for this option.</div>
      )}
    </div>
  )
}

function Footer({
  onCancel,
  onChat,
  submitDisabled,
  onSubmit
}: {
  onCancel: () => void
  onChat: () => void
  submitDisabled: boolean
  onSubmit: () => void
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 border-t border-border px-5 py-3">
      <Button variant="ghost" size="md" onClick={onChat} title="Skip the question and chat freely instead">
        Chat about this
      </Button>
      <div className="ml-auto flex gap-2">
        <Button variant="outline" size="md" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" size="md" onClick={onSubmit} disabled={submitDisabled}>
          Send answer
        </Button>
      </div>
    </div>
  )
}

function Shell({
  children,
  onKeyDown,
  // Widen only when the active question has previews. Clamps against 720px min window width.
  wide = false
}: {
  children: React.ReactNode
  onKeyDown?: (e: React.KeyboardEvent) => void
  wide?: boolean
}): JSX.Element {
  const dialogRef = useDialogFocus<HTMLDivElement>()
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onKeyDown={onKeyDown}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Claude is asking"
        className={`flex max-h-[80vh] flex-col rounded-xl border border-border bg-bg-elev shadow-lg outline-none ${
          wide ? 'w-[min(880px,94%)]' : 'w-[min(600px,92%)]'
        }`}
      >
        <div className="border-b border-border px-5 py-3">
          <div className="text-[11px] uppercase tracking-[0.14em] text-accent">Claude is asking</div>
        </div>
        {children}
      </div>
    </div>
  )
}
