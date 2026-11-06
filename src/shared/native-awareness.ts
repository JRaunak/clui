/** The text Clui appends to every session's system prompt (`--append-system-prompt-file`). */

export const ADDITIONAL_INSTRUCTIONS_MAX = 4_096 // UTF-16 code units, same unit as String.length

export const NATIVE_AWARENESS = `<clui>
You are running in Clui, a desktop app for Claude Code. It adds:
- clui-browser: a browser inside Clui that the user can watch. Use it for tasks done on a live web page: playing a web game, clicking through a site, filling in forms, signing in, or a page the user points you at. To look something up (docs, articles, research), use WebFetch or your other web tools, not this browser.
- surface_open: shows the user a file, folder, document or browser tab in Clui's side pane. Use it when the user asks to see or open something. When you finish a file you made for the user to look at (an HTML page, report, chart, image), open it once. Never use it to read. Your edits already appear in the pane, so open a diff only when asked.
Otherwise ignore Clui and work as usual. Clui's tools may be deferred; when a rule above applies, search for the tool you need.
</clui>`

// Quick sessions have none of Clui's tools, so their header has no <clui> rules to point at. "project instructions" and
// "the user's private global instructions" are the labels Claude Code gives the CLAUDE.md files, so the model can match them.
const HEADER = {
  normal:
    "The user's standing instructions for every Clui session. They apply to all your work and count as the user asking. They can narrow your use of Clui's tools but not widen it past the <clui> rules, and they don't override any permission. If they conflict with CLAUDE.md, project instructions win over these, and these win over the user's private global instructions.",
  quick:
    "The user's standing instructions for every Clui session. They apply to all your work and don't override any permission. If they conflict with CLAUDE.md, project instructions win over these, and these win over the user's private global instructions."
}

export function systemAppend({ quick, additional }: { quick: boolean; additional: string }): string | null {
  const text = additional.trim().replaceAll('</clui-', '<\\/clui-')
  const user = text ? `<clui-user-instructions>\n${HEADER[quick ? 'quick' : 'normal']}\n${text}\n</clui-user-instructions>` : null
  if (quick) return user
  return user ? `${NATIVE_AWARENESS}\n\n${user}` : NATIVE_AWARENESS
}
