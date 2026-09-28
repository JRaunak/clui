import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ApprovedSite, SavedLoginInfo } from '../../../../shared/browser'
import { ToastStack } from '../Toast'
import { FieldError } from '../LoginFields'
import { CheckBox, Pane } from './shared'
import { LoginForm } from './LoginForm'
import { ClearBrowsingData } from './ClearBrowsingData'

const UNDO_MS = 5000
export const CONTROL_BTN =
  'inline-flex h-7 shrink-0 items-center rounded-md border border-control-edge bg-control px-2.5 text-label font-semibold text-content transition-colors hover:bg-control-hover aria-disabled:cursor-default aria-disabled:border-transparent aria-disabled:bg-bg-raised aria-disabled:text-faint aria-disabled:hover:bg-bg-raised'
const shortMonth = new Intl.DateTimeFormat('en-US', { month: 'short' })
// en-GB would give the day-first order but spells September "Sept".
const approvedDate = (ms: number): string => `${new Date(ms).getDate()} ${shortMonth.format(ms)}`

type PendingRemoval = { id: string; title: string; commit: () => Promise<void> }

/** The browser switch, approved sites and saved logins. Changes go straight to main without waiting
 *  for Save; a removal commits once its undo toast runs out. The toasts sit outside the pane, so a
 *  pending removal stays undoable from another section. */
