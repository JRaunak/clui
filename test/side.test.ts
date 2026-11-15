// The side chat's hand-back text: which turns go, what counts as evidence, and the exact framing.
import { equal, ok } from './support/harness.mjs'

const { sideThreadText, sideTools, sideTurns, sideCounts } = await import('../src/renderer/src/lib/side.ts')

const LINE = 'This is a read-only side chat. Only Read, Grep, Glob and WebFetch will run here; any other tool call is denied.'
let id = 0
const user = (text: string): any => ({ id: `m${++id}`, role: 'user', text, thinking: '', tools: [], blocks: [] })
const tool = (name: string, input: unknown, over: Record<string, unknown> = {}): any => ({ id: `t${++id}`, name, input, result: 'ok', ...over })
/** `parts` stream in order: a string is a text run, an object a tool call. */
const reply = (parts: (string | any)[], turnEnd: any = {}, thinking = ''): any => {
  const tools = parts.filter((p) => typeof p !== 'string')
  const blocks = parts.map((p) => (typeof p === 'string' ? { kind: 'text', text: p } : { kind: 'tool', id: p.id }))
  return { id: `m${++id}`, role: 'assistant', text: parts.filter((p) => typeof p === 'string').join(''), thinking, tools, blocks, turnEnd }
}
const thread = (messages: any[]): any => ({ cwd: '/w', messages, side: { readOnly: LINE } })

