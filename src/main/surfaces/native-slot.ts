/**
 * The pane's place in the window for native views. A view sits in the pane, parked, or out of the
 * window. Only one slot is shown at a time across the window: showing one hides every other.
 */
import type { BrowserWindow, WebContentsView } from 'electron'
import type { PaneBounds } from '../../shared/browser'

const PARK_SIZE = { width: 800, height: 600 }

const shown = new Set<NativeViewSlot>()

export class NativeViewSlot {
  /** The pane in CSS px as the renderer reports it, or null while it isn't laid out. */
  bounds: PaneBounds | null = null
  /** Currently children of the window (re-adding a child reorders it, so it's tracked). */
  private readonly attached = new WeakSet<WebContentsView>()
  private readonly window: () => BrowserWindow | null
  private readonly hideOwner: () => Promise<unknown>

  /** `hide` is the owner's own hide, run when another slot is shown. */
  constructor(window: () => BrowserWindow | null, hide: () => Promise<unknown>) {
    this.window = window
    this.hideOwner = hide
  }

  get shown(): boolean {
    return shown.has(this)
  }

  async show(): Promise<void> {
    for (const other of [...shown]) if (other !== this && shown.has(other)) await other.hideOwner()
    shown.add(this)
  }

  hide(): void {
    shown.delete(this)
  }

  /** The pane in window px, scaled by the window's zoom. */
  pane(): PaneBounds | null {
    const win = this.window()
    const b = this.bounds
    if (!b || !win || win.isDestroyed()) return null
    const z = win.webContents.getZoomFactor()
    return z === 1 ? b : { x: Math.round(b.x * z), y: Math.round(b.y * z), width: Math.round(b.width * z), height: Math.round(b.height * z) }
  }

  /**
   * A parked view sits with only its top-left pixel inside the window's bottom-right corner, under
   * the rounded mask: the page gets a full viewport and paints, and nobody sees it.
   */
  park(): PaneBounds | null {
    const win = this.window()
    if (!win || win.isDestroyed()) return null
    const pane = this.pane()
    const [w, h] = win.getContentSize()
    return { x: w - 1, y: h - 1, width: pane?.width ?? PARK_SIZE.width, height: pane?.height ?? PARK_SIZE.height }
  }

  /** Lays the view at `rect`, adding it to the window if it isn't a child yet, or takes it out for null. */
  place(view: WebContentsView, rect: PaneBounds | null): void {
    const win = this.window()
    if (!rect) {
      if (this.attached.has(view) && win && !win.isDestroyed()) win.contentView.removeChildView(view)
      this.attached.delete(view)
      return
    }
    if (!win || win.isDestroyed()) return
    view.setBounds(rect)
    if (!this.attached.has(view)) win.contentView.addChildView(view)
    this.attached.add(view)
  }

  holds(view: WebContentsView | null): boolean {
    return !!view && this.attached.has(view)
  }
}
