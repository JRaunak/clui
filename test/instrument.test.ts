// Boundary: the row-state grammar, the aggregate's worst-state pick, "needs you" matching, and the
// current-turn derivation that the top-band header renders.
import { rowState, worstState, needsYouToolIdOf, turnNumberOf, currentTurnAt } from '../src/renderer/src/lib/instrument.ts'
import { equal } from './support/harness.mjs'

const tool = (o: Record<string, unknown>) => ({ id: 't', name: 'Bash', input: {}, ...o }) as never
const msg = (id: string, role: 'user' | 'assistant' | 'peer', text = '', extra: Record<string, unknown> = {}) =>
  ({ id, role, text, thinking: '', tools: [], blocks: [], ...extra }) as never

equal(rowState(tool({}), false), 'running', 'row: unresolved foreground tool is running')
equal(rowState(tool({}), true), 'needs-you', 'row: a pending permission wins over running')
equal(rowState(tool({ input: { run_in_background: true } }), false), 'launching', 'row: unresolved backgrounded tool is launching')
equal(rowState(tool({ name: 'Workflow', result: 'ok' }), false), 'launched', 'row: a finished Workflow reads launched')
equal(rowState(tool({ sentToBackground: true, result: 'ok' }), false), 'launched', 'row: sent-to-background reads launched')
equal(rowState(tool({ result: 'boom', isError: true }), false), 'failed', 'row: an error result is failed')
equal(rowState(tool({ result: 'ok' }), false), 'done', 'row: a plain result is done')

equal(worstState(['done', 'running', 'failed']), 'failed', 'worst: failed beats everything')
equal(worstState(['done', 'needs-you', 'running']), 'needs-you', 'worst: needs you beats running')
equal(worstState(['done', 'launched']), 'launched', 'worst: launched beats done')
equal(worstState([]), 'done', 'worst: an empty set reads done')

const slice = (messages: unknown[], pending: unknown[]) => ({ messages, pendingPermissions: pending }) as never
const asst = msg('a', 'assistant', '', { tools: [{ id: 'w1', name: 'Write', input: {}, result: 'ok' }, { id: 'w2', name: 'Write', input: {} }] })
equal(needsYouToolIdOf(slice([asst], [{ requestId: 'r', toolName: 'Write', input: {} }])), 'w2', 'needs-you: last unresolved same-name tool')
equal(needsYouToolIdOf(slice([asst], [])), null, 'needs-you: nothing pending')
equal(needsYouToolIdOf(slice([asst], [{ requestId: 'r', toolName: 'Bash', input: {} }])), null, 'needs-you: no name match')
equal(needsYouToolIdOf(null), null, 'needs-you: no slice')

const log = [msg('u1', 'user', 'first'), msg('a1', 'assistant'), msg('p1', 'peer', 'hi'), msg('u2', 'user', 'second\nline two'), msg('a2', 'assistant')]
equal(turnNumberOf(log, 4), 2, 'turn: two prompts up to index 4')
equal(turnNumberOf(log, 0), 1, 'turn: the first prompt is turn 1')
equal(currentTurnAt(log, 4)?.messageId, 'u2', 'current: reply row → its prompt')
equal(currentTurnAt(log, 4)?.turn, 2, 'current: carries the turn number')
equal(currentTurnAt(log, 4)?.text, 'second\nline two', 'current: preview keeps lines (the header shows line one)')
equal(currentTurnAt(log, 3), null, 'current: hidden while the prompt row itself is first visible')
equal(currentTurnAt([msg('a0', 'assistant')], 0), null, 'current: no prompt above')
equal(currentTurnAt([msg('u', 'user', '@"reviewer (agent)" check it'), msg('a', 'assistant')], 1)?.text, '@reviewer check it', 'current: agent mention tokens read as @name')
equal(currentTurnAt([msg('u', 'user', ''), msg('a', 'assistant')], 1)?.text, 'Attachments only', 'current: an attachment-only prompt still has a label')
