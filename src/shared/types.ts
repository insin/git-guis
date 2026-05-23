export type ChangeKind =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflicted'
  | 'binary'

export type FileChange = {
  path: string
  oldPath?: string
  kind: ChangeKind
  staged: boolean
  unstaged: boolean
  indexStatus: string
  worktreeStatus: string
}

export type RepoStatus = {
  root: string
  branch: string | null
  headOid: string | null
  unstaged: FileChange[]
  staged: FileChange[]
  hasConflicts: boolean
  lastRefreshedAt: number
}

export type GitResult<T = void> = {
  ok: boolean
  data?: T
  error?: string
}

export type RepoValidation = {
  root: string
  branch: string | null
}

export type WorktreeInfo = {
  path: string
  head: string | null
  branch: string | null
  bare: boolean
  detached: boolean
}
