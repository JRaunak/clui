import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useActive, useSession } from '../store'
import { useEscape } from '../lib/useEscape'
import { useClickOutside } from '../lib/useClickOutside'
import { IconSliders, IconRefresh, IconLock, IconWarn } from './Icon'
import {
  deriveModelInfo,
  groupModels,
  supportsUltracodeToggle,
  clampEffort,
  EFFORT_LABELS,
  type EffortChoice,
  type ModelChoice,
  type ModelInfo
} from '../../../shared/settings'

/** Effort → color, matching the statusline's per-level coloring. */
const EFFORT_COLORS: Record<EffortChoice, string> = {
  low: 'text-ok',
  medium: 'text-info',
  high: 'text-warn',
  xhigh: 'text-effort-xhigh',
  max: 'text-err'
}

/** Delay before a model row's effort flyout opens on hover (ms). */
const HOVER_DELAY = 400

/** Keys that commit effort changes. Tab-in or modifier release must not silently change model/effort. */
const COMMIT_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Enter',
  ' '
])

/** Floor for the refresh spinner. A missing `aws` rejects in single-digit ms, which reads
 *  as a flicker rather than a retry; the project bans sub-400ms spinners. */
const MIN_SPIN = 350

/** Composer control: model + effort picker. Applies to THIS session only; never
 *  writes any settings file. */
