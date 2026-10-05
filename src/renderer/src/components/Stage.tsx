import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject
} from 'react'
import { useActive, useSession, EMPTY_PENDING, selectBrowserOpen } from '../store'
import { Chat } from './Chat'
import { Composer } from './Composer'
import { ChangedFiles } from './ChangedFiles'
import { SubagentView } from './SubagentView'
import { BrowserPane } from './BrowserPane'
import { TopBand } from './TopBand'
import { StatusBar } from './StatusBar'
import { Notice } from './Notice'
import { IconClose, IconMaximize, IconRestore, IconShield } from './Icon'
import { SPLIT_MIN, getStage } from '../lib/stage'
import { diveOut, focusPaneTitle, resizePane } from '../lib/dive'
import { viaOf } from '../lib/motion'

export type PaneState = 'collapsed' | 'half' | 'full'

interface PaneApi {
  state: PaneState
  /** Half only exists when the Stage is at least SPLIT_MIN wide. */
  canToggleSize: boolean
  toggleSize: () => void
  close: () => void
  /** A Gate is waiting in the dock, and the dock is unmounted behind a full pane. */
  needsYou: boolean
  resolveNeedsYou: () => void
  /** Esc belongs to the pane when it has the whole Stage, or holds focus beside the transcript. */
  escapeActive: boolean
}

const PaneContext = createContext<PaneApi | null>(null)

export function usePane(): PaneApi {
  const pane = useContext(PaneContext)
  if (!pane) throw new Error('usePane() used outside <Stage>')
  return pane
}

/** Only whether the element is at least `min` wide, so a sidebar drag re-renders the Stage once at
 *  the crossing, not every frame. */
function useAtLeast(ref: RefObject<HTMLElement>, min: number): boolean {
  const [ok, setOk] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setOk(el.clientWidth >= min)
    let raf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setOk(el.clientWidth >= min))
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [ref, min])
  return ok
}

/** Mirrors an element's height into state, rAF-coalesced to dodge the ResizeObserver-loop warning. */
function useObservedHeight(ref: RefObject<HTMLElement>, set: (h: number) => void): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let raf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => set(el.offsetHeight))
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [ref, set])
}

export function Stage({
  leftInset,
  bleed,
  bordered,
  empty
}: {
  leftInset: number
  bleed: number
  /** Hairline against the expanded sidebar. The collapsed rail shares the Stage's surface. */
  bordered: boolean
  /** What fills the Stage with no session open: onboarding or the welcome block. */
  empty: ReactNode
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const cwd = useActive((s) => s?.cwd ?? null)
  const viewingSubagent = useSession((s) => s.viewingSubagent)
  const closeSubagentView = useSession((s) => s.closeSubagentView)
  const paneFull = useSession((s) => s.paneFull)
  const setPaneFull = useSession((s) => s.setPaneFull)
  const primaryScrolled = useSession((s) => s.primaryScrolled)
  const secondaryScrolled = useSession((s) => s.secondaryScrolled)
  const gatePending = useActive((s) => (s?.pendingPermissions ?? EMPTY_PENDING).length > 0)
  const wide = useAtLeast(ref, SPLIT_MIN)
  const [focusInSecondary, setFocusInSecondary] = useState(false)

  const browserOpen = useActive(selectBrowserOpen)
  const browserPaneFull = useSession((s) => s.browserPaneFull)
  const kind: 'subagent' | 'browser' | null = cwd && viewingSubagent ? 'subagent' : cwd && browserOpen ? 'browser' : null
  const full = kind === 'browser' ? browserPaneFull : paneFull
  const state: PaneState = !kind ? 'collapsed' : wide && !full ? 'half' : 'full'
  useEffect(() => {
    if (!kind) setFocusInSecondary(false)
  }, [kind])
  const hasBrowser = useActive((s) => !!s?.browser)
  // The native menu can't read the renderer, so its pane and browser items follow what this Stage shows.
  useEffect(() => {
    window.clui.menuState({
      browser: !hasBrowser ? 'none' : browserOpen ? 'shown' : 'hidden',
      pane: !kind || !wide ? 'none' : state === 'full' ? 'full' : 'split'
    })
  }, [hasBrowser, browserOpen, kind, wide, state])

  const pane = useMemo<PaneApi>(
    () => ({
      state,
      canToggleSize: wide,
      toggleSize: () => {
        const goingFull = !full
        const fromTranscript = !!document.activeElement?.closest('[data-ui="pane-primary"]')
        if (kind === 'browser') useSession.getState().setBrowserPane(goingFull ? 'full' : 'half')
        else setPaneFull(goingFull)
        // Going full unmounts the transcript, so focus that was in it moves to the pane's title.
        if (goingFull && fromTranscript) requestAnimationFrame(focusPaneTitle)
      },
      close: closeSubagentView,
      needsYou: state === 'full' && gatePending,
      resolveNeedsYou: () => {
        if (kind === 'browser') useSession.getState().setBrowserPane(wide ? 'half' : 'collapsed')
        else if (wide) setPaneFull(false)
        else closeSubagentView()
        requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-ui="gate-title"]')?.focus())
      },
      escapeActive: state === 'full' || focusInSecondary
    }),
    [state, wide, full, kind, gatePending, focusInSecondary, closeSubagentView, setPaneFull]
  )

  return (
    <div
      ref={ref}
      data-ui="stage"
      className={`relative isolate flex min-h-0 min-w-0 flex-1 flex-col [container-type:inline-size] [--bar-h:44px] [--top-h:44px] ${
        bordered ? 'border-l border-border' : ''
      }`}
    >
      <TopBand
        leftInset={leftInset}
        bleed={bleed}
        session={!!cwd}
        split={state === 'half'}
        scrolled={(state !== 'full' && primaryScrolled) || (!!kind && secondaryScrolled)}
      />
      {!cwd ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div aria-hidden="true" className="h-11 shrink-0" />
          <Notice />
          {empty}
        </div>
      ) : (
        <PaneContext.Provider value={pane}>
          <div className="relative flex min-h-0 flex-1">
            {state !== 'full' && <PrimaryPane split={state === 'half'} />}
            {kind && (
              <SecondaryPane
                key={kind}
                id={kind === 'browser' ? 'browser-pane-region' : undefined}
                label={kind === 'browser' ? 'Browser' : 'Detail pane'}
                split={state === 'half'}
                onFocusWithin={setFocusInSecondary}
              >
                {kind === 'browser' ? <BrowserPane /> : <SubagentView />}
              </SecondaryPane>
            )}
          </div>
          <StatusBar />
        </PaneContext.Provider>
      )}
    </div>
  )
}

