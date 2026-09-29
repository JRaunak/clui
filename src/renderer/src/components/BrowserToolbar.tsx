import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useActive, useSession, viewedTabOf, type BrowserTabs } from '../store'
import type { DriveState } from '../../../shared/browser'
import { IconChevron, IconClose, IconRefresh, IconStop } from './Icon'
import { PANE_BTN } from './Stage'

// The toolbar sits over the pane's flat floor, where the solid form is pixel-identical and skips a filter.
const SOLID = { ['--control-material' as string]: 'solid' } as CSSProperties

const ANNOUNCE: Partial<Record<DriveState, string>> = {
  user: 'You took over. Claude is paused.',
  stopped: 'Browser control stopped.',
  done: 'Claude finished with the browser.'
}

/** What the strip says about the viewed tab. `elsewhere`: Claude drives other tabs, not this one. */
type Mode = 'driving' | 'user' | 'stopped' | 'elsewhere'

interface StripView {
  mode: Mode
  /** Other tabs Claude is driving. */
  others: number
  /** The one of them Claude acted in last. */
  recent: number
}

function copyOf({ mode, others, recent }: StripView): { label: string; hint: string } {
  const where = others > 1 ? `in ${others} other tabs` : `in tab ${recent}`
  switch (mode) {
    case 'driving':
      return { label: 'Claude is driving', hint: others ? `Also driving ${where}` : 'Click the page to take over' }
    case 'user':
      return { label: "You're driving", hint: others ? `Claude is still driving ${where}` : 'Claude is paused in this tab' }
    case 'elsewhere':
      return { label: `Claude is driving ${where}`, hint: 'You can keep using this tab' }
    case 'stopped':
      return { label: 'Stopped', hint: 'Send a message to let Claude use the browser again' }
  }
}

const othersOf = (b: BrowserTabs | null | undefined): number =>
  b ? b.tabs.filter((t) => t.id !== b.viewed && t.drive === 'driving').length : 0

/** The other driving tab Claude used last, from the tool calls main attributed; else the newest one. */
function recentOf(b: BrowserTabs | null | undefined): number {
  if (!b) return 0
  const driving = new Set(b.tabs.filter((t) => t.id !== b.viewed && t.drive === 'driving').map((t) => t.id))
  if (!driving.size) return 0
  const used = Object.values(b.toolTabs)
  for (let i = used.length - 1; i >= 0; i--) if (driving.has(used[i])) return used[i]
  return Math.max(...driving)
}

/** A bare host or host:port gets https://; anything with a real scheme goes to main as typed, which
 *  refuses what isn't http(s). */
function normalize(raw: string): string {
  const v = raw.trim()
  return /^[a-z][a-z\d+.-]*:(\/\/|[^\d])/i.test(v) ? v : `https://${v}`
}

/** The display form drops only https://, because a visible http:// is the missing-s warning. */
function splitUrl(url: string): { origin: string; rest: string } {
  try {
    const u = new URL(url)
    const origin = `${u.protocol}//${u.host}`
    return { origin: u.protocol === 'https:' ? u.host : origin, rest: url.slice(origin.length) }
  } catch {
    return { origin: url, rest: '' }
  }
}

