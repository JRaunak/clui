/**
 * Read-only readers for the Customizations panel.
 *
 * Sources, in precedence order (high→low): project `<cwd>/.claude/` → user
 * `~/.claude/` → plugin marketplaces under `~/.claude/plugins/`. Everything is
 * best-effort and defensive: missing dirs/files and malformed frontmatter/JSON
 * are skipped, never thrown, so a browser always renders something.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import matter from 'gray-matter'
import type {
  AgentInfo,
  ConfigBundle,
  ConfigOrigin,
  HookInfo,
  McpServerInfo,
  SkillInfo
} from '../../shared/config'

const userClaude = (): string => join(homedir(), '.claude')

async function safeReadJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Parse a markdown file's YAML frontmatter, tolerating errors. */
async function readFrontmatter(
  path: string
): Promise<{ data: Record<string, unknown>; body: string } | null> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = matter(raw)
    return { data: parsed.data as Record<string, unknown>, body: parsed.content }
  } catch {
    return null
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

// --- Agents: <scope>/agents/*.md ---------------------------------------------

async function readAgentsIn(dir: string, origin: ConfigOrigin): Promise<AgentInfo[]> {
  const agentsDir = join(dir, 'agents')
  let files: string[]
  try {
    files = (await readdir(agentsDir)).filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }
  const out: AgentInfo[] = []
  for (const file of files) {
    const filePath = join(agentsDir, file)
    const fm = await readFrontmatter(filePath)
    if (!fm) continue
    out.push({
      name: str(fm.data.name) ?? file.replace(/\.md$/, ''),
      description: str(fm.data.description) ?? '',
      model: str(fm.data.model),
      tools: Array.isArray(fm.data.tools) ? fm.data.tools.join(', ') : str(fm.data.tools),
      origin,
      filePath
    })
  }
  return out
}

// --- Skills: <scope>/skills/<name>/SKILL.md ----------------------------------

async function readSkillsIn(dir: string, origin: ConfigOrigin): Promise<SkillInfo[]> {
  const skillsDir = join(dir, 'skills')
  let entries: string[]
  try {
    // A skill dir can be a symlink, which reports as a link (not a directory), so an
    // isDirectory() filter drops it. List every name; the SKILL.md read below gates.
    entries = await readdir(skillsDir)
  } catch {
    return []
  }
  const out: SkillInfo[] = []
  for (const name of entries) {
    const filePath = join(skillsDir, name, 'SKILL.md')
    const fm = await readFrontmatter(filePath)
    if (!fm) continue
    out.push({
      name: str(fm.data.name) ?? name,
      description: str(fm.data.description) ?? '',
      version: str(fm.data.version),
      origin,
      filePath
    })
  }
  return out
}

// --- Hooks: settings.json `hooks` --------------------------------------------

function parseHooks(
  settings: Record<string, unknown> | null,
  origin: ConfigOrigin,
  filePath: string
): HookInfo[] {
  const hooks = settings?.hooks
  if (!hooks || typeof hooks !== 'object') return []
  const out: HookInfo[] = []
  for (const [event, matchers] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(matchers)) continue
    for (const m of matchers) {
      if (!m || typeof m !== 'object') continue
      const entry = m as { matcher?: unknown; hooks?: unknown }
      const cmds: string[] = []
      if (Array.isArray(entry.hooks)) {
        for (const h of entry.hooks) {
          if (h && typeof h === 'object' && typeof (h as { command?: unknown }).command === 'string') {
            cmds.push((h as { command: string }).command)
          }
        }
      }
      out.push({ event, matcher: str(entry.matcher), commands: cmds, origin, filePath })
    }
  }
  return out
}

// --- MCP servers: .mcp.json / ~/.claude.json / settings.json -----------------

function parseMcpServers(
  container: Record<string, unknown> | null,
  origin: ConfigOrigin,
  filePath: string
): McpServerInfo[] {
  const servers = container?.mcpServers
  if (!servers || typeof servers !== 'object') return []
  const out: McpServerInfo[] = []
  for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
    if (!cfg || typeof cfg !== 'object') continue
    const c = cfg as { type?: unknown; url?: unknown; command?: unknown; args?: unknown }
    let transport = str(c.type) ?? (c.command ? 'stdio' : c.url ? 'http' : 'unknown')
    let target = ''
    if (str(c.command)) {
      const args = Array.isArray(c.args) ? c.args.join(' ') : ''
      target = `${str(c.command)}${args ? ' ' + args : ''}`
      transport = str(c.type) ?? 'stdio'
    } else if (str(c.url)) {
      target = str(c.url) as string
    }
    out.push({ name, transport, target, origin, filePath })
  }
  return out
}

