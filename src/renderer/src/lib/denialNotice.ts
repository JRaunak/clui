import type { DenialSource, PermissionDenial } from '../../../shared/events'
import { PERMISSION_MODE_LABELS } from '../../../shared/settings'

export type NoticeSource = Exclude<DenialSource, 'you'> | undefined

/** A safety denial never says whether its path is protected in every mode or only needs the user's
 *  approval (2.1.329). Interactive prompts for the second kind instead of denying it, so a safety
 *  denial there is the first kind; any other mode gets the hedged hint. */
export function noticeCopy(
  source: NoticeSource,
  denials: readonly PermissionDenial[],
  interactive: boolean
): { headline: string; label: string; hint?: string; reasonInHint?: true } {
  const one = denials.length === 1
  const count = one ? '1 action' : `${denials.length} actions`
  const switchTo = `switch to ${PERMISSION_MODE_LABELS.default}, then ask Claude to try again.`
  switch (source) {
    case 'safety': {
      const copy = { headline: `${count} stopped by a safety check`, label: 'Actions stopped by a safety check' }
      if (!interactive)
        return { ...copy, hint: `To approve ${one ? 'it' : 'them'} yourself, ${switchTo} Some actions stay blocked in every mode.` }
      const reason = one ? denials[0]?.reason : undefined
      if (!reason) return { ...copy, hint: `Claude Code blocks ${one ? 'this' : 'these'} in every permission mode.` }
      return { ...copy, hint: /[.!?]$/.test(reason) ? reason : `${reason}.`, reasonInHint: true }
    }
    case 'classifier':
      return {
        headline: `${count} held back by ${PERMISSION_MODE_LABELS.auto} mode`,
        label: `Actions held back by ${PERMISSION_MODE_LABELS.auto} mode`,
        hint: `To approve ${one ? 'it' : 'them'} yourself, ${switchTo}`
      }
    case 'rule':
      return { headline: `${count} blocked by your permission settings`, label: 'Actions blocked by your permission settings' }
    default:
      return { headline: `${count} blocked`, label: 'Blocked actions' }
  }
}