export function BrowserToolbar({ handleId }: { handleId: string }): JSX.Element {
  const tab = useActive((s) => s?.browser?.viewed ?? 0)
  const url = useActive((s) => viewedTabOf(s?.browser)?.url ?? '')
  const loading = useActive((s) => viewedTabOf(s?.browser)?.loading ?? false)
  const canBack = useActive((s) => viewedTabOf(s?.browser)?.canBack ?? false)
  const canForward = useActive((s) => viewedTabOf(s?.browser)?.canForward ?? false)
  const driving = useActive((s) => viewedTabOf(s?.browser)?.drive === 'driving')
  const wall = useActive((s) => viewedTabOf(s?.browser)?.loginWall === 'hardware')
  const setNotice = useSession((s) => s.setNotice)

  const shown = url === 'about:blank' ? '' : url
  const [focused, setFocused] = useState(false)
  // Null until the user edits, so a navigation while the field has focus still shows the new URL.
  const [draft, setDraft] = useState<string | null>(null)
  const { origin, rest } = splitUrl(shown)

  const navBtn = `${PANE_BTN} disabled:pointer-events-none disabled:opacity-40`
  const nav = (action: 'back' | 'forward' | 'reload' | 'stop'): void => void window.clui.browserNav(handleId, tab, action)

  const go = async (): Promise<void> => {
    if (!draft?.trim()) return
    const err = await window.clui.browserNavigate(handleId, tab, normalize(draft))
    if (err) setNotice(err, 'warn')
    else setDraft(null)
  }

  return (
    <div className="glass-bar flex h-10 shrink-0 items-center gap-1.5 px-2 [--bar-edge:var(--color-border)] contrast-more:[--bar-edge:var(--color-control-edge)]" style={SOLID}>
      <button type="button" aria-label="Back" disabled={!canBack} onClick={() => nav('back')} className={navBtn}>
        <IconChevron className="h-4 w-4 rotate-180" />
      </button>
      <button type="button" aria-label="Forward" disabled={!canForward} onClick={() => nav('forward')} className={navBtn}>
        <IconChevron className="h-4 w-4" />
      </button>
      <button
        type="button"
        aria-label={loading ? 'Stop loading' : 'Reload'}
        onClick={() => nav(loading ? 'stop' : 'reload')}
        className={navBtn}
      >
        {loading ? <IconClose className="h-4 w-4" /> : <IconRefresh className="h-4 w-4" />}
      </button>

      <div className="relative flex min-w-40 flex-1">
        <input
          data-ui="browser-url"
          data-pane-title={wall ? undefined : ''}
          aria-label="Address"
          placeholder="Enter an address, or ask Claude"
          spellCheck={false}
          autoComplete="off"
          readOnly={driving}
          title={driving ? 'Claude is driving. Take over to type an address.' : shown || undefined}
          value={focused ? (draft ?? shown) : shown}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => {
            setFocused(true)
            setDraft(null)
            e.currentTarget.select()
          }}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !driving) {
              e.preventDefault()
              void go()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              const el = e.currentTarget
              setDraft(null)
              requestAnimationFrame(() => el.select())
            }
          }}
          className={`h-7 min-w-0 flex-1 rounded-md bg-control px-2.5 text-code placeholder:text-dim focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring focus-visible:outline-offset-[-2px] ${
            focused ? 'text-content' : 'text-transparent'
          }`}
        />
        {!focused && shown && (
          <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-2.5 right-2.5 flex items-center overflow-hidden whitespace-nowrap text-code">
            <span className="min-w-0 truncate text-content">{origin}</span>
            <span className="min-w-0 shrink-[1000] truncate text-dim">{rest}</span>
          </span>
        )}
      </div>

    </div>
  )
}

/**
 * Who is driving the viewed tab, on its own line between the toolbar and the page, and whether Claude
 * is driving other tabs. It never animates: the page under it jumps by the strip's height, and motion
 * would only draw the eye to the jump. Once shown it stays for the rest of the turn, so Claude moving
 * between tabs moves the page once rather than on every switch. The live region sits outside the
 * strip so it's still mounted to say "finished" once the strip has gone.
 */
