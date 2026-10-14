import { iconFor, toneOf, type FileGlyph, type IconDim } from '../lib/file-icons'
import { Svg } from './Icon'

const page = (mark?: JSX.Element): JSX.Element => (
  <>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
    <path d="M14 2v6h6" />
    {mark}
  </>
)

// Page marks sit in the body below the dog-ear (x 7 to 17, y 11 to 19), at least 2 units from the outline.
// image, lock, git and env replace the page with their own silhouette.
const GLYPH: Record<Exclude<FileGlyph, 'folder'>, JSX.Element> = {
  file: page(),
  code: page(<path d="M10.5 12 7.5 15l3 3M13.5 12l3 3-3 3" />),
  test: page(<path d="m8.5 15 2.5 2.5 4.5-5" />),
  data: page(
    <path d="M10 11h-.5A1.5 1.5 0 0 0 8 12.5v1a1 1.5 0 0 1-1 1.5 1 1.5 0 0 1 1 1.5v1A1.5 1.5 0 0 0 9.5 19h.5M14 11h.5a1.5 1.5 0 0 1 1.5 1.5v1a1 1.5 0 0 0 1 1.5 1 1.5 0 0 0-1 1.5v1a1.5 1.5 0 0 1-1.5 1.5H14" />
  ),
  style: page(<path d="M8 13.5h8M8 16.5h8M11 11l-1 8M15 11l-1 8" />),
  doc: page(<path d="M8 12h8M8 15h8M8 18h5" />),
  config: page(
    <>
      <circle cx="9.5" cy="12.5" r="1.5" />
      <path d="M11 12.5h5M8 17.5h5" />
      <circle cx="14.5" cy="17.5" r="1.5" />
    </>
  ),
  shell: page(<path d="m8 12 3 3-3 3M13 18h3" />),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none" />
      <path d="m21 15-4.3-4.3a1 1 0 0 0-1.4 0L6 21" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  git: (
    <>
      <circle cx="7" cy="18" r="2.5" />
      <circle cx="17" cy="6" r="2.5" />
      <path d="M7 3v12.5M17 8.5a8 8 0 0 1-7.6 8.4" />
    </>
  ),
  env: (
    <>
      <circle cx="7.5" cy="16.5" r="3.5" />
      <path d="m10 14 9-9M16 8l2.5 2.5M13.5 10.5l2 2" />
    </>
  )
}

const FILL = 'fill-current [fill-opacity:var(--ft-folder-fill)]'
const FOLDER = (
  <path
    className={FILL}
    d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
  />
)
// The open folder fills only its front face.
const FOLDER_OPEN = (
  <>
    <path className={FILL} stroke="none" d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4Z" />
    <path d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
  </>
)

const TONE: Record<ReturnType<typeof toneOf>, string> = {
  dim: 'text-dim',
  faint: 'text-faint',
  blue: 'text-ft-blue',
  cyan: 'text-ft-cyan',
  green: 'text-ft-green',
  yellow: 'text-ft-yellow',
  purple: 'text-ft-purple',
  pink: 'text-ft-pink',
  red: 'text-ft-red'
}

/** Always aria-hidden (Svg without a title): the row or tab already names the file. */
export function FileIcon({
  name,
  kind,
  open = false,
  dim = false,
  className = 'h-4 w-4'
}: {
  name: string
  kind: 'file' | 'folder'
  open?: boolean
  dim?: IconDim
  className?: string
}): JSX.Element {
  const { glyph, hue } = iconFor(name, kind)
  return <Svg className={`${className} shrink-0 ${TONE[toneOf(hue, dim)]}`}>{glyph === 'folder' ? (open ? FOLDER_OPEN : FOLDER) : GLYPH[glyph]}</Svg>
}
