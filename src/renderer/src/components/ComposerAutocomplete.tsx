/**
 * Autocomplete popover for the composer: a `/` command menu (skills + headless-safe
 * built-ins) and an `@` file picker (git-aware, fuzzy). Surfacing affordances only —
 * the CLI already honors typed `/cmd` and `@path`; this adds the menu.
 *
 * Design: the Composer owns the textarea; this hook-driven component reads the
 * current `text` + `caret`, detects the active trigger token, and returns an API
 * the composer uses to (a) know if the menu is open (to delegate ↑/↓/Enter/Tab/Esc)
 * and (b) render the popover. Picking replaces the trigger token inline at the caret.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useActive, EMPTY_SLASH_COMMANDS } from '../store'
import { fuzzyMatch, highlightRuns } from '../lib/fuzzy'
import { resolveSlashCommands } from '../lib/slashCommands'
import { IconSearch } from './Icon'

interface Item {
  /** Text inserted (without the trigger char), e.g. "compact" or "src/App.tsx". */
  value: string
  label: string
  hint?: string
  kind: 'command' | 'skill' | 'file' | 'agent'
  /** Full literal replacement (incl. trigger char), overriding the default
   *  `trigger.char + value`. Agents need the quoted `@"name (agent)"` form. */
  insert?: string
}

/** Score at/above which the query matches a NAME contiguously (substring or better),
 *  not just as scattered letters in a path. The floor and the scoring tiers share it. */
const NAME_TIER = 1000

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
}

