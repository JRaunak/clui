import { useId, useState, type ReactNode } from 'react'
import { useSession, type PendingPermission } from '../../store'
import type { ElicitationRequest, ElicitationResponse } from '../../../../shared/events'
import { Button } from '../Button'
import { Dropdown } from '../Dropdown'
import { IconExternal, IconMessage, IconWarn } from '../Icon'
import { FieldError, LOGIN_INPUT } from '../LoginFields'
import { GateFrame, type GateCount } from './GateFrame'
import { GateCheckbox } from './PermissionGate'
import { contentOf, fieldError, fieldsOf, initialValues, linkOf, requestOf, type ElicitField, type ElicitValues } from './elicit'

/** An MCP server, through the CLI, asks the user to finish something in the browser (url mode) or
 *  to fill a few fields (form mode). The tool call blocks until this card is answered. */
export function ElicitGate({ request, count }: { request: PendingPermission; count: GateCount }): JSX.Element {
  const respond = useSession((s) => s.respondElicitation)
  const req = requestOf(request.input)
  const answer = (r: ElicitationResponse): void => void respond(request.requestId, r)
  const server = req?.serverName || request.displayName || 'An MCP server'
  if (req?.mode === 'url') return <UrlElicit req={req} server={server} count={count} answer={answer} />
  return <FormElicit req={req} server={server} count={count} answer={answer} />
}

const KICKER = 'MCP server'

interface Props {
  server: string
  count: GateCount
  answer: (r: ElicitationResponse) => void
}

function Message({ id, server, message }: { id: string; server: string; message: string }): JSX.Element | null {
  if (!message.trim()) return null
  return (
    <div id={id} className="mb-3 text-ui">
      <span className="text-dim">From {server}: </span>
      <span className="whitespace-pre-wrap break-words text-content">{message}</span>
    </div>
  )
}

function DeclineButton({ answer }: Pick<Props, 'answer'>): JSX.Element {
  return (
    <Button data-ui="gate-secondary" variant="control" size="md" onClick={() => answer({ action: 'decline' })}>
      Decline
    </Button>
  )
}

function UrlElicit({ req, server, count, answer }: Props & { req: ElicitationRequest }): JSX.Element {
  const [opened, setOpened] = useState(false)
  const msgId = useId()
  const link = linkOf(req.url)
  // Always the default browser, never the in-app one: a sign-in needs the user's real browser session.
  const open = (): void => {
    void window.clui.openExternal(req.url ?? '')
    setOpened(true)
  }
  // The open button keeps its key across the swap, so focus stays on it as it becomes "Open again".
  const openButton = (
    <Button
      key="open"
      data-ui={opened ? undefined : 'gate-primary'}
      variant={opened ? 'control' : 'primary'}
      size="md"
      onClick={open}
    >
      {opened ? 'Open again' : 'Open in browser'}
    </Button>
  )
  return (
    <GateFrame
      icon={<IconExternal className="h-3.5 w-3.5" />}
      kicker={KICKER}
      title={
        <>
          <span className="font-mono">{server}</span> wants you to continue in your browser
        </>
      }
      count={count}
      describedBy={req.message.trim() ? msgId : undefined}
      footer={
        <div className="ml-auto flex flex-none gap-2">
          {link.scheme === 'other' ? (
            <DeclineButton answer={answer} />
          ) : opened ? (
            [
              <Button key="cancel" data-ui="gate-secondary" variant="control" size="md" onClick={() => answer({ action: 'cancel' })}>
                Cancel
              </Button>,
              openButton,
              <Button key="done" data-ui="gate-primary" variant="primary" size="md" onClick={() => answer({ action: 'accept' })}>
                Done
              </Button>
            ]
          ) : (
            [<DeclineButton key="decline" answer={answer} />, openButton]
          )}
        </div>
      }
    >
      <div className="pb-1">
        <Message id={msgId} server={server} message={req.message} />
        {link.scheme === 'other' ? (
          <p className="text-ui text-dim">This link can&apos;t be opened from Clui.</p>
        ) : (
          <div data-ui="elicit-host" className="rounded-md border border-border bg-tool px-3 py-2">
            <div className="text-caps uppercase text-dim">Opens</div>
            <div className="mt-1 break-all font-mono text-code text-content">{link.host}</div>
            {link.scheme === 'http' && (
              <div className="mt-1.5 flex items-center gap-1.5 text-meta text-warn">
                <IconWarn className="h-3.5 w-3.5 shrink-0" />
                Not encrypted (http)
              </div>
            )}
          </div>
        )}
      </div>
    </GateFrame>
  )
}

