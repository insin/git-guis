import { contextBridge, ipcRenderer } from 'electron'

import type { GitApi } from '../src/shared/api.js'

const gitApi: GitApi = {
  openRepository: () => ipcRenderer.invoke('dialog:openRepository'),
  validateRepository: (repoPath) => ipcRenderer.invoke('git:validateRepository', repoPath),
  getStatus: (repoPath) => ipcRenderer.invoke('git:getStatus', repoPath),
  getDiff: (repoPath, filePath, staged) =>
    ipcRenderer.invoke('git:getDiff', repoPath, filePath, staged),
  stageFile: (repoPath, filePath) => ipcRenderer.invoke('git:stageFile', repoPath, filePath),
  unstageFile: (repoPath, filePath) => ipcRenderer.invoke('git:unstageFile', repoPath, filePath),
  revertFile: (repoPath, filePath, untracked) =>
    ipcRenderer.invoke('git:revertFile', repoPath, filePath, untracked),
  applyPatch: (repoPath, patch, reverse) =>
    ipcRenderer.invoke('git:applyPatch', repoPath, patch, reverse),
  commit: (repoPath, message, amend) => ipcRenderer.invoke('git:commit', repoPath, message, amend),
  getLastCommitMessage: (repoPath) => ipcRenderer.invoke('git:getLastCommitMessage', repoPath),
  listWorktrees: (repoPath) => ipcRenderer.invoke('git:listWorktrees', repoPath),
}

contextBridge.exposeInMainWorld('gitApi', gitApi)
