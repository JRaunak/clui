import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { activeSlice, browserTabOf, restoredTab, surfaceLabel, useActive, useSession, EMPTY_STRINGS, EMPTY_SURFACES, EMPTY_TABS, type PerSessionState } from '../../store'
import { blockedOf, recheck, useBlockedVersion, type Blocked } from '../../lib/blockedFiles'
import { siteKeyOf, type TabState } from '../../../../shared/browser'
import { agentRefOf, type PaneKind } from '../../../../shared/surfaces'
import { PANE_BTN } from './PaneHeader'
import { shownPath, suffixes } from '../../lib/tree'
import { fileLike } from '../../lib/presentation'
import { agentInfo, agentRunState, denseNext, faceOf, RUN_WORDS, type RunStatusOf } from '../../lib/agents'
import { workflowSummary } from '../../lib/workflow'
import { formatElapsed } from '../../lib/turnEnd'
import { FileIcon } from '../FileIcon'
import { Menu } from '../Menu'
import { usePaneEntries } from './PanePicker'
import { AgentFace } from '../faces'
import { RunMark } from '../RunMark'
import { IconAgentBrowser, IconClose, IconDiff, IconFolder, IconPlus, IconSideChat, IconSubagents, IconWorkflow, IconWorkflows } from '../Icon'

const NEAREST: ScrollIntoViewOptions = { block: 'nearest', inline: 'nearest' }
const EMPTY_IDS: number[] = []
const UNSEEN_LINE = 'Updated since you last looked'
const BLOCKED: Record<Blocked, { suffix: string; line: string }> = {
  missing: { suffix: ', not found', line: 'File not found' },
  outside: { suffix: ", can't open", line: 'Outside this folder. Open it again to view it.' }
}

