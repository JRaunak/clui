/// <reference types="vite/client" />
import type { CluiApi } from '../../shared/ipc'

declare global {
  interface Window {
    clui: CluiApi
  }
}

// @types/react 18 predates the popover attributes; React 18 forwards lowercase unknown attributes to the DOM.
declare module 'react' {
  interface HTMLAttributes<T> {
    popover?: 'auto' | 'manual' | ''
  }
  interface ButtonHTMLAttributes<T> {
    popovertarget?: string
    popovertargetaction?: 'toggle' | 'show' | 'hide'
  }
}

export {}
