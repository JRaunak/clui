import { useEffect, useRef, type ReactNode } from 'react'
import { notePaneInput, useSession } from '../../store'

/** The right sidebar. Its scrollers clear the band and its own header (--top-h 80px), and it hands
 *  focus to its title on open and back to the opener on close. */
export function SurfacePane({
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
    const quiet = useSession.getState().paneOpenedQuietly
    if (quiet) useSession.setState({ paneOpenedQuietly: false })
    else document.querySelector<HTMLElement>('[data-ui="pane-secondary"] [data-pane-title]')?.focus()
    return () => {
      const el = document.activeElement
      if (el && el !== document.body) return
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
      onPointerDownCapture={() => notePaneInput()}
      onKeyDownCapture={() => notePaneInput()}
      onFocus={() => onFocusWithin(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onFocusWithin(false)
      }}
    >
      {children}
    </section>
  )
}
