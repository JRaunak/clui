/**
 * Client-side attachment processing for the composer (drop-file).
 *
 * Turns a dropped/pasted/picked File into a `ProcessedAttachment` (image | document |
 * text) carrying a lean wire payload + renderer-only display metadata. All three ride
 * INLINE in the duplex stream-json user turn as Anthropic content blocks (image /
 * document / text — every kind verified live on CLI 2.1.209), so none of them touch
 * the Read tool or the workspace-cwd boundary.
 *
 * Routing (see `processDroppedFiles`):
 *  - IMAGE (png/jpeg/gif/webp) → downscale >1568px, exact bytes when in-bounds, GIFs
 *    never re-encoded → `image` block. Thumbnail preview.
 *  - PDF (application/pdf) → base64 → `document` block (the CLI ingests it; the model
 *    reads the PDF natively). Capped for cost (PDFs bill ~1.5–3k tokens/page).
 *  - TEXT-ish (.txt/.md/.csv/.json/.log/code/… by extension or text/* MIME) → decoded
 *    UTF-8, binary-sniffed (reject NUL / replacement-char garbage), size-capped →
 *    inlined as a `text` block. Mechanically identical to a paste.
 *  - Anything else (.zip, opaque binary, oversized) → a helpful ERROR (the caller
 *    surfaces it via the notice banner), never silently dropped.
 * Nothing commits until the user hits Send (staged as removable pills).
 */
import type { WireAttachment } from '../../../shared/ipc'

/** Media types the vision model accepts. */
const ACCEPTED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** Downscale target: the longest edge, in px. Matches the model's own resample. */
const MAX_EDGE = 1568
/** Thumbnail longest edge for the composer/bubble preview, in px. */
const PREVIEW_EDGE = 256
/** Hard reject above this original-file size (bytes) — 30 MB. */
const MAX_BYTES = 30 * 1024 * 1024
/** PDF hard cap (bytes) — the Anthropic document limit is 32 MB; 20 MB keeps a single
 *  turn sane on cost (a PDF bills ~1.5–3k tokens per page, every page). */
const MAX_PDF_BYTES = 20 * 1024 * 1024
/** Text file cap (bytes) — ~256 KB ≈ 64k tokens; a dropped log/csv above this should
 *  be referenced (@) or trimmed, not silently inlined (context-eviction risk). */
const MAX_TEXT_BYTES = 256 * 1024

/** Extensions treated as inlinable text (union with a `text/*` MIME sniff). Covers the
 *  common real drops: notes, data, logs, config, source. Binaries are excluded and
 *  further guarded by the NUL/replacement-char sniff in `processTextFile`. */
const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini',
  'xml', 'html', 'htm', 'css', 'log', 'env', 'sh', 'bash', 'zsh', 'py', 'rb', 'go', 'rs',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'c', 'h', 'cpp', 'hpp', 'java', 'kt', 'swift',
  'php', 'sql', 'graphql', 'vue', 'svelte', 'diff', 'patch', 'gitignore', 'dockerfile'
])

export interface ProcessedImage {
  /** Local-only key for React lists + removal. */
  id: string
  /** e.g. 'image/png'. */
  mediaType: string
  /** Base64 image bytes (NO `data:...;base64,` prefix) — the wire payload. */
  data: string
  /** Small `data:` URL for the thumbnail (renderer-only). */
  previewUrl: string
  /** Pixel dimensions of the wire image (renderer-only, for aspect + alt text). */
  w: number
  h: number
  /** Original filename, if the source had one. */
  name?: string
  /** Approx byte size of the wire payload (base64 → bytes). */
  bytes: number
}

/** Thrown for a rejected file; `message` is user-facing. */
export class ImageError extends Error {}

let idCounter = 0
function nextId(): string {
  idCounter += 1
  // Date.now/Math.random are fine in the renderer; keep it monotonic + unique.
  return `img-${Date.now().toString(36)}-${idCounter}`
}

/** Strip a data-URL down to `{ mediaType, base64 }`. */
function splitDataUrl(url: string): { mediaType: string; base64: string } {
  const comma = url.indexOf(',')
  const header = url.slice(5, url.indexOf(';')) // after "data:" up to ";base64"
  return { mediaType: header || 'application/octet-stream', base64: url.slice(comma + 1) }
}

function readAsDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result as string)
    fr.onerror = () => reject(new ImageError('Could not read the image file.'))
    fr.readAsDataURL(file)
  })
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new ImageError('That file is not a readable image.'))
    img.src = url
  })
}

/** Draw `img` into a canvas scaled to a max long edge; return a data-URL + dims. */
function renderScaled(
  img: HTMLImageElement,
  maxEdge: number,
  mediaType: string
): { url: string; w: number; h: number } {
  const longEdge = Math.max(img.naturalWidth, img.naturalHeight)
  const ratio = Math.min(1, maxEdge / longEdge)
  const w = Math.max(1, Math.round(img.naturalWidth * ratio))
  const h = Math.max(1, Math.round(img.naturalHeight * ratio))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new ImageError('Could not process the image (no canvas context).')
  ctx.drawImage(img, 0, 0, w, h)
  // JPEG re-encodes lossy (photos); png/webp stay lossless — crisp for screenshots.
  const url = mediaType === 'image/jpeg' ? canvas.toDataURL('image/jpeg', 0.9) : canvas.toDataURL(mediaType)
  return { url, w, h }
}

/**
 * Process one File into a `ProcessedImage`. Throws `ImageError` (user-facing
 * message) on an unsupported type, oversized file, or unreadable image.
 */
export async function processImageFile(file: File): Promise<ProcessedImage> {
  const mediaType = file.type
  if (!ACCEPTED.has(mediaType)) {
    throw new ImageError(
      `${file.name || 'That file'} isn't a supported image (need PNG, JPEG, GIF, or WebP).`
    )
  }
  if (file.size > MAX_BYTES) {
    throw new ImageError(`${file.name || 'That image'} is too large (max 30 MB).`)
  }

  const originalUrl = await readAsDataUrl(file)
  const img = await loadImage(originalUrl)
  const longEdge = Math.max(img.naturalWidth, img.naturalHeight)

  // Wire payload: keep exact original bytes when in-bounds OR a GIF (never re-encode
  // an animation); otherwise downscale + re-encode a still raster type.
  let wireUrl = originalUrl
  let w = img.naturalWidth
  let h = img.naturalHeight
  if (longEdge > MAX_EDGE && mediaType !== 'image/gif') {
    const scaled = renderScaled(img, MAX_EDGE, mediaType)
    wireUrl = scaled.url
    w = scaled.w
    h = scaled.h
  }

  const { mediaType: wireType, base64 } = splitDataUrl(wireUrl)

  // Preview thumbnail: a small still (first frame for GIFs) so the bubble doesn't
  // retain a full-size data-URL for the whole session. A GIF is ALWAYS flattened to
  // a still PNG even when small — otherwise a tiny-but-multi-MB animation would be
  // kept whole in the message. Non-GIFs already within the preview edge keep their
  // (small) data-URL as-is.
  let previewUrl = wireUrl
  const isGif = mediaType === 'image/gif'
  if (longEdge > PREVIEW_EDGE || isGif) {
    try {
      previewUrl = renderScaled(img, PREVIEW_EDGE, isGif ? 'image/png' : mediaType).url
    } catch {
      previewUrl = wireUrl
    }
  }

  return {
    id: nextId(),
    mediaType: wireType,
    data: base64,
    previewUrl,
    w,
    h,
    name: file.name || undefined,
    bytes: Math.round((base64.length * 3) / 4)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Generalized attachments (drop-file): image | document(PDF) | text
// ─────────────────────────────────────────────────────────────────────────────

/** A processed non-image attachment (PDF or inlined text file). Images keep their
 *  richer `ProcessedImage` shape; this union is what the composer stages + renders. */
export type ProcessedAttachment =
  | ({ kind: 'image' } & ProcessedImage)
  | { kind: 'document'; id: string; name: string; mediaType: string; data: string; bytes: number }
  | { kind: 'text'; id: string; name: string; text: string; bytes: number; lines: number }

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : name.toLowerCase()
}

/** True if decoded text contains a NUL (U+0000) or the Unicode replacement char
 *  (U+FFFD) — markers of a binary file or an invalid-UTF-8 decode. Scans a bounded
 *  prefix (binaries reveal themselves early; avoids walking a whole 256 KB string). */
function hasBinaryMarker(text: string): boolean {
  const n = Math.min(text.length, 4096)
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i)
    if (c === 0x0000 || c === 0xfffd) return true
  }
  return false
}

