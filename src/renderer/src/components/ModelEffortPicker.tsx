import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useActive, useSession, effortCap } from '../store'
import { useEscape } from '../lib/useEscape'
import { IconSliders, IconRefresh, IconLock, IconWarn, IconCheck } from './Icon'
import { usePopover } from './Popover'
import { viaOf } from '../lib/motion'
import {
  deriveModelInfo,
  groupModels,
  supportsUltracodeToggle,
  clampEffort,
  cappedEffort,
  contextSizeLabel,
  contextWindowForModel,
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
  const modelChoice = useActive((s) => s?.modelChoice ?? 'claude-opus-5-5[1m]')
  const effortChoice = useActive((s) => s?.effortChoice ?? 'high')
  const ultracode = useActive((s) => s?.ultracode ?? false)
  // Subscribe so a startup / session-start caps load re-renders the chip and flyout.
  useSession((s) => s.effortCaps)

  // The chip shows the effort that will actually run: the CLI floors the stored choice at
  // `maxEffortLevel` without Clui rewriting it.
  const cap = effortCap(modelChoice)
  const runningEffort = cappedEffort(modelChoice, effortChoice, cap)
  const cappedDown = !!cap && runningEffort !== effortChoice
  const capLabel = cap ? EFFORT_LABELS[clampEffort(modelChoice, cap)] : ''
  const setModel = useSession((s) => s.setModel)
  const setEffort = useSession((s) => s.setEffort)
  const [models, setModels] = useState<ModelInfo[]>([])
  // Per-call, not app state: only a SUCCESSFUL list is cached in main, so a later call
  // (or the refresh button) can go live again.
  const [live, setLive] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [hover, setHover] = useState<ModelChoice | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearHoverTimer = (): void => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
  }
  const chevronRef = useRef<HTMLButtonElement | null>(null)
  const p = usePopover({
    placement: 'up',
    above: '--composer-dock',
    onOpenChange: (o) => {
      if (!o) {
        clearHoverTimer()
        setHover(null)
      }
    }
  })
  const open = p.open
  const checkedRef = useRef<HTMLButtonElement>(null)

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
    <div className="relative min-w-0">
      <button
        type="button"
        data-ui="model-chip"
        {...p.triggerProps}
        aria-haspopup="dialog"
        title={`${curLabel} · ${EFFORT_LABELS[runningEffort]}`}
        onClick={(e) => {
          p.triggerProps.onClick(e)
          setHover(null)
        }}
        className={`flex h-8 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-xs text-content transition-colors ${
          open ? 'bg-control-hover' : 'bg-control hover:bg-control-hover'
        }`}
      >
        <IconSliders className="h-3.5 w-3.5 shrink-0 text-dim @max-[480px]/composer:hidden" />
        <span className="min-w-0 truncate whitespace-nowrap font-medium">{curLabel}</span>
        {/* A lock glyph marks a CLI `maxEffortLevel` cap, so the chip is honest without
            hiding the value. Ultra stays off the chip; its own toggle already says it's on. */}
        <span
          className={`flex shrink-0 items-center gap-1 whitespace-nowrap font-medium ${EFFORT_COLORS[runningEffort]}`}
          title={cappedDown ? `Your CLI settings cap effort at ${capLabel}.` : undefined}
        >
          {EFFORT_LABELS[runningEffort]}
          {cappedDown && <IconLock className="h-3 w-3 opacity-80" />}
        </span>
        <svg
          viewBox="0 0 12 12"
          className={`h-3 w-3 shrink-0 text-dim transition-transform ${open ? '' : 'rotate-180'}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 4.5 6 7.5 9 4.5" />
        </svg>
      </button>

      <div
        {...p.popoverProps}
        aria-label="Model and effort"
        className="pop-base pop glass-thick flex max-h-[min(60vh,calc(100vh-24px))] w-[196px] flex-col rounded-xl py-1 text-xs"
        onMouseLeave={scheduleHide}
      >
          <div className="flex shrink-0 items-center justify-between px-3 py-1 text-caps uppercase text-dim">
            <span>Model</span>
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
          {/* Its own line under the header, since the header row has no room for it. Wraps
              to two lines at w-[180px]; shrinking it below the meta size would fail the
              contrast/size floor. */}
          {!live && (
            <div
              className="flex shrink-0 items-start gap-1 px-3 pb-1 text-meta text-warn"
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
                <div className="px-3 pb-0.5 pt-1.5 text-caps uppercase text-dim">
                  {group.label}
                </div>
              )}
              {group.models.map((info) => {
            // While Ultra is on, a model that can't run it stays in the list, disabled with
            // its reason, so the menu keeps its shape when Ultra toggles.
            const incompatible = ultracode && !supportsUltracodeToggle(info.id)
            if (incompatible) {
              return (
                <div
                  key={info.id}
                  aria-disabled="true"
                  title="Ultra isn't available on this model"
                  className="flex w-full cursor-default items-center gap-2 px-3 py-2 text-left text-dim opacity-60"
                >
                  <span className="w-3 shrink-0">{info.id === modelChoice && <IconCheck className="h-3 w-3 text-dim" />}</span>
                  <span className="min-w-0 flex-1 truncate">{info.label}</span>
                  <span className="shrink-0 text-meta text-dim">No Ultra</span>
                </div>
              )
            }
            return (
              <div
                key={info.id}
                style={hover === info.id ? ({ anchorName: '--effort-row' } as React.CSSProperties) : undefined}
                className="relative"
                onMouseEnter={() => scheduleHover(info.id)}
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
                    onClick={(e) => {
                      if (info.id !== modelChoice) void setModel(info.id)
                      clearHoverTimer()
                      p.close({ via: viaOf(e) })
                    }}
                  >
                    <span className="w-3 shrink-0">{info.id === modelChoice && <IconCheck className="h-3 w-3 text-content" />}</span>
                    <span className="flex-1 truncate">{info.label}</span>
                    {/* No size for 'unknown' families (policy selectors, unrecognized ids):
                        they assert no context window. */}
                    {info.family !== 'unknown' && (
                      <span
                        className="shrink-0 tabular-nums text-meta text-dim"
                        title={`Context window: ${contextWindowForModel(info.id).toLocaleString()} tokens`}
                      >
                        {contextSizeLabel(info.id)}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    ref={hover === info.id ? chevronRef : undefined}
                    aria-expanded={hover === info.id}
                    className="flex shrink-0 items-center py-2 pr-3 pl-1 text-dim transition-colors hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    title={`Adjust effort · ${info.label}`}
                    aria-label={`Adjust effort for ${info.label}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      clearHoverTimer()
                      setHover((h) => (h === info.id ? null : info.id))
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'ArrowRight') return
                      e.preventDefault()
                      clearHoverTimer()
                      setHover(info.id)
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
                </div>

                {hover === info.id && (
                  <EffortFlyout
                    info={info}
                    cap={effortCap(info.id)}
                    current={cappedEffort(info.id, effortChoice, effortCap(info.id))}
                    onEnter={clearHoverTimer}
                    onLeave={scheduleHide}
                    onClose={() => {
                      setHover(null)
                      chevronRef.current?.focus()
                    }}
                    onPick={(ef) => {
                      if (info.id !== modelChoice) void setModel(info.id)
                      void setEffort(ef)
                      p.close({ via: 'pointer' })
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
    </div>
  )
}

function EffortFlyout({
  info,
  cap,
  current,
  onEnter,
  onLeave,
  onPick,
  onClose
}: {
  info: ModelInfo
  cap?: EffortChoice
  current: EffortChoice
  onEnter: () => void
  onLeave: () => void
  onPick: (e: EffortChoice) => void
  onClose: () => void
}): JSX.Element {
  const levels = info.efforts
  const idx = Math.max(0, levels.indexOf(current))
  const [preview, setPreview] = useState(idx)
  const value = levels[preview] ?? levels[idx]
  // Highest reachable tick under the CLI cap (no cap → the top of this model's range).
  const capIdx = cap ? levels.indexOf(clampEffort(info.id, cap)) : levels.length - 1
  const capLabel = cap ? EFFORT_LABELS[levels[capIdx]] : ''
  const ref = useRef<HTMLDivElement>(null)

  // A manual popover nested in the picker's DOM: it escapes the picker's scroll clip through the
  // top layer, and light dismiss skips it when walking up from a click, so the picker stays open.
  useLayoutEffect(() => {
    const el = ref.current
    if (el && !el.matches(':popover-open')) el.showPopover()
  }, [])
  useEscape(true, onClose)

  // Err text fails on glass, so Max reads as content text plus an err mark.
  const valueTone = value === 'max' ? 'text-content' : EFFORT_COLORS[value]

  return (
    <div
      ref={ref}
      popover="manual"
      data-ui="effort-flyout"
      role="group"
      aria-label={`Effort for ${info.label}, currently ${EFFORT_LABELS[current]}`}
      className="pop-base glass-thick w-56 rounded-lg p-3"
      style={
        {
          positionAnchor: '--effort-row',
          positionArea: 'right',
          positionTryFallbacks: 'flip-inline',
          marginLeft: '4px'
        } as React.CSSProperties
      }
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 text-caps uppercase text-dim">Effort</span>
          <span className="min-w-0 truncate text-meta text-dim">{info.label}</span>
        </span>
        <span className={`flex shrink-0 items-center gap-1 font-medium ${valueTone}`}>
          {value === 'max' && <span className="h-1.5 w-1.5 rounded-full bg-err" aria-hidden="true" />}
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
        aria-valuetext={
          preview === capIdx && cap ? `${EFFORT_LABELS[value]}, capped by your CLI settings.` : EFFORT_LABELS[value]
        }
        onChange={(e) => setPreview(Math.min(Number(e.target.value), capIdx))}
        onMouseUp={(e) => onPick(levels[Math.min(Number((e.target as HTMLInputElement).value), capIdx)])}
        onKeyUp={(e) => {
          if (!COMMIT_KEYS.has(e.key)) return
          onPick(levels[Math.min(Number((e.target as HTMLInputElement).value), capIdx)])
        }}
        className="w-full accent-[var(--color-accent)]"
      />
      {/* Underlined tick = the committed level. Ticks past the cap are dimmed, never struck through. */}
      <div className="mt-1 flex justify-between text-meta">
        {levels.map((lv, i) => (
          <span
            key={lv}
            className={
              lv === current
                ? 'border-b-2 border-content/40 font-medium text-content'
                : i > capIdx
                  ? 'text-dim opacity-60'
                  : 'text-dim'
            }
          >
            {EFFORT_LABELS[lv]}
          </span>
        ))}
      </div>
      {cap && <div className="mt-1.5 text-meta text-dim">Effort is capped at {capLabel} in your CLI settings.</div>}
    </div>
  )
}
