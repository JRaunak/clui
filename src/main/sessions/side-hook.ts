/**
 * The side chat's deny hook, run on PreToolUse and on PreSkillShellCommand (a skill's inline shell, which the CLI
 * reports as Bash). A side fork keeps every parent tool so it reads the parent's prompt cache, and this hook is
 * what makes it read-only.
 *
 * `/bin/sh` and `/usr/bin/awk` by absolute path: the packaged app can't run as Node (runAsNode fuse off) and
 * `/bin/sh` can't read a script inside app.asar, so the script is written to userData. The user's PATH, `jq` and
 * shell rc files never matter.
 */
import { join } from 'node:path'
import { SIDE_HOOK_ALLOW } from '../../shared/ipc'
import { atomicWriteFile } from '../lib/atomic'

/** Exit 2 blocks the call and hands stderr to the model as the reason, so every path except an exact allowlisted
 *  name ends in exit 2. Any other failure blocks too: session.ts sets `onFailure: 'block'`.
 *  `RS = "\001"` reads all of stdin as one record; a second `"tool_name":"` key (a tool input carrying its own)
 *  denies. */
export const SIDE_HOOK_SCRIPT = `name=$(/usr/bin/awk 'BEGIN { RS = "\\001" } { n = gsub(/"tool_name"[[:space:]]*:[[:space:]]*"/, "&"); if (n == 1 && match($0, /"tool_name"[[:space:]]*:[[:space:]]*"[A-Za-z0-9_.-]+"/)) { s = substr($0, RSTART, RLENGTH); sub(/^"tool_name"[[:space:]]*:[[:space:]]*"/, "", s); print substr(s, 1, length(s) - 1) } }')
case $name in
  ${SIDE_HOOK_ALLOW.join('|')}) exit 0 ;;
esac
echo "Side chat is read-only: \${name:-this tool} is not available here." >&2
exit 2
`

/** Written before every fork: a hook file deleted since the last one makes `sh` exit 127, which blocks every tool. */
export async function writeSideHook(userData: string): Promise<string> {
  const path = join(userData, 'side-chat-hook.sh')
  await atomicWriteFile(path, SIDE_HOOK_SCRIPT)
  return `/bin/sh '${path.replaceAll("'", `'\\''`)}'`
}
