/**
 * Plan decision Gate: the model's ExitPlanMode request. The CLI surfaces it as a can_use_tool
 * with requires_user_interaction (like AskUserQuestion), so GateHost routes it here instead of the
 * generic Allow/Deny body, which would bury the plan as escaped JSON. The plan markdown is read
 * in-band from request.input.plan; proceed vs keep-planning map to allow vs deny with a message.
 * planFilePath (~/.claude/plans) is ignored.
 */
import { useCallback } from 'react'
import { useSession, type PendingPermission } from '../../store'
import { Button } from '../Button'
import { Markdown } from '../Markdown'
import { IconChecklist } from '../Icon'
import { GateFrame, type GateCount } from './GateFrame'

export function PlanGate({ request, count }: { request: PendingPermission; count: GateCount }): JSX.Element {
  const respond = useSession((s) => s.respondPermission)

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

  return (
    <GateFrame
      icon={<IconChecklist className="h-3.5 w-3.5" />}
      kicker="Plan ready"
      title={plan ? 'Review the plan' : 'No plan to review'}
      count={count}
      footer={
        // The safe action comes first in DOM order and Enter isn't bound to the primary, so a
        // reflexive keypress can't start building.
        <div className="ml-auto flex gap-2">
          <Button data-ui="gate-secondary" variant={plan ? 'control' : 'primary'} size="md" onClick={keepPlanning}>
            Keep planning
          </Button>
          <Button data-ui="gate-primary" variant={plan ? 'primary' : 'control'} size="md" onClick={startBuilding}>
            {plan ? 'Start building' : 'Build without a plan'}
          </Button>
        </div>
      }
    >
      <div className="pb-1">
        {plan ? (
          // An inset reading field, set apart from the dock fill, so a long plan reads as a document.
          <div className="max-h-[40vh] overflow-y-auto rounded-md border border-border bg-tool px-4 py-3">
            <Markdown text={plan} headingScale="compact" />
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="text-sm text-dim">
              Claude didn’t attach a readable plan. You can start building anyway, or keep planning.
            </div>
            <details className="text-xs">
              <summary className="cursor-pointer text-dim">Raw request</summary>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-tool p-2 font-mono text-xs text-dim">
                {JSON.stringify(request.input, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </div>
    </GateFrame>
  )
}
