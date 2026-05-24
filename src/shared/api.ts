import type {
  GitDiff,
  GitResult,
  RepoStatus,
  RepoValidation,
  ThemeName,
  WorktreeInfo,
} from './types.js'

export type GitApi = {
  openRepository(): Promise<string | null>
  validateRepository(repoPath: string): Promise<GitResult<RepoValidation>>
  getStatus(repoPath: string, amend?: boolean): Promise<GitResult<RepoStatus>>
  getDiff(
    repoPath: string,
    filePath: string,
    staged: boolean,
    amend?: boolean,
  ): Promise<GitResult<GitDiff>>
  stageFile(repoPath: string, filePath: string): Promise<GitResult>
  unstageFile(repoPath: string, filePath: string, amend?: boolean): Promise<GitResult>
  revertFile(repoPath: string, filePath: string, untracked: boolean): Promise<GitResult>
  applyPatch(repoPath: string, patch: string, reverse: boolean): Promise<GitResult>
  commit(repoPath: string, message: string, amend: boolean): Promise<GitResult<string>>
  getLastCommitMessage(repoPath: string): Promise<GitResult<string>>
  listWorktrees(repoPath: string): Promise<GitResult<WorktreeInfo[]>>
}

export type AppApi = {
  setTheme(theme: ThemeName): void
  getLaunchRepositories(): Promise<string[]>
  onThemeSelected(callback: (theme: ThemeName) => void): () => void
  onOpenRepository(callback: () => void): () => void
  onOpenRepositoryPath(callback: (repoPath: string) => void): () => void
}
