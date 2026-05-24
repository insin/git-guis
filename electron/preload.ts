import { contextBridge, ipcRenderer } from 'electron'

import type { AppApi, GitApi } from '../src/shared/api.js'
import type { ThemeName } from '../src/shared/types.js'

const gitApi: GitApi = {
  openRepository: () => ipcRenderer.invoke('dialog:openRepository'),
  validateRepository: (repoPath) => ipcRenderer.invoke('git:validateRepository', repoPath),
  getStatus: (repoPath, amend) => ipcRenderer.invoke('git:getStatus', repoPath, amend),
  getDiff: (repoPath, filePath, staged, amend) =>
    ipcRenderer.invoke('git:getDiff', repoPath, filePath, staged, amend),
  stageFile: (repoPath, filePath) => ipcRenderer.invoke('git:stageFile', repoPath, filePath),
  unstageFile: (repoPath, filePath, amend) =>
    ipcRenderer.invoke('git:unstageFile', repoPath, filePath, amend),
  revertFile: (repoPath, filePath, untracked) =>
    ipcRenderer.invoke('git:revertFile', repoPath, filePath, untracked),
  applyPatch: (repoPath, patch, reverse) =>
    ipcRenderer.invoke('git:applyPatch', repoPath, patch, reverse),
  commit: (repoPath, message, amend) => ipcRenderer.invoke('git:commit', repoPath, message, amend),
  getLastCommitMessage: (repoPath) => ipcRenderer.invoke('git:getLastCommitMessage', repoPath),
  listWorktrees: (repoPath) => ipcRenderer.invoke('git:listWorktrees', repoPath),
}

const appApi: AppApi = {
  setTheme: (theme) => ipcRenderer.send('app:setTheme', theme),
  getLaunchRepositories: () => ipcRenderer.invoke('app:getLaunchRepositories'),
  onThemeSelected: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, theme: ThemeName) => callback(theme)
    ipcRenderer.on('app:themeSelected', listener)
    return () => ipcRenderer.removeListener('app:themeSelected', listener)
  },
  onOpenRepository: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('app:openRepository', listener)
    return () => ipcRenderer.removeListener('app:openRepository', listener)
  },
  onOpenRepositoryPath: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, repoPath: string) => callback(repoPath)
    ipcRenderer.on('app:openRepositoryPath', listener)
    return () => ipcRenderer.removeListener('app:openRepositoryPath', listener)
  },
}

contextBridge.exposeInMainWorld('gitApi', gitApi)
contextBridge.exposeInMainWorld('appApi', appApi)