export function BrowserDriveStrip(): JSX.Element {
  const viewed = useActive((s) => s?.browser?.viewed ?? 0)
  const drive = useActive((s) => viewedTabOf(s?.browser)?.drive ?? 'idle')
  const others = useActive((s) => othersOf(s?.browser))
  const recent = useActive((s) => recentOf(s?.browser))
  const several = useActive((s) => (s?.browser?.tabs.length ?? 0) > 1)
  const busy = useActive((s) => !!s?.busy)
  const browserDrive = useSession((s) => s.browserDrive)
  const viewTab = useSession((s) => s.viewBrowserTab)
  const rootRef = useRef<HTMLDivElement>(null)

  const mode: Mode | null =
    drive === 'driving' || drive === 'user' || drive === 'stopped' ? drive : others ? 'elsewhere' : null
  const view = useMemo<StripView | null>(() => (mode ? { mode, others, recent } : null), [mode, others, recent])
  const [held, setHeld] = useState<StripView | null>(null)
  useEffect(() => {
    if (!busy) setHeld(null)
    else if (view) setHeld(view)
  }, [view, busy])
  const shown = view ?? (busy ? held : null)

  const [announce, setAnnounce] = useState('')
  const prev = useRef({ viewed, drive, mode })
  const seq = useRef(0)
  useEffect(() => {
    const p = prev.current
    prev.current = { viewed, drive, mode }
    // Viewing another tab is the user's own doing, and focus on the tab already says where they are.
    if (p.viewed !== viewed) return
    let text: string | undefined
    if (mode === 'elsewhere' && p.mode !== 'elsewhere') text = `Claude is driving in tab ${recent}.`
    else if (p.drive !== drive)
      text = drive === 'driving' ? (p.drive === 'user' ? 'Claude is driving again.' : 'Claude is driving the browser.') : ANNOUNCE[drive]
    if (text) setAnnounce(`${text}${'\u200b'.repeat(++seq.current % 2)}`)
  }, [viewed, drive, mode, recent])

  // The pressed button unmounts once main answers, so focus that was in the strip goes to the next
  // useful control: Stop after Hand back or Show tab, the address once Claude is stopped.
  const refocus = useRef<string | null>(null)
  const shownMode = shown?.mode
  useLayoutEffect(() => {
    const target = refocus.current
    if (!target) return
    refocus.current = null
    document.querySelector<HTMLElement>(target)?.focus()
  }, [shownMode])
  const keepFocus = (target: string): void => {
    if (rootRef.current?.contains(document.activeElement)) refocus.current = target
  }
  const act = (action: 'stop' | 'handback'): void => {
    keepFocus(action === 'stop' ? '[data-ui="browser-url"]' : '[data-ui="browser-stop"]')
    void browserDrive(action)
  }
  const copy = shown && copyOf(shown)
  // A status hint cut mid-word reads as broken, so one that doesn't fit is hidden whole. It stays in
  // layout while hidden, so its widths keep measuring and it comes back once there's room.
  const [hintEl, setHintEl] = useState<HTMLSpanElement | null>(null)
  const [clipped, setClipped] = useState(false)
  const hint = copy?.hint
  useLayoutEffect(() => {
    if (!hintEl) return
    const check = (): void => setClipped(hintEl.scrollWidth > hintEl.clientWidth)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(hintEl)
    return () => ro.disconnect()
  }, [hintEl, hint])

  return (
    <>
      {shown && copy && (
        <div
          ref={rootRef}
          data-ui="browser-drive-strip"
          data-mode={shown.mode}
          className="@container flex h-9 shrink-0 items-center gap-2 border-b border-border bg-tool pl-2 pr-2"
        >
          <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center gap-0.5">
            {shown.mode === 'driving' ? (
              <span className="h-2 w-2 rounded-full bg-accent" />
            ) : shown.mode === 'user' ? (
              <>
                <span className="h-2 w-0.5 rounded-[1px] bg-dim" />
                <span className="h-2 w-0.5 rounded-[1px] bg-dim" />
              </>
            ) : shown.mode === 'elsewhere' ? (
              <span className="h-2 w-2 rounded-full border-[1.5px] border-dim" />
            ) : (
              <span className="h-2 w-2 rounded-[1.5px] bg-dim" />
            )}
          </span>
          <span className="whitespace-nowrap text-label font-medium text-content">{copy.label}</span>
          <span ref={setHintEl} className={`min-w-0 flex-1 truncate text-label text-dim ${clipped ? 'invisible' : ''}`}>
            {copy.hint}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {shown.mode === 'user' && (
              <button
                type="button"
                data-ui="browser-handback"
                onClick={() => act('handback')}
                className="btn-primary flex h-7 items-center py-0"
              >
                Hand back
              </button>
            )}
            {shown.mode === 'elsewhere' && (
              <button
                type="button"
                data-ui="browser-show-tab"
                onClick={() => {
                  keepFocus('[data-ui="browser-stop"]')
                  viewTab(shown.recent)
                }}
                className="flex h-7 shrink-0 items-center justify-center rounded-md border border-control-edge bg-control px-2.5 text-label text-content transition-colors pointer-fine:hover:bg-control-hover active:bg-border-strong"
              >
                Show tab {shown.recent}
              </button>
            )}
            {shown.mode !== 'stopped' && (
              <button
                type="button"
                data-ui="browser-stop"
                title={several ? 'Stop in every tab ⌘.' : 'Stop ⌘.'}
                aria-label="Stop"
                aria-keyshortcuts="Meta+Period"
                onClick={() => act('stop')}
                className="flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md border border-control-edge bg-control px-2.5 text-label text-content transition-colors pointer-fine:hover:bg-control-hover active:bg-border-strong @max-[400px]:w-7 @max-[400px]:px-0"
              >
                <IconStop className="h-3.5 w-3.5" />
                <span className="@max-[400px]:hidden">Stop</span>
              </button>
            )}
          </div>
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
    </>
  )
}
