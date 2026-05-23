import type { MouseEvent as ReactMouseEvent } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type { FileChange, RepoStatus } from '../../shared/types'
import { formatCommitMessage } from '../utils/commitMessage'
import {
  buildHunkPatch,
  buildSelectionPatch,
  type DiffLineSelection,
  type ParsedDiffLine,
  parseUnifiedDiff,
  withVisibleLineNumbers,
} from '../utils/diff'
import { loadJson, saveJson } from '../utils/storage'

type ThemeName = 'system' | 'light' | 'dark' | 'monokai'
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
  diff: string
  diffLoading: boolean
  commitDraft: string
  amend: boolean
  selectedLines: DiffLineSelection | null
  message: string
}

const TABS_KEY = 'git-guis.tabs'
const PREFS_KEY = 'git-guis.preferences'
const DRAFT_KEY = 'git-guis.drafts'

const defaultPrefs: Preferences = {
  theme: 'system',
  diffMode: 'highlighted',
}

export function App() {
  const [tabs, setTabs] = useState<RepoTab[]>(() => loadInitialTabs())
  const [activeTabId, setActiveTabId] = useState<string | null>(() => tabs[0]?.id ?? null)
  const [prefs, setPrefs] = useState<Preferences>(() => loadJson(PREFS_KEY, defaultPrefs))
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null

  useEffect(() => {
    document.documentElement.dataset.theme = prefs.theme
    saveJson(PREFS_KEY, prefs)
  }, [prefs])

  useEffect(() => {
    saveJson(
      TABS_KEY,
      tabs.map((tab) => tab.path),
    )
  }, [tabs])

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

  const openRepository = async () => {
    const selectedPath = await window.gitApi.openRepository()
    if (!selectedPath) return

    const validation = await window.gitApi.validateRepository(selectedPath)
    if (!validation.ok || !validation.data) {
      showMessage(null, validation.error ?? 'Not a Git repository.')
      return
    }

    const root = validation.data.root
    const existing = tabs.find((tab) => tab.path === root)
    if (existing) {
      setActiveTabId(existing.id)
      return
    }

    const tab = createTab(root)
    setTabs((current) => [...current, tab])
    setActiveTabId(tab.id)
    void refreshTab(tab.id, root)
  }

  const openWorktrees = async () => {
    if (!activeTab) return
    const result = await window.gitApi.listWorktrees(activeTab.path)
    if (!result.ok || !result.data) {
      showMessage(activeTab.id, result.error ?? 'Unable to list worktrees.')
      return
    }

    const newTabs = result.data
      .filter((worktree) => !worktree.bare && !tabs.some((tab) => tab.path === worktree.path))
      .map((worktree) => createTab(worktree.path))

    setTabs((current) => [...current, ...newTabs])
    for (const tab of newTabs) void refreshTab(tab.id, tab.path)
  }

  const closeTab = (tabId: string) => {
    setTabs((current) => {
      const next = current.filter((tab) => tab.id !== tabId)
      if (activeTabId === tabId) setActiveTabId(next[0]?.id ?? null)
      return next
    })
  }

  const refreshTab = useCallback(
    async (tabId: string, explicitPath?: string) => {
      const tab = tabs.find((item) => item.id === tabId)
      const repoPath = explicitPath ?? tab?.path
      if (!repoPath) return

      const status = await window.gitApi.getStatus(repoPath)
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
            selectedPath: selection.path,
            selectedPane: selection.pane,
            message: 'Ready.',
          }
        }),
      )

      const latestTab = tabs.find((item) => item.id === tabId) ?? tab
      const selection = latestTab
        ? preserveSelection(latestTab, statusData)
        : { path: null, pane: 'unstaged' as Pane }
      if (selection.path) void loadDiff(tabId, repoPath, selection.path, selection.pane)
    },
    [tabs],
  )

  const loadDiff = async (tabId: string, repoPath: string, filePath: string, pane: Pane) => {
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

    const result = await window.gitApi.getDiff(repoPath, filePath, pane === 'staged')
    setTabs((current) =>
      current.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              diff: result.data ?? '',
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
        ? await window.gitApi.unstageFile(tab.path, tab.selectedPath)
        : await window.gitApi.stageFile(tab.path, tab.selectedPath)
    if (!result.ok) {
      showMessage(tab.id, result.error ?? 'Git operation failed.')
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
    const patch = buildHunkPatch(tab.diff, hunkIndex)
    if (!patch) return
    const result = await window.gitApi.applyPatch(tab.path, patch, tab.selectedPane === 'staged')
    if (!result.ok) {
      showMessage(tab.id, result.error ?? 'Patch did not apply.')
      return
    }
    await refreshTab(tab.id)
  }

  const applySelection = async (tab: RepoTab, selection?: DiffLineSelection | null) => {
    const patch = buildSelectionPatch(tab.diff, selection ?? tab.selectedLines)
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
    const message = formatCommitMessage(tab.commitDraft)
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
          ? { ...item, commitDraft: '', message: result.data?.trim() || 'Committed.' }
          : item,
      ),
    )
    await refreshTab(tab.id)
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
              <span>{tab.displayName}</span>
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
              x
            </button>
          </div>
        ))}
        <button className="toolbar-button" onClick={openRepository} type="button">
          Open
        </button>
        <button
          className="toolbar-button"
          onClick={openWorktrees}
          disabled={!activeTab}
          type="button"
        >
          Worktrees
        </button>
        <div className="toolbar-spacer" />
        <select
          value={prefs.theme}
          onChange={(event) => setPrefs({ ...prefs, theme: event.target.value as ThemeName })}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
          <option value="monokai">Monokai Extended</option>
        </select>
        <select
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
          onSelect={(pane, change) => loadDiff(activeTab.id, activeTab.path, change.path, pane)}
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
          onAmendChange={(amend) => {
            setTabs((current) =>
              current.map((tab) => (tab.id === activeTab.id ? { ...tab, amend } : tab)),
            )
            if (amend && !activeTab.commitDraft.trim()) void loadAmendMessage(activeTab)
          }}
          onLoadAmendMessage={() => loadAmendMessage(activeTab)}
        />
      ) : (
        <section className="empty-state">
          <button className="primary-button" onClick={openRepository} type="button">
            Open Repository
          </button>
        </section>
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
  onAmendChange(amend: boolean): void
  onLoadAmendMessage(): void
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
  onAmendChange,
  onLoadAmendMessage,
}: RepositoryViewProps) {
  const hunks = useMemo(() => parseUnifiedDiff(tab.diff).hunks, [tab.diff])
  const diffTitle = tab.selectedPane === 'staged' ? 'Staged for commit' : 'Modified, not staged'
  const [contextMenu, setContextMenu] = useState<DiffContextMenu>(null)

  return (
    <section className="repo-view">
      <div className="branch-strip">
        <strong>Current Branch:</strong> {tab.status?.branch ?? 'detached'} <span>{tab.path}</span>
      </div>
      <div className="workspace-grid">
        <aside className="file-column">
          <FileList
            title="Unstaged Changes"
            tone="unstaged"
            changes={tab.status?.unstaged ?? []}
            selectedPath={tab.selectedPane === 'unstaged' ? tab.selectedPath : null}
            onSelect={(change) => onSelect('unstaged', change)}
          />
          <div className="splitter" />
          <FileList
            title="Staged Changes (Will Commit)"
            tone="staged"
            changes={tab.status?.staged ?? []}
            selectedPath={tab.selectedPane === 'staged' ? tab.selectedPath : null}
            onSelect={(change) => onSelect('staged', change)}
          />
        </aside>

        <section className="right-column">
          <div className="diff-header">
            <strong>{diffTitle}</strong>
            <span>{tab.selectedPath ? `File: ${tab.selectedPath}` : 'No file selected'}</span>
          </div>

          <div className="diff-body">
            {tab.diffLoading ? (
              <div className="placeholder">Loading diff...</div>
            ) : tab.diff ? (
              <DiffView
                patch={tab.diff}
                highlighted={prefs.diffMode === 'highlighted'}
                selectedLines={tab.selectedLines}
                onSelectionChange={onSelectedLines}
                onContextMenu={(event, hunkIndex, selection) => {
                  event.preventDefault()
                  event.stopPropagation()
                  setContextMenu({ x: event.clientX, y: event.clientY, hunkIndex, selection })
                }}
              />
            ) : (
              <div className="placeholder">Select a file to review changes.</div>
            )}
          </div>

          {contextMenu && (
            <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
              <button
                disabled={!contextMenu.selection}
                onClick={() => onApplySelection(contextMenu.selection)}
                type="button"
              >
                {tab.selectedPane === 'staged' ? 'Unstage' : 'Stage'} Selected Lines
              </button>
              <button
                disabled={contextMenu.hunkIndex === null}
                onClick={() => contextMenu.hunkIndex !== null && onApplyHunk(contextMenu.hunkIndex)}
                type="button"
              >
                {tab.selectedPane === 'staged' ? 'Unstage' : 'Stage'} Hunk
              </button>
              <button disabled={!tab.selectedPath} onClick={onToggleStage} type="button">
                {tab.selectedPane === 'staged' ? 'Unstage' : 'Stage'} File
              </button>
              <button
                disabled={tab.selectedPane !== 'unstaged' || !tab.selectedPath}
                onClick={onRevert}
                type="button"
              >
                Revert File
              </button>
              <button onClick={onRefresh} type="button">
                Refresh
              </button>
              {hunks.length > 1 && (
                <div className="context-menu-note">{hunks.length} hunks in file</div>
              )}
            </div>
          )}

          <footer className="commit-panel">
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
              {tab.amend && (
                <button onClick={onLoadAmendMessage} type="button">
                  Load last message
                </button>
              )}
            </div>
            <div className="commit-grid">
              <button onClick={onCommit} type="button">
                Commit
              </button>
              <textarea
                value={tab.commitDraft}
                onChange={(event) => onDraftChange(event.target.value)}
                spellCheck
              />
            </div>
          </footer>
        </section>
      </div>
      <div className="status-bar">{tab.message}</div>
    </section>
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
              <span className={`status-dot ${change.kind}`} />
              <span>{change.path}</span>
            </button>
          ))
        )}
      </div>
    </section>
  )
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

function createTab(repoPath: string): RepoTab {
  return {
    id: crypto.randomUUID(),
    path: repoPath,
    displayName: displayName(repoPath),
    status: null,
    selectedPane: 'unstaged',
    selectedPath: null,
    diff: '',
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