function FormElicit({ req, server, count, answer }: Props & { req: ElicitationRequest | null }): JSX.Element {
  const fields = req ? fieldsOf(req.requestedSchema) : null
  const [values, setValues] = useState<ElicitValues>(() => (fields ? initialValues(fields) : {}))
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const msgId = useId()
  const id = useId()

  const touch = (key: string): void => setTouched((t) => (t[key] ? t : { ...t, [key]: true }))
  const set = (key: string, v: string | boolean): void => setValues((cur) => ({ ...cur, [key]: v }))
  const submit = (): void => {
    if (!fields) return
    setTouched(Object.fromEntries(fields.map((f) => [f.key, true])))
    const content = contentOf(fields, values)
    if (content) answer({ action: 'accept', content })
  }

  return (
    <GateFrame
      icon={<IconMessage className="h-3.5 w-3.5" />}
      kicker={KICKER}
      title={
        <>
          <span className="font-mono">{server}</span> is asking for details
        </>
      }
      count={count}
      describedBy={req?.message.trim() ? msgId : undefined}
      footer={
        <div className="ml-auto flex flex-none gap-2">
          <DeclineButton answer={answer} />
          {fields && (
            <Button data-ui="gate-primary" variant="primary" size="md" className="whitespace-nowrap" onClick={submit}>
              Send to {server}
            </Button>
          )}
        </div>
      }
    >
      <div className="pb-1">
        {req && <Message id={msgId} server={server} message={req.message} />}
        {!fields ? (
          <p className="text-ui text-dim">This request needs fields Clui can&apos;t show yet.</p>
        ) : (
          fields.length > 0 && (
            <div className="mb-1 flex flex-col gap-2.5 rounded-md bg-tool p-3">
              {fields.map((f) => (
                <Field
                  key={f.key}
                  id={`${id}-${f.key}`}
                  field={f}
                  value={values[f.key]}
                  error={touched[f.key] ? fieldError(f, values[f.key]) : null}
                  onChange={(v) => set(f.key, v)}
                  onBlur={() => touch(f.key)}
                />
              ))}
            </div>
          )
        )}
      </div>
    </GateFrame>
  )
}

function Field({
  id,
  field: f,
  value,
  error,
  onChange,
  onBlur
}: {
  id: string
  field: ElicitField
  value: string | boolean | undefined
  error: string | null
  onChange: (v: string | boolean) => void
  onBlur: () => void
}): JSX.Element {
  const hintId = `${id}-hint`
  const errId = `${id}-err`
  const hint = f.description && (
    <p id={hintId} className="text-meta text-dim">
      {f.description}
    </p>
  )
  if (f.kind === 'boolean') {
    return (
      <GateCheckbox
        checked={value === true}
        onToggle={() => onChange(value !== true)}
        label={f.label}
        description={f.description}
        descriptionId={hintId}
      />
    )
  }
  const describedBy = [f.description ? hintId : '', error ? errId : ''].filter(Boolean).join(' ') || undefined
  const label: ReactNode = (
    <>
      {f.label}
      {f.required && ' (required)'}
    </>
  )
  const text = typeof value === 'string' ? value : ''
  return (
    <div className="flex flex-col gap-1">
      {f.kind === 'enum' ? (
        <div role="group" aria-labelledby={`${id}-label`} aria-describedby={describedBy} className="flex flex-col gap-1">
          <span id={`${id}-label`} className="text-meta text-dim">
            {label}
          </span>
          <Dropdown
            value={text}
            ariaLabel={f.label}
            options={[{ value: '', label: 'Choose one', color: 'text-dim' }, ...f.options]}
            onChange={(v) => {
              onChange(v)
              onBlur()
            }}
          />
        </div>
      ) : (
        <>
          <label htmlFor={id} className="text-meta text-dim">
            {label}
          </label>
          <input
            id={id}
            type={f.kind === 'number' ? 'number' : 'text'}
            inputMode={f.kind === 'number' ? (f.integer ? 'numeric' : 'decimal') : undefined}
            autoComplete="off"
            spellCheck={false}
            value={text}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onBlur}
            aria-invalid={!!error || undefined}
            aria-describedby={describedBy}
            className={LOGIN_INPUT}
          />
        </>
      )}
      {hint}
      {error && <FieldError id={errId} text={error} />}
    </div>
  )
}
