import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { useActive, useSession } from '../store'
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

const STRIP: Partial<Record<DriveState, { label: string; hint: string }>> = {
  driving: { label: 'Claude is driving', hint: 'Click the page to take over' },
  user: { label: "You're driving", hint: 'Claude is paused' },
  stopped: { label: 'Stopped', hint: 'Send a message to let Claude use the browser again' }
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
  const url = useActive((s) => s?.browser?.url ?? '')
  const loading = useActive((s) => s?.browser?.loading ?? false)
  const canBack = useActive((s) => s?.browser?.canBack ?? false)
  const canForward = useActive((s) => s?.browser?.canForward ?? false)
  const driving = useActive((s) => s?.browser?.drive === 'driving')
  const suspended = useActive((s) => s?.browser?.suspended ?? false)
  const wall = useActive((s) => s?.browser?.loginWall === 'hardware')
  const setNotice = useSession((s) => s.setNotice)

  const shown = url === 'about:blank' ? '' : url
  const [focused, setFocused] = useState(false)
  // Null until the user edits, so a navigation while the field has focus still shows the new URL.
  const [draft, setDraft] = useState<string | null>(null)
  const { origin, rest } = splitUrl(shown)

  const navBtn = `${PANE_BTN} disabled:pointer-events-none disabled:opacity-40`
  const nav = (action: 'back' | 'forward' | 'reload' | 'stop'): void => void window.clui.browserNav(handleId, action)

  const go = async (): Promise<void> => {
    if (!draft?.trim()) return
    const err = await window.clui.browserNavigate(handleId, normalize(draft))
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
          data-pane-title={suspended || wall ? undefined : ''}
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

      {suspended && <span className="shrink-0 text-label text-dim">Page paused</span>}
    </div>
  )
}

/**
 * Who is driving, on its own line between the toolbar and the page. It never animates: the page
 * under it jumps by the strip's height, and motion would only draw the eye to the jump. The live
 * region sits outside the strip so it's still mounted to say "finished" once the strip has gone.
 */
export function BrowserDriveStrip(): JSX.Element {
  const drive = useActive((s) => s?.browser?.drive ?? 'idle')
  const suspended = useActive((s) => s?.browser?.suspended ?? false)
  const browserDrive = useSession((s) => s.browserDrive)
  const rootRef = useRef<HTMLDivElement>(null)
  const state = suspended ? undefined : STRIP[drive]

  const [announce, setAnnounce] = useState('')
  const prevDrive = useRef(drive)
  const seq = useRef(0)
  useEffect(() => {
    const prev = prevDrive.current
    prevDrive.current = drive
    if (prev === drive) return
    const text = drive === 'driving' ? (prev === 'user' ? 'Claude is driving again.' : 'Claude is driving the browser.') : ANNOUNCE[drive]
    if (text) setAnnounce(`${text}${'\u200b'.repeat(++seq.current % 2)}`)
  }, [drive])

  // The pressed button unmounts once main answers, so focus that was in the strip goes to the next
  // useful control: Stop after Hand back, the address once Claude is stopped.
  const refocus = useRef<string | null>(null)
  useLayoutEffect(() => {
    const target = refocus.current
    if (!target) return
    refocus.current = null
    document.querySelector<HTMLElement>(target)?.focus()
  }, [drive])
  const act = (action: 'stop' | 'handback'): void => {
    if (rootRef.current?.contains(document.activeElement))
      refocus.current = action === 'stop' ? '[data-ui="browser-url"]' : '[data-ui="browser-stop"]'
    void browserDrive(action)
  }

  return (
    <>
      {state && (
        <div
          ref={rootRef}
          data-ui="browser-drive-strip"
          className="@container flex h-9 shrink-0 items-center gap-2 border-b border-border bg-tool pl-2 pr-2"
        >
          <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center gap-0.5">
            {drive === 'driving' ? (
              <span className="h-2 w-2 rounded-full bg-accent" />
            ) : drive === 'user' ? (
              <>
                <span className="h-2 w-0.5 rounded-[1px] bg-dim" />
                <span className="h-2 w-0.5 rounded-[1px] bg-dim" />
              </>
            ) : (
              <span className="h-2 w-2 rounded-[1.5px] bg-dim" />
            )}
          </span>
          <span className="whitespace-nowrap text-label font-medium text-content">{state.label}</span>
          <span title={state.hint} className="min-w-0 flex-1 truncate text-label text-dim @max-[400px]:hidden">
            {state.hint}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {drive === 'user' && (
              <button
                type="button"
                data-ui="browser-handback"
                onClick={() => act('handback')}
                className="btn-primary flex h-7 items-center py-0"
              >
                Hand back
              </button>
            )}
            {drive !== 'stopped' && (
              <button
                type="button"
                data-ui="browser-stop"
                title="Stop ⌘."
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