export function BrowserSection({ active }: { active: boolean }): JSX.Element {
  const [sites, setSites] = useState<ApprovedSite[]>([])
  const [logins, setLogins] = useState<SavedLoginInfo[]>([])
  const [vault, setVault] = useState<boolean | null>(null)
  const [form, setForm] = useState<{ edit: SavedLoginInfo | null } | null>(null)
  const [pending, setPendingState] = useState<PendingRemoval[]>([])
  const pendingRef = useRef<PendingRemoval[]>([])
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const [announce, setAnnounce] = useState('')
  const announceSeq = useRef(0)
  const unavailableId = useId()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [enableFailed, setEnableFailed] = useState(false)

  const setPending = useCallback((next: PendingRemoval[]) => {
    pendingRef.current = next
    setPendingState(next)
  }, [])

  const relist = useCallback(async () => {
    const [s, v] = await Promise.all([window.clui.browserListSites(), window.clui.browserVaultAvailable()])
    setSites(s)
    setVault(v)
    // Listing logins throws without Keychain access, which the unavailable line already explains.
    setLogins(v ? await window.clui.browserListLogins().catch(() => []) : [])
  }, [])
  useEffect(() => {
    void relist()
    void window.clui.getSettings().then(({ values }) => setEnabled(values.browserEnabled))
  }, [relist])

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

  const remove = (id: string, title: string, commit: () => Promise<void>): void => {
    const item = { id, title, commit: async () => { await commit(); await relist() } }
    setPending([item, ...pendingRef.current.filter((p) => p.id !== id)])
    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id)
        setPending(pendingRef.current.filter((p) => p.id !== id))
        void item.commit()
      }, UNDO_MS)
    )
    setAnnounce(`${title}. Undo available.${'\u200b'.repeat(++announceSeq.current % 2)}`)
  }
  const undo = (id: string): void => {
    clearTimeout(timers.current.get(id))
    timers.current.delete(id)
    setPending(pendingRef.current.filter((p) => p.id !== id))
  }

  const hidden = new Set(pending.map((p) => p.id))
  const shownSites = sites.filter((s) => !hidden.has(`site:${s.site}`))
  const shownLogins = logins.filter((l) => !hidden.has(`login:${l.id}`))

  return (
    <>
      <Pane section="browser" active={active} className="flex flex-col gap-5">
        <p className="text-meta text-dim">Changes here apply right away and don&apos;t need Save.</p>

        <div className="flex flex-col gap-2">
          <button
            type="button"
            role="checkbox"
            data-ui="browser-enabled"
            aria-checked={!!enabled}
            aria-disabled={enabled === null || undefined}
            aria-describedby={`${unavailableId}-enabled${enableFailed ? ` ${unavailableId}-enabled-err` : ''}`}
            onClick={toggleEnabled}
            className="group flex items-center gap-2 self-start rounded-md py-1 pr-1 text-left"
          >
            <CheckBox checked={!!enabled} />
            <span className="text-ui font-semibold text-content">Let Claude use Clui&apos;s browser</span>
          </button>
          <p id={`${unavailableId}-enabled`} className="text-meta text-dim">
            Applies to new and resumed sessions. Running sessions keep what they started with.
          </p>
          {enableFailed && <FieldError id={`${unavailableId}-enabled-err`} text="Couldn't save this setting. Try again." />}
        </div>

        <section className="flex flex-col gap-2" aria-labelledby={`${unavailableId}-sites`}>
          <div className="flex min-h-7 items-center gap-2">
            <h3 id={`${unavailableId}-sites`} className="text-ui font-semibold text-content">
              Approved sites
            </h3>
            <span className="text-meta text-dim">{shownSites.length}</span>
          </div>
          {shownSites.length === 0 ? (
            <p className="text-meta text-dim">No approved sites yet. Claude asks the first time it opens a site.</p>
          ) : (
            <ul className="flex flex-col">
              {shownSites.map((s) => (
                <li key={s.site} className="flex h-9 items-center gap-3">
                  <span className="min-w-0 truncate font-mono text-code text-content">{s.site}</span>
                  <span className="shrink-0 text-meta text-dim">Approved {approvedDate(s.approvedMs)}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${s.site}`}
                    className={`${CONTROL_BTN} ml-auto`}
                    onClick={() => remove(`site:${s.site}`, `Removed ${s.site}`, () => window.clui.browserRemoveSite(s.site))}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-2" aria-labelledby={`${unavailableId}-logins`}>
          <div className="flex min-h-7 items-center gap-2">
            <h3 id={`${unavailableId}-logins`} className="text-ui font-semibold text-content">
              Saved logins
            </h3>
            <span className="text-meta text-dim">{shownLogins.length}</span>
            <button
              type="button"
              aria-disabled={vault === false || undefined}
              aria-describedby={vault === false ? unavailableId : undefined}
              className={`${CONTROL_BTN} ml-auto`}
              onClick={() => {
                if (vault) setForm({ edit: null })
              }}
            >
              Add login
            </button>
          </div>
          {vault === false && (
            <p id={unavailableId} className="text-meta text-dim">
              Saved logins need macOS Keychain access, which isn&apos;t available right now.
            </p>
          )}
          {form && !form.edit && (
            <LoginForm
              edit={null}
              onCancel={() => setForm(null)}
              onSaved={() => {
                setForm(null)
                void relist()
              }}
            />
          )}
          {vault && shownLogins.length === 0 && !form && <p className="text-meta text-dim">No saved logins yet.</p>}
          {shownLogins.length > 0 && (
            <ul className="flex flex-col">
              {shownLogins.map((l) =>
                form?.edit?.id === l.id ? (
                  <li key={l.id}>
                    <LoginForm
                      edit={l}
                      onCancel={() => setForm(null)}
                      onSaved={() => {
                        setForm(null)
                        void relist()
                      }}
                    />
                  </li>
                ) : (
                  <li key={l.id} className="flex h-9 items-center gap-3">
                    <span className="min-w-0 truncate font-mono text-code text-content">{l.site}</span>
                    <span title={l.username} className="min-w-0 truncate text-meta text-dim">
                      {l.username}
                    </span>
                    {l.hasTotp && <span className="shrink-0 rounded bg-bg-raised px-1.5 py-0.5 text-badge text-dim">2FA</span>}
                    <span className="ml-auto flex shrink-0 gap-2">
                      <button
                        type="button"
                        aria-label={`Edit login for ${l.username}`}
                        className={CONTROL_BTN}
                        onClick={() => setForm({ edit: l })}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove login for ${l.username}`}
                        className={CONTROL_BTN}
                        onClick={() =>
                          remove(`login:${l.id}`, `Removed login for ${l.username}`, () => window.clui.browserRemoveLogin(l.id))
                        }
                      >
                        Remove
                      </button>
                    </span>
                  </li>
                )
              )}
            </ul>
          )}
        </section>

        <ClearBrowsingData />
      </Pane>

      <ToastStack
        items={pending.map((p) => ({ id: p.id, title: p.title }))}
        durationMs={UNDO_MS}
        announce={announce}
        onUndo={undo}
        label="Recently removed browser items"
      />
    </>
  )
}
