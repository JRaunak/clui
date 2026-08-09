/**
 * User-configurable app settings. Persisted by the main process to
 * `<userData>/settings.json`. All fields optional; sensible defaults applied.
 */
export interface CluiSettings {
  /** Explicit path to the `claude` binary (overrides auto-detection). */
  cliPath: string
  /** Editor command for opening files/diffs (e.g. `code`, `cursor`, `subl`). */
  editorCommand: string
  /**
   * Permission mode for new sessions.
   * - 'inherit': pass NO --permission-mode; honor your ~/.claude/settings.json
   *   `permissions.defaultMode` exactly as the terminal does.
   * - 'default': interactive approve/deny dialog for every asking tool.
   * - 'acceptEdits'/'plan': the CLI's respective modes (some tools still prompt).
   * - 'bypassPermissions': auto-approve everything (no dialog).
   * In every case Clui opens the stdio permission channel, so whenever the CLI
   * decides to ask, the dialog can answer it.
   */
  permissionMode:
    | 'inherit'
    | 'dontAsk'
    | 'default'
    | 'auto'
    | 'acceptEdits'
    | 'plan'
    | 'bypassPermissions'
  /** Default model for NEW sessions (a concrete choice; no inherit). */
  model: ModelChoice
  /**
   * Default effort for NEW sessions (a concrete choice; no inherit). Effort is
   * launch-only in the CLI; changing it mid-session respawns via --resume.
   */
  effort: EffortChoice
  /** Default workspace folder to offer when starting a session. */
  defaultWorkspace: string
  /**
   * Color theme. 'system' follows the OS `prefers-color-scheme`. Applied to
   * `<html data-theme>`; the light palette re-maps only the semantic token layer
   * (see styles.css). Persisted to `<userData>/settings.json` (never ~/.claude).
   */
  theme: ThemeChoice
  /**
   * First-run flag. False until the user dismisses the first-run intro; once
   * true the intro never shows again. Independent of the CLI health check, which
   * gates on live `detectCli` regardless of this flag.
   */
  onboarded: boolean
  /**
   * Collapsed session sidebar (focus mode). When true the left column shrinks to a
   * status rail. Default false so first-run and the design-capture harness start
   * expanded. Toggled by ⌘B or the header/rail button; persisted like `onboarded`.
   */
  sidebarCollapsed: boolean
}

/** A settings key (used by the per-field reset affordance). */
export type SettingsKey = keyof CluiSettings

/**
 * Where a resolved setting came from. `override` = the user set it in Clui's own
 * settings.json; `cli` = inherited from ~/.claude/settings.json (model/effort only);
 * `default` = the bundled constant. Absence of an override is what makes a per-field
 * reset possible, so this is exact, never best-effort.
 */
export type SettingsSource = 'override' | 'cli' | 'default'

/** Resolved values plus per-key provenance. Returned by `getSettings`. */
export interface ResolvedSettings {
  /** Always-concrete values; every existing consumer reads these. */
  values: CluiSettings
  sources: Record<SettingsKey, SettingsSource>
}

/** Color theme choices. 'system' tracks the OS `prefers-color-scheme`. */
export type ThemeChoice = 'dark' | 'light' | 'system'

export const THEME_CHOICES: ThemeChoice[] = ['dark', 'light', 'system']

export const THEME_LABELS: Record<ThemeChoice, string> = {
  dark: 'Dark',
  light: 'Light',
  system: 'System'
}

/**
 * A model "choice" is the actual `--model` value (id or alias), so the list is
 * derived from whatever Bedrock returns, never a fixed hardcoded union. Labels
 * and effort capabilities are derived from the id (see deriveModelInfo).
 */
export type ModelChoice = string

/** Effort choices (CLI: low/medium/high/xhigh/max). No inherit. Ultracode is a
 *  SEPARATE per-session toggle (not an effort level) that forces xhigh + workflow
 *  orchestration; see `setUltracode` in the store. */
export type EffortChoice = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const EFFORT_CHOICES: EffortChoice[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Narrow an arbitrary value (a hand-edited config field) to an effort level. */
export function isEffortChoice(v: unknown): v is EffortChoice {
  return typeof v === 'string' && (EFFORT_CHOICES as string[]).includes(v)
}

export const EFFORT_LABELS: Record<EffortChoice, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max'
}

/** True if this MODEL supports ultracode (needs xhigh capability). */
export function supportsUltracodeToggle(id: string): boolean {
  return effortsFor(id).includes('xhigh')
}

