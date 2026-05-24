import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type {
  CommitBranch,
  CommitSummary,
  FileChange,
  GitDiff,
  GitResult,
  PushOptions,
  RepoStatus,
  RepoValidation,
  ResetMode,
  WorktreeInfo,
} from '../../src/shared/types.js'

type RunOptions = {
  input?: string
  allowFailure?: boolean
}

type RunResult = {
  stdout: string
  stderr: string
  code: number
}

const CONFLICT_STATUSES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

export class GitService {
  async validateRepository(repoPath: string): Promise<GitResult<RepoValidation>> {
    try {
      const root = (await this.git(repoPath, ['rev-parse', '--show-toplevel'])).stdout.trim()
      const branchResult = await this.git(root, ['branch', '--show-current'], {
        allowFailure: true,
      })
      return {
        ok: true,
        data: {
          root,
          branch: branchResult.stdout.trim() || null,
        },
      }
    } catch (error) {
      return failure(error)
    }
  }

  async getStatus(repoPath: string, amend = false): Promise<GitResult<RepoStatus>> {
    try {
      const result = await this.git(repoPath, [
        'status',
        '--porcelain=v2',
        '-z',
        '--branch',
        '--untracked-files=all',
      ])
      const root =
        (
          await this.git(repoPath, ['rev-parse', '--show-toplevel'], { allowFailure: true })
        ).stdout.trim() || repoPath
      const status = parsePorcelainV2(result.stdout)
      const staged = amend ? await this.getAmendStagedChanges(repoPath) : status.staged
      return {
        ok: true,
        data: { ...status, root, staged },
      }
    } catch (error) {
      return failure(error)
    }
  }

  async getDiff(
    repoPath: string,
    filePath: string,
    staged: boolean,
    amend = false,
  ): Promise<GitResult<GitDiff>> {
    try {
      const args = staged
        ? ['diff', '--cached', '--no-ext-diff', ...(amend ? ['HEAD^'] : []), '--', filePath]
        : ['diff', '--no-ext-diff', '--', filePath]
      const result = await this.git(repoPath, args, { allowFailure: true })
      if (result.code !== 0) return { ok: false, error: result.stderr || 'Unable to read diff.' }

      if (isBinaryDiff(result.stdout)) {
        return {
          ok: true,
          data: { kind: 'binary', summary: await describeBinaryFile(repoPath, filePath) },
        }
      }

      if (result.stdout.trim().length > 0 || staged)
        return { ok: true, data: { kind: 'text', patch: result.stdout } }

      const status = await this.getStatus(repoPath)
      const file = status.data?.unstaged.find((change) => change.path === filePath)
      if (file?.kind === 'untracked') {
        return this.getUntrackedDiff(repoPath, filePath)
      }

      return { ok: true, data: { kind: 'text', patch: result.stdout } }
    } catch (error) {
      return failure(error)
    }
  }

  async stageFile(repoPath: string, filePath: string): Promise<GitResult> {
    return this.runMutation(repoPath, ['add', '--', filePath])
  }

  async unstageFile(repoPath: string, filePath: string, amend = false): Promise<GitResult> {
    if (amend) {
      const reset = await this.git(repoPath, ['reset', '-q', 'HEAD^', '--', filePath], {
        allowFailure: true,
      })
      if (reset.code === 0) return { ok: true }
    }

    const restore = await this.git(repoPath, ['restore', '--staged', '--', filePath], {
      allowFailure: true,
    })
    if (restore.code === 0) return { ok: true }

    const reset = await this.git(repoPath, ['reset', '-q', 'HEAD', '--', filePath], {
      allowFailure: true,
    })
    return reset.code === 0
      ? { ok: true }
      : { ok: false, error: restore.stderr || reset.stderr || 'Unable to unstage file.' }
  }

  async revertFile(repoPath: string, filePath: string): Promise<GitResult> {
    return this.runMutation(repoPath, ['restore', '--worktree', '--', filePath])
  }

