import { File, FileCheck, GitBranch, Plus, X } from 'lucide-react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'

import type {
  CommitBranch,
  CommitSummary,
  FileChange,
  GitDiff,
  RepoStatus,
  ResetMode,
  ThemeName,
} from '../../shared/types'
import {
  buildHunkPatch,
  buildSelectionPatch,
  type DiffLineSelection,
  type ParsedDiffLine,
  parseUnifiedDiff,
  selectedDiffText,
  withVisibleLineNumbers,
} from '../utils/diff'
import { loadJson, saveJson } from '../utils/storage'

type DiffMode = 'highlighted' | 'classic'
type Pane = 'unstaged' | 'staged'
type ShortcutScope = 'files' | 'diff' | 'other'

type SelectionPreference = {
  pane: Pane
  path: string | null
  paths?: string[]
  anchorPath?: string | null
}

type FileSelection = {
  pane: Pane
  path: string | null
  paths: string[]
  anchorPath: string | null
}

type Preferences = {
  theme: ThemeName
  diffMode: DiffMode
}

type RepoTab = {
  id: string
  path: string
  displayName: string
  status: RepoStatus | null
  selectedPane: Pane
  selectedPath: string | null
  selectedPaths: string[]
  selectionAnchorPath: string | null
  diff: GitDiff | null
  diffLoading: boolean
  commitDraft: string
  amend: boolean
  selectedLines: DiffLineSelection | null
  message: string
}

type PushDialogState = {
  repoId: string
  repoPath: string
  remotes: string[]
  remote: string
  branches: string[]
  branch: string
  force: boolean
  forceWithLease: boolean
  includeTags: boolean
  pushing: boolean
  error: string | null
}

type ResetDialogState = {
  repoId: string
  repoPath: string
  hash: string
  shortHash: string
  subject: string
  branch: string
  mode: ResetMode
  resetting: boolean
  error: string | null
}

const TABS_KEY = 'git-guis.tabs'
const ACTIVE_TAB_KEY = 'git-guis.activeTab'
const PREFS_KEY = 'git-guis.preferences'
const DRAFT_KEY = 'git-guis.drafts'
const WORKSPACE_LAYOUT_KEY = 'git-guis.layout.workspace'
const FILE_LIST_LAYOUT_KEY = 'git-guis.layout.file-list'
const RIGHT_PANE_LAYOUT_KEY = 'git-guis.layout.right-pane'
const COMMIT_AREA_LAYOUT_KEY = 'git-guis.layout.commit-area'
const COMMIT_BROWSER_VISIBLE_KEY = 'git-guis.commit-browser.visible'

const defaultPrefs: Preferences = {
  theme: 'system',
  diffMode: 'highlighted',
}