/** Parsed shape of a model id. */
export interface ModelInfo {
  /** The exact `--model` value (id or alias). */
  id: string
  /** Friendly label, e.g. "Opus 4.8 (1M)". */
  label: string
  /** Effort levels this model supports (derived from family + version). */
  efforts: EffortChoice[]
  /** Family + numeric version, derived from the id, used to GROUP the live list
      in the picker (never to filter or hardcode which models exist). */
  family: 'opus' | 'sonnet' | 'haiku' | 'fable' | 'unknown'
  version: number
}

/**
 * Fallback model ids used before the live Bedrock query lands or when it fails (no `aws`
 * on PATH, creds refreshing). A curated recent set; superseded models are omitted.
 *
 * ponytail: re-check against `aws bedrock list-inference-profiles` when a new family ships.
 * Every Opus >=4.7 needs its `[1m]` twin listed explicitly, since `withVariants()` only
 * derives those on the live path; a missing one silently caps a fallback user at 200K.
 */
export const FALLBACK_MODEL_IDS: string[] = [
  'claude-opus-5[1m]',
  'claude-opus-5',
  'claude-opus-4-8[1m]',
  'claude-opus-4-8',
  'claude-opus-4-7[1m]',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-fable-5',
  'claude-haiku-4-5'
]

// A model id is never shortened for use: only the full Bedrock profile id, a suffix-free
// id, or a short alias ('haiku') is a valid `--model` value. Stripping the prefix off a
// date-suffixed profile yields 'claude-haiku-4-5', which the API rejects; that shortening
// once made half the picker unselectable. `labelFor` parses the full id for display.

/**
 * Parse family + numeric version + 1M flag out of a model id, across every provider's id
 * shape: Bedrock's `us.anthropic.claude-opus-5`, Vertex's `claude-sonnet-4-5@20250929`,
 * Foundry's bare `claude-sonnet-4-6`, Mantle's `anthropic.claude-opus-5`, and the bare
 * aliases (`opus`, `haiku`) the CLI uses on first-party providers. Matching is by substring
 * so an unfamiliar prefix or suffix still parses.
 *
 * An alias carries no version, and it is NOT assumed to be the newest: the CLI's own table
 * maps `sonnet` to Sonnet 4.5 on Bedrock while Sonnet 5 exists. `versioned` reports the
 * absence so the gates below can decline to downgrade a model they can't identify.
 */
function parseModelId(id: string): {
  family: 'opus' | 'sonnet' | 'haiku' | 'fable' | 'unknown'
  version: number
  is1m: boolean
  versioned: boolean
} {
  const s = id.toLowerCase()
  const is1m = /\[1m\]/.test(s)
  const family = s.includes('opus')
    ? 'opus'
    : s.includes('sonnet')
      ? 'sonnet'
      : s.includes('haiku')
        ? 'haiku'
        : s.includes('fable')
          ? 'fable'
          : 'unknown'
  // "opus-4-8" → 4.8, "sonnet-5" → 5, "3-5-sonnet" → 3.5 (the pre-4 families put the
  // version BEFORE the name). The minor part is a single digit on purpose: profile ids
  // carry a date next ("sonnet-4-20250514"), and a greedy \d+ read that as 2025051.4.
  const after = s.match(/(?:opus|sonnet|haiku|fable)-(\d+)(?:-(\d)(?!\d))?/)
  const before = s.match(/(\d+)-(\d)-(?:opus|sonnet|haiku|fable)/)
  const m = after ?? before
  const version = m ? Number(m[1]) + (m[2] ? Number(m[2]) / 10 : 0) : 0
  return { family, version, is1m, versioned: version > 0 }
}

/**
 * Which effort levels a model supports, derived from the CLI's verified gates
 * (binary strings "Fable 5, Opus 4.7+, Sonnet 5" for xhigh and "…Opus 4.6+,
 * Sonnet 4.6+" for max). Version-based so future models qualify automatically.
 */