  async applyPatch(repoPath: string, patch: string, reverse: boolean): Promise<GitResult> {
    const checkArgs = ['apply', '--cached', '--check', reverse ? '--reverse' : ''].filter(Boolean)
    const applyArgs = [
      'apply',
      '--cached',
      '--whitespace=nowarn',
      reverse ? '--reverse' : '',
    ].filter(Boolean)

    const check = await this.git(repoPath, checkArgs, { input: patch, allowFailure: true })
    if (check.code !== 0)
      return { ok: false, error: check.stderr || 'Patch does not apply cleanly.' }

    const applied = await this.git(repoPath, applyArgs, { input: patch, allowFailure: true })
    return applied.code === 0
      ? { ok: true }
      : { ok: false, error: applied.stderr || 'Patch apply failed.' }
  }

  async commit(repoPath: string, message: string, amend: boolean): Promise<GitResult<string>> {
    const args = amend ? ['commit', '--amend', '--file', '-'] : ['commit', '--file', '-']
    const result = await this.git(repoPath, args, { input: message, allowFailure: true })
    return result.code === 0
      ? { ok: true, data: result.stdout }
      : { ok: false, error: result.stderr || result.stdout }
  }

  async listBranches(repoPath: string): Promise<GitResult<string[]>> {
    try {
      const result = await this.git(repoPath, ['branch', '--format=%(refname:short)'])
      return {
        ok: true,
        data: result.stdout
          .split('\n')
          .map((branch) => branch.trim())
          .filter(Boolean),
      }
    } catch (error) {
      return failure(error)
    }
  }

  async listRemotes(repoPath: string): Promise<GitResult<string[]>> {
    try {
      const result = await this.git(repoPath, ['remote'])
      return {
        ok: true,
        data: result.stdout
          .split('\n')
          .map((remote) => remote.trim())
          .filter(Boolean),
      }
    } catch (error) {
      return failure(error)
    }
  }

  async push(repoPath: string, options: PushOptions): Promise<GitResult<string>> {
    const args = ['push', '--porcelain']
    if (options.force) args.push(options.forceWithLease ? '--force-with-lease' : '--force')
    if (options.includeTags) args.push('--tags')
    args.push(options.remote, options.branch)

    const result = await this.git(repoPath, args, { allowFailure: true })
    return result.code === 0
      ? { ok: true, data: result.stdout || result.stderr }
      : { ok: false, error: result.stderr || result.stdout || 'Push failed.' }
  }

  async listCommitBranches(repoPath: string): Promise<GitResult<CommitBranch[]>> {
    try {
      const result = await this.git(repoPath, [
        'branch',
        '--all',
        '--format=%(refname)%1f%(refname:short)%1f%(objectname)%1f%(HEAD)%1e',
      ])
      return { ok: true, data: parseCommitBranches(result.stdout) }
    } catch (error) {
      return failure(error)
    }
  }

  async listCommits(repoPath: string, ref: string): Promise<GitResult<CommitSummary[]>> {
    try {
      const result = await this.git(repoPath, [
        'log',
        '--date=short',
        '--decorate=full',
        '--max-count=200',
        '--format=%H%x1f%h%x1f%P%x1f%s%x1f%an%x1f%ad%x1f%D%x1e',
        ref,
      ])
      return { ok: true, data: parseCommits(result.stdout) }
    } catch (error) {
      return failure(error)
    }
  }

  async checkoutBranch(repoPath: string, branch: string): Promise<GitResult> {
    return this.runMutation(repoPath, ['switch', branch])
  }

  async cherryPickCommit(repoPath: string, hash: string): Promise<GitResult<string>> {
    const result = await this.git(repoPath, ['cherry-pick', hash], { allowFailure: true })
    return result.code === 0
      ? { ok: true, data: result.stdout || result.stderr }
      : { ok: false, error: result.stderr || result.stdout || 'Cherry-pick failed.' }
  }

  async resetToCommit(repoPath: string, hash: string, mode: ResetMode): Promise<GitResult<string>> {
    const result = await this.git(repoPath, ['reset', `--${mode}`, hash], { allowFailure: true })
    return result.code === 0
      ? { ok: true, data: result.stdout || result.stderr }
      : { ok: false, error: result.stderr || result.stdout || 'Reset failed.' }
  }

