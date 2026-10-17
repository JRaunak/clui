import { useEffect, useRef, useState } from 'react'
import { activeSlice, anyTabIn, paneTarget, selectPaneOpen, surfaceKindOf, useActive, useSession } from '../store'
import { CurrentTurnHeader } from './CurrentTurnHeader'
import { FindBar } from './FindBar'
import { IconAgentBrowser, IconDiff, IconFile, IconFolder, IconPaneRight } from './Icon'
import { viaOf } from '../lib/motion'
import { setPaneVia } from '../lib/dive'

/**
 * The top band over the Stage's top 44px, which the transcript scrolls beneath. Its glass layer shows
 * only while content is under it. It comes in instantly, since the band's text is drawn from the first
 * frame and a fade would leave it over bare content, and fades only on the way back to the top, where
 * nothing is left under the text. The root is no-drag and the window drags from the empty spacer
 * siblings, because a no-drag control nested in a drag region doesn't reliably carve itself back out
 * on macOS. The left inset sits under the app's sidebar toggle, so it's plain no-drag space.
 */
export function TopBand({
  leftInset,
  bleed,
  session,
  split,
  scrolled: scrolledUnder
}: {
  leftInset: number
  /** How far the glass reaches left past the band, under the collapsed rail's empty top, so the
   *  hairline runs unbroken to the window edge. */
  bleed: number
  /** A session is open. Without one the band has nothing to describe, so it's only a drag surface. */
  session: boolean
  /** The right sidebar is beside the transcript, so the slot is bounded to the primary pane. */
  split: boolean
  scrolled: boolean
}): JSX.Element {
  const reported = useSession((s) => s.activeHandleId !== null && s.primaryScrolledFor === s.activeHandleId)
  const showToggle = useActive((s) => !!s?.cwd)
  // An open find bar's dim text sits on the band, and a compositor-scrolled first frame can reach
  // it before any script runs, so the band stays tinted for as long as find is open.
  const findOpen = useSession((s) => s.findOpen && !s.viewingSubagent)
  const scrolled = scrolledUnder || findOpen
  const [painted, setPainted] = useState(false)
  // The fade arms a frame after the open session's first report, so a session that opens at the top
  // drops the previous session's tint at once.
  useEffect(() => {
    if (!reported) {
      setPainted(false)
      return
    }
    const raf = requestAnimationFrame(() => setPainted(true))
    return () => cancelAnimationFrame(raf)
  }, [reported])
  const settled = reported && painted

  // Virtuoso reports leaving the top through a React commit, and a compositor-scrolled first wheel
  // frame can paint before it, leaving the band's text over untinted content. The scroll listener
  // marks the band first; at the top it defers to the prop, which may still be set by the other pane.
  const bandRef = useRef<HTMLDivElement>(null)
  const scrolledRef = useRef(scrolled)
  scrolledRef.current = scrolled
  useEffect(() => {
    if (!session) return
    const onScroll = (e: Event): void => {
      const t = e.target
      if (!(t instanceof HTMLElement) || !t.matches('[data-ui="pane-primary"] [data-testid="virtuoso-scroller"]')) return
      if (t.scrollTop > 0) bandRef.current?.setAttribute('data-scrolled', 'true')
      else if (!scrolledRef.current) bandRef.current?.removeAttribute('data-scrolled')
    }
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => document.removeEventListener('scroll', onScroll, { capture: true })
  }, [session])

  if (!session) {
    return (
      <div data-ui="top-band" className="absolute inset-x-0 top-0 z-40 flex h-11">
        <div aria-hidden="true" className="h-full shrink-0" style={{ width: leftInset }} />
        <div data-ui="top-band-drag" aria-hidden="true" className="h-full flex-1 [-webkit-app-region:drag]" />
      </div>
    )
  }
  return (
    <div
      ref={bandRef}
      data-ui="top-band"
      data-scrolled={scrolled || undefined}
      className="group/band absolute inset-x-0 top-0 z-40 flex h-11 items-center"
    >
      <div
        aria-hidden="true"
        data-ui="top-band-glass"
        style={{ left: -bleed }}
        className={`glass-bar pointer-events-none absolute inset-0 -z-10 opacity-0 [--bar-edge:var(--band-edge)] contrast-more:[--bar-edge:var(--color-control-edge)] group-data-[scrolled]/band:opacity-100 contrast-more:opacity-100 ${
          settled ? 'transition-opacity duration-fast ease-in group-data-[scrolled]/band:transition-none motion-reduce:transition-none' : ''
        }`}
      />
      <div aria-hidden="true" className="h-full shrink-0" style={{ width: leftInset }} />
      <div
        className="flex h-full min-w-0 items-center"
        style={split ? { width: `calc(var(--primary-w, 50%) - ${leftInset}px)` } : { flex: '1 1 0%' }}
      >
        <div data-ui="top-band-drag" aria-hidden="true" className="h-full w-6 shrink-0 [-webkit-app-region:drag]" />
        <TopSlot leftInset={leftInset} rightInset={showToggle && !split ? RIGHT_INSET : EDGE_INSET} split={split} />
        <div data-ui="top-band-drag" aria-hidden="true" className="h-full w-6 shrink-0 [-webkit-app-region:drag]" />
      </div>
      {split && (
        <div data-ui="top-band-drag" aria-hidden="true" className="h-full min-w-0 flex-1 [-webkit-app-region:drag]" />
      )}
      {showToggle && (
        <div data-ui="top-band-actions" className="flex shrink-0 items-center gap-1">
          <PaneToggle />
        </div>
      )}
      <div data-ui="top-band-drag" aria-hidden="true" className="h-full w-2 shrink-0 [-webkit-app-region:drag]" />
    </div>
  )
}