function effortsFor(id: string): EffortChoice[] {
  const { family, version, versioned } = parseModelId(id)
  const base: EffortChoice[] = ['low', 'medium', 'high']
  let max = false
  let xhigh = false
  // An unversioned alias can't be gated by version, and capping it at `high` would strip
  // xhigh/max from what is usually the newest model in its family. Offer the full range and
  // let the CLI reject a level it doesn't support, since a visible error beats a silent
  // downgrade. Haiku is out because no version of it supports effort.
  if (!versioned) {
    if (family === 'opus' || family === 'sonnet' || family === 'fable') return [...base, 'xhigh', 'max']
    return base
  }
  if (family === 'opus') {
    max = version >= 4.6
    xhigh = version >= 4.7
  } else if (family === 'sonnet') {
    max = version >= 4.6
    xhigh = version >= 5
  } else if (family === 'fable') {
    max = version >= 5
    xhigh = version >= 5
  }
  // haiku / unknown: high only.
  const out = [...base]
  if (xhigh) out.push('xhigh')
  if (max) out.push('max')
  return out
}

/** The CLI's non-model selector values, which name a policy rather than a model. */
const SELECTOR_LABELS: Record<string, string> = {
  default: 'Default',
  best: 'Best available',
  opusplan: 'Opus for plans, Sonnet to build'
}

function labelFor(id: string): string {
  const selector = SELECTOR_LABELS[id.toLowerCase().replace(/\[1m\]$/, '')]
  if (selector) return selector
  const { family, version, is1m } = parseModelId(id)
  if (family === 'unknown') return id
  const cap = family.charAt(0).toUpperCase() + family.slice(1)
  const ver = version ? ` ${version % 1 === 0 ? version : version.toFixed(1)}` : ''
  return `${cap}${ver}${is1m ? ' (1M)' : ''}`
}

export function deriveModelInfo(id: string): ModelInfo {
  const { family, version } = parseModelId(id)
  return { id, label: labelFor(id), efforts: effortsFor(id), family, version }
}

/** Group order for the model picker, most-capable families first. Unknown families
    fall through to a trailing "Other" bucket so a NEW Bedrock model is never dropped. */
const FAMILY_ORDER: ModelInfo['family'][] = ['opus', 'sonnet', 'haiku', 'fable', 'unknown']
const FAMILY_LABEL: Record<ModelInfo['family'], string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  fable: 'Fable',
  unknown: 'Other'
}

export interface ModelGroup {
  family: ModelInfo['family']
  label: string
  models: ModelInfo[]
}

/**
 * Group a LIVE model list by family, version-desc within each group, families in
 * FAMILY_ORDER. Purely a display transform: every input model lands in exactly one
 * group (unknown → "Other"), nothing is filtered or hardcoded, so the picker still
 * reflects whatever Bedrock returned, just scannable instead of a flat interleaved wall.
 */
export function groupModels(models: ModelInfo[]): ModelGroup[] {
  const byFamily = new Map<ModelInfo['family'], ModelInfo[]>()
  for (const m of models) {
    const arr = byFamily.get(m.family) ?? []
    arr.push(m)
    byFamily.set(m.family, arr)
  }
  const groups: ModelGroup[] = []
  for (const fam of FAMILY_ORDER) {
    const list = byFamily.get(fam)
    if (!list || list.length === 0) continue
    // Version desc; a 1M variant sorts just above its non-1M twin (larger context first).
    list.sort((a, b) => b.version - a.version || Number(b.id.includes('[1m]')) - Number(a.id.includes('[1m]')))
    groups.push({ family: fam, label: FAMILY_LABEL[fam], models: list })
  }
  return groups
}

/**
 * Context-window size (tokens) for a model id: 1M for the `[1m]` variant, else 200K.
 * The `result` event carries the authoritative window once a turn streams; this is
 * the id-derived estimate used before that (session start, and on a mid-session model
 * switch, where the picker changes the window with no new turn to re-derive it).
 */
export function contextWindowForModel(id: string): number {
  return /\[1m\]/i.test(id) ? 1_000_000 : 200_000
}

/** ultracode (= xhigh + workflow orchestration) is available iff the model has xhigh. */
export function supportsUltracode(id: string): boolean {
  return effortsFor(id).includes('xhigh')
}

/** True if two model ids denote the SAME model (family+version+1M), ignoring the
 *  Bedrock inference-profile prefix, so the CLI's raw report `claude-sonnet-5`
 *  matches a picker id `us.anthropic.claude-sonnet-5`. */
export function sameModel(a: string, b: string): boolean {
  const pa = parseModelId(a)
  const pb = parseModelId(b)
  return pa.family === pb.family && pa.version === pb.version && pa.is1m === pb.is1m
}

