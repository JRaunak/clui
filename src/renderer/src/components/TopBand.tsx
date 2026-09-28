import { useEffect, useState } from 'react'
import { useSession } from '../store'
import { CurrentTurnHeader } from './CurrentTurnHeader'

/**
 * The top band over the Stage's top 44px, which the transcript scrolls beneath. Its glass layer fades
 * in only while content is under it. The root is no-drag and the window drags from the empty spacer
 * siblings, because a no-drag control nested in a drag region doesn't reliably carve itself back out
 * on macOS. The left inset sits under the app's sidebar toggle, so it's plain no-drag space.
 */
export function TopBand({
  leftInset,
  bleed,
  session,
  split,
  scrolled
}: {
  leftInset: number
  /** How far the glass reaches left past the band, under the collapsed rail's empty top, so the
   *  increased-contrast hairline runs unbroken to the window edge. */
  bleed: number
  /** A session is open. Without one the band has nothing to describe, so it's only a drag surface. */
  session: boolean
  /** The right sidebar is beside the transcript, so the slot is bounded to the primary pane. */
  split: boolean
  scrolled: boolean
}): JSX.Element {
  const reported = useSession((s) => s.activeHandleId !== null && s.primaryScrolledFor === s.activeHandleId)
  const [painted, setPainted] = useState(false)
  // The fade arms a frame after the open session's first report, so a session that opens scrolled
  // paints its tint without fading in.
  useEffect(() => {
    if (!reported) {
      setPainted(false)
      return
    }
    const raf = requestAnimationFrame(() => setPainted(true))
    return () => cancelAnimationFrame(raf)
  }, [reported])
  const settled = reported && painted

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
      data-ui="top-band"
      data-scrolled={scrolled || undefined}
      className="group/band absolute inset-x-0 top-0 z-40 flex h-11 items-center"
    >
      <div
        aria-hidden="true"
        data-ui="top-band-glass"
        style={{ left: -bleed }}
        className={`glass-bar pointer-events-none absolute inset-0 -z-10 opacity-0 group-data-[scrolled]/band:opacity-100 contrast-more:opacity-100 ${
          settled ? 'transition-opacity duration-fast ease-in group-data-[scrolled]/band:ease-out motion-reduce:transition-none' : ''
        }`}
      />
      <div aria-hidden="true" className="h-full shrink-0" style={{ width: leftInset }} />
      <div
        className="flex h-full min-w-0 items-center"
        style={split ? { width: `calc(var(--primary-w, 50%) - ${leftInset}px)` } : { flex: '1 1 0%' }}
      >
        <div data-ui="top-band-drag" aria-hidden="true" className="h-full w-6 shrink-0 [-webkit-app-region:drag]" />
        <TopSlot />
        <div data-ui="top-band-drag" aria-hidden="true" className="h-full w-6 shrink-0 [-webkit-app-region:drag]" />
      </div>
      {split && (
        <div data-ui="top-band-drag" aria-hidden="true" className="h-full min-w-0 flex-1 [-webkit-app-region:drag]" />
      )}
      <div data-ui="top-band-actions" className="flex shrink-0 items-center gap-1" />
      <div data-ui="top-band-drag" aria-hidden="true" className="h-full w-2 shrink-0 [-webkit-app-region:drag]" />
    </div>
  )
}

/**
 * The band's middle slot. Empty, it is itself a drag spacer. Content rendered here replaces the drag
 * div, so it has to flank itself with drag spacers to keep the space around it draggable.
 */
export function TopSlot(): JSX.Element {
  const currentTurn = useSession((s) => s.currentTurn)
  return (
    <div data-ui="top-slot" className="flex h-full min-w-0 flex-1 items-center">
      {currentTurn ? (
        <>
          <div data-ui="top-band-drag" aria-hidden="true" className="h-full flex-1 [-webkit-app-region:drag]" />
          <div className="flex min-w-0 flex-[0_1_64rem] items-center px-5">
            <CurrentTurnHeader key={currentTurn.messageId} />
          </div>
          <div data-ui="top-band-drag" aria-hidden="true" className="h-full flex-1 [-webkit-app-region:drag]" />
        </>
      ) : (
        <div data-ui="top-band-drag" aria-hidden="true" className="h-full flex-1 [-webkit-app-region:drag]" />
      )}
    </div>
  )
}
