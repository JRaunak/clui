/**
 * LibreOffice's conversion of Office files to PDF, and of OpenDocument spreadsheets to XLSX. soffice runs headless on a
 * private copy in its own job directory, with Clui's own profile, never the user's. Its exit code doesn't say the input
 * was a document (garbage converts to a page of text), so main's pre-flight is the only damage gate and success is
 * exit 0 plus the expected file in a fresh outdir.
 */
import { execFile, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, constants, mkdir, open, readdir, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { basename, delimiter, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CHUNK_MAX } from '../../shared/files'
import type { LoResult, LoState } from '../../shared/office'
import type { Read } from './zip'

export const SOFFICE_APP = '/Applications/LibreOffice.app/Contents/MacOS/soffice'
export const TIMEOUT_MS = 60_000
const VERSION_MS = 10_000
// ponytail: 32 newest derivatives by mtime, size-bound the cache dir if image-heavy decks fill the disk
const CACHE_MAX = 32
/** Page N is slide N, hidden slides included, since PowerPoint and the file's own order number them that way. */
export const IMPRESS_PDF = 'pdf:impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"}}'

// Writer Link 0 never loads a linked file; 2 and 3 can. SecureURL stays empty, since it's a trust list that reopens
// links. Impress has no VBA Executable key.
export const PROFILE_XCU = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>1</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Filter/Import/VBA"><prop oor:name="Load" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Filter/Import/VBA"><prop oor:name="Executable" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Filter/Import/VBA"><prop oor:name="Load" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Filter/Import/VBA"><prop oor:name="Executable" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Office.Impress/Filter/Import/VBA"><prop oor:name="Load" oor:op="fuse"><value>false</value></prop></item>
</oor:items>
`

const MACHO = new Set(['feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca'])
const runnable = (p: string): Promise<boolean> => access(p, constants.X_OK).then(() => true, () => false)
async function machO(p: string): Promise<boolean> {
  const f = await open(p, 'r').catch(() => null)
  if (!f) return false
  try {
    const b = Buffer.alloc(4)
    const { bytesRead } = await f.read(b, 0, 4, 0)
    return bytesRead === 4 && MACHO.has(b.toString('hex'))
  } finally {
    await f.close()
  }
}

/**
 * Where soffice is: the app bundle, then the user's own Applications folder, then a PATH hit resolved through its
 * links, used only when that is the real binary. Homebrew's `soffice` is a bash wrapper in a versioned Caskroom
 * directory that `brew upgrade` deletes, so it never qualifies.
 */
export async function findSoffice(home: string, pathEnv = '', app = SOFFICE_APP): Promise<string | null> {
  for (const p of [app, join(home, 'Applications/LibreOffice.app/Contents/MacOS/soffice')]) if (await runnable(p)) return p
  for (const d of pathEnv.split(delimiter).filter(Boolean)) {
    const real = await realpath(join(d, 'soffice')).catch(() => null)
    if (real && (await runnable(real)) && (await machO(real))) return real
  }
  return null
}

/** A LibreOffice PDF's page count from its page dictionaries, which its writer never packs into object streams. */
export const pdfPages = (pdf: Buffer): number => (pdf.toString('latin1').match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length

/** The `{version}` in `LibreOffice 26.8.2.2 9dea…`: the second token; the build hash is never shown. */
export const versionOf = (out: string): string | null => /^LibreOffice\s+(\d[\w.]*)/m.exec(out)?.[1] ?? null

type Job = {
  key: string
  name: string
  tickets: Map<string, (s: LoState) => void>
  state: LoState | null
  /** Kills a running soffice and settles its run at once, as execFile's own timeout does. */
  kill: (() => void) | null
  cancelled: boolean
  done: Promise<LoResult & { file?: string }>
}
export type Converted = LoResult & { file?: string }
export interface ConvertAsk {
  path: string
  revision: string
  size: number
  read: Read
  to: 'pdf' | 'xlsx'
  slides: boolean
  /** Skip the cached derivative and convert again, as after its pages couldn't be read. */
  fresh?: boolean
}

/**
 * The converter: discovery, one conversion at a time (a second run on one profile exits 1 silently), a 60s limit with
 * SIGKILL, and jobs shared by every tab that asks for the same revision, cancelled only when the last one leaves.
 * Derivatives are cached on disk by the source's bytes, the converter's version and the filter, so a touched file
 * with the same bytes and a restart both hit, and an upgrade of LibreOffice misses.
 */
export function soffices(o: { dir: string; home: string; pathEnv?: string; seam?: string; app?: string; timeoutMs?: number }) {
  const profile = join(o.dir, 'profile')
  const cache = join(o.dir, 'cache')
  const jobsDir = join(o.dir, 'jobs')
  let found: { bin: string; version: string } | null = null
  let seeded = false
  const jobs = new Map<string, Job>()
  let slot: Job | null = null
  const queue: { job: Job; go: (ok: boolean) => void }[] = []

  const env = (): string => `-env:UserInstallation=${pathToFileURL(profile).href}`
  const lookup = async (): Promise<{ bin: string; version: string } | null> => {
    if (found && (await runnable(found.bin))) return found
    found = null
    const bin = o.seam ?? (await findSoffice(o.home, o.pathEnv, o.app))
    if (!bin || !(await runnable(bin))) return null
    const out = await new Promise<string>((res) => execFile(bin, [env(), '--version'], { timeout: VERSION_MS, killSignal: 'SIGKILL' }, (e, stdout) => res(e ? '' : String(stdout))))
    const version = versionOf(out)
    return version ? (found = { bin, version }) : null
  }

  const tell = (j: Job, s: LoState): void => {
    j.state = s
    for (const f of j.tickets.values()) f(s)
  }
  const take = (j: Job): Promise<boolean> => {
    if (!slot) {
      slot = j
      return Promise.resolve(true)
    }
    tell(j, { t: 'waiting', other: slot.name })
    return new Promise((go) => queue.push({ job: j, go }))
  }
  const give = (): void => {
    slot = null
    const next = queue.shift()
    if (!next) return
    slot = next.job
    for (const w of queue) tell(w.job, { t: 'waiting', other: slot.name })
    next.go(true)
  }

  /** A private copy of one revision and the sha256 of its bytes; null when the file changed under the reads. */
  const copyOut = async (to: string, a: ConvertAsk): Promise<string | null> => {
    const h = createHash('sha256')
    const parts: Buffer[] = []
    for (let at = 0; at < a.size; at += CHUNK_MAX) {
      const b = await a.read(at, Math.min(CHUNK_MAX, a.size - at))
      if (!b) return null
      h.update(b)
      parts.push(b)
    }
    await writeFile(to, Buffer.concat(parts), { mode: 0o600 })
    return h.digest('hex').slice(0, 32)
  }
  const trim = async (): Promise<void> => {
    const names = await readdir(cache).catch(() => [] as string[])
    if (names.length <= CACHE_MAX) return
    const aged = await Promise.all(names.map(async (n) => ({ n, t: (await stat(join(cache, n)).catch(() => null))?.mtimeMs ?? 0 })))
    aged.sort((a, b) => a.t - b.t)
    await Promise.all(aged.slice(0, aged.length - CACHE_MAX).map(({ n }) => rm(join(cache, n), { force: true })))
  }

  const run = async (j: Job, a: ConvertAsk): Promise<Converted> => {
    const lo = await lookup()
    if (!lo) return { ok: false, why: 'missing' }
    const dir = join(jobsDir, randomUUID())
    const ext = extname(a.path).toLowerCase()
    const input = join(dir, `doc${ext}`)
    const outdir = join(dir, 'out')
    let held = false
    try {
      await mkdir(outdir, { recursive: true, mode: 0o700 })
      const hash = await copyOut(input, a)
      if (!hash) return { ok: false, why: 'changed' }
      const by = `LibreOffice ${lo.version}`
      const filter = a.to === 'xlsx' ? 'xlsx' : a.slides ? IMPRESS_PDF : 'pdf'
      const file = join(cache, `${createHash('sha256').update(`${hash}\0${by}\0${filter}`).digest('hex').slice(0, 32)}.${a.to}`)
      const version = `sha256:${hash}` as const
      if (a.fresh) await rm(file, { force: true })
      else if (await stat(file).then((s) => s.isFile(), () => false)) {
        const now = new Date()
        await utimes(file, now, now).catch(() => {})
        return { ok: true, by, version, file }
      }
      if (j.cancelled || !(await take(j))) return { ok: false, why: 'stopped' }
      held = true
      if (j.cancelled) return { ok: false, why: 'stopped' }
      tell(j, { t: 'running', startedAt: Date.now() })
      if (!seeded) {
        await mkdir(join(profile, 'user'), { recursive: true, mode: 0o700 })
        await writeFile(join(profile, 'user', 'registrymodifications.xcu'), PROFILE_XCU, { mode: 0o600 })
        seeded = true
      }
      // soffice reads `--` as an unknown option, so only an absolute input path keeps a name from reading as a switch.
      const argv = [env(), '--headless', '--norestore', '--nologo', '--nodefault', '--nolockcheck', '--convert-to', filter, '--outdir', outdir, input]
      const ran = await new Promise<'ok' | 'timeout' | 'failed'>((res) => {
        const child: ChildProcess | undefined = execFile(lo.bin, argv, { timeout: o.timeoutMs ?? TIMEOUT_MS, killSignal: 'SIGKILL' }, (e) =>
          res(!e ? 'ok' : (e as { killed?: boolean }).killed && !j.cancelled ? 'timeout' : 'failed')
        )
        j.kill = () => {
          child?.stdout?.destroy()
          child?.stderr?.destroy()
          child?.kill('SIGKILL')
          res('failed')
        }
      })
      j.kill = null
      if (j.cancelled) return { ok: false, why: 'stopped' }
      if (ran !== 'ok') return { ok: false, why: ran }
      const out = join(outdir, `doc.${a.to}`)
      if (!(await stat(out).then((s) => s.isFile() && s.size > 0, () => false))) return { ok: false, why: 'failed' }
      await mkdir(cache, { recursive: true, mode: 0o700 })
      await rename(out, file)
      await trim()
      return { ok: true, by, version, file }
    } finally {
      if (held) give()
      // A killed run leaves `.~lock.*#` and `lu*.tmp` behind in its outdir; the whole job directory goes.
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** Detaches one tab; the job stops only when no tab is left on it. */
  const stop = (ticket: string): void => {
    for (const j of jobs.values()) {
      if (!j.tickets.delete(ticket) || j.tickets.size) continue
      j.cancelled = true
      const w = queue.findIndex((q) => q.job === j)
      if (w >= 0) queue.splice(w, 1)[0].go(false)
      j.kill?.()
    }
  }

  return {
    /** soffice and its version, cached only once found: while it's missing every ask looks again, so installing it
     *  needs no restart. A cached binary that has gone is looked for once more. */
    find: lookup,
    convert(a: ConvertAsk, ticket: string, onState: (s: LoState) => void): Promise<Converted> {
      const key = `${a.path}\0${a.revision}\0${a.to}`
      const live = jobs.get(key)
      if (live && !live.cancelled && !a.fresh) {
        live.tickets.set(ticket, onState)
        if (live.state) onState(live.state)
        return live.done
      }
      const j: Job = { key, name: basename(a.path), tickets: new Map([[ticket, onState]]), state: null, kill: null, cancelled: false, done: null! }
      j.done = run(j, a).then((r) => {
        if (jobs.get(key) === j) jobs.delete(key)
        return r
      })
      jobs.set(key, j)
      return j.done
    },
    stop,
    stopAll(): void {
      for (const j of [...jobs.values()]) for (const t of [...j.tickets.keys()]) stop(t)
    }
  }
}
