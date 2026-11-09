import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useActive, useSession } from '../store'
import { IconClose, IconExternal, IconFolderOpen } from './Icon'
import { Dropdown, type DropdownOption } from './Dropdown'
import { CheckBox, OUTLINE_BUTTON, SAVE_FAILED, describedBy, useInstantSetting } from './settings/shared'
import { FieldError } from './LoginFields'
import { HOOKS_TOKEN, agentToken, effectiveDisabled, mcpToken, toggleDisabled } from '../../../shared/settings'
import { basename, useProjectDirs } from '../lib/useProjectDirs'
import { unfirmlink } from '../lib/tree'
import { useEscape } from '../lib/useEscape'
import { useDialogFocus } from '../lib/useDialogFocus'
import { useOverlayEnter, useOverlayCovered } from '../lib/overlayOrigin'
import type { ConfigBundle, ConfigOrigin } from '../../../shared/config'

type Tab = 'agents' | 'skills' | 'hooks' | 'mcp'
const TABS: Tab[] = ['agents', 'skills', 'hooks', 'mcp']

// Scope-picker sentinels. Real scopes are absolute paths, so these can't collide.
const SCOPE_GLOBAL = '__clui_scope_global__'
const SCOPE_PICK = '__clui_scope_pick__'
const CHAT_DIR_PICKED = "That's the folder no-project sessions use. Scope: Global."
const LOCKED = 'Off in Global. Switch the scope to Global to turn it on.'
const PENDING = 'Applies to new and resumed sessions. This session keeps its current setting.'

/** One on/off control, resolved for the picked scope. `inert` is aria-disabled: settings not loaded, or locked by global.
 *  `off` is false until settings load, so an unloaded switch doesn't badge every row. */
interface Switch {
  on: boolean
  off: boolean
  inert: boolean
  status: string[]
  failed: boolean
  flip: () => void
}

/**
 * CONFIGURATION browser: the Agents / Skills / Hooks / MCP
 * servers that apply in the picked scope (one project, or Global: user + plugin), merged across
 * project > user > plugin with origin badges. Its unique job is the cross-scope precedence AUDIT + jumping to the source
 * file (the CLI scatters this across `claude agents` / `/mcp` / `/hooks`). It never writes the
 * config files: a stale writer would corrupt the user's real ~/.claude / .mcp.json (catastrophic
 * for a wrapper) and chase CLI schema drift forever. The on/off switches live in Clui's own
 * settings and reach the CLI as launch flags.
 * Entry is ⌘K-only (an infrequent read-only audit isn't persistent chrome, so it's out of
 * the sidebar). Named "Configuration" so it doesn't collide with Settings, and so the
 * skills tab stops implying it's a second invoke-door to the composer's `/` menu.
 */
