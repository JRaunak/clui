/// <reference types="vite/client" />
import type { CluiApi } from '../../shared/ipc'

declare global {
  interface Window {
    clui: CluiApi
  }
}

export {}