export function App() {
  const [tabs, setTabs] = useState<RepoTab[]>(() => loadInitialTabs())
  const [activeTabId, setActiveTabId] = useState<string | null>(() => loadInitialActiveTabId(tabs))
  const [prefs, setPrefs] = useState<Preferences>(() => loadJson(PREFS_KEY, defaultPrefs))
  const [showCommitBrowser, setShowCommitBrowser] = useState(() =>
    loadJson(COMMIT_BROWSER_VISIBLE_KEY, false),
  )
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null)
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null)
  const [shortcutScope, setShortcutScope] = useState<ShortcutScope>('files')
  const [pushDialog, setPushDialog] = useState<PushDialogState | null>(null)
  const [resetDialog, setResetDialog] = useState<ResetDialogState | null>(null)
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null

  useEffect(() => {
    document.documentElement.dataset.theme = prefs.theme
    saveJson(PREFS_KEY, prefs)
    window.appApi?.setTheme(prefs.theme)
  }, [prefs])

  useEffect(() => {
    return window.appApi?.onThemeSelected((theme) => {
      setPrefs((current) => ({ ...current, theme }))
    })
  }, [])

  useEffect(() => {
    saveJson(
      TABS_KEY,
      tabs.map((tab) => tab.path),
    )
  }, [tabs])

  useEffect(() => {
    saveJson(ACTIVE_TAB_KEY, activeTab?.path ?? null)
  }, [activeTab?.path])

  useEffect(() => {
    saveJson(COMMIT_BROWSER_VISIBLE_KEY, showCommitBrowser)
  }, [showCommitBrowser])

  useEffect(() => {
    for (const tab of tabs) {
      if (!tab.status) void refreshTab(tab.id)
    }
  }, [])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!activeTab) return
      if (isRefreshShortcut(event)) {
        event.preventDefault()
        void refreshTab(activeTab.id)
      }
      if (isStageShortcut(event)) {
        event.preventDefault()
        if (shortcutScope === 'diff') void applySelectedLineShortcut(activeTab)
        if (shortcutScope === 'files') void toggleStage(activeTab)
      }
      if (isUnstageShortcut(event)) {
        event.preventDefault()
        if (shortcutScope === 'diff') void applySelectedLineShortcut(activeTab, 'staged')
        if (shortcutScope === 'files') void unstageSelected(activeTab)
      }
      if (isRevertShortcut(event)) {
        event.preventDefault()
        void revertSelected(activeTab)
      }
      if (isCommitShortcut(event)) {
        event.preventDefault()
        void commit(activeTab)
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [activeTab, tabs, shortcutScope])

  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'visible' && activeTab) void refreshTab(activeTab.id)
    }
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [activeTab?.id])

  const openRepositoryPath = async (selectedPath: string) => {
    if (!selectedPath) return

    const validation = await window.gitApi.validateRepository(selectedPath)
    if (!validation.ok || !validation.data) {
      showMessage(null, validation.error ?? 'Not a Git repository.')
      return
    }

    const root = validation.data.root
    let activeId: string | null = null
    let refreshId: string | null = null
    setTabs((current) => {
      const existing = current.find((tab) => tab.path === root)
      if (existing) {
        activeId = existing.id
        return current
      }

      const tab = createTab(root)
      activeId = tab.id
      refreshId = tab.id
      return [...current, tab]
    })

    if (activeId) setActiveTabId(activeId)
    if (refreshId) void refreshTab(refreshId, root)
  }

  const openRepository = async () => {
    const selectedPath = await window.gitApi.openRepository()
    if (selectedPath) await openRepositoryPath(selectedPath)
  }

  useEffect(() => {
    return window.appApi?.onOpenRepository(() => {
      void openRepository()
    })
  }, [openRepository])

  useEffect(() => {
    const unsubscribe = window.appApi?.onOpenRepositoryPath((repoPath) => {
      void openRepositoryPath(repoPath)
    })
    return unsubscribe
  }, [openRepositoryPath])

  useEffect(() => {
    void window.appApi?.getLaunchRepositories().then((repoPaths) => {
      for (const repoPath of repoPaths) void openRepositoryPath(repoPath)
    })
  }, [])

  const closeTab = (tabId: string) => {
    setTabs((current) => {
      const next = current.filter((tab) => tab.id !== tabId)
      if (activeTabId === tabId) {
        const closedIndex = current.findIndex((tab) => tab.id === tabId)
        setActiveTabId(next[Math.max(0, closedIndex - 1)]?.id ?? next[0]?.id ?? null)
      }
      return next
    })
  }

  const reorderTab = (dragId: string, targetId: string) => {
    if (dragId === targetId) return
    setTabs((current) => {
      const dragIndex = current.findIndex((tab) => tab.id === dragId)
      const targetIndex = current.findIndex((tab) => tab.id === targetId)
      if (dragIndex === -1 || targetIndex === -1) return current

      const next = [...current]
      const [draggedTab] = next.splice(dragIndex, 1)
      if (!draggedTab) return current
      next.splice(targetIndex, 0, draggedTab)
      return next
    })
  }

  const refreshTab = useCallback(
    async (
      tabId: string,
      explicitPath?: string,
      explicitAmend?: boolean,
      selectionPreference?: SelectionPreference,
    ) => {
      const tab = tabs.find((item) => item.id === tabId)
      const repoPath = explicitPath ?? tab?.path
      if (!repoPath) return
      const amend = explicitAmend ?? tab?.amend ?? false

      const status = await window.gitApi.getStatus(repoPath, amend)
      if (!status.ok || !status.data) {
        showMessage(tabId, status.error ?? 'Unable to refresh repository.')
        return
      }
      const statusData = status.data

      setTabs((current) =>
        current.map((item) => {
          if (item.id !== tabId) return item
          const selection = preserveSelection(item, statusData, selectionPreference)
          return {
            ...item,
            status: statusData,
            displayName: displayName(statusData.root),
            diff: selection.path ? item.diff : null,
            diffLoading: false,
            selectedPath: selection.path,
            selectedPane: selection.pane,
            selectedPaths: selection.paths,
            selectionAnchorPath: selection.anchorPath,
            selectedLines: selection.path ? item.selectedLines : null,
            message: 'Ready.',
          }
        }),
      )

      const latestTab = tabs.find((item) => item.id === tabId) ?? tab
      const selection = latestTab
        ? preserveSelection(latestTab, statusData, selectionPreference)
        : { path: null, pane: 'unstaged' as Pane, paths: [], anchorPath: null }
      if (selection.path) void loadDiff(tabId, repoPath, selection.path, selection.pane, amend)
    },
    [tabs],
  )

  const loadDiff = async (
    tabId: string,
    repoPath: string,
    filePath: string,
    pane: Pane,
    amend: boolean,
    selection?: FileSelection,
  ) => {
    setTabs((current) =>
      current.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              selectedPath: filePath,
              selectedPane: pane,
              selectedPaths: selection?.paths ?? tab.selectedPaths,
              selectionAnchorPath: selection?.anchorPath ?? tab.selectionAnchorPath,
              diffLoading: true,
              selectedLines: null,
              message: 'Loading diff...',
            }
          : tab,
      ),
    )

    const result = await window.gitApi.getDiff(repoPath, filePath, pane === 'staged', amend)
    setTabs((current) =>
      current.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              diff: result.data ?? null,
              diffLoading: false,
              message: result.ok ? 'Ready.' : (result.error ?? 'Unable to load diff.'),
            }
          : tab,
      ),
    )
  }

  const selectFile = (
    tab: RepoTab,
    pane: Pane,
    change: FileChange,
    event: ReactMouseEvent,
    changes: FileChange[],
  ) => {
    const selection = nextFileSelection(tab, pane, change.path, changes, event)
    if (!selection.path) {
      setTabs((current) =>
        current.map((item) =>
          item.id === tab.id
            ? {
                ...item,
                selectedPane: selection.pane,
                selectedPath: null,
                selectedPaths: [],
                selectionAnchorPath: selection.anchorPath,
                diff: null,
                selectedLines: null,
              }
            : item,
        ),
      )
      return
    }

    void loadDiff(tab.id, tab.path, selection.path, selection.pane, tab.amend, selection)
  }

  const toggleStage = async (tab: RepoTab) => {
    const filePaths = selectedFilePaths(tab)
    if (filePaths.length === 0) return
    const selectionPreference = previousFileSelection(tab)

    for (const filePath of filePaths) {
      const result =
        tab.selectedPane === 'staged'
          ? await window.gitApi.unstageFile(tab.path, filePath, tab.amend)
          : await window.gitApi.stageFile(tab.path, filePath)
      if (!result.ok) {
        showMessage(tab.id, result.error ?? 'Git operation failed.')
        await refreshTab(tab.id, undefined, undefined, selectionPreference)
        return
      }
    }

    await refreshTab(tab.id, undefined, undefined, selectionPreference)
  }

  const unstageSelected = async (tab: RepoTab) => {
    if (tab.selectedPane !== 'staged') return
    const filePaths = selectedFilePaths(tab)
    if (filePaths.length === 0) return
    const selectionPreference = previousFileSelection(tab)

    for (const filePath of filePaths) {
      const result = await window.gitApi.unstageFile(tab.path, filePath, tab.amend)
      if (!result.ok) {
        showMessage(tab.id, result.error ?? 'Unable to unstage file.')
        await refreshTab(tab.id, undefined, undefined, selectionPreference)
        return
      }
    }

    await refreshTab(tab.id, undefined, undefined, selectionPreference)
  }

  const revertSelected = async (tab: RepoTab) => {
    if (!tab.selectedPath || tab.selectedPane !== 'unstaged') return
    const changes = selectedChanges(tab, 'unstaged')
    if (changes.length === 0) return

    const onlyChange = changes[0]
    const message =
      changes.length === 1 && onlyChange
        ? onlyChange.kind === 'untracked'
          ? `Move untracked file to Trash?\n\n${onlyChange.path}`
          : `Discard unstaged changes in this file?\n\n${onlyChange.path}`
        : `Discard or trash changes in ${changes.length} selected files?`
    if (!window.confirm(message)) return

    const selectionPreference = previousFileSelection(tab)
    for (const change of changes) {
      const result = await window.gitApi.revertFile(
        tab.path,
        change.path,
        change.kind === 'untracked',
      )
      if (!result.ok) {
        showMessage(tab.id, result.error ?? 'Unable to revert file.')
        await refreshTab(tab.id, undefined, undefined, selectionPreference)
        return
      }
    }
    await refreshTab(tab.id, undefined, undefined, selectionPreference)
  }

  const applyHunk = async (tab: RepoTab, hunkIndex: number) => {
    if (tab.diff?.kind !== 'text') return
    const patch = buildHunkPatch(tab.diff.patch, hunkIndex)
    if (!patch) return
    const result = await window.gitApi.applyPatch(tab.path, patch, tab.selectedPane === 'staged')
    if (!result.ok) {
      showMessage(tab.id, result.error ?? 'Patch did not apply.')
      return
    }
    await refreshTab(tab.id)
  }

  const applySelection = async (tab: RepoTab, selection?: DiffLineSelection | null) => {
    if (tab.diff?.kind !== 'text') return
    const patch = buildSelectionPatch(tab.diff.patch, selection ?? tab.selectedLines)
    if (!patch) {
      showMessage(tab.id, 'Select changed lines before applying a partial patch.')
      return
    }
    const result = await window.gitApi.applyPatch(tab.path, patch, tab.selectedPane === 'staged')
    if (!result.ok) {
      showMessage(tab.id, result.error ?? 'Patch did not apply.')
      return
    }
    await refreshTab(tab.id)
  }

  const applySelectedLineShortcut = async (tab: RepoTab, pane?: Pane) => {
    if (pane && tab.selectedPane !== pane) return
    await applySelection(tab)
  }

  const copySelectedDiff = async (tab: RepoTab, selection?: DiffLineSelection | null) => {
    if (tab.diff?.kind !== 'text') return
    const text = selectedDiffText(tab.diff.patch, selection ?? tab.selectedLines)
    if (!text) {
      showMessage(tab.id, 'Select diff lines before copying.')
      return
    }

    try {
      await copyText(text)
      showMessage(tab.id, 'Copied selected diff.')
    } catch (error) {
      showMessage(tab.id, error instanceof Error ? error.message : 'Unable to copy diff.')
    }
  }

  const commit = async (tab: RepoTab) => {
    const message = tab.commitDraft
    if (!message.trim()) {
      showMessage(tab.id, 'Commit message is empty.')
      return
    }

    const result = await window.gitApi.commit(tab.path, message, tab.amend)
    if (!result.ok) {
      showMessage(tab.id, result.error ?? 'Commit failed.')
      return
    }

    saveDraft(tab.path, '')
    setTabs((current) =>
      current.map((item) =>
        item.id === tab.id
          ? {
              ...item,
              amend: false,
              commitDraft: '',
              diff: null,
              selectedLines: null,
              selectedPath: null,
              selectedPaths: [],
              selectionAnchorPath: null,
              selectedPane: 'unstaged',
              message: result.data?.trim() || 'Committed.',
            }
          : item,
      ),
    )
    await refreshTab(tab.id, undefined, false)
  }

  const openPushDialog = async (tab: RepoTab) => {
    const [branchesResult, remotesResult] = await Promise.all([
      tryGitResult(() => window.gitApi.listBranches(tab.path)),
      tryGitResult(() => window.gitApi.listRemotes(tab.path)),
    ])
    if (!branchesResult.ok || !branchesResult.data) {
      showMessage(tab.id, branchesResult.error ?? 'Unable to list branches.')
      return
    }
    if (!remotesResult.ok || !remotesResult.data) {
      showMessage(tab.id, remotesResult.error ?? 'Unable to list remotes.')
      return
    }

    const branch =
      (tab.status?.branch && branchesResult.data.includes(tab.status.branch)
        ? tab.status.branch
        : null) ??
      branchesResult.data[0] ??
      ''
    const remote =
      (remotesResult.data.includes('origin') ? 'origin' : null) ?? remotesResult.data[0] ?? ''

    setPushDialog({
      repoId: tab.id,
      repoPath: tab.path,
      remotes: remotesResult.data,
      remote,
      branches: branchesResult.data,
      branch,
      force: false,
      forceWithLease: true,
      includeTags: false,
      pushing: false,
      error: null,
    })
  }

  const submitPush = async () => {
    if (!pushDialog?.branch) return
    setPushDialog((current) => (current ? { ...current, pushing: true, error: null } : current))

    const result = await tryGitResult(() =>
      window.gitApi.push(pushDialog.repoPath, {
        remote: pushDialog.remote,
        branch: pushDialog.branch,
        force: pushDialog.force,
        forceWithLease: pushDialog.forceWithLease,
        includeTags: pushDialog.includeTags,
      }),
    )

    if (!result.ok) {
      setPushDialog((current) =>
        current ? { ...current, pushing: false, error: result.error ?? 'Push failed.' } : current,
      )
      return
    }

    setPushDialog(null)
    showMessage(
      pushDialog.repoId,
      result.data?.trim() || `Pushed ${pushDialog.branch} to ${pushDialog.remote}.`,
    )
  }

  const checkoutBranch = async (tab: RepoTab, branch: CommitBranch) => {
    if (branch.remote) return
    const result = await window.gitApi.checkoutBranch(tab.path, branch.name)
    if (!result.ok) {
      showMessage(tab.id, result.error ?? 'Checkout failed.')
      return
    }
    await refreshTab(tab.id)
    showMessage(tab.id, `Checked out ${branch.name}.`)
  }

  const cherryPickCommit = async (tab: RepoTab, commit: CommitSummary) => {
    const result = await window.gitApi.cherryPickCommit(tab.path, commit.hash)
    if (!result.ok) {
      showMessage(tab.id, result.error ?? 'Cherry-pick failed.')
      return
    }
    await refreshTab(tab.id)
    showMessage(tab.id, result.data?.trim() || `Cherry-picked ${commit.shortHash}.`)
  }

  const openResetDialog = (tab: RepoTab, commit: CommitSummary) => {
    setResetDialog({
      repoId: tab.id,
      repoPath: tab.path,
      hash: commit.hash,
      shortHash: commit.shortHash,
      subject: commit.subject,
      branch: tab.status?.branch ?? 'HEAD',
      mode: 'mixed',
      resetting: false,
      error: null,
    })
  }

  const submitReset = async () => {
    if (!resetDialog) return
    setResetDialog((current) => (current ? { ...current, resetting: true, error: null } : current))

    const result = await window.gitApi.resetToCommit(
      resetDialog.repoPath,
      resetDialog.hash,
      resetDialog.mode,
    )
    if (!result.ok) {
      setResetDialog((current) =>
        current
          ? { ...current, resetting: false, error: result.error ?? 'Reset failed.' }
          : current,
      )
      return
    }

    const repoId = resetDialog.repoId
    const shortHash = resetDialog.shortHash
    const mode = resetDialog.mode
    setResetDialog(null)
    await refreshTab(repoId)
    showMessage(repoId, result.data?.trim() || `Reset ${mode} to ${shortHash}.`)
  }

  const copyHash = async (tab: RepoTab, hash: string) => {
    try {
      await copyText(hash)
      showMessage(tab.id, 'Copied commit hash.')
    } catch (error) {
      showMessage(tab.id, error instanceof Error ? error.message : 'Unable to copy commit hash.')
    }
  }

  const loadAmendMessage = async (tab: RepoTab) => {
    const result = await window.gitApi.getLastCommitMessage(tab.path)
    if (!result.ok || result.data === undefined) {
      showMessage(tab.id, result.error ?? 'Unable to load last commit message.')
      return
    }
    updateDraft(tab.id, result.data)
  }

  const clearUnchangedAmendMessage = async (tab: RepoTab) => {
    const result = await window.gitApi.getLastCommitMessage(tab.path)
    if (result.ok && result.data === tab.commitDraft) updateDraft(tab.id, '')
  }

  const updateDraft = (tabId: string, value: string) => {
    setTabs((current) =>
      current.map((tab) => {
        if (tab.id !== tabId) return tab
        saveDraft(tab.path, value)
        return { ...tab, commitDraft: value }
      }),
    )
  }

  const showMessage = (tabId: string | null, message: string) => {
    setTabs((current) => current.map((tab) => (tab.id === tabId ? { ...tab, message } : tab)))
  }

  return (
    <main className="app-shell">
      <header className="tab-bar">
        <div className="drag-region" />
        <ul className="tab-list">
          {tabs.map((tab) => (
            <li
              className={`repo-tab ${tab.id === activeTab?.id ? 'active' : ''} ${
                tab.id === draggedTabId ? 'dragging' : ''
              } ${tab.id === dragOverTabId && tab.id !== draggedTabId ? 'drag-over' : ''}`}
              draggable
              key={tab.id}
              onDragEnd={() => {
                setDraggedTabId(null)
                setDragOverTabId(null)
              }}
              onDragEnter={(event) => {
                event.preventDefault()
                if (draggedTabId && draggedTabId !== tab.id) setDragOverTabId(tab.id)
              }}
              onDragOver={(event) => {
                event.preventDefault()
                if (draggedTabId && draggedTabId !== tab.id) setDragOverTabId(tab.id)
              }}
              onDragStart={(event) => {
                setDraggedTabId(tab.id)
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', tab.id)
              }}
              onDrop={(event) => {
                event.preventDefault()
                const dragId = draggedTabId ?? event.dataTransfer.getData('text/plain')
                if (dragId) reorderTab(dragId, tab.id)
                setDraggedTabId(null)
                setDragOverTabId(null)
              }}
            >
              <button
                className="tab-main"
                onClick={() => setActiveTabId(tab.id)}
                title={tab.path}
                type="button"
              >
                <span className="tab-title">{tab.displayName}</span>
                <span className="tab-branch">{tab.status?.branch ?? 'detached'}</span>
              </button>
              <button
                className="tab-close"
                onClick={(event) => {
                  event.stopPropagation()
                  closeTab(tab.id)
                }}
                title={`Close ${tab.displayName}`}
                type="button"
              >
                <X aria-hidden size={13} strokeWidth={2.25} />
              </button>
            </li>
          ))}
        </ul>
        <button
          aria-label="Open repository"
          className="tab-add"
          onClick={openRepository}
          title="Open repository"
          type="button"
        >
          <Plus aria-hidden size={20} strokeWidth={2.1} />
        </button>
        <div className="toolbar-spacer" />
        <select
          className="hidden"
          value={prefs.diffMode}
          onChange={(event) => setPrefs({ ...prefs, diffMode: event.target.value as DiffMode })}
        >
          <option value="highlighted">Readable</option>
          <option value="classic">Classic</option>
        </select>
      </header>

      {activeTab ? (
        <RepositoryView
          tab={activeTab}
          prefs={prefs}
          showCommitBrowser={showCommitBrowser}
          onToggleCommitBrowser={() => setShowCommitBrowser((visible) => !visible)}
          onShortcutScopeChange={setShortcutScope}
          onRefresh={() => refreshTab(activeTab.id)}
          onSelect={(pane, change, event, changes) =>
            selectFile(activeTab, pane, change, event, changes)
          }
          onToggleStage={() => toggleStage(activeTab)}
          onRevert={() => revertSelected(activeTab)}
          onApplyHunk={(hunkIndex) => applyHunk(activeTab, hunkIndex)}
          onApplySelection={(selection) => applySelection(activeTab, selection)}
          onCopySelectedDiff={(selection) => copySelectedDiff(activeTab, selection)}
          onSelectedLines={(range) =>
            setTabs((current) =>
              current.map((tab) =>
                tab.id === activeTab.id ? { ...tab, selectedLines: range } : tab,
              ),
            )
          }
          onDraftChange={(value) => updateDraft(activeTab.id, value)}
          onCommit={() => commit(activeTab)}
          onPush={() => openPushDialog(activeTab)}
          onCheckoutBranch={(branch) => checkoutBranch(activeTab, branch)}
          onCherryPickCommit={(commit) => cherryPickCommit(activeTab, commit)}
          onResetToCommit={(commit) => openResetDialog(activeTab, commit)}
          onCopyCommitHash={(hash) => copyHash(activeTab, hash)}
          onAmendChange={(amend) => {
            setTabs((current) =>
              current.map((tab) => (tab.id === activeTab.id ? { ...tab, amend } : tab)),
            )
            void refreshTab(activeTab.id, undefined, amend)
            if (amend && !activeTab.commitDraft.trim()) void loadAmendMessage(activeTab)
            if (!amend && activeTab.commitDraft) void clearUnchangedAmendMessage(activeTab)
          }}
        />
      ) : (
        <section className="empty-state">
          <button className="primary-button" onClick={openRepository} type="button">
            Open Repository
          </button>
        </section>
      )}

      {pushDialog && (
        <PushDialog
          state={pushDialog}
          onChange={(update) =>
            setPushDialog((current) => (current ? { ...current, ...update } : current))
          }
          onCancel={() => setPushDialog(null)}
          onSubmit={submitPush}
        />
      )}

      {resetDialog && (
        <ResetDialog
          state={resetDialog}
          onChange={(update) =>
            setResetDialog((current) => (current ? { ...current, ...update } : current))
          }
          onCancel={() => setResetDialog(null)}
          onSubmit={submitReset}
        />
      )}
    </main>
  )
}

