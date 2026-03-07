import { describe, it, expect, vi } from 'vitest'
import { buildMenuItems, type MenuActions, type MenuBuildContext } from '../../../../src/components/context-menu/menu-defs'
import type { ContextTarget } from '../../../../src/components/context-menu/context-menu-types'

function createActions(): MenuActions {
  return {
    newDefaultTab: vi.fn(),
    newTabWithPane: vi.fn(),
    copyTabNames: vi.fn(),
    toggleSidebar: vi.fn(),
    copyShareLink: vi.fn(),
    openView: vi.fn(),
    copyTabName: vi.fn(),
    refreshTab: vi.fn(),
    renameTab: vi.fn(),
    closeTab: vi.fn(),
    closeOtherTabs: vi.fn(),
    closeTabsToRight: vi.fn(),
    moveTab: vi.fn(),
    renamePane: vi.fn(),
    refreshPane: vi.fn(),
    replacePane: vi.fn(),
    splitPane: vi.fn(),
    resetSplit: vi.fn(),
    swapSplit: vi.fn(),
    closePane: vi.fn(),
    getTerminalActions: vi.fn(() => ({
      copySelection: vi.fn(),
      paste: vi.fn(),
      selectAll: vi.fn(),
      clearScrollback: vi.fn(),
      reset: vi.fn(),
      scrollToBottom: vi.fn(),
      hasSelection: vi.fn(() => false),
      openSearch: vi.fn(),
    })),
    getEditorActions: vi.fn(() => ({
      cut: vi.fn(),
      copy: vi.fn(),
      paste: vi.fn(),
      selectAll: vi.fn(),
      openInEditor: vi.fn(),
      saveNow: vi.fn(),
      togglePreview: vi.fn(),
      copyPath: vi.fn(),
      revealInExplorer: vi.fn(),
    })),
    getBrowserActions: vi.fn(() => ({
      back: vi.fn(),
      forward: vi.fn(),
      reload: vi.fn(),
      copyUrl: vi.fn(),
      openExternal: vi.fn(),
      toggleDevTools: vi.fn(),
    })),
    openSessionInNewTab: vi.fn(),
    openSessionInThisTab: vi.fn(),
    renameSession: vi.fn(),
    toggleArchiveSession: vi.fn(),
    deleteSession: vi.fn(),
    copySessionId: vi.fn(),
    copySessionCwd: vi.fn(),
    copySessionSummary: vi.fn(),
    copySessionMetadata: vi.fn(),
    copyResumeCommand: vi.fn(),
    setProjectColor: vi.fn(),
    toggleProjectExpanded: vi.fn(),
    openAllSessionsInProject: vi.fn(),
    copyProjectPath: vi.fn(),
    openTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    generateTerminalSummary: vi.fn(),
    deleteTerminal: vi.fn(),
    copyTerminalCwd: vi.fn(),
    copyMessageText: vi.fn(),
    copyMessageCode: vi.fn(),
    copyFreshclaudeCodeBlock: vi.fn(),
    copyFreshclaudeToolInput: vi.fn(),
    copyFreshclaudeToolOutput: vi.fn(),
    copyFreshclaudeDiffNew: vi.fn(),
    copyFreshclaudeDiffOld: vi.fn(),
    copyFreshclaudeFilePath: vi.fn(),
  }
}

function makeCtx(actions: MenuActions, overrides?: Partial<MenuBuildContext>): MenuBuildContext {
  return {
    view: 'terminal',
    sidebarCollapsed: false,
    tabs: [{ id: 'tab-1', title: 'Tab', mode: 'shell' }] as any,
    paneLayouts: {
      'tab-1': {
        type: 'leaf',
        id: 'pane-1',
        content: { kind: 'terminal', createRequestId: 'req-1', status: 'running', mode: 'shell' },
      },
    },
    sessions: [],
    expandedProjects: new Set<string>(),
    contextElement: null,
    clickTarget: null,
    actions,
    platform: 'linux',
    ...overrides,
  }
}

