/**
 * Escape-to-dismiss with correct nesting.
 *
 * A single document-level keydown listener drives a LIFO stack of registered
 * handlers, so pressing Esc closes only the INNERMOST open layer (e.g. a dropdown
 * inside Settings closes the dropdown, not the whole Settings modal). Each
 * component that wants Esc-to-close calls `useEscape(active, onEscape)`; the most
 * recently activated one wins, and it stops there (no cascade).
 *
 * The permission dialog intentionally does NOT use this — dismissing a security
 * decision with Esc is ambiguous (deny? cancel?), so it stays click-only.
 */
import { useEffect } from 'react'

type Handler = () => void

const stack: Handler[] = []
let listening = false

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  const top = stack[stack.length - 1]
  if (top) {
    e.preventDefault()
    e.stopPropagation()
    top()
  }
}

function ensureListener(): void {
  if (listening) return
  // Capture phase so we intercept before component-local handlers; the stack top
  // decides, then stops. (An unlayered bubble-phase listener would let multiple
  // layers all react to one Esc.)
  document.addEventListener('keydown', onKeyDown, true)
  listening = true
}

/**
 * Register `onEscape` as the top Esc handler while `active` is true.
 * @param active whether this layer is currently open
 * @param onEscape called when Esc is pressed and this layer is innermost
 */
export function useEscape(active: boolean, onEscape: Handler): void {
  useEffect(() => {
    if (!active) return
    ensureListener()
    stack.push(onEscape)
    return () => {
      const i = stack.lastIndexOf(onEscape)
      if (i !== -1) stack.splice(i, 1)
    }
  }, [active, onEscape])
}