/** The transcript and the floating dock. The dock sits over the transcript's bottom, so the
 *  transcript reads the dock's height from --dock-h to keep its tail clear. */
function PrimaryPane({ split }: { split: boolean }): JSX.Element {
  const [dockH, setDockH] = useState(0)
  const [sbW, setSbW] = useState(0)
  const [noticeH, setNoticeH] = useState(0)
  const activeHandleId = useSession((s) => s.activeHandleId)
  const paneRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const noticeRef = useRef<HTMLDivElement>(null)
  useObservedHeight(dockRef, setDockH)
  useObservedHeight(noticeRef, setNoticeH)

  // The top band bounds its slot to this pane's width in half.
  useLayoutEffect(() => {
    const el = paneRef.current
    const stage = getStage()
    if (!el || !stage) return
    let raf = 0
    const publish = (): void => stage.style.setProperty('--primary-w', `${el.offsetWidth}px`)
    publish()
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(publish)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
      stage.style.removeProperty('--primary-w')
    }
  }, [])

  // The dock and the top band's header overlay both clear the transcript's scrollbar gutter.
  useLayoutEffect(() => {
    const stage = getStage()
    if (!stage) return
    stage.style.setProperty('--sb-w', `${sbW}px`)
    return () => {
      stage.style.removeProperty('--sb-w')
    }
  }, [sbW])

  // The status bar's tray popovers open above the whole dock: its height plus the 8px (mb-2) gap
  // between the dock and the bar.
  useLayoutEffect(() => {
    const stage = getStage()
    if (!stage) return
    stage.style.setProperty('--dock-lift', `${dockH + 8}px`)
    return () => {
      stage.style.removeProperty('--dock-lift')
    }
  }, [dockH])

  return (
    <div
      ref={paneRef}
      data-ui="pane-primary"
      className={`relative mb-2 flex min-h-0 flex-1 flex-col ${split ? 'min-w-[520px]' : 'min-w-0'}`}
      style={{ '--dock-h': `${dockH}px`, '--notice-h': `${noticeH}px` } as CSSProperties}
    >
      <div ref={noticeRef} className="absolute inset-x-0 z-30" style={{ top: 'var(--bar-h, 44px)' }}>
        <Notice />
      </div>
      <Chat onScrollbarWidth={setSbW} />
      {/* The transcript reserves a stable scrollbar gutter; the dock pads its right by the same
          width so the composer column lines up with the message column. The wrapper ignores
          pointer events so the scrollbar under that padding stays grabbable. */}
      <div
        ref={dockRef}
        className="group/dock pointer-events-none absolute inset-x-0 bottom-0 [&>*]:pointer-events-auto"
        style={{ paddingRight: 'var(--sb-w, 0px)' }}
      >
        <ChangedFiles key={activeHandleId ?? 'none'} />
        <Composer />
      </div>
    </div>
  )
}

/** The right sidebar. Its scrollers clear the band and its own header (--top-h 80px), and it hands
 *  focus to its title on open and back to the opener on close. */