// The trailing w-2 inset, the 28px pane toggle and an 8px gap, the same gap leftInset keeps past
// the collapsed toggle, so the header never touches it. In a split the toggle sits over the other pane,
// past the slot's edge, and a session with nothing to show has no toggle, so only the inset is left.
const RIGHT_INSET = 44
const EDGE_INSET = 8

/**
 * The band's middle slot, which is always a drag spacer. Its content floats in an overlay laid on
 * the transcript's column box, so "You" lines up with the messages under it rather than with the
 * spacers around the slot; only the content's own controls take the pointer.
 */
export function TopSlot({
  leftInset,
  rightInset,
  split
}: {
  leftInset: number
  rightInset: number
  split: boolean
}): JSX.Element {
  const currentTurn = useSession((s) => s.currentTurn)
  const findOpen = useSession((s) => s.findOpen && !s.viewingSubagent)
  return (
    <div data-ui="top-slot" className="flex h-full min-w-0 flex-1 items-center">
      <div data-ui="top-band-drag" aria-hidden="true" className="h-full flex-1 [-webkit-app-region:drag]" />
      {(findOpen || currentTurn) && (
        <div
          className="pointer-events-none absolute inset-y-0 left-0 flex items-center"
          style={{ width: split ? 'var(--primary-w, 50%)' : '100%', paddingRight: 'var(--sb-w, 0px)' }}
        >
          <div
            className="mx-auto flex w-full min-w-0 max-w-5xl items-center [&>*]:pointer-events-auto"
            style={{
              paddingLeft: `max(1.25rem, calc(${leftInset}px - max(0px, (100% - 64rem) / 2)))`,
              // The inset counts from the band's edge, and this box already stops short of it by the scrollbar.
              paddingRight: `max(1.25rem, calc(${rightInset}px - var(--sb-w, 0px) - max(0px, (100% - 64rem) / 2)))`
            }}
          >
            {findOpen ? <FindBar /> : currentTurn && <CurrentTurnHeader key={currentTurn.messageId} />}
          </div>
        </div>
      )}
    </div>
  )
}

/** Shows or hides this session's pane, a disclosure for the right sidebar. Its glyph and name are the
 *  tab it would show or is showing. While Claude drives a hidden browser, a static dot marks it, since
 *  the light itself stays in the transcript. */
function PaneToggle(): JSX.Element {
  const open = useSession((s) => !s.viewingSubagent && selectPaneOpen(activeSlice(s)))
  const driving = useActive((s) => anyTabIn(s?.browser, 'driving'))
  const kind = useActive((s) => (s ? surfaceKindOf(s.surfaces, paneTarget(s)) : null))
  const title = useActive((s) => {
    const id = s && paneTarget(s)
    return (id && s?.surfaces.tabs[id]?.title) ?? ''
  })
  const togglePane = useSession((s) => s.togglePane)
  const verb = open ? 'Hide' : 'Show'
  // With no target a click shows the picker, so the glyph stays the generic pane one even when the session has a browser.
  const { Glyph, name, what } =
    kind === 'diff'
      ? { Glyph: IconDiff, name: 'Claude changes', what: 'Claude changes' }
      : kind === 'file'
        ? { Glyph: IconFile, name: `File, ${title}`, what: title }
        : kind === 'tree'
          ? { Glyph: IconFolder, name: 'File tree', what: 'file tree' }
          : kind === 'browser'
            ? { Glyph: IconAgentBrowser, name: driving && !open ? 'Browser, Claude is driving' : 'Browser', what: 'browser' }
            : { Glyph: IconPaneRight, name: 'Pane', what: 'pane' }
  return (
    <button
      type="button"
      title={`${verb} ${what} ⌥⌘0`}
      data-ui="pane-toggle"
      data-kind={kind ?? 'pane'}
      aria-label={name}
      aria-expanded={open}
      aria-controls={open ? 'surface-pane-region' : undefined}
      onClick={(e) => {
        const via = viaOf(e)
        togglePane((next) => setPaneVia(next, via))
      }}
      className="toggle-press relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-dim transition-colors focus-visible:-outline-offset-2 pointer-fine:hover:bg-[var(--glass-row-hover)] pointer-fine:hover:text-content"
    >
      <Glyph className="h-4 w-4" />
      {driving && !open && <span aria-hidden="true" className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent ring-2 ring-bg" />}
    </button>
  )
}
