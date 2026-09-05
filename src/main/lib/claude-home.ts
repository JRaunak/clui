/**
 * The effective Claude config directory.
 *
 * Honors `CLAUDE_CONFIG_DIR` (the CLI's documented override) so Clui's own readers
 * (session history, settings, customizations, tasks) resolve the SAME tree the spawned
 * `claude` child does (it inherits the var via `process.env`), instead of hardcoding
 * `~/.claude`. Without this, a user who points the CLI at an alternate root would see
 * Clui list/inherit/export/delete from one tree while sessions ran against another.
 *
 * Resolved from `process.env`, the same source the child spawn inherits. (`~/.claude.json`,
 * the separate legacy sibling file, is not relocated by this override and is read directly.)
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export function claudeHome(): string {
  const override = process.env.CLAUDE_CONFIG_DIR
  return override && override.trim() ? override : join(homedir(), '.claude')
}
