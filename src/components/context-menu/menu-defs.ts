import type { MenuItem, ContextTarget } from './context-menu-types'
import type { AppView } from '@/components/Sidebar'
import type { Tab, ProjectGroup } from '@/store/types'
import type { PaneNode, PaneContent } from '@/store/paneTypes'
import { findPaneContent } from '@/lib/pane-utils'
import { collectSessionRefsFromNode } from '@/lib/session-utils'
import type { TerminalActions, EditorActions, BrowserActions } from '@/lib/pane-action-registry'
import { buildResumeCommand, isResumeCommandProvider, type ResumeCommandProvider } from '@/lib/coding-cli-utils'

export type MenuActions = {
  newDefaultTab: () => void
  newTabWithPane: (type: 'shell' | 'cmd' | 'powershell' | 'wsl' | 'browser' | 'editor') => void
  copyTabNames: () => void
  toggleSidebar: () => void
  copyShareLink: () => void
  openView: (view: AppView) => void
  copyTabName: (tabId: string) => void
  renameTab: (tabId: string) => void
  closeTab: (tabId: string) => void
  closeOtherTabs: (tabId: string) => void
  closeTabsToRight: (tabId: string) => void
  moveTab: (tabId: string, dir: -1 | 1) => void
  renamePane: (tabId: string, paneId: string) => void
  replacePane: (tabId: string, paneId: string) => void
  splitPane: (tabId: string, paneId: string, direction: 'horizontal' | 'vertical') => void
  resetSplit: (tabId: string, splitId: string) => void
  swapSplit: (tabId: string, splitId: string) => void
  closePane: (tabId: string, paneId: string) => void
  getTerminalActions: (paneId: string) => TerminalActions | undefined
  getEditorActions: (paneId: string) => EditorActions | undefined
  getBrowserActions: (paneId: string) => BrowserActions | undefined
  openSessionInNewTab: (sessionId: string, provider?: string) => void
  openSessionInThisTab: (sessionId: string, provider?: string) => void
  renameSession: (sessionId: string, provider?: string, withSummary?: boolean) => void
  toggleArchiveSession: (sessionId: string, provider: string | undefined, next: boolean) => void
  deleteSession: (sessionId: string, provider?: string) => void
  copySessionId: (sessionId: string) => void
  copySessionCwd: (sessionId: string, provider?: string) => void
  copySessionSummary: (sessionId: string, provider?: string) => void
  copySessionMetadata: (sessionId: string, provider?: string) => void
  copyResumeCommand: (provider: ResumeCommandProvider, sessionId: string) => void
  setProjectColor: (projectPath: string) => void
  toggleProjectExpanded: (projectPath: string, expanded: boolean) => void
  openAllSessionsInProject: (projectPath: string) => void
  copyProjectPath: (projectPath: string) => void
  openTerminal: (terminalId: string) => void
  renameTerminal: (terminalId: string) => void
  generateTerminalSummary: (terminalId: string) => void
  deleteTerminal: (terminalId: string) => void
  copyTerminalCwd: (terminalId: string) => void
  copyMessageText: (contextEl: HTMLElement | null) => void
  copyMessageCode: (contextEl: HTMLElement | null) => void
  copyFreshclaudeCodeBlock: (clickTarget: HTMLElement | null) => void
  copyFreshclaudeToolInput: (clickTarget: HTMLElement | null) => void
  copyFreshclaudeToolOutput: (clickTarget: HTMLElement | null) => void
  copyFreshclaudeDiffNew: (clickTarget: HTMLElement | null) => void
  copyFreshclaudeDiffOld: (clickTarget: HTMLElement | null) => void
  copyFreshclaudeFilePath: (clickTarget: HTMLElement | null) => void
}

export type MenuBuildContext = {
  view: AppView
  sidebarCollapsed: boolean
  tabs: Tab[]
  paneLayouts: Record<string, PaneNode>
  sessions: ProjectGroup[]
  expandedProjects: Set<string>
  contextElement: HTMLElement | null
  clickTarget: HTMLElement | null
  actions: MenuActions
  platform: string | null
}

