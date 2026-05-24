import path from 'node:path'

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  nativeTheme,
  type OpenDialogOptions,
  shell,
} from 'electron'

import type { ThemeName } from '../src/shared/types.js'
import { GitService } from './services/gitService.js'

const git = new GitService()

let mainWindow: BrowserWindow | null = null
let currentTheme: ThemeName = 'system'
const pendingRepositoryPaths = new Set<string>()

const themeLabels: Record<ThemeName, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
  monokai: 'Monokai Extended',
}

function setTheme(theme: ThemeName, notifyRenderer = false) {
  currentTheme = theme
  nativeTheme.themeSource = theme === 'monokai' ? 'dark' : theme
  buildApplicationMenu()
  if (notifyRenderer) mainWindow?.webContents.send('app:themeSelected', theme)
}

function themeMenuItems(): MenuItemConstructorOptions[] {
  return (Object.keys(themeLabels) as ThemeName[]).map((theme) => ({
    type: 'radio',
    label: themeLabels[theme],
    checked: currentTheme === theme,
    click: () => setTheme(theme, true),
  }))
}

function buildApplicationMenu() {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { label: 'Theme', submenu: themeMenuItems() },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Repository...',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow?.webContents.send('app:openRepository'),
        },
        ...(!isMac
          ? ([{ type: 'separator' }, { role: 'quit' }] as MenuItemConstructorOptions[])
          : []),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        ...(!isMac
          ? ([
              { label: 'Theme', submenu: themeMenuItems() },
              { type: 'separator' },
            ] as MenuItemConstructorOptions[])
          : []),
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    { role: 'windowMenu' },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function repoPathsFromArgv(argv: string[]) {
  const repoPaths: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if ((arg === '--repo' || arg === '--repository') && argv[index + 1]) {
      repoPaths.push(path.resolve(argv[index + 1]))
      index += 1
    }
  }
  return repoPaths
}

function focusMainWindow() {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function openRepositoryPath(repoPath: string) {
  const normalizedPath = path.resolve(repoPath)
  if (mainWindow && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('app:openRepositoryPath', normalizedPath)
    focusMainWindow()
    return
  }
  pendingRepositoryPaths.add(normalizedPath)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 980,
    minHeight: 620,
    titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1f1f' : '#f5f5f5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'))
  }
}

for (const repoPath of repoPathsFromArgv(process.argv)) {
  pendingRepositoryPaths.add(repoPath)
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    for (const repoPath of repoPathsFromArgv(argv)) {
      openRepositoryPath(repoPath)
    }
    focusMainWindow()
  })

  app.whenReady().then(() => {
    buildApplicationMenu()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

ipcMain.on('app:setTheme', (_event, theme: ThemeName) => setTheme(theme))

ipcMain.handle('app:getLaunchRepositories', () => {
  const repoPaths = [...pendingRepositoryPaths]
  pendingRepositoryPaths.clear()
  return repoPaths
})

ipcMain.handle('dialog:openRepository', async () => {
  const options: OpenDialogOptions = {
    title: 'Open Git Repository',
    properties: ['openDirectory'],
  }
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)

  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('git:validateRepository', (_event, repoPath: string) =>
  git.validateRepository(repoPath),
)
ipcMain.handle('git:getStatus', (_event, repoPath: string, amend: boolean) =>
  git.getStatus(repoPath, amend),
)
ipcMain.handle(
  'git:getDiff',
  (_event, repoPath: string, filePath: string, staged: boolean, amend: boolean) =>
    git.getDiff(repoPath, filePath, staged, amend),
)
ipcMain.handle('git:stageFile', (_event, repoPath: string, filePath: string) =>
  git.stageFile(repoPath, filePath),
)
ipcMain.handle('git:unstageFile', (_event, repoPath: string, filePath: string, amend: boolean) =>
  git.unstageFile(repoPath, filePath, amend),
)
ipcMain.handle(
  'git:revertFile',
  (_event, repoPath: string, filePath: string, untracked: boolean) =>
    untracked
      ? shell.trashItem(path.join(repoPath, filePath)).then(
          () => ({ ok: true }),
          (error: unknown) => ({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        )
      : git.revertFile(repoPath, filePath),
)
ipcMain.handle('git:applyPatch', (_event, repoPath: string, patch: string, reverse: boolean) =>
  git.applyPatch(repoPath, patch, reverse),
)
ipcMain.handle('git:commit', (_event, repoPath: string, message: string, amend: boolean) =>
  git.commit(repoPath, message, amend),
)
ipcMain.handle('git:getLastCommitMessage', (_event, repoPath: string) =>
  git.getLastCommitMessage(repoPath),
)
ipcMain.handle('git:listWorktrees', (_event, repoPath: string) => git.listWorktrees(repoPath))
