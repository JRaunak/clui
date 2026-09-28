/**
 * Saved logins (`<userData>/browser-vault.bin`), encrypted with safeStorage. Plaintext is
 * decrypted per call and never cached, so a secret exists in main only while it is used.
 * Nothing in this file may log an entry or put a username, password or seed in an error.
 */
import { safeStorage, app } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { siteKeyOf, type SavedLoginInfo } from '../../shared/browser'
import { atomicWriteFile } from '../lib/atomic'
import { base32Decode } from './totp'

interface Entry {
  id: string
  site: string
  username: string
  password: string
  totpSeed?: string
  createdMs: number
}

const vaultPath = (): string => join(app.getPath('userData'), 'browser-vault.bin')
const UNAVAILABLE = "Saved logins need macOS Keychain access, which isn't available right now."

export function vaultAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

async function read(): Promise<Entry[]> {
  if (!vaultAvailable()) throw new Error(UNAVAILABLE)
  let bytes: Buffer
  try {
    bytes = await readFile(vaultPath())
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(safeStorage.decryptString(bytes))
  } catch {
    // Never treat an undecryptable vault as empty: the next save would overwrite it.
    throw new Error("Clui can't read the saved logins file.")
  }
  if (!Array.isArray(parsed)) throw new Error("Clui can't read the saved logins file.")
  return parsed.filter(
    (e): e is Entry =>
      !!e &&
      typeof e.id === 'string' &&
      typeof e.site === 'string' &&
      typeof e.username === 'string' &&
      typeof e.password === 'string' &&
      typeof e.createdMs === 'number'
  )
}

// Serialize read-modify-write so two saves in one tick can't drop each other's entry.
let writeChain: Promise<unknown> = Promise.resolve()
function mutate<T>(fn: (entries: Entry[]) => { entries: Entry[]; result: T }): Promise<T> {
  const next = writeChain.then(async () => {
    const { entries, result } = fn(await read())
    await atomicWriteFile(vaultPath(), safeStorage.encryptString(JSON.stringify(entries)))
    return result
  })
  writeChain = next.catch(() => {})
  return next
}

const info = (e: Entry): SavedLoginInfo => ({
  id: e.id,
  site: e.site,
  username: e.username,
  hasTotp: !!e.totpSeed,
  createdMs: e.createdMs
})

export async function listLogins(): Promise<SavedLoginInfo[]> {
  return (await read()).map(info)
}

export async function loginsForSite(site: string): Promise<SavedLoginInfo[]> {
  return (await read()).filter((e) => e.site === site).map(info)
}

export async function saveLogin(input: {
  id?: string
  site: string
  username: string
  password?: string
  totpSeed?: string
}): Promise<SavedLoginInfo> {
  const bare = input.site.trim().replace(/^https?:\/\//i, '')
  const site = bare.includes('://') ? null : siteKeyOf('https://' + bare)
  if (!site) throw new Error('Enter a site like github.com')
  const username = input.username.trim()
  if (!username) throw new Error('Enter a username')
  // An empty password or seed on an edit means "unchanged", matching the form's placeholder.
  const password = input.password || undefined
  const seed = input.totpSeed?.trim() || undefined
  if (seed && base32Decode(seed).length === 0) throw new Error('Not a base32 setup key')
  return mutate((entries) => {
    if (input.id) {
      const i = entries.findIndex((e) => e.id === input.id)
      const cur = entries[i]
      if (!cur) throw new Error('That login no longer exists.')
      // Otherwise an edit could hand a stored password to a site the user never typed it for.
      if (site !== cur.site && !password) throw new Error('Enter the password again to use this login on another site.')
      const next: Entry = { ...cur, site, username, password: password ?? cur.password, totpSeed: seed ?? cur.totpSeed }
      return { entries: entries.map((e, j) => (j === i ? next : e)), result: info(next) }
    }
    if (!password) throw new Error('Enter a password')
    const entry: Entry = { id: randomUUID(), site, username, password, totpSeed: seed, createdMs: Date.now() }
    return { entries: [...entries, entry], result: info(entry) }
  })
}

export async function removeLogin(id: string): Promise<void> {
  await mutate((entries) => ({ entries: entries.filter((e) => e.id !== id), result: undefined }))
}

/** The only function that returns a secret, and only for the site it was saved for. Called by the
 *  autofill path in main, nowhere else. */
export async function secretOf(id: string, site: string): Promise<{ username: string; password: string; totpSeed?: string } | null> {
  const e = (await read()).find((x) => x.id === id && x.site === site)
  return e ? { username: e.username, password: e.password, totpSeed: e.totpSeed } : null
}