// --- Plugin scan: marketplaces/*/plugins|external_plugins/*/{agents,skills} --

async function readPluginConfigs(): Promise<{ agents: AgentInfo[]; skills: SkillInfo[] }> {
  const root = join(userClaude(), 'plugins', 'marketplaces')
  const agents: AgentInfo[] = []
  const skills: SkillInfo[] = []
  // Offer a plugin's items only when enabled in settings.json, keyed "<plugin>@<marketplace>";
  // else a cloned-but-unenabled marketplace buries the user's own agents under dozens it can't run.
  const settings = await safeReadJson(join(userClaude(), 'settings.json'))
  const enabled = (settings?.enabledPlugins ?? {}) as Record<string, unknown>
  let marketplaces: string[]
  try {
    marketplaces = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return { agents, skills }
  }
  for (const mkt of marketplaces) {
    // Plugins live under plugins/ and external_plugins/ inside each marketplace.
    for (const group of ['plugins', 'external_plugins']) {
      const groupDir = join(root, mkt, group)
      let plugins: string[]
      try {
        plugins = (await readdir(groupDir, { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
      } catch {
        continue
      }
      for (const plugin of plugins) {
        if (enabled[`${plugin}@${mkt}`] !== true) continue
        const pluginDir = join(groupDir, plugin)
        agents.push(...(await readAgentsIn(pluginDir, 'plugin')))
        skills.push(...(await readSkillsIn(pluginDir, 'plugin')))
      }
    }
  }
  return { agents, skills }
}

/**
 * Assemble the full customization bundle for a workspace. `cwd` may be null
 * (no active session) — then only user + plugin scopes are read.
 */
export async function readConfig(cwd: string | null): Promise<ConfigBundle> {
  const user = userClaude()
  const projectClaude = cwd ? join(cwd, '.claude') : null

  // Agents + skills from project and user scopes.
  const agents: AgentInfo[] = []
  const skills: SkillInfo[] = []
  if (projectClaude && (await exists(projectClaude))) {
    agents.push(...(await readAgentsIn(projectClaude, 'project')))
    skills.push(...(await readSkillsIn(projectClaude, 'project')))
  }
  agents.push(...(await readAgentsIn(user, 'user')))
  skills.push(...(await readSkillsIn(user, 'user')))
  const plugin = await readPluginConfigs()
  agents.push(...plugin.agents)
  skills.push(...plugin.skills)

  // Hooks: project settings, then user settings.
  const hooks: HookInfo[] = []
  if (projectClaude) {
    for (const f of ['settings.json', 'settings.local.json']) {
      const p = join(projectClaude, f)
      hooks.push(...parseHooks(await safeReadJson(p), 'project', p))
    }
  }
  const userSettings = join(user, 'settings.json')
  hooks.push(...parseHooks(await safeReadJson(userSettings), 'user', userSettings))

  // MCP servers: project .mcp.json + settings, user ~/.claude.json + settings.
  const mcpServers: McpServerInfo[] = []
  if (cwd) {
    const projMcp = join(cwd, '.mcp.json')
    mcpServers.push(...parseMcpServers(await safeReadJson(projMcp), 'project', projMcp))
  }
  if (projectClaude) {
    const p = join(projectClaude, 'settings.json')
    mcpServers.push(...parseMcpServers(await safeReadJson(p), 'project', p))
  }
  const dotClaude = join(homedir(), '.claude.json')
  mcpServers.push(...parseMcpServers(await safeReadJson(dotClaude), 'user', dotClaude))
  mcpServers.push(...parseMcpServers(await safeReadJson(userSettings), 'user', userSettings))

  return {
    agents: dedupeByName(agents),
    skills: dedupeByName(skills),
    hooks,
    mcpServers: dedupeMcp(mcpServers)
  }
}

/** Keep the highest-precedence entry per name (project > user > plugin). */
function dedupeByName<T extends { name: string; origin: ConfigOrigin }>(items: T[]): T[] {
  const rank: Record<ConfigOrigin, number> = { project: 0, user: 1, plugin: 2 }
  const best = new Map<string, T>()
  for (const item of items) {
    const cur = best.get(item.name)
    if (!cur || rank[item.origin] < rank[cur.origin]) best.set(item.name, item)
  }
  return [...best.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function dedupeMcp(items: McpServerInfo[]): McpServerInfo[] {
  const rank: Record<ConfigOrigin, number> = { project: 0, user: 1, plugin: 2 }
  const best = new Map<string, McpServerInfo>()
  for (const item of items) {
    const cur = best.get(item.name)
    if (!cur || rank[item.origin] < rank[cur.origin]) best.set(item.name, item)
  }
  return [...best.values()].sort((a, b) => a.name.localeCompare(b.name))
}
