import { File, FileCheck, Plus, X } from 'lucide-react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'

import type { FileChange, GitDiff, RepoStatus, ThemeName } from '../../shared/types'
import {
  buildHunkPatch,
  buildSelectionPatch,
  type DiffLineSelection,
  type ParsedDiffLine,
  parseUnifiedDiff,
  withVisibleLineNumbers,
} from '../utils/diff'
import { loadJson, saveJson } from '../utils/storage'

type DiffMode = 'highlighted' | 'classic'
type Pane = 'unstaged' | 'staged'

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

const TABS_KEY = 'git-guis.tabs'
const ACTIVE_TAB_KEY = 'git-guis.activeTab'
const PREFS_KEY = 'git-guis.preferences'
const DRAFT_KEY = 'git-guis.drafts'
const WORKSPACE_LAYOUT_KEY = 'git-guis.layout.workspace'
const FILE_LIST_LAYOUT_KEY = 'git-guis.layout.file-list'
const RIGHT_PANE_LAYOUT_KEY = 'git-guis.layout.right-pane'

const defaultPrefs: Preferences = {
  theme: 'system',
  diffMode: 'highlighted',
}

export function App() {
  const [tabs, setTabs] = useState<RepoTab[]>(() => loadInitialTabs())
  const [activeTabId, setActiveTabId] = useState<string | null>(() => loadInitialActiveTabId(tabs))
  const [prefs, setPrefs] = useState<Preferences>(() => loadJson(PREFS_KEY, defaultPrefs))
  const [pushDialog, setPushDialog] = useState<PushDialogState | null>(null)
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
        void toggleStage(activeTab)
      }
      if (isUnstageShortcut(event)) {
        event.preventDefault()
        void unstageSelected(activeTab)
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
  }, [activeTab, tabs])

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

  const refreshTab = useCallback(
    async (tabId: string, explicitPath?: string, explicitAmend?: boolean) => {
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
          const selection = preserveSelection(item, statusData)
          return {
            ...item,
            status: statusData,
            displayName: displayName(statusData.root),
            diff: selection.path ? item.diff : null,
            diffLoading: false,
            selectedPath: selection.path,
            selectedPane: selection.pane,
            selectedLines: selection.path ? item.selectedLines : null,
            message: 'Ready.',
          }
        }),
      )

      const latestTab = tabs.find((item) => item.id === tabId) ?? tab
      const selection = latestTab
        ? preserveSelection(latestTab, statusData)
        : { path: null, pane: 'unstaged' as Pane }
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
  ) => {
    setTabs((current) =>
      current.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              selectedPath: filePath,
              selectedPane: pane,
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

  const toggleStage = async (tab: RepoTab) => {
    if (!tab.selectedPath) return
    const result =
      tab.selectedPane === 'staged'
        ? await window.gitApi.unstageFile(tab.path, tab.selectedPath, tab.amend)
        : await window.gitApi.stageFile(tab.path, tab.selectedPath)
    if (!result.ok) {
      showMessage(tab.id, result.error ?? 'Git operation failed.')
      return
    }
    await refreshTab(tab.id)
  }

  const unstageSelected = async (tab: RepoTab) => {
    if (!tab.selectedPath || tab.selectedPane !== 'staged') return
    const result = await window.gitApi.unstageFile(tab.path, tab.selectedPath, tab.amend)
    if (!result.ok) {
      showMessage(tab.id, result.error ?? 'Unable to unstage file.')
      return
    }
    await refreshTab(tab.id)
  }

  const revertSelected = async (tab: RepoTab) => {
    if (!tab.selectedPath || tab.selectedPane !== 'unstaged') return
    const change = tab.status?.unstaged.find((item) => item.path === tab.selectedPath)
    if (!change) return

    const message =
      change.kind === 'untracked'
        ? `Move untracked file to Trash?\n\n${change.path}`
        : `Discard unstaged changes in this file?\n\n${change.path}`
    if (!window.confirm(message)) return

    const result = await window.gitApi.revertFile(
      tab.path,
      change.path,
      change.kind === 'untracked',
    )
    if (!result.ok) {
      showMessage(tab.id, result.error ?? 'Unable to revert file.')
      return
    }
    await refreshTab(tab.id)
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

  const loadAmendMessage = async (tab: RepoTab) => {
    const result = await window.gitApi.getLastCommitMessage(tab.path)
    if (!result.ok || result.data === undefined) {
      showMessage(tab.id, result.error ?? 'Unable to load last commit message.')
      return
    }
    updateDraft(tab.id, result.data)
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
        {tabs.map((tab) => (
          <div className={`repo-tab ${tab.id === activeTab?.id ? 'active' : ''}`} key={tab.id}>
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
          </div>
        ))}
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
          onRefresh={() => refreshTab(activeTab.id)}
          onSelect={(pane, change) =>
            loadDiff(activeTab.id, activeTab.path, change.path, pane, activeTab.amend)
          }
          onToggleStage={() => toggleStage(activeTab)}
          onRevert={() => revertSelected(activeTab)}
          onApplyHunk={(hunkIndex) => applyHunk(activeTab, hunkIndex)}
          onApplySelection={(selection) => applySelection(activeTab, selection)}
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
          onAmendChange={(amend) => {
            setTabs((current) =>
              current.map((tab) => (tab.id === activeTab.id ? { ...tab, amend } : tab)),
            )
            void refreshTab(activeTab.id, undefined, amend)
            if (amend && !activeTab.commitDraft.trim()) void loadAmendMessage(activeTab)
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
    </main>
  )
}

type RepositoryViewProps = {
  tab: RepoTab
  prefs: Preferences
  onRefresh(): void
  onSelect(pane: Pane, change: FileChange): void
  onToggleStage(): void
  onRevert(): void
  onApplyHunk(hunkIndex: number): void
  onApplySelection(selection?: DiffLineSelection | null): void
  onSelectedLines(range: DiffLineSelection | null): void
  onDraftChange(value: string): void
  onCommit(): void
  onPush(): void
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
  onRefresh,
  onSelect,
  onToggleStage,
  onRevert,
  onApplyHunk,
  onApplySelection,
  onSelectedLines,
  onDraftChange,
  onCommit,
  onPush,
  onAmendChange,
}: RepositoryViewProps) {
  const hunks = useMemo(
    () => (tab.diff?.kind === 'text' ? parseUnifiedDiff(tab.diff.patch).hunks : []),
    [tab.diff],
  )
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
                onSelect={(change) => onSelect('unstaged', change)}
              />
            </Panel>
            <Separator className="resize-handle resize-handle-vertical" id="file-list-separator" />
            <Panel className="file-list-panel" defaultSize="44%" id="staged" minSize={100}>
              <FileList
                title={tab.amend ? 'Staged Changes (Will Amend)' : 'Staged Changes (Will Commit)'}
                tone="staged"
                changes={tab.status?.staged ?? []}
                selectedPath={tab.selectedPane === 'staged' ? tab.selectedPath : null}
                onSelect={(change) => onSelect('staged', change)}
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

              <div className="diff-body">
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
                      setContextMenu({ x: event.clientX, y: event.clientY, hunkIndex, selection })
                    }}
                  />
                ) : tab.diff?.kind === 'binary' ? (
                  <BinaryDiff summary={tab.diff.summary} />
                ) : (
                  <div className="placeholder">Select a file to review changes.</div>
                )}
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

            <Panel className="commit-panel" defaultSize="24%" id="commit" minSize={140}>
              <div className="commit-toolbar">
                <span>Commit Message:</span>
                <label>
                  <input
                    type="checkbox"
                    checked={tab.amend}
                    onChange={(event) => onAmendChange(event.target.checked)}
                  />
                  Amend Last Commit
                </label>
              </div>
              <div className="commit-grid">
                <div className="commit-actions">
                  <button onClick={onCommit} type="button">
                    Commit
                  </button>
                  <button onClick={onPush} type="button">
                    Push
                  </button>
                </div>
                <textarea
                  value={tab.commitDraft}
                  onChange={(event) => onDraftChange(event.target.value)}
                  spellCheck
                />
              </div>
            </Panel>
          </Group>
        </Panel>
      </Group>
      <div className="status-bar">{tab.message}</div>
    </section>
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

