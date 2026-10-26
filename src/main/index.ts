/**
 * Electron main process entry.
 *
 * Owns the CLI subprocesses (via SessionManager), the native window, and the IPC
 * handlers that back the preload `window.clui` API. The renderer is pure UI.
 */
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Menu, shell, systemPreferences, webContents } from 'electron'
import type { MenuItemConstructorOptions, WebContents } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { basename, dirname, isAbsolute } from 'node:path'
import { readFile, writeFile, mkdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  IpcChannels,
  type EffortCaps,
  type MenuAction,
  type MenuState,
  type PermissionModeChoice,
  type PermissionVerdict,
  type ChangeRefResult,
  type StartSessionOptions
} from '../shared/ipc'
import type { ElicitationResponse } from '../shared/events'
import { classifierEnv, type EffortChoice, type ModelChoice } from '../shared/settings'
import { detectCli } from './cli/detect'
import { loginShellAuthEnv } from './cli/shell-env'
import { SessionManager } from './sessions/manager'
import { listSessions, deleteSession, renameSession } from './sessions/store'
import {
  readTranscript,
  readAgentTranscript,
  readAgentTranscriptByToolUseId
} from './sessions/transcript'
import { searchSessions, warmSearchCache } from './sessions/search'
import { exportSessionMarkdown, exportFilename } from './sessions/export'
import { readSessionModels, setSessionModel, deleteSessionModel } from './sessions/models'
import { deleteSessionUsage } from './sessions/usage'
import { readConfig } from './config/reader'
import { openInEditor, openDiff } from './ide/open'
import { listWorkspaceFiles } from './workspace/files'
import { readGitStatus } from './workspace/git-status'
import { createFileAccess, readText, statFile, type FileResource, type Refusal } from './surfaces/files'
import { listTree, treeTarget } from './surfaces/tree'
import { bindSession, deleteSurfaces, flushSurfaces, forgetSession, loadSurfaces, saveSession, trackSession } from './surfaces/persist'
import type { SurfacesRestore } from '../shared/surfaces'
import { parseAnchor, parseMenuItems, popupMenu } from './context-menu'
import { changeMarks, diffSnapshots, editLine, getDiff, parseChangeRefRequest, parseDiffRequest, selectChange, type DiffSource } from './surfaces/diff'
import { ChangeRefs } from './surfaces/change-refs'
import { surfaceBridge, surfaceServer } from './surfaces/mcp-surface'
import { SURFACE_OPEN_TOOL, SURFACE_STATE_TOOL } from '../shared/surface-tools'
import {
  getResolvedSettings,
  getSettings,
  getSettingsSync,
  updateSettings
} from './settings/store'
import { readCliSettings } from './settings/cli-settings'
import { listModels, liveModelIds } from './models/list'
import { BrowserManager } from './browser/manager'
import { BrowserMcpServer } from './browser/mcp'
import { mcpListener } from './lib/mcp-route'
import { Annotator } from './browser/annotate'
import { changeRefStatus, classifyRefPaths, parseOutgoing, preparePacket, validateRefs, type PacketDeps } from './cli/packet'
import { contextWatches } from './surfaces/context-watch'
import { CHANGE_READ_TOOL, CHANGE_REF, isRefInput, MAX_REFS, relativeTo, type DraftReference } from '../shared/context'
import { WORLD } from './browser/cursor'
import { approve as approveSite, listLocalNet, listSites, removeSite } from './browser/sites'
import { listLogins, removeLogin, saveLogin, vaultAvailable } from './browser/vault'
import type { ClearBrowsingData, DriveState, PaneBounds, TabActor } from '../shared/browser'
import type { CluiSettings, SettingsKey } from '../shared/settings'

const __dirname = dirname(fileURLToPath(import.meta.url))

let mainWindow: BrowserWindow | null = null
let sessionManager: SessionManager | null = null
let browserManager: BrowserManager | null = null
let diffs: ReturnType<typeof diffSnapshots> | null = null
let presentation: ReturnType<typeof surfaceBridge> | null = null
const LAUNCHERS = /\.(app|command|terminal|tool|fileloc|webloc|inetloc|workflow|action|jar|pkg|mpkg|scpt|applescript)$/i

// Backstop: a window-teardown race can throw "Object has been destroyed" from an
// async child-stdout callback AFTER the window is gone. That's benign (there's
// nothing left to deliver to), but Electron's default handler pops a crash dialog.
// SUPPRESS only that specific benign error; re-throw everything else so real bugs
// still surface (never a blanket swallow).
process.on('uncaughtException', (err) => {
  if (err instanceof Error && /Object has been destroyed/i.test(err.message)) {
    console.warn('[clui] suppressed benign teardown error:', err.message)
    return
  }
  throw err
})

function modeToFlag(choice: PermissionModeChoice): string | undefined {
  // 'inherit' → undefined = pass no flag = honor ~/.claude/settings.json.
  return choice === 'inherit' ? undefined : choice
}

/** Window background per theme. Matches the renderer's --color-bg so there's no
 *  flash of the wrong color before the React/CSS paint. Keep in sync with styles.css. */
const THEME_BG = { dark: '#161617', light: '#ffffff' } as const

/** An opaque window background paints over the vibrancy material, so on macOS the page paints its own surfaces. */
const windowBg = (): string => (process.platform === 'darwin' ? '#00000000' : THEME_BG[resolveTheme()])

function resolveTheme(): 'dark' | 'light' {
  const pref = getSettingsSync().theme
  if (pref === 'system') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  return pref
}

/** The native page holding keyboard focus. Focus in it leaves the renderer's document, so the
 *  renderer can't tell a focused page from a window in the background. */
let focusedPage: WebContents | null = null
const isPage = (wc: WebContents | null): boolean => !!wc && !BrowserWindow.getAllWindows().some((w) => w.webContents === wc)
app.on('web-contents-created', (_e, wc) => {
  const mark = (on: boolean): void => {
    if (!isPage(wc) || (on ? focusedPage === wc : focusedPage !== wc)) return
    focusedPage = on ? wc : null
    buildMenu()
  }
  wc.on('focus', () => mark(true))
  wc.on('blur', () => mark(false))
  wc.once('destroyed', () => mark(false))
})

/**
 * Build + install the application menu. ⌘N / ⌘W / ⌘, are defined HERE (not as
 * renderer key listeners) because macOS routes those through the app menu first:
 * a DOM listener for ⌘W would still hit Electron's default "Close Window". Menu
 * clicks push a `menuAction` to the renderer, which calls the matching store
 * action. The Edit + Window submenus use built-in ROLES so copy/paste/select-all
 * and standard window commands keep working in text fields (a custom menu that
 * omits them silently breaks clipboard shortcuts, the classic Electron gotcha).
 */
const TAKES_TYPING = new Set<MenuAction>(['find-in-conversation', 'find-next', 'find-prev', 'open-file', 'open-palette', 'open-command-palette', 'search-global'])
let menuState: MenuState = { browser: 'none', pane: 'none', surface: 'none', canPane: false, close: 'session', external: { kind: 'none', enabled: false } }
const EXTERNAL_LABEL: Record<MenuState['external']['kind'], string> = { file: 'Open in Editor', diff: 'Open Diff in Editor', browser: 'Open in Default Browser', tree: 'Open Folder in Editor', none: 'Open Externally' }