type RepositoryViewProps = {
  tab: RepoTab
  prefs: Preferences
  showCommitBrowser: boolean
  onToggleCommitBrowser(): void
  onShortcutScopeChange(scope: ShortcutScope): void
  onRefresh(): void
  onSelect(pane: Pane, change: FileChange, event: ReactMouseEvent, changes: FileChange[]): void
  onToggleStage(): void
  onRevert(): void
  onApplyHunk(hunkIndex: number): void
  onApplySelection(selection?: DiffLineSelection | null): void
  onCopySelectedDiff(selection?: DiffLineSelection | null): void
  onSelectedLines(range: DiffLineSelection | null): void
  onDraftChange(value: string): void
  onCommit(): void
  onPush(): void
  onCheckoutBranch(branch: CommitBranch): void
  onCherryPickCommit(commit: CommitSummary): void
  onResetToCommit(commit: CommitSummary): void
  onCopyCommitHash(hash: string): void
  onAmendChange(amend: boolean): void
}

type DiffContextMenu = {
  x: number
  y: number
  hunkIndex: number | null
  selection: DiffLineSelection | null
} | null

function RepositoryView({
  tab,
  prefs,
  showCommitBrowser,
  onToggleCommitBrowser,
  onShortcutScopeChange,
  onRefresh,
  onSelect,
  onToggleStage,
  onRevert,
  onApplyHunk,
  onApplySelection,
  onCopySelectedDiff,
  onSelectedLines,
  onDraftChange,
  onCommit,
  onPush,
  onCheckoutBranch,
  onCherryPickCommit,
  onResetToCommit,
  onCopyCommitHash,
  onAmendChange,
}: RepositoryViewProps) {
  const hunks = useMemo(
    () => (tab.diff?.kind === 'text' ? parseUnifiedDiff(tab.diff.patch).hunks : []),
    [tab.diff],
  )
  const diffIsNewFile = tab.diff?.kind === 'text' && isNewFilePatch(tab.diff.patch)
  const diffTitle =
    tab.selectedPane === 'staged'
      ? tab.amend
        ? 'Staged for amended commit'
        : 'Staged for commit'
      : 'Modified, not staged'
  const [contextMenu, setContextMenu] = useState<DiffContextMenu>(null)

  useEffect(() => {
    if (!contextMenu) return

    const closeMenu = () => setContextMenu(null)
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu()
    }

    window.addEventListener('pointerdown', closeMenu)
    window.addEventListener('blur', closeMenu)
    window.addEventListener('keydown', closeOnEscape)

    return () => {
      window.removeEventListener('pointerdown', closeMenu)
      window.removeEventListener('blur', closeMenu)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [contextMenu])

  const runMenuAction = (action: () => void) => {
    setContextMenu(null)
    action()
  }

  return (
    <section className="repo-view">
      <div className="branch-strip">
        <strong>Current Branch:</strong> {tab.status?.branch ?? 'detached'} <span>{tab.path}</span>
      </div>
      <Group
        className="workspace-panels"
        defaultLayout={loadJson(WORKSPACE_LAYOUT_KEY, { files: 34, detail: 66 })}
        id="workspace-panels"
        onLayoutChanged={(layout) => saveJson(WORKSPACE_LAYOUT_KEY, layout)}
        orientation="horizontal"
      >
        <Panel className="file-column" defaultSize="34%" id="files" minSize={250}>
          <Group
            className="file-list-panels"
            defaultLayout={loadJson(FILE_LIST_LAYOUT_KEY, { unstaged: 56, staged: 44 })}
            id="file-list-panels"
            onLayoutChanged={(layout) => saveJson(FILE_LIST_LAYOUT_KEY, layout)}
            orientation="vertical"
          >
            <Panel className="file-list-panel" defaultSize="56%" id="unstaged" minSize={120}>
              <FileList
                title="Unstaged Changes"
                tone="unstaged"
                changes={tab.status?.unstaged ?? []}
                selectedPath={tab.selectedPane === 'unstaged' ? tab.selectedPath : null}
                selectedPaths={tab.selectedPane === 'unstaged' ? tab.selectedPaths : []}
                onActivate={() => onShortcutScopeChange('files')}
                onSelect={(change, event, changes) => onSelect('unstaged', change, event, changes)}
              />
            </Panel>
            <Separator className="resize-handle resize-handle-vertical" id="file-list-separator" />
            <Panel className="file-list-panel" defaultSize="44%" id="staged" minSize={100}>
              <FileList
                title={tab.amend ? 'Staged Changes (Will Amend)' : 'Staged Changes (Will Commit)'}
                tone="staged"
                changes={tab.status?.staged ?? []}
                selectedPath={tab.selectedPane === 'staged' ? tab.selectedPath : null}
                selectedPaths={tab.selectedPane === 'staged' ? tab.selectedPaths : []}
                onActivate={() => onShortcutScopeChange('files')}
                onSelect={(change, event, changes) => onSelect('staged', change, event, changes)}
              />
            </Panel>
          </Group>
        </Panel>

        <Separator className="resize-handle resize-handle-horizontal" id="workspace-separator" />

        <Panel className="right-column" defaultSize="66%" id="detail" minSize={520}>
          <Group
            className="right-pane-panels"
            defaultLayout={loadJson(RIGHT_PANE_LAYOUT_KEY, { diff: 76, commit: 24 })}
            id="right-pane-panels"
            onLayoutChanged={(layout) => saveJson(RIGHT_PANE_LAYOUT_KEY, layout)}
            orientation="vertical"
          >
            <Panel className="diff-panel" defaultSize="76%" id="diff" minSize={160}>
              <div className="diff-header">
                <strong>{diffTitle}</strong>
                <span>{tab.selectedPath ? `File: ${tab.selectedPath}` : 'No file selected'}</span>
              </div>

              <div
                className="diff-body"
                onFocusCapture={() => onShortcutScopeChange('diff')}
                onPointerDownCapture={() => onShortcutScopeChange('diff')}
              >
                {tab.diffLoading ? (
                  <div className="placeholder">Loading diff...</div>
                ) : tab.diff?.kind === 'text' ? (
                  <DiffView
                    patch={tab.diff.patch}
                    highlighted={prefs.diffMode === 'highlighted'}
                    selectedLines={tab.selectedLines}
                    onSelectionChange={onSelectedLines}
                    onContextMenu={(event, hunkIndex, selection) => {
                      event.preventDefault()
                      event.stopPropagation()
                      setContextMenu({
                        ...clampedMenuPosition(event.clientX, event.clientY, 180, 190),
                        hunkIndex,
                        selection,
                      })
                    }}
                  />
                ) : tab.diff?.kind === 'binary' ? (
                  <BinaryDiff summary={tab.diff.summary} />
                ) : null}
              </div>

              {contextMenu && (
                <div
                  className="context-menu"
                  onPointerDown={(event) => event.stopPropagation()}
                  style={{ left: contextMenu.x, top: contextMenu.y }}
                >
                  <button
                    disabled={!contextMenu.selection}
                    onClick={() => runMenuAction(() => onApplySelection(contextMenu.selection))}
                    type="button"
                  >
                    {tab.selectedPane === 'staged' ? 'Unstage' : 'Stage'} Selected Lines
                  </button>
                  {!diffIsNewFile && (
                    <button
                      disabled={!contextMenu.selection}
                      onClick={() => runMenuAction(() => onCopySelectedDiff(contextMenu.selection))}
                      type="button"
                    >
                      Copy Diff
                    </button>
                  )}
                  <button
                    disabled={contextMenu.hunkIndex === null}
                    onClick={() =>
                      runMenuAction(() => {
                        if (contextMenu.hunkIndex !== null) onApplyHunk(contextMenu.hunkIndex)
                      })
                    }
                    type="button"
                  >
                    {tab.selectedPane === 'staged' ? 'Unstage' : 'Stage'} Hunk
                  </button>
                  <button
                    disabled={!tab.selectedPath}
                    onClick={() => runMenuAction(onToggleStage)}
                    type="button"
                  >
                    {tab.selectedPane === 'staged' ? 'Unstage' : 'Stage'} File
                  </button>
                  <button
                    disabled={tab.selectedPane !== 'unstaged' || !tab.selectedPath}
                    onClick={() => runMenuAction(onRevert)}
                    type="button"
                  >
                    Revert File
                  </button>
                  <button onClick={() => runMenuAction(onRefresh)} type="button">
                    Refresh
                  </button>
                  {hunks.length > 1 && (
                    <div className="context-menu-note">{hunks.length} hunks in file</div>
                  )}
                </div>
              )}
            </Panel>

            <Separator className="resize-handle resize-handle-vertical" id="right-pane-separator" />

            <Panel
              className="commit-panel"
              defaultSize="24%"
              id="commit"
              minSize={140}
              onFocusCapture={() => onShortcutScopeChange('other')}
              onPointerDownCapture={() => onShortcutScopeChange('other')}
            >
              {showCommitBrowser ? (
                <Group
                  className="commit-area-panels"
                  defaultLayout={loadJson(COMMIT_AREA_LAYOUT_KEY, { message: 58, browser: 42 })}
                  id="commit-area-panels"
                  onLayoutChanged={(layout) => saveJson(COMMIT_AREA_LAYOUT_KEY, layout)}
                  orientation="horizontal"
                >
                  <Panel
                    className="commit-editor-panel"
                    defaultSize="58%"
                    id="message"
                    minSize={260}
                  >
                    <CommitEditor
                      amend={tab.amend}
                      draft={tab.commitDraft}
                      showCommitBrowser={showCommitBrowser}
                      onAmendChange={onAmendChange}
                      onCommit={onCommit}
                      onDraftChange={onDraftChange}
                      onPush={onPush}
                      onToggleCommitBrowser={onToggleCommitBrowser}
                    />
                  </Panel>
                  <Separator
                    className="resize-handle resize-handle-horizontal"
                    id="commit-area-separator"
                  />
                  <Panel
                    className="commit-browser-panel"
                    defaultSize="42%"
                    id="browser"
                    minSize={260}
                  >
                    <CommitBrowser
                      repoPath={tab.path}
                      currentBranch={tab.status?.branch}
                      refreshKey={tab.status?.lastRefreshedAt ?? 0}
                      onCheckout={onCheckoutBranch}
                      onCherryPick={onCherryPickCommit}
                      onReset={onResetToCommit}
                      onCopyHash={onCopyCommitHash}
                    />
                  </Panel>
                </Group>
              ) : (
                <div className="commit-editor-panel">
                  <CommitEditor
                    amend={tab.amend}
                    draft={tab.commitDraft}
                    showCommitBrowser={showCommitBrowser}
                    onAmendChange={onAmendChange}
                    onCommit={onCommit}
                    onDraftChange={onDraftChange}
                    onPush={onPush}
                    onToggleCommitBrowser={onToggleCommitBrowser}
                  />
                </div>
              )}
            </Panel>
          </Group>
        </Panel>
      </Group>
      <div className="status-bar">{tab.message}</div>
    </section>
  )
}

type CommitEditorProps = {
  amend: boolean
  draft: string
  showCommitBrowser: boolean
  onAmendChange(amend: boolean): void
  onCommit(): void
  onDraftChange(value: string): void
  onPush(): void
  onToggleCommitBrowser(): void
}

function CommitEditor({
  amend,
  draft,
  showCommitBrowser,
  onAmendChange,
  onCommit,
  onDraftChange,
  onPush,
  onToggleCommitBrowser,
}: CommitEditorProps) {
  return (
    <div className="commit-grid">
      <div className="commit-actions">
        <button onClick={onCommit} type="button">
          Commit
        </button>
        <button onClick={onPush} type="button">
          Push
        </button>
      </div>
      <div className="commit-message-field">
        <div className="commit-message-header">
          <span>Commit Message:</span>
          <div className="commit-message-controls">
            <label>
              <input
                type="checkbox"
                checked={amend}
                onChange={(event) => onAmendChange(event.target.checked)}
              />
              Amend Last Commit
            </label>
            <button
              aria-pressed={showCommitBrowser}
              className={`commit-browser-toggle ${showCommitBrowser ? 'active' : ''}`}
              onClick={onToggleCommitBrowser}
              title={showCommitBrowser ? 'Hide branch picker' : 'Show branch picker'}
              type="button"
            >
              <GitBranch aria-hidden size={14} strokeWidth={2.1} />
            </button>
          </div>
        </div>
        <textarea
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          spellCheck
        />
      </div>
    </div>
  )
}

type PushDialogProps = {
  state: PushDialogState
  onChange(update: Partial<PushDialogState>): void
  onCancel(): void
  onSubmit(): void
}

function PushDialog({ state, onChange, onCancel, onSubmit }: PushDialogProps) {
  return (
    <div className="modal-backdrop">
      <form
        className="push-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}
      >
        <header className="push-dialog-header">
          <strong>Push</strong>
          <button aria-label="Close" onClick={onCancel} type="button">
            <X aria-hidden size={14} strokeWidth={2.25} />
          </button>
        </header>

        <div className="push-dialog-body">
          <label>
            <span>Branch</span>
            <select
              disabled={state.pushing || state.branches.length === 0}
              value={state.branch}
              onChange={(event) => onChange({ branch: event.target.value, error: null })}
            >
              {state.branches.map((branch) => (
                <option key={branch} value={branch}>
                  {branch}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Remote</span>
            <select
              disabled={state.pushing || state.remotes.length === 0}
              value={state.remote}
              onChange={(event) => onChange({ remote: event.target.value, error: null })}
            >
              {state.remotes.map((remote) => (
                <option key={remote} value={remote}>
                  {remote}
                </option>
              ))}
            </select>
          </label>

          <span className="label">Options</span>

          <label className="push-option">
            <input
              checked={state.force}
              disabled={state.pushing}
              onChange={(event) => onChange({ force: event.target.checked, error: null })}
              type="checkbox"
            />
            Force
          </label>

          <label className="push-option indented">
            <input
              checked={state.forceWithLease}
              disabled={state.pushing}
              onChange={(event) => onChange({ forceWithLease: event.target.checked, error: null })}
              type="checkbox"
            />
            With lease (safer force)
          </label>

          <label className="push-option">
            <input
              checked={state.includeTags}
              disabled={state.pushing}
              onChange={(event) => onChange({ includeTags: event.target.checked, error: null })}
              type="checkbox"
            />
            Include tags
          </label>

          {state.error && <div className="push-error">{state.error}</div>}
        </div>

        <footer className="push-dialog-actions">
          <button disabled={state.pushing} onClick={onCancel} type="button">
            Cancel
          </button>
          <button disabled={state.pushing || !state.branch} type="submit">
            {state.pushing ? 'Pushing...' : 'Push'}
          </button>
        </footer>
      </form>
    </div>
  )
}

type ResetDialogProps = {
  state: ResetDialogState
  onChange(update: Partial<ResetDialogState>): void
  onCancel(): void
  onSubmit(): void
}

function ResetDialog({ state, onChange, onCancel, onSubmit }: ResetDialogProps) {
  return (
    <div className="modal-backdrop">
      <form
        className="push-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}
      >
        <header className="push-dialog-header">
          <strong>Reset {state.branch}</strong>
          <button aria-label="Close" disabled={state.resetting} onClick={onCancel} type="button">
            <X aria-hidden size={14} strokeWidth={2.25} />
          </button>
        </header>

        <div className="push-dialog-body">
          <div className="reset-target">
            <strong>{state.shortHash}</strong>
            <span>{state.subject}</span>
          </div>

          <span className="label">Mode</span>
          {(['soft', 'mixed', 'hard'] as ResetMode[]).map((mode) => (
            <label className="push-option" key={mode}>
              <input
                checked={state.mode === mode}
                disabled={state.resetting}
                name="reset-mode"
                onChange={() => onChange({ mode, error: null })}
                type="radio"
              />
              {resetModeLabel(mode)}
            </label>
          ))}

          {state.error && <div className="push-error">{state.error}</div>}
        </div>

        <footer className="push-dialog-actions">
          <button disabled={state.resetting} onClick={onCancel} type="button">
            Cancel
          </button>
          <button disabled={state.resetting} type="submit">
            {state.resetting ? 'Resetting...' : 'OK'}
          </button>
        </footer>
      </form>
    </div>
  )
}

function resetModeLabel(mode: ResetMode) {
  if (mode === 'soft') return 'Soft'
  if (mode === 'hard') return 'Hard'
  return 'Mixed'
}

type CommitBrowserProps = {
  repoPath: string
  currentBranch: string | null | undefined
  refreshKey: number
  onCheckout(branch: CommitBranch): void
  onCherryPick(commit: CommitSummary): void
  onReset(commit: CommitSummary): void
  onCopyHash(hash: string): void
}

type CommitContextMenu = {
  x: number
  y: number
  commit: CommitSummary
} | null

function CommitBrowser({
  repoPath,
  currentBranch,
  refreshKey,
  onCheckout,
  onCherryPick,
  onReset,
  onCopyHash,
}: CommitBrowserProps) {
  const [branches, setBranches] = useState<CommitBranch[]>([])
  const [selectedRef, setSelectedRef] = useState('')
  const [commits, setCommits] = useState<CommitSummary[]>([])
  const [loadingBranches, setLoadingBranches] = useState(false)
  const [loadingCommits, setLoadingCommits] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<CommitContextMenu>(null)

  const selectedBranch = branches.find((branch) => branch.ref === selectedRef) ?? null

  useEffect(() => {
    let cancelled = false
    setLoadingBranches(true)
    setError(null)

    void tryGitResult(() => window.gitApi.listCommitBranches(repoPath)).then((result) => {
      if (cancelled) return
      setLoadingBranches(false)
      if (!result.ok || !result.data) {
        setError(result.error ?? 'Unable to load branches.')
        setBranches([])
        setSelectedRef('')
        return
      }

      const localBranches = result.data.filter((branch) => !branch.remote)
      setBranches(localBranches)
      setSelectedRef((current) => {
        if (localBranches.some((branch) => branch.ref === current)) return current
        const currentLocal = localBranches.find(
          (branch) => !branch.remote && branch.name === currentBranch,
        )
        return currentLocal?.ref ?? localBranches[0]?.ref ?? ''
      })
    })

    return () => {
      cancelled = true
    }
  }, [repoPath, currentBranch, refreshKey])

  useEffect(() => {
    if (!selectedRef) {
      setCommits([])
      return
    }

    let cancelled = false
    setLoadingCommits(true)
    setError(null)

    void tryGitResult(() => window.gitApi.listCommits(repoPath, selectedRef)).then((result) => {
      if (cancelled) return
      setLoadingCommits(false)
      if (!result.ok || !result.data) {
        setError(result.error ?? 'Unable to load commits.')
        setCommits([])
        return
      }
      setCommits(result.data)
    })

    return () => {
      cancelled = true
    }
  }, [repoPath, selectedRef])

  useEffect(() => {
    if (!contextMenu) return

    const closeMenu = () => setContextMenu(null)
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu()
    }

    window.addEventListener('pointerdown', closeMenu)
    window.addEventListener('blur', closeMenu)
    window.addEventListener('keydown', closeOnEscape)

    return () => {
      window.removeEventListener('pointerdown', closeMenu)
      window.removeEventListener('blur', closeMenu)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [contextMenu])

  const runMenuAction = (action: () => void) => {
    setContextMenu(null)
    action()
  }

  return (
    <section className="commit-browser">
      <div className="commit-browser-toolbar">
        <select
          disabled={loadingBranches || branches.length === 0}
          value={selectedRef}
          onChange={(event) => setSelectedRef(event.target.value)}
        >
          {branches.map((branch) => (
            <option key={branch.ref} value={branch.ref}>
              {branch.name}
            </option>
          ))}
        </select>
        <button
          disabled={!selectedBranch || selectedBranch.remote || selectedBranch.current}
          onClick={() => selectedBranch && onCheckout(selectedBranch)}
          type="button"
        >
          Check Out
        </button>
      </div>

      <div className="commit-list">
        {error ? (
          <div className="empty-list">{error}</div>
        ) : loadingCommits ? (
          <div className="empty-list">Loading commits...</div>
        ) : commits.length === 0 ? (
          <div className="empty-list">No commits</div>
        ) : (
          commits.map((commit) => (
            <button
              className="commit-row"
              key={commit.hash}
              onContextMenu={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setContextMenu({
                  ...clampedMenuPosition(event.clientX, event.clientY, 210, 118),
                  commit,
                })
              }}
              title={commit.hash}
              type="button"
            >
              <CommitRow commit={commit} />
            </button>
          ))
        )}
      </div>

      {contextMenu && (
        <div
          className="context-menu"
          onPointerDown={(event) => event.stopPropagation()}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => runMenuAction(() => onCherryPick(contextMenu.commit))}
            type="button"
          >
            Cherry-pick this commit
          </button>
          <button onClick={() => runMenuAction(() => onReset(contextMenu.commit))} type="button">
            Reset {currentBranch ?? 'HEAD'} to here
          </button>
          <button
            onClick={() => runMenuAction(() => onCopyHash(contextMenu.commit.hash))}
            type="button"
          >
            Copy commit hash
          </button>
        </div>
      )}
    </section>
  )
}

function CommitRow({ commit }: { commit: CommitSummary }) {
  const refs = visibleCommitRefs(commit)
  return (
    <>
      <span className="commit-subject">{commit.subject}</span>
      <span className="commit-date">{commit.authorDate}</span>
      {refs.length > 0 && (
        <span className="commit-refs">
          {refs.map((ref) => (
            <span className={`commit-ref ${ref.type}`} key={`${commit.hash}-${ref.name}`}>
              {ref.name}
            </span>
          ))}
        </span>
      )}
    </>
  )
}

function visibleCommitRefs(commit: CommitSummary) {
  return commit.refs.filter((ref) => ref.type === 'branch' || ref.type === 'tag')
}

type FileListProps = {
  title: string
  tone: 'unstaged' | 'staged'
  changes: FileChange[]
  selectedPath: string | null
  selectedPaths: string[]
  onActivate(): void
  onSelect(change: FileChange, event: ReactMouseEvent, changes: FileChange[]): void
}

function FileList({
  title,
  tone,
  changes,
  selectedPath,
  selectedPaths,
  onActivate,
  onSelect,
}: FileListProps) {
  const selectedPathSet = new Set(selectedPaths)
  return (
    <section className="file-list" onFocusCapture={onActivate} onPointerDownCapture={onActivate}>
      <header className={tone}>{title}</header>
      <div className="file-list-body">
        {changes.length > 0 &&
          changes.map((change) => (
            <button
              className={`file-row ${selectedPathSet.has(change.path) ? 'selected' : ''} ${
                selectedPath === change.path ? 'active' : ''
              }`}
              key={`${tone}-${change.path}`}
              onClick={(event) => onSelect(change, event, changes)}
              title={change.path}
              type="button"
            >
              <FileStatusIcon change={change} pane={tone} />
              <span>{change.path}</span>
            </button>
          ))}
      </div>
    </section>
  )
}

function FileStatusIcon({ change, pane }: { change: FileChange; pane: Pane }) {
  const className = `file-icon ${fileIconClass(change, pane)}`
  if (pane === 'staged' && change.kind === 'modified') {
    return <FileCheck aria-hidden className={className} size={14} strokeWidth={2} />
  }

  return <File aria-hidden className={className} size={14} strokeWidth={2} />
}

function fileIconClass(change: FileChange, pane: Pane) {
  if (change.kind === 'added' || change.kind === 'untracked') return 'new'
  if (pane === 'staged') return 'staged'
  if (change.kind === 'deleted') return 'deleted'
  if (change.kind === 'renamed' || change.kind === 'copied') return 'renamed'
  if (change.kind === 'conflicted') return 'conflicted'
  return 'modified'
}

type DiffViewProps = {
  patch: string
  highlighted: boolean
  selectedLines: DiffLineSelection | null
  onSelectionChange(range: DiffLineSelection | null): void
  onContextMenu(
    event: ReactMouseEvent,
    hunkIndex: number | null,
    selection: DiffLineSelection | null,
  ): void
}

function DiffView({
  patch,
  highlighted,
  selectedLines,
  onSelectionChange,
  onContextMenu,
}: DiffViewProps) {
  if (!patch) return null
  const parsed = withVisibleLineNumbers(parseUnifiedDiff(patch))
  const isNewFile = isNewFilePatch(patch)

  return (
    <pre
      className={`classic-diff ${highlighted ? 'highlighted-diff' : ''}`}
      onMouseUp={() => onSelectionChange(selectionFromDom())}
      onKeyUp={() => onSelectionChange(selectionFromDom())}
      onContextMenu={(event) => {
        const currentSelection = selectionFromDom()
        onSelectionChange(currentSelection)
        const target =
          event.target instanceof Element ? event.target.closest<HTMLElement>('.diff-line') : null
        const hunkIndex = target?.dataset.hunk ? Number(target.dataset.hunk) : null
        onContextMenu(event, Number.isFinite(hunkIndex) ? hunkIndex : null, currentSelection)
      }}
    >
      {parsed.hunks.map((hunk, hunkIndex) => [
        <div
          className="diff-line line-hunk"
          data-hunk={hunkIndex}
          key={`hunk-${hunk.oldStart}-${hunk.newStart}-${hunk.header}`}
        >
          {hunk.header}
        </div>,
        ...hunk.lines.map((line, lineIndex) => {
          return (
            <DiffLine
              hunkIndex={hunkIndex}
              key={`line-${line.visibleLine ?? `${hunk.oldStart}-${hunk.newStart}-${lineIndex}`}`}
              line={line}
              isNewFile={isNewFile}
              selectedLines={selectedLines}
            />
          )
        }),
      ])}
    </pre>
  )
}

function BinaryDiff({ summary }: { summary: string }) {
  return (
    <div className="binary-diff">
      <div>* {summary}</div>
      <div>* Binary file (not showing content).</div>
    </div>
  )
}

function DiffLine({
  line,
  hunkIndex,
  selectedLines,
  isNewFile,
}: {
  line: ParsedDiffLine
  hunkIndex: number
  selectedLines: DiffLineSelection | null
  isNewFile: boolean
}) {
  const lineNumber =
    line.kind === 'add'
      ? line.newLine
      : line.kind === 'del'
        ? line.oldLine
        : (line.newLine ?? line.oldLine)
  const selected =
    selectedLines &&
    line.visibleLine !== undefined &&
    line.visibleLine >= Math.min(selectedLines.start, selectedLines.end) &&
    line.visibleLine <= Math.max(selectedLines.start, selectedLines.end)

  return (
    <div
      className={`diff-line ${lineClass(line.kind, isNewFile)} ${selected ? 'selected-line' : ''}`}
      data-hunk={hunkIndex}
      data-kind={line.kind}
      data-line-number={lineNumber}
      data-visible-line={line.visibleLine}
    >
      <span className="diff-marker">
        {isNewFile && line.kind === 'add' ? ' ' : markerForLine(line.kind)}
      </span>
      <span className="diff-code">{line.text || ' '}</span>
    </div>
  )
}

function selectionFromDom(): DiffLineSelection | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null

  const range = selection.getRangeAt(0)
  const start = closestDiffLine(range.startContainer)
  const end = closestDiffLine(range.endContainer)
  if (!start || !end) return null

  const startLine = Number(start.dataset.visibleLine)
  const endLine = Number(end.dataset.visibleLine)
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return null

  return { start: startLine, end: endLine }
}

function closestDiffLine(node: Node) {
  const element = node instanceof Element ? node : node.parentElement
  return element?.closest<HTMLElement>('.diff-line[data-visible-line]')
}

function markerForLine(kind: ParsedDiffLine['kind']) {
  if (kind === 'add') return '+'
  if (kind === 'del') return '-'
  return ' '
}

function lineClass(kind: ParsedDiffLine['kind'], isNewFile = false) {
  if (kind === 'add') return isNewFile ? 'line-new-file' : 'line-add'
  if (kind === 'del') return 'line-del'
  if (kind === 'meta') return 'line-file-meta'
  return 'line-context'
}

function isNewFilePatch(patch: string) {
  const parsed = parseUnifiedDiff(patch)
  return parsed.header.some((line) => line === '--- /dev/null' || line === 'new file mode 100644')
}

function isRefreshShortcut(event: KeyboardEvent) {
  return (
    (event.key === 'F5' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) ||
    (event.key.toLowerCase() === 'r' && primaryModifier(event) && !event.altKey && !event.shiftKey)
  )
}

function isStageShortcut(event: KeyboardEvent) {
  return (
    event.key.toLowerCase() === 't' && primaryModifier(event) && !event.altKey && !event.shiftKey
  )
}

function isUnstageShortcut(event: KeyboardEvent) {
  return (
    event.key.toLowerCase() === 'u' && primaryModifier(event) && !event.altKey && !event.shiftKey
  )
}

function isRevertShortcut(event: KeyboardEvent) {
  return (
    event.key.toLowerCase() === 'j' && primaryModifier(event) && !event.altKey && !event.shiftKey
  )
}

function isCommitShortcut(event: KeyboardEvent) {
  return event.key === 'Enter' && primaryModifier(event) && !event.altKey && !event.shiftKey
}

function primaryModifier(event: KeyboardEvent) {
  return isMacPlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

function isMacPlatform() {
  return navigator.platform.toLowerCase().includes('mac')
}

async function tryGitResult<T>(
  operation: () => Promise<{ ok: boolean; data?: T; error?: string }>,
) {
  try {
    return await operation()
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }

  const input = document.createElement('textarea')
  input.value = value
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.append(input)
  input.select()
  const copied = document.execCommand('copy')
  input.remove()
  if (!copied) throw new Error('Unable to copy commit hash.')
}

function clampedMenuPosition(x: number, y: number, width: number, height: number) {
  const margin = 8
  return {
    x: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
    y: Math.max(margin, Math.min(y, window.innerHeight - height - margin)),
  }
}

function nextFileSelection(
  tab: RepoTab,
  pane: Pane,
  clickedPath: string,
  changes: FileChange[],
  event: ReactMouseEvent,
): FileSelection {
  const paths = changes.map((change) => change.path)
  const samePane = tab.selectedPane === pane
  const currentPaths = samePane ? tab.selectedPaths.filter((path) => paths.includes(path)) : []
  const anchorPath = samePane ? tab.selectionAnchorPath : null

  if (event.shiftKey) {
    const anchorIndex = anchorPath ? paths.indexOf(anchorPath) : -1
    const clickedIndex = paths.indexOf(clickedPath)
    if (anchorIndex !== -1 && clickedIndex !== -1) {
      const start = Math.min(anchorIndex, clickedIndex)
      const end = Math.max(anchorIndex, clickedIndex)
      return {
        pane,
        path: clickedPath,
        paths: paths.slice(start, end + 1),
        anchorPath,
      }
    }
  }

  if (primaryMouseModifier(event)) {
    const selected = new Set(currentPaths)
    if (selected.has(clickedPath)) selected.delete(clickedPath)
    else selected.add(clickedPath)

    const nextPaths = paths.filter((path) => selected.has(path))
    return {
      pane,
      path: selected.has(clickedPath) ? clickedPath : (nextPaths[0] ?? null),
      paths: nextPaths,
      anchorPath: clickedPath,
    }
  }

  return {
    pane,
    path: clickedPath,
    paths: [clickedPath],
    anchorPath: clickedPath,
  }
}

function primaryMouseModifier(event: ReactMouseEvent) {
  return isMacPlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

function createTab(repoPath: string): RepoTab {
  return {
    id: crypto.randomUUID(),
    path: repoPath,
    displayName: displayName(repoPath),
    status: null,
    selectedPane: 'unstaged',
    selectedPath: null,
    selectedPaths: [],
    selectionAnchorPath: null,
    diff: null,
    diffLoading: false,
    commitDraft: loadDraft(repoPath),
    amend: false,
    selectedLines: null,
    message: 'Ready.',
  }
}

function loadInitialTabs() {
  return loadJson<string[]>(TABS_KEY, []).map(createTab)
}

function loadInitialActiveTabId(tabs: RepoTab[]) {
  const activePath = loadJson<string | null>(ACTIVE_TAB_KEY, null)
  return tabs.find((tab) => tab.path === activePath)?.id ?? tabs[0]?.id ?? null
}

function selectedFilePaths(tab: RepoTab) {
  const changes = selectedPaneChanges(tab)
  const existingPaths = new Set(changes.map((change) => change.path))
  const selectedPaths = tab.selectedPaths.filter((path) => existingPaths.has(path))
  if (selectedPaths.length > 0) return selectedPaths
  return tab.selectedPath && existingPaths.has(tab.selectedPath) ? [tab.selectedPath] : []
}

function selectedChanges(tab: RepoTab, pane: Pane) {
  const changes = pane === 'staged' ? tab.status?.staged : tab.status?.unstaged
  if (!changes || tab.selectedPane !== pane) return []
  const selectedPaths = new Set(selectedFilePaths(tab))
  return changes.filter((change) => selectedPaths.has(change.path))
}

function selectedPaneChanges(tab: RepoTab) {
  return tab.selectedPane === 'staged' ? (tab.status?.staged ?? []) : (tab.status?.unstaged ?? [])
}

function previousFileSelection(tab: RepoTab): SelectionPreference | undefined {
  if (!tab.status || !tab.selectedPath) return undefined
  const list = selectedPaneChanges(tab)
  const selectedPaths = selectedFilePaths(tab)
  const selectedIndexes = selectedPaths
    .map((path) => list.findIndex((change) => change.path === path))
    .filter((index) => index !== -1)
  if (selectedIndexes.length === 0) return undefined

  const firstIndex = Math.min(...selectedIndexes)
  const lastIndex = Math.max(...selectedIndexes)
  const preferredPath = list[firstIndex - 1]?.path ?? list[lastIndex + 1]?.path ?? null

  return {
    pane: tab.selectedPane,
    path: preferredPath,
    paths: preferredPath ? [preferredPath] : [],
    anchorPath: preferredPath,
  }
}

function preserveSelection(
  tab: RepoTab,
  status: RepoStatus,
  preference?: SelectionPreference,
): FileSelection {
  if (preference) {
    const preferredList = preference.pane === 'staged' ? status.staged : status.unstaged
    const preferredPaths = (preference.paths ?? []).filter((path) =>
      preferredList.some((change) => change.path === path),
    )
    if (preference.path && preferredList.some((change) => change.path === preference.path)) {
      return {
        path: preference.path,
        pane: preference.pane,
        paths: preferredPaths.length > 0 ? preferredPaths : [preference.path],
        anchorPath: preference.anchorPath ?? preference.path,
      }
    }
  }

  const list = tab.selectedPane === 'staged' ? status.staged : status.unstaged
  const paths = tab.selectedPaths.filter((path) => list.some((change) => change.path === path))
  if (tab.selectedPath && list.some((change) => change.path === tab.selectedPath)) {
    return {
      path: tab.selectedPath,
      pane: tab.selectedPane,
      paths: paths.length > 0 ? paths : [tab.selectedPath],
      anchorPath: tab.selectionAnchorPath ?? tab.selectedPath,
    }
  }
  if (paths[0]) {
    return {
      path: paths[0],
      pane: tab.selectedPane,
      paths,
      anchorPath: tab.selectionAnchorPath ?? paths[0],
    }
  }
  if (status.unstaged[0])
    return {
      path: status.unstaged[0].path,
      pane: 'unstaged',
      paths: [status.unstaged[0].path],
      anchorPath: status.unstaged[0].path,
    }
  if (status.staged[0])
    return {
      path: status.staged[0].path,
      pane: 'staged',
      paths: [status.staged[0].path],
      anchorPath: status.staged[0].path,
    }
  return { path: null, pane: 'unstaged', paths: [], anchorPath: null }
}

function displayName(repoPath: string) {
  return repoPath.split(/[\\/]/).filter(Boolean).at(-1) ?? repoPath
}

function loadDraft(repoPath: string) {
  return loadJson<Record<string, string>>(DRAFT_KEY, {})[repoPath] ?? ''
}

function saveDraft(repoPath: string, value: string) {
  const drafts = loadJson<Record<string, string>>(DRAFT_KEY, {})
  drafts[repoPath] = value
  saveJson(DRAFT_KEY, drafts)
}
