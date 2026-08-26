/**
 * Plan decision dialog: the model's ExitPlanMode request. The CLI surfaces it as a
 * can_use_tool with requires_user_interaction (like AskUserQuestion), so PermissionDialog
 * routes it here rather than into the generic Allow/Deny box, which would bury the plan as
 * escaped JSON and frame a decision as a raw permission grant. The plan markdown is in-band
 * on request.input.plan; we render it and offer proceed vs keep-planning, mapped to allow
 * vs deny(+message). request.input.planFilePath (~/.claude/plans) is ignored: Clui reads
 * the plan from the wire, never from disk.
 */
import { useCallback } from 'react'
import { useActive, useSession, type PendingPermission } from '../store'
import { useEscape } from '../lib/useEscape'
import { useDialogFocus } from '../lib/useDialogFocus'
import { Button } from './Button'
import { Markdown } from './Markdown'
import { IconChecklist } from './Icon'

export function PlanDialog({ request }: { request: PendingPermission }): JSX.Element {
  const respond = useSession((s) => s.respondPermission)
  const queued = useActive((s) => (s?.pendingPermissions.length ?? 1) - 1)
  const dialogRef = useDialogFocus<HTMLDivElement>()

  const input = (request.input ?? {}) as { plan?: unknown }
  const plan = typeof input.plan === 'string' ? input.plan.trim() : ''

  const startBuilding = useCallback(() => {
    void respond({ requestId: request.requestId, behavior: 'allow', updatedInput: request.input })
  }, [respond, request.requestId, request.input])

  const keepPlanning = useCallback(() => {
    void respond({
      requestId: request.requestId,
      behavior: 'deny',
      message:
        "The user hasn't approved the plan and wants to keep refining it. Stay in plan mode and wait for their next message."
    })
  }, [respond, request.requestId])

  // Esc maps to the safe branch only (keep planning) and can never reach "Start building",
  // so unlike the generic permission dialog (which stays click-only) there's no ambiguity.
  useEscape(true, keepPlanning)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="plan-title"
        className="flex max-h-[80vh] w-[min(720px,94%)] flex-col rounded-xl border border-border bg-bg-elev shadow-lg outline-none"
      >
        <div className="border-b border-border px-5 py-3.5">
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.14em] text-info">
            <IconChecklist className="h-3.5 w-3.5" />
            Plan mode
          </div>
          <div id="plan-title" className="mt-1.5 font-serif text-lg font-semibold text-content">
            Review the plan
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {plan ? (
            <Markdown text={plan} headingScale="compact" />
          ) : (
            <div className="flex flex-col gap-2">
              <div className="text-sm text-dim">
                Claude didn’t attach a readable plan. You can start building anyway, or keep planning.
              </div>
              <details className="text-xs">
                <summary className="cursor-pointer text-dim">Raw request</summary>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-bg p-2 font-mono text-xs text-dim">
                  {JSON.stringify(request.input, null, 2)}
                </pre>
              </details>
            </div>
          )}
          {queued > 0 && (
            <div className="mt-3 text-xs text-dim">
              +{queued} more request{queued > 1 ? 's' : ''} queued
            </div>
          )}
        </div>

        {/* Safe action (Keep planning) is DOM-first so the first Tab lands on it, and nothing
            is autofocused. Approving a plan is the consequential action, so Enter stays inert
            on the container (no Enter-to-primary bind), and a reflexive keypress can't start work. */}
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="secondary" size="md" onClick={keepPlanning}>
            Keep planning
          </Button>
          <Button variant="primary" size="md" onClick={startBuilding}>
            Start building
          </Button>
        </div>
      </div>
    </div>
  )
}