function buildMenu(): void {
  const send = (action: MenuAction): void => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    try {
      if (!win || win.isDestroyed()) return
      const wc = win.webContents
      if (wc.isDestroyed()) return
      const page = !!focusedPage || isPage(webContents.getFocusedWebContents())
      // A DOM focus() can't pull keyboard focus out of a native page, so an action that opens a
      // renderer input takes it back here first.
      if (focusedPage && TAKES_TYPING.has(action)) wc.focus()
      wc.send(IpcChannels.menuAction, action, page)
    } catch {
      /* window torn down; drop */
    }
  }
  const isMac = process.platform === 'darwin'
  const close = focusedPage ? 'tab' : menuState.close
  // With Close Tab disabled on the picker, ⌘W must not fall through to the window's own Close.
  const closeWindow: MenuItemConstructorOptions = { role: 'close', accelerator: 'Shift+CmdOrCtrl+W' }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: 'Clui',
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('open-settings') },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Session', accelerator: 'CmdOrCtrl+N', click: () => send('new-session') },
        { label: 'New Quick Session', accelerator: 'Alt+CmdOrCtrl+N', click: () => send('new-quick-session') },
        { label: 'New Session in a Directory…', accelerator: 'CmdOrCtrl+Shift+N', click: () => send('new-named-session') },
        { label: 'Quick Switcher…', accelerator: 'CmdOrCtrl+K', click: () => send('open-palette') },
        { label: 'Command Palette…', accelerator: 'CmdOrCtrl+Shift+K', click: () => send('open-command-palette') },
        { label: close === 'session' ? 'Close Session' : 'Close Tab', accelerator: 'CmdOrCtrl+W', enabled: close !== 'none', click: () => send('close-session') },
        { type: 'separator' },
        // Native accelerators, not DOM keys, so they still fire while focus sits inside a native view.
        { label: 'Open File…', accelerator: 'CmdOrCtrl+P', enabled: menuState.canPane, click: () => send('open-file') },
        {
          label: menuState.surface === 'none' ? 'Show Pane' : 'Hide Pane',
          accelerator: 'Alt+CmdOrCtrl+0',
          enabled: menuState.canPane,
          click: () => send('pane-toggle')
        },
        {
          label: menuState.pane === 'full' ? 'Split Pane' : 'Expand Pane',
          accelerator: 'Alt+CmdOrCtrl+B',
          enabled: menuState.pane !== 'none',
          click: () => send('toggle-pane-size')
        },
        {
          label: menuState.browser === 'shown' ? 'Hide Browser' : 'Show Browser',
          accelerator: 'CmdOrCtrl+Shift+B',
          enabled: menuState.browser !== 'none',
          click: () => send('browser-toggle')
        },
        {
          label: EXTERNAL_LABEL[menuState.external.kind],
          accelerator: 'Shift+CmdOrCtrl+O',
          enabled: menuState.external.enabled,
          click: () => send('pane-external')
        },
        { type: 'separator' },
        { label: 'Stop Browser Agent', accelerator: 'CmdOrCtrl+.', click: () => send('browser-stop') },
        { label: 'Point', accelerator: 'CmdOrCtrl+Shift+A', click: () => send('browser-annotate') },
        ...(isMac ? [] : ([{ type: 'separator' }, { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('open-settings') }] as MenuItemConstructorOptions[])),
        { type: 'separator' },
        isMac ? closeWindow : { role: 'quit' }
      ]
    },
    // Role-based Edit menu, preserving ⌘C/⌘V/⌘X/⌘A/⌘Z in inputs + the textarea.
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find in Conversation…', accelerator: 'CmdOrCtrl+F', click: () => send('find-in-conversation') },
        { label: 'Find Next', accelerator: 'CmdOrCtrl+G', click: () => send('find-next') },
        { label: 'Find Previous', accelerator: 'CmdOrCtrl+Shift+G', click: () => send('find-prev') },
        { label: 'Search All Conversations…', accelerator: 'CmdOrCtrl+Shift+F', click: () => send('search-global') }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? ([{ type: 'separator' }, { role: 'front' }] as MenuItemConstructorOptions[])
          : [closeWindow])
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Clui',
    backgroundColor: windowBg(),
    // Hide the native title bar so the sidebar reaches the window top; the lights overlay its band.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 19, y: 16 },
    // The material shows only through the expanded sidebar. Fullscreen and the accessibility settings cover it in CSS,
    // so nothing here toggles during the OS fullscreen animation.
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Sandbox the renderer: the preload only uses electron (ipcRenderer/contextBridge/
      // webUtils), no Node built-ins, so it runs fine sandboxed.
      sandbox: true
    }
  })

  // Commands sent to an earlier window or renderer can't be answered by this one.
  presentation?.renew()
  mainWindow.on('closed', () => presentation?.renew())
  mainWindow.webContents.on('render-process-gone', () => presentation?.renew())

  // Probe runs set CLUI_TEST_INACTIVE so the window opens behind whatever the user is working in.
  mainWindow.on('ready-to-show', () => (process.env.CLUI_TEST_INACTIVE === '1' ? mainWindow?.showInactive() : mainWindow?.show()))

  // macOS hides the traffic lights in fullscreen; push the state so the renderer shifts its controls.
  const pushFullscreen = (): void => {
    const wc = mainWindow?.webContents
    if (wc && !wc.isDestroyed()) wc.send(IpcChannels.fullscreenChanged, mainWindow?.isFullScreen() ?? false)
  }
  mainWindow.on('enter-full-screen', pushFullscreen)
  mainWindow.on('leave-full-screen', pushFullscreen)
  mainWindow.on('resize', () => browserManager?.relayout())

  // nativeTheme's `updated` isn't documented to fire for Reduce transparency, so re-send it whenever
  // the window regains focus, which is where the user returns after changing System Settings.
  mainWindow.on('focus', () => {
    const wc = mainWindow?.webContents
    if (wc && !wc.isDestroyed()) wc.send(IpcChannels.reducedTransparencyChanged, nativeTheme.prefersReducedTransparency)
  })

  // Defense-in-depth against navigation footguns: never let the webview leave the
  // app document. A file dropped outside the composer (or a stray link) must not
  // navigate the window to a file://…/local URL and white-screen the app. The
  // renderer already cancels stray drops; this is the backstop.
  // External http(s) links are opened in the OS browser via the existing openExternal
  // IPC, so we can safely block ALL in-window navigations except the initial load.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const current = mainWindow?.webContents.getURL()
    if (url !== current) e.preventDefault()
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // electron-vite injects ELECTRON_RENDERER_URL in dev; load the built file in prod.
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  const browser = new BrowserManager(() => mainWindow, () => THEME_BG[resolveTheme()])
  const listener = mcpListener()
  const mcp = new BrowserMcpServer(browser, listener)
  const changeRefs = new ChangeRefs()
  const bridge = surfaceBridge((cmd) => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return false
    mainWindow.webContents.send(IpcChannels.surfaceCommand, cmd)
    return true
  })
  presentation = bridge
  const surface = surfaceServer(changeRefs, {
    cwd: (h) => manager.cwd(h),
    authorize: async (h, p) => {
      const f = await files.resolveAllowed(h, p, { consumer: 'file', operation: 'read-file' })
      if (f.ok || f.reason !== 'wrong-type') return f.ok ? 'file' : f.reason
      const d = await files.resolveAllowed(h, p, { consumer: 'tree', operation: 'list-directory' })
      return d.ok ? 'tree' : d.reason
    },
    changed: async (h, p) => !!(await manager.changes(h))?.some((c) => c.path === p),
    browserTabs: (h) => browser.tabsOf(h)?.tabs.map(({ id, url, title }) => ({ id, url, title })) ?? null,
    request: (h, op) => bridge.request(h, op)
  })
  const surfaceRoute = listener.route('mcp-surface', surface)
  const annotator = new Annotator(browser, () => mainWindow)
  browser.onLeave = (handleId, tab, why) => annotator.leave(handleId, tab, why)
  browser.onDocumentGone = (handleId, tab, reason) => annotator.gone(handleId, tab, reason)
  browser.holdsPins = (handleId, tab) => annotator.holds(handleId, tab)
  browserManager = browser
  const disposeBrowser = (handleId: string): void => {
    annotator.dispose(handleId)
    browser.dispose(handleId)
    mcp.revoke(handleId)
    surfaceRoute.revoke(handleId)
    surface.revoke(handleId)
    bridge.retire(handleId)
    changeRefs.dispose(handleId)
    refWatches.dispose(handleId)
    files.dispose(handleId)
    forgetSession(handleId)
    for (const [id, owner] of watchOwners) if (owner === handleId) watchOwners.delete(id)
  }
  if (process.env.CLUI_TEST_HOOKS === '1') {
    // For the harness only, from Playwright's app.evaluate; the shipped app never sets this variable.
    Object.assign(globalThis, {
      __cluiBrowser: {
        endpoint: (handleId: string) => mcp.endpoint(handleId),
        callTool: (handleId: string, name: string, args: Record<string, unknown> = {}, toolUseId?: string) =>
          mcp.callTool(handleId, name, args, toolUseId),
        evalInPage: (handleId: string, code: string, tab?: number) =>
          browser.page(handleId, tab ?? browser.tabsOf(handleId)?.viewed ?? 1)?.wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]) ??
          Promise.resolve(null),
        clearData: (what: ClearBrowsingData) => browser.clearData(what),
        approveSite: (site: string) => approveSite(site),
        // A fresh blank page for the same session and token, so one scene's page can't leak into the next.
        resetPage: (handleId: string) => {
          browser.dispose(handleId)
          browser.enable(handleId)
        },
        newTab: async (handleId: string, by: TabActor, url?: string) => {
          const tab = await browser.newTab(handleId, by, url)
          if (tab !== null && url) await browser.navigate(handleId, tab, url, by)
          return tab
        },
        closeTab: (handleId: string, tab: number, by: TabActor) => browser.closeTab(handleId, tab, by),
        setDrive: (handleId: string, tab: number, drive: DriveState) => browser.setTabDrive(handleId, tab, drive),
        click: (handleId: string, x: number, y: number, tab?: number) => browser.page(handleId, tab ?? browser.tabsOf(handleId)?.viewed ?? 1)?.cdp.click(x, y),
        hover: (handleId: string, x: number, y: number, tab?: number) => browser.page(handleId, tab ?? browser.tabsOf(handleId)?.viewed ?? 1)?.cdp.hover(x, y),
        // Native input, unlike CDP's: only it raises before-input-event, as the user's keys do.
        key: (handleId: string, key: string, tab?: number) => {
          const wc = browser.page(handleId, tab ?? browser.tabsOf(handleId)?.viewed ?? 1)?.wc
          wc?.sendInputEvent({ type: 'keyDown', keyCode: key })
          wc?.sendInputEvent({ type: 'keyUp', keyCode: key })
        },
        annotated: (handleId: string, tab: number) => annotator.count(handleId, tab),
        annotationOrder: (handleId: string, tab: number) => annotator.order(handleId, tab),
        suspend: (handleId: string, tab: number) => browser.suspendTab(handleId, tab),
        tabs: (handleId: string) =>
          browser.tabsOf(handleId)?.tabs.map(({ id, url, title, drive, suspended, attached, parked }) => ({ id, url, title, drive, suspended, attached, parked })) ?? null,
        lastToolTab: (handleId: string) => browser.tabsOf(handleId)?.lastUsed ?? null
      },
      __cluiSurface: {
        callTool: (handleId: string, name: string, args: Record<string, unknown> = {}) => surface.call(handleId, name, args),
        endpoint: (handleId: string) => surfaceRoute.endpoint(handleId),
        // The nth hunk (0-based, oldest segment first) of the file's diff as the Diff surface lists it, minted
        // through clui:createChangeRef's own path.
        mint: async (handleId: string, path: string, o: { hunk?: number; side?: 'diff' | 'before' | 'after'; rows?: { start: number; end: number } } = {}) => {
          const h = (await getDiff(diffSource, handleId, { path }))?.segments.flatMap((s) => s.groups.flat())[o.hunk ?? 0]
          if (!h) return null
          return createChangeRef(handleId, { path, segmentId: h.segmentId, revision: h.revision, hunkId: h.id, side: o.side ?? 'diff', ...(o.rows ? { rows: o.rows } : {}) })
        },
        available: (handleId: string) => changeRefs.available(handleId)
      },
      __cluiSessions: {
        // The real send's own preparation, with a fresh uuid, and never written: the exact outgoing envelope at zero tokens.
        prepare: (handleId: string, raw: unknown) => {
          const packet = parseOutgoing(raw)
          return packet ? preparePacket(packetDeps, handleId, packet, randomUUID()) : { ok: false, reason: 'invalid' }
        }
      }
    })
  }

  // A `claude` child's stdout can arrive while the window tears down, and on a destroyed
  // BrowserWindow even reading `.webContents` throws, so isDestroyed() goes first. The catch
  // covers a teardown that lands between the check and the send.
  const push = (channel: string, payload: unknown): void => {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) return
      const wc = mainWindow.webContents
      if (!wc.isDestroyed()) wc.send(channel, payload)
    } catch {
      /* window torn down mid-send; drop the event */
    }
  }
  const manager = new SessionManager(
    (handleId, event) => {
      browser.onSessionEvent(handleId, event)
      if (event.type === 'session-init') {
        if (event.sessionId) {
          bindSession(handleId, event.sessionId)
          changeRefs.bind(handleId, event.sessionId)
        }
        changeRefs.setAvailable(handleId, event.tools.includes(CHANGE_READ_TOOL))
      }
      if (event.type === 'process-exit') disposeBrowser(handleId)
      push(IpcChannels.sessionEvent, { handleId, event })
    },
    (handleId, summaries) => push(IpcChannels.changesEvent, { handleId, summaries })
  )
  sessionManager = manager
  /** A watch id answers only to the session that made it. */
  const watchOwners = new Map<string, string>()
  const files = createFileAccess({
    cwd: (h) => manager.cwd(h),
    changedPaths: async (h) => (await manager.changes(h))?.map((c) => c.path) ?? null
  })
  const diffSource: DiffSource = {
    segments: (h, p) => manager.segments(h, p),
    current: async (h, p) => {
      const r = await files.resolveAllowed(h, p, { consumer: 'diff', operation: 'read-file' })
      const t = r.ok ? await readText(r) : null
      return t?.ok && !t.binary && !t.truncated && !t.unsupportedEncoding ? { text: t.text, revision: t.revision } : null
    }
  }
  diffs = diffSnapshots(join(app.getPath('userData'), 'diff-snapshots'), diffSource, (h, p) => files.registerDerived(h, 'editor', p))
  const packetDeps: PacketDeps = {
    cwd: (h) => manager.cwd(h),
    readRevision: async (h, p) => {
      const r = await files.resolveAllowed(h, p, { consumer: 'file', operation: 'read-file' })
      const t = r.ok ? await readText(r) : r
      if (!t.ok) return t
      if (t.binary || t.unsupportedEncoding) return { ok: false, reason: 'changed' }
      // Counted as the File surface counts them: a final newline ends the last line rather than starting one.
      const n = t.text.split('\n').length
      return { ok: true, version: `sha256:${t.revision}`, lineCount: n > 1 && t.text.endsWith('\n') ? n - 1 : n }
    },
    authorize: async (h, p, kind) => {
      const r = await files.resolveAllowed(h, p, kind === 'file' ? { consumer: 'file', operation: 'read-file' } : { consumer: 'tree', operation: 'list-directory' })
      return r.ok ? 'ok' : r.reason === 'missing' ? 'missing' : 'denied'
    },
    docOf: (h, tab) => annotator.docOf(h, tab),
    secrets: (h, tab) => browser.page(h, tab)?.cdp.secrets ?? new Set(),
    change: (h, ref) => changeRefs.check(h, ref),
    changeOf: (h, ref) => changeRefs.locator(h, ref),
    activate: (h, packetId, refs) => changeRefs.activate(h, packetId, refs)
  }
  // Mint reads ledger memory for the handle's own session only; access comes later, from dispatch.
  async function createChangeRef(handleId: unknown, raw: unknown): Promise<ChangeRefResult> {
    const cwd = typeof handleId === 'string' ? manager.cwd(handleId) : null
    if (typeof handleId !== 'string' || cwd === null) return { ok: false, reason: 'unavailable' }
    const h = handleId
    const req = parseChangeRefRequest(raw)
    if (!req) throw new Error('createChangeRef: invalid request')
    if (changeRefs.available(h) === false) return { ok: false, reason: 'denied' }
    const r = await selectChange(diffSource, h, req)
    if (!r.ok) return r
    const { text, old, new: neu, bytes } = r.sel
    const range = { ...(old ? { old } : {}), ...(neu ? { new: neu } : {}) }
    const { path, segmentId, revision, hunkId, side, rows } = req
    const changeRef = changeRefs.mint(h, { path, label: relativeTo(cwd, path), segmentId, revision, hunkId, side, ...(rows ? { rows } : {}), ...range, text, bytes })
    if (!changeRef) return { ok: false, reason: 'unavailable' }
    return { ok: true, ref: { kind: 'change', changeRef, path, side, ...range }, bytes }
  }
  const refWatches = contextWatches({
    resolve: (h, p) => files.resolveAllowed(h, p, { consumer: 'file', operation: 'watch-file' }),
    watch: (r, onChange, pool) => files.watch(r, onChange, pool),
    unwatch: (id) => files.unwatch(id),
    readRevision: packetDeps.readRevision,
    push: (e) => push(IpcChannels.refSourceChanged, e)
  })

  // Reject IPC that doesn't come from the top frame of a real app window: an injected
  // sub-frame or webview must not reach the privileged bridge. Defense in depth
  // alongside the CSP + navigation guards; the legit renderer is always the top frame.
  const fromTrustedFrame = (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean =>
    !e.senderFrame?.parent && BrowserWindow.fromWebContents(e.sender) !== null
  const handle = (
    channel: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors ipcMain.handle's own arg typing
    fn: (e: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown
  ): void => {
    ipcMain.handle(channel, (e, ...args) => {
      if (!fromTrustedFrame(e)) throw new Error('ipc: untrusted sender')
      return fn(e, ...args)
    })
  }

  handle(IpcChannels.pickWorkspace, async () => {
    if (!mainWindow) return null
    const { defaultWorkspace } = await getSettings()
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Pick a workspace folder',
      properties: ['openDirectory', 'createDirectory'],
      ...(defaultWorkspace ? { defaultPath: defaultWorkspace } : {})
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  // The cwd for a "no directory" session: a dedicated ~/.clui (configurable), created on
  // demand so it always exists before spawn. Contained on purpose so it never touches the home tree.
  handle(IpcChannels.getChatDir, async () => {
    const { defaultChatDir } = await getSettings()
    const dir = defaultChatDir.trim() || join(homedir(), '.clui')
    await mkdir(dir, { recursive: true })
    return dir
  })

  handle(IpcChannels.getCliInfo, async () => {
    const { cliPath } = await getSettings()
    return detectCli(cliPath || null)
  })

  handle(IpcChannels.getFullscreen, () => mainWindow?.isFullScreen() ?? false)
  handle(IpcChannels.getReducedTransparency, () => nativeTheme.prefersReducedTransparency)
  // themeSource overrides what nativeTheme reports, but not the macOS default it reads.
  handle(IpcChannels.getOsTheme, () => (systemPreferences.getUserDefault('AppleInterfaceStyle', 'string') === 'Dark' ? 'dark' : 'light'))

  handle(IpcChannels.startSession, async (_e, opts: StartSessionOptions) => {
    const settings = await getSettings()
    const info = await detectCli(settings.cliPath || null)
    if (!info.path) throw new Error('claude CLI not found. Set its path in Settings.')
    // Finder/app-drawer-launched Electron gets a minimal env, so the spawned CLI would
    // miss the user's Bedrock/Vertex/API-key auth vars → "Not logged in". Pull the
    // auth-relevant subset from the login shell (like detect.ts does for PATH) and merge
    // it into the child env. Cached; best-effort (empty → CLI behaves as before).
    const authEnv = await loginShellAuthEnv()
    // The token in the config is bound to the handle, so the handle exists before the process does.
    const handleId = randomUUID()
    const withBrowser = settings.browserEnabled && !opts.ephemeral
    const servers = { 'clui-surface': await surfaceRoute.entry(handleId), ...(withBrowser ? { 'clui-browser': await mcp.entry(handleId) } : {}) }
    const presents = settings.surfaceTools && !opts.ephemeral
    surface.setPresentation(handleId, presents)
    // Tool-level for the surface, so a disabled presentation tool never rides a server-wide rule.
    const allow = [CHANGE_READ_TOOL, ...(presents ? [SURFACE_STATE_TOOL, SURFACE_OPEN_TOOL] : []), ...(withBrowser ? ['mcp__clui-browser'] : [])]
    const restore: SurfacesRestore = opts.resumeSessionId && !opts.ephemeral ? await loadSurfaces(opts.resumeSessionId) : { status: 'none' }
    const saved = restore.status === 'ok' ? restore.entry : null
    if (withBrowser) mcp.setBundles(handleId, { visual: settings.browserVisual, interact: settings.browserInteract, debug: settings.browserDebug })
    manager.start(handleId, {
      cliPath: info.path,
      cwd: opts.cwd,
      resumeSessionId: opts.resumeSessionId,
      fork: opts.fork,
      name: opts.name,
      ephemeral: opts.ephemeral,
      env: authEnv,
      // Model/effort: per-session override wins over the global default.
      // model is the raw --model value (id or alias).
      model: opts.model ?? settings.model,
      effort: opts.effort ?? settings.effort,
      enableTaskTools: settings.enableTaskTools,
      classifierEnv: classifierEnv(settings, liveModelIds()),
      // Always open the stdio approval channel so any tool the CLI asks about can
      // be answered in the UI (inert when the mode never asks).
      gated: true,
      // Per-session override wins over the global default; 'inherit' → no flag
      // (honor ~/.claude/settings.json). Never writes any settings file.
      permissionMode: modeToFlag(opts.permissionMode ?? settings.permissionMode),
      cluiMcp: { config: JSON.stringify({ mcpServers: servers }), allow },
      mcpConfigPath: process.env.CLUI_TEST_MCP_CONFIG
    })
    changeRefs.track(handleId, { quick: !!opts.ephemeral, sessionId: opts.fork ? null : (opts.resumeSessionId ?? null), ...(opts.fork && opts.resumeSessionId ? { forkOf: opts.resumeSessionId } : {}) })
    trackSession(handleId, { quick: !!opts.ephemeral, sessionId: opts.fork ? null : (opts.resumeSessionId ?? null), seed: opts.fork ? saved : null })
    if (withBrowser) browser.enable(handleId, saved?.browserTabs)
    const surfaces: SurfacesRestore = saved ? { status: 'ok', entry: { ...saved, browserTabs: withBrowser ? browser.records(handleId) : null } } : restore
    return { handleId, browser: withBrowser, surfaces }
  })

  handle(IpcChannels.sendMessage, async (_e, handleId: unknown, raw: unknown) => {
    if (typeof handleId !== 'string') throw new Error('sendMessage: invalid handle')
    const packet = parseOutgoing(raw)
    if (!packet) return { ok: false, reason: 'invalid' }
    return manager.send(handleId, packet.now, (uuid) => preparePacket(packetDeps, handleId, packet, uuid))
  })

  handle(IpcChannels.validateRefs, async (_e, handleId: unknown, refs: unknown) => {
    const valid = (d: unknown): d is DraftReference =>
      !!d && typeof d === 'object' && isRefInput((d as DraftReference).ref) && typeof (d as DraftReference).ref.id === 'string'
    if (typeof handleId !== 'string' || !Array.isArray(refs) || refs.length > MAX_REFS || !refs.every(valid)) throw new Error('validateRefs: invalid refs')
    return validateRefs(packetDeps, handleId, refs)
  })

  handle(IpcChannels.syncAnnotationOrder, async (_e, handleId: unknown, o: unknown) => {
    const int = (v: unknown, lo: number, hi: number): boolean => Number.isSafeInteger(v) && (v as number) >= lo && (v as number) <= hi
    const { keep, shown, room } = (o ?? {}) as Record<string, unknown>
    if (typeof handleId !== 'string' || !Array.isArray(keep) || keep.length > 1000 || !keep.every((v) => Number.isSafeInteger(v))) return
    if (!Array.isArray(shown) || shown.length > MAX_REFS || !int(room, 0, MAX_REFS)) return
    if (!shown.every((p) => Array.isArray(p) && p.length === 2 && keep.includes(p[0]) && int(p[1], 1, MAX_REFS))) return
    await annotator.sync(handleId, { keep, shown, room: room as number })
  })

  handle(IpcChannels.syncRefWatches, async (_e, handleId: unknown, entries: unknown) => {
    const ok = (x: unknown): boolean => {
      const { path, version } = (x ?? {}) as Record<string, unknown>
      return typeof path === 'string' && isAbsolute(path) && path.length <= 4096 && !path.includes('\0') && typeof version === 'string' && /^sha256:[0-9a-f]{32}$/.test(version)
    }
    if (typeof handleId !== 'string' || manager.cwd(handleId) === null || !Array.isArray(entries) || entries.length > MAX_REFS || !entries.every(ok)) return
    refWatches.sync(handleId, entries)
  })

  handle(IpcChannels.interrupt, async (_e, handleId: string) => {
    manager.interrupt(handleId)
  })

  handle(IpcChannels.stopTask, async (_e, handleId: string, taskId: string) => {
    return manager.stopTask(handleId, taskId)
  })

  handle(IpcChannels.backgroundTask, async (_e, handleId: string, toolUseId: string) => {
    return manager.backgroundTask(handleId, toolUseId)
  })

  handle(
    IpcChannels.setPermissionMode,
    async (_e, handleId: string, mode: PermissionModeChoice) => {
      // 'inherit' has no CLI "unset" mid-session, so resolve it to the user's ACTUAL
      // configured default (permissions.defaultMode) rather than hardcoding 'default'
      // (Interactive): otherwise picking "System Default" would silently force Interactive
      // for a user whose default is Plan/Accept-Edits/Autonomous. Falls back to 'default'
      // when unset (the CLI's own default). Still a live control message only.
      const resolved = mode === 'inherit' ? ((await readCliSettings()).defaultMode ?? 'default') : mode
      return { ...(await manager.setPermissionMode(handleId, resolved)), mode: resolved }
    }
  )

  handle(IpcChannels.setModel, async (_e, handleId: string, model: ModelChoice) => {
    // model is the raw --model value; pass it straight through.
    return model ? manager.setModel(handleId, model) : false
  })

  handle(IpcChannels.setEffort, async (_e, handleId: string, effort: EffortChoice) => {
    await manager.setEffort(handleId, effort)
  })
  handle(IpcChannels.injectRename, async (_e, handleId: string, name: string) => {
    manager.injectRename(handleId, name)
  })
  handle(IpcChannels.setUltracode, async (_e, handleId: string, on: boolean) => {
    return manager.setUltracode(handleId, on)
  })

  handle(IpcChannels.surfaceReply, (e, reqId: unknown, reply: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed() && e.sender === mainWindow.webContents) bridge.reply(reqId, reply)
  })

  handle(IpcChannels.stopSession, async (_e, handleId: string) => {
    manager.stop(handleId)
    disposeBrowser(handleId)
  })

  ipcMain.on(IpcChannels.menuState, (e, next: MenuState) => {
    if (!fromTrustedFrame(e)) return
    if (JSON.stringify(next) === JSON.stringify(menuState)) return
    menuState = next
    buildMenu()
  })
  ipcMain.on(IpcChannels.browserSetBounds, (e, handleId: string, b: PaneBounds | null) => {
    if (fromTrustedFrame(e)) browser.setBounds(handleId, b)
  })
  handle(IpcChannels.browserSetVisible, (_e, handleId: string, visible: boolean) => browser.setVisible(handleId, visible))
  handle(IpcChannels.browserViewTab, (_e, handleId: string, tab: number) => browser.viewTab(handleId, tab))
  handle(IpcChannels.browserNewTab, async (_e, handleId: string) => {
    const tab = await browser.newTab(handleId, 'user')
    if (tab === null) throw new Error('The browser is off for this session.')
    return tab
  })
  handle(IpcChannels.browserCloseTab, (_e, handleId: string, tab: number) => browser.closeTab(handleId, tab, 'user'))
  handle(IpcChannels.browserNavigate, (_e, handleId: string, tab: number, url: string) => browser.navigate(handleId, tab, url, 'user'))
  handle(IpcChannels.browserNav, (_e, handleId: string, tab: number, action: 'back' | 'forward' | 'reload' | 'stop') =>
    browser.nav(handleId, tab, action)
  )
  handle(IpcChannels.browserDrive, (_e, handleId: string, action: 'stop' | 'handback' | 'takeover' | 'reset', tab?: number) =>
    browser.drive(handleId, action, tab)
  )
  handle(IpcChannels.browserAnnotate, (_e, handleId: string, tab: number, on: boolean) =>
    on === true ? annotator.start(handleId, tab) : annotator.stop(handleId, 'user')
  )
  handle(IpcChannels.browserSiteVerdict, (_e, handleId: string, requestId: string, allow: boolean) =>
    browser.siteVerdict(handleId, requestId, allow)
  )
  handle(IpcChannels.browserLoginVerdict, (_e, handleId: string, requestId: string, verdict: Parameters<BrowserManager['loginVerdict']>[2]) =>
    browser.loginVerdict(handleId, requestId, verdict)
  )
  handle(IpcChannels.browserListSites, () => listSites())
  handle(IpcChannels.browserRemoveSite, (_e, site: string) => removeSite(site))
  handle(IpcChannels.browserLocalNetDecide, (_e, site: string, allow: boolean) =>
    typeof site === 'string' && typeof allow === 'boolean' ? browser.localNetDecide(site, allow) : undefined
  )
  handle(IpcChannels.browserListLocalNet, () => listLocalNet())
  handle(IpcChannels.browserForgetLocalNet, (_e, site: string) => (typeof site === 'string' ? browser.localNetForget(site) : undefined))
  handle(IpcChannels.browserListLogins, () => listLogins())
  handle(IpcChannels.browserSaveLogin, (_e, input: Parameters<typeof saveLogin>[0]) => saveLogin(input))
  handle(IpcChannels.browserRemoveLogin, (_e, id: string) => removeLogin(id))
  handle(IpcChannels.browserVaultAvailable, () => vaultAvailable())
  handle(IpcChannels.browserDataInfo, () => browser.dataInfo())
  handle(IpcChannels.browserClearData, (_e, what: ClearBrowsingData) =>
    browser.clearData({ cookies: what?.cookies === true, cache: what?.cache === true, history: what?.history === true })
  )

  handle(
    IpcChannels.respondPermission,
    async (_e, handleId: string, verdict: PermissionVerdict) => {
      manager.respondPermission(handleId, verdict)
    }
  )

  handle(IpcChannels.respondElicitation, (_e, handleId: string, requestId: string, response: ElicitationResponse) =>
    manager.respondElicitation(handleId, requestId, response)
  )

  handle(IpcChannels.listSessions, async () => listSessions())

  handle(IpcChannels.deleteSession, async (_e, projectSlug: string, id: string) => {
    await deleteSession(projectSlug, id)
  })

  handle(IpcChannels.renameSession, async (_e, id: string, name: string) => {
    await renameSession(id, name)
  })

  handle(IpcChannels.readTranscript, async (_e, sessionId: string) =>
    readTranscript(sessionId)
  )
  handle(IpcChannels.readAgentTranscript, async (_e, agentId: string) =>
    readAgentTranscript(agentId)
  )
  handle(IpcChannels.readAgentTranscriptByToolUseId, async (_e, toolUseId: string) =>
    readAgentTranscriptByToolUseId(toolUseId)
  )

  // Title/cwd lookup for search results, from the same source the sidebar uses. Cached
  // with a short TTL: listSessions scans every file's first lines (~500ms on a big
  // corpus) and titles change rarely, so re-scanning on every keystroke dominated
  // search latency. TTL keeps freshly-renamed/created sessions current within seconds.
  let searchMetaCache: { at: number; map: Map<string, { title: string; cwd: string }> } | null = null
  const SEARCH_META_TTL = 10_000
  const getSearchMeta = async (
    now: number
  ): Promise<Map<string, { title: string; cwd: string }>> => {
    if (searchMetaCache && now - searchMetaCache.at < SEARCH_META_TTL) return searchMetaCache.map
    const groups = await listSessions()
    const map = new Map<string, { title: string; cwd: string }>()
    for (const g of groups) for (const s of g.sessions) map.set(s.id, { title: s.title, cwd: s.cwd })
    searchMetaCache = { at: now, map }
    return map
  }
  handle(
    IpcChannels.searchSessions,
    async (_e, query: string, queryId: number, opts?: { scopeSlug?: string; userOnly?: boolean }) => {
      // Date.now() is fine in main (only the workflow sandbox forbids it).
      const meta = await getSearchMeta(Date.now())
      const titleFor = (sessionId: string): { title: string; cwd: string } =>
        meta.get(sessionId) ?? { title: sessionId.slice(0, 8), cwd: '' }
      return searchSessions(query, queryId, titleFor, opts ?? {})
    }
  )
  // Workspaces for the search scope dropdown (slug + label + count), from listSessions.
  handle(IpcChannels.listWorkspaces, async () => {
    const groups = await listSessions()
    // Each ProjectGroup is one workspace (cwd). Derive the slug from the first session.
    return groups
      .map((g) => ({
        slug: g.sessions[0]?.projectSlug ?? '',
        label: g.label,
        cwd: g.cwd,
        count: g.sessions.length
      }))
      .filter((w) => w.slug)
  })
  handle(IpcChannels.warmSearchCache, async () => {
    void getSearchMeta(Date.now()) // warm the title map too (fire-and-forget)
    await warmSearchCache()
  })

  // Export a session to Markdown. Reads the jsonl directly (no resume/spawn, so it works
  // on dormant sessions), then a native Save dialog lets the USER choose the location
  // (Clui never silently writes a file). Returns the saved path, or null if cancelled.
  handle(IpcChannels.exportSession, async (_e, sessionId: string) => {
    if (!mainWindow) return null
    const meta = await getSearchMeta(Date.now())
    const info = meta.get(sessionId) ?? { title: sessionId.slice(0, 8), cwd: '' }
    const models = await readSessionModels()
    const model = models[sessionId]?.model
    // ISO date (yyyy-mm-dd) for the provenance line.
    const date = new Date().toISOString().slice(0, 10)
    const md = await exportSessionMarkdown(sessionId, { title: info.title, cwd: info.cwd, model, date })
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Export conversation',
      defaultPath: exportFilename(info.title),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (res.canceled || !res.filePath) return null
    await writeFile(res.filePath, md, 'utf8')
    return res.filePath
  })

  handle(IpcChannels.getSessionModels, async () => readSessionModels())
  handle(
    IpcChannels.setSessionModel,
    async (_e, sessionId: string, prefs: { model?: string; effort?: string }) => {
      await setSessionModel(sessionId, prefs)
    }
  )
  handle(IpcChannels.deleteSessionModel, async (_e, sessionId: string) => {
    if (typeof sessionId === 'string') changeRefs.deleteSession(sessionId)
    await Promise.all([deleteSessionModel(sessionId), deleteSessionUsage(sessionId), deleteSurfaces(sessionId)])
  })

  // Browser tabs come from main's own records. A session running without the browser keeps the ones it saved.
  const saveFor = (handleId: unknown, save: unknown): Promise<void> =>
    typeof handleId === 'string' ? saveSession(handleId, save, browser.records(handleId) ?? undefined) : Promise.resolve()
  handle(IpcChannels.saveSurfaces, (_e, handleId: string, save: unknown) => saveFor(handleId, save))
  ipcMain.on(IpcChannels.saveSurfacesSync, (e, handleId: unknown, save: unknown) => {
    if (fromTrustedFrame(e)) void saveFor(handleId, save)
    e.returnValue = null
  })
  // The grant covers only the path the dialog returned, for the asking session. The renderer's defaultPath only picks where the dialog starts.
  handle(IpcChannels.chooseSurfaceFile, async (_e, handleId: string, defaultPath: string) => {
    if (!mainWindow || typeof handleId !== 'string' || manager.cwd(handleId) === null) return null
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      ...(typeof defaultPath === 'string' && isAbsolute(defaultPath) ? { defaultPath } : {})
    })
    const picked = res.canceled ? undefined : res.filePaths[0]
    if (!picked || !(await files.grant(handleId, 'file', picked))) return null
    const r = await files.resolveAllowed(handleId, picked, { consumer: 'file', operation: 'read-file' })
    return r.ok ? r.path : null
  })

  // The sources readConfig returns are the only files the editor may open without a session.
  handle(IpcChannels.readConfig, async (_e, cwd: string | null) => {
    const bundle = await readConfig(cwd)
    const sources = [...bundle.agents, ...bundle.skills, ...bundle.hooks, ...bundle.mcpServers]
    await Promise.all(sources.map((s) => s.filePath && files.grant(null, 'editor', s.filePath)))
    return bundle
  })

  const editorTarget = async (handleId: string | null, path: string): Promise<string> => {
    const r = await files.resolveAllowed(handleId, path, { consumer: 'editor', operation: 'open-external' })
    if (r.ok) return r.path
    const name = typeof path === 'string' ? basename(path) : 'the file'
    // Only a file Claude changed is known to have existed; any other path may never have.
    const changed = r.reason === 'missing' && !!handleId && !!(await manager.changes(handleId))?.some((c) => c.path === path)
    throw new Error(
      r.reason === 'missing'
        ? changed
          ? `Couldn't open ${name}. It's no longer on disk, so it was deleted or moved.`
          : `Couldn't open ${name}. It isn't on disk.`
        : `Couldn't open ${name}. Clui only opens files in this session's folder or files Claude changed; open it from your editor instead.`
    )
  }

  handle(IpcChannels.openInEditor, async (_e, handleId: string | null, filePath: string, line?: unknown) => {
    const target = await editorTarget(handleId, filePath)
    const { editorCommand } = await getSettings()
    const cmd = editorCommand || 'code'
    try {
      await openInEditor(cmd, target, Number.isSafeInteger(line) && (line as number) > 0 ? (line as number) : undefined)
    } catch {
      throw new Error(`Couldn't open ${basename(target)} in your editor. Clui runs "${cmd}"; check it's on your PATH, or change Editor command in Settings.`)
    }
  })

  handle(IpcChannels.openDiff, async (_e, handleId: string, left: string, right: string) => {
    if (typeof handleId !== 'string') throw new Error("Couldn't open the diff. It doesn't belong to an open session.")
    const [a, b] = await Promise.all([editorTarget(handleId, left), editorTarget(handleId, right)])
    const { editorCommand } = await getSettings()
    await openDiff(editorCommand || 'code', a, b)
  })

  const fileFor = (handleId: unknown, path: unknown, operation: 'read-file' | 'watch-file' | 'open-external') =>
    files.resolveAllowed(typeof handleId === 'string' ? handleId : '', path as string, { consumer: 'file', operation })
  handle(IpcChannels.readText, async (_e, handleId: string, path: string) => {
    const r = await fileFor(handleId, path, 'read-file')
    return r.ok ? readText(r) : r
  })
  handle(IpcChannels.statFile, async (_e, handleId: string, path: string) => {
    const r = await fileFor(handleId, path, 'read-file')
    return r.ok ? statFile(r) : r
  })
  const watchFor = async (handleId: string, r: FileResource | Refusal): Promise<{ ok: true; id: string } | Refusal> => {
    if (!r.ok) return r
    let id = ''
    const w = await files.watch(r, () => push(IpcChannels.fileChanged, { handleId, id }))
    if (!w.ok) return w
    // The session may have ended while the watch was being set up; its dispose has already run.
    if (manager.cwd(handleId) === null) {
      files.unwatch(w.id)
      return { ok: false, reason: 'denied' }
    }
    watchOwners.set((id = w.id), handleId)
    return w
  }
  handle(IpcChannels.watchFile, async (_e, handleId: string, path: string) => watchFor(handleId, await fileFor(handleId, path, 'watch-file')))
  const cwdOf = (handleId: unknown): string | null => (typeof handleId === 'string' ? manager.cwd(handleId) : null)
  handle(IpcChannels.listDir, (_e, handleId: string, rel: string) => listTree(files, handleId, cwdOf(handleId), rel))
  handle(IpcChannels.watchDir, async (_e, handleId: string, rel: string) => watchFor(handleId, await treeTarget(files, handleId, cwdOf(handleId), rel, 'watch-directory')))
  handle(IpcChannels.revealPath, async (_e, handleId: string, path: string) => {
    const r = await files.resolveAllowed(typeof handleId === 'string' ? handleId : '', path, { consumer: 'tree', operation: 'open-external' })
    const name = typeof path === 'string' ? basename(path) : 'the file'
    if (!r.ok) return { ok: false, message: `Couldn't show ${name} in Finder. ${r.reason === 'missing' ? "It's no longer on disk." : "Clui only shows items in this session's folder."}` }
    shell.showItemInFolder(r.path)
    return { ok: true }
  })
  handle(IpcChannels.showContextMenu, (e, raw: unknown, rawAt: unknown) => {
    const items = parseMenuItems(raw)
    const at = parseAnchor(rawAt)
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!items || at === null || !win) throw new Error('showContextMenu: invalid menu')
    return popupMenu(win, items, at)
  })
  handle(IpcChannels.unwatchFile, async (_e, handleId: string, id: string) => {
    if (typeof id !== 'string' || watchOwners.get(id) !== handleId) return
    watchOwners.delete(id)
    files.unwatch(id)
  })
  handle(IpcChannels.openPath, async (_e, handleId: string, path: string) => {
    const r = await fileFor(handleId, path, 'open-external')
    const name = typeof path === 'string' ? basename(path) : 'the file'
    if (!r.ok) return { ok: false, message: `Couldn't open ${name}. ${r.reason === 'missing' ? "It's no longer on disk." : "Clui can't open it from this session."}` }
    // A default app is a viewer here, never a way to run something: no folders, bundles, scripts or executables.
    const s = await stat(r.path).catch(() => null)
    if (!s) return { ok: false, message: `Couldn't open ${name}. It's no longer on disk.` }
    if (LAUNCHERS.test(r.path) || (!s.isDirectory() && s.mode & 0o111)) {
      return { ok: false, message: `Couldn't open ${name}. Clui doesn't open apps or files that can run as programs. Open it from Finder instead.` }
    }
    if (s.isDirectory()) return { ok: false, message: `Couldn't open ${name}. It's a folder, and Clui only opens files.` }
    const err = await shell.openPath(r.path)
    return err ? { ok: false, message: `Couldn't open ${name}. ${err}` } : { ok: true }
  })
  handle(IpcChannels.getChangeMarks, async (_e, handleId: string, path: string) =>
    typeof handleId === 'string' && typeof path === 'string' && path.length <= 4096 ? changeMarks(diffSource, handleId, path) : null
  )

  handle(IpcChannels.getDiff, async (_e, handleId: string, raw: unknown) => {
    const req = parseDiffRequest(raw)
    return typeof handleId === 'string' && req ? getDiff(diffSource, handleId, req) : null
  })

  handle(IpcChannels.openChangeDiff, async (_e, handleId: string, raw: unknown) => {
    const req = parseDiffRequest(raw)
    if (typeof handleId !== 'string' || !req || !diffs) return { ok: false, message: "Couldn't open the diff. It doesn't belong to an open session." }
    const editor = (await getSettings()).editorCommand || 'code'
    return diffs.open(handleId, req, editor, (a, b) => openDiff(editor, a, b))
  })

  handle(IpcChannels.openExternal, async (_e, url: string) => {
    // Only allow web links from markdown, never file:// or arbitrary schemes
    // (defense against a malicious link in model output opening a local target).
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })

  handle(IpcChannels.listWorkspaceFiles, async (_e, handleId: string) => {
    const cwd = typeof handleId === 'string' ? manager.cwd(handleId) : null
    // No home/root narrowing here: it returns paths, not contents, and the session's CLI can already read all of its cwd.
    const root = cwd === null ? null : await realpath(cwd).catch(() => null)
    if (!root || !(await stat(root).catch(() => null))?.isDirectory()) throw new Error('The folder no longer exists.')
    return listWorkspaceFiles(root)
  })

  handle(IpcChannels.classifyRefPaths, (_e, handleId: unknown, paths: unknown) => classifyRefPaths(packetDeps, handleId, paths))
  handle(IpcChannels.createChangeRef, (_e, handleId: unknown, req: unknown) => createChangeRef(handleId, req))
  handle(IpcChannels.changeRefStatus, (_e, handleId: unknown, refs: unknown) => changeRefStatus(packetDeps, handleId, refs))
  handle(IpcChannels.changeRefPeek, (_e, handleId: unknown, ref: unknown) => {
    const l = typeof handleId === 'string' && typeof ref === 'string' && CHANGE_REF.test(ref) ? changeRefs.locator(handleId, ref) : null
    return l ? { ok: true, text: l.text, side: l.side, ...(l.old ? { old: l.old } : {}), ...(l.new ? { new: l.new } : {}), bytes: l.bytes } : { ok: false }
  })

  handle(IpcChannels.editLine, async (_e, handleId: string, path: string, editId: string) => {
    if (typeof handleId !== 'string' || typeof path !== 'string' || typeof editId !== 'string') return null
    const segs = await manager.segments(handleId, path)
    return segs && editLine(segs, editId)
  })
  handle(IpcChannels.getChanges, (_e, handleId: string) => (typeof handleId === 'string' ? manager.changes(handleId) : null))
  handle(IpcChannels.getChangeGitStatus, async (_e, handleId: string) => {
    const changes = typeof handleId === 'string' ? await manager.changes(handleId) : null
    return changes && readGitStatus(changes.map((c) => c.path))
  })

  handle(IpcChannels.getSettings, async () => getResolvedSettings())

  handle(
    IpcChannels.updateSettings,
    async (_e, patch: Partial<CluiSettings>, clear?: SettingsKey[]) => {
      const next = await updateSettings(patch, clear ?? [])
      if ('theme' in patch || clear?.includes('theme')) {
        nativeTheme.themeSource = getSettingsSync().theme
        mainWindow?.setBackgroundColor(windowBg())
        browser.repaint()
      }
      mainWindow?.webContents.send(IpcChannels.settingsChanged, next)
      return next
    }
  )

  handle(IpcChannels.detectCliAt, async (_e, path: string) => detectCli(path || null))

  handle(IpcChannels.listModels, async (_e, refresh?: boolean) => listModels(refresh))

  // Synchronous: the preload calls this before first paint to set <html data-theme>
  // with no flash. Returns the concrete resolved theme ('dark' | 'light').
  ipcMain.on(IpcChannels.getHomeDirSync, (e) => {
    e.returnValue = fromTrustedFrame(e) ? homedir() : ''
  })
  ipcMain.on(IpcChannels.getResolvedThemeSync, (e) => {
    // Same trusted-frame gate as the async handlers; an untrusted frame just gets the
    // default theme rather than a live read.
    e.returnValue = fromTrustedFrame(e) ? resolveTheme() : 'dark'
  })

  // When following the OS theme, repaint the window chrome background on OS change
  // (the renderer separately re-applies data-theme via its own media listener).
  nativeTheme.on('updated', () => {
    // isDestroyed() first: reading webContents on a destroyed window throws.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IpcChannels.reducedTransparencyChanged, nativeTheme.prefersReducedTransparency)
    }
    if (getSettingsSync().theme === 'system') {
      mainWindow?.setBackgroundColor(windowBg())
      browser.repaint()
    }
  })

  handle(IpcChannels.getSystemPermissionMode, async () => {
    // Read the user's ~/.claude/settings.json fresh (read-only) for what "System Default" resolves to.
    // null when it sets no default mode, so the UI can tell that apart from an explicit `default`.
    return (await readCliSettings()).defaultMode ?? null
  })

  handle(IpcChannels.getEffortCaps, async () => {
    // Both caps were already validated against EFFORT_CHOICES in readCliSettings, so the
    // stored strings are EffortChoice at runtime; narrow at this boundary.
    const { maxEffortLevel, modelSettings } = await readCliSettings()
    return { maxEffortLevel, modelSettings } as EffortCaps
  })
}

