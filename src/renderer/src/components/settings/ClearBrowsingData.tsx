import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { BrowsingDataInfo, ClearBrowsingData as ClearWhat } from '../../../../shared/browser'
import { anyTabIn, useSession } from '../../store'
import { IconCookie, IconHistory, IconImage } from '../Icon'
import { FieldError } from '../LoginFields'
import { useEscape } from '../../lib/useEscape'
import { CheckBox } from './shared'
import { CONTROL_BTN } from './BrowserSection'

const MB = 1024 * 1024

function cacheDetail(bytes: number): string {
  if (bytes === 0) return 'Nothing cached.'
  const size =
    bytes < MB ? 'Less than 1 MB' : bytes < 1024 * MB ? `${Math.round(bytes / MB)} MB` : `${(bytes / (1024 * MB)).toFixed(1)} GB`
  return `${size} cached. Pages download them again as needed.`
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many)

/** One app-wide clear of the shared browser profile. Opening the checklist is the confirmation. */
export function ClearBrowsingData(): JSX.Element {
  const id = useId()
  const [info, setInfo] = useState<BrowsingDataInfo | null>(null)
  const [open, setOpen] = useState(false)
  const [what, setWhat] = useState<ClearWhat>({ cookies: true, cache: true, history: true })
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [cleared, setCleared] = useState(false)
  const [announce, setAnnounce] = useState('')
  const seq = useRef(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const firstRowRef = useRef<HTMLButtonElement>(null)
  const blocked = useSession((s) =>
    Object.values(s.sessions).some((x) => anyTabIn(x.browser, 'driving', 'user'))
  )

  const recount = useCallback(async () => setInfo(await window.clui.browserDataInfo().catch(() => null)), [])
  useEffect(() => {
    void recount()
  }, [recount])
  useEffect(() => {
    if (open) firstRowRef.current?.focus()
  }, [open])

  const say = (text: string): void => setAnnounce(`${text}${'\u200b'.repeat(++seq.current % 2)}`)
  const empty = !!info && info.cookieSites === 0 && info.cacheBytes === 0 && info.openPages === 0
  const unavailable = blocked || (empty && !cleared)
  const description = blocked
    ? "Unavailable while Claude is using the browser. Try again when it's done."
    : cleared
      ? 'Cleared. Open pages reloaded.'
      : empty
        ? 'Nothing to clear yet.'
        : "Cookies, cache and page history in Clui's browser. Shared by every session."

  const collapse = useCallback(() => {
    setOpen(false)
    setFailed(false)
    triggerRef.current?.focus()
  }, [])
  const busyRef = useRef(false)
  busyRef.current = busy
  const onEscape = useCallback(() => {
    if (!busyRef.current) collapse()
  }, [collapse])
  useEscape(open, onEscape)

  const none = !what.cookies && !what.cache && !what.history
  const del = async (): Promise<void> => {
    if (none || blocked || busy) return
    setBusy(true)
    setFailed(false)
    try {
      await window.clui.browserClearData(what)
      setCleared(true)
      setOpen(false)
      triggerRef.current?.focus()
      say('Browsing data cleared.')
    } catch {
      setFailed(true)
      say("Couldn't clear browsing data. Try again.")
    }
    setBusy(false)
    void recount()
  }

  const n = info?.cookieSites ?? 0
  const pages = info?.openPages ?? 0
  const rows: { key: keyof ClearWhat; icon: JSX.Element; label: string; detail: string }[] = [
    {
      key: 'cookies',
      icon: <IconCookie className="h-4 w-4" />,
      label: 'Cookies and site data',
      detail:
        n === 0 ? 'Nothing stored.' : `Stored for ${n} ${plural(n, 'site', 'sites')}. Signs you out of ${plural(n, 'it', 'them')}.`
    },
    { key: 'cache', icon: <IconImage className="h-4 w-4" />, label: 'Cached images and files', detail: cacheDetail(info?.cacheBytes ?? 0) },
    {
      key: 'history',
      icon: <IconHistory className="h-4 w-4" />,
      label: 'Page history',
      detail:
        pages === 0
          ? 'No pages open.'
          : `Back and forward for ${pages === 1 ? 'the open page' : `${pages} open pages`}. Clui keeps no other history.`
    }
  ]

  return (
    <section className="flex flex-col gap-2" aria-labelledby={`${id}-data`}>
      <div className="flex min-h-7 items-center gap-2">
        <h3 id={`${id}-data`} className="text-ui font-semibold text-content">
          Browsing data
        </h3>
        <button
          ref={triggerRef}
          type="button"
          data-ui="clear-data"
          aria-expanded={open}
          aria-controls={`${id}-panel`}
          aria-disabled={unavailable || undefined}
          aria-describedby={`${id}-desc`}
          className={`${CONTROL_BTN} ml-auto`}
          onClick={() => {
            if (unavailable || busy) return
            if (open) return collapse()
            setWhat({ cookies: true, cache: true, history: true })
            setOpen(true)
          }}
        >
          Clear browsing data
        </button>
      </div>
      <p id={`${id}-desc`} className="text-meta text-dim">
        {description}
      </p>
      {open && (
        <div id={`${id}-panel`} role="group" aria-labelledby={`${id}-data`} className="my-1 flex flex-col gap-2.5 rounded-md bg-tool p-3">
          <div className="flex flex-col">
            {rows.map((r, i) => (
              <button
                key={r.key}
                ref={i === 0 ? firstRowRef : undefined}
                type="button"
                role="checkbox"
                aria-checked={what[r.key]}
                aria-disabled={busy || undefined}
                aria-describedby={`${id}-${r.key}`}
                onClick={() => {
                  if (!busy) setWhat((w) => ({ ...w, [r.key]: !w[r.key] }))
                }}
                className="group flex min-h-11 w-full items-start gap-3 rounded-md px-2 py-2 text-left -outline-offset-2 pointer-fine:hover:bg-[var(--color-row-hover)]"
              >
                <span className="mt-0.5 shrink-0 text-dim">{r.icon}</span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-label text-content">{r.label}</span>
                  <span id={`${id}-${r.key}`} className="text-meta text-dim">
                    {r.detail}
                  </span>
                </span>
                <span className="mt-0.5 flex flex-none">
                  <CheckBox checked={what[r.key]} />
                </span>
              </button>
            ))}
          </div>
          <p className="text-meta text-dim">Saved logins and approved sites stay. Open pages reload.</p>
          {failed && <FieldError id={`${id}-err`} text="Couldn't clear browsing data. Try again." />}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              aria-disabled={busy || undefined}
              className={CONTROL_BTN}
              onClick={() => {
                if (!busy) collapse()
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              data-ui="clear-data-delete"
              aria-disabled={none || blocked || undefined}
              aria-busy={busy || undefined}
              aria-describedby={blocked ? `${id}-desc` : failed ? `${id}-err` : undefined}
              className={`btn-primary inline-flex h-7 items-center px-2.5 py-0 text-label font-semibold aria-disabled:cursor-default aria-disabled:bg-bg-raised aria-disabled:text-faint aria-disabled:hover:bg-bg-raised ${busy ? 'pointer-events-none opacity-60' : ''}`}
              onClick={() => void del()}
            >
              Clear data
            </button>
          </div>
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
    </section>
  )
}
