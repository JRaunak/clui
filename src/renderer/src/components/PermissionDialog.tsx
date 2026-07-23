import { useActive, useSession, EMPTY_PENDING, type PendingPermission } from '../store'
import { Button } from './Button'
import { IconShield } from './Icon'
import { QuestionDialog } from './QuestionDialog'

/**
 * Modal shown when Claude requests permission for a gated tool call.
 * Only the oldest pending request of the ACTIVE session is shown; answering it
 * reveals the next. Background sessions accumulate their own requests (badged in
 * the sidebar) — this never steals focus to a background session's prompt.
 */
export function PermissionDialog(): JSX.Element | null {
  const pending = useActive((s) => s?.pendingPermissions ?? EMPTY_PENDING)
  const respond = useSession((s) => s.respondPermission)
  const current = pending[0]
  if (!current) return null

  // AskUserQuestion isn't a permission — it's a question needing an answer (it
  // fires can_use_tool with requires_user_interaction even in bypass mode). Route
  // it to a dedicated picker instead of the wrong Allow/Deny dialog.
  if (current.toolName === 'AskUserQuestion') {
    return <QuestionDialog request={current} />
  }

  const allow = (): void => {
    void respond({ requestId: current.requestId, behavior: 'allow', updatedInput: current.input })
  }
  const deny = (): void => {
    void respond({
      requestId: current.requestId,
      behavior: 'deny',
      message: 'The user denied this action.'
    })
  }

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-[min(560px,90%)] rounded-xl border border-border bg-bg-elev shadow-lg">
        <div className="border-b border-border px-5 py-3.5">
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.14em] text-warn">
            <IconShield className="h-3.5 w-3.5" />
            Permission required
          </div>
          <div className="mt-1.5 font-serif text-lg font-semibold text-content">
            Allow <span className="text-accent">{current.displayName || current.toolName}</span>?
          </div>
        </div>

        <div className="max-h-[45vh] overflow-y-auto px-5 py-4">
          {current.description && (
            <p className="mb-3 text-sm text-dim">{current.description}</p>
          )}
          <PermissionInput toolName={current.toolName} input={current.input} />
          {pending.length > 1 && (
            <div className="mt-3 text-xs text-dim">
              +{pending.length - 1} more request{pending.length - 1 > 1 ? 's' : ''} queued
            </div>
          )}
        </div>

        {/* Trust-critical gate: the safe action (Deny) gets an equal-weight,
            clearly-bordered button and NOTHING is auto-focused, so a reflexive
            Enter can't grant a write/exec. The user must aim at Allow deliberately. */}
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button
            variant="secondary"
            size="md"
            onClick={deny}
            className="border-border-strong hover:border-err hover:text-err"
          >
            Deny
          </Button>
          <Button variant="primary" size="md" onClick={allow}>
            Allow
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Render the most relevant part of the tool input prominently, plus full JSON. */
function PermissionInput({
  toolName,
  input
}: Pick<PendingPermission, 'toolName' | 'input'>): JSX.Element {
  const highlight = highlightOf(input)
  return (
    <div className="flex flex-col gap-2">
      {highlight && (
        <div className="rounded-md border border-border bg-bg px-3 py-2">
          <div className="text-[12px] uppercase tracking-wide text-dim">{highlight.label}</div>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[14px] text-content">
            {highlight.value}
          </pre>
        </div>
      )}
      <details className="text-xs">
        <summary className="cursor-pointer text-dim">Full input ({toolName})</summary>
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-bg p-2 font-mono text-xs text-dim">
          {JSON.stringify(input, null, 2)}
        </pre>
      </details>
    </div>
  )
}

/** Pick the field a human most needs to see to make the decision. */
function highlightOf(input: unknown): { label: string; value: string } | null {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>
    if (typeof o.command === 'string') return { label: 'Command', value: o.command }
    if (typeof o.file_path === 'string') {
      const extra = typeof o.content === 'string' ? `\n\n${truncate(o.content, 600)}` : ''
      return { label: 'File', value: o.file_path + extra }
    }
    if (typeof o.path === 'string') return { label: 'Path', value: o.path }
    if (typeof o.url === 'string') return { label: 'URL', value: o.url }
  }
  return null
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s
}
