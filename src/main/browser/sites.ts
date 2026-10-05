/**
 * App-wide site approvals (`<userData>/browser-sites.json`): a site the user allowed once is
 * never asked about again in any session. Denials are per session and live on the manager.
 * Shape: { "<site>": { "approvedMs": <number> }, "localNetwork": { "<site>": { "allow": <boolean>, "atMs": <number> } } }.
 * A site key is lowercase, so "localNetwork" never collides with one, and an older Clui skips it for
 * having no approvedMs.
 */
import { app } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ApprovedSite, LocalNetSite } from '../../shared/browser'
import { atomicWriteFile } from '../lib/atomic'

const sitesPath = (): string => join(app.getPath('userData'), 'browser-sites.json')

const NET_KEY = 'localNetwork'

let cache: Map<string, number> | null = null
let netCache: Map<string, { allow: boolean; atMs: number }> | null = null

async function load(): Promise<Map<string, number>> {
  if (cache) return cache
  const map = new Map<string, number>()
  const net = new Map<string, { allow: boolean; atMs: number }>()
  try {
    const parsed: unknown = JSON.parse(await readFile(sitesPath(), 'utf8'))
    if (parsed && typeof parsed === 'object') {
      for (const [site, v] of Object.entries(parsed as Record<string, unknown>)) {
        const ms = (v as { approvedMs?: unknown } | null)?.approvedMs
        if (typeof ms === 'number') map.set(site, ms)
      }
      const decisions = (parsed as Record<string, unknown>)[NET_KEY]
      if (decisions && typeof decisions === 'object') {
        for (const [site, v] of Object.entries(decisions as Record<string, unknown>)) {
          const { allow, atMs } = (v ?? {}) as { allow?: unknown; atMs?: unknown }
          if (typeof allow === 'boolean' && typeof atMs === 'number') net.set(site, { allow, atMs })
        }
      }
    }
  } catch {
    // Missing or corrupt: no approvals, so every site asks again.
  }
  // Two loads can overlap at startup; the first to finish wins, so a write never lands on a map that was replaced.
  cache ??= map
  netCache ??= net
  return cache
}

let writeChain: Promise<void> = Promise.resolve()
function persist(): Promise<void> {
  const out: Record<string, unknown> = Object.fromEntries([...(cache ?? [])].map(([site, approvedMs]) => [site, { approvedMs }]))
  if (netCache?.size) out[NET_KEY] = Object.fromEntries(netCache)
  const body = JSON.stringify(out, null, 2)
  const next = writeChain.then(() => atomicWriteFile(sitesPath(), body))
  writeChain = next.catch(() => {})
  return next
}

export async function isApproved(site: string): Promise<boolean> {
  return (await load()).has(site)
}

/** For the synchronous navigation guard; the manager warms the cache at startup. */
export function isApprovedCached(site: string): boolean {
  return cache?.has(site) ?? false
}

export async function approve(site: string): Promise<void> {
  const map = await load()
  if (map.has(site)) return
  map.set(site, Date.now())
  await persist()
}

export async function removeSite(site: string): Promise<void> {
  const map = await load()
  if (map.delete(site)) await persist()
}

/** Newest first. */
export async function listSites(): Promise<ApprovedSite[]> {
  return [...(await load())].map(([site, approvedMs]) => ({ site, approvedMs })).sort((a, b) => b.approvedMs - a.approvedMs)
}

/** For the synchronous permission check: undefined when the site hasn't been asked, null before the cache is warm. */
export function localNetCached(site: string): boolean | undefined | null {
  return netCache ? netCache.get(site)?.allow : null
}

export async function decideLocalNet(site: string, allow: boolean): Promise<void> {
  await load()
  netCache?.set(site, { allow, atMs: Date.now() })
  await persist()
}

export async function forgetLocalNet(site: string): Promise<void> {
  await load()
  if (netCache?.delete(site)) await persist()
}

/** Newest first. */
export async function listLocalNet(): Promise<LocalNetSite[]> {
  await load()
  return [...(netCache ?? [])].map(([site, d]) => ({ site, ...d })).sort((a, b) => b.atMs - a.atMs)
}
