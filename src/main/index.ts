/**
 * Electron main process entry.
 *
 * Owns the CLI subprocesses (via SessionManager), the native window, and the IPC
 * handlers that back the preload `window.clui` API. The renderer is pure UI.
 */
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Menu, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  IpcChannels,
  type PermissionModeChoice,
  type PermissionVerdict,
  type StartSessionOptions,
  type WireAttachment
} from '../shared/ipc'
import type { EffortChoice, ModelChoice } from '../shared/settings'
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
import { readCosts, setCost, deleteCost } from './sessions/costs'
import { readSessionModels, setSessionModel, deleteSessionModel } from './sessions/models'
import { readConfig } from './config/reader'
import { openInEditor, openDiff } from './ide/open'
import { listWorkspaceFiles } from './workspace/files'
import {
  getResolvedSettings,
  getSettings,
  getSettingsSync,
  updateSettings
} from './settings/store'
import { readCliSettings } from './settings/cli-settings'
import { listModels } from './models/list'
import type { CluiSettings, SettingsKey } from '../shared/settings'

const __dirname = dirname(fileURLToPath(import.meta.url))

let mainWindow: BrowserWindow | null = null
let sessionManager: SessionManager | null = null

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
const THEME_BG = { dark: '#161617', light: '#f6f3ee' } as const

function resolveTheme(): 'dark' | 'light' {
  const pref = getSettingsSync().theme
  if (pref === 'system') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  return pref
}

/**
 * Build + install the application menu. ⌘N / ⌘W / ⌘, are defined HERE (not as
 * renderer key listeners) because macOS routes those through the app menu first:
 * a DOM listener for ⌘W would still hit Electron's default "Close Window". Menu
 * clicks push a `menuAction` to the renderer, which calls the matching store
 * action. The Edit + Window submenus use built-in ROLES so copy/paste/select-all
 * and standard window commands keep working in text fields (a custom menu that
 * omits them silently breaks clipboard shortcuts, the classic Electron gotcha).
 */