describe('context menu global view labels', () => {
  it('includes renamed views and new tabs view in global menu', () => {
    const items = buildMenuItems(
      { kind: 'global' },
      makeCtx(createActions(), {
        tabs: [],
        paneLayouts: {},
      }),
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

describe('buildMenuItems - refresh items', () => {
  it('enables Refresh tab only when the stored layout has at least one refresh-capable leaf', () => {
    const actions = createActions()
    const items = buildMenuItems(
      { kind: 'tab', tabId: 'tab-1' },
      makeCtx(actions, {
        paneLayouts: {
          'tab-1': {
            type: 'split',
            id: 'split-1',
            direction: 'horizontal',
            sizes: [50, 50],
            children: [
              {
                type: 'leaf',
                id: 'pane-live-browser',
                content: {
                  kind: 'browser',
                  browserInstanceId: 'browser-1',
                  url: 'https://example.com',
                  devToolsOpen: false,
                },
              },
              {
                type: 'leaf',
                id: 'pane-blank-browser',
                content: {
                  kind: 'browser',
                  browserInstanceId: 'browser-2',
                  url: '',
                  devToolsOpen: false,
                },
              },
            ],
          },
        },
      }),
    )

    const refreshItem = items.find((item) => item.type === 'item' && item.id === 'refresh-tab')
    expect(refreshItem?.type).toBe('item')
    expect(refreshItem?.type === 'item' ? refreshItem.disabled : true).toBe(false)
  })

  it('disables Refresh pane for blank browser panes and unattached terminal panes', () => {
    const blankBrowserItems = buildMenuItems(
      { kind: 'browser', tabId: 'tab-1', paneId: 'pane-1' },
      makeCtx(createActions(), {
        paneLayouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'browser',
              browserInstanceId: 'browser-1',
              url: '',
              devToolsOpen: false,
            },
          },
        },
      }),
    )
    const blankBrowserRefresh = blankBrowserItems.find((item) => item.type === 'item' && item.id === 'refresh-pane')
    expect(blankBrowserRefresh?.type === 'item' ? blankBrowserRefresh.disabled : false).toBe(true)

    const unattachedTerminalItems = buildMenuItems(
      { kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1' },
      makeCtx(createActions(), {
        paneLayouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'shell',
              createRequestId: 'req-1',
              status: 'running',
            },
          },
        },
      }),
    )
    const unattachedTerminalRefresh = unattachedTerminalItems.find((item) => item.type === 'item' && item.id === 'refresh-pane')
    expect(unattachedTerminalRefresh?.type === 'item' ? unattachedTerminalRefresh.disabled : false).toBe(true)
  })

  it('includes Refresh pane on pane, terminal, and browser menus', () => {
    for (const target of [
      { kind: 'pane', tabId: 'tab-1', paneId: 'pane-1' } as const,
      { kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1' } as const,
      { kind: 'browser', tabId: 'tab-1', paneId: 'pane-2' } as const,
    ]) {
      const items = buildMenuItems(target, makeCtx(createActions(), {
        paneLayouts: {
          'tab-1': {
            type: 'split',
            id: 'split-1',
            direction: 'horizontal',
            sizes: [50, 50],
            children: [
              {
                type: 'leaf',
                id: 'pane-1',
                content: {
                  kind: 'terminal',
                  mode: 'shell',
                  createRequestId: 'req-1',
                  terminalId: 'term-1',
                  status: 'running',
                },
              },
              {
                type: 'leaf',
                id: 'pane-2',
                content: {
                  kind: 'browser',
                  browserInstanceId: 'browser-2',
                  url: 'https://example.com',
                  devToolsOpen: false,
                },
              },
            ],
          },
        },
      }))

      expect(items.find((item) => item.type === 'item' && item.id === 'refresh-pane')).toBeDefined()
    }
  })
})

describe('buildMenuItems - "Replace pane" item', () => {
  it('includes "Replace pane" for target.kind === "pane"', () => {
    const actions = createActions()
    const target: ContextTarget = { kind: 'pane', tabId: 'tab-1', paneId: 'pane-1' }
    const items = buildMenuItems(target, makeCtx(actions))

    const replaceItem = items.find((item) => item.type === 'item' && item.id === 'replace-pane')
    expect(replaceItem).toBeDefined()
    if (replaceItem?.type === 'item') {
      expect(replaceItem.label).toBe('Replace pane')
    }
  })

  it('"Replace pane" appears after "Rename pane" in pane menu', () => {
    const actions = createActions()
    const target: ContextTarget = { kind: 'pane', tabId: 'tab-1', paneId: 'pane-1' }
    const items = buildMenuItems(target, makeCtx(actions))

    const renameIndex = items.findIndex((item) => item.type === 'item' && item.id === 'rename-pane')
    const replaceIndex = items.findIndex((item) => item.type === 'item' && item.id === 'replace-pane')
    expect(renameIndex).toBeGreaterThanOrEqual(0)
    expect(replaceIndex).toBeGreaterThan(renameIndex)
  })

  it('includes "Replace pane" for terminal/browser/editor menus', () => {
    const actions = createActions()
    const terminalItems = buildMenuItems(
      { kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1' },
      makeCtx(actions),
    )
    const browserItems = buildMenuItems(
      { kind: 'browser', tabId: 'tab-1', paneId: 'pane-1' },
      makeCtx(actions),
    )
    const editorItems = buildMenuItems(
      { kind: 'editor', tabId: 'tab-1', paneId: 'pane-1' },
      makeCtx(actions, {
        paneLayouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'editor',
              filePath: '/test.ts',
              language: 'typescript',
              readOnly: false,
              content: '',
              viewMode: 'source' as const,
            },
          },
        },
      }),
    )

    for (const items of [terminalItems, browserItems, editorItems]) {
      const replaceItem = items.find((item) => item.type === 'item' && item.id === 'replace-pane')
      expect(replaceItem).toBeDefined()
      if (replaceItem?.type === 'item') {
        expect(replaceItem.label).toBe('Replace pane')
      }
    }
  })

  it('calls actions.replacePane when selected', () => {
    const actions = createActions()
    const target: ContextTarget = { kind: 'pane', tabId: 'tab-1', paneId: 'pane-1' }
    const items = buildMenuItems(target, makeCtx(actions))

    const replaceItem = items.find((item) => item.type === 'item' && item.id === 'replace-pane')
    expect(replaceItem).toBeDefined()
    if (replaceItem?.type === 'item') {
      replaceItem.onSelect()
      expect(actions.replacePane).toHaveBeenCalledWith('tab-1', 'pane-1')
    }
  })
})

