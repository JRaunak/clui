/** Pick the field a human most needs to see for a tool call. Shared by the permission dialog
 *  (a pending ask) and the blocked-actions notice (a past denial) so both name it the same way. */
export function highlightOf(input: unknown): { label: string; value: string } | null {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>
    if (typeof o.command === 'string') return { label: 'Command', value: o.command }
    if (typeof o.file_path === 'string') return { label: 'File', value: o.file_path }
    if (typeof o.path === 'string') return { label: 'Path', value: o.path }
    if (typeof o.url === 'string') return { label: 'URL', value: o.url }
  }
  return null
}
