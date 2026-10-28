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
  type RefSourceChanged
} from '../shared/ipc'
import type { CluiSettings, EffortChoice, ModelChoice, ResolvedSettings, SettingsKey } from '../shared/settings'
import type { BrowserEvent } from '../shared/browser'
import type { HtmlViewEvent } from '../shared/html-view'
import type { ElicitationResponse } from '../shared/events'
import type { AnnotateEvent } from '../shared/annotate'
import type { ChangesEvent } from '../shared/changes'
import type { FileChangedEvent } from '../shared/files'
import type { SurfaceCommand } from '../shared/surface-tools'

const api: CluiApi = {
  pickWorkspace: () => ipcRenderer.invoke(IpcChannels.pickWorkspace),
  getChatDir: () => ipcRenderer.invoke(IpcChannels.getChatDir),
  getCliInfo: () => ipcRenderer.invoke(IpcChannels.getCliInfo),
  getFullscreen: () => ipcRenderer.invoke(IpcChannels.getFullscreen),
  isMac: process.platform === 'darwin',
  getReducedTransparency: () => ipcRenderer.invoke(IpcChannels.getReducedTransparency),
  getOsTheme: () => ipcRenderer.invoke(IpcChannels.getOsTheme),
  startSession: (opts: StartSessionOptions) =>
    ipcRenderer.invoke(IpcChannels.startSession, opts),
  sendMessage: (handleId, packet) => ipcRenderer.invoke(IpcChannels.sendMessage, handleId, packet),
  validateRefs: (handleId, refs) => ipcRenderer.invoke(IpcChannels.validateRefs, handleId, refs),
  syncAnnotationOrder: (handleId, order) => ipcRenderer.invoke(IpcChannels.syncAnnotationOrder, handleId, order),
  syncRefWatches: (handleId, entries) => ipcRenderer.invoke(IpcChannels.syncRefWatches, handleId, entries),
  onRefSourceChanged: (cb) => {
    const listener = (_e: unknown, ev: RefSourceChanged): void => cb(ev)
    ipcRenderer.on(IpcChannels.refSourceChanged, listener)
    return () => ipcRenderer.removeListener(IpcChannels.refSourceChanged, listener)
  },
  onSurfaceCommand: (cb) => {
    const listener = (_e: unknown, cmd: SurfaceCommand): void => cb(cmd)
    ipcRenderer.on(IpcChannels.surfaceCommand, listener)
    return () => ipcRenderer.removeListener(IpcChannels.surfaceCommand, listener)
  },
  surfaceReply: (reqId, reply) => ipcRenderer.invoke(IpcChannels.surfaceReply, reqId, reply),
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
  injectRename: (handleId: string, name: string) =>
    ipcRenderer.invoke(IpcChannels.injectRename, handleId, name),
  setUltracode: (handleId: string, on: boolean) =>
    ipcRenderer.invoke(IpcChannels.setUltracode, handleId, on),
  stopSession: (handleId: string) => ipcRenderer.invoke(IpcChannels.stopSession, handleId),
  respondPermission: (handleId: string, verdict: PermissionVerdict) =>
    ipcRenderer.invoke(IpcChannels.respondPermission, handleId, verdict),
  respondElicitation: (handleId: string, requestId: string, response: ElicitationResponse) =>
    ipcRenderer.invoke(IpcChannels.respondElicitation, handleId, requestId, response),
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
  getSessionModels: () => ipcRenderer.invoke(IpcChannels.getSessionModels),
  setSessionModel: (sessionId: string, prefs: { model?: string; effort?: string; ultracode?: boolean }) =>
    ipcRenderer.invoke(IpcChannels.setSessionModel, sessionId, prefs),
  deleteSessionModel: (sessionId: string) =>
    ipcRenderer.invoke(IpcChannels.deleteSessionModel, sessionId),
  saveSurfaces: (handleId, save) => ipcRenderer.invoke(IpcChannels.saveSurfaces, handleId, save),
  saveSurfacesSync: (handleId, save) => void ipcRenderer.sendSync(IpcChannels.saveSurfacesSync, handleId, save),
  chooseSurfaceFile: (handleId, defaultPath) => ipcRenderer.invoke(IpcChannels.chooseSurfaceFile, handleId, defaultPath),
  readConfig: (cwd: string | null) => ipcRenderer.invoke(IpcChannels.readConfig, cwd),
  openInEditor: (handleId: string | null, filePath: string, line?: number) => ipcRenderer.invoke(IpcChannels.openInEditor, handleId, filePath, line),
  openExternal: (url: string) => ipcRenderer.invoke(IpcChannels.openExternal, url),
  getChanges: (handleId: string) => ipcRenderer.invoke(IpcChannels.getChanges, handleId),
  editLine: (handleId: string, path: string, editId: string) => ipcRenderer.invoke(IpcChannels.editLine, handleId, path, editId),
  getChangeGitStatus: (handleId: string) => ipcRenderer.invoke(IpcChannels.getChangeGitStatus, handleId),
  listWorkspaceFiles: (handleId: string) => ipcRenderer.invoke(IpcChannels.listWorkspaceFiles, handleId),
  classifyRefPaths: (handleId: string, paths: string[]) => ipcRenderer.invoke(IpcChannels.classifyRefPaths, handleId, paths),
  createChangeRef: (handleId, req) => ipcRenderer.invoke(IpcChannels.createChangeRef, handleId, req),
  changeRefStatus: (handleId, refs) => ipcRenderer.invoke(IpcChannels.changeRefStatus, handleId, refs),
  changeRefPeek: (handleId, ref) => ipcRenderer.invoke(IpcChannels.changeRefPeek, handleId, ref),
  openDiff: (handleId: string, left: string, right: string) =>
    ipcRenderer.invoke(IpcChannels.openDiff, handleId, left, right),
  getDiff: (handleId, req) => ipcRenderer.invoke(IpcChannels.getDiff, handleId, req),
  openChangeDiff: (handleId, req) => ipcRenderer.invoke(IpcChannels.openChangeDiff, handleId, req),
  getChangeMarks: (handleId, path) => ipcRenderer.invoke(IpcChannels.getChangeMarks, handleId, path),
  readText: (handleId, path) => ipcRenderer.invoke(IpcChannels.readText, handleId, path),
  statFile: (handleId, path) => ipcRenderer.invoke(IpcChannels.statFile, handleId, path),
  imageCaps: (handleId, owner, paths) => ipcRenderer.invoke(IpcChannels.imageCaps, handleId, owner, paths),
  imageCapsRevoke: (handleId, owner) => ipcRenderer.invoke(IpcChannels.imageCapsRevoke, handleId, owner),
  imageOpen: (handleId, owner, path) => ipcRenderer.invoke(IpcChannels.imageOpen, handleId, owner, path),
  imageVersion: (handleId, path) => ipcRenderer.invoke(IpcChannels.imageVersion, handleId, path),
  watchFile: (handleId, path) => ipcRenderer.invoke(IpcChannels.watchFile, handleId, path),
  unwatchFile: (handleId, id) => ipcRenderer.invoke(IpcChannels.unwatchFile, handleId, id),
  openPath: (handleId, path) => ipcRenderer.invoke(IpcChannels.openPath, handleId, path),
  listDir: (handleId, rel) => ipcRenderer.invoke(IpcChannels.listDir, handleId, rel),
  watchDir: (handleId, rel) => ipcRenderer.invoke(IpcChannels.watchDir, handleId, rel),
  revealPath: (handleId, path) => ipcRenderer.invoke(IpcChannels.revealPath, handleId, path),
  showContextMenu: (items, at) => ipcRenderer.invoke(IpcChannels.showContextMenu, items, at),
  // The sandboxed preload has no node:os; one sync read before page scripts run.
  homeDir: ipcRenderer.sendSync(IpcChannels.getHomeDirSync) as string,
  onFileChanged: (cb) => {
    const listener = (_e: unknown, payload: FileChangedEvent): void => cb(payload)
    ipcRenderer.on(IpcChannels.fileChanged, listener)
    return () => ipcRenderer.removeListener(IpcChannels.fileChanged, listener)
  },
  getSettings: () => ipcRenderer.invoke(IpcChannels.getSettings),
  updateSettings: (patch: Partial<CluiSettings>, clear?: SettingsKey[]) =>
    ipcRenderer.invoke(IpcChannels.updateSettings, patch, clear),
  onSettingsChanged: (cb) => {
    const listener = (_e: unknown, settings: ResolvedSettings): void => cb(settings)
    ipcRenderer.on(IpcChannels.settingsChanged, listener)
    return () => ipcRenderer.removeListener(IpcChannels.settingsChanged, listener)
  },
  detectCliAt: (path: string) => ipcRenderer.invoke(IpcChannels.detectCliAt, path),
  getSystemPermissionMode: () => ipcRenderer.invoke(IpcChannels.getSystemPermissionMode),
  getEffortCaps: () => ipcRenderer.invoke(IpcChannels.getEffortCaps),
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
  onChangesEvent: (cb: (evt: ChangesEvent) => void) => {
    const listener = (_e: unknown, payload: ChangesEvent): void => cb(payload)
    ipcRenderer.on(IpcChannels.changesEvent, listener)
    return () => ipcRenderer.removeListener(IpcChannels.changesEvent, listener)
  },
  onMenuAction: (cb: (action: MenuAction, page: boolean) => void) => {
    const listener = (_e: unknown, action: MenuAction, page?: boolean): void => cb(action, !!page)
    ipcRenderer.on(IpcChannels.menuAction, listener)
    return () => ipcRenderer.removeListener(IpcChannels.menuAction, listener)
  },
  onFullscreenChanged: (cb: (isFullscreen: boolean) => void) => {
    const listener = (_e: unknown, isFullscreen: boolean): void => cb(isFullscreen)
    ipcRenderer.on(IpcChannels.fullscreenChanged, listener)
    return () => ipcRenderer.removeListener(IpcChannels.fullscreenChanged, listener)
  },
  onReducedTransparencyChanged: (cb: (on: boolean) => void) => {
    const listener = (_e: unknown, on: boolean): void => cb(on)
    ipcRenderer.on(IpcChannels.reducedTransparencyChanged, listener)
    return () => ipcRenderer.removeListener(IpcChannels.reducedTransparencyChanged, listener)
  },
  browserSetBounds: (handleId, b) => ipcRenderer.send(IpcChannels.browserSetBounds, handleId, b),
  browserSetVisible: (handleId, visible) => ipcRenderer.invoke(IpcChannels.browserSetVisible, handleId, visible),
  browserViewTab: (handleId, tab) => ipcRenderer.invoke(IpcChannels.browserViewTab, handleId, tab),
  browserNewTab: (handleId) => ipcRenderer.invoke(IpcChannels.browserNewTab, handleId),
  browserCloseTab: (handleId, tab) => ipcRenderer.invoke(IpcChannels.browserCloseTab, handleId, tab),
  browserNavigate: (handleId, tab, url) => ipcRenderer.invoke(IpcChannels.browserNavigate, handleId, tab, url),
  browserNav: (handleId, tab, action) => ipcRenderer.invoke(IpcChannels.browserNav, handleId, tab, action),
  browserDrive: (handleId, action, tab) => ipcRenderer.invoke(IpcChannels.browserDrive, handleId, action, tab),
  annotate: (handleId, at, on) => ipcRenderer.invoke(IpcChannels.annotate, handleId, at, on),
  onAnnotateEvent: (cb) => {
    const listener = (_e: unknown, handleId: string, ev: AnnotateEvent): void => cb(handleId, ev)
    ipcRenderer.on(IpcChannels.annotateEvent, listener)
    return () => ipcRenderer.removeListener(IpcChannels.annotateEvent, listener)
  },
  browserSiteVerdict: (handleId, requestId, allow) =>
    ipcRenderer.invoke(IpcChannels.browserSiteVerdict, handleId, requestId, allow),
  browserLoginVerdict: (handleId, requestId, verdict) =>
    ipcRenderer.invoke(IpcChannels.browserLoginVerdict, handleId, requestId, verdict),
  browserListSites: () => ipcRenderer.invoke(IpcChannels.browserListSites),
  browserRemoveSite: (site) => ipcRenderer.invoke(IpcChannels.browserRemoveSite, site),
  browserLocalNetDecide: (site, allow) => ipcRenderer.invoke(IpcChannels.browserLocalNetDecide, site, allow),
  browserListLocalNet: () => ipcRenderer.invoke(IpcChannels.browserListLocalNet),
  browserForgetLocalNet: (site) => ipcRenderer.invoke(IpcChannels.browserForgetLocalNet, site),
  browserListLogins: () => ipcRenderer.invoke(IpcChannels.browserListLogins),
  browserSaveLogin: (input) => ipcRenderer.invoke(IpcChannels.browserSaveLogin, input),
  browserRemoveLogin: (id) => ipcRenderer.invoke(IpcChannels.browserRemoveLogin, id),
  browserVaultAvailable: () => ipcRenderer.invoke(IpcChannels.browserVaultAvailable),
  browserDataInfo: () => ipcRenderer.invoke(IpcChannels.browserDataInfo),
  browserClearData: (what) => ipcRenderer.invoke(IpcChannels.browserClearData, what),
  menuState: (state) => ipcRenderer.send(IpcChannels.menuState, state),
  onBrowserEvent: (cb: (handleId: string, e: BrowserEvent) => void) => {
    const listener = (_e: unknown, handleId: string, ev: BrowserEvent): void => cb(handleId, ev)
    ipcRenderer.on(IpcChannels.browserEvent, listener)
    return () => ipcRenderer.removeListener(IpcChannels.browserEvent, listener)
  },
  htmlOpen: (handleId, tabId, path, start) => ipcRenderer.invoke(IpcChannels.htmlOpen, handleId, tabId, path, start),
  htmlSetBounds: (viewId, b) => ipcRenderer.send(IpcChannels.htmlSetBounds, viewId, b),
  htmlSetVisible: (viewId, visible) => ipcRenderer.invoke(IpcChannels.htmlSetVisible, viewId, visible),
  htmlReload: (viewId) => ipcRenderer.invoke(IpcChannels.htmlReload, viewId),
  htmlClose: (viewId) => ipcRenderer.invoke(IpcChannels.htmlClose, viewId),
  htmlFocus: (viewId) => ipcRenderer.invoke(IpcChannels.htmlFocus, viewId),
  onHtmlEvent: (cb) => {
    const listener = (_e: unknown, ev: HtmlViewEvent): void => cb(ev)
    ipcRenderer.on(IpcChannels.htmlEvent, listener)
    return () => ipcRenderer.removeListener(IpcChannels.htmlEvent, listener)
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
