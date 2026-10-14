import { useCallback, useEffect, useId, useMemo, useRef, type KeyboardEvent } from 'react'
import { activeSlice, useActive, useSession, type SurfaceSpec } from '../../store'
import { paneItems, type PaneItem, type PaneItemKey } from '../../lib/paneItems'
import { requestSurfaceFocus } from '../../lib/surfaceFocus'
import { useEscape } from '../../lib/useEscape'
import { usePane } from '../Stage'
import { openFilePalette } from '../CommandPalette'
import { IconAgentBrowser, IconDiff, IconFolder, IconSearch } from '../Icon'

const GLYPH: Record<PaneItemKey, (p: { className?: string }) => JSX.Element> = {
  'open-file': IconSearch,
  tree: IconFolder,
  changes: IconDiff,
  browser: IconAgentBrowser
}

export interface PaneEntry extends PaneItem {
  Glyph: (p: { className?: string }) => JSX.Element
  run: () => void
}

const focusAddress = (): void => document.querySelector<HTMLElement>('[data-ui="browser-url"]')?.focus()

/** A new browser tab, with focus on its address bar. */
async function openBrowserTab(): Promise<void> {
  focusAddress()
  await useSession.getState().newBrowserTab()
  // From another kind, the address only exists once the new tab's surface has mounted.
  requestAnimationFrame(focusAddress)
}

/** Creates or activates a singleton and puts focus in it. One already on screen mounts nothing that would take
 *  the focus, so it's given here. */
function openSingleton(spec: SurfaceSpec & { kind: 'tree' | 'diff' }): void {
  const st = useSession.getState()
  const slice = activeSlice(st)
  if (!slice) return
  const shown = slice.paneOpen && !st.viewingSubagent && slice.surfaces.active === spec.kind
  if (!shown) requestSurfaceFocus(spec.kind)
  st.openSurface(slice.handleId, spec, 'focus', 'user', 'user')
  if (shown) document.querySelector<HTMLElement>('[data-ui="pane-secondary"] [data-pane-title]')?.focus()
}

function run(key: PaneItemKey, cwd: string): void {
  switch (key) {
    case 'open-file':
      return openFilePalette()
    case 'tree':
      return openSingleton({ kind: 'tree', key: '', title: cwd.slice(cwd.lastIndexOf('/') + 1) || cwd })
    case 'changes':
      return openSingleton({ kind: 'diff', key: '', title: 'Claude changes' })
    case 'browser':
      return void openBrowserTab()
  }
}

/** The one list the empty pane and the "+" menu both show. */
export function usePaneEntries(): PaneEntry[] {
  const cwd = useActive((s) => s?.cwd ?? null)
  const changes = useActive((s) => s?.changes.length ?? 0)
  const browser = useActive((s) => !!s?.browser)
  return useMemo(
    () => (cwd ? paneItems({ cwd, home: window.clui.homeDir, changes, browser }).map((it) => ({ ...it, Glyph: GLYPH[it.key], run: () => run(it.key, cwd) })) : []),
    [cwd, changes, browser]
  )
}

/** The pane with no tabs: what it can open, as a flat list. */
export function PanePicker(): JSX.Element {
  const entries = usePaneEntries()
  const pane = usePane()
  const headingId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const hide = useCallback(() => useSession.getState().togglePane(), [])
  useEscape(pane.escapeActive, hide)

  // Opening the pane focuses row 1 through SurfacePane. Closing the last tab drops focus to the body, so it lands
  // here instead.
  useEffect(() => {
    const el = document.activeElement
    if (!useSession.getState().paneOpenedQuietly && (!el || el === document.body)) listRef.current?.querySelector<HTMLElement>('button')?.focus()
  }, [])

  const onKeyDown = (e: KeyboardEvent): void => {
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('button') ?? [])]
    const i = rows.indexOf(document.activeElement as HTMLElement)
    const n = rows.length
    const to = { ArrowDown: (i + 1) % n, ArrowUp: (i - 1 + n) % n, Home: 0, End: n - 1 }[e.key]
    if (to === undefined || i < 0 || e.metaKey || e.ctrlKey || e.altKey) return
    e.preventDefault()
    rows[to]?.focus()
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg pt-(--top-h)">
      <div data-ui="pane-picker" data-beside-header="" className="flex h-full min-h-0 flex-col items-center overflow-y-auto px-6 py-10">
        <div className="my-auto w-full max-w-[320px]">
          <h2 id={headingId} className="px-3 pb-1.5 text-label font-medium text-dim">
            Open in pane
          </h2>
          <div ref={listRef} role="group" aria-labelledby={headingId} onKeyDown={onKeyDown}>
            {entries.map((it, i) => (
              <button
                key={it.key}
                type="button"
                data-item={it.key}
                {...(i === 0 ? { 'data-pane-title': '' } : {})}
                aria-description={it.description}
                aria-keyshortcuts={it.keys}
                onClick={it.run}
                className="relative flex h-9 w-full items-center gap-2.5 rounded-md px-3 text-left text-label text-content -outline-offset-2 pointer-fine:hover:bg-control-hover focus-visible:bg-control-hover"
              >
                <it.Glyph className="h-3.5 w-3.5 shrink-0 text-dim" />
                <span className="min-w-0 flex-1 truncate">{it.label}</span>
                {it.meta && (
                  <span aria-hidden="true" title={it.meta} className={`min-w-0 max-w-[55%] truncate text-meta text-dim ${it.mono ? 'font-mono' : ''}`}>
                    {it.meta}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
