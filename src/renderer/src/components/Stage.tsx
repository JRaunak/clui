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
import { useActive, useSession, EMPTY_PENDING } from '../store'
import { Chat } from './Chat'
import { Composer } from './Composer'
import { ChangedFiles } from './ChangedFiles'
import { SubagentView } from './SubagentView'
import { TopBand } from './TopBand'
import { StatusBar } from './StatusBar'
import { Notice } from './Notice'
import { IconClose, IconMaximize, IconRestore, IconShield } from './Icon'
import { SPLIT_MIN, getStage } from '../lib/stage'

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
  bordered,
  empty
}: {
  leftInset: number
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

  const kind: 'subagent' | null = cwd && viewingSubagent ? 'subagent' : null
  const state: PaneState = !kind ? 'collapsed' : wide && !paneFull ? 'half' : 'full'
  useEffect(() => {
    if (!kind) setFocusInSecondary(false)
  }, [kind])

  const pane = useMemo<PaneApi>(
    () => ({
      state,
      canToggleSize: wide,
      toggleSize: () => {
        const goingFull = !paneFull
        const fromTranscript = !!document.activeElement?.closest('[data-ui="pane-primary"]')
        setPaneFull(goingFull)
        // Going full unmounts the transcript, so focus that was in it moves to the pane's title.
        if (goingFull && fromTranscript)
          requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-ui="pane-title"]')?.focus())
      },
      close: closeSubagentView,
      needsYou: state === 'full' && gatePending,
      resolveNeedsYou: () => {
        if (wide) setPaneFull(false)
        else closeSubagentView()
        requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-ui="gate"]')?.focus())
      },
      escapeActive: state === 'full' || focusInSecondary
    }),
    [state, wide, paneFull, gatePending, focusInSecondary, closeSubagentView, setPaneFull]
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
              <SecondaryPane key={kind} split={state === 'half'} onFocusWithin={setFocusInSecondary}>
                <SubagentView />
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
      style={{ '--dock-h': `${dockH}px`, '--sb-w': `${sbW}px`, '--notice-h': `${noticeH}px` } as CSSProperties}
    >
      <div ref={noticeRef} className="absolute inset-x-0 z-30" style={{ top: 'var(--bar-h, 44px)' }}>
        <Notice />
      </div>
      <Chat onScrollbarWidth={setSbW} />
      {/* The transcript reserves a stable scrollbar gutter; the dock pads its right by the same
          width so the composer column lines up with the message column. */}
      <div ref={dockRef} className="absolute inset-x-0 bottom-0" style={{ paddingRight: 'var(--sb-w, 0px)' }}>
        <ChangedFiles />
        <Composer />
      </div>
    </div>
  )
}

/** The right sidebar. Its scrollers clear the band and its own header (--top-h 80px), and it hands
 *  focus to its title on open and back to the opener on close. */
function SecondaryPane({
  split,
  onFocusWithin,
  children
}: {
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
    document.querySelector<HTMLElement>('[data-ui="pane-secondary"] [data-ui="pane-title"]')?.focus()
    return () => {
      if (opener && document.contains(opener)) opener.focus()
      else document.querySelector<HTMLElement>('[data-composer-input]')?.focus()
    }
  }, [])
  return (
    <section
      ref={ref}
      data-ui="pane-secondary"
      aria-label="Detail pane"
      className={`relative flex min-h-0 flex-1 flex-col [--dock-h:0px] [--top-h:80px] ${
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

const PANE_BTN =
  'toggle-press flex h-7 w-7 items-center justify-center rounded-md text-dim transition-colors focus-visible:-outline-offset-2 pointer-fine:hover:bg-[var(--glass-row-hover)] pointer-fine:hover:text-content'

/**
 * The right sidebar's 36px header under the top band, glass only while content is under it. The view
 * inside supplies the title (the element carrying data-ui="pane-title") and its status; the header
 * supplies the pane actions.
 */
export function PaneHeader({
  kind,
  status,
  children
}: {
  kind: string
  status?: ReactNode
  children: ReactNode
}): JSX.Element {
  const pane = usePane()
  const full = pane.state === 'full'
  const scrolled = useSession((s) => s.secondaryScrolled)
  return (
    <div
      data-ui="pane-header"
      data-scrolled={scrolled || undefined}
      className="group/pane absolute inset-x-0 top-11 z-30 flex h-9 items-center gap-2 pl-4 pr-2 text-label"
    >
      <div
        aria-hidden="true"
        data-ui="pane-header-glass"
        className="glass-bar pointer-events-none absolute inset-0 -z-10 opacity-0 transition-opacity duration-fast ease-in group-data-[scrolled]/pane:opacity-100 group-data-[scrolled]/pane:ease-out contrast-more:opacity-100 motion-reduce:transition-none"
      />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {children}
        <span className="shrink-0 text-meta text-dim">{kind}</span>
      </div>
      {status}
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
      <div className="flex shrink-0 items-center gap-0.5">
        {pane.canToggleSize && (
          <button
            type="button"
            data-ui="pane-expand"
            onClick={pane.toggleSize}
            aria-pressed={full}
            aria-label={full ? 'Return to split' : 'Expand to full'}
            title={full ? 'Split ⌥⌘B' : 'Expand ⌥⌘B'}
            className={PANE_BTN}
          >
            {full ? <IconRestore className="h-4 w-4" /> : <IconMaximize className="h-4 w-4" />}
          </button>
        )}
        <button
          type="button"
          data-ui="pane-close"
          onClick={pane.close}
          aria-label="Close pane"
          title="Close (Esc)"
          className={PANE_BTN}
        >
          <IconClose className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
