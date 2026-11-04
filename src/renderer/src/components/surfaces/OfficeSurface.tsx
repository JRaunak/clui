import { useCallback, useEffect, useRef, useState } from 'react'
import { useActive, useSession } from '../../store'
import type { Refusal } from '../../../../shared/files'
import { isPresentation, type DamagedAs, type Glimpse, type OfficeOpen } from '../../../../shared/office'
import { Button } from '../Button'
import { IconTarget } from '../Icon'
import { useSay } from '../../lib/useSay'
import { noteRead } from '../../lib/blockedFiles'
import { takeSurfaceFocus } from '../../lib/surfaceFocus'
import { megabytes, unconvertedFact, unpackDetail } from '../../lib/docxView'
import { BANNER, baseOf, DocState, openDefault, REASON, SelectionNotice, SKELETON_MS, STATE_BODY, TEXT_BTN, setStatus, type Doc } from './fileDoc'
import { DocxSurface } from './DocxSurface'
import { PdfSurface } from './PdfSurface'
import { ConvertingBanner, ConvertingBody, useConversion } from './Converting'

const TURN_RELOAD_MS = 300
const MISSING_POLL_MS = 2000
const LIBREOFFICE = 'https://www.libreoffice.org/'
const MACROS = ' This document contains macros. Clui never runs them.'
const DARK_PAGE = "In Dark Mode, Quick Look draws its first page as black text on a dark background, so Clui doesn't show it."
const CAP = 'Clui lays out Word documents with up to 1 MB of text and formatting'
const NOTICE = {
  cleared: 'The document changed on disk, so the selection was cleared.',
  removed: 'The document changed on disk, so the selection was cleared and removed from the message.'
}
const DAMAGED: Record<DamagedAs, string> = { word: 'Word document', powerpoint: 'PowerPoint presentation', opendocument: 'OpenDocument file', rtf: 'RTF file' }

type Shown = { t: 'loading' } | { t: 'missing' } | { t: 'error'; reason: Refusal['reason']; message: string } | { t: 'failed'; revision: string; text: boolean } | Extract<OfficeOpen, { ok: true }>
/** Shown in Clui's own view, which keeps its selection across versions. */
const laidOut = (t: Shown['t']): boolean => t === 'word' || t === 'text'

// The install sentence shows on the app session's first glimpse only, and on that tab for as long as it's open.
let hintTab: string | null = null

/**
 * An Office file in the pane: main's pre-flight first, then Clui's own view for a .docx or .docm that fits or an .odt
 * or .rtf that converts, and Quick Look's first page for the rest. Watches the file and runs the pre-flight again on a
 * change.
 */
