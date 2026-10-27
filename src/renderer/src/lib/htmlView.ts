import type { HtmlBlocked, HtmlPolicy } from '../../../shared/html-view'

/** The policy line's parts, shown joined by `·`. */
export function policyParts(p: HtmlPolicy, changedSince: boolean): string[] {
  if (!p.artifact) return ['Runs offline', 'Only files in this folder']
  return [changedSince ? 'Made by Claude, changed since' : 'Made by Claude', `Web resources ${p.remote ? 'on' : 'off'}`, `Data requests ${p.data ? 'on' : 'off'}`]
}

export type BlockedCause = 'remote' | 'data' | 'eval' | 'offline'

/** The one blocked-content row a load earns, first match wins. `count` is blocked loads, not hosts. */
export function blockedRow(p: HtmlPolicy, b: HtmlBlocked): { cause: BlockedCause; count: number } | null {
  if (p.artifact && !p.remote && b.remote) return { cause: 'remote', count: b.remote }
  if (p.artifact && !p.data && b.data) return { cause: 'data', count: b.data }
  if (b.eval) return { cause: 'eval', count: 0 }
  if (!p.artifact && b.remote + b.data) return { cause: 'offline', count: b.remote + b.data }
  return null
}

export const SELF_HOST = 'this folder'

/** An origin as the strip names it. HTTPS is the expected case, so only another scheme is worth reading. */
export const hostLabel = (h: string): string => (h === 'self' ? SELF_HOST : h.replace(/^https:\/\//, ''))

/** The first two origins, read as `a and b` or `a, b and N more`. */
export function hostsOf(hosts: readonly string[]): { shown: string[]; sep: string; rest: string } {
  const shown = hosts.slice(0, 2).map(hostLabel)
  const more = hosts.length - shown.length
  return { shown, sep: more ? ', ' : ' and ', rest: more ? ` and ${more} more` : '' }
}

export type NoticeKind = 'changed' | 'stuck' | 'blocked'

/** One strip at a time: an outside change outranks a stuck page, which outranks blocked content. */
export function noticeOf(s: { changed: boolean; stuck: boolean; blocked: boolean }): NoticeKind | null {
  return s.changed ? 'changed' : s.stuck ? 'stuck' : s.blocked ? 'blocked' : null
}