function isWindowsLike(platform: string | null): boolean {
  return platform === 'win32' || platform === 'wsl'
}

function getSessionById(projects: ProjectGroup[], sessionId: string, provider?: string) {
  for (const project of projects) {
    const session = project.sessions.find((s) => s.sessionId === sessionId)
    if (session && (!provider || session.provider === provider)) return { session, project }
  }
  return null
}

type ResumeCommandCandidate = {
  provider: ResumeCommandProvider
  sessionId?: string
}

function getTabProvider(tab?: Tab): string | undefined {
  if (!tab) return undefined
  return tab.codingCliProvider || (tab.mode !== 'shell' ? tab.mode : undefined)
}

function getResumeCandidateForTerminalContent(content: PaneContent, tab?: Tab): ResumeCommandCandidate | null {
  if (content.kind !== 'terminal') return null
  if (!isResumeCommandProvider(content.mode)) return null
  const tabProvider = getTabProvider(tab)
  const sessionId = content.resumeSessionId || (tabProvider === content.mode ? tab?.resumeSessionId : undefined)
  return {
    provider: content.mode,
    sessionId,
  }
}

function getResumeCandidateForLegacyTab(tab?: Tab): ResumeCommandCandidate | null {
  const provider = getTabProvider(tab)
  if (!isResumeCommandProvider(provider)) return null
  return {
    provider,
    sessionId: tab?.resumeSessionId,
  }
}

function buildCopyResumeMenuItem(id: string, candidate: ResumeCommandCandidate, actions: MenuActions): MenuItem {
  const canCopy = !!buildResumeCommand(candidate.provider, candidate.sessionId)
  return {
    type: 'item',
    id,
    label: 'Copy resume command',
    onSelect: () => {
      if (!candidate.sessionId) return
      actions.copyResumeCommand(candidate.provider, candidate.sessionId)
    },
    disabled: !canCopy,
  }
}

