import type { MouseEvent } from 'react'
import { create } from 'zustand'
import type { LinkTarget } from '../../../shared/settings'
import { activeSlice, useActive, useSession } from '../store'
import { urlSpans } from './urlSpans'

/** Neutral, not accent: accent text fails body contrast on the light card, and accent is kept scarce. */
export const LINK =
  'rounded-sm text-content underline decoration-[var(--color-dim)] underline-offset-2 pointer-fine:hover:decoration-[var(--color-content)]'

/** The "Open links in" setting, mirrored so a link's title can name where it opens without reading settings per render. */
export const useLinkTarget = create<{ target: LinkTarget }>(() => ({ target: 'clui' }))
void window.clui.getSettings().then(
  ({ values }) => useLinkTarget.setState({ target: values.linkTarget }),
  () => {}
)

export const LINK_MOD = window.clui.isMac ? '⌘' : 'Ctrl'
const isWeb = (href: string): boolean => /^https?:\/\//i.test(href)
let announceSeq = 0

/** Where a plain click goes, and the modifier for the other way when there is one. */
export function linkTitle(href: string, hasBrowser: boolean, target: LinkTarget): string {
  if (!hasBrowser || !isWeb(href)) return 'Opens in your default browser.'
  return target === 'clui'
    ? `Opens in Clui's browser. ${LINK_MOD}-click for default browser.`
    : `Opens in your default browser. ${LINK_MOD}-click for Clui's browser.`
}

/** A web link goes to a new tab of this session's browser, so Claude's tab is never taken; anything else, or a
 *  session without the browser, goes to the default browser. The modifier flips it for one click. */
export async function openLink(href: string, invert: boolean): Promise<void> {
  const s = useSession.getState()
  const active = activeSlice(s)
  const inClui = !!active?.browser && isWeb(href) && (useLinkTarget.getState().target === 'clui') !== invert
  if (!active || !inClui) return void window.clui.openExternal(href)
  try {
    const tab = await window.clui.browserNewTab(active.handleId)
    await window.clui.browserNavigate(active.handleId, tab, href)
  } catch {
    return void window.clui.openExternal(href)
  }
  if (!active.browserOpen) s.setBrowserPane(s.browserPaneFull ? 'full' : 'half')
  useSession.setState({ browserAnnounce: `Opened in Clui's browser${'\u200b'.repeat(++announceSeq % 2)}` })
}

/** Click and keyboard handlers for an anchor that routes through openLink. A middle click would open an Electron window. */
export function linkHandlers(href: string): { onClick: (e: MouseEvent) => void; onAuxClick: (e: MouseEvent) => void } {
  return {
    onClick: (e) => {
      e.preventDefault()
      void openLink(href, e.metaKey || e.ctrlKey)
    },
    onAuxClick: (e) => e.preventDefault()
  }
}

/** Plain text with its http(s) URLs as links. A URL cut off by truncation stays text, since it would lead nowhere. */
export function LinkedText({ text, truncated }: { text: string; truncated: boolean }): JSX.Element {
  const hasBrowser = useActive((s) => !!s?.browser)
  const target = useLinkTarget((s) => s.target)
  const out: (string | JSX.Element)[] = []
  let last = 0
  for (const { start, end, url } of urlSpans(text, truncated)) {
    out.push(text.slice(last, start))
    out.push(
      <a key={start} href={url} className={LINK} title={linkTitle(url, hasBrowser, target)} {...linkHandlers(url)}>
        {url}
      </a>
    )
    last = end
  }
  out.push(text.slice(last))
  return <>{out}</>
}
