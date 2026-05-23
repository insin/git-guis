import path from 'node:path'

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  type OpenDialogOptions,
  shell,
} from 'electron'

import { GitService } from './services/gitService.js'

const git = new GitService()

let mainWindow: BrowserWindow | null = null

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
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
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
ipcMain.handle('git:getStatus', (_event, repoPath: string) => git.getStatus(repoPath))
ipcMain.handle('git:getDiff', (_event, repoPath: string, filePath: string, staged: boolean) =>
  git.getDiff(repoPath, filePath, staged),
)
ipcMain.handle('git:stageFile', (_event, repoPath: string, filePath: string) =>
  git.stageFile(repoPath, filePath),
)
ipcMain.handle('git:unstageFile', (_event, repoPath: string, filePath: string) =>
  git.unstageFile(repoPath, filePath),
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