function buildMenu(): void {
  const send = (action: string): void => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    try {
      if (!win || win.isDestroyed()) return
      const wc = win.webContents
      if (!wc.isDestroyed()) wc.send(IpcChannels.menuAction, action)
    } catch {
      /* window torn down; drop */
    }
  }
  const isMac = process.platform === 'darwin'

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
        { label: 'New Named Session…', accelerator: 'CmdOrCtrl+Shift+N', click: () => send('new-named-session') },
        { label: 'Quick Switcher…', accelerator: 'CmdOrCtrl+K', click: () => send('open-palette') },
        { label: 'Close Session', accelerator: 'CmdOrCtrl+W', click: () => send('close-session') },
        ...(isMac ? [] : ([{ type: 'separator' }, { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('open-settings') }] as MenuItemConstructorOptions[])),
        { type: 'separator' },
        ...(isMac ? ([{ role: 'close' }] as MenuItemConstructorOptions[]) : ([{ role: 'quit' }] as MenuItemConstructorOptions[]))
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
          : ([{ role: 'close' }] as MenuItemConstructorOptions[]))
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Clui',
    backgroundColor: THEME_BG[resolveTheme()],
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false // preload uses Node built-ins via the bridge; keep isolation on
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

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
  const manager = new SessionManager((handleId, event) => {
    // A `claude` child's stdout can arrive WHILE the window is tearing down. When the
    // BrowserWindow itself is destroyed, even READING `mainWindow.webContents` throws
    // "Object has been destroyed" (the getter throws), so we must check
    // `mainWindow.isDestroyed()` BEFORE touching `.webContents`, and guard the
    // webContents too. Wrapped in try/catch as a final backstop (a teardown race can
    // still slip between the check and the send). A latent race, amplified by the
    // ~200 task_progress events a workflow emits.
    try {
      if (!mainWindow || mainWindow.isDestroyed()) return
      const wc = mainWindow.webContents
      if (!wc.isDestroyed()) wc.send(IpcChannels.sessionEvent, { handleId, event })
    } catch {
      /* window torn down mid-send; drop the event */
    }
  })
  sessionManager = manager

  ipcMain.handle(IpcChannels.pickWorkspace, async () => {
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

  ipcMain.handle(IpcChannels.getCliInfo, async () => {
    const { cliPath } = await getSettings()
    return detectCli(cliPath || null)
  })

  ipcMain.handle(IpcChannels.startSession, async (_e, opts: StartSessionOptions) => {
    const settings = await getSettings()
    const info = await detectCli(settings.cliPath || null)
    if (!info.path) throw new Error('claude CLI not found — set its path in Settings')
    // Finder/app-drawer-launched Electron gets a minimal env, so the spawned CLI would
    // miss the user's Bedrock/Vertex/API-key auth vars → "Not logged in". Pull the
    // auth-relevant subset from the login shell (like detect.ts does for PATH) and merge
    // it into the child env. Cached; best-effort (empty → CLI behaves as before).
    const authEnv = await loginShellAuthEnv()
    const handleId = manager.start({
      cliPath: info.path,
      cwd: opts.cwd,
      resumeSessionId: opts.resumeSessionId,
      fork: opts.fork,
      name: opts.name,
      env: authEnv,
      // Model/effort: per-session override wins over the global default.
      // model is the raw --model value (id or alias).
      model: opts.model ?? settings.model,
      effort: opts.effort ?? settings.effort,
      // Always open the stdio approval channel so any tool the CLI asks about can
      // be answered in the UI (inert when the mode never asks).
      gated: true,
      // Per-session override wins over the global default; 'inherit' → no flag
      // (honor ~/.claude/settings.json). Never writes any settings file.
      permissionMode: modeToFlag(opts.permissionMode ?? settings.permissionMode)
    })
    return { handleId }
  })

  ipcMain.handle(
    IpcChannels.sendMessage,
    async (_e, handleId: string, text: string, attachments?: WireAttachment[]) => {
      manager.send(handleId, text, attachments)
    }
  )

  ipcMain.handle(IpcChannels.interrupt, async (_e, handleId: string) => {
    manager.interrupt(handleId)
  })

  ipcMain.handle(IpcChannels.stopTask, async (_e, handleId: string, taskId: string) => {
    return manager.stopTask(handleId, taskId)
  })

  ipcMain.handle(IpcChannels.backgroundTask, async (_e, handleId: string, toolUseId: string) => {
    return manager.backgroundTask(handleId, toolUseId)
  })

  ipcMain.handle(
    IpcChannels.setPermissionMode,
    async (_e, handleId: string, mode: PermissionModeChoice) => {
      // 'inherit' has no CLI equivalent mid-session (there's no "unset"); map it
      // to 'default' so switching back to an asking mode still works. This still
      // never writes any settings file; it's a live control message only.
      manager.setPermissionMode(handleId, mode === 'inherit' ? 'default' : mode)
    }
  )

  ipcMain.handle(IpcChannels.setModel, async (_e, handleId: string, model: ModelChoice) => {
    // model is the raw --model value; pass it straight through.
    if (model) manager.setModel(handleId, model)
  })

  ipcMain.handle(IpcChannels.setEffort, async (_e, handleId: string, effort: EffortChoice) => {
    await manager.setEffort(handleId, effort)
  })
  ipcMain.handle(IpcChannels.setUltracode, async (_e, handleId: string, on: boolean) => {
    await manager.setUltracode(handleId, on)
  })

  ipcMain.handle(IpcChannels.stopSession, async (_e, handleId: string) => {
    manager.stop(handleId)
  })

  ipcMain.handle(
    IpcChannels.respondPermission,
    async (_e, handleId: string, verdict: PermissionVerdict) => {
      manager.respondPermission(handleId, verdict)
    }
  )

  ipcMain.handle(IpcChannels.listSessions, async () => listSessions())

  ipcMain.handle(IpcChannels.deleteSession, async (_e, projectSlug: string, id: string) => {
    await deleteSession(projectSlug, id)
  })

  ipcMain.handle(IpcChannels.renameSession, async (_e, id: string, name: string) => {
    await renameSession(id, name)
  })

  ipcMain.handle(IpcChannels.readTranscript, async (_e, sessionId: string) =>
    readTranscript(sessionId)
  )
  ipcMain.handle(IpcChannels.readAgentTranscript, async (_e, agentId: string) =>
    readAgentTranscript(agentId)
  )
  ipcMain.handle(IpcChannels.readAgentTranscriptByToolUseId, async (_e, toolUseId: string) =>
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
  ipcMain.handle(
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
  ipcMain.handle(IpcChannels.listWorkspaces, async () => {
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
  ipcMain.handle(IpcChannels.warmSearchCache, async () => {
    void getSearchMeta(Date.now()) // warm the title map too (fire-and-forget)
    await warmSearchCache()
  })

  // Export a session to Markdown. Reads the jsonl directly (no resume/spawn, so it works
  // on dormant sessions), then a native Save dialog lets the USER choose the location
  // (Clui never silently writes a file). Returns the saved path, or null if cancelled.
  ipcMain.handle(IpcChannels.exportSession, async (_e, sessionId: string) => {
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

  ipcMain.handle(IpcChannels.getSessionCosts, async () => readCosts())
  ipcMain.handle(IpcChannels.setSessionCost, async (_e, sessionId: string, usd: number) => {
    await setCost(sessionId, usd)
  })
  ipcMain.handle(IpcChannels.deleteSessionCost, async (_e, sessionId: string) => {
    await deleteCost(sessionId)
  })
  ipcMain.handle(IpcChannels.getSessionModels, async () => readSessionModels())
  ipcMain.handle(
    IpcChannels.setSessionModel,
    async (_e, sessionId: string, prefs: { model?: string; effort?: string }) => {
      await setSessionModel(sessionId, prefs)
    }
  )
  ipcMain.handle(IpcChannels.deleteSessionModel, async (_e, sessionId: string) => {
    await deleteSessionModel(sessionId)
  })

  ipcMain.handle(IpcChannels.readConfig, async (_e, cwd: string | null) => readConfig(cwd))

  ipcMain.handle(IpcChannels.openInEditor, async (_e, filePath: string) => {
    const { editorCommand } = await getSettings()
    await openInEditor(editorCommand || 'code', filePath)
  })

  ipcMain.handle(IpcChannels.openDiff, async (_e, left: string, right: string) => {
    const { editorCommand } = await getSettings()
    await openDiff(editorCommand || 'code', left, right)
  })

  ipcMain.handle(IpcChannels.openExternal, async (_e, url: string) => {
    // Only allow web links from markdown, never file:// or arbitrary schemes
    // (defense against a malicious link in model output opening a local target).
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })

  ipcMain.handle(IpcChannels.listWorkspaceFiles, async (_e, cwd: string) => {
    try {
      return await listWorkspaceFiles(cwd)
    } catch {
      return { files: [], truncated: false }
    }
  })

  ipcMain.handle(IpcChannels.filterExistingFiles, async (_e, paths: string[]) => {
    // Prune paths that no longer exist (deleted this turn, including by the agent
    // via Bash rm, which never surfaces a file_path). Keeps the changed-files list
    // accurate. Best-effort: any stat error → treat as gone.
    return (Array.isArray(paths) ? paths : []).filter((p) => {
      try {
        return existsSync(p)
      } catch {
        return false
      }
    })
  })

  ipcMain.handle(IpcChannels.getSettings, async () => getResolvedSettings())

  ipcMain.handle(
    IpcChannels.updateSettings,
    async (_e, patch: Partial<CluiSettings>, clear?: SettingsKey[]) =>
      updateSettings(patch, clear ?? [])
  )

  ipcMain.handle(IpcChannels.detectCliAt, async (_e, path: string) => detectCli(path || null))

  ipcMain.handle(IpcChannels.listModels, async (_e, refresh?: boolean) => listModels(refresh))

  // Synchronous: the preload calls this before first paint to set <html data-theme>
  // with no flash. Returns the concrete resolved theme ('dark' | 'light').
  ipcMain.on(IpcChannels.getResolvedThemeSync, (e) => {
    e.returnValue = resolveTheme()
  })

  // When following the OS theme, repaint the window chrome background on OS change
  // (the renderer separately re-applies data-theme via its own media listener).
  nativeTheme.on('updated', () => {
    if (getSettingsSync().theme === 'system') {
      mainWindow?.setBackgroundColor(THEME_BG[resolveTheme()])
    }
  })

  ipcMain.handle(IpcChannels.getSystemPermissionMode, async () => {
    // Read the user's ~/.claude/settings.json fresh (read-only) and report what
    // "System Default" resolves to. Defaults to 'default' if unset/unreadable.
    return (await readCliSettings()).defaultMode ?? 'default'
  })
}

// Single-instance lock: a second Clui launch must NOT spawn a rival process. Two
// Clui instances could each `--resume` the same session and both append to one jsonl
// (an unguarded corruption hazard; the CLI writes no lockfile). Acquiring the lock
// makes a 2nd launch hand off to the already-running instance (which focuses its
// window) and quit. Must run BEFORE whenReady. (The intra-Clui double-spawn case is
// already guarded in the store; this closes the cross-instance case at ~zero cost.)
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
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  sessionManager?.stopAll()
})