export function OfficeSurface({ handleId, tabId }: { handleId: string; tabId: string }): JSX.Element {
  const tab = useActive((s) => s?.surfaces.tabs[tabId])
  const path = tab?.key ?? ''
  const name = baseOf(path)
  const owner = `${handleId}\0${path}`
  const busy = useActive((s) => !!s?.busy)
  const setView = useSession((s) => s.setSurfaceView)
  const [shown, setShown] = useState<Shown>({ t: 'loading' })
  const shownRef = useRef(shown)
  shownRef.current = shown
  const [slow, setSlow] = useState(false)
  const [watchGen, setWatchGen] = useState(0)
  const [notice, setNotice] = useState<'cleared' | 'removed' | null>(null)
  const [said, say] = useSay()
  const gen = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const g = ++gen.current
    lastLoad.current = Date.now()
    const r = await window.clui.officeOpen(handleId, path).catch((): Refusal => ({ ok: false, reason: 'unreadable' }))
    if (g !== gen.current) return
    noteRead(handleId, path, r.ok ? null : r.reason)
    const prev = shownRef.current
    if (r.ok && 'revision' in prev && prev.revision === r.revision && prev.t === r.t) return
    const next: Shown = r.ok ? r : r.reason === 'missing' ? { t: 'missing' } : { t: 'error', reason: r.reason, message: REASON[r.reason] }
    // The Word view keeps its own selection across versions; leaving it for anything else clears it.
    if (laidOut(prev.t) && !laidOut(next.t)) {
      const st = useSession.getState()
      const sel = st.sessions[handleId]?.surfaces.tabs[tabId]?.selection
      if (sel?.part) {
        setView(handleId, tabId, { selection: undefined })
        setNotice('cleared')
        say(NOTICE.cleared)
      }
    }
    setStatus(owner, laidOut(next.t) ? 'loading' : next.t === 'missing' ? 'missing' : 'error')
    setShown(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleId, path, tabId])
  const lastLoad = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const busyRef = useRef(busy)
  busyRef.current = busy
  const scheduleLoad = useCallback(() => {
    if (timer.current) return
    const wait = busyRef.current ? Math.max(0, TURN_RELOAD_MS - (Date.now() - lastLoad.current)) : 0
    timer.current = setTimeout(() => {
      timer.current = null
      void load()
    }, wait)
  }, [load])

  useEffect(() => {
    const t = setTimeout(() => setSlow(true), SKELETON_MS)
    void load().finally(() => clearTimeout(t))
    return () => {
      clearTimeout(t)
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      gen.current++
      setStatus(owner, null)
    }
  }, [load, owner])
  useEffect(() => {
    let id: string | null = null
    let live = true
    const off = window.clui.onFileChanged((e) => {
      if (e.handleId === handleId && e.id === id) scheduleLoad()
    })
    void window.clui.watchFile(handleId, path).then((w) => {
      if (!w.ok) return
      if (live) id = w.id
      else void window.clui.unwatchFile(handleId, w.id)
    })
    window.addEventListener('focus', scheduleLoad)
    return () => {
      live = false
      off()
      window.removeEventListener('focus', scheduleLoad)
      if (id) void window.clui.unwatchFile(handleId, id)
    }
  }, [handleId, path, watchGen, scheduleLoad])
  useEffect(() => {
    if (shown.t !== 'missing') return
    const t = setInterval(() => {
      void window.clui.statFile(handleId, path).then((s) => {
        if (!s.ok) return
        void load()
        setWatchGen((n) => n + 1)
      })
    }, MISSING_POLL_MS)
    return () => clearInterval(t)
  }, [shown.t, handleId, path, load])

  // A user open focuses the state's first action once it settles; the views take it themselves.
  const stateEl = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (shown.t === 'loading' || laidOut(shown.t) || shown.t === 'glimpse' || shown.t === 'convert') return
    const via = takeSurfaceFocus(tabId)
    if (!via) return
    const opts: FocusOptions & { focusVisible?: boolean } = { preventScroll: true, focusVisible: via === 'keyboard' }
    ;(stateEl.current?.querySelector<HTMLElement>('button') ?? stateEl.current)?.focus(opts)
  }, [shown.t, tabId])

  if (shown.t === 'word' || shown.t === 'text') {
    return (
      <DocxSurface
        handleId={handleId}
        tabId={tabId}
        flight={shown}
        onStale={scheduleLoad}
        onFailed={() => {
          setStatus(owner, 'error')
          setShown({ t: 'failed', revision: shown.revision, text: shown.t === 'text' })
        }}
      />
    )
  }
  if (shown.t === 'convert') return <ConvertedView handleId={handleId} tabId={tabId} path={path} flight={shown} onStale={scheduleLoad} onMissing={() => void load()} />
  if (shown.t === 'glimpse') return <GlimpseView handleId={handleId} tabId={tabId} path={path} flight={shown} onStale={scheduleLoad} notice={notice} onDismiss={() => setNotice(null)} />

  const app = (
    <Button variant="secondary" size="sm" onClick={() => void openDefault(handleId, path)}>
      Open in default app
    </Button>
  )
  const head = (title: string, body?: string): JSX.Element => (
    <>
      <p className="text-ui font-medium text-content">{title}</p>
      {body && <p className="max-w-[60ch] text-ui text-dim">{body}</p>}
    </>
  )
  const body = ((): JSX.Element | null => {
    switch (shown.t) {
      case 'loading':
        return slow ? <p className="text-meta text-dim">{`Loading ${name}`}</p> : null
      case 'empty':
        return head(`${name} is empty`)
      case 'locked':
        return (
          <>
            {head(`${name} is password protected`, "Clui doesn't open password-protected documents.")}
            <div className="flex gap-2">{app}</div>
          </>
        )
      case 'damaged':
        return (
          <>
            {head(
              `Couldn't open ${name}`,
              shown.converting
                ? `macOS couldn't read it as ${shown.as === 'rtf' ? 'an RTF file' : 'an OpenDocument text file'}. It may be damaged or cut short.`
                : `The file is damaged or isn't a valid ${DAMAGED[shown.as]}.`
            )}
            <div className="flex gap-2">{app}</div>
          </>
        )
      case 'too-large':
        return (
          <>
            {head(`${name} is too large to convert here`, `It's ${Math.ceil(shown.bytes / 1024 / 1024)} MB. Clui converts documents up to 100 MB.`)}
            <div className="flex gap-2">{app}</div>
          </>
        )
      case 'unpacks':
        return (
          <>
            {head(`${name} is too large to open here`, unpackDetail(shown))}
            <div className="flex gap-2">{app}</div>
          </>
        )
      case 'failed':
        return (
          <>
            {head(`Couldn't show ${name}`, shown.text ? "Clui couldn't lay out the converted document." : "Clui couldn't lay out this Word document. It may be damaged or use something Clui can't read.")}
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setShown({ t: 'loading' })
                  void load()
                }}
              >
                Try again
              </Button>
              {app}
            </div>
          </>
        )
      case 'needs-lo':
        return null
      default: {
        const d: Doc = shown.t === 'missing' ? { t: 'missing' } : { t: 'error', reason: shown.reason, message: shown.message }
        return (
          <DocState
            handleId={handleId}
            tabId={tabId}
            path={path}
            doc={d}
            load={load}
            reopen={() => {
              void load()
              setWatchGen((n) => n + 1)
            }}
          />
        )
      }
    }
  })()
  return (
    <div data-ui="office-surface" className="flex h-full min-h-0 flex-col bg-bg pt-(--top-h)">
      <div className="pdf-frame relative min-h-0 flex-1">
        <div
          ref={stateEl}
          role="region"
          aria-label={name}
          aria-busy={shown.t === 'loading' || undefined}
          tabIndex={-1}
          data-ui="office-state"
          data-beside-header=""
          {...(shown.t === 'loading' ? {} : { 'data-pane-title': '' })}
          className={`absolute inset-0 overflow-auto focus-visible:outline-none ${body && shown.t !== 'loading' ? STATE_BODY : 'px-4 py-6'}`}
        >
          {body}
        </div>
      </div>
      {notice && <SelectionNotice notice={notice} copy={NOTICE} onDismiss={() => setNotice(null)} />}
      <span data-ui="office-live" className="sr-only" aria-live="polite">
        {said}
      </span>
    </div>
  )
}