// Single-instance lock: a second Clui launch must NOT spawn a rival process. Two
// Clui instances could each `--resume` the same session and both append to one jsonl
// (an unguarded corruption hazard; the CLI writes no lockfile). Acquiring the lock
// makes a 2nd launch hand off to the already-running instance (which focuses its
// window) and quit. Must run BEFORE whenReady. (The intra-Clui double-spawn case is
// already guarded in the store; this closes the cross-instance case at ~zero cost.)
// The fuses close --inspect, but Chromium's remote debugging port would still let another local
// process drive Clui's pages, the signed-in browser pane among them.
if (app.isPackaged && app.commandLine.hasSwitch('remote-debugging-port')) app.exit(1)

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // Someone tried to launch a second Clui; focus/restore ours instead.
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    } else {
      createWindow()
    }
  })

  app.whenReady().then(async () => {
    // Warm the settings cache BEFORE creating the window so the sync theme IPC and
    // the window backgroundColor resolve to the persisted theme (not defaults).
    await getSettings()
    // Native menus, dialogs and every webContents' prefers-color-scheme follow Clui's theme, not the OS's.
    nativeTheme.themeSource = getSettingsSync().theme
    registerIpc()
    buildMenu()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  sessionManager?.stopAll()
  // Stopped sessions emit no exit event, so their pages would outlive the window.
  browserManager?.disposeAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  sessionManager?.stopAll()
  diffs?.clear()
})

// Quitting waits for the last pane saves the window's unload handed over, at most 2s so a stalled disk
// can't leave the app unquittable.
let surfacesFlushed = false
app.on('will-quit', (e) => {
  if (surfacesFlushed) return
  e.preventDefault()
  surfacesFlushed = true
  // Electron ignores app.quit() until this event's dispatch returns, and an already-settled flush would
  // call it from the dispatch's own microtasks, so the quit goes on a later task.
  void Promise.race([flushSurfaces(), new Promise((r) => setTimeout(r, 2000))]).finally(() => setImmediate(() => app.quit()))
})
