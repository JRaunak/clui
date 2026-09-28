import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { CliInfo, ModelListResult } from '../../../shared/ipc'
import {
  siteKeyOf,
  type ApprovedSite,
  type BrowsingDataInfo,
  type ClearBrowsingData,
  type SavedLoginInfo
} from '../../../shared/browser'
import {
  PERMISSION_MODES,
  PERMISSION_MODE_LABELS,
  PERMISSION_MODE_COLORS,
  PERMISSION_MODE_DESCRIPTIONS,
  EFFORT_CHOICES,
  EFFORT_LABELS,
  THEME_CHOICES,
  THEME_LABELS,
  deriveModelInfo,
  groupModels,
  contextSizeLabel,
  contextWindowForModel,
  type CluiSettings,
  type SettingsKey,
  type SettingsSource
} from '../../../shared/settings'
import { useSession } from '../store'
import { Dropdown } from './Dropdown'
import { Button } from './Button'
import { IconClose, IconWarn, IconCheck, IconCookie, IconHistory, IconImage } from './Icon'
import { FieldError, LOGIN_INPUT, RevealButton } from './LoginFields'
import { ToastStack } from './Toast'
import { applyTheme } from '../lib/theme'
import { useEscape } from '../lib/useEscape'
import { useDialogFocus } from '../lib/useDialogFocus'

/** What to tell the user when the model list is the bundled fallback. Only Bedrock can be queried
 *  for a list; on other providers the CLI reads its own built-in catalog, so a missing `aws` is normal. */
const FALLBACK_NOTES: Record<NonNullable<ModelListResult['reason']>, string> = {
  'no-cli':
    "Showing Clui's built-in model list. A live list needs the aws CLI on Clui's PATH, which only applies if you use Bedrock.",
  'expired-creds':
    'Your AWS credentials have expired, so newer models may be missing. Run aws sso login, then reopen Settings.',
  other:
    "Showing Clui's built-in list. The live Bedrock query failed, so newer models may be missing. Check the aws CLI and your credentials, then reopen Settings."
}

/** Model families offered for quick sessions (the latest live model of the pick is resolved at
 *  spawn; see latestModelInFamily). Not the full live list: a quick chat picks a family, not a
 *  concrete id. */
const QUICK_FAMILIES: CluiSettings['quickModelFamily'][] = ['opus', 'sonnet', 'haiku']
const QUICK_FAMILY_LABELS: Record<CluiSettings['quickModelFamily'], string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku'
}

/** Permission modes a quick session can use: a deliberate subset of PERMISSION_MODES (no
 *  Silent Deny / Plan / Auto Edit, which don't fit a throwaway chat). */
const QUICK_PERMISSION_MODES: CluiSettings['permissionMode'][] = [
  'inherit',
  'default',
  'auto',
  'bypassPermissions'
]

/** In the quick-session context, System Default couples to the global permission mode, not a
 *  settings.json field, so its description is reworded to keep that coupling honest. */
const QUICK_PERMISSION_DESCRIPTIONS: Record<CluiSettings['permissionMode'], string> = {
  ...PERMISSION_MODE_DESCRIPTIONS,
  inherit: 'Follows your global permission mode'
}

