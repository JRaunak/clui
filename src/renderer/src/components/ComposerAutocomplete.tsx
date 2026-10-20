/**
 * Autocomplete popover for the composer: a `/` command menu (skills + headless-safe
 * built-ins) and an `@` menu of agents, open File tabs and workspace files (git-aware, fuzzy).
 *
 * Design: the Composer owns the textarea; this hook-driven component reads the
 * current `text` + `caret`, detects the active trigger token, and returns an API
 * the composer uses to (a) know if the menu is open (to delegate ↑/↓/Enter/Tab/Esc)
 * and (b) render the popover. A command, skill or agent pick replaces the trigger token
 * inline; a file pick adds a reference chip and removes the token.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { CAP_NOTE, refKey, type RefInput } from '../../../shared/context'
import type { ChangeRefRequest } from '../../../shared/ipc'
import { denyChangeRead, useActive, useSession, EMPTY_REFS, EMPTY_SLASH_COMMANDS } from '../store'
import { fuzzyMatch, highlightRuns, rankPaths } from '../lib/fuzzy'
import { resolveSlashCommands } from '../lib/slashCommands'
import { paneRows, removeToken } from '../lib/composerRefs'
import { useWorkspaceListing } from '../lib/openLink'
import { mintedRef, recordMint } from '../lib/changeRefs'
import { addedText, baseOf, BUDGET_NOTE, CHANGE_DENIED, changeRefusedText, couldNotAdd, noMatchText, showingText, spokenRef, tooLargeText, truncatedText } from '../lib/refCopy'
import { addToDraft, signalRefs } from './ContextChips'
import { IconSearch } from './Icon'

interface Item {
  key: string
  /** Text inserted (without the trigger char), e.g. "compact" or "src/App.tsx". */
  value: string
  label: string
  hint?: string
  args?: string
  kind: 'command' | 'skill' | 'file' | 'agent'
  /** Full literal replacement (incl. trigger char), overriding the default
   *  `trigger.char + value`. Agents need the quoted `@"name (agent)"` form. */
  insert?: string
  /** The reference a pick adds in place of text. */
  input?: RefInput
  /** A Diff selection a pick mints, then adds. */
  mint?: ChangeRefRequest
  aria?: string
}

interface Row {
  it: Item
  matches: number[]
}

interface Group {
  label: string
  rows: Row[]
}

const RESULT_CAP = 50
const PANE_CAP = 8
const NO_MENU: { groups: Group[]; shown: number; total: number } = { groups: [], shown: 0, total: 0 }
/** Session and cwd pairs whose truncated listing was already announced. */
const toldTruncated = new Set<string>()

/** The active trigger token at the caret, or null if none. */
interface Trigger {
  char: '/' | '@'
  /** The query after the trigger char (e.g. "comp" for "/comp"). */
  query: string
  /** Index in `text` where the trigger char sits. */
  start: number
}

/**
 * Detect a `/` at the very START of the message, or an `@` token anywhere, ending
 * at the caret. `/` is only a command trigger at position 0 (so "http://x" or a
 * mid-sentence slash never triggers). `@` triggers when preceded by start/space.
 */
function detectTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret)
  // Slash: only when it's the first char of the message.
  if (/^\/[^\s]*$/.test(before)) {
    return { char: '/', query: before.slice(1), start: 0 }
  }
  // @-file: last @ that starts a token (preceded by start or whitespace), no space after.
  const at = before.lastIndexOf('@')
  if (at !== -1) {
    const prev = at === 0 ? '' : before[at - 1]
    const token = before.slice(at + 1)
    if ((at === 0 || /\s/.test(prev)) && !/\s/.test(token)) {
      return { char: '@', query: token, start: at }
    }
  }
  return null
}

export interface AutocompleteApi {
  open: boolean
  /** Render the popover (null when closed). */
  render: () => JSX.Element | null
  /** Feed a keydown while open; returns true if it was consumed (composer skips it). */
  onKeyDown: (e: React.KeyboardEvent) => boolean
  /** Stable id of the listbox, for the textarea's `aria-controls`. */
  listboxId: string
  /** Id of the active option, for the textarea's `aria-activedescendant`; undefined when closed. */
  activeId: string | undefined
  /** The textarea's `aria-describedby` while the footer shows: the no-match line first when there is one. */
  describedBy: string | undefined
}

