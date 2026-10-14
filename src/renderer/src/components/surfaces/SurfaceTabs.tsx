import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { activeSlice, browserTabOf, surfaceLabel, useActive, useSession, EMPTY_STRINGS, EMPTY_SURFACES, EMPTY_TABS } from '../../store'
import { siteKeyOf, type TabState } from '../../../../shared/browser'
import type { SurfaceKind } from '../../../../shared/surfaces'
import { PANE_BTN } from './PaneHeader'
import { tilde } from '../../lib/tree'
import { FileIcon } from '../FileIcon'
import { IconAgentBrowser, IconClose, IconDiff, IconFolder, IconPlus } from '../Icon'

const NEAREST: ScrollIntoViewOptions = { block: 'nearest', inline: 'nearest' }
const EMPTY_IDS: number[] = []
const UNSEEN_LINE = 'Updated since you last looked'

const tabButton = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-ui="surface-tabs"] [data-tab="${CSS.escape(id)}"]`)

const focusAddress = (): void => document.querySelector<HTMLElement>('[data-ui="browser-url"]')?.focus()

const tabLabel = (t: Pick<TabState, 'title' | 'url'>): string => t.title || siteKeyOf(t.url) || 'New page'

/**
 * Closes a tab of the active session. The right neighbour takes its place, else the left; `refocus`
 * moves focus to it, which happens before the close so focus never falls to the body. Closing the
 * last tab hides the pane, whose unmount hands focus back.
 */
export function closeTab(id: string, refocus: boolean): void {
  const st = useSession.getState()
  const slice = activeSlice(st)
  const order = slice?.surfaces.order ?? EMPTY_STRINGS
  const i = order.indexOf(id)
  if (!slice || i < 0) return
  const next = order[i + 1] ?? order[i - 1]
  if (next && refocus) tabButton(next)?.focus()
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
  kind: SurfaceKind
  label: string
  /** Distinguishes file tabs that share a basename. */
  suffix: string
  /** The rest of the accessible name, after the label. */
  more: string
  tip: string
  closeName: string
  state: 'driving' | 'user' | 'suspended' | null
  unseen: boolean
  fade: boolean
}

const GLYPH: Partial<Record<SurfaceKind, (p: { className?: string }) => JSX.Element>> = {
  browser: IconAgentBrowser,
  diff: IconDiff,
  tree: IconFolder
}

const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1) || p
const dirOf = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf('/')))
const relTo = (cwd: string | null, p: string): string => (cwd && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p)

/** The fewest trailing directory names that tell apart file tabs sharing a basename. */
function suffixes(paths: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const groups = Map.groupBy(paths, base)
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const dirs = group.map((p) => dirOf(p).split('/').filter(Boolean))
    for (const [i, p] of group.entries()) {
      const mine = dirs[i]
      let k = 1
      const tail = (d: string[], n: number): string => d.slice(-n).join('/')
      while (k < mine.length && dirs.some((d, j) => j !== i && tail(d, k) === tail(mine, k))) k++
      out.set(p, tail(mine, k))
    }
  }
  return out
}

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
  const hasBrowser = useActive((s) => !!s?.browser)
  const enter = useActive((s) => s?.browser?.enter ?? EMPTY_IDS)
  const announce = useActive((s) => s?.browser?.announce ?? '')
  const cwd = useActive((s) => s?.cwd ?? null)
  const activate = useSession((s) => s.activateSurface)
  const newTab = useSession((s) => s.newBrowserTab)
  const listRef = useRef<HTMLDivElement>(null)
  // Tabs already here when the strip mounted don't fade, so reopening the pane stays still.
  const [initial] = useState(() => new Set(order))

  const files = order.flatMap((id) => (surfaceTabs[id]?.kind === 'file' ? [surfaceTabs[id].key] : []))
  const dup = suffixes(files)
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
      return [{ id, kind: 'browser', label, suffix: '', more: `, tab ${t.id}${info?.suffix ?? ''}`, tip: tip.filter(Boolean).join('\n'), closeName: `Close tab ${t.id}`, state, unseen, fade: enter.includes(t.id) && !initial.has(id) }]
    }
    const t = surfaceTabs[id]
    if (!t) return []
    const label = surfaceLabel(t)
    const common = { id, kind: t.kind, label, suffix: '', more: '', tip: label, closeName: `Close ${label}`, state: null, unseen: !!t.unseen, fade: t.openedBy === 'claude' && !initial.has(id) }
    if (t.kind === 'diff') return [{ ...common, tip: 'What Claude changed in this session' }]
    if (t.kind === 'tree') return [{ ...common, more: ', file tree', tip: cwd ? tilde(cwd, window.clui.homeDir) : label }]
    if (t.kind !== 'file') return [common]
    const suffix = dup.get(t.key) ?? ''
    const named = suffix ? `${label} ${suffix}` : label
    const dir = dirOf(relTo(cwd, t.key))
    return [{ ...common, suffix, more: `${suffix ? ` ${suffix}` : ''}${dir ? `, file in ${dir}` : ', file'}`, tip: relTo(cwd, t.key), closeName: `Close ${named}` }]
  })
  const ids = views.map((v) => v.id)
  const idsKey = ids.join('\n')

  const count = views.length
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const clip = (): void => {
      el.toggleAttribute('data-clip-start', el.scrollLeft > 0.5)
      el.toggleAttribute('data-clip-end', el.scrollLeft < el.scrollWidth - el.clientWidth - 0.5)
    }
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaX !== 0 || e.deltaY === 0) return
      const before = el.scrollLeft
      el.scrollLeft += e.deltaY
      if (el.scrollLeft !== before) e.preventDefault()
    }
    clip()
    el.addEventListener('scroll', clip, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: false })
    const ro = new ResizeObserver(clip)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', clip)
      el.removeEventListener('wheel', onWheel)
      ro.disconnect()
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

  return (
    <div className="flex min-w-0 items-center">
      <div
        ref={listRef}
        role="tablist"
        aria-label="Pane tabs"
        aria-orientation="horizontal"
        data-ui="surface-tabs"
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
          return (
            <div
              key={v.id}
              data-kind={v.kind}
              data-enter={v.fade || undefined}
              className={`group/tab relative flex h-7 w-[200px] min-w-[96px] shrink items-center rounded-md ${
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
                className={`flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border pl-2.5 text-label focus-visible:-outline-offset-2 active:bg-border-strong ${
                  on
                    ? 'border-control-edge bg-control pr-2.5 font-medium text-content'
                    : `border-transparent pointer-fine:group-hover/tab:bg-[var(--glass-row-hover)] pointer-fine:group-hover/tab:text-content ${
                        unseenShown ? 'pr-7 text-content' : 'pr-2.5 text-dim'
                      }`
                }`}
              >
                {/* Live state outranks the kind, so it takes the glyph's place rather than adding to the row. */}
                <span aria-hidden="true" className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  {v.state === 'driving' ? (
                    <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                  ) : v.state === 'user' ? (
                    <span className="flex gap-0.5">
                      <span className="h-1.5 w-0.5 rounded-[1px] bg-dim" />
                      <span className="h-1.5 w-0.5 rounded-[1px] bg-dim" />
                    </span>
                  ) : v.kind === 'file' ? (
                    <FileIcon name={v.label} kind="file" className="h-3.5 w-3.5" />
                  ) : (
                    Glyph && <Glyph className="h-3.5 w-3.5" />
                  )}
                </span>
                <span className="min-w-0 truncate">{v.label}</span>
                {v.suffix && <span className="ml-1 min-w-0 shrink-[2] truncate text-meta text-faint">{v.suffix}</span>}
              </button>
              {unseenShown && (
                <span aria-hidden="true" data-ui="surface-tab-unseen" className="pointer-events-none absolute right-0.5 top-0.5 flex h-6 w-6 items-center justify-center">
                  <span className="h-1.5 w-1.5 rounded-full bg-content" />
                </span>
              )}
              {/* The keyboard closes with Delete on the tab, so the button stays out of the Tab order. It paints the
                  tab's own fill over the title's tail, so the active tab's title gets the same room as the rest. */}
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
            </div>
          )
        })}
      </div>
      {hasBrowser && (
        <button
          type="button"
          data-ui="browser-tab-new"
          aria-label="New browser tab"
          title="New browser tab"
          onClick={async () => {
            focusAddress()
            await newTab()
            // From another kind, the address only exists once the new tab's surface has mounted.
            requestAnimationFrame(focusAddress)
          }}
          className={`${PANE_BTN} ml-0.5 shrink-0`}
        >
          <IconPlus className="h-4 w-4" />
        </button>
      )}
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
    </div>
  )
}
