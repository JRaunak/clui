import { SIDE_HOOK_ALLOW, type ApiProvider } from '../../../shared/ipc'

/** The tools the deny hook lets run, minus ToolSearch (plumbing) and WebSearch where the provider has none. Known at
 *  fork time: the side's own init only arrives with its first turn, after the read-only line is sent. */
export const sideToolsAtFork = (provider: ApiProvider | null): string[] =>
  SIDE_HOOK_ALLOW.filter((t) => t !== 'ToolSearch' && !(t === 'WebSearch' && provider === 'bedrock'))

/** Sent as the first line of the first side message, never in the system prompt, which would miss the cache. */
export const SIDE_READ_ONLY_LINE = 'This is a read-only side chat. Only {tools} will run here; any other tool call is denied.'

export const readOnlyLine = (tools: readonly string[]): string =>
  SIDE_READ_ONLY_LINE.replace('{tools}', tools.length > 1 ? `${tools.slice(0, -1).join(', ')} and ${tools.at(-1)}` : (tools[0] ?? ''))
