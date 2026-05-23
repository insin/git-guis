import type { GitResult, RepoStatus, RepoValidation, WorktreeInfo } from './types.js'

export type GitApi = {
  openRepository(): Promise<string | null>
  validateRepository(repoPath: string): Promise<GitResult<RepoValidation>>
  getStatus(repoPath: string): Promise<GitResult<RepoStatus>>
  getDiff(repoPath: string, filePath: string, staged: boolean): Promise<GitResult<string>>
  stageFile(repoPath: string, filePath: string): Promise<GitResult>
  unstageFile(repoPath: string, filePath: string): Promise<GitResult>
  revertFile(repoPath: string, filePath: string, untracked: boolean): Promise<GitResult>
  applyPatch(repoPath: string, patch: string, reverse: boolean): Promise<GitResult>
  commit(repoPath: string, message: string, amend: boolean): Promise<GitResult<string>>
  getLastCommitMessage(repoPath: string): Promise<GitResult<string>>
  listWorktrees(repoPath: string): Promise<GitResult<WorktreeInfo[]>>
}