describe('buildMenuItems - terminal "Search" item', () => {
  it('includes "Search" item in terminal context menu', () => {
    const actions = createActions()
    const target: ContextTarget = { kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1' }
    const items = buildMenuItems(target, makeCtx(actions))

    const searchItem = items.find((item) => item.type === 'item' && item.id === 'terminal-search')
    expect(searchItem).toBeDefined()
    if (searchItem?.type === 'item') {
      expect(searchItem.label).toBe('Search')
    }
  })

  it('"Search" appears after "Select all" in terminal menu', () => {
    const actions = createActions()
    const target: ContextTarget = { kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1' }
    const items = buildMenuItems(target, makeCtx(actions))

    const selectAllIndex = items.findIndex((item) => item.type === 'item' && item.id === 'terminal-select-all')
    const searchIndex = items.findIndex((item) => item.type === 'item' && item.id === 'terminal-search')
    expect(selectAllIndex).toBeGreaterThanOrEqual(0)
    expect(searchIndex).toBeGreaterThan(selectAllIndex)
  })

  it('calls terminalActions.openSearch when selected', () => {
    const actions = createActions()
    const target: ContextTarget = { kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1' }
    const items = buildMenuItems(target, makeCtx(actions))

    const terminalActions = (actions.getTerminalActions as ReturnType<typeof vi.fn>).mock.results[0]?.value
    const searchItem = items.find((item) => item.type === 'item' && item.id === 'terminal-search')
    expect(searchItem).toBeDefined()
    if (searchItem?.type === 'item') {
      searchItem.onSelect()
      expect(terminalActions?.openSearch).toHaveBeenCalled()
    }
  })
})
