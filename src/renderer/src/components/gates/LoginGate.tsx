import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { useSession, type PendingPermission } from '../../store'
import type { LoginRequest } from '../../../../shared/browser'
import { Button } from '../Button'
import { IconCheck, IconLock } from '../Icon'
import { FieldError, LOGIN_INPUT, RevealButton } from '../LoginFields'
import { GateFrame, type GateCount } from './GateFrame'

function requestOf(input: unknown): LoginRequest | null {
  const r = input as Partial<LoginRequest> | null
  if (r?.kind === 'save' && typeof r.site === 'string') return { kind: 'save', site: r.site }
  if (r?.kind === 'choose' && typeof r.site === 'string' && Array.isArray(r.usernames))
    return { kind: 'choose', site: r.site, usernames: r.usernames.filter((u): u is string => typeof u === 'string') }
  return null
}

/** Claude asked Clui to sign in. The user picks or saves the login; the model never sees it. */
export function LoginGate({ request, count }: { request: PendingPermission; count: GateCount }): JSX.Element {
  const respond = useSession((s) => s.respondBrowserLogin)
  const req = requestOf(request.input)
  const decline = (): void => void respond(request.requestId, { action: 'decline' })
  if (req?.kind === 'choose') return <ChooseLogin req={req} requestId={request.requestId} count={count} onDecline={decline} />
  return <SaveLogin site={req?.site ?? request.displayName ?? ''} requestId={request.requestId} count={count} onDecline={decline} />
}

const KICKER = 'Sign-in needed'
const kickerIcon = <IconLock className="h-3.5 w-3.5" />

function ChooseLogin({
  req,
  requestId,
  count,
  onDecline
}: {
  req: Extract<LoginRequest, { kind: 'choose' }>
  requestId: string
  count: GateCount
  onDecline: () => void
}): JSX.Element {
  const respond = useSession((s) => s.respondBrowserLogin)
  const [picked, setPicked] = useState(0)
  // The request carries usernames only, so the ids come from the vault's own list for the site.
  const [ids, setIds] = useState<Record<string, string>>({})
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([])
  useEffect(() => {
    let live = true
    void window.clui.browserListLogins().then((all) => {
      if (live) setIds(Object.fromEntries(all.filter((l) => l.site === req.site).map((l) => [l.username, l.id])))
    })
    return () => {
      live = false
    }
  }, [req.site])
  const loginId = ids[req.usernames[picked] ?? '']

  const onKey = (e: KeyboardEvent): void => {
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0
    if (!step || req.usernames.length === 0) return
    e.preventDefault()
    const next = (picked + step + req.usernames.length) % req.usernames.length
    setPicked(next)
    rowRefs.current[next]?.focus()
  }

  return (
    <GateFrame
      icon={kickerIcon}
      kicker={KICKER}
      title={`Which login for ${req.site}?`}
      count={count}
      footer={
        <div className="ml-auto flex flex-none gap-2">
          <Button data-ui="gate-secondary" variant="control" size="md" onClick={onDecline}>
            Not now
          </Button>
          <Button
            data-ui="gate-primary"
            variant="primary"
            size="md"
            disabled={!loginId}
            onClick={() => loginId && void respond(requestId, { action: 'fill', loginId })}
          >
            Fill
          </Button>
        </div>
      }
    >
      <div role="radiogroup" aria-label={`Saved logins for ${req.site}`} className="flex flex-col gap-1.5 pb-1" onKeyDown={onKey}>
        {req.usernames.map((u, i) => (
          <button
            key={u}
            ref={(el) => (rowRefs.current[i] = el)}
            type="button"
            role="radio"
            aria-checked={i === picked}
            tabIndex={i === picked ? 0 : -1}
            onClick={() => setPicked(i)}
            className={`flex items-center gap-2.5 rounded-md border bg-tool px-3 py-2 text-left transition-colors ${
              i === picked ? 'border-content' : 'border-border hover:border-border-strong hover:bg-bg-raised'
            }`}
          >
            <span className="min-w-0 flex-1 truncate text-ui text-content">{u}</span>
            {i === picked && <IconCheck className="h-3.5 w-3.5 shrink-0 text-content" />}
          </button>
        ))}
      </div>
    </GateFrame>
  )
}

/** No saved login for the site. The fields live in this component's state only: the password
 *  crosses to main once, in the verdict, and never touches the store. */