function SecondaryPane({
  id,
  label,
  split,
  onFocusWithin,
  children
}: {
  id?: string
  label: string
  split: boolean
  onFocusWithin: (inside: boolean) => void
  children: ReactNode
}): JSX.Element {
  const ref = useRef<HTMLElement>(null)
  const setSecondaryScrolled = useSession((s) => s.setSecondaryScrolled)
  // A view can hold more than one scroller, so the header shows its glass while any of them is off the
  // top. A scroller that starts below the header (data-beside-header) never puts content under it.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const off = new Set<Element>()
    const onScroll = (e: Event): void => {
      const t = e.target as Element
      if (t instanceof HTMLElement && 'besideHeader' in t.dataset) return
      if (t.scrollTop > 0) off.add(t)
      else off.delete(t)
      setSecondaryScrolled([...off].some((n) => n.isConnected))
    }
    el.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll, { capture: true })
      setSecondaryScrolled(false)
    }
  }, [setSecondaryScrolled])
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    document.querySelector<HTMLElement>('[data-ui="pane-secondary"] [data-pane-title]')?.focus()
    return () => {
      if (opener && document.contains(opener)) opener.focus()
      else document.querySelector<HTMLElement>('[data-composer-input]')?.focus()
    }
  }, [])
  return (
    <section
      ref={ref}
      id={id}
      data-ui="pane-secondary"
      aria-label={label}
      className={`relative flex min-h-0 flex-1 flex-col bg-bg [--dock-h:0px] [--top-h:80px] ${
        split ? 'min-w-[440px] border-l border-border' : 'min-w-0'
      }`}
      onFocus={() => onFocusWithin(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onFocusWithin(false)
      }}
    >
      {children}
    </section>
  )
}

export const PANE_BTN =
  'toggle-press flex h-7 w-7 items-center justify-center rounded-md text-dim transition-colors focus-visible:-outline-offset-2 pointer-fine:hover:bg-[var(--glass-row-hover)] pointer-fine:hover:text-content'

/**
 * The right sidebar's 36px header under the top band, glass only while content is under it. The view
 * inside supplies the title (the element carrying data-ui="pane-title", or the browser's tabs) and its
 * status; the header supplies the pane actions.
 */
export function PaneHeader({
  kind,
  status,
  actions,
  children
}: {
  /** Without a kind the row starts at 8px, so the browser's first tab lines up with the toolbar's Back button. */
  kind?: string
  status?: ReactNode
  /** The view's own buttons, before the size toggle. They also replace Close: a view with actions is
   *  the browser, which hides rather than closes so it keeps its page. */
  actions?: ReactNode
  children: ReactNode
}): JSX.Element {
  const pane = usePane()
  const full = pane.state === 'full'
  const scrolled = useSession((s) => s.secondaryScrolled)
  return (
    <div
      data-ui="pane-header"
      data-scrolled={scrolled || undefined}
      className={`group/pane absolute inset-x-0 top-11 z-30 flex h-9 items-center gap-2 pr-2 text-label ${kind ? 'pl-4' : 'pl-2'}`}
    >
      <div
        aria-hidden="true"
        data-ui="pane-header-glass"
        className="glass-bar pointer-events-none absolute inset-0 -z-10 opacity-0 transition-opacity duration-fast ease-in group-data-[scrolled]/pane:opacity-100 group-data-[scrolled]/pane:ease-out contrast-more:opacity-100 motion-reduce:transition-none"
      />
      <div data-ui="pane-head-title" className="flex min-w-0 flex-1 items-center gap-2">
        {children}
        {kind && <span className="shrink-0 text-meta text-dim">{kind}</span>}
        {status && (
          <>
            <span aria-hidden="true" className="shrink-0 text-meta text-dim">·</span>
            {status}
          </>
        )}
      </div>
      {pane.needsYou && (
        <button
          type="button"
          data-ui="pane-needs-you"
          onClick={pane.resolveNeedsYou}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-control px-2.5 text-meta font-medium text-content transition-colors hover:bg-control-hover"
        >
          <IconShield className="h-3.5 w-3.5 text-warn" />
          Needs you
        </button>
      )}
      <div data-ui="pane-head-controls" className="flex shrink-0 items-center gap-0.5">
        {actions}
        {pane.canToggleSize && (
          <button
            type="button"
            data-ui="pane-expand"
            onClick={(e) => resizePane(!full, viaOf(e))}
            aria-pressed={full}
            aria-label={full ? 'Return to split' : 'Expand to full'}
            title={full ? 'Split ⌥⌘B' : 'Expand ⌥⌘B'}
            className={PANE_BTN}
          >
            {full ? <IconRestore className="h-4 w-4" /> : <IconMaximize className="h-4 w-4" />}
          </button>
        )}
        {!actions && (
          <button
            type="button"
            data-ui="pane-close"
            onClick={(e) => diveOut(viaOf(e))}
            aria-label="Close pane"
            title="Close (Esc)"
            className={PANE_BTN}
          >
            <IconClose className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  )
}
