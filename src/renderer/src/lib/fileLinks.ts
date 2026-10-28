// Which paths in Claude's text point into the session's folder. No window here, so the suite runs it as is.
import { editorLineStyle, type FileLinkTarget } from '../../../shared/settings'

export interface Workspace {
  files: Set<string>
  dirs: Set<string>
}

/** A place in the session's folder, `rel` relative to it. */
export interface FileRef {
  rel: string
  line?: number
  endLine?: number
  /** A fragment that isn't a line, for a Markdown Preview to scroll to. */
  anchor?: string
}

export type HrefRef = { kind: 'file'; ref: FileRef } | { kind: 'outside'; path: string }

const SCHEME = /^[a-z][a-z\d+.-]*:/i
const SUFFIX = /(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?(\d+))?)$/

export function workspaceOf(files: string[]): Workspace {
  const dirs = new Set<string>()
  for (const f of files) {
    for (let i = f.indexOf('/'); i > 0; i = f.indexOf('/', i + 1)) dirs.add(f.slice(0, i))
  }
  return { files: new Set(files), dirs }
}

/** `src/a.ts:12:3`, `src/a.ts#L12` and `src/a.ts#L12-L20` → the path and its line or range. */
export function splitLineSuffix(s: string): { path: string; line?: number; endLine?: number } {
  const m = SUFFIX.exec(s)
  const line = m ? Number(m[1] ?? m[2]) : 0
  if (!m || !line) return { path: s }
  const end = m[3] ? Number(m[3]) : 0
  return { path: s.slice(0, m.index), line, ...(end > line ? { endLine: end } : {}) }
}

function segments(p: string): string[] | null {
  const out: string[] = []
  for (const x of p.split('/')) {
    if (!x || x === '.') continue
    if (x !== '..') out.push(x)
    else if (!out.pop()) return null
  }
  return out
}

/** `p` against the session's folder with `.` and `..` resolved; null when it lands outside. */
export function relativeTo(cwd: string, p: string): string | null {
  const parts = segments(p)
  if (!parts) return null
  if (!p.startsWith('/')) return parts.join('/')
  const root = segments(cwd) ?? []
  if (parts.length < root.length || root.some((x, i) => parts[i] !== x)) return null
  return parts.slice(root.length).join('/')
}

/** A file: URL, or a path with a line suffix that react-markdown's default would read as a scheme. A bare word before
 *  the colon (`javascript:1`) doesn't count; it needs a dot or a slash to look like a path. */
export const isLocalHref = (url: string): boolean => /^file:\/\//i.test(url) || /^[^:]*[./][^:]*:\d+(?::\d+)?(?:#.*)?$/.test(url)

/** A Markdown href as a place in the folder, a local path outside it, or null for anything else (web, mail,
 *  other schemes, same-document anchors), which goes to the web link handler. A relative href is relative to `base`,
 *  the linking document's folder, when there is one, else to the session's folder. */
export function resolveHref(href: string, cwd: string, base?: string): HrefRef | null {
  if (!href || href.startsWith('#') || href.startsWith('?') || href.startsWith('//')) return null
  const file = /^file:\/\/([^/]*)(\/.*)?$/i.exec(href)
  if (file && ((file[1] && file[1].toLowerCase() !== 'localhost') || !file[2])) return null
  const { path, line, endLine } = splitLineSuffix(file ? file[2] : href)
  const frag = line ? undefined : /#(.+)$/.exec(path)?.[1]
  let decoded: string
  let anchor: string | undefined
  try {
    decoded = decodeURIComponent(path.replace(/[?#].*$/, ''))
    anchor = frag && decodeURIComponent(frag)
  } catch {
    return null
  }
  if (!decoded || decoded.includes('\0') || (!file && SCHEME.test(path.replace(/%[\da-f]{2}/gi, 'x')))) return null
  const abs = base && !decoded.startsWith('/') ? `${base}/${decoded}` : decoded
  const rel = relativeTo(cwd, abs)
  if (rel === null) {
    const norm = base ? segments(abs) : null
    return { kind: 'outside', path: norm ? `/${norm.join('/')}` : decoded }
  }
  if (!rel) return null
  return { kind: 'file', ref: { rel, ...(line ? { line } : {}), ...(endLine ? { endLine } : {}), ...(anchor ? { anchor } : {}) } }
}

/** Inline code that is exactly a path in the folder's file set, never a basename guess. A folder links only when
 *  it's written with a slash, so a bare word like `src` or `test` stays code. */
export function resolveCode(text: string, cwd: string, ws: Workspace): FileRef | null {
  const exact = (s: string): string | null => {
    let p = s.startsWith('./') ? s.slice(2) : s
    if (p.startsWith('/')) {
      if (!p.startsWith(`${cwd}/`)) return null
      p = p.slice(cwd.length + 1)
    }
    if (ws.files.has(p)) return p
    const dir = p.endsWith('/') ? p.slice(0, -1) : p
    return dir.includes('/') || dir !== p ? (ws.dirs.has(dir) ? dir : null) : null
  }
  const whole = exact(text)
  if (whole) return { rel: whole }
  const { path, line, endLine } = splitLineSuffix(text)
  const rel = path !== text ? exact(path) : null
  return rel ? { rel, ...(line ? { line } : {}), ...(endLine ? { endLine } : {}) } : null
}

/** False only once the folder is listed and `rel` isn't in it; before that a link is given the benefit of the doubt. */
export const listedIn = (ws: Workspace | null, rel: string): boolean => !ws || ws.files.has(rel) || ws.dirs.has(rel)

/** Whether a click lands on the line: always in Clui, in the editor only when it takes one. */
export const lineReaches = (target: FileLinkTarget, editor: string): boolean => target === 'clui' || !!editorLineStyle(editor)

/** A tool card button's name, naming the line only where the click will land on it. */
export const openFileLabel = (name: string, line: number | undefined, target: FileLinkTarget, editor: string): string =>
  `Open ${name}${line && lineReaches(target, editor) ? ` at line ${line}` : ''}`

/** A file_path from a tool call's input, when it's inside the session's folder. */
export function toolPathIn(input: unknown, cwd: string | null): string | null {
  const p = input && typeof input === 'object' ? (input as Record<string, unknown>).file_path : undefined
  return cwd && typeof p === 'string' && p.startsWith(`${cwd}/`) && relativeTo(cwd, p) ? p : null
}