/** Reconcile a CLI-reported model id to the matching picker id: if `reported`
 *  denotes the same model as `current`, keep `current` (preserves the exact
 *  prefixed string the picker matches on); otherwise find a list id that matches,
 *  else fall back to the reported id. Used on session-init so the picker reflects
 *  the model the CLI is ACTUALLY running (e.g. after a mid-session switch survives
 *  a resume) instead of the stale Settings default. */
export function reconcileModelChoice(current: string, reported: string, listed: string[]): string {
  if (sameModel(current, reported)) return current
  const match = listed.find((id) => sameModel(id, reported))
  return match ?? reported
}

/** Clamp an effort to what a model supports (nearest lower level). `EFFORT_CHOICES` is
 *  ordered low→max, so walking it downward from the requested index finds the highest
 *  supported level at or below the request. */
export function clampEffort(model: ModelChoice, effort: EffortChoice): EffortChoice {
  const allowed = effortsFor(model)
  if (allowed.includes(effort)) return effort
  const reqIdx = EFFORT_CHOICES.indexOf(effort)
  for (let i = reqIdx; i >= 0; i--) {
    if (allowed.includes(EFFORT_CHOICES[i])) return EFFORT_CHOICES[i]
  }
  return allowed[allowed.length - 1]
}

export const DEFAULT_SETTINGS: CluiSettings = {
  cliPath: '',
  editorCommand: 'code',
  // Default to honoring the user's ~/.claude/settings.json rather than overriding it.
  permissionMode: 'inherit',
  // Model/effort are Clui-managed and always concrete (independent of settings.json).
  // model is the raw --model value; the list is derived from Bedrock at runtime.
  model: 'claude-opus-4-8[1m]',
  effort: 'high',
  defaultWorkspace: '',
  // Dark is Clui's signature surface; light + system are opt-in.
  theme: 'dark',
  // First launch shows the intro card until dismissed.
  onboarded: false,
  sidebarCollapsed: false
}

// Ordered by the risk ramp (safest concrete mode → riskiest), with System Default
// (settings.json-honoring) pinned first. `dontAsk`/`auto` are 2.1.210 CLI modes
// (verified accepted headless): dontAsk = never prompts, DENIES anything not
// pre-approved (most restrictive; verified it hard-denies a safe-but-unlisted
// command); auto = runs low-risk silently + delegates risk to Claude's classifier
// (Claude Code's new default).
export const PERMISSION_MODES: CluiSettings['permissionMode'][] = [
  'inherit',
  'dontAsk',
  'default',
  'auto',
  'acceptEdits',
  'plan',
  'bypassPermissions'
]

/** Human-friendly labels for the permission-mode pickers. */
export const PERMISSION_MODE_LABELS: Record<CluiSettings['permissionMode'], string> = {
  inherit: 'System Default',
  dontAsk: 'Silent Deny',
  default: 'Interactive',
  auto: 'Adaptive',
  acceptEdits: 'Auto Edit',
  plan: 'Plan Mode',
  bypassPermissions: 'Autonomous'
}

/**
 * Risk-based Tailwind text-color class per mode (green = safest → red = riskiest).
 * System Default is neutral (it inherits whatever settings.json says). `dontAsk` is
 * green because it's the MOST restrictive (only pre-approved actions run, rest denied);
 * `auto` is info-blue, a smart/managed middle (classifier decides), deliberately not green
 * since its live hard-block wasn't fully verified (don't over-signal "safe").
 */
export const PERMISSION_MODE_COLORS: Record<CluiSettings['permissionMode'], string> = {
  inherit: 'text-dim',
  dontAsk: 'text-ok',
  default: 'text-ok',
  auto: 'text-info',
  acceptEdits: 'text-warn',
  plan: 'text-info',
  bypassPermissions: 'text-err'
}

/**
 * One-line behavior descriptions shown UNDER each option in the open picker (menu
 * only; the collapsed composer chip stays compact). The terse labels ("Silent Deny",
 * "Adaptive") don't convey behavior alone, so each description says what the mode DOES
 * and whether it asks you, making the risk ordering self-explanatory. Kept ≤7 words.
 */
export const PERMISSION_MODE_DESCRIPTIONS: Record<CluiSettings['permissionMode'], string> = {
  inherit: 'Follows your CLI settings.json',
  dontAsk: 'Never asks; denies anything not pre-approved',
  default: 'Asks before running each tool',
  auto: 'Claude judges risk and decides per action',
  acceptEdits: 'Applies file edits without asking',
  plan: 'Proposes a plan before touching anything',
  bypassPermissions: 'Runs everything without asking'
}