export function Settings({ onClose }: { onClose: () => void }): JSX.Element {
  const [settings, setSettings] = useState<CluiSettings | null>(null)
  const [cliInfo, setCliInfo] = useState<CliInfo | null>(null)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [modelList, setModelList] = useState<ModelListResult>({ ids: [], live: true })
  // Per-key provenance from the main process, plus the keys staged for reset. Both drive the reset control;
  // the modal commits on Save, so a reset is staged until then, and re-picking a value un-stages it.
  const [sources, setSources] = useState<Record<SettingsKey, SettingsSource> | null>(null)
  const [cleared, setCleared] = useState<SettingsKey[]>([])
  // The theme is applied live on change for instant feedback, but only persisted on Save.
  // `persistedTheme` tracks the last-persisted value so closing without saving can revert the live preview;
  // `previewedTheme` is null until the user changes the dropdown, so the unmount revert only fires when
  // there's a real preview to undo. Avoids reverting when StrictMode's simulated mount/unmount fires cleanup
  // before the async getSettings() resolves.
  const persistedTheme = useRef<CluiSettings['theme'] | null>(null)
  const previewedTheme = useRef<CluiSettings['theme'] | null>(null)

  useEffect(() => {
    window.clui.getSettings().then(({ values, sources: src }) => {
      setSettings(values)
      setSources(src)
      persistedTheme.current = values.theme
      void checkCli(values.cliPath)
    })
    window.clui.listModels().then(setModelList)
  }, [])

  // Group + version-sort the unordered live Bedrock list into the composer picker's shape.
  // Headers only when there's more than one family; the context-size column only for known ones.
  const modelOptions = useMemo(
    () =>
      groupModels(modelList.ids.map(deriveModelInfo)).flatMap((g, gi, groups) =>
        g.models.map((info, i) => ({
          value: info.id,
          label: info.label,
          header: groups.length > 1 && i === 0 ? g.label : undefined,
          meta: info.family !== 'unknown' ? contextSizeLabel(info.id) : undefined,
          metaTitle:
            info.family !== 'unknown'
              ? `Context window: ${contextWindowForModel(info.id).toLocaleString()} tokens`
              : undefined
        }))
      ),
    [modelList.ids]
  )

  // On unmount, revert an unsaved live theme preview, but only if one was made and we know the persisted baseline.
  useEffect(() => {
    return () => {
      if (previewedTheme.current !== null && persistedTheme.current !== null) {
        applyTheme(persistedTheme.current)
      }
    }
  }, [])

  // Esc closes the modal (via the escape-stack, so an open dropdown inside closes first).
  useEscape(true, onClose)

  const checkCli = async (path: string): Promise<void> => {
    setChecking(true)
    const info = await window.clui.detectCliAt(path)
    setCliInfo(info)
    setChecking(false)
  }

  const set = <K extends keyof CluiSettings>(key: K, value: CluiSettings[K]): void => {
    setSettings((s) => (s ? { ...s, [key]: value } : s))
    // Editing a field un-stages its pending reset.
    setCleared((c) => (c.includes(key) ? c.filter((k) => k !== key) : c))
    setSaveError(null)
  }

  /** Stage a reset: the key is cleared on Save. */
  const reset = (key: SettingsKey): void => {
    setCleared((c) => (c.includes(key) ? c : [...c, key]))
    setSaveError(null)
  }

  /** True while this field holds a user override. */
  const isOverridden = (key: SettingsKey): boolean =>
    sources?.[key] === 'override' && !cleared.includes(key)

  // Save commits + dismisses (dialog contract: the primary action of a modal both applies and closes).
  // But close only on success: if the write fails we keep the modal open and surface the error.
  const save = async (): Promise<void> => {
    if (!settings || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      await window.clui.updateSettings(settings, cleared)
      // The live-applied theme is now persisted, so mark it so the unmount revert is a no-op.
      persistedTheme.current = settings.theme
      previewedTheme.current = null
      onClose()
    } catch (e) {
      setSaving(false)
      setSaveError(e instanceof Error ? e.message : 'Could not save settings.')
    }
  }

  const pickWorkspace = async (): Promise<void> => {
    const dir = await window.clui.pickWorkspace()
    if (dir) set('defaultWorkspace', dir)
  }

  if (!settings) return <Overlay>Loading…</Overlay>

  return (
    <Overlay>
      <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
        <div className="text-title text-content">Settings</div>
        <button
          className="rounded-md p-1 text-dim transition-colors hover:bg-bg-raised hover:text-content"
          onClick={onClose}
          title="Close"
        >
          <IconClose className="h-4 w-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
        <Field
          label="Theme"
          hint="System matches your Mac's appearance. Light and Dark override it."
          onReset={isOverridden('theme') ? () => reset('theme') : undefined}
        >
          <Dropdown<CluiSettings['theme']>
            value={settings.theme}
            ariaLabel="Theme"
            options={THEME_CHOICES.map((t) => ({ value: t, label: THEME_LABELS[t] }))}
            onChange={(t) => {
              set('theme', t)
              // Apply immediately for instant feedback; persisted only on Save. Mark that a live preview exists so close-without-save reverts it.
              previewedTheme.current = t
              applyTheme(t)
            }}
          />
        </Field>

        <Field
          label="Claude CLI path"
          hint="Leave blank to detect Claude automatically. Set a path only if it lives somewhere unusual."
          onReset={isOverridden('cliPath') ? () => reset('cliPath') : undefined}
        >
          <div className="flex gap-2">
            <input
              aria-label="Claude CLI path"
              className="flex-1 rounded border border-border bg-bg px-2 py-1.5 font-mono text-xs text-content outline-none focus:border-accent"
              placeholder="(auto-detect)"
              value={settings.cliPath}
              onChange={(e) => set('cliPath', e.target.value)}
              onBlur={() => void checkCli(settings.cliPath)}
            />
            <button
              className="rounded border border-border px-3 text-xs text-dim hover:text-content"
              onClick={() => void checkCli(settings.cliPath)}
            >
              Check
            </button>
          </div>
          {/* Version + path are machine values, rendered in mono. */}
          <div className="mt-1 text-meta">
            {checking ? (
              <span className="text-dim">checking…</span>
            ) : cliInfo?.path ? (
              <span className="text-ok">
                ✓ <span className="font-mono">claude {cliInfo.version ?? '?'}</span> ·{' '}
                {cliInfo.source} · <span className="font-mono">{cliInfo.path}</span>
              </span>
            ) : (
              <span className="text-err">✗ claude not found</span>
            )}
          </div>
        </Field>

        <Field
          label="Editor command"
          hint="Used to open changed files / diffs (e.g. code, cursor, subl)."
          onReset={isOverridden('editorCommand') ? () => reset('editorCommand') : undefined}
        >
          <input
            aria-label="Editor command"
            className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-xs text-content outline-none focus:border-accent"
            value={settings.editorCommand}
            onChange={(e) => set('editorCommand', e.target.value)}
          />
        </Field>

        <div className="mt-4 text-caps uppercase text-dim">Defaults for new sessions</div>

        <Field
          label="Permission mode"
          hint="Default for new sessions (changeable per-session in the composer). Applied as a --permission-mode flag; 'System Default' passes no flag. Clui never writes your ~/.claude/settings.json."
          onReset={isOverridden('permissionMode') ? () => reset('permissionMode') : undefined}
        >
          <Dropdown<CluiSettings['permissionMode']>
            value={settings.permissionMode}
            ariaLabel="Permission mode"
            options={PERMISSION_MODES.map((m) => ({
              value: m,
              label: PERMISSION_MODE_LABELS[m],
              color: PERMISSION_MODE_COLORS[m],
              description: PERMISSION_MODE_DESCRIPTIONS[m]
            }))}
            menuClassName="w-72"
            onChange={(m) => set('permissionMode', m)}
          />
        </Field>

        <Field
          label="Model"
          hint={`Default model for new sessions (changeable per-session).${
            sources?.model === 'cli' ? ' Currently inheriting from ~/.claude/settings.json.' : ''
          }`}
          onReset={isOverridden('model') ? () => reset('model') : undefined}
          // Amber = degraded but usable: they still have a working list, just possibly incomplete.
          note={
            !modelList.live && (
              <p className="flex items-start gap-1.5 text-meta text-warn" role="status">
                <IconWarn className="mt-px h-3.5 w-3.5 shrink-0" />
                {FALLBACK_NOTES[modelList.reason ?? 'other']}
              </p>
            )
          }
        >
          <Dropdown<CluiSettings['model']>
            value={settings.model}
            ariaLabel="Default model for new sessions"
            options={modelOptions}
            onChange={(m) => set('model', m)}
          />
        </Field>

        <Field
          label="Effort"
          hint={`Default reasoning effort for new sessions (changeable per-session).${
            sources?.effort === 'cli' ? ' Currently inheriting from ~/.claude/settings.json.' : ''
          }`}
          onReset={isOverridden('effort') ? () => reset('effort') : undefined}
        >
          <Dropdown<CluiSettings['effort']>
            value={settings.effort}
            ariaLabel="Default reasoning effort for new sessions"
            options={EFFORT_CHOICES.map((e) => ({ value: e, label: EFFORT_LABELS[e] }))}
            onChange={(e) => set('effort', e)}
          />
        </Field>

        <Field
          label="Task tracking tools"
          hint="Lets Claude keep a checklist of its work in the task puck. Opus 4.8 and newer only offer these tools when this is on. Off by default."
          hintId="task-tools-hint"
          onReset={isOverridden('enableTaskTools') ? () => reset('enableTaskTools') : undefined}
        >
          <button
            type="button"
            role="checkbox"
            aria-checked={settings.enableTaskTools}
            aria-label="Enable task tracking tools for new sessions"
            aria-describedby="task-tools-hint"
            onClick={() => set('enableTaskTools', !settings.enableTaskTools)}
            className="group flex items-center gap-2 rounded-md py-1 pr-1 text-left"
          >
            <span
              className={`flex h-4 w-4 flex-none items-center justify-center rounded-[4px] border transition-colors duration-150 ${
                settings.enableTaskTools
                  ? 'border-accent bg-accent/15 text-accent'
                  : 'border-control-edge text-transparent group-hover:border-border-strong'
              }`}
            >
              <IconCheck className="h-3 w-3" />
            </span>
            <span className="text-label text-content">Enable for new sessions</span>
          </button>
        </Field>

        <Field
          label="Default workspace"
          hint="Offered when starting a new session."
          onReset={isOverridden('defaultWorkspace') ? () => reset('defaultWorkspace') : undefined}
        >
          <div className="flex gap-2">
            <input
              aria-label="Default workspace"
              className="flex-1 rounded border border-border bg-bg px-2 py-1.5 font-mono text-xs text-content outline-none focus:border-accent"
              placeholder="(none)"
              value={settings.defaultWorkspace}
              onChange={(e) => set('defaultWorkspace', e.target.value)}
            />
            <button
              className="rounded border border-border px-3 text-xs text-dim hover:text-content"
              onClick={() => void pickWorkspace()}
            >
              Browse…
            </button>
          </div>
        </Field>

        <div className="mt-4 text-caps uppercase text-dim">Quick sessions</div>

        <Field
          label="Model family"
          hint="Quick sessions run this family's latest model at high effort, with a limited tool set. Applies to all quick sessions."
          onReset={isOverridden('quickModelFamily') ? () => reset('quickModelFamily') : undefined}
        >
          <Dropdown<CluiSettings['quickModelFamily']>
            value={settings.quickModelFamily}
            ariaLabel="Quick session model family"
            options={QUICK_FAMILIES.map((f) => ({ value: f, label: QUICK_FAMILY_LABELS[f] }))}
            onChange={(f) => set('quickModelFamily', f)}
          />
        </Field>

        <Field
          label="Permission mode"
          hint="How quick sessions handle tool permissions. Applies to all quick sessions, not per-session."
          onReset={isOverridden('quickPermissionMode') ? () => reset('quickPermissionMode') : undefined}
        >
          <Dropdown<CluiSettings['quickPermissionMode']>
            value={settings.quickPermissionMode}
            ariaLabel="Quick session permission mode"
            options={QUICK_PERMISSION_MODES.map((m) => ({
              value: m,
              label: PERMISSION_MODE_LABELS[m],
              color: PERMISSION_MODE_COLORS[m],
              description: QUICK_PERMISSION_DESCRIPTIONS[m],
              tone: m === 'bypassPermissions' ? ('danger' as const) : undefined
            }))}
            menuClassName="w-72"
            onChange={(m) => set('quickPermissionMode', m)}
          />
        </Field>

        <div className="mt-4 text-caps uppercase text-dim">Browser</div>
        <BrowserSettings />
      </div>

      <div className="flex items-center justify-end gap-3 border-t border-border px-5 py-3">
        {/* On failure only: keep the modal open + explain. Success needs no message; the modal closes. */}
        {saveError && (
          <span className="mr-auto text-xs text-err" role="alert" aria-live="assertive">
            {saveError}
          </span>
        )}
        <Button variant="outline" size="md" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" size="md" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Overlay>
  )
}

