import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ApprovedSite, SavedLoginInfo } from '../../../../shared/browser'
import { ToastStack } from '../Toast'
import { FieldError, LOGIN_INPUT } from '../LoginFields'
import { IconEdit, IconPlus, IconTrash } from '../Icon'
import { useEscape } from '../../lib/useEscape'
import { CheckBox, Field, Pane } from './shared'
import { Dropdown } from '../Dropdown'
import { LINK, LINK_MOD, useLinkTarget } from '../../lib/openLink'
import type { LinkTarget } from '../../../../shared/settings'
import { LoginForm } from './LoginForm'
import { ClearBrowsingData } from './ClearBrowsingData'

const UNDO_MS = 5000
// A list turns into a scrolling window with a filter at the row count where it would start to scroll.
const WINDOW_AT = 7
export const DANGER_BTN =
  'inline-flex h-7 shrink-0 items-center rounded-md border border-control-edge bg-control px-2.5 text-label font-semibold text-err transition-colors hover:bg-[var(--color-control-danger-hover)] aria-disabled:cursor-default aria-disabled:border-transparent aria-disabled:bg-bg-raised aria-disabled:text-faint aria-disabled:hover:bg-bg-raised'
// The negative outline offset keeps the ring inside the list window, whose overflow would clip it.
const ICON_BTN =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-dim -outline-offset-2 transition-colors duration-150'
const NEUTRAL_HOVER = 'pointer-fine:hover:bg-bg-raised pointer-fine:hover:text-content'
const DANGER_HOVER =
  'pointer-fine:hover:bg-[var(--color-control-danger-hover)] pointer-fine:hover:text-err active:bg-[var(--color-control-danger-hover)] active:text-err'
// 236px is six and a half rows plus the borders; the cut row is the scroll cue.
const WINDOW = 'h-[236px] overflow-y-auto [scrollbar-gutter:stable] overscroll-contain border-y border-border'

const shortMonth = new Intl.DateTimeFormat('en-US', { month: 'short' })
// en-GB would give the day-first order but spells September "Sept".
const approvedDate = (ms: number): string => {
  const d = new Date(ms)
  const day = `${d.getDate()} ${shortMonth.format(d)}`
  return d.getFullYear() === new Date().getFullYear() ? day : `${day} ${d.getFullYear()}`
}
const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
const has = (text: string, q: string): boolean => text.toLowerCase().includes(q.toLowerCase())
const bySiteAge = (a: ApprovedSite, b: ApprovedSite): number => b.approvedMs - a.approvedMs || a.site.localeCompare(b.site)
const byLoginAge = (a: SavedLoginInfo, b: SavedLoginInfo): number => b.createdMs - a.createdMs || a.site.localeCompare(b.site)
const siteKey = (s: ApprovedSite): string => `site:${s.site}`
const loginKey = (l: SavedLoginInfo): string => `login:${l.id}`

/** `hides` are the row keys the removal takes out of view, which are also their Remove buttons' focus keys. */
type PendingRemoval = { id: string; hides: string[]; title: string; commit: () => Promise<void> }
type FocusRequest = { key: string; fallback?: string; reveal?: boolean; top?: boolean }

/** The browser switch, approved sites and saved logins. Changes go straight to main without waiting
 *  for Save; a removal commits once its undo toast runs out. The toasts sit outside the pane, so a
 *  pending removal stays undoable from another section. */
