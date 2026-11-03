import type { FileChange } from '../../shared/types'

// Wording follows https://github.com/git/git/blob/master/git-gui/git-gui.sh (all_descs).
export function fileStatusDescription(
  staged: FileChange | undefined,
  unstaged: FileChange | undefined,
  amend = false,
): string {
  if (staged?.kind === 'conflicted' || unstaged?.kind === 'conflicted') {
    return 'Requires merge resolution'
  }

  const index = staged?.indexStatus ?? unstaged?.indexStatus ?? '.'
  const worktree = unstaged?.worktreeStatus ?? staged?.worktreeStatus ?? '.'
  const hasIndexChange = index !== '.' && index !== ' '
  let description: string

  if (index === 'D') {
    description = unstaged ? 'Staged for removal, still present' : 'Staged for removal'
  } else if (index === 'T') {
    description =
      worktree === 'D'
        ? 'File type change staged, file missing'
        : worktree === 'M'
          ? 'File type change staged, modification not staged'
          : 'File type changed, staged'
  } else if (worktree === 'T') {
    description = hasIndexChange
      ? 'File type changed, old type staged for commit'
      : 'File type changed, not staged'
  } else if (worktree === '?') {
    description = 'Untracked, not staged'
  } else if (worktree === 'D') {
    description = hasIndexChange ? 'Staged for commit, missing' : 'Missing'
  } else if (hasIndexChange) {
    description =
      worktree !== '.' && worktree !== ' ' ? 'Portions staged for commit' : 'Staged for commit'
  } else {
    description = unstaged ? 'Modified, not staged' : 'Unmodified'
  }

  return amend ? description.replace('for commit', 'for amended commit') : description
}
