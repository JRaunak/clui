import { useCallback, useEffect, useRef, useState } from 'react'
import { useActive, useSession } from '../store'
import { useEscape } from '../lib/useEscape'
import { useClickOutside } from '../lib/useClickOutside'
import { IconSliders, IconRefresh, IconLock, IconWarn } from './Icon'
import {
  deriveModelInfo,
  groupModels,
  supportsUltracode,
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
          className="absolute bottom-full left-0 mb-1.5 w-[180px] rounded-xl bg-bg-elev py-1 text-xs shadow-lg"
          onMouseLeave={scheduleHide}
        >
          <div className="flex items-center justify-between px-3 py-1 text-[11px] uppercase tracking-wide text-dim">
            <span>{ultracode ? 'Model · Ultra needs X-High' : 'Model'}</span>
            <button
              type="button"
              className="-my-1 flex h-6 w-6 items-center justify-center rounded text-dim transition-colors hover:text-content"
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
              the ultracode string. Wraps to two lines at w-[180px] — accepted, since
              shrinking it below the meta size would fail the contrast/size floor. */}
          {!live && (
            <div
              className="flex items-start gap-1 px-3 pb-1 text-[11px] text-warn"
              title="Couldn't reach Bedrock. This is Clui's built-in list and may be missing newer models. Refresh to retry."
            >
              <IconWarn className="mt-px h-3 w-3 shrink-0" />
              <span>Built-in list, may be incomplete</span>
            </div>
          )}
          {models.length === 0 && <div className="px-3 py-2 text-dim">Loading models…</div>}
          {/* Grouped by family (version-desc within each) so 13 near-identically-named
              models aren't a flat interleaved wall. Purely a display transform over the
              LIVE list — nothing filtered or hardcoded (groupModels buckets unknowns too). */}
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
                  <span className="flex-1">{info.label}</span>
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
                className="relative"
                onMouseEnter={() => effortSelectable && scheduleHover(info.id)}
              >
                {/* Two click regions (dropdown contract: selecting an item closes the
                    menu). Clicking the MODEL NAME switches the model AND closes — a
                    complete action, no forced effort step. Effort is an OPTIONAL
                    refinement via the ▶ chevron (click to open the flyout, also opens
                    on hover) so it stays reachable by both click + keyboard without
                    gating the common case. */}
                <div className="flex w-full items-center text-content hover:bg-row-hover">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left"
                    onClick={() => {
                      if (info.id !== modelChoice) void setModel(info.id)
                      clearHoverTimer()
                      setOpen(false)
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
                      className="flex shrink-0 items-center py-2 pr-3 pl-1 text-dim transition-colors hover:text-content"
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
                    }}
                  />
                )}
              </div>
            )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function EffortFlyout({
  info,
  current,
  onEnter,
  onLeave,
  onPick
}: {
  info: ModelInfo
  current: EffortChoice
  onEnter: () => void
  onLeave: () => void
  onPick: (e: EffortChoice) => void
}): JSX.Element {
  const levels = info.efforts
  const idx = Math.max(0, levels.indexOf(current))
  const [preview, setPreview] = useState(idx)
  const value = levels[preview] ?? levels[idx]

  return (
    <div
      className="absolute top-1/2 left-full z-50 ml-1 w-56 -translate-y-1/2 rounded-lg bg-bg-elev p-3 shadow-lg"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12px] uppercase tracking-wide text-dim">
          Effort{supportsUltracode(info.id) ? '' : ''}
        </span>
        <span className={`font-medium ${EFFORT_COLORS[value]}`}>{EFFORT_LABELS[value]}</span>
      </div>
      <input
        type="range"
        min={0}
        max={levels.length - 1}
        step={1}
        value={preview}
        onChange={(e) => setPreview(Number(e.target.value))}
        onMouseUp={() => onPick(levels[preview])}
        onKeyUp={() => onPick(levels[preview])}
        className="w-full accent-[var(--color-accent)]"
      />
      <div className="mt-1 flex justify-between text-[11px] text-dim">
        {levels.map((lv) => (
          <span key={lv}>{EFFORT_LABELS[lv]}</span>
        ))}
      </div>
    </div>
  )
}
