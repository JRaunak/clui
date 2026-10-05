import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { siteFromInput, type SavedLoginInfo } from '../../../../shared/browser'
import { Button } from '../Button'
import { IconWarn } from '../Icon'
import { FieldError, LOGIN_INPUT, RevealButton } from '../LoginFields'

/** The same normalisation main applies when it saves, so the hint shows the site that will be stored. */

/** Add or edit a saved login. An edit never shows the stored password: leaving it blank keeps it.
 *  Field values stay in this component; the password goes to main in the save call only. */
export function LoginForm({
  id: formId,
  edit,
  onCancel,
  onSaved
}: {
  id: string
  edit: SavedLoginInfo | null
  onCancel: () => void
  onSaved: (saved: SavedLoginInfo) => void
}): JSX.Element {
  const [site, setSite] = useState(edit?.site ?? '')
  const [username, setUsername] = useState(edit?.username ?? '')
  const [password, setPassword] = useState('')
  const [seed, setSeed] = useState('')
  const [reveal, setReveal] = useState(false)
  const [touched, setTouched] = useState({ site: false, username: false, password: false })
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const id = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const siteRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    rootRef.current?.scrollIntoView({ block: 'nearest' })
    siteRef.current?.focus({ preventScroll: true })
  }, [])

  const normalized = siteFromInput(site)
  const siteErr = touched.site && !normalized
  const userErr = touched.username && !username.trim()
  // Required when adding; on edit a blank password keeps the stored one.
  const passErr = !edit && touched.password && !password

  const submit = async (): Promise<void> => {
    setTouched({ site: true, username: true, password: true })
    if (!normalized || !username.trim() || (!edit && !password) || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      const saved = await window.clui.browserSaveLogin({
        ...(edit ? { id: edit.id } : {}),
        site: normalized,
        username: username.trim(),
        ...(password ? { password } : {}),
        ...(seed.trim() ? { totpSeed: seed.trim() } : {})
      })
      onSaved(saved)
    } catch (e) {
      setSaving(false)
      setSaveError(e instanceof Error ? e.message : "Couldn't save the login.")
    }
  }
  const onEnter = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <div ref={rootRef} id={formId} className="my-1 flex flex-col gap-2.5 rounded-md border border-border bg-tool p-3">
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-site`} className="text-meta text-dim">
          Site
        </label>
        <input
          ref={siteRef}
          id={`${id}-site`}
          spellCheck={false}
          autoComplete="off"
          value={site}
          onChange={(e) => setSite(e.target.value)}
          onBlur={() => {
            setTouched((t) => ({ ...t, site: true }))
            if (normalized) setSite(normalized)
          }}
          onKeyDown={onEnter}
          aria-invalid={siteErr || undefined}
          aria-describedby={`${id}-site-hint`}
          className={`${LOGIN_INPUT} font-mono`}
        />
        {siteErr ? (
          <FieldError id={`${id}-site-hint`} text="Enter a site like github.com." />
        ) : (
          <p id={`${id}-site-hint`} className="text-meta text-dim">
            {normalized ? `Fills on ${normalized} only. Subdomains need their own login.` : "Enter the site's address, like github.com."}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-user`} className="text-meta text-dim">
          Username
        </label>
        <input
          id={`${id}-user`}
          autoComplete="off"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, username: true }))}
          onKeyDown={onEnter}
          aria-invalid={userErr || undefined}
          aria-describedby={userErr ? `${id}-user-err` : undefined}
          className={LOGIN_INPUT}
        />
        {userErr && <FieldError id={`${id}-user-err`} text="Enter a username." />}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-pass`} className="text-meta text-dim">
          Password
        </label>
        <div className="relative">
          <input
            id={`${id}-pass`}
            type={reveal ? 'text' : 'password'}
            autoComplete="new-password"
            spellCheck={false}
            placeholder={edit ? 'Unchanged' : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, password: true }))}
            onKeyDown={onEnter}
            aria-invalid={passErr || undefined}
            aria-describedby={passErr ? `${id}-pass-err` : undefined}
            className={`${LOGIN_INPUT} pr-9 placeholder:text-dim`}
          />
          <RevealButton pressed={reveal} onToggle={() => setReveal((r) => !r)} />
        </div>
        {passErr && <FieldError id={`${id}-pass-err`} text="Enter a password." />}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-seed`} className="text-meta text-dim">
          One-time code secret (optional)
        </label>
        <input
          id={`${id}-seed`}
          autoComplete="off"
          spellCheck={false}
          value={seed}
          onChange={(e) => setSeed(e.target.value)}
          onKeyDown={onEnter}
          aria-describedby={`${id}-seed-hint`}
          className={`${LOGIN_INPUT} font-mono`}
        />
        <p id={`${id}-seed-hint`} className="text-meta text-dim">
          The setup key from the site&apos;s authenticator screen, not a 6-digit code.
        </p>
      </div>
      <div className="flex items-center justify-end gap-2">
        {saveError && (
          <p role="alert" className="mr-auto flex items-center gap-1.5 text-meta text-err">
            <IconWarn className="h-3.5 w-3.5 shrink-0" />
            {saveError}
          </p>
        )}
        <Button variant="control" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={() => void submit()} disabled={saving}>
          Save
        </Button>
      </div>
    </div>
  )
}
