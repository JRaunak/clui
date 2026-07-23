import { useEffect, useState } from 'react'
import { useActive } from '../store'
import { IconClose } from './Icon'
import { useEscape } from '../lib/useEscape'
import type { ConfigBundle, ConfigOrigin } from '../../../shared/config'

type Tab = 'agents' | 'skills' | 'hooks' | 'mcp'

/**
 * Read-only CONFIGURATION browser: the Agents / Skills / Hooks / MCP
 * servers that apply to THIS workspace, merged across project > user > plugin scopes with
 * origin badges. Its unique job is the cross-scope precedence AUDIT + jumping to the source
 * file (the CLI scatters this across `claude agents` / `/mcp` / `/hooks`). Read-only by
 * design: a stale WRITER would corrupt the user's real ~/.claude / .mcp.json (catastrophic
 * for a wrapper) and chase CLI schema drift forever; a stale reader just mis-renders a row.
 * Entry is ⌘K-only (reshaped out of the sidebar — infrequent read-only audit ≠ persistent
 * chrome). Renamed from "Customizations" so it doesn't collide with Settings, and so the
 * skills tab stops implying it's a second invoke-door to the composer's `/` menu.
 */
export function Customizations({ onClose }: { onClose: () => void }): JSX.Element {
  const cwd = useActive((s) => s?.cwd ?? null)
  const [bundle, setBundle] = useState<ConfigBundle | null>(null)
  const [tab, setTab] = useState<Tab>('agents')
  const [loading, setLoading] = useState(true)
  // Descope the noise: plugin/marketplace agents+skills are hidden by default so the
  // panel shows YOUR project+user config, not a wall of marketplace entries (the reported
  // "marketplace dominates" problem). Toggle reveals them. Only agents/skills have a
  // plugin scope (hooks/MCP don't), so the toggle only appears on those tabs.
  const [showPlugins, setShowPlugins] = useState(false)

  useEffect(() => {
    setLoading(true)
    window.clui.readConfig(cwd).then((b) => {
      setBundle(b)
      setLoading(false)
    })
  }, [cwd])

  // Esc closes the modal (nesting-aware via the escape-stack).
  useEscape(true, onClose)

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

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/50">
      <div className="flex h-[80vh] w-[min(760px,92%)] flex-col rounded-lg border border-border bg-bg-elev shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <div>
            <div className="font-serif text-lg font-semibold text-content">Configuration</div>
            <div className="mt-0.5 text-[12px] text-dim">
              What applies to this workspace, and where it comes from — read-only.
            </div>
          </div>
          <button
            className="rounded-md p-1 text-dim transition-colors hover:bg-bg-raised hover:text-content"
            onClick={onClose}
            title="Close"
          >
            <IconClose className="h-4 w-4" />
          </button>
        </div>

        {/* Null-cwd trap fix: with no active session the reader skips PROJECT scope, so the
            list would silently show only user + plugin entries (the reported "I can't see my
            project skills" confusion). Say so explicitly instead of pretending it's complete. */}
        {!loading && !cwd && (
          <div className="border-b border-info/30 bg-info/10 px-5 py-2 text-[12px] text-info">
            Global scope only — open a session to also see this workspace’s project configuration.
          </div>
        )}

        <div className="flex gap-1 border-b border-border px-3 pt-2">
          {(['agents', 'skills', 'hooks', 'mcp'] as Tab[]).map((t) => (
            <button
              key={t}
              className={`rounded-t px-3 py-2 text-[14px] capitalize ${
                tab === t
                  ? 'border-b-2 border-accent font-semibold text-content'
                  : 'text-dim hover:text-content'
              }`}
              onClick={() => setTab(t)}
            >
              {t === 'mcp' ? 'MCP' : t} <span className="text-dim">({counts[t]})</span>
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading && <div className="text-sm text-dim">Loading…</div>}
          {/* Plugin/marketplace descope toggle — only on agents/skills (the scopes that
              have plugin entries), only when some are hidden. */}
          {!loading && (tab === 'agents' || tab === 'skills') && (hiddenPluginCount > 0 || showPlugins) && (
            <button
              className="mb-3 rounded-md border border-border px-2.5 py-1 text-[12px] text-dim transition-colors hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              onClick={() => setShowPlugins((v) => !v)}
              aria-pressed={showPlugins}
            >
              {showPlugins
                ? 'Hide plugin / marketplace items'
                : `Show ${hiddenPluginCount} plugin / marketplace item${hiddenPluginCount === 1 ? '' : 's'}`}
            </button>
          )}
          {!loading && bundle && (
            <>
              {tab === 'agents' &&
                (visibleAgents.length ? (
                  visibleAgents.map((a) => (
                    <ItemRow
                      key={a.filePath}
                      title={a.name}
                      subtitle={a.description}
                      origin={a.origin}
                      meta={[a.model && `model: ${a.model}`, a.tools && `tools: ${a.tools}`]}
                      onOpen={() => void window.clui.openInEditor(a.filePath)}
                    />
                  ))
                ) : (
                  <Empty
                    what="agents"
                    hint="Agents defined in .claude/agents (project, user, or a plugin) appear here."
                  />
                ))}
              {tab === 'skills' &&
                (visibleSkills.length ? (
                  visibleSkills.map((s) => (
                    <ItemRow
                      key={s.filePath}
                      title={s.name}
                      subtitle={s.description}
                      origin={s.origin}
                      meta={[s.version && `v${s.version}`]}
                      onOpen={() => void window.clui.openInEditor(s.filePath)}
                    />
                  ))
                ) : (
                  <Empty
                    what="skills"
                    hint="Skills in .claude/skills (project, user, or a plugin) appear here."
                  />
                ))}
              {tab === 'hooks' &&
                (bundle.hooks.length ? (
                  bundle.hooks.map((h, i) => (
                    <ItemRow
                      key={`${h.event}-${i}`}
                      title={h.event}
                      subtitle={h.matcher ? `matcher: ${h.matcher}` : ''}
                      origin={h.origin}
                      meta={h.commands}
                      onOpen={h.filePath ? () => void window.clui.openInEditor(h.filePath) : undefined}
                    />
                  ))
                ) : (
                  <Empty
                    what="hooks"
                    hint="Hooks configured in settings.json (project or user) appear here."
                  />
                ))}
              {tab === 'mcp' &&
                (bundle.mcpServers.length ? (
                  bundle.mcpServers.map((m) => (
                    <ItemRow
                      key={m.name}
                      title={m.name}
                      subtitle={m.target}
                      origin={m.origin}
                      meta={[`transport: ${m.transport}`]}
                      onOpen={m.filePath ? () => void window.clui.openInEditor(m.filePath) : undefined}
                    />
                  ))
                ) : (
                  <Empty
                    what="MCP servers"
                    hint="MCP servers configured in .mcp.json or settings.json appear here."
                  />
                ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function ItemRow({
  title,
  subtitle,
  origin,
  meta,
  onOpen
}: {
  title: string
  subtitle?: string
  origin: ConfigOrigin
  meta?: (string | undefined | false)[]
  onOpen?: () => void
}): JSX.Element {
  const metaItems = (meta ?? []).filter(Boolean) as string[]
  return (
    <div className="mb-2 rounded-md border border-border bg-bg px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-content">{title}</span>
        <OriginBadge origin={origin} />
        {onOpen && (
          <button
            className="ml-auto text-[12px] text-dim hover:text-accent"
            onClick={onOpen}
            title="Open source file in editor"
          >
            open ↗
          </button>
        )}
      </div>
      {subtitle && <div className="mt-1 text-xs text-dim">{subtitle}</div>}
      {metaItems.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1">
          {metaItems.map((m, i) => (
            <code key={i} className="block break-words font-mono text-[12px] text-dim">
              {m}
            </code>
          ))}
        </div>
      )}
    </div>
  )
}

function OriginBadge({ origin }: { origin: ConfigOrigin }): JSX.Element {
  const color =
    origin === 'project' ? 'text-ok' : origin === 'user' ? 'text-accent' : 'text-dim'
  return (
    <span className={`rounded border border-border px-1.5 py-0.5 text-[11px] uppercase ${color}`}>
      {origin}
    </span>
  )
}

/* Centered empty-state (not a lone top-left line stranded over a tall void, which
   read as a load failure). Names where items would be discovered from, since this
   panel is read-only provenance across project → user → plugin scopes. */
function Empty({ what, hint }: { what: string; hint: string }): JSX.Element {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-1.5 text-center">
      <div className="font-serif text-base text-dim">No {what} found</div>
      <div className="max-w-xs text-xs text-faint">{hint}</div>
    </div>
  )
}