const REBUILDING = 'The pages are being converted again.'

/**
 * LibreOffice's pages of an Office file, in the PDF view. A new revision converts while the old pages stay up under a
 * banner; until a first conversion lands the viewport holds the converting state, after a second of nothing.
 */
function ConvertedView({ handleId, tabId, path, flight, onStale, onMissing }: {
  handleId: string
  tabId: string
  path: string
  flight: Extract<OfficeOpen, { t: 'convert' }>
  onStale: () => void
  onMissing: () => void
}): JSX.Element {
  const name = baseOf(path)
  const owner = `${handleId}\0${path}`
  const { conv, done, shown, stop, again } = useConversion(handleId, path, flight.revision, { onStale, onMissing })
  const stateEl = useRef<HTMLDivElement>(null)
  const rootEl = useRef<HTMLDivElement>(null)
  const [said, say] = useSay()
  const failed = conv.t === 'failed' || conv.t === 'timeout' || conv.t === 'stopped'
  const stale = !!done && done.revision !== flight.revision

  // A conversion that ends while focus is on Stop moves it to what replaced Stop.
  const hadStop = useRef(false)
  hadStop.current = !!(document.activeElement as HTMLElement | null)?.closest('[data-ui="convert-stop"]') && !!rootEl.current?.contains(document.activeElement)
  useEffect(() => {
    if (!hadStop.current) return
    const to = failed ? stateEl.current?.querySelector<HTMLElement>('button') : rootEl.current?.querySelector<HTMLElement>('[data-ui="pdf-viewport"]')
    to?.focus({ preventScroll: true })
  }, [failed, done])
  useEffect(() => {
    if (conv.t === 'failed') say(`Couldn't convert ${name}`)
    else if (conv.t === 'timeout') say(`${name} took too long to convert`)
    else if (conv.t === 'stopped' && !done) say(`Stopped converting ${name}.`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.t])
  useEffect(() => {
    if (!done) setStatus(owner, failed ? 'error' : 'loading')
  }, [owner, done, failed])

  if (done && !(failed && conv.t !== 'stopped')) {
    const busy = stale && (conv.t === 'waiting' || conv.t === 'running')
    return (
      <div ref={rootEl} className="contents">
        <PdfSurface
          handleId={handleId}
          tabId={tabId}
          converted={{
            id: done.id,
            revision: done.revision,
            version: done.version,
            by: done.by,
            slides: isPresentation(path),
            facts: flight.facts,
            frozen: stale ? REBUILDING : null,
            banner: stale && ((busy && shown) || conv.t === 'stopped') ? <ConvertingBanner name={name} conv={conv} onStop={stop} onAgain={() => again()} /> : null,
            onUnreadable: () => again(true)
          }}
        />
      </div>
    )
  }
  const app = (
    <Button variant="secondary" size="sm" onClick={() => void openDefault(handleId, path)}>
      Open in default app
    </Button>
  )
  const retry = (
    <Button variant="secondary" size="sm" onClick={() => again()}>
      {conv.t === 'stopped' ? 'Convert again' : 'Try again'}
    </Button>
  )
  const [title, detail] =
    conv.t === 'failed'
      ? [`Couldn't convert ${name}`, "LibreOffice couldn't turn it into pages. The file may be damaged or use features it can't read."]
      : conv.t === 'timeout'
        ? [`${name} took too long to convert`, 'Clui stops a conversion after a minute.']
        : [`Stopped converting ${name}.`, '']
  return (
    <div ref={rootEl} data-ui="office-surface" className="flex h-full min-h-0 flex-col bg-bg pt-(--top-h)">
      <div className="pdf-frame relative min-h-0 flex-1">
        <div
          ref={stateEl}
          role="region"
          aria-label={name}
          aria-busy={!failed || undefined}
          tabIndex={-1}
          data-ui="office-state"
          data-beside-header=""
          data-pane-title=""
          className={`absolute inset-0 overflow-auto focus-visible:outline-none ${STATE_BODY}`}
        >
          {failed ? (
            <>
              <p className="text-ui font-medium text-content">{title}</p>
              {detail && <p className="max-w-[60ch] text-ui text-dim">{detail}</p>}
              <div className="flex gap-2">
                {retry}
                {app}
              </div>
            </>
          ) : shown ? (
            <ConvertingBody name={name} conv={conv} onStop={stop} />
          ) : null}
        </div>
      </div>
      <span className="sr-only" aria-live="polite">
        {said}
      </span>
    </div>
  )
}

/** Quick Look's first page in a page box, with the one sentence that says what it is and what would show the rest. */
function GlimpseView({ handleId, tabId, path, flight, onStale, notice, onDismiss }: {
  handleId: string
  tabId: string
  path: string
  flight: Extract<OfficeOpen, { t: 'glimpse' }>
  onStale: () => void
  notice: 'cleared' | 'removed' | null
  onDismiss: () => void
}): JSX.Element {
  const name = baseOf(path)
  const owner = `${handleId}\0${path}`
  const slides = isPresentation(path)
  const page = slides ? 'slide' : 'page'
  const location = useActive((s) => s?.surfaces.tabs[tabId]?.location)
  const [g, setG] = useState<Glimpse | null>(null)
  const [slow, setSlow] = useState(false)
  const regionEl = useRef<HTMLDivElement>(null)
  const stateEl = useRef<HTMLDivElement>(null)
  if (hintTab === null) hintTab = tabId
  const hint = hintTab === tabId

  useEffect(() => {
    let live = true
    setG(null)
    setSlow(false)
    const t = setTimeout(() => live && setSlow(true), SKELETON_MS)
    void window.clui
      .officeGlimpse(handleId, path, flight.revision)
      .catch((): Glimpse => ({ ok: false, why: 'failed' }))
      .then((r) => {
        clearTimeout(t)
        if (!live) return
        if (!r.ok && 'reason' in r) return onStale()
        if (!r.ok && r.why === 'changed') return onStale()
        setG(r as Glimpse)
        setStatus(owner, 'error')
      })
    return () => {
      live = false
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleId, path, flight.revision])

  useEffect(() => {
    if (!g) return
    const via = takeSurfaceFocus(tabId)
    if (!via) return
    const opts: FocusOptions & { focusVisible?: boolean } = { preventScroll: true, focusVisible: via === 'keyboard' }
    ;(g.ok ? regionEl.current : (stateEl.current?.querySelector<HTMLElement>('button') ?? regionEl.current))?.focus(opts)
  }, [g, tabId])

  const about = (
    <button type="button" className={TEXT_BTN} onClick={() => void window.clui.openExternal(LIBREOFFICE)}>
      About LibreOffice
    </button>
  )
  const why = flight.xml ? `${CAP}, and this one has ${megabytes(flight.xml)} MB.` : flight.convert ? unconvertedFact(flight.convert) : ''
  const macros = flight.macros ? MACROS : ''
  const fact = `Showing the first ${page} as Quick Look draws it.${why ? ` ${why}` : ''}${macros}`
  const hintText = hint ? ` With LibreOffice installed, Clui shows every ${page} here.` : ''
  const failed = !!g && !g.ok
  const dark = g?.ok === false && g.why === 'unreadable'
  const tooLong = !!flight.xml || flight.convert?.why === 'too-long'
  const claude =
    location?.text !== undefined
      ? tooLong
        ? `Claude pointed to text in ${name}, which is too long to lay out here. Only its first page shows.`
        : flight.convert?.why === 'timeout'
          ? `Claude pointed to text in ${name}, which Clui couldn't convert. Only its first page shows.`
          : flight.convert?.why === 'no-text'
            ? `Claude pointed to text in ${name}, but macOS found no text in it. Only its first page shows.`
            : null
      : location?.page && location.page > 1
        ? `Claude pointed to ${page} ${location.page}. Without LibreOffice, Clui shows only the first ${page} of ${name}.`
        : null

  return (
    <div data-ui="office-surface" className="flex h-full min-h-0 flex-col bg-bg pt-(--top-h)">
      {g?.ok && (
        <div data-ui="glimpse-banner" className={BANNER}>
          <p className="min-w-0 flex-1 py-1">{`${fact}${hintText}`}</p>
          {hint && about}
        </div>
      )}
      {g?.ok && claude && (
        <div data-ui="docx-pointed" className="flex min-h-8 shrink-0 items-center gap-1.5 px-3 text-meta text-dim">
          <IconTarget className="h-3 w-3 shrink-0" />
          {claude}
        </div>
      )}
      <div className="pdf-frame relative min-h-0 flex-1">
        <div
          ref={regionEl}
          role="region"
          aria-label={`${name}, first ${page} preview`}
          aria-description={g?.ok ? `${fact}${hintText}` : undefined}
          aria-busy={!g || undefined}
          tabIndex={0}
          data-ui="glimpse-viewport"
          data-beside-header=""
          {...(g ? { 'data-pane-title': '' } : {})}
          className="pdf-viewport absolute inset-0 overflow-auto bg-page-gutter p-4 focus-visible:outline-none"
        >
          {!g && slow && <p className="text-meta text-dim">{`Loading ${name}`}</p>}
          {g?.ok && (
            <div className="mx-auto bg-page-canvas shadow-[0_0_0_1px_var(--color-page-edge)]" style={{ width: `min(100%, ${g.w / 2}px)`, aspectRatio: `${g.w} / ${g.h}` }}>
              <img src={g.url} alt={`First ${page} of ${name}, as Quick Look draws it`} draggable={false} className="block h-auto w-full" />
            </div>
          )}
          {failed && (
            <div ref={stateEl} className={`${STATE_BODY} bg-bg`}>
              {why ? (
                <>
                  <p className="text-ui font-medium text-content">
                    {tooLong ? `${name} is too long to lay out here` : flight.convert?.why === 'timeout' ? `${name} took too long to convert` : `Clui can't show ${name} here`}
                  </p>
                  <p className="max-w-[60ch] text-ui text-dim">{`${why} ${dark ? DARK_PAGE : "Quick Look couldn't draw its first page."} With LibreOffice installed, Clui can show files like this here.${macros}`}</p>
                </>
              ) : (
                <>
                  <p className="text-ui font-medium text-content">{`Clui can't show ${name} here`}</p>
                  <p className="max-w-[60ch] text-ui text-dim">{`${dark ? `${DARK_PAGE} ` : ''}With LibreOffice installed, Clui can show files like this here.${macros}`}</p>
                </>
              )}
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={() => void openDefault(handleId, path)}>
                  Open in default app
                </Button>
                <Button variant="secondary" size="sm" onClick={() => void window.clui.openExternal(LIBREOFFICE)}>
                  About LibreOffice
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
      {notice && <SelectionNotice notice={notice} copy={NOTICE} onDismiss={onDismiss} />}
    </div>
  )
}