/** No scrim dismissal: the form holds unsaved edits an outside click would discard. */
function Overlay({ children }: { children: React.ReactNode }): JSX.Element {
  const dialogRef = useDialogFocus<HTMLDivElement>()
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center scrim">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        data-ui="settings"
        className="flex max-h-[85vh] w-[min(620px,92%)] flex-col rounded-lg border border-border bg-bg-elev shadow-[var(--shadow-float)] outline-none"
      >
        {children}
      </div>
    </div>
  )
}

function Field({
  label,
  hint,
  hintId,
  onReset,
  note,
  children
}: {
  label: string
  hint?: string
  /** id for the hint <p>, so a control in `children` can point aria-describedby at it. */
  hintId?: string
  /** Present only while this field holds an override. Its presence IS the "modified"
   *  marker: a neutral gutter rule fails the 3:1 non-text gate on this surface (the
   *  best neutral is 1.79:1) and the only value that passes is the scarce accent, so
   *  the control carries the state instead of a second colored channel. */
  onReset?: () => void
  /** Rendered after the hint, for a state the hint can't express (e.g. a degraded source). */
  note?: React.ReactNode
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      {/* min-h-6 keeps the row a constant height whether or not the button is there,
          so resetting a field doesn't reflow everything below it. */}
      <div className="flex min-h-6 items-center justify-between gap-3">
        <label className="text-ui font-semibold text-content">{label}</label>
        {onReset && (
          <button
            type="button"
            onClick={onReset}
            aria-label={`Reset ${label} to its inherited value`}
            className="-mr-1.5 flex h-6 items-center rounded px-1.5 text-label font-medium text-dim transition-colors hover:text-content"
          >
            Reset
          </button>
        )}
      </div>
      {children}
      {hint && (
        <p id={hintId} className="text-meta text-dim">
          {hint}
        </p>
      )}
      {note}
    </div>
  )
}