const BEDROCK = sideTools(['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'ToolSearch', 'WebFetch', 'Write', 'mcp__clui-surface__surface_open'], 'bedrock')
equal(BEDROCK.join(), 'Read,Grep,Glob,WebFetch', 'tools: a parent-shaped init keeps the allowlist, in its order, without ToolSearch or Bash')
equal(sideTools([], 'bedrock').join(), 'Read,Grep,Glob,WebFetch', 'tools: no init yet falls back to the fork-time list')
equal(sideTools([], null).join(), 'Read,Grep,Glob,WebFetch,WebSearch', 'tools: an unknown provider names WebSearch')

const OPENING =
  "The user asked these questions in a side chat: a read-only fork of this conversation with the same model. It saw this conversation only up to when it was opened, and it could only use Read, Grep, Glob and WebFetch. The evidence under each answer lists what the side read: it records where the answer came from, not that the answer is right. Build on the answers instead of redoing the side's work. Read a source yourself before you edit it, when an answer conflicts with something in this conversation, or when this conversation has changed that file."

// The design's worked example, byte for byte.
const worked = thread([
  user(`${LINE}\n\nWhere does respondPermission resolve the handle?`),
  reply([
    tool('Read', { file_path: '/w/src/renderer/src/store.ts', offset: 2960, limit: 24 }),
    tool('Grep', { pattern: 'respondPermission', path: '/w/src/renderer' }),
    'It reads `activeSlice(s)`, so it always answers the active main session. A side gate would resolve against main\'s queue.'
  ], {}, 'private reasoning'),
  user('Is a can_use_tool request ever auto-denied?'),
  reply([tool('Read', { file_path: '/w/.claude/GOTCHAS.md', offset: 40, limit: 19 }), "No. Headless can_use_tool has no deadline and never auto-denies; the request waits until it's answered."])
])
const text = sideThreadText(sideTurns(worked), BEDROCK)
equal(
  text,
  `${OPENING}

Question 1: Where does respondPermission resolve the handle?

Answer 1:
It reads \`activeSlice(s)\`, so it always answers the active main session. A side gate would resolve against main's queue.

Evidence 1:
- Read src/renderer/src/store.ts, lines 2960-2983
- Grep "respondPermission" in src/renderer

Question 2: Is a can_use_tool request ever auto-denied?

Answer 2:
No. Headless can_use_tool has no deadline and never auto-denies; the request waits until it's answered.

Evidence 2:
- Read .claude/GOTCHAS.md, lines 40-58`,
  'text: the worked example, byte for byte'
)
ok(!text.includes('read-only side chat') && !text.includes('private reasoning'), 'text: the read-only line and thinking never go back')
ok(!/[–—]/.test(text) && !/verified|checked|re-check/i.test(text) && text.includes('not that the answer is right'), 'text: no dashes, never calls the thread verified')

// One turn drops the numbers; no evidence says so on one line.
const single = sideThreadText(sideTurns(thread([user('Why?'), reply(['Because.'])])), BEDROCK)
ok(single.startsWith('The user asked this question in a side chat') && single.endsWith('Question: Why?\n\nAnswer:\nBecause.\n\nEvidence: none, answered from the conversation.'), 'text: one turn is unnumbered with the none line')

// Prose either side of a tool call stays two paragraphs.
const split = sideTurns(thread([user('q'), reply(["I'll read it.  ", tool('Read', { file_path: '/w/a.ts' }), '  The store does X.'])]))
equal(split[0]?.answer, "I'll read it.\n\nThe store does X.", 'answer: text blocks trimmed and joined by a blank line')

// Evidence: only calls that ran clean, deduped, in call order; a path outside cwd stays absolute.
const denied = 'PreToolUse:WebFetch hook error: [/bin/sh x]: blocked'
const ev = sideTurns(thread([
  user('q'),
  reply([
    tool('Read', { file_path: '/w/a.ts', offset: 10, limit: 5 }),
    tool('Read', { file_path: '/w/a.ts', offset: 10, limit: 5 }),
    tool('Read', { file_path: '/w/b.ts', offset: 10 }),
    tool('Read', { file_path: '/elsewhere/c.ts', limit: 50 }),
    tool('Read', { file_path: '/w/d.ts', offset: 7, limit: 1 }),
    tool('Read', { file_path: '/w/fail.ts' }, { isError: true }),
    tool('Read', { file_path: '/w/rejected.ts' }, { isError: true, result: 'The user rejected this' }),
    tool('Read', { file_path: '/w/running.ts' }, { result: undefined }),
    tool('Read', { file_path: '/w/stopped.ts' }, { stopped: true }),
    tool('Read', { file_path: '/w/held.ts' }, { notRun: true }),
    tool('WebFetch', { url: 'https://a.example' }, { result: denied, isError: true }),
    tool('WebFetch', { url: 'https://b.example' }, { result: denied }),
    tool('Bash', { command: 'touch x' }, { isError: true, result: 'PreToolUse:Bash hook error: [/bin/sh x]: denied' }),
    tool('ToolSearch', { query: 'select:WebFetch' }),
    tool('Glob', { pattern: '**/*.ts', path: '/w/src' }),
    tool('Grep', { pattern: 'x' }),
    tool('WebFetch', { url: 'https://ok.example' }),
    tool('WebSearch', { query: 'zustand' }),
    'done'
  ])
]))[0]?.evidence
equal(
  ev?.join('\n'),
  ['Read a.ts, lines 10-14', 'Read b.ts, from line 10', 'Read /elsewhere/c.ts, lines 1-50', 'Read d.ts, line 7', 'Glob **/*.ts in src', 'Grep "x"', 'WebFetch https://ok.example', 'WebSearch "zustand"'].join('\n'),
  'evidence: clean calls only, deduped, ranges per form, denials and ToolSearch never listed'
)

// Which turns: a completed answer only. Budget, Send now, Stop, errors and the one still streaming stay out.
const turns = sideTurns(thread([
  user('stopped'),
  reply(['partial'], { reason: { kind: 'stopped' } }),
  user('budget'),
  reply(['partial'], { reason: { kind: 'budget' } }),
  user('kept'),
  reply(['yes']),
  user('streaming'),
  reply(['half'], null)
]))
equal(turns.map((t) => t.question).join(), 'kept', 'turns: only a clean, finished answer goes back')

equal(sideCounts({ openedAt: 0, answers: 1, sources: 1 }), '1 answer · 1 source', 'counts: singular')
equal(sideCounts({ openedAt: 0, answers: 2, sources: 0 }), '2 answers', 'counts: no sources says nothing about them')