function SaveLogin({
  site,
  requestId,
  count,
  onDecline
}: {
  site: string
  requestId: string
  count: GateCount
  onDecline: () => void
}): JSX.Element {
  const respond = useSession((s) => s.respondBrowserLogin)
  const [available, setAvailable] = useState<boolean | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [seed, setSeed] = useState('')
  const [reveal, setReveal] = useState(false)
  const [touched, setTouched] = useState({ username: false, password: false })
  const id = useId()
  const descId = `${id}-desc`
  const userErrId = `${id}-user-err`
  const passErrId = `${id}-pass-err`
  const seedHintId = `${id}-seed-hint`

  useEffect(() => {
    let live = true
    void window.clui.browserVaultAvailable().then((ok) => live && setAvailable(ok))
    return () => {
      live = false
    }
  }, [])

  const userErr = touched.username && !username.trim()
  const passErr = touched.password && !password
  const self = (): void => void respond(requestId, { action: 'self' })
  const submit = (): void => {
    setTouched({ username: true, password: true })
    if (!username.trim() || !password) return
    const s = seed.trim()
    void respond(requestId, { action: 'save', username: username.trim(), password, ...(s ? { totpSeed: s } : {}) })
  }
  // Enter is a deliberate key inside a field the user is typing into, so it submits once both are filled.
  const onEnter = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && username.trim() && password) {
      e.preventDefault()
      submit()
    }
  }

  const title = (
    <>
      Save a login for <span className="font-mono">{site}</span>?
    </>
  )

  if (available === false) {
    return (
      <GateFrame
        icon={kickerIcon}
        kicker={KICKER}
        title={title}
        count={count}
        footer={
          <div className="ml-auto flex flex-none gap-2">
            <Button data-ui="gate-secondary" variant="control" size="md" onClick={onDecline}>
              Not now
            </Button>
            <Button variant="control" size="md" onClick={self}>
              Sign in myself
            </Button>
          </div>
        }
      >
        <p className="pb-1 text-ui text-dim">Saved logins need macOS Keychain access, which isn&apos;t available right now.</p>
      </GateFrame>
    )
  }

  return (
    <GateFrame
      icon={kickerIcon}
      kicker={KICKER}
      title={title}
      count={count}
      describedBy={descId}
      footer={
        <div className="ml-auto flex flex-none gap-2">
          <Button data-ui="gate-secondary" variant="control" size="md" onClick={onDecline}>
            Not now
          </Button>
          <Button variant="control" size="md" onClick={self}>
            Sign in myself
          </Button>
          <Button data-ui="gate-primary" variant="primary" size="md" onClick={submit} disabled={available === null}>
            Save and fill
          </Button>
        </div>
      }
    >
      <p id={descId} className="mb-3 text-ui text-dim">
        Claude asked Clui to sign in. Clui fills the page itself; Claude never sees the password.
      </p>
      <div className="mb-1 flex flex-col gap-2.5 rounded-md bg-tool p-3">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-user`} className="text-meta text-dim">
            Username
          </label>
          <input
            id={`${id}-user`}
            autoComplete="username"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, username: true }))}
            onKeyDown={onEnter}
            aria-invalid={userErr || undefined}
            aria-describedby={userErr ? userErrId : undefined}
            className={LOGIN_INPUT}
          />
          {userErr && <FieldError id={userErrId} text="Enter a username" />}
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-pass`} className="text-meta text-dim">
            Password
          </label>
          <div className="relative">
            <input
              id={`${id}-pass`}
              type={reveal ? 'text' : 'password'}
              autoComplete="current-password"
              spellCheck={false}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, password: true }))}
              onKeyDown={onEnter}
              aria-invalid={passErr || undefined}
              aria-describedby={passErr ? passErrId : undefined}
              className={`${LOGIN_INPUT} pr-9`}
            />
            <RevealButton pressed={reveal} onToggle={() => setReveal((r) => !r)} />
          </div>
          {passErr && <FieldError id={passErrId} text="Enter a password" />}
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
            aria-describedby={seedHintId}
            className={`${LOGIN_INPUT} font-mono`}
          />
          <p id={seedHintId} className="text-meta text-dim">
            The setup key from the site&apos;s authenticator screen, not a 6-digit code.
          </p>
        </div>
      </div>
    </GateFrame>
  )
}