export function buildMenuItems(target: ContextTarget, ctx: MenuBuildContext): MenuItem[] {
  const { actions, tabs, paneLayouts, sessions, view, sidebarCollapsed, expandedProjects, contextElement, clickTarget, platform } = ctx
  const isSessionOpen = (sessionId: string, provider?: string) => {
    const keyProvider = provider || 'claude'
    for (const tab of tabs) {
      const layout = paneLayouts[tab.id]
      if (!layout) continue
      const refs = collectSessionRefsFromNode(layout)
      if (refs.some((ref) => ref.provider === keyProvider && ref.sessionId === sessionId)) {
        return true
      }
    }
    return false
  }

  if (target.kind === 'global') {
    const views: Array<{ id: AppView; label: string }> = [
      { id: 'terminal', label: 'Coding Agents' },
      { id: 'tabs', label: 'Tabs' },
      { id: 'overview', label: 'Panes' },
      { id: 'sessions', label: 'Projects' },
      { id: 'settings', label: 'Settings' },
    ]

    return [
      { type: 'item', id: 'new-tab', label: 'New tab', onSelect: actions.newDefaultTab },
      { type: 'item', id: 'copy-tabs', label: 'Copy all tab names', onSelect: actions.copyTabNames },
      { type: 'item', id: 'toggle-sidebar', label: `${sidebarCollapsed ? 'Open' : 'Close'} menu`, onSelect: actions.toggleSidebar },
      { type: 'item', id: 'copy-link', label: 'Copy freshell token link', onSelect: actions.copyShareLink },
      { type: 'separator', id: 'views-sep' },
      ...views
        .filter((v) => v.id !== view)
        .map((v) => ({
          type: 'item' as const,
          id: `open-${v.id}`,
          label: `Open ${v.label}`,
          onSelect: () => actions.openView(v.id),
        })),
    ]
  }

  if (target.kind === 'tab-add') {
    const shellItems: MenuItem[] = isWindowsLike(platform)
      ? [
          { type: 'item', id: 'new-cmd', label: 'New CMD tab', onSelect: () => actions.newTabWithPane('cmd') },
          { type: 'item', id: 'new-powershell', label: 'New PowerShell tab', onSelect: () => actions.newTabWithPane('powershell') },
          { type: 'item', id: 'new-wsl', label: 'New WSL tab', onSelect: () => actions.newTabWithPane('wsl') },
        ]
      : [{ type: 'item', id: 'new-shell', label: 'New Shell tab', onSelect: () => actions.newTabWithPane('shell') }]

    return [
      ...shellItems,
      { type: 'separator', id: 'new-tab-sep' },
      { type: 'item', id: 'new-browser', label: 'New Browser tab', onSelect: () => actions.newTabWithPane('browser') },
      { type: 'item', id: 'new-editor', label: 'New Editor tab', onSelect: () => actions.newTabWithPane('editor') },
    ]
  }

  if (target.kind === 'tab') {
    const index = tabs.findIndex((t) => t.id === target.tabId)
    const tab = tabs[index]
    const layout = paneLayouts[target.tabId]
    const resumeCandidate =
      layout?.type === 'leaf'
        ? getResumeCandidateForTerminalContent(layout.content, tab)
        : !layout
          ? getResumeCandidateForLegacyTab(tab)
          : null
    const tabResumeMenuItem = resumeCandidate
      ? [buildCopyResumeMenuItem('tab-copy-resume-command', resumeCandidate, actions)]
      : []
    const isFirst = index <= 0
    const isLast = index === tabs.length - 1
    const onlyOne = tabs.length <= 1

    return [
      { type: 'item', id: 'copy-tab-name', label: 'Copy tab name', onSelect: () => actions.copyTabName(target.tabId) },
      ...tabResumeMenuItem,
      { type: 'item', id: 'rename-tab', label: 'Rename tab', onSelect: () => actions.renameTab(target.tabId) },
      { type: 'separator', id: 'tab-sep' },
      { type: 'item', id: 'close-tab', label: 'Close tab', onSelect: () => actions.closeTab(target.tabId) },
      {
        type: 'item',
        id: 'close-others',
        label: 'Close all but this tab',
        onSelect: () => actions.closeOtherTabs(target.tabId),
        disabled: onlyOne,
        danger: true,
      },
      {
        type: 'item',
        id: 'close-right',
        label: 'Close tabs to the right',
        onSelect: () => actions.closeTabsToRight(target.tabId),
        disabled: isLast,
        danger: true,
      },
      { type: 'separator', id: 'tab-move-sep' },
      { type: 'item', id: 'move-left', label: 'Move tab left', onSelect: () => actions.moveTab(target.tabId, -1), disabled: isFirst },
      { type: 'item', id: 'move-right', label: 'Move tab right', onSelect: () => actions.moveTab(target.tabId, 1), disabled: isLast },
    ]
  }

  if (target.kind === 'pane') {
    const tab = tabs.find((t) => t.id === target.tabId)
    const layout = paneLayouts[target.tabId]
    const paneContent = layout ? findPaneContent(layout, target.paneId) : null
    const resumeCandidate = paneContent ? getResumeCandidateForTerminalContent(paneContent, tab) : null
    const paneResumeMenuItem = resumeCandidate
      ? [buildCopyResumeMenuItem('pane-copy-resume-command', resumeCandidate, actions)]
      : []
    return [
      ...paneResumeMenuItem,
      { type: 'item', id: 'split-right', label: 'Split right', onSelect: () => actions.splitPane(target.tabId, target.paneId, 'horizontal') },
      { type: 'item', id: 'split-down', label: 'Split down', onSelect: () => actions.splitPane(target.tabId, target.paneId, 'vertical') },
      { type: 'separator', id: 'pane-split-sep' },
      { type: 'item', id: 'rename-pane', label: 'Rename pane', onSelect: () => actions.renamePane(target.tabId, target.paneId) },
      { type: 'separator', id: 'pane-replace-sep' },
      { type: 'item', id: 'replace-pane', label: 'Replace pane', onSelect: () => actions.replacePane(target.tabId, target.paneId) },
    ]
  }

  if (target.kind === 'pane-divider') {
    return [
      { type: 'item', id: 'reset-split', label: 'Reset split (50/50)', onSelect: () => actions.resetSplit(target.tabId, target.splitId) },
      { type: 'item', id: 'swap-split', label: 'Swap panes', onSelect: () => actions.swapSplit(target.tabId, target.splitId) },
    ]
  }

  if (target.kind === 'terminal') {
    const terminalActions = actions.getTerminalActions(target.paneId)
    const hasSelection = terminalActions?.hasSelection() ?? false
    const tab = tabs.find((t) => t.id === target.tabId)
    const layout = paneLayouts[target.tabId]
    const paneContent = layout ? findPaneContent(layout, target.paneId) : null
    const resumeCandidate = paneContent ? getResumeCandidateForTerminalContent(paneContent, tab) : null
    const terminalResumeMenuItem = resumeCandidate
      ? [buildCopyResumeMenuItem('terminal-copy-resume-command', resumeCandidate, actions)]
      : []
    return [
      {
        type: 'item',
        id: 'terminal-copy',
        label: 'Copy selection',
        onSelect: () => terminalActions?.copySelection(),
        disabled: !terminalActions || !hasSelection,
      },
      {
        type: 'item',
        id: 'terminal-paste',
        label: 'Paste',
        onSelect: () => terminalActions?.paste(),
        disabled: !terminalActions,
      },
      {
        type: 'item',
        id: 'terminal-select-all',
        label: 'Select all',
        onSelect: () => terminalActions?.selectAll(),
        disabled: !terminalActions,
      },
      {
        type: 'item',
        id: 'terminal-search',
        label: 'Search',
        onSelect: () => terminalActions?.openSearch(),
        disabled: !terminalActions,
      },
      ...terminalResumeMenuItem,
      { type: 'separator', id: 'terminal-sep' },
      {
        type: 'item',
        id: 'terminal-clear',
        label: 'Clear scrollback',
        onSelect: () => terminalActions?.clearScrollback(),
        disabled: !terminalActions,
      },
      {
        type: 'item',
        id: 'terminal-reset',
        label: 'Reset terminal',
        onSelect: () => terminalActions?.reset(),
        disabled: !terminalActions,
      },
      { type: 'separator', id: 'terminal-replace-sep' },
      { type: 'item', id: 'replace-pane', label: 'Replace pane', onSelect: () => actions.replacePane(target.tabId, target.paneId) },
    ]
  }

  if (target.kind === 'browser') {
    const browserActions = actions.getBrowserActions(target.paneId)
    return [
      { type: 'item', id: 'browser-back', label: 'Back', onSelect: () => browserActions?.back(), disabled: !browserActions },
      { type: 'item', id: 'browser-forward', label: 'Forward', onSelect: () => browserActions?.forward(), disabled: !browserActions },
      { type: 'item', id: 'browser-refresh', label: 'Reload/Stop', onSelect: () => browserActions?.reload(), disabled: !browserActions },
      { type: 'separator', id: 'browser-sep' },
      { type: 'item', id: 'browser-copy-url', label: 'Copy URL', onSelect: () => browserActions?.copyUrl(), disabled: !browserActions },
      { type: 'item', id: 'browser-open', label: 'Open in external browser', onSelect: () => browserActions?.openExternal(), disabled: !browserActions },
      { type: 'item', id: 'browser-devtools', label: 'Toggle devtools', onSelect: () => browserActions?.toggleDevTools(), disabled: !browserActions },
      { type: 'separator', id: 'browser-replace-sep' },
      { type: 'item', id: 'replace-pane', label: 'Replace pane', onSelect: () => actions.replacePane(target.tabId, target.paneId) },
    ]
  }

  if (target.kind === 'editor') {
    const editorActions = actions.getEditorActions(target.paneId)
    const paneContent = paneLayouts[target.tabId]
      ? findPaneContent(paneLayouts[target.tabId], target.paneId)
      : null
    const readOnly = !!(paneContent && paneContent.kind === 'editor' && paneContent.readOnly)

    return [
      { type: 'item', id: 'editor-cut', label: 'Cut', onSelect: () => editorActions?.cut(), disabled: !editorActions || readOnly },
      { type: 'item', id: 'editor-copy', label: 'Copy', onSelect: () => editorActions?.copy(), disabled: !editorActions },
      { type: 'item', id: 'editor-paste', label: 'Paste', onSelect: () => editorActions?.paste(), disabled: !editorActions || readOnly },
      { type: 'item', id: 'editor-select-all', label: 'Select all', onSelect: () => editorActions?.selectAll(), disabled: !editorActions },
      { type: 'separator', id: 'editor-sep' },
      { type: 'item', id: 'editor-open', label: 'Open with system viewer', onSelect: () => editorActions?.openWithSystemViewer(), disabled: !editorActions },
      { type: 'item', id: 'editor-save', label: 'Save now', onSelect: () => editorActions?.saveNow(), disabled: !editorActions || readOnly },
      { type: 'item', id: 'editor-toggle-preview', label: 'Toggle preview/source', onSelect: () => editorActions?.togglePreview(), disabled: !editorActions },
      { type: 'item', id: 'editor-copy-path', label: 'Copy file path', onSelect: () => editorActions?.copyPath(), disabled: !editorActions },
      { type: 'item', id: 'editor-reveal', label: 'Reveal in file explorer', onSelect: () => editorActions?.revealInExplorer(), disabled: !editorActions },
      { type: 'separator', id: 'editor-replace-sep' },
      { type: 'item', id: 'replace-pane', label: 'Replace pane', onSelect: () => actions.replacePane(target.tabId, target.paneId) },
    ]
  }

  if (target.kind === 'pane-picker') {
    const layout = paneLayouts[target.tabId]
    const isOnlyPane = layout?.type === 'leaf' && layout.id === target.paneId
    return [
      {
        type: 'item',
        id: 'pane-picker-close',
        label: 'Close pane',
        onSelect: () => actions.closePane(target.tabId, target.paneId),
        disabled: isOnlyPane,
      },
    ]
  }

  if (target.kind === 'sidebar-session') {
    const sessionInfo = getSessionById(sessions, target.sessionId, target.provider)
    const archived = sessionInfo?.session.archived ?? false
    const isRunning = !!target.runningTerminalId
    const provider = target.provider || 'claude'
    const resumeCandidate = isResumeCommandProvider(provider)
      ? {
          provider,
          sessionId: target.sessionId,
        }
      : null
    const sidebarResumeMenuItem = resumeCandidate
      ? [buildCopyResumeMenuItem('session-copy-resume-command', resumeCandidate, actions)]
      : []

    return [
      { type: 'item', id: 'session-open-new', label: 'Open in new tab', onSelect: () => actions.openSessionInNewTab(target.sessionId, target.provider) },
      { type: 'item', id: 'session-open-this', label: 'Open in this tab', onSelect: () => actions.openSessionInThisTab(target.sessionId, target.provider) },
      { type: 'item', id: 'session-rename', label: 'Rename', onSelect: () => actions.renameSession(target.sessionId, target.provider) },
      {
        type: 'item',
        id: 'session-archive',
        label: archived ? 'Unarchive' : 'Archive',
        onSelect: () => actions.toggleArchiveSession(target.sessionId, target.provider, !archived),
      },
      {
        type: 'item',
        id: 'session-delete',
        label: 'Delete',
        onSelect: () => actions.deleteSession(target.sessionId, target.provider),
        danger: true,
        disabled: isRunning,
      },
      { type: 'separator', id: 'session-sep' },
      ...sidebarResumeMenuItem,
      { type: 'item', id: 'session-copy-id', label: 'Copy session ID', onSelect: () => actions.copySessionId(target.sessionId) },
      { type: 'item', id: 'session-copy-cwd', label: 'Copy CWD', onSelect: () => actions.copySessionCwd(target.sessionId, target.provider) },
      { type: 'item', id: 'session-copy-meta', label: 'Copy full metadata', onSelect: () => actions.copySessionMetadata(target.sessionId, target.provider) },
    ]
  }

  if (target.kind === 'history-project') {
    const expanded = expandedProjects.has(target.projectPath)
    return [
      {
        type: 'item',
        id: 'history-project-toggle',
        label: expanded ? 'Collapse project' : 'Expand project',
        onSelect: () => actions.toggleProjectExpanded(target.projectPath, !expanded),
      },
      { type: 'item', id: 'history-project-color', label: 'Set project color', onSelect: () => actions.setProjectColor(target.projectPath) },
      { type: 'item', id: 'history-project-copy', label: 'Copy project path', onSelect: () => actions.copyProjectPath(target.projectPath) },
      { type: 'separator', id: 'history-project-sep' },
      { type: 'item', id: 'history-project-open-all', label: 'Open all sessions in tabs', onSelect: () => actions.openAllSessionsInProject(target.projectPath) },
    ]
  }

  if (target.kind === 'history-session') {
    const sessionInfo = getSessionById(sessions, target.sessionId, target.provider)
    const hasSummary = !!sessionInfo?.session.summary
    const isOpen = isSessionOpen(target.sessionId, target.provider)
    return [
      { type: 'item', id: 'history-session-open', label: 'Open session', onSelect: () => actions.openSessionInNewTab(target.sessionId, target.provider) },
      { type: 'item', id: 'history-session-rename', label: 'Rename', onSelect: () => actions.renameSession(target.sessionId, target.provider, true) },
      { type: 'item', id: 'history-session-delete', label: 'Delete session', onSelect: () => actions.deleteSession(target.sessionId, target.provider), danger: true, disabled: isOpen },
      { type: 'separator', id: 'history-session-sep' },
      { type: 'item', id: 'history-session-copy-id', label: 'Copy session ID', onSelect: () => actions.copySessionId(target.sessionId) },
      { type: 'item', id: 'history-session-copy-summary', label: 'Copy summary', onSelect: () => actions.copySessionSummary(target.sessionId, target.provider), disabled: !hasSummary },
      { type: 'item', id: 'history-session-copy-cwd', label: 'Copy CWD', onSelect: () => actions.copySessionCwd(target.sessionId, target.provider) },
    ]
  }

  if (target.kind === 'overview-terminal') {
    return [
      { type: 'item', id: 'overview-open', label: 'Open/focus terminal', onSelect: () => actions.openTerminal(target.terminalId) },
      { type: 'item', id: 'overview-rename', label: 'Rename', onSelect: () => actions.renameTerminal(target.terminalId) },
      { type: 'item', id: 'overview-summary', label: 'Generate summary', onSelect: () => actions.generateTerminalSummary(target.terminalId) },
      { type: 'item', id: 'overview-delete', label: 'Delete terminal', onSelect: () => actions.deleteTerminal(target.terminalId), danger: true },
      { type: 'separator', id: 'overview-sep' },
      { type: 'item', id: 'overview-copy-cwd', label: 'Copy CWD', onSelect: () => actions.copyTerminalCwd(target.terminalId) },
    ]
  }

  if (target.kind === 'claude-message') {
    const hasCode = contextElement?.querySelector('pre code')
    return [
      { type: 'item', id: 'claude-copy-text', label: 'Copy message text', onSelect: () => actions.copyMessageText(contextElement) },
      { type: 'item', id: 'claude-copy-code', label: 'Copy code block', onSelect: () => actions.copyMessageCode(contextElement), disabled: !hasCode },
      { type: 'separator', id: 'claude-sep' },
      { type: 'item', id: 'claude-copy-session', label: 'Copy session ID', onSelect: () => actions.copySessionId(target.sessionId) },
      { type: 'item', id: 'claude-open-session', label: 'Open session in new tab', onSelect: () => actions.openSessionInNewTab(target.sessionId, target.provider) },
    ]
  }

  if (target.kind === 'freshclaude-chat') {
    const selection = window.getSelection()
    const hasSelection = !!(selection && selection.toString().trim())

    // Detect sub-region from click target using closest()
    const codeBlock = clickTarget?.closest?.('.prose pre code') as HTMLElement | null
    const toolInput = clickTarget?.closest?.('[data-tool-input]') as HTMLElement | null
    const toolOutput = clickTarget?.closest?.('[data-tool-output]') as HTMLElement | null
    const diffView = clickTarget?.closest?.('[data-diff]') as HTMLElement | null

    const items: MenuItem[] = [
      {
        type: 'item',
        id: 'fc-copy',
        label: 'Copy',
        onSelect: () => {
          if (hasSelection) document.execCommand('copy')
        },
        disabled: !hasSelection,
      },
      {
        type: 'item',
        id: 'fc-select-all',
        label: 'Select all',
        onSelect: () => {
          if (contextElement) {
            const range = document.createRange()
            range.selectNodeContents(contextElement)
            const sel = window.getSelection()
            sel?.removeAllRanges()
            sel?.addRange(range)
          }
        },
      },
    ]

    // Context-sensitive items
    if (codeBlock) {
      items.push(
        { type: 'separator', id: 'fc-code-sep' },
        {
          type: 'item',
          id: 'fc-copy-code-block',
          label: 'Copy code block',
          onSelect: () => actions.copyFreshclaudeCodeBlock(codeBlock),
        },
      )
    }

    if (toolInput) {
      const toolName = toolInput.getAttribute('data-tool-name')
      const isBash = toolName === 'Bash'
      items.push(
        { type: 'separator', id: 'fc-tool-input-sep' },
        {
          type: 'item',
          id: isBash ? 'fc-copy-command' : 'fc-copy-input',
          label: isBash ? 'Copy command' : 'Copy input',
          onSelect: () => actions.copyFreshclaudeToolInput(toolInput),
        },
      )
    }

    if (toolOutput) {
      // Don't add separator if we just added one for toolInput
      if (!toolInput) items.push({ type: 'separator', id: 'fc-tool-output-sep' })
      items.push({
        type: 'item',
        id: 'fc-copy-output',
        label: 'Copy output',
        onSelect: () => actions.copyFreshclaudeToolOutput(toolOutput),
      })
    }

    if (diffView) {
      const filePath = diffView.getAttribute('data-file-path')
      items.push(
        { type: 'separator', id: 'fc-diff-sep' },
        {
          type: 'item',
          id: 'fc-copy-new-version',
          label: 'Copy new version',
          onSelect: () => actions.copyFreshclaudeDiffNew(diffView),
        },
        {
          type: 'item',
          id: 'fc-copy-old-version',
          label: 'Copy old version',
          onSelect: () => actions.copyFreshclaudeDiffOld(diffView),
        },
      )
      if (filePath) {
        items.push({
          type: 'item',
          id: 'fc-copy-file-path',
          label: 'Copy file path',
          onSelect: () => actions.copyFreshclaudeFilePath(diffView),
        })
      }
    }

    // Session metadata at the bottom
    items.push(
      { type: 'separator', id: 'fc-session-sep' },
      { type: 'item', id: 'fc-copy-session', label: 'Copy session ID', onSelect: () => actions.copySessionId(target.sessionId) },
    )

    return items
  }

  return []
}