function readAsText(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result as string)
    fr.onerror = () => reject(new ImageError('Could not read the file.'))
    fr.readAsText(file)
  })
}

/** Base64 of a Blob (no data-URL prefix). */
async function readAsBase64(file: File | Blob): Promise<string> {
  const url = await readAsDataUrl(file)
  return url.slice(url.indexOf(',') + 1)
}

async function processPdfFile(file: File): Promise<ProcessedAttachment> {
  if (file.size > MAX_PDF_BYTES) {
    throw new ImageError(`${file.name || 'That PDF'} is too large to attach (max 20 MB).`)
  }
  const data = await readAsBase64(file)
  return {
    kind: 'document',
    id: nextId(),
    name: file.name || 'document.pdf',
    mediaType: 'application/pdf',
    data,
    bytes: Math.round((data.length * 3) / 4)
  }
}

async function processTextFile(file: File): Promise<ProcessedAttachment> {
  if (file.size > MAX_TEXT_BYTES) {
    throw new ImageError(
      `${file.name || 'That file'} is too large to inline (max 256 KB) — reference it with @ if it's in your project.`
    )
  }
  const text = await readAsText(file)
  // Binary sniff: a NUL byte (U+0000) or a Unicode replacement char (U+FFFD, what the
  // decoder emits for invalid UTF-8) means this is a renamed binary or a wrong-encoding
  // decode → inlining it would be token garbage. Reject constructively. (Codepoint
  // check, not literal chars, so it's robust to editor/encoding round-tripping.)
  if (hasBinaryMarker(text)) {
    throw new ImageError(
      `${file.name || 'That file'} doesn't look like text — Clui can only inline text files.`
    )
  }
  return {
    kind: 'text',
    id: nextId(),
    name: file.name || 'file.txt',
    text,
    bytes: text.length,
    lines: text.split('\n').length
  }
}

/** True if a file should be inlined as text (extension allowlist OR a text/* MIME). */
function isTextFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true
  if (/^(application\/(json|xml|x-yaml|x-sh)|application\/javascript)$/.test(file.type)) return true
  return TEXT_EXTS.has(extOf(file.name))
}

/**
 * Route dropped/pasted/picked files by type into `ProcessedAttachment`s, returning the
 * successes + user-facing error messages for the rest. Unsupported files are REPORTED
 * (not silently skipped) so the composer can show a helpful notice — because here the
 * user explicitly dropped a document expecting something to happen.
 */
export async function processDroppedFiles(
  files: File[]
): Promise<{ attachments: ProcessedAttachment[]; errors: string[] }> {
  const attachments: ProcessedAttachment[] = []
  const errors: string[] = []
  for (const file of files) {
    try {
      if (file.type.startsWith('image/') || ACCEPTED.has(file.type)) {
        attachments.push({ kind: 'image', ...(await processImageFile(file)) })
      } else if (file.type === 'application/pdf' || extOf(file.name) === 'pdf') {
        attachments.push(await processPdfFile(file))
      } else if (isTextFile(file)) {
        attachments.push(await processTextFile(file))
      } else {
        errors.push(
          `Can't attach ${file.name || 'that file'} — Clui inlines images, PDFs, and text files. Use @ to reference a file in your project.`
        )
      }
    } catch (e) {
      errors.push(e instanceof ImageError ? e.message : `Could not attach ${file.name || 'a file'}.`)
    }
  }
  return { attachments, errors }
}

/** Project a ProcessedAttachment to the lean wire payload sent over IPC. */
export function toWireAttachment(a: ProcessedAttachment): WireAttachment {
  switch (a.kind) {
    case 'image':
      return { kind: 'image', mediaType: a.mediaType, data: a.data }
    case 'document':
      return { kind: 'document', mediaType: a.mediaType, data: a.data }
    case 'text':
      return { kind: 'text', name: a.name, text: a.text }
  }
}
