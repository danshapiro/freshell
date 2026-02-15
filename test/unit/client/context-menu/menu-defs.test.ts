import { describe, it, expect, vi } from 'vitest'
import { buildMenuItems } from '../../../../src/components/context-menu/menu-defs'

const noop = vi.fn()

function createActions() {
  return {
    newDefaultTab: noop,
    newTabWithPane: noop,
    copyTabNames: noop,
    toggleSidebar: noop,
    copyShareLink: noop,
    openView: noop,
    copyTabName: noop,
    renameTab: noop,
    closeTab: noop,
    closeOtherTabs: noop,
    closeTabsToRight: noop,
    moveTab: noop,
    renamePane: noop,
    replacePane: noop,
    splitPane: noop,
    resetSplit: noop,
    swapSplit: noop,
    closePane: noop,
    getTerminalActions: () => undefined,
    getEditorActions: () => undefined,
    getBrowserActions: () => undefined,
    openSessionInNewTab: noop,
    openSessionInThisTab: noop,
    renameSession: noop,
    toggleArchiveSession: noop,
    deleteSession: noop,
    copySessionId: noop,
    copySessionCwd: noop,
    copySessionSummary: noop,
    copySessionMetadata: noop,
    copyResumeCommand: noop,
    setProjectColor: noop,
    toggleProjectExpanded: noop,
    openAllSessionsInProject: noop,
    copyProjectPath: noop,
    openTerminal: noop,
    renameTerminal: noop,
    generateTerminalSummary: noop,
    deleteTerminal: noop,
    copyTerminalCwd: noop,
    copyMessageText: noop,
    copyMessageCode: noop,
    copyFreshclaudeCodeBlock: noop,
    copyFreshclaudeToolInput: noop,
    copyFreshclaudeToolOutput: noop,
    copyFreshclaudeDiffNew: noop,
    copyFreshclaudeDiffOld: noop,
    copyFreshclaudeFilePath: noop,
  }
}

describe('context menu global view labels', () => {
  it('includes renamed views and new tabs view in global menu', () => {
    const items = buildMenuItems(
      { kind: 'global' },
      {
        view: 'terminal',
        sidebarCollapsed: false,
        tabs: [],
        paneLayouts: {},
        sessions: [],
        expandedProjects: new Set(),
        contextElement: null,
        clickTarget: null,
        actions: createActions(),
        platform: null,
      },
    )

    const labels = items
      .filter((item) => item.type === 'item' && item.id.startsWith('open-'))
      .map((item) => item.label)
    expect(labels).toEqual([
      'Open Tabs',
      'Open Panes',
      'Open Projects',
      'Open Settings',
    ])
  })
})
