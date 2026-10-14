/**
 * A native context menu built from renderer-supplied rows. The rows are plain data and every field
 * is checked: no roles, accelerators, submenus or callbacks cross from the renderer. The renderer
 * learns only which id was chosen and runs the action through the IPC it already uses.
 */
import { Menu, type BrowserWindow } from 'electron'
import type { ContextMenuItem } from '../shared/files'

const ITEMS_MAX = 16
const LABEL_MAX = 80
const ID = /^[a-z][a-z0-9-]{0,31}$/
// Control and format characters (bidi overrides, zero-width marks) would let a label render as something other than what it says.
const UNSAFE = /[\p{Cc}\p{Cf}]/u
const COORD_MAX = 100_000

const keysAre = (o: object, keys: string[]): boolean => {
  const own = Object.keys(o)
  return own.length === keys.length && keys.every((k) => own.includes(k))
}

/** The rows when every one is well formed, else null. Ids are unique and at least one row can be chosen. */
export function parseMenuItems(raw: unknown): ContextMenuItem[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > ITEMS_MAX) return null
  const out: ContextMenuItem[] = []
  const ids = new Set<string>()
  for (const it of raw) {
    if (typeof it !== 'object' || it === null || Object.getPrototypeOf(it) !== Object.prototype) return null
    const { type, id, label, enabled } = it as Record<string, unknown>
    if (type === 'separator') {
      if (!keysAre(it, ['type'])) return null
      out.push({ type })
      continue
    }
    if (type !== 'normal' || !keysAre(it, ['type', 'id', 'label', 'enabled'])) return null
    if (typeof id !== 'string' || !ID.test(id) || ids.has(id)) return null
    if (typeof label !== 'string' || !label.trim() || label.length > LABEL_MAX || UNSAFE.test(label)) return null
    if (typeof enabled !== 'boolean') return null
    ids.add(id)
    out.push({ type, id, label, enabled })
  }
  return out.some((i) => i.type === 'normal' && i.enabled) ? out : null
}

/** A keyboard-opened menu's anchor in window coordinates; a pointer-opened one passes nothing and opens at the cursor. */
export function parseAnchor(raw: unknown): { x: number; y: number } | null | undefined {
  if (raw === undefined || raw === null) return undefined
  const { x, y } = raw as Record<string, unknown>
  const ok = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= COORD_MAX
  return typeof raw === 'object' && keysAre(raw, ['x', 'y']) && ok(x) && ok(y) ? { x, y } : null
}

let open: { menu: Menu; win: BrowserWindow } | null = null

export function popupMenu(win: BrowserWindow, items: ContextMenuItem[], at?: { x: number; y: number }): Promise<string | null> {
  // One menu at a time: a second request closes the first, which resolves null.
  open?.menu.closePopup(open.win)
  return new Promise((resolve) => {
    const menu = Menu.buildFromTemplate(
      items.map((i) => (i.type === 'separator' ? { type: 'separator' } : { label: i.label, enabled: i.enabled, click: () => resolve(i.id) }))
    )
    open = { menu, win }
    menu.popup({
      window: win,
      ...(at ?? {}),
      callback: () => {
        if (open?.menu === menu) open = null
        // The close can be reported before the chosen item's click, so null waits a moment and a click still wins.
        setTimeout(() => resolve(null), 100)
      }
    })
  })
}