export function BrowserSection({ active }: { active: boolean }): JSX.Element {
  const target = useLinkTarget((st) => st.target)
  const [targetFailed, setTargetFailed] = useState(false)
  // Saved on change, like the browser toggle above; the mirror updates first so open links' titles follow at once.
  const saveTarget = (next: LinkTarget, reset = false): void => {
    const prev = useLinkTarget.getState().target
    useLinkTarget.setState({ target: next })
    setTargetFailed(false)
    void window.clui.updateSettings(reset ? {} : { linkTarget: next }, reset ? ['linkTarget'] : undefined).catch(() => {
      useLinkTarget.setState({ target: prev })
      setTargetFailed(true)
    })
  }
  const [sites, setSites] = useState<ApprovedSite[]>([])
  const [logins, setLogins] = useState<SavedLoginInfo[]>([])
  const [vault, setVault] = useState<boolean | null>(null)
  const [form, setForm] = useState<{ edit: SavedLoginInfo | null; opener: string } | null>(null)
  const [pending, setPendingState] = useState<PendingRemoval[]>([])
  const pendingRef = useRef<PendingRemoval[]>([])
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const [announce, setAnnounce] = useState('')
  const announceSeq = useRef(0)
  const [filterSay, setFilterSay] = useState('')
  const filterSeq = useRef(0)
  const [siteQuery, setSiteQuery] = useState('')
  const [loginQuery, setLoginQuery] = useState('')
  const [focus, setFocus] = useState<FocusRequest | null>(null)
  const loginsWindow = useRef<HTMLUListElement>(null)
  const uid = useId()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [enableFailed, setEnableFailed] = useState(false)

  const setPending = useCallback((next: PendingRemoval[]) => {
    pendingRef.current = next
    setPendingState(next)
  }, [])

  const relist = useCallback(async () => {
    const [s, v] = await Promise.all([window.clui.browserListSites(), window.clui.browserVaultAvailable()])
    setSites(s.sort(bySiteAge))
    setVault(v)
    // Listing logins throws without Keychain access, which the unavailable line already explains.
    setLogins(v ? (await window.clui.browserListLogins().catch(() => [])).sort(byLoginAge) : [])
  }, [])
  useEffect(() => {
    void relist()
    void window.clui.getSettings().then(({ values }) => setEnabled(values.browserEnabled))
  }, [relist])

  // Focus moves only after the render that shows its target.
  useLayoutEffect(() => {
    if (!focus) return
    setFocus(null)
    const pane = document.getElementById('settings-panel-browser')
    const find = (key?: string): HTMLElement | null =>
      key ? (pane?.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`) ?? null) : null
    const el = find(focus.key) ?? find(focus.fallback)
    if (!el) return
    if (focus.top) loginsWindow.current?.scrollTo({ top: 0 })
    el.focus({ preventScroll: focus.reveal })
    if (focus.reveal) el.scrollIntoView({ block: 'nearest' })
  }, [focus])

  const sayFilter = useCallback((text: string) => setFilterSay(`${text}${'\u200b'.repeat(++filterSeq.current % 2)}`), [])

  const toggleEnabled = (): void => {
    if (enabled === null) return
    setEnabled(!enabled)
    setEnableFailed(false)
    void window.clui.updateSettings({ browserEnabled: !enabled }).catch(() => {
      setEnabled(enabled)
      setEnableFailed(true)
    })
  }

  // Closing Settings is not an undo: whatever is still waiting commits now.
  useEffect(() => {
    const t = timers.current
    return () => {
      t.forEach(clearTimeout)
      pendingRef.current.forEach((p) => void p.commit())
    }
  }, [])

  const remove = (p: PendingRemoval, said: string): void => {
    const item = { ...p, commit: async () => { await p.commit(); await relist() } }
    setPending([item, ...pendingRef.current.filter((x) => x.id !== p.id)])
    timers.current.set(
      p.id,
      setTimeout(() => {
        timers.current.delete(p.id)
        setPending(pendingRef.current.filter((x) => x.id !== p.id))
        void item.commit()
      }, UNDO_MS)
    )
    setAnnounce(`${said} Undo available.${'\u200b'.repeat(++announceSeq.current % 2)}`)
  }

  const hidden = new Set(pending.flatMap((p) => p.hides))
  const siteMatch = (s: ApprovedSite): boolean => has(s.site, siteQuery)
  const loginMatch = (l: SavedLoginInfo): boolean => has(l.site, loginQuery) || has(l.username, loginQuery)
  const liveSites = sites.filter((s) => !hidden.has(siteKey(s)))
  const liveLogins = logins.filter((l) => !hidden.has(loginKey(l)))
  const siteRows = liveSites.filter(siteMatch)
  const loginRows = liveLogins.filter(loginMatch)
  const sitesWindowed = liveSites.length >= WINDOW_AT || !!siteQuery
  const loginsWindowed = liveLogins.length >= WINDOW_AT || !!loginQuery

  /** Focus lands on the row that takes the removed one's place, like a mail list. */
  const removeRow = (keys: string[], i: number, h3: string, p: PendingRemoval, said: string): void => {
    remove(p, said)
    setFocus({ key: keys[i + 1] ?? keys[i - 1] ?? h3 })
  }
  const removeSite = (s: ApprovedSite, i: number): void =>
    removeRow(siteRows.map(siteKey), i, 'sites-h3', {
      id: siteKey(s),
      hides: [siteKey(s)],
      title: s.site,
      commit: () => window.clui.browserRemoveSite(s.site)
    }, `Removed ${s.site}.`)
  const removeLogin = (l: SavedLoginInfo, i: number): void =>
    removeRow(loginRows.map(loginKey), i, 'logins-h3', {
      id: loginKey(l),
      hides: [loginKey(l)],
      title: `${l.username} on ${l.site}`,
      commit: () => window.clui.browserRemoveLogin(l.id)
    }, `Removed login ${l.username} on ${l.site}.`)
  const removeAllSites = (): void => {
    if (!siteRows.length) return
    const gone = siteRows.map((s) => s.site)
    const n = count(gone.length, 'site', 'sites')
    remove({
      id: `sites:bulk:${Date.now()}`,
      hides: siteRows.map(siteKey),
      title: n,
      commit: async () => { await Promise.all(gone.map((s) => window.clui.browserRemoveSite(s))) }
    }, `Removed ${n}.`)
    setFocus({ key: siteQuery ? 'sites-filter' : 'sites-h3' })
  }

  const undo = (id: string): void => {
    const p = pendingRef.current.find((x) => x.id === id)
    clearTimeout(timers.current.get(id))
    timers.current.delete(id)
    setPending(pendingRef.current.filter((x) => x.id !== id))
    // A pointer undo leaves focus alone; a keyboard one follows the restored row.
    const el = document.activeElement
    if (!p || !el?.closest('[data-toast-id]') || !el.matches(':focus-visible')) return
    const isSite = p.id.startsWith('site')
    const visible = isSite ? sites.filter(siteMatch).map(siteKey) : logins.filter(loginMatch).map(loginKey)
    const key = visible.find((k) => p.hides.includes(k))
    setFocus(key ? { key, reveal: true } : { key: isSite ? 'sites-filter' : 'logins-filter' })
  }

  const openForm = (edit: SavedLoginInfo | null, opener: string): void => {
    if (vault) setForm({ edit, opener })
  }
  const formId = `${uid}-form`

  return (
    <>
      <Pane section="browser" active={active} className="flex flex-col gap-5">
        <Field
          label="Agentic browser"
          hint="Running sessions keep what they started with."
          hintId={`${uid}-enabled`}
          note={enableFailed && <FieldError id={`${uid}-enabled-err`} text="Couldn't save this setting. Try again." />}
        >
          <button
            type="button"
            role="checkbox"
            data-ui="browser-enabled"
            aria-checked={!!enabled}
            aria-disabled={enabled === null || undefined}
            aria-label="Enable the agentic browser for new and resumed sessions"
            aria-describedby={`${uid}-enabled${enableFailed ? ` ${uid}-enabled-err` : ''}`}
            onClick={toggleEnabled}
            className="group flex items-center gap-2 self-start rounded-md py-1 pr-1 text-left"
          >
            <CheckBox checked={!!enabled} />
            <span className="text-label text-content">Enable for new and resumed sessions</span>
          </button>
        </Field>
        <Field
          label="Open links in"
          hint={
            enabled
              ? `Applies to links in Claude's replies and tool output. ${LINK_MOD}-click opens the other way.`
              : 'Takes effect when the agentic browser is on. Until then, links open in your default browser.'
          }
          hintId={`${uid}-links`}
          onReset={target !== 'clui' ? () => saveTarget('clui', true) : undefined}
          note={targetFailed && <FieldError id={`${uid}-links-err`} text="Couldn't save this setting. Try again." />}
        >
          <Dropdown<LinkTarget>
            value={target}
            ariaLabel="Open links in"
            options={[
              { value: 'clui', label: "Clui's browser" },
              { value: 'system', label: 'Default browser' }
            ]}
            onChange={(v) => saveTarget(v)}
          />
        </Field>

        <section className="flex flex-col gap-2" aria-labelledby={`${uid}-sites`}>
          <div className="flex min-h-7 items-center gap-2">
            <h3
              id={`${uid}-sites`}
              tabIndex={-1}
              data-focus="sites-h3"
              className="text-ui font-semibold text-content focus-visible:outline-none"
            >
              Approved sites
            </h3>
            <span className="text-meta text-dim">{liveSites.length}</span>
            {sitesWindowed && (
              <button
                type="button"
                aria-disabled={!siteRows.length || undefined}
                aria-label={siteQuery ? `Remove ${count(siteRows.length, 'matching site', 'matching sites')}` : `Remove all ${count(siteRows.length, 'site', 'sites')}`}
                className={`${DANGER_BTN} ml-auto`}
                onClick={removeAllSites}
              >
                {siteQuery ? 'Remove matching' : 'Remove all'}
              </button>
            )}
          </div>
          {sitesWindowed && (
            <Filter
              value={siteQuery}
              onChange={setSiteQuery}
              focusKey="sites-filter"
              label="Filter approved sites"
              placeholder="Filter sites"
              matches={siteRows.length}
              noun={['site', 'sites']}
              say={sayFilter}
            />
          )}
          {!sitesWindowed && !liveSites.length ? (
            <p className="text-meta text-dim">No approved sites. Claude asks before it opens a new site.</p>
          ) : sitesWindowed && !siteRows.length ? (
            <div className={WINDOW}>
              <p className="px-0 py-2 text-meta text-dim">No sites match &quot;{siteQuery}&quot;.</p>
            </div>
          ) : (
            <ul className={sitesWindowed ? WINDOW : 'flex flex-col'}>
              {siteRows.map((s, i) => (
                <li key={s.site} className="flex h-9 items-center gap-3">
                  <span title={s.site} className="min-w-0 truncate font-mono text-code text-content">
                    {s.site}
                  </span>
                  <span className="shrink-0 text-meta text-dim">Approved {approvedDate(s.approvedMs)}</span>
                  <button
                    type="button"
                    data-focus={siteKey(s)}
                    title="Remove site"
                    aria-label={`Remove ${s.site}`}
                    className={`${ICON_BTN} ${DANGER_HOVER} ml-auto`}
                    onClick={() => removeSite(s, i)}
                  >
                    <IconTrash className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-2" aria-labelledby={`${uid}-logins`}>
          <div
            className={`flex min-h-7 items-center gap-2 ${loginsWindowed ? 'overflow-hidden [scrollbar-gutter:stable]' : ''}`}
          >
            <h3
              id={`${uid}-logins`}
              tabIndex={-1}
              data-focus="logins-h3"
              className="text-ui font-semibold text-content focus-visible:outline-none"
            >
              Saved logins
            </h3>
            <span className="text-meta text-dim">{liveLogins.length}</span>
            <button
              type="button"
              data-focus="add"
              title="Add login"
              aria-label="Add login"
              aria-disabled={vault === false || undefined}
              aria-describedby={vault === false ? `${uid}-vault` : undefined}
              className={`${ICON_BTN} ${vault === false ? 'cursor-default text-faint' : NEUTRAL_HOVER} ml-auto`}
              onClick={() => openForm(null, 'add')}
            >
              <IconPlus className="h-3.5 w-3.5" />
            </button>
          </div>
          {vault === false && (
            <p id={`${uid}-vault`} className="text-meta text-dim">
              Saved logins need macOS Keychain access, which isn&apos;t available right now.
            </p>
          )}
          {loginsWindowed && (
            <Filter
              value={loginQuery}
              onChange={setLoginQuery}
              focusKey="logins-filter"
              label="Filter saved logins"
              placeholder="Filter by site or username"
              matches={loginRows.length}
              noun={['login', 'logins']}
              say={sayFilter}
            />
          )}
          {form && (
            <LoginForm
              key={form.edit?.id ?? 'new'}
              id={formId}
              edit={form.edit}
              onCancel={() => {
                setForm(null)
                setFocus({ key: form.opener })
              }}
              onSaved={(saved) => {
                void relist().then(() => {
                  setForm(null)
                  setFocus({ key: `edit:${saved.id}`, fallback: loginQuery ? 'logins-filter' : 'logins-h3', top: !form.edit })
                })
              }}
            />
          )}
          {vault && !loginsWindowed && !liveLogins.length && !form ? (
            <p className="text-meta text-dim">
              No saved logins yet.{' '}
              <button type="button" data-focus="add-empty" className={LINK} onClick={() => openForm(null, 'add-empty')}>
                Add a login
              </button>
            </p>
          ) : loginsWindowed && !loginRows.length ? (
            <div className={WINDOW}>
              <p className="px-0 py-2 text-meta text-dim">No logins match &quot;{loginQuery}&quot;.</p>
            </div>
          ) : (
            !!loginRows.length && (
              <ul ref={loginsWindow} className={loginsWindowed ? WINDOW : 'flex flex-col'}>
                {loginRows.map((l, i) => {
                  const editing = form?.edit?.id === l.id
                  return (
                    <li key={l.id} className="flex h-9 items-center gap-3">
                      <span title={l.site} className="min-w-0 truncate font-mono text-code text-content">
                        {l.site}
                      </span>
                      <span title={l.username} className="min-w-0 truncate text-meta text-dim">
                        {l.username}
                      </span>
                      {l.hasTotp && <span className="shrink-0 rounded bg-bg-raised px-1.5 py-0.5 text-badge text-dim">2FA</span>}
                      <span className="ml-auto flex shrink-0 gap-2">
                        <button
                          type="button"
                          data-focus={`edit:${l.id}`}
                          title="Edit login"
                          aria-label={`Edit login ${l.username} on ${l.site}`}
                          aria-expanded={editing}
                          aria-controls={editing ? formId : undefined}
                          className={`${ICON_BTN} ${NEUTRAL_HOVER}`}
                          onClick={() => openForm(l, `edit:${l.id}`)}
                        >
                          <IconEdit className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          data-focus={loginKey(l)}
                          title="Remove login"
                          aria-label={`Remove login ${l.username} on ${l.site}`}
                          className={`${ICON_BTN} ${DANGER_HOVER}`}
                          onClick={() => removeLogin(l, i)}
                        >
                          <IconTrash className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    </li>
                  )
                })}
              </ul>
            )
          )}
        </section>

        <ClearBrowsingData />
        <span className="sr-only" aria-live="polite">
          {filterSay}
        </span>
      </Pane>

      <ToastStack
        items={pending.map((p) => ({ id: p.id, title: p.title, suffix: 'removed' }))}
        durationMs={UNDO_MS}
        announce={announce}
        onUndo={undo}
        label="Recently removed browser items"
      />
    </>
  )
}

/** Esc with text clears the field and keeps focus; the escape stack puts it above Settings' own Esc.
 *  The match count is spoken once typing pauses. */
function Filter({
  value,
  onChange,
  focusKey,
  label,
  placeholder,
  matches,
  noun: [one, many],
  say
}: {
  value: string
  onChange: (q: string) => void
  focusKey: string
  label: string
  placeholder: string
  matches: number
  noun: [string, string]
  say: (text: string) => void
}): JSX.Element {
  const [focused, setFocused] = useState(false)
  const clear = useCallback(() => onChange(''), [onChange])
  useEscape(focused && value !== '', clear)
  const latest = useRef(matches)
  latest.current = matches
  useEffect(() => {
    if (!value) return
    const t = setTimeout(() => say(latest.current ? count(latest.current, one, many) : `No ${many} match`), 400)
    return () => clearTimeout(t)
  }, [value, one, many, say])

  return (
    <input
      type="text"
      data-focus={focusKey}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      aria-label={label}
      placeholder={placeholder}
      autoComplete="off"
      spellCheck={false}
      className={`${LOGIN_INPUT} placeholder:text-dim`}
    />
  )
}
