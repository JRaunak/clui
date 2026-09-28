/**
 * App-wide site approvals (`<userData>/browser-sites.json`): a site the user allowed once is
 * never asked about again in any session. Denials are per session and live on the manager.
 * Shape: { "<site>": { "approvedMs": <number> } }.
 */
import { app } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ApprovedSite } from '../../shared/browser'
import { atomicWriteFile } from '../lib/atomic'

const sitesPath = (): string => join(app.getPath('userData'), 'browser-sites.json')

let cache: Map<string, number> | null = null

async function load(): Promise<Map<string, number>> {
  if (cache) return cache
  const map = new Map<string, number>()
  try {
    const parsed: unknown = JSON.parse(await readFile(sitesPath(), 'utf8'))
    if (parsed && typeof parsed === 'object') {
      for (const [site, v] of Object.entries(parsed as Record<string, unknown>)) {
        const ms = (v as { approvedMs?: unknown } | null)?.approvedMs
        if (typeof ms === 'number') map.set(site, ms)
      }
    }
  } catch {
    // Missing or corrupt: no approvals, so every site asks again.
  }
  cache = map
  return map
}

let writeChain: Promise<void> = Promise.resolve()
function persist(map: Map<string, number>): Promise<void> {
  const body = JSON.stringify(Object.fromEntries([...map].map(([site, approvedMs]) => [site, { approvedMs }])), null, 2)
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
  await persist(map)
}

export async function removeSite(site: string): Promise<void> {
  const map = await load()
  if (map.delete(site)) await persist(map)
}

/** Newest first. */
export async function listSites(): Promise<ApprovedSite[]> {
  return [...(await load())].map(([site, approvedMs]) => ({ site, approvedMs })).sort((a, b) => b.approvedMs - a.approvedMs)
}