export function ModelEffortPicker(): JSX.Element {
  const modelChoice = useActive((s) => s?.modelChoice ?? 'claude-opus-4-8[1m]')
  const effortChoice = useActive((s) => s?.effortChoice ?? 'high')
  const ultracode = useActive((s) => s?.ultracode ?? false)
  // While ultracode is on the CLI forces xhigh regardless of the stored effort, so the
  // chip DISPLAYS xhigh (without mutating the stored choice, which is restored when ultra
  // turns off). Effort selection is disabled while ultra is on (it's overridden).
  const displayEffort = ultracode ? 'xhigh' : effortChoice
  const setModel = useSession((s) => s.setModel)
  const setEffort = useSession((s) => s.setEffort)
  const setUltracode = useSession((s) => s.setUltracode)
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<ModelInfo[]>([])
  // Per-call, not app state: only a SUCCESSFUL list is cached in main, so a later call
  // (or the refresh button) can go live again.
  const [live, setLive] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [hover, setHover] = useState<ModelChoice | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const checkedRef = useRef<HTMLButtonElement>(null)
  // The currently-hovered row, so the portaled flyout can anchor to its rect.
  const rowRef = useRef<HTMLDivElement>(null)

  // Load the live model list once the popover first opens.
  useEffect(() => {
    if (!open || models.length) return
    window.clui.listModels().then((res) => {
      setModels(res.ids.map(deriveModelInfo))
      setLive(res.live)
    })
  }, [open, models.length])

  // Force a fresh live query (Bedrock may have gained a model, or the first query
  // hit a transient failure and returned the bundled fallback).
  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      // Awaited (not a bare setTimeout) so no timer can outlive the unmount.
      const [res] = await Promise.all([
        window.clui.listModels(true),
        new Promise((r) => setTimeout(r, MIN_SPIN))
      ])
      setModels(res.ids.map(deriveModelInfo))
      setLive(res.live)
    } finally {
      setRefreshing(false)
    }
  }

  const dismiss = useCallback(() => setOpen(false), [])
  useClickOutside(ref, open, dismiss)
  // Esc closes via the shared escape-stack (nesting-aware) and hands focus back to the
  // trigger, since the focused row unmounts with the popover and would otherwise leave
  // focus on <body>. An outside click deliberately doesn't: it would steal focus from
  // whatever the user just clicked.
  useEscape(
    open,
    useCallback(() => {
      setOpen(false)
      triggerRef.current?.focus()
    }, [])
  )

  const clearHoverTimer = (): void => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
  }
  // Open a row's flyout after a delay (cancel if the pointer moves on quickly).
  const scheduleHover = (m: ModelChoice): void => {
    clearHoverTimer()
    hoverTimer.current = setTimeout(() => setHover(m), HOVER_DELAY)
  }
  // Hide the flyout after the same delay, so the pointer has time to travel from
  // the model row to the flyout (to its right) without it vanishing.
  const scheduleHide = (): void => {
    clearHoverTimer()
    hoverTimer.current = setTimeout(() => setHover(null), HOVER_DELAY)
  }
  useEffect(() => clearHoverTimer, [])

  // Bring the checked model into view when the list opens (family grouping is preserved;
  // the current model is not hoisted, so it may sit anywhere in its family).
  useEffect(() => {
    if (open && models.length) checkedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [open, models.length])

  const curLabel = deriveModelInfo(modelChoice).label

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        className={`flex h-8 items-center gap-1.5 rounded-full px-2.5 text-xs text-content transition-colors ${
          open ? 'bg-control-hover' : 'bg-control hover:bg-control-hover'
        }`}
        onClick={() => {
          setOpen((o) => !o)
          setHover(null)
        }}
      >
        <IconSliders className="h-3.5 w-3.5 shrink-0 text-dim" />
        <span className="font-medium">{curLabel}</span>
        {/* Effort readout. While Ultra is on it's LOCKED to X-High (Ultra forces it) →
            show the value in the Ultra purple + a lock glyph, so the chip honestly
            reflects "you can't change effort here right now" without hiding the value. */}
        <span
          className={`flex items-center gap-1 font-medium ${
            ultracode ? 'text-effort-ultra' : EFFORT_COLORS[displayEffort]
          }`}
          title={
            ultracode ? 'Ultra runs at X-High — turn off Ultra to change effort' : undefined
          }
        >
          {EFFORT_LABELS[displayEffort]}
          {ultracode && <IconLock className="h-3 w-3 opacity-80" />}
        </span>
        <svg
          viewBox="0 0 12 12"
          className={`h-3 w-3 text-dim transition-transform ${open ? '' : 'rotate-180'}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 4.5 6 7.5 9 4.5" />
        </svg>
      </button>

      {open && (
        <div
          className="absolute bottom-full left-0 mb-1.5 flex max-h-[min(60vh,calc(100vh-24px))] w-[196px] flex-col rounded-xl bg-bg-elev py-1 text-xs shadow-lg"
          onMouseLeave={scheduleHide}
        >
          <div className="flex shrink-0 items-center justify-between px-3 py-1 text-[11px] uppercase tracking-wide text-dim">
            <span>{ultracode ? 'Model · Ultra needs X-High' : 'Model'}</span>
            <button
              type="button"
              className="-my-1 flex h-6 w-6 items-center justify-center rounded text-dim transition-colors hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              title={live ? 'Refresh model list from Bedrock' : 'Retry the live model query'}
              onClick={(e) => {
                e.stopPropagation()
                void refresh()
              }}
            >
              <IconRefresh className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
          {/* Own line UNDER the header, not in it: the left slot is already spoken for by
              the ultracode string. Wraps to two lines at w-[180px]; shrinking it below the
              meta size would fail the contrast/size floor. */}
          {!live && (
            <div
              className="flex shrink-0 items-start gap-1 px-3 pb-1 text-[11px] text-warn"
              title="Couldn't reach Bedrock. This is Clui's built-in list and may be missing newer models. Refresh to retry."
            >
              <IconWarn className="mt-px h-3 w-3 shrink-0" />
              <span>Built-in list, may be incomplete</span>
            </div>
          )}
          {models.length === 0 && <div className="px-3 py-2 text-dim">Loading models…</div>}
          {/* Grouped by family (version-desc within each) so 13 near-identically-named
              models aren't a flat interleaved wall. Purely a display transform over the
              LIVE list, nothing filtered or hardcoded (groupModels buckets unknowns too). */}
          <div className="min-h-0 flex-1 overflow-y-auto">
          {groupModels(models).map((group) => (
            <div key={group.family}>
              {/* One subtle section header per family; skip when there's a single group
                  (no grouping value if everything is one family). */}
              {groupModels(models).length > 1 && (
                <div className="px-3 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-faint">
                  {group.label}
                </div>
              )}
              {group.models.map((info) => {
            // While Ultra is on, a model without X-High can't run it. Show it
            // DISABLED-WITH-REASON (not hidden, since hiding is the disappearing-menu
            // anti-pattern) so the user keeps their map + learns the rule.
            const incompatible = ultracode && !supportsUltracodeToggle(info.id)
            if (incompatible) {
              return (
                <div
                  key={info.id}
                  aria-disabled="true"
                  title="Ultra needs a model with X-High reasoning"
                  className="flex w-full cursor-default items-center gap-2 px-3 py-2 text-left text-faint opacity-60"
                >
                  <span className="w-3 shrink-0">{info.id === modelChoice ? '✓' : ''}</span>
                  <span className="min-w-0 flex-1 truncate">{info.label}</span>
                  <span className="shrink-0 font-mono text-[10px] text-faint">Needs X-High</span>
                </div>
              )
            }
            // Effort is not selectable while Ultra is on (it's forced to X-High), so the
            // per-model flyout is suppressed, so the row just switches the model.
            const effortSelectable = !ultracode
            return (
              <div
                key={info.id}
                ref={hover === info.id ? rowRef : null}
                className="relative"
                onMouseEnter={() => effortSelectable && scheduleHover(info.id)}
              >
                {/* Two click regions (dropdown contract: selecting an item closes the
                    menu). Clicking the MODEL NAME switches the model AND closes, a
                    complete action, no forced effort step. Effort is an OPTIONAL
                    refinement via the ▶ chevron (click to open the flyout, also opens
                    on hover) so it stays reachable by both click + keyboard without
                    gating the common case. */}
                <div className="flex w-full items-center text-content hover:bg-row-hover">
                  <button
                    type="button"
                    ref={info.id === modelChoice ? checkedRef : undefined}
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    onClick={() => {
                      if (info.id !== modelChoice) void setModel(info.id)
                      clearHoverTimer()
                      setOpen(false)
                      // The clicked row unmounts with the menu; hand focus back to the
                      // trigger so keyboard order isn't dropped to <body>.
                      triggerRef.current?.focus()
                    }}
                  >
                    <span className="w-3 shrink-0 text-accent">
                      {info.id === modelChoice ? '✓' : ''}
                    </span>
                    <span className="flex-1 truncate">{info.label}</span>
                  </button>
                  {/* Chevron = explicit "adjust effort" affordance (only meaningful when
                      effort is selectable; hidden while Ultra locks it to X-High). */}
                  {effortSelectable && (
                    <button
                      type="button"
                      className="flex shrink-0 items-center py-2 pr-3 pl-1 text-dim transition-colors hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      title={`Adjust effort · ${info.label}`}
                      aria-label={`Adjust effort for ${info.label}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        clearHoverTimer()
                        setHover((h) => (h === info.id ? null : info.id))
                      }}
                    >
                      <svg
                        viewBox="0 0 12 12"
                        className="h-3 w-3"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M4.5 3 7.5 6 4.5 9" />
                      </svg>
                    </button>
                  )}
                </div>

                {effortSelectable && hover === info.id && (
                  <EffortFlyout
                    info={info}
                    anchorRef={rowRef}
                    current={info.id === modelChoice ? effortChoice : clampEffort(info.id, effortChoice)}
                    onEnter={clearHoverTimer}
                    onLeave={scheduleHide}
                    onPick={(ef) => {
                      if (info.id !== modelChoice) void setModel(info.id)
                      // Explicitly picking an effort while Ultra is on means the user
                      // wants that reasoning level → turn Ultra OFF (it forces xhigh).
                      if (ultracode) void setUltracode(false)
                      void setEffort(ef)
                      setOpen(false)
                      triggerRef.current?.focus()
                    }}
                  />
                )}
              </div>
            )
              })}
            </div>
          ))}
          </div>
        </div>
      )}
    </div>
  )
}