  async getLastCommitMessage(repoPath: string): Promise<GitResult<string>> {
    try {
      const result = await this.git(repoPath, ['log', '-1', '--format=%B'], { allowFailure: true })
      return result.code === 0
        ? { ok: true, data: result.stdout.trimEnd() }
        : { ok: false, error: result.stderr }
    } catch (error) {
      return failure(error)
    }
  }

  async listWorktrees(repoPath: string): Promise<GitResult<WorktreeInfo[]>> {
    try {
      const result = await this.git(repoPath, ['worktree', 'list', '--porcelain'])
      return { ok: true, data: parseWorktrees(result.stdout) }
    } catch (error) {
      return failure(error)
    }
  }

  private async getAmendStagedChanges(repoPath: string): Promise<FileChange[]> {
    const result = await this.git(repoPath, ['diff', '--cached', '--name-status', '-z', 'HEAD^'], {
      allowFailure: true,
    })
    if (result.code !== 0) return []
    return parseNameStatus(result.stdout)
  }

  private async getUntrackedDiff(repoPath: string, filePath: string): Promise<GitResult<GitDiff>> {
    try {
      const absolutePath = path.join(repoPath, filePath)
      const buffer = fs.readFileSync(absolutePath)
      if (isBinaryBuffer(buffer)) {
        return {
          ok: true,
          data: { kind: 'binary', summary: await describeBinaryFile(repoPath, filePath) },
        }
      }

      const file = buffer.toString('utf8')
      const lines =
        file.length === 0
          ? []
          : file.endsWith('\n')
            ? file.slice(0, -1).split('\n')
            : file.split('\n')
      const safePath = quotePath(filePath)
      return {
        ok: true,
        data: {
          kind: 'text',
          patch: [
            `diff --git a/${safePath} b/${safePath}`,
            'new file mode 100644',
            'index 0000000..0000000',
            '--- /dev/null',
            `+++ b/${safePath}`,
            `@@ -0,0 +1,${lines.length} @@`,
            ...lines.map((line) => `+${line}`),
          ].join('\n'),
        },
      }
    } catch {
      return {
        ok: true,
        data: { kind: 'binary', summary: await describeBinaryFile(repoPath, filePath) },
      }
    }
  }

  private async runMutation(repoPath: string, args: string[]): Promise<GitResult> {
    try {
      const result = await this.git(repoPath, args, { allowFailure: true })
      return result.code === 0 ? { ok: true } : { ok: false, error: result.stderr || result.stdout }
    } catch (error) {
      return failure(error)
    }
  }

  private git(repoPath: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', ['-C', repoPath, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })

      child.on('error', reject)
      child.on('close', (code) => {
        const runResult = { stdout, stderr, code: code ?? 0 }
        if (!options.allowFailure && runResult.code !== 0) {
          reject(new Error(stderr || stdout || `git exited with code ${runResult.code}`))
          return
        }
        resolve(runResult)
      })

      if (options.input) child.stdin.write(options.input)
      child.stdin.end()
    })
  }
}

function parsePorcelainV2(stdout: string): RepoStatus {
  const records = stdout.split('\0').filter(Boolean)
  const staged = new Map<string, FileChange>()
  const unstaged = new Map<string, FileChange>()
  const root = ''
  let branch: string | null = null
  let headOid: string | null = null
  let hasConflicts = false

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record.startsWith('# branch.head ')) {
      const value = record.slice('# branch.head '.length)
      branch = value === '(detached)' ? null : value
      continue
    }
    if (record.startsWith('# branch.oid ')) {
      const value = record.slice('# branch.oid '.length)
      headOid = value === '(initial)' ? null : value
      continue
    }

    if (record.startsWith('1 ')) {
      const parts = record.split(' ')
      const xy = parts[1] ?? '..'
      const filePath = parts.slice(8).join(' ')
      addStatus(filePath, xy[0] ?? '.', xy[1] ?? '.', staged, unstaged)
      continue
    }

    if (record.startsWith('2 ')) {
      const parts = record.split(' ')
      const xy = parts[1] ?? '..'
      const filePath = parts.slice(9).join(' ')
      const oldPath = records[index + 1]
      index += oldPath ? 1 : 0
      addStatus(filePath, xy[0] ?? '.', xy[1] ?? '.', staged, unstaged, oldPath)
      continue
    }

    if (record.startsWith('u ')) {
      const parts = record.split(' ')
      const xy = parts[1] ?? 'UU'
      const filePath = parts.slice(10).join(' ')
      hasConflicts = true
      addStatus(filePath, xy[0] ?? 'U', xy[1] ?? 'U', staged, unstaged)
      continue
    }

    if (record.startsWith('? ')) {
      const filePath = record.slice(2)
      unstaged.set(filePath, {
        path: filePath,
        kind: 'untracked',
        staged: false,
        unstaged: true,
        indexStatus: '.',
        worktreeStatus: '?',
      })
    }
  }

  return {
    root,
    branch,
    headOid,
    unstaged: sortChanges([...unstaged.values()]),
    staged: sortChanges([...staged.values()]),
    hasConflicts,
    lastRefreshedAt: Date.now(),
  }
}