const UNDO_MS = 5000
const CONTROL_BTN =
  'inline-flex h-7 shrink-0 items-center rounded-md border border-control-edge bg-control px-2.5 text-label font-semibold text-content transition-colors hover:bg-control-hover aria-disabled:cursor-default aria-disabled:border-transparent aria-disabled:bg-bg-raised aria-disabled:text-faint aria-disabled:hover:bg-bg-raised'
const shortMonth = new Intl.DateTimeFormat('en-US', { month: 'short' })
// en-GB would give the day-first order but spells September "Sept".
const approvedDate = (ms: number): string => `${new Date(ms).getDate()} ${shortMonth.format(ms)}`

/** The same normalisation main applies when it saves, so the hint shows the site that will be stored. */
const normalizeSite = (raw: string): string | null => siteKeyOf(`https://${raw.trim().replace(/^https?:\/\//, '')}`)

type PendingRemoval = { id: string; title: string; commit: () => Promise<void> }

/** Approved sites and saved logins. Changes go straight to main without waiting for Save; a
 *  removal commits once its undo toast runs out. */
function BrowserSettings(): JSX.Element {
  const [sites, setSites] = useState<ApprovedSite[]>([])
  const [logins, setLogins] = useState<SavedLoginInfo[]>([])
  const [vault, setVault] = useState<boolean | null>(null)
  const [form, setForm] = useState<{ edit: SavedLoginInfo | null } | null>(null)
  const [pending, setPendingState] = useState<PendingRemoval[]>([])
  const pendingRef = useRef<PendingRemoval[]>([])
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const [announce, setAnnounce] = useState('')
  const announceSeq = useRef(0)
  const unavailableId = useId()

  const setPending = useCallback((next: PendingRemoval[]) => {
    pendingRef.current = next
    setPendingState(next)
  }, [])

  const relist = useCallback(async () => {
    const [s, v] = await Promise.all([window.clui.browserListSites(), window.clui.browserVaultAvailable()])
    setSites(s)
    setVault(v)
    // Listing logins throws without Keychain access, which the unavailable line already explains.
    setLogins(v ? await window.clui.browserListLogins().catch(() => []) : [])
  }, [])
  useEffect(() => {
    void relist()
  }, [relist])

  // Closing Settings is not an undo: whatever is still waiting commits now.
  useEffect(() => {
    const t = timers.current
    return () => {
      t.forEach(clearTimeout)
      pendingRef.current.forEach((p) => void p.commit())
    }
  }, [])

  const remove = (id: string, title: string, commit: () => Promise<void>): void => {
    const item = { id, title, commit: async () => { await commit(); await relist() } }
    setPending([item, ...pendingRef.current.filter((p) => p.id !== id)])
    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id)
        setPending(pendingRef.current.filter((p) => p.id !== id))
        void item.commit()
      }, UNDO_MS)
    )
    setAnnounce(`${title}. Undo available.${'\u200b'.repeat(++announceSeq.current % 2)}`)
  }
  const undo = (id: string): void => {
    clearTimeout(timers.current.get(id))
    timers.current.delete(id)
    setPending(pendingRef.current.filter((p) => p.id !== id))
  }

  const hidden = new Set(pending.map((p) => p.id))
  const shownSites = sites.filter((s) => !hidden.has(`site:${s.site}`))
  const shownLogins = logins.filter((l) => !hidden.has(`login:${l.id}`))

  return (
    <>
      <section className="flex flex-col gap-2" aria-labelledby={`${unavailableId}-sites`}>
        <div className="flex min-h-7 items-center gap-2">
          <h3 id={`${unavailableId}-sites`} className="text-ui font-semibold text-content">
            Approved sites
          </h3>
          <span className="text-meta text-dim">{shownSites.length}</span>
        </div>
        {shownSites.length === 0 ? (
          <p className="text-meta text-dim">No approved sites yet. Claude asks the first time it opens a site.</p>
        ) : (
          <ul className="flex flex-col">
            {shownSites.map((s) => (
              <li key={s.site} className="flex h-9 items-center gap-3">
                <span className="min-w-0 truncate font-mono text-code text-content">{s.site}</span>
                <span className="shrink-0 text-meta text-dim">Approved {approvedDate(s.approvedMs)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${s.site}`}
                  className={`${CONTROL_BTN} ml-auto`}
                  onClick={() => remove(`site:${s.site}`, `Removed ${s.site}`, () => window.clui.browserRemoveSite(s.site))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2" aria-labelledby={`${unavailableId}-logins`}>
        <div className="flex min-h-7 items-center gap-2">
          <h3 id={`${unavailableId}-logins`} className="text-ui font-semibold text-content">
            Saved logins
          </h3>
          <span className="text-meta text-dim">{shownLogins.length}</span>
          <button
            type="button"
            aria-disabled={vault === false || undefined}
            aria-describedby={vault === false ? unavailableId : undefined}
            className={`${CONTROL_BTN} ml-auto`}
            onClick={() => {
              if (vault) setForm({ edit: null })
            }}
          >
            Add login
          </button>
        </div>
        {vault === false && (
          <p id={unavailableId} className="text-meta text-dim">
            Saved logins need macOS Keychain access, which isn&apos;t available right now.
          </p>
        )}
        {form && !form.edit && (
          <LoginForm
            edit={null}
            onCancel={() => setForm(null)}
            onSaved={() => {
              setForm(null)
              void relist()
            }}
          />
        )}
        {vault && shownLogins.length === 0 && !form && <p className="text-meta text-dim">No saved logins yet.</p>}
        {shownLogins.length > 0 && (
          <ul className="flex flex-col">
            {shownLogins.map((l) =>
              form?.edit?.id === l.id ? (
                <li key={l.id}>
                  <LoginForm
                    edit={l}
                    onCancel={() => setForm(null)}
                    onSaved={() => {
                      setForm(null)
                      void relist()
                    }}
                  />
                </li>
              ) : (
                <li key={l.id} className="flex h-9 items-center gap-3">
                  <span className="min-w-0 truncate font-mono text-code text-content">{l.site}</span>
                  <span className="min-w-0 truncate text-meta text-dim">{l.username}</span>
                  {l.hasTotp && <span className="shrink-0 rounded bg-bg-raised px-1.5 py-0.5 text-badge text-dim">2FA</span>}
                  <span className="ml-auto flex shrink-0 gap-2">
                    <button
                      type="button"
                      aria-label={`Edit login for ${l.username}`}
                      className={CONTROL_BTN}
                      onClick={() => setForm({ edit: l })}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove login for ${l.username}`}
                      className={CONTROL_BTN}
                      onClick={() =>
                        remove(`login:${l.id}`, `Removed login for ${l.username}`, () => window.clui.browserRemoveLogin(l.id))
                      }
                    >
                      Remove
                    </button>
                  </span>
                </li>
              )
            )}
          </ul>
        )}
      </section>

      <BrowsingData />

      <ToastStack
        items={pending.map((p) => ({ id: p.id, title: p.title }))}
        durationMs={UNDO_MS}
        announce={announce}
        onUndo={undo}
        label="Recently removed browser items"
      />
    </>
  )
}