function EffortFlyout({
  info,
  anchorRef,
  current,
  onEnter,
  onLeave,
  onPick
}: {
  info: ModelInfo
  anchorRef: React.RefObject<HTMLElement>
  current: EffortChoice
  onEnter: () => void
  onLeave: () => void
  onPick: (e: EffortChoice) => void
}): JSX.Element {
  const levels = info.efforts
  const idx = Math.max(0, levels.indexOf(current))
  const [preview, setPreview] = useState(idx)
  const value = levels[preview] ?? levels[idx]

  // Portaled to <body> so vertical scroll on the model list can't clip it (a scroll
  // container's overflow-x computes to auto, hiding this right-side flyout). Positioned
  // fixed from the row's rect and clamped to the viewport; measured once on open.
  const flyoutRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    // The flyout is a descendant of its anchor row, so on the opening commit the row's ref
    // isn't attached yet when this runs (child layout effects fire before the parent ref).
    // Defer a frame to measure it; the visibility gate below hides the pre-measure paint.
    const raf = requestAnimationFrame(() => {
      const anchor = anchorRef.current
      const el = flyoutRef.current
      if (!anchor || !el) return
      const r = anchor.getBoundingClientRect()
      const fw = el.offsetWidth
      const fh = el.offsetHeight
      const margin = 8
      // Prefer the right of the row; flip left if it'd overrun the viewport.
      let left = r.right + 4
      if (left + fw > window.innerWidth - margin) left = r.left - fw - 4
      left = Math.max(margin, Math.min(left, window.innerWidth - fw - margin))
      let top = r.top + r.height / 2 - fh / 2
      top = Math.max(margin, Math.min(top, window.innerHeight - fh - margin))
      setPos({ top, left })
    })
    return () => cancelAnimationFrame(raf)
  }, [anchorRef])

  return createPortal(
    <div
      ref={flyoutRef}
      role="group"
      aria-label={`Effort for ${info.label}, currently ${EFFORT_LABELS[current]}`}
      className="fixed z-50 w-56 rounded-lg bg-bg-elev p-3 shadow-lg"
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 text-[12px] uppercase tracking-wide text-dim">Effort</span>
          <span className="min-w-0 truncate text-[12px] text-dim">{info.label}</span>
        </span>
        <span className={`shrink-0 font-medium ${EFFORT_COLORS[value]}`}>
          {EFFORT_LABELS[value]}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={levels.length - 1}
        step={1}
        value={preview}
        aria-label={`Reasoning effort for ${info.label}`}
        aria-valuetext={EFFORT_LABELS[value]}
        onChange={(e) => setPreview(Number(e.target.value))}
        onMouseUp={(e) => onPick(levels[Number((e.target as HTMLInputElement).value)])}
        onKeyUp={(e) => {
          if (!COMMIT_KEYS.has(e.key)) return
          onPick(levels[Number((e.target as HTMLInputElement).value)])
        }}
        className="w-full accent-[var(--color-accent)]"
      />
      {/* Underlined tick = the committed level; the colored top-right pill = the inspected one. */}
      <div className="mt-1 flex justify-between text-[11px]">
        {levels.map((lv) => (
          <span
            key={lv}
            className={
              lv === current
                ? 'border-b-2 border-content/40 font-medium text-content'
                : 'text-faint'
            }
          >
            {EFFORT_LABELS[lv]}
          </span>
        ))}
      </div>
    </div>,
    document.body
  )
}
