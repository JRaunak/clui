import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { useSession, activeSlice, type PerSessionState } from './store'
import './styles.css'

// E2E hook: lets the Playwright driver drive the store directly (the workspace
// picker is a native dialog that automation can't click). Harmless in prod — it
// only exposes the same actions the UI already calls.
const w = window as unknown as {
  __cluiStore?: typeof useSession
  __cluiActive?: () => PerSessionState | null
}
w.__cluiStore = useSession
// The active session's slice (state is keyed per session under keep-sessions-alive).
w.__cluiActive = () => activeSlice(useSession.getState())

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
