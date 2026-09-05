import { useState } from 'react'
import { useActive, useSession, EMPTY_PENDING, type PendingPermission } from '../store'
import { Button } from './Button'
import { IconShield, IconCheck } from './Icon'
import { QuestionDialog } from './QuestionDialog'
import { PlanDialog } from './PlanDialog'
import { useDialogFocus } from '../lib/useDialogFocus'
import { PERMISSION_MODE_LABELS, PERMISSION_MODE_DESCRIPTIONS } from '../../../shared/settings'
import type { PermissionModeChoice } from '../../../shared/ipc'
import type { PermissionSuggestion } from '../../../shared/events'

/** Modal shown when Claude requests permission for a gated tool call. Shows only the
 *  oldest pending request of the active session; background sessions accumulate their own. */
export function PermissionDialog(): JSX.Element | null {
  const pending = useActive((s) => s?.pendingPermissions ?? EMPTY_PENDING)
  const activeHandleId = useSession((s) => s.activeHandleId)
  const current = pending[0]
  if (!current) return null

  // Keyed by session handle + request id so a new request mounts clean: no armed quick-action,
  // prior answers, or focus-on-Allow can survive from the one before it.
  const key = `${activeHandleId ?? ''}:${current.requestId}`

  // AskUserQuestion fires can_use_tool with requires_user_interaction even in bypass mode.
  // Route to a dedicated picker, not the Allow/Deny dialog.
  if (current.toolName === 'AskUserQuestion') {
    return <QuestionDialog key={key} request={current} />
  }

  // ExitPlanMode is a decision to approve the plan, not a raw grant; renders the plan.
  if (current.toolName === 'ExitPlanMode') {
    return <PlanDialog key={key} request={current} />
  }

  return <GenericPermission key={key} request={current} queued={pending.length - 1} />
}

/** Allow/Deny body for a generic gated tool. Keyed per request so consent state is per-request. */
function GenericPermission({
  request,
  queued
}: {
  request: PendingPermission
  queued: number
}): JSX.Element {
  const respond = useSession((s) => s.respondPermission)
  const setPermissionMode = useSession((s) => s.setPermissionMode)
  // Focus the container, not a button: announces the dialog without pre-selecting Allow/Deny.
  const dialogRef = useDialogFocus<HTMLDivElement>()
  // Arms the "also switch mode" quick action; plain Allow stays a one-off.
  const [armed, setArmed] = useState(false)

  const allow = (): void => {
    void respond({ requestId: request.requestId, behavior: 'allow', updatedInput: request.input })
  }
  const deny = (): void => {
    void respond({
      requestId: request.requestId,
      behavior: 'deny',
      message: 'The user denied this action.'
    })
  }
  // Session-scoped mode switch. setPermissionMode is per-session, so a project- or
  // user-scoped suggestion would under-apply.
  const suggestion = pickModeSuggestion(request.permissionSuggestions)
  const allowAndSwitch = (): void => {
    void respond({ requestId: request.requestId, behavior: 'allow', updatedInput: request.input })
    if (suggestion) void setPermissionMode(suggestion.mode)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="permission-title"
        className="w-[min(560px,90%)] rounded-xl border border-border bg-bg-elev shadow-lg outline-none"
      >
        <div className="border-b border-border px-5 py-3.5">
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.14em] text-warn">
            <IconShield className="h-3.5 w-3.5" />
            Permission required
          </div>
          <div id="permission-title" className="mt-1.5 font-serif text-lg font-semibold text-content">
            Allow <span className="text-accent">{request.displayName || request.toolName}</span>?
          </div>
        </div>

        <div className="max-h-[45vh] overflow-y-auto px-5 py-4">
          {request.description && (
            <p className="mb-3 text-sm text-dim">{request.description}</p>
          )}
          <PermissionInput toolName={request.toolName} input={request.input} />
          {queued > 0 && (
            <div className="mt-3 text-xs text-dim">
              +{queued} more request{queued > 1 ? 's' : ''} queued
            </div>
          )}
        </div>

        {/* Trust-critical: Deny is equal-size and nothing is autofocused, so a reflexive Enter
            can't grant a write/exec. Quick action only arms; plain Allow stays a one-off. */}
        <div
          className={`flex items-center gap-3 border-t border-border px-5 py-3 ${
            suggestion ? 'justify-between' : 'justify-end'
          }`}
        >
          {suggestion && (
            <button
              type="button"
              role="checkbox"
              aria-checked={armed}
              aria-describedby="perm-quickaction-desc"
              onClick={() => setArmed((v) => !v)}
              className="group flex items-start gap-2 rounded-md py-1 pr-1 text-left"
            >
              <span
                className={`mt-px flex h-4 w-4 flex-none items-center justify-center rounded-[4px] border transition-colors duration-150 ${
                  armed
                    ? 'border-warn bg-warn/15 text-warn'
                    : 'border-control-edge text-transparent group-hover:border-warn'
                }`}
              >
                <IconCheck className="h-3 w-3" />
              </span>
              <span>
                <span className="block text-[13px] leading-tight text-content">
                  Also switch to {suggestion.label} for this session
                </span>
                <span id="perm-quickaction-desc" className="mt-0.5 block text-[11px] leading-tight text-faint">
                  {suggestion.description}
                </span>
              </span>
            </button>
          )}
          <div className="flex flex-none gap-2">
            <Button
              variant="secondary"
              size="md"
              onClick={deny}
              className="border-control-edge hover:border-err hover:text-err"
            >
              Deny
            </Button>
            <Button variant="primary" size="md" onClick={armed && suggestion ? allowAndSwitch : allow}>
              Allow
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** First session-scoped setMode suggestion for a known mode, else null. Broader scopes can't
 *  apply to a per-session mode; the known-mode check avoids "switch to undefined". */
function pickModeSuggestion(
  suggestions?: PermissionSuggestion[]
): { mode: PermissionModeChoice; label: string; description: string } | null {
  for (const s of suggestions ?? []) {
    if (s.type === 'setMode' && s.destination === 'session' && s.mode && s.mode in PERMISSION_MODE_LABELS) {
      const mode = s.mode as PermissionModeChoice
      return { mode, label: PERMISSION_MODE_LABELS[mode], description: PERMISSION_MODE_DESCRIPTIONS[mode] }
    }
  }
  return null
}

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
