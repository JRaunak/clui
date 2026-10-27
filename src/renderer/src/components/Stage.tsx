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
import { browserTabOf, surfaceKindOf, useActive, useSession, viewedTabOf, EMPTY_PENDING, selectPaneOpen } from '../store'
import { Chat } from './Chat'
import { Composer } from './Composer'
import { ChangedFiles } from './ChangedFiles'
import { SubagentView } from './SubagentView'
import { SurfacePane } from './surfaces/SurfacePane'
import { SurfaceHost } from './surfaces/SurfaceHost'
import { browserExternalBlock } from './surfaces/BrowserSurface'
import { selectedChange } from './surfaces/DiffSurface'
import { useFileStatus } from './surfaces/FileSurface'
import { TopBand } from './TopBand'
import { StatusBar } from './StatusBar'
import { Notice } from './Notice'
import { SPLIT_MIN, getStage } from '../lib/stage'
import { focusPaneTitle } from '../lib/dive'

export type PaneState = 'collapsed' | 'half' | 'full'

interface PaneApi {
  kind: 'subagent' | 'surfaces' | null
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
  const setStageWide = useSession((s) => s.setStageWide)
  useEffect(() => setStageWide(wide), [wide, setStageWide])
  const [focusInSecondary, setFocusInSecondary] = useState(false)

  const paneOpen = useActive(selectPaneOpen)
  const surfacePaneFull = useActive((s) => !!s?.surfacePaneFull)
  const kind: 'subagent' | 'surfaces' | null = cwd && viewingSubagent ? 'subagent' : cwd && paneOpen ? 'surfaces' : null
  const full = kind === 'surfaces' ? surfacePaneFull : paneFull
  const state: PaneState = !kind ? 'collapsed' : wide && !full ? 'half' : 'full'
  useEffect(() => {
    if (!kind) setFocusInSecondary(false)
  }, [kind])
  const hasBrowser = useActive((s) => !!s?.browser)
  const browserActive = useActive((s) => browserTabOf(s?.surfaces.active) !== null)
  const activeKind = useActive((s) => (s ? surfaceKindOf(s.surfaces, s.surfaces.active) : null))
  const onBrowser = kind === 'surfaces' && browserActive
  const onDiff = useActive((s) => kind === 'surfaces' && s?.surfaces.active === 'diff')
  const onTree = useActive((s) => kind === 'surfaces' && s?.surfaces.active === 'tree')
  const diffOpenable = useActive((s) => !!selectedChange(s)?.snapshot)
  const handleId = useSession((s) => s.activeHandleId)
  const filePath = useActive((s) => (kind === 'surfaces' && s?.surfaces.active && s.surfaces.tabs[s.surfaces.active]?.kind === 'file' ? s.surfaces.tabs[s.surfaces.active].key : null))
  const fileStatus = useFileStatus(handleId, filePath)
  const externalBlocked = useActive((s) => !!browserExternalBlock(viewedTabOf(s?.browser)?.url ?? ''))
  // The native menu can't read the renderer, so its pane, browser and Open externally items follow what this Stage shows.
  useEffect(() => {
    window.clui.menuState({
      browser: !hasBrowser ? 'none' : onBrowser ? 'shown' : 'hidden',
      pane: !kind || !wide ? 'none' : state === 'full' ? 'full' : 'split',
      surface: kind === 'surfaces' ? (activeKind ?? 'picker') : 'none',
      canPane: !!cwd,
      close: kind !== 'surfaces' || !focusInSecondary ? 'session' : activeKind ? 'tab' : 'none',
      external: onBrowser
        ? { kind: 'browser', enabled: !externalBlocked }
        : onDiff
          ? { kind: 'diff', enabled: diffOpenable }
          : filePath
            ? { kind: 'file', enabled: fileStatus !== 'missing' }
            : onTree
              ? { kind: 'tree', enabled: true }
              : { kind: 'none', enabled: false },
      fileLines: fileStatus === 'text'
    })
  }, [hasBrowser, onBrowser, onDiff, onTree, diffOpenable, filePath, fileStatus, kind, wide, state, externalBlocked, cwd, activeKind, focusInSecondary])

  const pane = useMemo<PaneApi>(
    () => ({
      kind,
      state,
      canToggleSize: wide,
      toggleSize: () => {
        const goingFull = !full
        const fromTranscript = !!document.activeElement?.closest('[data-ui="pane-primary"]')
        if (kind === 'surfaces') useSession.getState().setPane(goingFull ? 'full' : 'half')
        else setPaneFull(goingFull)
        // Going full unmounts the transcript, so focus that was in it moves to the pane's title.
        if (goingFull && fromTranscript) requestAnimationFrame(focusPaneTitle)
      },
      close: closeSubagentView,
      needsYou: state === 'full' && gatePending,
      resolveNeedsYou: () => {
        if (kind === 'surfaces') useSession.getState().setPane(wide ? 'half' : 'collapsed')
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
              <SurfacePane
                key={kind}
                id={kind === 'surfaces' ? 'surface-pane-region' : undefined}
                label={kind === 'surfaces' ? 'Pane' : 'Detail pane'}
                split={state === 'half'}
                onFocusWithin={setFocusInSecondary}
              >
                {kind === 'surfaces' ? <SurfaceHost /> : <SubagentView />}
              </SurfacePane>
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