export function Customizations({ onClose, covered }: { onClose: () => void; covered: boolean }): JSX.Element {
  const cwd = useActive((s) => s?.cwd ?? null)
  const chatDir = useSession((s) => s.chatDir)
  const projectDirs = useProjectDirs()
  const [scope, setScope] = useState(() => (cwd && cwd !== chatDir ? cwd : SCOPE_GLOBAL))
  const [picked, setPicked] = useState<string | null>(null)
  const [bundle, setBundle] = useState<ConfigBundle | null>(null)
  const [busy, setBusy] = useState(true)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [slow, setSlow] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const announceNext = useRef(false)
  const [tab, setTab] = useState<Tab>('agents')
  // Plugin/marketplace agents+skills are hidden by default so the panel shows YOUR
  // project+user config rather than a wall of marketplace entries (the reported
  // "marketplace dominates" problem). Toggle reveals them. Only agents/skills have a
  // plugin scope (hooks/MCP don't), so the toggle only appears on those tabs.
  const [showPlugins, setShowPlugins] = useState(false)

  const label = scopeLabel(scope)
  const all = scope === SCOPE_GLOBAL

  const disabled = useInstantSetting('disabledConfig')
  const cfg = disabled.value
  const [lastFlip, setLastFlip] = useState<string | null>(null)
  const launched = useActive((s) => s?.launchedDisabled ?? null)
  const liveMcp = useActive((s) => s?.liveMcp ?? null)
  const openSettings = useSession((s) => s.openSettings)
  const target = all ? null : scope
  // The CLI reports a symlink-resolved cwd (/private/tmp/x for /tmp/x), so either spelling is the same folder.
  const here = cwd && chatDir && sameDir(cwd, chatDir) ? chatDir : cwd
  // Global covers every session; a project covers its own.
  const sessionOff =
    cfg && here && launched && (all || sameDir(here, scope))
      ? new Set(effectiveDisabled(cfg, here, chatDir ?? '', Object.keys(cfg.projects).filter((k) => sameDir(k, here))))
      : null
  // A chat-dir session's config is the user-level bundle, so it's the one Global lists.
  const liveHere = !!here && !!liveMcp && (all ? here === chatDir : sameDir(here, scope))

  const switchFor = (token: string, name: string): Switch => {
    const globalOff = !!cfg?.global.includes(token)
    const on = !!cfg && !globalOff && !(target !== null && cfg.projects[target]?.includes(token))
    const locked = target !== null && globalOff
    const pending = !!sessionOff && !!launched && sessionOff.has(token) !== launched.includes(token)
    return {
      on,
      off: !!cfg && !on,
      inert: !cfg || locked,
      status: [...(locked ? [LOCKED] : []), ...(pending ? [PENDING] : [])],
      failed: disabled.failed && lastFlip === token,
      flip: () => {
        if (!cfg || locked) return
        disabled.set(toggleDisabled(cfg, target, token, on))
        setLastFlip(token)
        setAnnouncement(`${name} ${on ? 'off' : 'on'}.`)
      }
    }
  }
  const hooks = switchFor(HOOKS_TOKEN, 'Hooks')

  // A read that lands after a newer one started is dropped, so a slow scope can't overwrite a later pick.
  useEffect(() => {
    let live = true
    setBusy(true)
    window.clui.readConfig(scope === SCOPE_GLOBAL ? null : scope).then(
      (b) => {
        if (!live) return
        setBundle(b)
        setFailed(false)
        setBusy(false)
        if (announceNext.current) setAnnouncement(`Scope: ${scopeLabel(scope)}`)
        announceNext.current = false
      },
      () => {
        if (!live) return
        // Old rows belong to another scope; keeping their counts on the tabs would misreport this one.
        setBundle(null)
        setFailed(true)
        setBusy(false)
      }
    )
    return () => {
      live = false
    }
  }, [scope, attempt])

  const waiting = !bundle && !failed
  useEffect(() => {
    if (!waiting) return
    const t = setTimeout(() => setSlow(true), 400)
    return () => {
      clearTimeout(t)
      setSlow(false)
    }
  }, [waiting])

  const dirs = picked && !projectDirs.some((d) => sameDir(d, picked)) ? [...projectDirs, picked] : projectDirs
  const scopeOptions: DropdownOption<string>[] = [
    { value: SCOPE_GLOBAL, label: 'Global', description: 'Your user and plugin config, for every session' },
    ...dirs.map((d, i) => ({ value: d, label: basename(d), description: d, divider: i === 0 })),
    { value: SCOPE_PICK, label: 'Other folder…', icon: <IconFolderOpen className="h-4 w-4" />, divider: true }
  ]

  const changeScope = (next: string): void => {
    if (next === scope) return
    announceNext.current = true
    setScope(next)
  }

  const onSelectScope = async (v: string): Promise<void> => {
    if (v !== SCOPE_PICK) return changeScope(v)
    const dir = await window.clui.pickWorkspace()
    dialogRef.current?.querySelector<HTMLButtonElement>('[data-ui="config-scope"]')?.focus()
    if (!dir) return
    if (chatDir && sameDir(dir, chatDir)) {
      announceNext.current = false
      setScope(SCOPE_GLOBAL)
      setAnnouncement(CHAT_DIR_PICKED)
      return
    }
    // The dialog can return /private/tmp/x for a listed /tmp/x; selecting the listed spelling keeps one option and one key.
    const listed = projectDirs.find((d) => sameDir(d, dir))
    if (!listed) setPicked(dir)
    changeScope(listed ?? dir)
  }

  const retry = (): void => {
    announceNext.current = true
    setAttempt((n) => n + 1)
  }

  // Esc closes the modal (nesting-aware via the escape-stack).
  useEscape(true, onClose)
  const scrimRef = useRef<HTMLDivElement>(null)
  const dialogRef = useDialogFocus<HTMLDivElement>()
  useOverlayEnter(scrimRef, dialogRef)
  useOverlayCovered(scrimRef, covered)

  const pluginFilter = <T extends { origin: ConfigOrigin }>(items: T[]): T[] =>
    showPlugins ? items : items.filter((it) => it.origin !== 'plugin')
  const visibleAgents = bundle ? pluginFilter(bundle.agents) : []
  const visibleSkills = bundle ? pluginFilter(bundle.skills) : []
  const pluginAgentCount = bundle ? bundle.agents.filter((a) => a.origin === 'plugin').length : 0
  const pluginSkillCount = bundle ? bundle.skills.filter((s) => s.origin === 'plugin').length : 0
  const hiddenPluginCount = (tab === 'agents' ? pluginAgentCount : tab === 'skills' ? pluginSkillCount : 0)

  const counts = bundle
    ? {
        agents: visibleAgents.length,
        skills: visibleSkills.length,
        hooks: bundle.hooks.length,
        mcp: bundle.mcpServers.length
      }
    : { agents: 0, skills: 0, hooks: 0, mcp: 0 }

  const tablistRef = useRef<HTMLDivElement>(null)
  const onTabKey = (e: React.KeyboardEvent): void => {
    const at = TABS.indexOf(tab)
    const last = TABS.length - 1
    let next: number
    if (e.key === 'ArrowRight') next = at === last ? 0 : at + 1
    else if (e.key === 'ArrowLeft') next = at === 0 ? last : at - 1
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = last
    else return
    e.preventDefault()
    setTab(TABS[next])
    tablistRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }

  return (
    <div ref={scrimRef} className="fixed inset-0 z-40 flex items-center justify-center scrim">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="config-title"
        data-ui="configuration"
        className="flex h-[80vh] w-[min(760px,92%)] flex-col rounded-lg border border-border bg-bg-elev shadow-[var(--shadow-float)] outline-none"
      >
        <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-3.5">
          <div className="min-w-0">
            <div id="config-title" className="text-title text-content">
              Configuration
            </div>
            <div className="mt-0.5 text-meta text-dim">
              Turn agents, MCP servers, and hooks on or off for this scope. Changes apply to new and resumed sessions.
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Dropdown<string>
              dataUi="config-scope"
              className="w-56"
              align="right"
              solid
              ariaLabel={`Scope: ${label}`}
              menuClassName="w-72"
              value={scope}
              options={scopeOptions}
              onChange={(v) => void onSelectScope(v)}
            />
            <button
              className="rounded-md p-1 text-dim transition-colors hover:bg-bg-raised hover:text-content"
              onClick={onClose}
              title="Close"
            >
              <IconClose className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div role="status" aria-live="polite" className="sr-only">
          {announcement}
        </div>

        <div
          ref={tablistRef}
          role="tablist"
          aria-label="Configuration sections"
          onKeyDown={onTabKey}
          className="flex gap-1 border-b border-border px-3 pt-2"
        >
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              id={`config-tab-${t}`}
              aria-selected={tab === t}
              aria-controls="config-panel"
              tabIndex={tab === t ? 0 : -1}
              className={`rounded-t px-3 py-2 text-ui capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${
                tab === t
                  ? 'border-b-2 border-content font-semibold text-content'
                  : 'text-dim pointer-fine:hover:text-content'
              }`}
              onClick={() => setTab(t)}
            >
              {t === 'mcp' ? 'MCP' : t} <span className="text-dim">({counts[t]})</span>
            </button>
          ))}
        </div>

        <div
          id="config-panel"
          role="tabpanel"
          aria-labelledby={`config-tab-${tab}`}
          aria-busy={busy || undefined}
          className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
        >
          {waiting && slow && <div className="text-sm text-dim">Loading…</div>}
          {failed && (
            <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-center">
              <div className="text-ui text-content">Couldn't read the configuration for {label}.</div>
              <button type="button" className={`h-8 ${OUTLINE_BUTTON}`} onClick={retry}>
                Try again
              </button>
            </div>
          )}
          {/* Only on agents/skills, the scopes that have plugin entries. */}
          {!!bundle && (tab === 'agents' || tab === 'skills') && (hiddenPluginCount > 0 || showPlugins) && (
            <button
              className="mb-3 rounded-md border border-border px-2.5 py-1 text-label text-dim transition-colors hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              onClick={() => setShowPlugins((v) => !v)}
              aria-pressed={showPlugins}
            >
              {showPlugins
                ? 'Hide plugin / marketplace items'
                : `Show ${hiddenPluginCount} plugin / marketplace item${hiddenPluginCount === 1 ? '' : 's'}`}
            </button>
          )}
          {bundle && (
            <>
              {tab === 'agents' &&
                (visibleAgents.length ? (
                  <Groups items={visibleAgents} split={!all}>
                    {(a) => (
                      <ItemRow
                        key={a.filePath}
                        title={a.name}
                        description={a.description}
                        origin={a.origin}
                        inline={agentMeta(a.model, splitTools(a.tools).length)}
                        chips={splitTools(a.tools)}
                        onOpen={() => void window.clui.openInEditor(null, a.filePath)}
                        toggle={switchFor(agentToken(a.name), a.name)}
                      />
                    )}
                  </Groups>
                ) : (
                  <Empty
                    what="agents"
                    project={all ? null : label}
                    hint="Agents in ~/.claude/agents or an enabled plugin appear here."
                  />
                ))}
              {tab === 'skills' && (
                <p className="mb-3 text-meta text-dim">Skills can't be turned off. The CLI has no way to hide a skill from a session.</p>
              )}
              {tab === 'skills' &&
                (visibleSkills.length ? (
                  <Groups items={visibleSkills} split={!all}>
                    {(s) => (
                      <ItemRow
                        key={s.filePath}
                        title={s.name}
                        description={s.description}
                        origin={s.origin}
                        inline={s.version && `v${s.version}`}
                        onOpen={() => void window.clui.openInEditor(null, s.filePath)}
                      />
                    )}
                  </Groups>
                ) : (
                  <Empty
                    what="skills"
                    project={all ? null : label}
                    hint="Skills in ~/.claude/skills or an enabled plugin appear here."
                  />
                ))}
              {tab === 'hooks' && <HooksSwitch s={hooks} global={all} />}
              {tab === 'hooks' &&
                (bundle.hooks.length ? (
                  <Groups items={bundle.hooks} split={!all}>
                    {(h, i) => (
                      <ItemRow
                        key={`${h.event}-${i}`}
                        title={h.event}
                        description={h.matcher && `matcher: ${h.matcher}`}
                        origin={h.origin}
                        off={hooks.off}
                        commands={h.commands}
                        onOpen={h.filePath ? () => void window.clui.openInEditor(null, h.filePath) : undefined}
                      />
                    )}
                  </Groups>
                ) : (
                  <Empty
                    what="hooks"
                    project={all ? null : label}
                    hint="Hooks in ~/.claude/settings.json appear here."
                  />
                ))}
              {tab === 'mcp' &&
                (bundle.mcpServers.length ? (
                  <Groups items={bundle.mcpServers} split={!all}>
                    {(m) => (
                      <ItemRow
                        key={m.name}
                        title={m.name}
                        description={m.target}
                        mono
                        origin={m.origin}
                        inline={m.transport}
                        onOpen={m.filePath ? () => void window.clui.openInEditor(null, m.filePath) : undefined}
                        toggle={switchFor(mcpToken(m.name), m.name)}
                      />
                    )}
                  </Groups>
                ) : (
                  <Empty
                    what="MCP servers"
                    project={all ? null : label}
                    hint="MCP servers in ~/.claude.json or ~/.claude/settings.json appear here."
                  />
                ))}
              {tab === 'mcp' && liveHere && (
                <LiveMcp
                  servers={liveMcp.filter((m) => !bundle.mcpServers.some((d) => d.name === m.name))}
                  onBrowserSettings={() => {
                    openSettings('browser')
                    onClose()
                  }}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const sameDir = (a: string, b: string): boolean => unfirmlink(a) === unfirmlink(b)

function scopeLabel(scope: string): string {
  return scope === SCOPE_GLOBAL ? 'Global' : basename(scope)
}

/** Split a frontmatter `tools` string ("Read, Grep, Bash") into one label per tool. */
function splitTools(tools?: string): string[] {
  return tools ? tools.split(',').map((t) => t.trim()).filter(Boolean) : []
}

function agentMeta(model: string | undefined, tools: number): string {
  return [model, tools > 0 && `${tools} tool${tools === 1 ? '' : 's'}`].filter(Boolean).join(' · ')
}

function ItemRow({
  title,
  description,
  mono,
  origin,
  inline,
  chips = [],
  commands = [],
  onOpen,
  toggle,
  off = toggle?.off ?? false,
  status = toggle?.status ?? [],
  action
}: {
  title: string
  description?: string
  /** Render the description as code (MCP target). */
  mono?: boolean
  origin: Origin
  inline?: string
  /** Agent tools, shown as chips in the expanded body. */
  chips?: string[]
  /** Hook commands: the first on the collapsed row, all of them expanded. */
  commands?: string[]
  onOpen?: () => void
  toggle?: Switch
  off?: boolean
  /** Lines under the description; the checkbox is described by them. */
  status?: string[]
  /** Follows the status lines (the live browser row's Settings link). */
  action?: ReactNode
}): JSX.Element {
  const rowRef = useRef<HTMLDivElement>(null)
  const descRef = useRef<HTMLSpanElement>(null)
  const cmdRef = useRef<HTMLElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const bodyId = useId()
  const descId = useId()
  const statusId = useId()
  const errId = useId()

  // Overflow only exists in the clamped state, so measure while collapsed, and on every resize
  // since the modal width tracks the window. Once true it stays true: a row that stopped being
  // expandable would swap its focused button for a div.
  useEffect(() => {
    if (expanded || overflows) return
    const row = rowRef.current
    if (!row) return
    const ro = new ResizeObserver(() => {
      const d = descRef.current
      const c = cmdRef.current
      if ((!!d && d.scrollHeight > d.clientHeight) || (!!c && c.scrollWidth > c.clientWidth)) setOverflows(true)
    })
    ro.observe(row)
    return () => ro.disconnect()
  }, [expanded, overflows, description, commands[0]])

  const expandable = overflows || chips.length > 0 || commands.length > 1

  const summary = (
    <>
      <span className="flex h-5 w-3 shrink-0 items-center">
        {expandable && (
          <svg
            viewBox="0 0 12 12"
            className={`h-3 w-3 text-dim transition-transform duration-[var(--dur-fast)] motion-reduce:transition-none ${expanded ? '' : '-rotate-90'}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 4.5 6 7.5 9 4.5" />
          </svg>
        )}
      </span>
      <span className="block min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className={`truncate font-semibold ${off ? 'text-dim' : 'text-content'}`} title={title}>
            {title}
          </span>
          <Badge text={origin} ok={origin === 'project'} />
          {off && <Badge text="Off" />}
          {inline && <span className="truncate text-meta text-dim">{inline}</span>}
        </span>
        {description && (
          <span
            ref={descRef}
            id={descId}
            className={`mt-0.5 text-xs text-dim ${mono ? 'font-mono' : ''} ${expanded ? 'block' : 'line-clamp-1'}`}
          >
            {description}
          </span>
        )}
        {!expanded && commands.length > 0 && (
          <span className="mt-1 flex min-w-0 items-baseline gap-2">
            <code ref={cmdRef} className="block min-w-0 truncate font-mono text-meta text-dim">
              {commands[0]}
            </code>
            {commands.length > 1 && (
              <span className="shrink-0 text-meta text-dim">+{commands.length - 1} more</span>
            )}
          </span>
        )}
      </span>
    </>
  )

  return (
    <div ref={rowRef} className="mb-2 rounded-md border border-border bg-bg px-3 py-2">
      <div className="flex items-start gap-2">
        {expandable ? (
          <button
            type="button"
            className="flex min-w-0 flex-1 gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-controls={bodyId}
            aria-label={title}
            aria-describedby={description ? descId : undefined}
          >
            {summary}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 gap-2">{summary}</div>
        )}
        {onOpen && (
          <button
            type="button"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-dim pointer-fine:hover:bg-bg-raised pointer-fine:hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            onClick={onOpen}
            aria-label={`Open ${title} source file`}
            title="Open source file"
          >
            <IconExternal className="h-4 w-4" />
          </button>
        )}
        {toggle && (
          <button
            type="button"
            role="checkbox"
            aria-checked={toggle.on}
            aria-disabled={toggle.inert || undefined}
            aria-label={`${title} on`}
            aria-describedby={describedBy(status.length > 0 && statusId, toggle.failed && errId)}
            onClick={toggle.flip}
            className="group flex h-8 min-w-8 shrink-0 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <CheckBox checked={toggle.on} />
          </button>
        )}
      </div>
      {(status.length > 0 || action) && (
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 pl-5">
          {status.length > 0 && (
            <p id={statusId} className="text-meta text-dim">
              {status.join(' ')}
            </p>
          )}
          {action}
        </div>
      )}
      {toggle?.failed && (
        <div className="mt-1 pl-5">
          <FieldError id={errId} text={SAVE_FAILED} />
        </div>
      )}
      {expanded && (
        <div id={bodyId} className="mt-1.5 pl-5">
          {chips.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {chips.map((c) => (
                <span key={c} className="rounded bg-bg-raised px-1.5 py-0.5 text-meta text-dim">
                  {c}
                </span>
              ))}
            </div>
          )}
          {commands.length > 0 && (
            <div className="flex flex-col gap-1">
              {commands.map((m, i) => (
                <code key={i} className="block break-words font-mono text-meta text-dim">
                  {m}
                </code>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** A project scope's rows, split into This project and Global when both have any. `items` arrive sorted project-first,
 *  so the first non-project row is the cut. `i` is the index in `items`, stable across the split. */
function Groups<T extends { origin: ConfigOrigin }>({
  items,
  split,
  children
}: {
  items: T[]
  split: boolean
  children: (item: T, i: number) => ReactNode
}): JSX.Element {
  const id = useId()
  const cut = split ? items.findIndex((it) => it.origin !== 'project') : -1
  if (cut <= 0) return <>{items.map(children)}</>
  const group = (key: string, label: string, from: number, to?: number): JSX.Element => (
    <section aria-labelledby={`${id}-${key}`} className="group/sec">
      <h3 id={`${id}-${key}`} className="mb-2 mt-4 text-caps uppercase text-dim group-first/sec:mt-0">
        {label}
      </h3>
      {items.slice(from, to).map((it, j) => children(it, from + j))}
    </section>
  )
  return (
    <>
      {group('project', 'This project', 0, cut)}
      {group('global', 'Global', cut)}
    </>
  )
}

/** Where a row comes from: a config scope, or (live MCP only) Clui itself or the running session. */
type Origin = ConfigOrigin | 'clui' | 'session'

function Badge({ text, ok }: { text: string; ok?: boolean }): JSX.Element {
  return (
    <span className={`rounded border border-border px-1.5 py-0.5 text-badge capitalize ${ok ? 'text-ok' : 'text-dim'}`}>
      {text}
    </span>
  )
}

/** The whole-scope hooks switch: the CLI has one `disableAllHooks` and no per-hook control. */
function HooksSwitch({ s, global }: { s: Switch; global: boolean }): JSX.Element {
  const id = useId()
  return (
    <div className="mb-4 flex flex-col gap-1">
      <button
        type="button"
        role="checkbox"
        aria-checked={s.on}
        aria-disabled={s.inert || undefined}
        aria-describedby={describedBy(`${id}-hint`, s.status.length > 0 && `${id}-status`, s.failed && `${id}-err`)}
        onClick={s.flip}
        className="group flex items-center gap-2 self-start rounded-md py-1 pr-1 text-left"
      >
        <CheckBox checked={s.on} />
        <span className="text-label text-content group-aria-disabled:text-faint">Run hooks</span>
      </button>
      <p id={`${id}-hint`} className="text-meta text-dim">
        {global
          ? 'Off stops every hook in every session. The CLI has no per-hook switch.'
          : "Off stops every hook in this project's sessions, global hooks included. The CLI has no per-hook switch."}
      </p>
      {s.status.length > 0 && (
        <p id={`${id}-status`} className="text-meta text-dim">
          {s.status.join(' ')}
        </p>
      )}
      {s.failed && <FieldError id={`${id}-err`} text={SAVE_FAILED} />}
    </div>
  )
}

/** MCP servers the running session loaded that no config file in this scope declares. */
function LiveMcp({
  servers,
  onBrowserSettings
}: {
  servers: { name: string; status: string }[]
  onBrowserSettings: () => void
}): JSX.Element | null {
  if (!servers.length) return null
  return (
    <section aria-labelledby="config-live-mcp">
      <h3 id="config-live-mcp" className="mb-2 mt-4 text-caps uppercase text-dim">
        In this session
      </h3>
      {servers.map((m) => {
        const clui = m.name === 'clui-browser' || m.name === 'clui-surface'
        return (
          <ItemRow
            key={m.name}
            title={m.name}
            origin={clui ? 'clui' : 'session'}
            inline={m.status}
            status={[
              m.name === 'clui-browser'
                ? "Clui's browser. Turn it on or off in Settings, Browser."
                : clui
                  ? 'Built into Clui. Always on.'
                  : 'Added by this session, not a config file. Shown for reference.'
            ]}
            action={
              m.name === 'clui-browser' && (
                <button
                  type="button"
                  onClick={onBrowserSettings}
                  className="h-8 rounded-md px-2 text-label text-dim pointer-fine:hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Browser settings
                </button>
              )
            }
          />
        )
      })}
    </section>
  )
}

/* Centered empty-state: a lone top-left line stranded over a tall void reads as a
   load failure. Names where items would be discovered from, since this panel is
   read-only provenance across project → user → plugin scopes. A project scope names
   both places it looked, so the hint would only repeat them. */
function Empty({ what, project, hint }: { what: string; project: string | null; hint: string }): JSX.Element {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-1.5 text-center">
      {project ? (
        <div className="text-ui text-dim">
          No {what} in {project} or Global.
        </div>
      ) : (
        <>
          <div className="text-ui text-dim">No {what} found</div>
          <div className="max-w-xs text-xs text-faint">{hint}</div>
        </>
      )}
    </div>
  )
}