type FileListProps = {
  title: string
  tone: 'unstaged' | 'staged'
  changes: FileChange[]
  selectedPath: string | null
  onSelect(change: FileChange): void
}

function FileList({ title, tone, changes, selectedPath, onSelect }: FileListProps) {
  return (
    <section className="file-list">
      <header className={tone}>{title}</header>
      <div className="file-list-body">
        {changes.length === 0 ? (
          <div className="empty-list">No changes</div>
        ) : (
          changes.map((change) => (
            <button
              className={`file-row ${selectedPath === change.path ? 'selected' : ''}`}
              key={`${tone}-${change.path}`}
              onClick={() => onSelect(change)}
              title={change.path}
              type="button"
            >
              <FileStatusIcon change={change} pane={tone} />
              <span>{change.path}</span>
            </button>
          ))
        )}
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
  if (!patch) return <div className="placeholder">Select a file to review changes.</div>
  const parsed = withVisibleLineNumbers(parseUnifiedDiff(patch))
  const isNewFile = parsed.header.some(
    (line) => line === '--- /dev/null' || line === 'new file mode 100644',
  )

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
      <span className="diff-marker">{markerForLine(line.kind)}</span>
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

function createTab(repoPath: string): RepoTab {
  return {
    id: crypto.randomUUID(),
    path: repoPath,
    displayName: displayName(repoPath),
    status: null,
    selectedPane: 'unstaged',
    selectedPath: null,
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

function preserveSelection(tab: RepoTab, status: RepoStatus): { path: string | null; pane: Pane } {
  const list = tab.selectedPane === 'staged' ? status.staged : status.unstaged
  if (tab.selectedPath && list.some((change) => change.path === tab.selectedPath))
    return { path: tab.selectedPath, pane: tab.selectedPane }
  if (status.unstaged[0]) return { path: status.unstaged[0].path, pane: 'unstaged' }
  if (status.staged[0]) return { path: status.staged[0].path, pane: 'staged' }
  return { path: null, pane: 'unstaged' }
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