function addStatus(
  filePath: string,
  indexStatus: string,
  worktreeStatus: string,
  staged: Map<string, FileChange>,
  unstaged: Map<string, FileChange>,
  oldPath?: string,
) {
  const conflict = CONFLICT_STATUSES.has(`${indexStatus}${worktreeStatus}`)
  const kind = kindFromStatus(indexStatus, worktreeStatus, oldPath, conflict)

  if (indexStatus !== '.' && indexStatus !== ' ') {
    staged.set(filePath, {
      path: filePath,
      oldPath,
      kind,
      staged: true,
      unstaged: worktreeStatus !== '.' && worktreeStatus !== ' ',
      indexStatus,
      worktreeStatus,
    })
  }

  if (worktreeStatus !== '.' && worktreeStatus !== ' ') {
    unstaged.set(filePath, {
      path: filePath,
      oldPath,
      kind,
      staged: indexStatus !== '.' && indexStatus !== ' ',
      unstaged: true,
      indexStatus,
      worktreeStatus,
    })
  }
}

function kindFromStatus(
  indexStatus: string,
  worktreeStatus: string,
  oldPath: string | undefined,
  conflict: boolean,
): FileChange['kind'] {
  if (conflict) return 'conflicted'
  if (oldPath || indexStatus === 'R' || worktreeStatus === 'R') return 'renamed'
  if (indexStatus === 'A' || worktreeStatus === 'A') return 'added'
  if (indexStatus === 'D' || worktreeStatus === 'D') return 'deleted'
  if (indexStatus === 'C' || worktreeStatus === 'C') return 'copied'
  return 'modified'
}

function sortChanges(changes: FileChange[]) {
  return changes.sort((a, b) => a.path.localeCompare(b.path))
}

function parseNameStatus(stdout: string): FileChange[] {
  const records = stdout.split('\0').filter(Boolean)
  const changes: FileChange[] = []

  for (let index = 0; index < records.length; index += 1) {
    const status = records[index]
    const code = status[0] ?? 'M'
    const oldPath = code === 'R' || code === 'C' ? records[index + 1] : undefined
    const filePath = code === 'R' || code === 'C' ? records[index + 2] : records[index + 1]
    index += code === 'R' || code === 'C' ? 2 : 1
    if (!filePath) continue

    changes.push({
      path: filePath,
      oldPath,
      kind: kindFromStatus(code, '.', oldPath, false),
      staged: true,
      unstaged: false,
      indexStatus: code,
      worktreeStatus: '.',
    })
  }

  return sortChanges(changes)
}

function parseWorktrees(stdout: string): WorktreeInfo[] {
  const blocks = stdout.split(/\n(?=worktree )/).filter(Boolean)
  return blocks.map((block) => {
    const lines = block.trim().split('\n')
    const info: WorktreeInfo = {
      path: '',
      head: null,
      branch: null,
      bare: false,
      detached: false,
    }

    for (const line of lines) {
      if (line.startsWith('worktree ')) info.path = line.slice('worktree '.length)
      if (line.startsWith('HEAD ')) info.head = line.slice('HEAD '.length)
      if (line.startsWith('branch ')) info.branch = line.slice('branch refs/heads/'.length)
      if (line === 'bare') info.bare = true
      if (line === 'detached') info.detached = true
    }

    return info
  })
}