const lift = (it: Item): number => (it.kind === 'file' ? 0 : 10000)

export function useComposerAutocomplete(
  text: string,
  caret: number,
  apply: (nextText: string, nextCaret: number) => void
): AutocompleteApi {
  const cwd = useActive((s) => s?.cwd ?? null)
  const handleId = useActive((s) => s?.handleId ?? null)
  const refs = useActive((s) => s?.contextRefs ?? EMPTY_REFS)
  const tabs = useActive((s) => s?.surfaces.tabs ?? null)
  const changeRead = useActive((s) => s?.changeRead ?? null)
  const [sel, setSel] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()
  const footerId = useId()
  const emptyId = useId()

  const trigger = detectTrigger(text, caret)
  const q = trigger?.query ?? ''

  const listing = useWorkspaceListing(handleId, trigger?.char === '@')
  const truncated = !!listing?.truncated
  const files = useMemo(() => (listing ? [...listing.files] : []), [listing])

  // Build candidate items for the active trigger.
  const skills = useActiveSkills(trigger?.char === '/')
  const agents = useActiveAgents(trigger?.char === '@')
  // The CLI's live command list (from the initialize response), curated to the
  // headless-safe allowlist + hydrated with real descriptions/arg-hints.
  const liveCommands = useActive((s) => s?.slashCommands ?? EMPTY_SLASH_COMMANDS)
  const commands = useMemo(() => resolveSlashCommands(liveCommands), [liveCommands])
  const attached = useMemo(() => new Set(refs.map((d) => refKey(d.ref))), [refs])

  const commandItems = useMemo<Item[]>(
    () => [
      ...commands.map((c) => ({ key: `command:${c.name}`, value: c.name, label: `/${c.name}`, hint: c.description, args: c.argumentHint, kind: 'command' as const })),
      ...skills.map((s) => ({ key: `skill:${s.name}`, value: s.name, label: `/${s.name}`, hint: s.description, kind: 'skill' as const }))
    ],
    [commands, skills]
  )
  // Agents first (delegate the turn), then files. Empty query keeps this order
  // since the fuzzy sort is skipped, so agents sit above files naturally.
  const atItems = useMemo<Item[]>(
    () => [
      ...agents.map((a) => ({ key: `agent:${a.name}`, value: a.name, label: a.name, hint: a.description, kind: 'agent' as const, insert: `@"${a.name} (agent)"` })),
      ...files.map((f): Item => {
        const input: RefInput | undefined = cwd ? { kind: 'file', path: `${cwd}/${f}` } : undefined
        return { key: `file:${f}`, value: f, label: f, kind: 'file', input, ...(input && attached.has(refKey(input)) ? { hint: 'In message' } : {}) }
      })
    ],
    [agents, files, cwd, attached]
  )

  // Fuzzy-filter + rank by the trigger's query. An agent, skill or command that matches by name sits above
  // every file. Commands and Open in pane rows render a label that isn't their match key, so their highlight is
  // recomputed on the label.
  const menu = useMemo(() => {
    if (!trigger) return NO_MENU
    const rowOf = ({ item: it, matches }: { item: Item; matches: number[] }): Row => ({ it, matches: it.label === it.value ? matches : fuzzyMatch(q, it.label).matches })
    if (trigger.char === '/') {
      const rows = rankPaths(q, commandItems, (it) => it.value, lift).slice(0, RESULT_CAP).map(rowOf)
      return rows.length ? { groups: [{ label: 'Commands & skills', rows }], shown: 0, total: 0 } : NO_MENU
    }
    const inDraft = (r: RefInput): boolean => attached.has(refKey(r))
    const minted = (req: ChangeRefRequest): boolean => {
      const ref = handleId ? mintedRef(handleId, req) : null
      return !!ref && refs.some((d) => d.ref.kind === 'change' && d.ref.changeRef === ref)
    }
    const pane = rankPaths(q, paneRows(Object.values(tabs ?? {}), cwd, window.clui.homeDir, { inDraft, minted, changeRead }), (r) => r.rel).slice(0, PANE_CAP)
    const taken = new Set(pane.flatMap(({ item: { input } }) => (input?.kind === 'file' && !input.lines ? [input.path] : [])))
    const paneItems = pane.map(({ item: r }): Row => ({
      it: { key: r.key, value: r.rel, label: r.label, hint: r.hint, kind: 'file', ...(r.input ? { input: r.input } : { mint: r.mint }), aria: r.aria },
      matches: fuzzyMatch(q, r.label).matches
    }))
    const ranked = rankPaths(q, taken.size ? atItems.filter((it) => !it.input || it.input.kind !== 'file' || !taken.has(it.input.path)) : atItems, (it) => it.value, lift)
    const rest = ranked.slice(0, RESULT_CAP - paneItems.length).map(rowOf)
    const groups = [
      ...(paneItems.length ? [{ label: 'Open in pane', rows: paneItems }] : []),
      ...(rest.length ? [{ label: 'Agents & files', rows: rest }] : [])
    ]
    return {
      groups,
      shown: rest.filter((r) => r.it.kind === 'file').length,
      total: q.trim() ? ranked.filter((r) => r.item.kind === 'file').length : 0
    }
  }, [trigger?.char, q, commandItems, atItems, tabs, cwd, attached, refs, changeRead, handleId])
  const flat = useMemo(() => menu.groups.flatMap((g) => g.rows), [menu])

  const open = trigger !== null && flat.length > 0
  // A truncated listing explains a query that matches nothing; a complete one just closes.
  const empty = trigger?.char === '@' && !open && truncated
  const visible = (open || empty) && !dismissed
  const menuOpen = open && !dismissed
  const footer = useMemo(
    () => (trigger?.char === '@' ? [truncated ? truncatedText : '', menu.total > menu.shown ? showingText(menu.shown, menu.total) : ''].filter(Boolean) : []),
    [trigger?.char, truncated, menu]
  )

  useEffect(() => {
    setSel((s) => (flat.length ? Math.min(s, flat.length - 1) : 0))
  }, [flat.length])
  // Reset selection to the top whenever the query changes.
  useEffect(() => setSel(0), [trigger?.query, trigger?.char])
  // Keep the selected row in view as the user arrows through a long list.
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [sel])
  // Esc dismissal: hide until the query changes again.
  useEffect(() => setDismissed(false), [trigger?.query, trigger?.char, trigger?.start])

  useEffect(() => {
    if (!visible || !truncated || trigger?.char !== '@' || !handleId) return
    const key = `${handleId}\0${cwd}`
    if (toldTruncated.has(key)) return
    toldTruncated.add(key)
    useSession.getState().announceRefs(handleId, truncatedText)
  }, [visible, truncated, trigger?.char, handleId, cwd])

  const pick = useCallback(
    (i: number) => {
      if (!trigger) return
      const chosen = flat[i]?.it
      if (!chosen) return
      if (chosen.mint && handleId) return pickChange(handleId, chosen.mint, trigger.start, `@${trigger.query}`)
      const input = chosen.input
      if (input && handleId) {
        const say = (t: string): void => useSession.getState().announceRefs(handleId, t)
        const [r] = addToDraft(handleId, [input], () => CAP_NOTE)
        if (r.status === 'added' || r.status === 'duplicate') {
          say(r.status === 'added' ? addedText(input) : `Already attached: ${spokenRef(input)}`)
          const next = removeToken(text, trigger.start, caret)
          return apply(next.text, next.caret)
        }
        // Nothing was added, so what the user typed stays; the menu goes so Enter can't re-pick into the refusal.
        say(r.status === 'cap' ? CAP_NOTE : couldNotAdd(input))
        setDismissed(true)
        return apply(text, caret)
      }
      // Agents carry a full quoted `insert` (`@"name (agent)"`); everything else is
      // just the trigger char + value. Trailing space so you keep typing.
      const insert = `${chosen.insert ?? trigger.char + chosen.value} `
      // Replace from the trigger start up to the caret; leave the rest of the text intact.
      const nextText = text.slice(0, trigger.start) + insert + text.slice(caret)
      apply(nextText, trigger.start + insert.length)
    },
    [trigger, flat, text, caret, apply, handleId, changeRead]
  )

  // Mint is a round trip, so the draft is read again after it: typing in the meantime is kept, and the token goes
  // only if it is still there.
  const pickChange = (h: string, req: ChangeRefRequest, start: number, token: string): void => {
    const say = (t: string): void => useSession.getState().announceRefs(h, t)
    const refuse = (spoken: string, note?: string): void => {
      say(spoken)
      if (note) signalRefs(h, null, { note })
      setDismissed(true)
    }
    if (changeRead === false) return refuse(changeRefusedText('denied'), CHANGE_DENIED)
    void (async () => {
      let r
      try {
        r = await window.clui.createChangeRef(h, req)
      } catch {
        return refuse(`Couldn't add the change to ${baseOf(req.path)}.`)
      }
      if (!r.ok) {
        const size = { lines: r.lines ?? 0, bytes: r.bytes ?? 0 }
        if (r.reason === 'denied') denyChangeRead(h)
        return refuse(changeRefusedText(r.reason, size), r.reason === 'denied' ? CHANGE_DENIED : r.reason === 'too-large' ? tooLargeText(size.lines, size.bytes) : undefined)
      }
      recordMint(h, r.ref.changeRef, req)
      const [a] = addToDraft(h, [r.ref], () => CAP_NOTE, r.bytes)
      if (a.status !== 'added' && a.status !== 'duplicate') return refuse(a.status === 'cap' ? CAP_NOTE : a.status === 'budget' ? BUDGET_NOTE : couldNotAdd(r.ref))
      say(a.status === 'added' ? addedText(r.ref) : `Already attached: ${spokenRef(r.ref)}`)
      const cur = useSession.getState().sessions[h]?.draftText ?? ''
      const end = start + token.length
      if (cur.slice(start, end) !== token || !/^(\s|$)/.test(cur.slice(end))) return
      const next = removeToken(cur, start, end)
      const ta = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : null
      const now = ta?.selectionStart ?? end
      apply(next.text, now > end ? now - (cur.length - next.text.length) : next.caret)
    })()
  }

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!menuOpen) {
        if (!visible || e.key !== 'Escape') return false
        e.preventDefault()
        setDismissed(true)
        return true
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSel((s) => (s + 1) % flat.length)
        return true
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((s) => (s - 1 + flat.length) % flat.length)
        return true
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        pick(sel)
        return true
      }
      if (e.key === 'Enter') {
        // A fully typed `/command` sends as typed; re-picking would only add a trailing space. On `@`, Enter
        // always picks: an exact path is the file the menu would attach, and Esc then Enter sends the raw text.
        const typed = q.trim().toLowerCase()
        if (trigger?.char === '/' && flat.some((r) => r.it.value.toLowerCase() === typed)) return false
        e.preventDefault()
        pick(sel)
        return true
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        // Dismiss the menu; consume Esc so it doesn't bubble to other handlers.
        setDismissed(true)
        return true
      }
      return false
    },
    [menuOpen, visible, flat, sel, pick, q, trigger?.char]
  )

  // Shown the moment it mounts; it has no enter animation because it appears as you type.
  const popRef = useCallback((el: HTMLDivElement | null) => {
    if (el && !el.matches(':popover-open')) el.showPopover()
  }, [])
  const render = useCallback((): JSX.Element | null => {
    if (!visible) return null
    let idx = 0
    return (
      <div
        ref={popRef}
        popover="manual"
        data-ui="composer-menu"
        className="pop-base glass-thick flex flex-col rounded-lg"
        style={
          {
            positionAnchor: '--composer-dock',
            positionArea: 'top span-right',
            marginBottom: '8px',
            width: 'min(640px, calc(anchor-size(width) - 24px))'
          } as React.CSSProperties
        }
      >
        {open ? (
          <div id={listboxId} ref={listRef} className="max-h-72 overflow-y-auto py-1" role="listbox">
            {menu.groups.map((g, gi) => (
              <div key={g.label} role="group" aria-labelledby={`${listboxId}-g${gi}`}>
                <div
                  id={`${listboxId}-g${gi}`}
                  role="presentation"
                  className={gi === 0 ? 'flex items-center gap-2 px-3 py-1.5 text-meta text-dim' : 'px-3 pb-1.5 pt-3 text-meta text-dim'}
                >
                  {gi === 0 && trigger?.char === '@' && <IconSearch className="h-3 w-3" />}
                  {g.label}
                </div>
                {g.rows.map((r) => {
                  const i = idx++
                  const runs = highlightRuns(r.it.label, r.matches)
                  return (
                    <button
                      key={r.it.key}
                      id={`${listboxId}-opt-${i}`}
                      data-idx={i}
                      role="option"
                      aria-selected={i === sel}
                      aria-label={r.it.aria}
                      onMouseMove={() => setSel(i)}
                      onClick={() => pick(i)}
                      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left ${i === sel ? 'bg-[var(--glass-row-hover)]' : ''}`}
                    >
                      <span className="max-w-[45%] shrink-0 truncate font-mono text-xs text-content">
                        {runs.map((run, j) =>
                          run.match ? (
                            <span key={j} className="font-semibold text-content underline decoration-dim underline-offset-2">
                              {run.text}
                            </span>
                          ) : (
                            <span key={j}>{run.text}</span>
                          )
                        )}
                      </span>
                      {r.it.args && (
                        <span className="max-w-[30%] shrink-0 truncate font-mono text-meta text-dim" title={r.it.args}>
                          {r.it.args}
                        </span>
                      )}
                      {(r.it.kind === 'skill' || r.it.kind === 'agent') && (
                        <span className="shrink-0 rounded bg-[var(--glass-row-hover)] px-1.5 py-0.5 text-badge text-dim">
                          {r.it.kind}
                        </span>
                      )}
                      {r.it.hint && (
                        <span className="min-w-0 flex-1 truncate text-meta text-dim" title={r.it.hint}>
                          {r.it.hint}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        ) : (
          <p id={emptyId} data-ui="composer-menu-empty" className="px-3 py-2 text-sm text-dim">
            {noMatchText(q)}
          </p>
        )}
        {footer.length > 0 && (
          <div id={footerId} data-ui="composer-menu-footer" className="border-t border-[var(--glass-edge)] px-3 py-1.5 text-meta text-dim">
            {footer.map((t) => (
              <p key={t}>{t}</p>
            ))}
          </div>
        )}
      </div>
    )
  }, [visible, open, menu, sel, trigger?.char, q, pick, listboxId, footerId, emptyId, footer])

  const activeId = menuOpen ? `${listboxId}-opt-${sel}` : undefined
  const describedBy = visible && footer.length ? (open ? footerId : `${emptyId} ${footerId}`) : undefined

  return { open: menuOpen, render, onKeyDown, listboxId, activeId, describedBy }
}

/** Load the workspace's skills (once per cwd) for the `/` menu. */
function useActiveSkills(active: boolean): { name: string; description: string }[] {
  const cwd = useActive((s) => s?.cwd ?? null)
  const [skills, setSkills] = useState<{ name: string; description: string }[]>([])
  const loadedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!active || loadedFor.current === cwd) return
    loadedFor.current = cwd
    void window.clui.readConfig(cwd).then((b) => setSkills(b.skills.map((s) => ({ name: s.name, description: s.description }))))
  }, [active, cwd])
  return skills
}

/** Load the workspace's agents (once per cwd) for the `@` menu. Picking one inserts
 *  the quoted `@"name (agent)"` token the CLI needs to delegate the turn.
 *  ponytail: agent roster from readConfig (disk) that misses CLI built-in agents
 *  (Explore, claude); switch the source to the initialize control_response 'agents'
 *  array (event-mapper → new 'agents' DomainEvent → store, mirroring 'slash-commands')
 *  if users report a built-in agent missing from the @ menu. */
function useActiveAgents(active: boolean): { name: string; description: string }[] {
  const cwd = useActive((s) => s?.cwd ?? null)
  const [agents, setAgents] = useState<{ name: string; description: string }[]>([])
  const loadedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!active || loadedFor.current === cwd) return
    loadedFor.current = cwd
    void window.clui.readConfig(cwd).then((b) => setAgents(b.agents.map((a) => ({ name: a.name, description: a.description }))))
  }, [active, cwd])
  return agents
}
