// The images a composer attachment inlines. A drop knows a file's MIME type; a picked path only has its name, so
// main reads the type off the extension and both land on the same set.
const IMAGE_MIME = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp']
])

export const IMAGE_TYPES: ReadonlySet<string> = new Set(IMAGE_MIME.values())

export const MAX_IMAGE_BYTES = 30 * 1024 * 1024

export function imageMime(path: string): string | null {
  const dot = path.lastIndexOf('.')
  return dot > path.lastIndexOf('/') ? (IMAGE_MIME.get(path.slice(dot + 1).toLowerCase()) ?? null) : null
}