function parseCommitBranches(stdout: string): CommitBranch[] {
  return stdout
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [ref = '', name = '', commit = '', head = ''] = record.split('\x1f')
      return {
        name,
        ref,
        commit,
        current: head === '*',
        remote: ref.startsWith('refs/remotes/'),
      }
    })
    .filter((branch) => branch.name && !branch.ref.endsWith('/HEAD'))
    .sort((a, b) => Number(a.remote) - Number(b.remote) || a.name.localeCompare(b.name))
}

function parseCommits(stdout: string): CommitSummary[] {
  return stdout
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [
        hash = '',
        shortHash = '',
        parents = '',
        subject = '',
        authorName = '',
        authorDate = '',
        decorations = '',
      ] = record.split('\x1f')
      return {
        hash,
        shortHash,
        parents: parents.split(' ').filter(Boolean),
        subject,
        authorName,
        authorDate,
        refs: parseCommitRefs(decorations),
      }
    })
}

function parseCommitRefs(decorations: string) {
  return decorations
    .split(', ')
    .map((decoratedRef) => decoratedRef.trim())
    .filter(Boolean)
    .map((decoratedRef) => {
      if (decoratedRef === 'HEAD') return { type: 'head' as const, name: 'HEAD' }

      const ref = decoratedRef.startsWith('HEAD -> ')
        ? decoratedRef.slice('HEAD -> '.length)
        : decoratedRef
      if (ref.startsWith('tag: refs/tags/')) {
        return { type: 'tag' as const, name: ref.slice('tag: refs/tags/'.length) }
      }
      if (ref.startsWith('refs/heads/')) {
        return { type: 'branch' as const, name: ref.slice('refs/heads/'.length) }
      }
      if (ref.startsWith('refs/remotes/')) {
        return { type: 'remote' as const, name: ref.slice('refs/remotes/'.length) }
      }
      return { type: 'branch' as const, name: ref }
    })
}

function quotePath(filePath: string) {
  return filePath.replaceAll('\\', '\\\\').replaceAll('\n', '\\n')
}

function isBinaryDiff(diff: string) {
  return /^Binary files .+ differ$/m.test(diff) || /^GIT binary patch$/m.test(diff)
}

function isBinaryBuffer(buffer: Buffer) {
  if (buffer.includes(0)) return true
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000))
  if (sample.length === 0) return false

  let suspicious = 0
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13) continue
    if (byte >= 32 && byte <= 126) continue
    suspicious += 1
  }

  return suspicious / sample.length > 0.3
}

async function describeBinaryFile(repoPath: string, filePath: string) {
  const absolutePath = path.join(repoPath, filePath)
  const fileResult = await runFileCommand(absolutePath)
  if (fileResult) return fileResult

  try {
    const buffer = fs.readFileSync(absolutePath)
    return describeFromMagicBytes(buffer)
  } catch {
    return 'Binary file'
  }
}

function runFileCommand(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('file', ['-b', filePath], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      const summary = stdout.trim()
      resolve(code === 0 && summary ? summary : null)
    })
  })
}

function describeFromMagicBytes(buffer: Buffer) {
  if (isPng(buffer)) {
    const width = buffer.readUInt32BE(16)
    const height = buffer.readUInt32BE(20)
    const bitDepth = buffer[24]
    const colorType = pngColorType(buffer[25])
    return `PNG image data, ${width} x ${height}, ${bitDepth}-bit/color ${colorType}`
  }

  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'JPEG image data'
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a') return 'GIF image data'
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return 'GIF image data'
  if (buffer.subarray(0, 4).toString('ascii') === '%PDF') return 'PDF document'
  if (buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return 'Zip archive data'

  return 'Binary file'
}

function isPng(buffer: Buffer) {
  return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
}

function pngColorType(colorType: number | undefined) {
  if (colorType === 0) return 'grayscale'
  if (colorType === 2) return 'RGB'
  if (colorType === 3) return 'colormap'
  if (colorType === 4) return 'grayscale+alpha'
  if (colorType === 6) return 'RGBA'
  return 'PNG'
}

function failure(error: unknown): GitResult<never> {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }
}
