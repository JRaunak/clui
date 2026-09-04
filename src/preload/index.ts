/**
 * Preload: exposes a minimal, typed `window.clui` API to the renderer over the
 * context bridge. No Node globals leak into the renderer; every capability is an
 * explicit IPC call.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  IpcChannels,
  type CluiApi,
  type PermissionModeChoice,
  type PermissionVerdict,
  type StartSessionOptions,
  type TaggedEvent,
  type MenuAction,
  type WireAttachment
} from '../shared/ipc'
import type { CluiSettings, EffortChoice, ModelChoice, SettingsKey } from '../shared/settings'

const api: CluiApi = {
  pickWorkspace: () => ipcRenderer.invoke(IpcChannels.pickWorkspace),
  getCliInfo: () => ipcRenderer.invoke(IpcChannels.getCliInfo),
  getFullscreen: () => ipcRenderer.invoke(IpcChannels.getFullscreen),
  startSession: (opts: StartSessionOptions) =>
    ipcRenderer.invoke(IpcChannels.startSession, opts),
  sendMessage: (handleId: string, text: string, attachments?: WireAttachment[]) =>
    ipcRenderer.invoke(IpcChannels.sendMessage, handleId, text, attachments),
  interrupt: (handleId: string) => ipcRenderer.invoke(IpcChannels.interrupt, handleId),
  stopTask: (handleId: string, taskId: string) =>
    ipcRenderer.invoke(IpcChannels.stopTask, handleId, taskId),
  backgroundTask: (handleId: string, toolUseId: string) =>
    ipcRenderer.invoke(IpcChannels.backgroundTask, handleId, toolUseId),
  setPermissionMode: (handleId: string, mode: PermissionModeChoice) =>
    ipcRenderer.invoke(IpcChannels.setPermissionMode, handleId, mode),
  setModel: (handleId: string, model: ModelChoice) =>
    ipcRenderer.invoke(IpcChannels.setModel, handleId, model),
  setEffort: (handleId: string, effort: EffortChoice) =>
    ipcRenderer.invoke(IpcChannels.setEffort, handleId, effort),
  setUltracode: (handleId: string, on: boolean) =>
    ipcRenderer.invoke(IpcChannels.setUltracode, handleId, on),
  stopSession: (handleId: string) => ipcRenderer.invoke(IpcChannels.stopSession, handleId),
  respondPermission: (handleId: string, verdict: PermissionVerdict) =>
    ipcRenderer.invoke(IpcChannels.respondPermission, handleId, verdict),
  listSessions: () => ipcRenderer.invoke(IpcChannels.listSessions),
  deleteSession: (projectSlug: string, id: string) =>
    ipcRenderer.invoke(IpcChannels.deleteSession, projectSlug, id),
  renameSession: (id: string, name: string) =>
    ipcRenderer.invoke(IpcChannels.renameSession, id, name),
  readTranscript: (sessionId: string) => ipcRenderer.invoke(IpcChannels.readTranscript, sessionId),
  readAgentTranscript: (agentId: string) =>
    ipcRenderer.invoke(IpcChannels.readAgentTranscript, agentId),
  readAgentTranscriptByToolUseId: (toolUseId: string) =>
    ipcRenderer.invoke(IpcChannels.readAgentTranscriptByToolUseId, toolUseId),
  searchSessions: (query: string, queryId: number, opts?: { scopeSlug?: string; userOnly?: boolean }) =>
    ipcRenderer.invoke(IpcChannels.searchSessions, query, queryId, opts),
  warmSearchCache: () => ipcRenderer.invoke(IpcChannels.warmSearchCache),
  listWorkspaces: () => ipcRenderer.invoke(IpcChannels.listWorkspaces),
  exportSession: (sessionId: string) => ipcRenderer.invoke(IpcChannels.exportSession, sessionId),
  getSessionCosts: () => ipcRenderer.invoke(IpcChannels.getSessionCosts),
  setSessionCost: (sessionId: string, usd: number) =>
    ipcRenderer.invoke(IpcChannels.setSessionCost, sessionId, usd),
  deleteSessionCost: (sessionId: string) =>
    ipcRenderer.invoke(IpcChannels.deleteSessionCost, sessionId),
  getSessionModels: () => ipcRenderer.invoke(IpcChannels.getSessionModels),
  setSessionModel: (sessionId: string, prefs: { model?: string; effort?: string; ultracode?: boolean }) =>
    ipcRenderer.invoke(IpcChannels.setSessionModel, sessionId, prefs),
  deleteSessionModel: (sessionId: string) =>
    ipcRenderer.invoke(IpcChannels.deleteSessionModel, sessionId),
  readConfig: (cwd: string | null) => ipcRenderer.invoke(IpcChannels.readConfig, cwd),
  openInEditor: (filePath: string) => ipcRenderer.invoke(IpcChannels.openInEditor, filePath),
  openExternal: (url: string) => ipcRenderer.invoke(IpcChannels.openExternal, url),
  filterExistingFiles: (paths: string[]) =>
    ipcRenderer.invoke(IpcChannels.filterExistingFiles, paths),
  listWorkspaceFiles: (cwd: string) => ipcRenderer.invoke(IpcChannels.listWorkspaceFiles, cwd),
  openDiff: (left: string, right: string) =>
    ipcRenderer.invoke(IpcChannels.openDiff, left, right),
  getSettings: () => ipcRenderer.invoke(IpcChannels.getSettings),
  updateSettings: (patch: Partial<CluiSettings>, clear?: SettingsKey[]) =>
    ipcRenderer.invoke(IpcChannels.updateSettings, patch, clear),
  detectCliAt: (path: string) => ipcRenderer.invoke(IpcChannels.detectCliAt, path),
  getSystemPermissionMode: () => ipcRenderer.invoke(IpcChannels.getSystemPermissionMode),
  listModels: (refresh?: boolean) => ipcRenderer.invoke(IpcChannels.listModels, refresh),
  // Electron 33 removed `File.path`; the ONLY way to get a dropped/picked file's absolute
  // path is webUtils.getPathForFile in the (privileged) preload. Returns '' if unavailable
  // (e.g. a synthetic File with no backing path, like a pasted screenshot Blob).
  getPathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      return ''
    }
  },
  onSessionEvent: (cb: (evt: TaggedEvent) => void) => {
    const listener = (_e: unknown, payload: TaggedEvent): void => cb(payload)
    ipcRenderer.on(IpcChannels.sessionEvent, listener)
    return () => ipcRenderer.removeListener(IpcChannels.sessionEvent, listener)
  },
  onMenuAction: (cb: (action: MenuAction) => void) => {
    const listener = (_e: unknown, action: MenuAction): void => cb(action)
    ipcRenderer.on(IpcChannels.menuAction, listener)
    return () => ipcRenderer.removeListener(IpcChannels.menuAction, listener)
  },
  onFullscreenChanged: (cb: (isFullscreen: boolean) => void) => {
    const listener = (_e: unknown, isFullscreen: boolean): void => cb(isFullscreen)
    ipcRenderer.on(IpcChannels.fullscreenChanged, listener)
    return () => ipcRenderer.removeListener(IpcChannels.fullscreenChanged, listener)
  }
}

contextBridge.exposeInMainWorld('clui', api)

// Resolve + apply the theme BEFORE the renderer paints, avoiding a flash of the wrong
// palette. Done here (not via an inline <head> script, which our strict
// `default-src 'self'` CSP would block) because the preload is privileged and
// runs before page scripts. `sendSync` blocks for the main-resolved concrete
// theme ('dark' | 'light'; 'system' already resolved via the OS in main).
try {
  const theme = ipcRenderer.sendSync(IpcChannels.getResolvedThemeSync) as 'dark' | 'light'
  document.documentElement.setAttribute('data-theme', theme)
} catch {
  document.documentElement.setAttribute('data-theme', 'dark')
}
