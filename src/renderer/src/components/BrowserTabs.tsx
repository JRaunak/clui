import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { activeSlice, useActive, useSession, EMPTY_TABS } from '../store'
import { siteKeyOf, type TabState } from '../../../shared/browser'
import { PANE_BTN } from './Stage'
import { IconClose, IconPlus } from './Icon'

const NEAREST: ScrollIntoViewOptions = { block: 'nearest', inline: 'nearest' }
const EMPTY_IDS: number[] = []

const tabButton = (id: number): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-ui="browser-tabs"] [data-tab="${id}"]`)

const focusAddress = (): void => document.querySelector<HTMLElement>('[data-ui="browser-url"]')?.focus()

const tabLabel = (t: Pick<TabState, 'title' | 'url'>): string => t.title || siteKeyOf(t.url) || 'New page'

/**
 * Closes a tab of the active session. The right neighbour takes its place, else the left; `refocus`
 * moves focus to it, which happens before the close so focus never falls to the body. Closing the
 * only tab puts focus on the address, ready for the empty tab main opens in its place.
 */
export function closeTab(id: number, refocus: boolean): void {
  const st = useSession.getState()
  const tabs = activeSlice(st)?.browser?.tabs ?? EMPTY_TABS
  const i = tabs.findIndex((t) => t.id === id)
  if (i < 0) return
  const next = tabs[i + 1] ?? tabs[i - 1]
  if (!next) focusAddress()
  else if (refocus) tabButton(next.id)?.focus()
  st.closeBrowserTab(id)
}

const STATE: Partial<Record<'driving' | 'user' | 'suspended', { suffix: string; line: string }>> = {
  driving: { suffix: ', Claude is driving', line: 'Claude is driving in this tab' },
  user: { suffix: ', you took over, Claude is paused here', line: 'You took over this tab. Claude is paused here.' },
  suspended: {
    suffix: ', paused to save memory',
    line: 'Paused to save memory. Viewing it reloads the page, and anything typed into it is gone.'
  }
}

function stateOf(t: TabState): 'driving' | 'user' | 'suspended' | null {
  if (t.drive === 'driving' || t.drive === 'user') return t.drive
  return t.suspended ? 'suspended' : null
}

/**
 * The browser pane's tabs, in the header row. Arrows only move focus: viewing a suspended tab
 * reloads it, so a tab is viewed on Enter, Space or a click, never by passing over it.
 */
export function BrowserTabs(): JSX.Element {
  const tabs = useActive((s) => s?.browser?.tabs ?? EMPTY_TABS)
  const viewed = useActive((s) => s?.browser?.viewed ?? 0)
  const enter = useActive((s) => s?.browser?.enter ?? EMPTY_IDS)
  const announce = useActive((s) => s?.browser?.announce ?? '')
  const viewTab = useSession((s) => s.viewBrowserTab)
  const newTab = useSession((s) => s.newBrowserTab)
  const listRef = useRef<HTMLDivElement>(null)
  // Tabs already here when the strip mounted don't fade, so reopening the pane stays still.
  const [initial] = useState(() => new Set(tabs.map((t) => t.id)))

  const count = tabs.length
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
    tabButton(viewed)?.scrollIntoView(NEAREST)
  }, [viewed])

  // Claude closing a tab can take focus with it: from its tab button, or from its page when it was
  // the viewed one. Focus then goes to the tab now viewed. A close the user made has already moved it.
  const focused = useRef<number | null>(null)
  const prev = useRef({ ids: tabs.map((t) => t.id), viewed })
  useLayoutEffect(() => {
    const was = prev.current
    const ids = tabs.map((t) => t.id)
    prev.current = { ids, viewed }
    const gone = was.ids.filter((id) => !ids.includes(id))
    if (!gone.length) return
    const active = document.activeElement
    if (active && active !== document.body) return
    const fromTab = document.hasFocus() && focused.current !== null && gone.includes(focused.current)
    const fromPage = !document.hasFocus() && gone.includes(was.viewed)
    if (fromTab || fromPage) tabButton(viewed)?.focus()
  }, [tabs, viewed])

  const onKeyDown = (e: KeyboardEvent, i: number): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const n = tabs.length
    const moves: Record<string, number> = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 }
    const to = moves[e.key]
    if (to !== undefined) {
      e.preventDefault()
      tabButton(tabs[to].id)?.focus()
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      closeTab(tabs[i].id, true)
    }
  }
  const inList = (): boolean => !!listRef.current?.contains(document.activeElement)

  return (
    <div className="flex min-w-0 items-center">
      <div
        ref={listRef}
        role="tablist"
        aria-label="Browser tabs"
        aria-orientation="horizontal"
        data-ui="browser-tabs"
        onBlur={(e) => {
          if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) focused.current = null
        }}
        className="flex min-w-0 items-center gap-1 overflow-x-auto overflow-y-hidden scrollbar-none"
      >
        {tabs.map((t, i) => {
          const on = t.id === viewed
          const state = stateOf(t)
          const info = state ? STATE[state] : undefined
          const label = tabLabel(t)
          const fade = enter.includes(t.id) && !initial.has(t.id)
          const tip = [`Tab ${t.id} · ${label}`, t.url === 'about:blank' ? '' : t.url, info?.line ?? ''].filter(Boolean).join('\n')
          return (
            <div
              key={t.id}
              data-enter={fade || undefined}
              className={`group/tab relative flex h-7 w-[200px] min-w-[96px] shrink items-center rounded-md ${
                fade ? 'transition-opacity duration-fast ease-out starting:opacity-0 motion-reduce:transition-none' : ''
              }`}
            >
              <button
                type="button"
                role="tab"
                data-tab={t.id}
                aria-selected={on}
                aria-keyshortcuts="Delete"
                tabIndex={on ? 0 : -1}
                title={tip}
                onClick={() => viewTab(t.id)}
                onKeyDown={(e) => onKeyDown(e, i)}
                onFocus={(e) => {
                  focused.current = t.id
                  e.currentTarget.scrollIntoView(NEAREST)
                }}
                // A middle press would start autoscroll, and a closing tab shouldn't take focus first.
                onMouseDown={(e) => {
                  if (e.button === 1) e.preventDefault()
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) closeTab(t.id, inList())
                }}
                className={`flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border pl-2.5 text-label focus-visible:-outline-offset-2 active:bg-border-strong ${
                  on
                    ? 'border-control-edge bg-control pr-7 font-medium text-content'
                    : 'border-transparent pr-2.5 text-dim pointer-fine:group-hover/tab:bg-[var(--glass-row-hover)] pointer-fine:group-hover/tab:text-content'
                }`}
              >
                {state === 'driving' ? (
                  <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                ) : state === 'user' ? (
                  <span aria-hidden="true" className="flex shrink-0 gap-0.5">
                    <span className="h-1.5 w-0.5 rounded-[1px] bg-dim" />
                    <span className="h-1.5 w-0.5 rounded-[1px] bg-dim" />
                  </span>
                ) : null}
                <span className="min-w-0 truncate">{label}</span>
                <span className="sr-only">
                  , tab {t.id}
                  {info?.suffix}
                </span>
              </button>
              {/* The keyboard closes with Delete on the tab, so the button stays out of the Tab order.
                  On an unviewed tab it paints the tab's hover fill over the title's tail. */}
              <button
                type="button"
                data-ui="browser-tab-close"
                aria-label={`Close tab ${t.id}`}
                title="Close tab"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => closeTab(t.id, inList())}
                className={`absolute right-0.5 top-0.5 flex h-6 w-6 items-center justify-center rounded-sm text-dim pointer-fine:hover:text-content ${
                  on
                    ? 'pointer-fine:hover:bg-[var(--glass-row-hover)]'
                    : 'pointer-events-none bg-bg bg-[linear-gradient(var(--glass-row-hover),var(--glass-row-hover))] opacity-0 pointer-fine:group-hover/tab:pointer-events-auto pointer-fine:group-hover/tab:opacity-100 group-active/tab:bg-border-strong group-active/tab:bg-none'
                }`}
              >
                <IconClose className="h-3.5 w-3.5" />
              </button>
            </div>
          )
        })}
      </div>
      <button
        type="button"
        data-ui="browser-tab-new"
        aria-label="New tab"
        title="New tab"
        onClick={() => {
          focusAddress()
          void newTab()
        }}
        className={`${PANE_BTN} ml-0.5 shrink-0`}
      >
        <IconPlus className="h-4 w-4" />
      </button>
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
    </div>
  )
}
