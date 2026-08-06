/**
 * The composer's `/` menu (dynamic discovery, curated).
 *
 * DESIGN (chosen after researching Cursor/Copilot/Zed AND Claude Desktop): a GUI over
 * an engine should CURATE, not mirror, the engine's command list. Anthropic's own Chat
 * app exposes ZERO raw CLI commands (it maps them to native controls); and where the
 * CLI's raw list DID bleed into a GUI (claude.ai/code remote-control), TUI-only commands
 * silently fell through as plain-text prose (GH #28379). So Clui surfaces a small
 * ALLOWLIST of commands that are (a) verified to work over the headless stdin pipe and
 * (b) not already owned by a Clui-native control.
 *
 * But the allowlist is HYDRATED from the CLI's live `initialize` command list
 * (`resolveSlashCommands`): descriptions + argument hints come from the CLI (so they
 * never drift / go stale), and an allowlisted command that VANISHES from the live list
 * is dropped automatically. When the live list hasn't arrived yet (pre-handshake), we
 * fall back to the bundled defaults so the menu is never empty.
 *
 * EXCLUDED on purpose (Clui owns these natively, or they no-op/mislead over the pipe):
 *   /model, /effort        → the composer's model+effort picker + Ultra toggle
 *   /clear, /resume        → New Session button + the sessions sidebar
 *   /config, /mcp-ui, /vim, /terminal-setup, /doctor, /debug, /insights, /recap,
 *   /agents (removed), /login, /status, /help, __remote-workflow, /rewind …
 *                          → TUI-chrome / server-only / diagnostic — meaningless or
 *                            broken through Clui's pipe (verified live).
 */
import type { SlashCommandInfo } from '../../../shared/events'

export interface SlashCommand {
  /** The command name WITHOUT the leading slash (e.g. "compact"). */
  name: string
  description: string
}

/**
 * The curated allowlist: command names Clui surfaces in the `/` menu. Each is verified
 * to actually DO something over the headless stdin pipe and to not duplicate a
 * Clui-native control. Adding a name here surfaces it IF the live CLI list also has it.
 */
export const HEADLESS_SAFE_COMMANDS: readonly string[] = [
  'compact', // free up context (also offered via the ContextRing markers)
  'context', // native card (CommandOutput ContextCard)
  'usage', // native card (UsageCard)
  'init', // analyze the codebase → CLAUDE.md
  'code-review', // review a PR / the working diff (canonical name; `review` is its alias pre-2.1.223)
  'mcp' // manage MCP servers (reconnect/enable/disable) — no Clui-native equivalent
]

/** Bundled fallback descriptions, used only until the live list arrives (pre-handshake)
 *  or if the live list somehow lacks an allowlisted name. Live descriptions win. */
export const BUILTIN_SLASH_COMMANDS: SlashCommand[] = [
  { name: 'compact', description: 'Summarize the conversation so far to free up context' },
  { name: 'context', description: 'Show current context-window usage' },
  { name: 'usage', description: 'Show cost, duration, and token totals' },
  { name: 'init', description: 'Analyze the codebase and create a CLAUDE.md' },
  { name: 'code-review', description: 'Review the current changes' }
]

/**
 * Resolve the `/` menu's commands: the allowlist, hydrated from the CLI's live list when
 * available (real descriptions + arg hints, auto-pruned if a command disappears), else
 * the bundled fallback. Order follows the allowlist so the menu is stable.
 */
export function resolveSlashCommands(live: SlashCommandInfo[]): SlashCommand[] {
  if (live.length === 0) {
    // Pre-handshake: show the bundled defaults (filtered to the allowlist for safety).
    return BUILTIN_SLASH_COMMANDS.filter((c) => HEADLESS_SAFE_COMMANDS.includes(c.name))
  }
  // Index aliases too, so a command the CLI renamed (keeping the old name as an alias)
  // still resolves instead of being pruned as missing.
  const byName = new Map<string, SlashCommandInfo>()
  for (const c of live) {
    byName.set(c.name, c)
    for (const alias of c.aliases ?? []) if (!byName.has(alias)) byName.set(alias, c)
  }
  const fallback = new Map(BUILTIN_SLASH_COMMANDS.map((c) => [c.name, c.description]))
  const out: SlashCommand[] = []
  for (const name of HEADLESS_SAFE_COMMANDS) {
    const info = byName.get(name)
    if (!info) continue // allowlisted but not in the live list, even via alias (CLI dropped it) → skip
    const desc = info.description || fallback.get(name) || ''
    // Append the argument hint so the menu teaches the syntax (e.g. "manage MCP … [reconnect|…]").
    const hint = info.argumentHint ? `${desc} · ${info.argumentHint}` : desc
    out.push({ name, description: hint })
  }
  return out
}
