/**
 * Shared types for the read-only Customizations browsers:
 * Agents, Skills, Hooks, and MCP servers sourced from project + user scopes.
 */

/** Where a customization came from (for labeling + precedence). */
export type ConfigOrigin = 'project' | 'user' | 'plugin'

export interface AgentInfo {
  name: string
  description: string
  /** Model alias from frontmatter, if any. */
  model?: string
  /** Tools list from frontmatter, if any. */
  tools?: string
  origin: ConfigOrigin
  /** Absolute path to the .md file. */
  filePath: string
}

export interface SkillInfo {
  name: string
  description: string
  version?: string
  origin: ConfigOrigin
  /** Absolute path to the SKILL.md file. */
  filePath: string
}

export interface HookInfo {
  /** Event name, e.g. PreToolUse, PostToolUse, Stop. */
  event: string
  /** Matcher pattern, if present. */
  matcher?: string
  /** The hook command(s) configured. */
  commands: string[]
  origin: ConfigOrigin
  /** Which settings file it was defined in. */
  filePath: string
}

export interface McpServerInfo {
  name: string
  /** stdio | http | sse | unknown. */
  transport: string
  /** For stdio: the command; for http/sse: the URL. */
  target: string
  origin: ConfigOrigin
  /** Which config file it was defined in. */
  filePath: string
}

/** Everything the Customizations panel shows for a given workspace. */
export interface ConfigBundle {
  agents: AgentInfo[]
  skills: SkillInfo[]
  hooks: HookInfo[]
  mcpServers: McpServerInfo[]
}