const tabButton = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-ui="surface-tabs"] [data-tab="${CSS.escape(id)}"]`)

const tabLabel = (t: Pick<TabState, 'title' | 'url'>): string => t.title || siteKeyOf(t.url) || 'New page'

/**
 * Closes a tab of the active session. The right neighbour takes its place, else the left; `refocus`
 * moves focus to it, which happens before the close so focus never falls to the body. Closing the
 * last tab hides the pane, so focus that was in it goes to the composer.
 */
export function closeTab(id: string, refocus: boolean): void {
  const st = useSession.getState()
  const slice = activeSlice(st)
  const order = slice?.surfaces.order ?? EMPTY_STRINGS
  const i = order.indexOf(id)
  if (!slice || i < 0) return
  const next = order[i + 1] ?? order[i - 1]
  if (next && refocus) tabButton(next)?.focus()
  if (order.length === 1) {
    const el = document.activeElement
    if (!el || el === document.body || el.closest('[data-ui="pane-secondary"]')) document.querySelector<HTMLElement>('[data-composer-input]')?.focus()
  }
  st.closeSurface(slice.handleId, id)
}

const STATE: Partial<Record<'driving' | 'user' | 'suspended', { suffix: string; line: string }>> = {
  driving: { suffix: ', Claude is driving', line: 'Claude is driving in this tab' },
  user: { suffix: ", you're driving", line: 'You took over this tab. Claude is paused here.' },
  suspended: {
    suffix: ', paused to save memory',
    line: 'Paused to save memory. Viewing it reloads the page, and anything typed into it is gone.'
  }
}

function stateOf(t: TabState): 'driving' | 'user' | 'suspended' | null {
  if (t.drive === 'driving' || t.drive === 'user') return t.drive
  return t.suspended ? 'suspended' : null
}

interface TabView {
  id: string
  kind: PaneKind
  label: string
  /** Distinguishes file tabs that share a basename. */
  suffix: string
  /** Made by Claude: the suffix ends in the text mark. */
  mark: boolean
  /** The rest of the accessible name, after the label. */
  more: string
  tip: string
  closeName: string
  state: 'driving' | 'user' | 'suspended' | null
  unseen: boolean
  fade: boolean
  /** Agent and workflow tabs: identity and run state, both shown even icon-only. */
  run?: { face: number | null; state: RunStatusOf['state'] }
}

const GLYPH: Partial<Record<PaneKind, (p: { className?: string }) => JSX.Element>> = {
  browser: IconAgentBrowser,
  diff: IconDiff,
  tree: IconFolder,
  workflow: IconWorkflow,
  agents: IconSubagents,
  workflows: IconWorkflows,
  side: IconSideChat
}

/** What an agent or workflow tab's name and tooltip say, from the slice. */
interface RunView {
  status: RunStatusOf
  face: number | null
  type: string | null
  parent: string | null
  /** A workflow's agents: done of total. */
  done?: number
  total?: number
}

/** The agent and workflow tabs' run views as one string, so the strip re-renders when one changes and not on every
 *  streamed token. */
function runSig(s: PerSessionState): string {
  const out: Record<string, RunView> = {}
  for (const t of Object.values(s.surfaces.tabs)) {
    const w = t.kind === 'workflow' ? s.workflows[t.key] : undefined
    if (w) {
      const sum = workflowSummary(w, s.pendingPermissions)
      out[t.id] = { status: sum.state, face: null, type: null, parent: null, done: sum.done, total: sum.total }
    }
    if (t.kind !== 'agent') continue
    const ref = agentRefOf(t.key)
    if (!ref) continue
    const up = t.trail?.[t.trail.length - 1]
    const upRef = up ? agentRefOf(up.replace(/^agent:/, '')) : null
    const parent = up ? (s.surfaces.tabs[up]?.title ?? (upRef?.by === 'tool' ? agentInfo(s, upRef.id).label : up.startsWith('workflow:') ? (s.workflows[up.slice(9)]?.name ?? 'Workflow') : 'Agent')) : null
    out[t.id] = { status: agentRunState(s, ref), face: faceOf(s, t), type: ref.by === 'tool' ? agentInfo(s, ref.id).subtype : null, parent }
  }
  return JSON.stringify(out)
}

const REASON_SPOKEN = { quit: 'Clui quit while it was running', 'no-result': 'it ended without a result' } as const
const REASON_LINE = { quit: 'Clui quit while it was running', 'no-result': 'It ended without a result' } as const

/** The tooltip's figure: a running clock, or how long it took. Unknown shows nothing. */
function figureOf({ state, startMs, durationMs }: RunStatusOf): string {
  if ((state === 'running' || state === 'background' || state === 'needs') && startMs !== undefined) return ` · ${formatElapsed(Date.now() - startMs)}`
  if (durationMs === undefined) return ''
  return state === 'done' ? ` · in ${formatElapsed(durationMs)}` : state === 'failed' || state === 'stopped' ? ` · after ${formatElapsed(durationMs)}` : ''
}

const dirOf = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf('/')))
const relTo = (cwd: string | null, p: string): string => (cwd && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p)

/**
 * The pane's tabs, in the header row, for every kind. Arrows only move focus: viewing a suspended
 * browser tab reloads it and a surface mounts on activation, so a tab is activated on Enter, Space or
 * a click, never by passing over it.
 */
export function SurfaceTabs(): JSX.Element {
  const handleId = useSession((s) => s.activeHandleId)
  const order = useActive((s) => s?.surfaces.order ?? EMPTY_STRINGS)
  const active = useActive((s) => s?.surfaces.active ?? null)
  const surfaceTabs = useActive((s) => s?.surfaces.tabs ?? EMPTY_SURFACES.tabs)
  const browserUnseen = useActive((s) => s?.surfaces.browserUnseen ?? EMPTY_SURFACES.browserUnseen)
  const browserTabs = useActive((s) => s?.browser?.tabs ?? EMPTY_TABS)
  const enter = useActive((s) => s?.browser?.enter ?? EMPTY_IDS)
  const announce = useActive((s) => s?.browser?.announce ?? '')
  const cwd = useActive((s) => s?.cwd ?? null)
  const createdMs = useActive((s) => s?.createdMs ?? 0)
  useBlockedVersion()
  const activate = useSession((s) => s.activateSurface)
  const entries = usePaneEntries()
  const listRef = useRef<HTMLDivElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const sig = useActive((s) => (s ? runSig(s) : '{}'))
  const runs = useMemo(() => JSON.parse(sig) as Record<string, RunView>, [sig])
  const [dense, setDense] = useState(false)
  // Tabs already here when the strip mounted don't fade, so reopening the pane stays still.
  const [initial] = useState(() => new Set(order))

  const files = order.flatMap((id) => (fileLike(surfaceTabs[id]?.kind) ? [surfaceTabs[id].key] : []))
  const dup = suffixes(files)
  // A restored file that can't open keeps its look. Its name and tooltip say why, re-checked when the window regains focus.
  const restoredFiles = order.flatMap((id) => {
    const t = surfaceTabs[id]
    return (t?.kind === 'file' || t?.kind === 'image' || t?.kind === 'doc' || t?.kind === 'sheet') && restoredTab({ createdMs }, t) ? [t.key] : []
  })
  const restoredKey = restoredFiles.join('\n')
  useEffect(() => {
    if (!handleId || !restoredKey) return
    const paths = restoredKey.split('\n')
    const check = (): void => recheck(handleId, paths)
    check()
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [handleId, restoredKey])
  const views = order.flatMap((id): TabView[] => {
    const n = browserTabOf(id)
    if (n !== null) {
      const t = browserTabs.find((x) => x.id === n)
      if (!t) return []
      const state = stateOf(t)
      const info = state ? STATE[state] : undefined
      const label = tabLabel(t)
      const unseen = !!browserUnseen[id]
      const tip = [`Tab ${t.id} · ${label}`, t.url === 'about:blank' ? '' : t.url, info?.line ?? '']
      return [{ id, kind: 'browser', label, suffix: '', mark: false, more: `, tab ${t.id}${info?.suffix ?? ''}`, tip: tip.filter(Boolean).join('\n'), closeName: `Close tab ${t.id}`, state, unseen, fade: enter.includes(t.id) && !initial.has(id) }]
    }
    const t = surfaceTabs[id]
    if (!t) return []
    const label = surfaceLabel(t)
    const common = { id, kind: t.kind, label, suffix: '', mark: false, more: '', tip: label, closeName: `Close ${label}`, state: null, unseen: !!t.unseen, fade: (t.openedBy === 'claude' || t.openedBy === 'change') && !initial.has(id) }
    if (t.kind === 'diff') return [{ ...common, tip: 'What Claude changed in this session' }]
    if (t.kind === 'tree') return [{ ...common, more: ', file tree', tip: cwd ? shownPath(cwd, window.clui.homeDir) : label }]
    const run = runs[id]
    if (run && t.kind === 'workflow') {
      const w = RUN_WORDS[run.status.state]
      const of = `${run.done} of ${run.total} agents done`
      return [{ ...common, run: { face: null, state: run.status.state }, more: `, workflow, ${w.spoken}, ${of}`, tip: `${label}\nWorkflow · ${w.word}${figureOf(run.status)}\n${of}` }]
    }
    if (run) {
      const { status, type, parent } = run
      const w = RUN_WORDS[status.state]
      const reason = status.state === 'interrupted' ? status.reason : undefined
      const more = `, ${type ? `${type} agent` : 'agent'}, ${w.spoken}${reason ? `, ${REASON_SPOKEN[reason]}` : ''}${parent ? `, inside ${parent}` : ''}`
      const tip = [label, `${type ? `${type} agent` : 'Agent'} · ${w.word}${figureOf(status)}`, parent ? `Inside ${parent}` : '', reason ? REASON_LINE[reason] : '']
      return [{ ...common, run: { face: run.face, state: status.state }, more, tip: tip.filter(Boolean).join('\n') }]
    }
    if (!fileLike(t.kind)) return [common]
    const suffix = dup.get(t.key) ?? ''
    const named = suffix ? `${label} ${suffix}` : label
    // The mark is text, so it never rests on colour.
    if (t.kind === 'artifact')
      return [{ ...common, suffix, mark: true, more: `${suffix ? ` ${suffix}` : ''}, made by Claude`, tip: `${label}\nMade by Claude in this session`, closeName: `Close ${named}` }]
    const dir = dirOf(relTo(cwd, t.key))
    const why = handleId && restoredTab({ createdMs }, t) ? blockedOf(handleId, t.key) : null
    const blocked = why ? BLOCKED[why] : null
    const more = `${suffix ? ` ${suffix}` : ''}${dir ? `, file in ${dir}` : ', file'}${blocked?.suffix ?? ''}`
    return [{ ...common, suffix, more, tip: blocked ? `${relTo(cwd, t.key)}\n${blocked.line}` : relTo(cwd, t.key), closeName: `Close ${named}` }]
  })
  const ids = views.map((v) => v.id)
  const idsKey = ids.join('\n')

  const count = views.length
  useEffect(() => {
    const el = listRef.current
    const row = rowRef.current
    if (!el || !row) return
    const clip = (): void => {
      el.toggleAttribute('data-clip-start', el.scrollLeft > 0.5)
      el.toggleAttribute('data-clip-end', el.scrollLeft < el.scrollWidth - el.clientWidth - 0.5)
    }
    // The row holds the tablist and the 30px "+".
    const fit = (): void => setDense((was) => denseNext(count, row.clientWidth - 30, was))
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaX !== 0 || e.deltaY === 0) return
      const before = el.scrollLeft
      el.scrollLeft += e.deltaY
      if (el.scrollLeft !== before) e.preventDefault()
    }
    clip()
    fit()
    el.addEventListener('scroll', clip, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: false })
    const ro = new ResizeObserver(clip)
    ro.observe(el)
    const rowRo = new ResizeObserver(fit)
    rowRo.observe(row)
    return () => {
      el.removeEventListener('scroll', clip)
      el.removeEventListener('wheel', onWheel)
      ro.disconnect()
      rowRo.disconnect()
    }
  }, [count])

  useLayoutEffect(() => {
    if (active) tabButton(active)?.scrollIntoView(NEAREST)
  }, [active])

  // Claude closing a tab can take focus with it: from its tab button, or from its page when it was
  // the active one. Focus then goes to the tab now active. A close the user made has already moved it.
  const focused = useRef<string | null>(null)
  const prev = useRef({ ids, active })
  useLayoutEffect(() => {
    const was = prev.current
    prev.current = { ids, active }
    const gone = was.ids.filter((id) => !ids.includes(id))
    if (!gone.length || !active) return
    const el = document.activeElement
    if (el && el !== document.body) return
    const fromTab = document.hasFocus() && focused.current !== null && gone.includes(focused.current)
    const fromPage = !document.hasFocus() && !!was.active && gone.includes(was.active)
    if (fromTab || fromPage) tabButton(active)?.focus()
  }, [idsKey, active])

  const onKeyDown = (e: KeyboardEvent, i: number): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const n = views.length
    const moves: Record<string, number> = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 }
    const to = moves[e.key]
    if (to !== undefined) {
      e.preventDefault()
      tabButton(views[to].id)?.focus()
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      closeTab(views[i].id, true)
    }
  }
  const inList = (): boolean => !!listRef.current?.contains(document.activeElement)

  // With no tabs the picker fills the pane and lists the same entries, and an empty tablist is invalid.
  const any = views.length > 0

  return (
    <div ref={rowRef} className="flex min-w-0 flex-1 items-center">
      {any && (
        <div
          ref={listRef}
          role="tablist"
          aria-label="Pane tabs"
          aria-orientation="horizontal"
          data-ui="surface-tabs"
          data-dense={dense || undefined}
          onBlur={(e) => {
            if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) focused.current = null
          }}
          className="flex min-w-0 items-center gap-1 overflow-x-auto overflow-y-hidden scrollbar-none"
        >
          {views.map((v, i) => {
            const on = v.id === active
            // Activation clears unseen, and a driving tab's dot already says something is happening there.
            const unseenShown = v.unseen && !on && v.state !== 'driving'
            const Glyph = GLYPH[v.kind]
            // Dense: every inactive tab keeps only its icon (and run mark); a hover × would cover the face.
            const icon = dense && !on
            const size = icon ? 'w-auto min-w-0 shrink-0' : dense ? 'w-[160px] shrink-0' : `w-[200px] min-w-[120px] ${on ? 'shrink-0' : 'shrink'}`
            return (
              <div
                key={v.id}
                data-kind={v.kind}
                data-enter={v.fade || undefined}
                // An inline-size container has no intrinsic width, so an auto-width icon tab would measure 0px.
                className={`group/tab ${icon ? '' : '@container'} relative flex h-7 ${size} items-center rounded-md ${
                  v.fade ? 'transition-opacity duration-fast ease-out starting:opacity-0 motion-reduce:transition-none' : ''
                }`}
              >
                <button
                  type="button"
                  role="tab"
                  data-tab={v.id}
                  aria-selected={on}
                  // A named button, not visible text plus an sr-only span: Chrome joins those with a stray space.
                  aria-label={`${v.label}${v.more}`}
                  aria-keyshortcuts="Delete"
                  aria-description={unseenShown ? 'updated' : undefined}
                  tabIndex={on ? 0 : -1}
                  title={unseenShown ? `${v.tip}\n${UNSEEN_LINE}` : v.tip}
                  onClick={() => handleId && activate(handleId, v.id)}
                  onKeyDown={(e) => onKeyDown(e, i)}
                  onFocus={(e) => {
                    focused.current = v.id
                    e.currentTarget.scrollIntoView(NEAREST)
                  }}
                  // A middle press would start autoscroll, and a closing tab shouldn't take focus first.
                  onMouseDown={(e) => {
                    if (e.button === 1) e.preventDefault()
                  }}
                  onAuxClick={(e) => {
                    if (e.button === 1) closeTab(v.id, inList())
                  }}
                  className={`flex h-7 min-w-0 flex-1 items-center rounded-md border text-label focus-visible:-outline-offset-2 active:bg-border-strong ${icon ? 'gap-[3px] px-2' : 'gap-1.5 pl-2.5'} ${
                    on
                      ? 'border-control-edge bg-control pr-7 font-medium text-content'
                      : `border-transparent pointer-fine:group-hover/tab:bg-[var(--glass-row-hover)] pointer-fine:group-hover/tab:text-content ${
                          icon ? (unseenShown ? 'text-content' : 'text-dim') : unseenShown ? 'pr-7 text-content' : 'pr-2.5 text-dim'
                        }`
                  }`}
                >
                  {/* An agent's face and its state are both needed exactly when several run, so neither replaces the other. */}
                  {v.run ? (
                    <span aria-hidden="true" className={`flex shrink-0 items-center ${icon ? 'gap-[3px]' : 'gap-1'}`}>
                      {v.kind === 'agent' ? (
                        <AgentFace face={v.run.face} className="h-4 w-4" />
                      ) : (
                        <span className="flex h-3.5 w-3.5 items-center justify-center">{Glyph && <Glyph className="h-3.5 w-3.5" />}</span>
                      )}
                      <RunMark state={v.run.state} />
                    </span>
                  ) : (
                    // Live state outranks the kind, so it takes the glyph's place rather than adding to the row.
                    <span aria-hidden="true" className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                      {v.state === 'driving' ? (
                        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                      ) : v.state === 'user' ? (
                        <span className="flex gap-0.5">
                          <span className="h-1.5 w-0.5 rounded-[1px] bg-dim" />
                          <span className="h-1.5 w-0.5 rounded-[1px] bg-dim" />
                        </span>
                      ) : fileLike(v.kind) ? (
                        <FileIcon name={v.label} kind="file" className="h-3.5 w-3.5" />
                      ) : (
                        Glyph && <Glyph className="h-3.5 w-3.5" />
                      )}
                    </span>
                  )}
                  {!icon && (
                    <>
                      <span className="min-w-0 truncate">{v.label}</span>
                      {v.suffix && <span className="ml-1 min-w-0 shrink-[2] truncate text-meta text-faint">{v.suffix}</span>}
                      {/* Dropped rather than cut to "b…" in a narrow tab; the name and tooltip still carry it. */}
                      {v.mark && <span className="ml-1 shrink-0 text-meta text-faint @max-[140px]:hidden">{v.suffix ? '· by Claude' : 'by Claude'}</span>}
                    </>
                  )}
                </button>
                {unseenShown &&
                  (icon ? (
                    <span aria-hidden="true" data-ui="surface-tab-unseen" className="pointer-events-none absolute right-[3px] top-[3px] h-1.5 w-1.5 rounded-full bg-content" />
                  ) : (
                    <span aria-hidden="true" data-ui="surface-tab-unseen" className="pointer-events-none absolute right-0.5 top-0.5 flex h-6 w-6 items-center justify-center">
                      <span className="h-1.5 w-1.5 rounded-full bg-content" />
                    </span>
                  ))}
                {/* The keyboard closes with Delete on the tab, so the button stays out of the Tab order. */}
                {!icon && (
                  <button
                    type="button"
                    data-ui="surface-tab-close"
                    aria-label={v.closeName}
                    title="Close tab"
                    tabIndex={-1}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => closeTab(v.id, inList())}
                    className={`absolute right-0.5 top-0.5 flex h-6 w-6 items-center justify-center rounded-sm text-dim pointer-fine:hover:text-content ${
                      on
                        ? 'bg-control pointer-fine:hover:bg-[linear-gradient(var(--glass-row-hover),var(--glass-row-hover))]'
                        : 'pointer-events-none bg-bg bg-[linear-gradient(var(--glass-row-hover),var(--glass-row-hover))] opacity-0 pointer-fine:group-hover/tab:pointer-events-auto pointer-fine:group-hover/tab:opacity-100 group-active/tab:bg-border-strong group-active/tab:bg-none'
                    }`}
                  >
                    <IconClose className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
      {any && (
        <Menu
          label="Open in pane"
          align="start"
          width="min-w-[220px]"
          items={entries.map((it) => ({
            key: it.key,
            label: it.label,
            icon: <it.Glyph className="h-3.5 w-3.5" />,
            onClick: it.run,
            hint: it.meta && (it.mono ? <span className="font-mono">{it.meta}</span> : it.meta),
            hintTitle: it.meta,
            description: it.description,
            keys: it.keys,
            returnFocus: it.key === 'open-file'
          }))}
          trigger={{ 'data-ui': 'pane-add', 'aria-label': 'Open in pane', title: 'Open in pane', className: `${PANE_BTN} ml-0.5 shrink-0` }}
        >
          <IconPlus className="h-4 w-4" />
        </Menu>
      )}
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
    </div>
  )
}