const MB = 1024 * 1024

function cacheDetail(bytes: number): string {
  if (bytes === 0) return 'Nothing cached.'
  const size =
    bytes < MB ? 'Less than 1 MB' : bytes < 1024 * MB ? `${Math.round(bytes / MB)} MB` : `${(bytes / (1024 * MB)).toFixed(1)} GB`
  return `${size} cached. Pages download them again as needed.`
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many)

/** One app-wide clear of the shared browser profile. Opening the checklist is the confirmation. */
function BrowsingData(): JSX.Element {
  const id = useId()
  const [info, setInfo] = useState<BrowsingDataInfo | null>(null)
  const [open, setOpen] = useState(false)
  const [what, setWhat] = useState<ClearBrowsingData>({ cookies: true, cache: true, history: true })
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [cleared, setCleared] = useState(false)
  const [announce, setAnnounce] = useState('')
  const seq = useRef(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const firstRowRef = useRef<HTMLButtonElement>(null)
  const blocked = useSession((s) =>
    Object.values(s.sessions).some((x) => x.browser?.drive === 'driving' || x.browser?.drive === 'user')
  )

  const recount = useCallback(async () => setInfo(await window.clui.browserDataInfo().catch(() => null)), [])
  useEffect(() => {
    void recount()
  }, [recount])
  useEffect(() => {
    if (open) firstRowRef.current?.focus()
  }, [open])

  const say = (text: string): void => setAnnounce(`${text}${'\u200b'.repeat(++seq.current % 2)}`)
  const empty = !!info && info.cookieSites === 0 && info.cacheBytes === 0 && info.openPages === 0
  const unavailable = blocked || (empty && !cleared)
  const description = blocked
    ? "Unavailable while Claude is using the browser. Wait until it's done, or press Stop."
    : cleared
      ? 'Cleared. Open pages reloaded.'
      : empty
        ? 'Nothing to clear yet.'
        : "Cookies, cache and page history in Clui's browser. Shared by every session."

  const collapse = useCallback(() => {
    setOpen(false)
    setFailed(false)
    triggerRef.current?.focus()
  }, [])
  const busyRef = useRef(false)
  busyRef.current = busy
  const onEscape = useCallback(() => {
    if (!busyRef.current) collapse()
  }, [collapse])
  useEscape(open, onEscape)

  const none = !what.cookies && !what.cache && !what.history
  const del = async (): Promise<void> => {
    if (none || blocked || busy) return
    setBusy(true)
    setFailed(false)
    try {
      await window.clui.browserClearData(what)
      setCleared(true)
      setOpen(false)
      triggerRef.current?.focus()
      say('Browsing data cleared.')
    } catch {
      setFailed(true)
      say("Couldn't clear browsing data. Try again.")
    }
    setBusy(false)
    void recount()
  }

  const n = info?.cookieSites ?? 0
  const pages = info?.openPages ?? 0
  const rows: { key: keyof ClearBrowsingData; icon: JSX.Element; label: string; detail: string }[] = [
    {
      key: 'cookies',
      icon: <IconCookie className="h-4 w-4" />,
      label: 'Cookies and site data',
      detail:
        n === 0 ? 'Nothing stored.' : `Stored for ${n} ${plural(n, 'site', 'sites')}. Signs you out of ${plural(n, 'it', 'them')}.`
    },
    { key: 'cache', icon: <IconImage className="h-4 w-4" />, label: 'Cached images and files', detail: cacheDetail(info?.cacheBytes ?? 0) },
    {
      key: 'history',
      icon: <IconHistory className="h-4 w-4" />,
      label: 'Page history',
      detail:
        pages === 0
          ? 'No pages open.'
          : `Back and forward for ${pages === 1 ? 'the open page' : `${pages} open pages`}. Clui keeps no other history.`
    }
  ]

  return (
    <section className="flex flex-col gap-2" aria-labelledby={`${id}-data`}>
      <div className="flex min-h-7 items-center gap-2">
        <h3 id={`${id}-data`} className="text-ui font-semibold text-content">
          Browsing data
        </h3>
        <button
          ref={triggerRef}
          type="button"
          data-ui="clear-data"
          aria-expanded={open}
          aria-controls={`${id}-panel`}
          aria-disabled={unavailable || undefined}
          aria-describedby={`${id}-desc`}
          className={`${CONTROL_BTN} ml-auto`}
          onClick={() => {
            if (unavailable || busy) return
            if (open) return collapse()
            setWhat({ cookies: true, cache: true, history: true })
            setOpen(true)
          }}
        >
          Clear browsing data
        </button>
      </div>
      <p id={`${id}-desc`} className="text-meta text-dim">
        {description}
      </p>
      {open && (
        <div id={`${id}-panel`} role="group" aria-labelledby={`${id}-data`} className="my-1 flex flex-col gap-2.5 rounded-md bg-tool p-3">
          <div className="flex flex-col">
            {rows.map((r, i) => (
              <button
                key={r.key}
                ref={i === 0 ? firstRowRef : undefined}
                type="button"
                role="checkbox"
                aria-checked={what[r.key]}
                aria-disabled={busy || undefined}
                aria-describedby={`${id}-${r.key}`}
                onClick={() => {
                  if (!busy) setWhat((w) => ({ ...w, [r.key]: !w[r.key] }))
                }}
                className="group flex min-h-11 w-full items-start gap-3 rounded-md px-2 py-2 text-left -outline-offset-2 pointer-fine:hover:bg-[var(--color-row-hover)]"
              >
                <span className="mt-0.5 shrink-0 text-dim">{r.icon}</span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-label text-content">{r.label}</span>
                  <span id={`${id}-${r.key}`} className="text-meta text-dim">
                    {r.detail}
                  </span>
                </span>
                <span
                  className={`mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-[4px] border transition-colors duration-150 ${
                    what[r.key]
                      ? 'border-accent bg-accent/15 text-accent'
                      : 'border-control-edge text-transparent group-hover:border-border-strong'
                  }`}
                >
                  <IconCheck className="h-3 w-3" />
                </span>
              </button>
            ))}
          </div>
          <p className="text-meta text-dim">Saved logins and approved sites stay. Open pages reload.</p>
          {blocked && (
            <p id={`${id}-blocked`} className="text-meta text-dim">
              Unavailable while Claude is using the browser. Wait until it&apos;s done, or press Stop.
            </p>
          )}
          {failed && <FieldError id={`${id}-err`} text="Couldn't clear browsing data. Try again." />}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              aria-disabled={busy || undefined}
              className={CONTROL_BTN}
              onClick={() => {
                if (!busy) collapse()
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              data-ui="clear-data-delete"
              aria-disabled={none || blocked || undefined}
              aria-busy={busy || undefined}
              aria-describedby={blocked ? `${id}-blocked` : failed ? `${id}-err` : undefined}
              className={`btn-primary inline-flex h-7 items-center px-2.5 py-0 text-label font-semibold aria-disabled:cursor-default aria-disabled:bg-bg-raised aria-disabled:text-faint aria-disabled:hover:bg-bg-raised ${busy ? 'pointer-events-none opacity-60' : ''}`}
              onClick={() => void del()}
            >
              Delete data
            </button>
          </div>
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
    </section>
  )
}

/** Add or edit a saved login. An edit never shows the stored password: leaving it blank keeps it.
 *  Field values stay in this component; the password goes to main in the save call only. */
function LoginForm({
  edit,
  onCancel,
  onSaved
}: {
  edit: SavedLoginInfo | null
  onCancel: () => void
  onSaved: () => void
}): JSX.Element {
  const [site, setSite] = useState(edit?.site ?? '')
  const [username, setUsername] = useState(edit?.username ?? '')
  const [password, setPassword] = useState('')
  const [seed, setSeed] = useState('')
  const [reveal, setReveal] = useState(false)
  const [touched, setTouched] = useState({ site: false, username: false, password: false })
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const id = useId()

  const normalized = normalizeSite(site)
  const siteErr = touched.site && !normalized
  const userErr = touched.username && !username.trim()
  // Required when adding; on edit a blank password keeps the stored one.
  const passErr = !edit && touched.password && !password

  const submit = async (): Promise<void> => {
    setTouched({ site: true, username: true, password: true })
    if (!normalized || !username.trim() || (!edit && !password) || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      await window.clui.browserSaveLogin({
        ...(edit ? { id: edit.id } : {}),
        site: normalized,
        username: username.trim(),
        ...(password ? { password } : {}),
        ...(seed.trim() ? { totpSeed: seed.trim() } : {})
      })
      onSaved()
    } catch (e) {
      setSaving(false)
      setSaveError(e instanceof Error ? e.message : "Couldn't save the login.")
    }
  }
  const onEnter = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <div className="my-1 flex flex-col gap-2.5 rounded-md bg-tool p-3">
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-site`} className="text-meta text-dim">
          Site
        </label>
        <input
          id={`${id}-site`}
          spellCheck={false}
          autoComplete="off"
          value={site}
          onChange={(e) => setSite(e.target.value)}
          onBlur={() => {
            setTouched((t) => ({ ...t, site: true }))
            if (normalized) setSite(normalized)
          }}
          onKeyDown={onEnter}
          aria-invalid={siteErr || undefined}
          aria-describedby={`${id}-site-hint`}
          className={`${LOGIN_INPUT} font-mono`}
        />
        {siteErr ? (
          <FieldError id={`${id}-site-hint`} text="Enter a site like github.com" />
        ) : (
          <p id={`${id}-site-hint`} className="text-meta text-dim">
            {normalized ? `Fills on ${normalized} only. Subdomains need their own login.` : "Enter the site's address, like github.com."}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-user`} className="text-meta text-dim">
          Username
        </label>
        <input
          id={`${id}-user`}
          autoComplete="off"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, username: true }))}
          onKeyDown={onEnter}
          aria-invalid={userErr || undefined}
          aria-describedby={userErr ? `${id}-user-err` : undefined}
          className={LOGIN_INPUT}
        />
        {userErr && <FieldError id={`${id}-user-err`} text="Enter a username" />}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-pass`} className="text-meta text-dim">
          Password
        </label>
        <div className="relative">
          <input
            id={`${id}-pass`}
            type={reveal ? 'text' : 'password'}
            autoComplete="new-password"
            spellCheck={false}
            placeholder={edit ? 'Unchanged' : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, password: true }))}
            onKeyDown={onEnter}
            aria-invalid={passErr || undefined}
            aria-describedby={passErr ? `${id}-pass-err` : undefined}
            className={`${LOGIN_INPUT} pr-9 placeholder:text-dim`}
          />
          <RevealButton pressed={reveal} onToggle={() => setReveal((r) => !r)} />
        </div>
        {passErr && <FieldError id={`${id}-pass-err`} text="Enter a password" />}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-seed`} className="text-meta text-dim">
          One-time code secret (optional)
        </label>
        <input
          id={`${id}-seed`}
          autoComplete="off"
          spellCheck={false}
          value={seed}
          onChange={(e) => setSeed(e.target.value)}
          onKeyDown={onEnter}
          aria-describedby={`${id}-seed-hint`}
          className={`${LOGIN_INPUT} font-mono`}
        />
        <p id={`${id}-seed-hint`} className="text-meta text-dim">
          The setup key from the site&apos;s authenticator screen, not a 6-digit code.
        </p>
      </div>
      <div className="flex items-center justify-end gap-2">
        {saveError && (
          <p role="alert" className="mr-auto flex items-center gap-1.5 text-meta text-err">
            <IconWarn className="h-3.5 w-3.5 shrink-0" />
            {saveError}
          </p>
        )}
        <Button variant="control" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={() => void submit()} disabled={saving}>
          Save
        </Button>
      </div>
    </div>
  )
}