export function useComposerAutocomplete(
  text: string,
  caret: number,
  apply: (nextText: string, nextCaret: number) => void
): AutocompleteApi {
  const cwd = useActive((s) => s?.cwd ?? null)
  const [files, setFiles] = useState<string[]>([])
  const [sel, setSel] = useState(0)
  const loadedForCwd = useRef<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const trigger = detectTrigger(text, caret)

  // Lazy-load the workspace file list the first time an `@` trigger opens (per cwd).
  useEffect(() => {
    if (trigger?.char !== '@' || !cwd || loadedForCwd.current === cwd) return
    loadedForCwd.current = cwd
    void window.clui.listWorkspaceFiles(cwd).then((r) => setFiles(r.files))
  }, [trigger?.char, cwd])

  // Build candidate items for the active trigger.
  const skills = useActiveSkills(trigger?.char === '/')
  const agents = useActiveAgents(trigger?.char === '@')
  // The CLI's live command list (from the initialize response), curated to the
  // headless-safe allowlist + hydrated with real descriptions/arg-hints.
  const liveCommands = useActive((s) => s?.slashCommands ?? EMPTY_SLASH_COMMANDS)
  const commands = useMemo(() => resolveSlashCommands(liveCommands), [liveCommands])
  const candidates = useMemo<Item[]>(() => {
    if (!trigger) return []
    if (trigger.char === '/') {
      return [
        ...commands.map((c) => ({
          value: c.name,
          label: `/${c.name}`,
          hint: c.description,
          kind: 'command' as const
        })),
        ...skills.map((s) => ({
          value: s.name,
          label: `/${s.name}`,
          hint: s.description,
          kind: 'skill' as const
        }))
      ]
    }
    // Agents first (delegate the turn), then files. Empty query keeps this order
    // since the fuzzy sort is skipped — so agents sit above files naturally.
    return [
      ...agents.map((a) => ({
        value: a.name,
        label: a.name,
        hint: a.description,
        kind: 'agent' as const,
        insert: `@"${a.name} (agent)"`
      })),
      ...files.map((f) => ({ value: f, label: f, kind: 'file' as const }))
    ]
  }, [trigger?.char, skills, agents, files, commands])

  // Fuzzy-filter + rank by the trigger's query.
  const results = useMemo(() => {
    if (!trigger) return []
    const q = trigger.query
    const ql = q.trim().toLowerCase()
    const scored = candidates
      .map((it) => {
        const m = fuzzyMatch(q, it.value)
        let score = m.score
        // Tiers spaced 1000 apart so a lower one can't accumulate into a higher: a flat
        // bonus let "@basil" rank a .light.png (b/s/l on segment starts) above the basil
        // agent. `base` is the final path segment for a file, the whole name otherwise.
        // kindLift floats an agent/skill/command above every file, but only on a real name
        // hit (substring or better), never a scattered match.
        if (ql) {
          const base = it.kind === 'file' ? it.value.slice(it.value.lastIndexOf('/') + 1) : it.value
          const bl = base.toLowerCase()
          const bm = fuzzyMatch(q, base)
          const kindLift = it.kind === 'file' ? 0 : 10000
          if (bm.score !== null) score = Math.max(score ?? 0, bm.score) // scattered
          if (bl.includes(ql)) score = Math.max(score ?? 0, kindLift + NAME_TIER + (bm.score ?? 0)) // substring
          if (bl.startsWith(ql)) score = Math.max(score ?? 0, kindLift + 2 * NAME_TIER + (bm.score ?? 0)) // prefix
          if (bl === ql) score = Math.max(score ?? 0, kindLift + 3 * NAME_TIER) // exact
        }
        // Highlight indices must index the LABEL we actually render — commands
        // render as "/usage" but are matched on the value "usage", so value-relative
        // indices are off by the leading "/" (lit the slash, dropped the last char).
        // Files have label === value, so reuse the already-computed matches.
        const matches = it.label === it.value ? m.matches : fuzzyMatch(q, it.label).matches
        return { it, score, matches }
      })
      .filter((r) => r.score !== null)
    // Tie-break by shorter value: within a tier, "Composer.tsx" beats
    // "ComposerAutocomplete.tsx" and the exact name beats a longer path that shares its prefix.
    if (q.trim())
      scored.sort((a, b) => (b.score as number) - (a.score as number) || a.it.value.length - b.it.value.length)
    // Drop scattered matches (below NAME_TIER) only when a real name match exists: "@co" on a
    // deep cwd is a subsequence of ~3000 paths but a name-match of ~150. When nothing scored
    // higher, keep them, so a deliberately deep query still finds its file, not an empty menu.
    const floored = scored.some((r) => (r.score as number) >= NAME_TIER)
      ? scored.filter((r) => (r.score as number) >= NAME_TIER)
      : scored
    return floored.slice(0, 50)
  }, [candidates, trigger?.query])

  const open = trigger !== null && results.length > 0

  useEffect(() => {
    setSel((s) => (results.length ? Math.min(s, results.length - 1) : 0))
  }, [results.length])
  // Reset selection to the top whenever the query changes.
  useEffect(() => setSel(0), [trigger?.query, trigger?.char])
  // Keep the selected row in view as the user arrows through a long list.
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const pick = useCallback(
    (i: number) => {
      if (!trigger) return
      const chosen = results[i]?.it
      if (!chosen) return
      // Agents carry a full quoted `insert` (`@"name (agent)"`); everything else is
      // just the trigger char + value. Trailing space so you keep typing.
      const insert = `${chosen.insert ?? trigger.char + chosen.value} `
      // Replace from the trigger start up to the caret; leave the rest of the text intact.
      const nextText = text.slice(0, trigger.start) + insert + text.slice(caret)
      apply(nextText, trigger.start + insert.length)
    },
    [trigger, results, text, caret, apply]
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!open) return false
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSel((s) => (s + 1) % results.length)
        return true
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((s) => (s - 1 + results.length) % results.length)
        return true
      }
      // Tab ALWAYS completes to the selected item. Enter completes too — EXCEPT
      // when the user has already typed a value that exactly matches an item (e.g.
      // the full `/context`): then Enter should SEND, not re-pick (re-picking would
      // insert a trailing space / the wrong fuzzy row and the command never sends).
      if (e.key === 'Tab') {
        e.preventDefault()
        pick(sel)
        return true
      }
      if (e.key === 'Enter') {
        const q = (trigger?.query ?? '').trim()
        // Agents are EXCLUDED from the send-as-typed shortcut: a bare `@fiber` does
        // NOT delegate (only the quoted `@"fiber (agent)"` does), so Enter must always
        // run pick() to insert the quoted form — never send the raw typed name.
        const exact = results.some((r) => r.it.kind !== 'agent' && r.it.value.toLowerCase() === q.toLowerCase())
        if (exact) return false // let the composer send the typed command as-is
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
    [open, results, sel, pick, trigger?.query]
  )

  // Esc dismissal: hide until the query changes again.
  const [dismissed, setDismissed] = useState(false)
  useEffect(() => setDismissed(false), [trigger?.query, trigger?.char, trigger?.start])
  const visible = open && !dismissed

  const render = useCallback((): JSX.Element | null => {
    if (!visible) return null
    return (
      <div
        ref={listRef}
        className="absolute bottom-full left-0 z-50 mb-2 max-h-72 w-[min(460px,90%)] overflow-y-auto rounded-lg border border-border bg-bg-elev py-1 shadow-lg"
      >
        <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-faint">
          {trigger?.char === '@' && <IconSearch className="h-3 w-3" />}
          {trigger?.char === '/' ? 'Commands & skills' : 'Agents & files'}
        </div>
        {results.map((r, i) => {
          const runs = highlightRuns(r.it.label, r.matches)
          return (
            <button
              key={r.it.kind + ':' + r.it.value}
              data-idx={i}
              onMouseMove={() => setSel(i)}
              onClick={() => pick(i)}
              className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left ${i === sel ? 'bg-bg-raised' : ''}`}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-content">
                {runs.map((run, j) =>
                  run.match ? (
                    <span key={j} className="font-semibold text-accent">
                      {run.text}
                    </span>
                  ) : (
                    <span key={j}>{run.text}</span>
                  )
                )}
              </span>
              {(r.it.kind === 'skill' || r.it.kind === 'agent') && (
                <span className="shrink-0 rounded bg-bg-raised px-1.5 py-0.5 text-[10px] text-faint">
                  {r.it.kind}
                </span>
              )}
              {r.it.hint && (
                <span className="max-w-[55%] shrink-0 truncate text-[11px] text-dim">{r.it.hint}</span>
              )}
            </button>
          )
        })}
      </div>
    )
  }, [visible, results, sel, trigger?.char, pick])

  return { open: visible, render, onKeyDown }
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
 *  ponytail: agent roster from readConfig (disk) — misses CLI built-in agents
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
