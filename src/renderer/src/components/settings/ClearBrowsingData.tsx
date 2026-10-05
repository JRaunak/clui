import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { BrowsingDataInfo, ClearBrowsingData as ClearWhat } from '../../../../shared/browser'
import { anyTabIn, useSession } from '../../store'
import { FieldError } from '../LoginFields'
import { CheckBox } from './shared'
import { DANGER_BTN } from './BrowserSection'

const MB = 1024 * 1024
const NONE: ClearWhat = { cookies: false, cache: false, history: false }

function cacheDetail(bytes: number): string {
  if (bytes === 0) return 'Nothing cached.'
  const size =
    bytes < MB ? 'Less than 1 MB' : bytes < 1024 * MB ? `${Math.round(bytes / MB)} MB` : `${(bytes / (1024 * MB)).toFixed(1)} GB`
  return `${size} cached. Pages download them again as needed.`
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many)

/** One app-wide clear of the shared browser profile. Nothing starts checked, so a clear takes two
 *  deliberate acts: a cookie clear can't be undone and there is no confirmation step. */
export function ClearBrowsingData(): JSX.Element {
  const id = useId()
  const [info, setInfo] = useState<BrowsingDataInfo | null>(null)
  const [what, setWhat] = useState<ClearWhat>(NONE)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [cleared, setCleared] = useState(false)
  const [announce, setAnnounce] = useState('')
  const seq = useRef(0)
  const blocked = useSession((s) =>
    Object.values(s.sessions).some((x) => anyTabIn(x.browser, 'driving', 'user'))
  )

  const recount = useCallback(async () => setInfo(await window.clui.browserDataInfo().catch(() => null)), [])
  useEffect(() => {
    void recount()
  }, [recount])

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

  const none = !what.cookies && !what.cache && !what.history
  const del = async (): Promise<void> => {
    if (none || unavailable || busy) return
    setBusy(true)
    setFailed(false)
    try {
      await window.clui.browserClearData(what)
      setCleared(true)
      setWhat(NONE)
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
  const rows: { key: keyof ClearWhat; label: string; detail: string }[] = [
    {
      key: 'cookies',
      label: 'Cookies and site data',
      detail:
        n === 0 ? 'Nothing stored.' : `Stored for ${n} ${plural(n, 'site', 'sites')}. Signs you out of ${plural(n, 'it', 'them')}.`
    },
    { key: 'cache', label: 'Cached images and files', detail: cacheDetail(info?.cacheBytes ?? 0) },
    {
      key: 'history',
      label: 'Page history',
      detail:
        pages === 0
          ? 'No pages open.'
          : `Back and forward for ${pages === 1 ? 'the open page' : `${pages} open pages`}. Clui keeps no other history.`
    }
  ]
  const locked = unavailable || busy

  return (
    <section className="flex flex-col gap-2" aria-labelledby={`${id}-data`}>
      <div className="flex min-h-7 items-center gap-2">
        <h3 id={`${id}-data`} className="text-ui font-semibold text-content">
          Browsing data
        </h3>
      </div>
      <p id={`${id}-desc`} className="text-meta text-dim">
        {description}
      </p>
      <div className="flex flex-col">
        {rows.map((r) => (
          <button
            key={r.key}
            type="button"
            role="checkbox"
            data-ui={`clear-data-${r.key}`}
            aria-checked={what[r.key]}
            aria-disabled={locked || undefined}
            aria-describedby={`${id}-${r.key}`}
            onClick={() => {
              if (!locked) setWhat((w) => ({ ...w, [r.key]: !w[r.key] }))
            }}
            className="group flex min-h-11 w-full items-start gap-3 rounded-md py-2 text-left -outline-offset-2 aria-disabled:cursor-default"
          >
            <span className="mt-0.5 flex flex-none">
              <CheckBox checked={what[r.key]} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-label text-content">{r.label}</span>
              <span id={`${id}-${r.key}`} className="text-meta text-dim">
                {r.detail}
              </span>
            </span>
          </button>
        ))}
      </div>
      <p className="text-meta text-dim">Saved logins and approved sites stay. Open pages reload.</p>
      {failed && <FieldError id={`${id}-err`} text="Couldn't clear browsing data. Try again." />}
      <button
        type="button"
        data-ui="clear-data-delete"
        aria-disabled={none || unavailable || undefined}
        aria-busy={busy || undefined}
        aria-describedby={unavailable ? `${id}-desc` : failed ? `${id}-err` : undefined}
        className={`${DANGER_BTN} self-start ${busy ? 'pointer-events-none opacity-60' : ''}`}
        onClick={() => void del()}
      >
        {busy ? 'Clearing…' : 'Clear selected data'}
      </button>
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
    </section>
  )
}
