import { describe, it, expect, vi } from 'vitest'
import { buildMenuItems, type MenuActions, type MenuBuildContext } from '@/components/context-menu/menu-defs'
import type { ContextTarget } from '@/components/context-menu/context-menu-types'

function createMockActions(): MenuActions {
  return {
    newDefaultTab: vi.fn(),
    newTabWithPane: vi.fn(),
    copyTabNames: vi.fn(),
    toggleSidebar: vi.fn(),
    copyShareLink: vi.fn(),
    openView: vi.fn(),
    copyTabName: vi.fn(),
    renameTab: vi.fn(),
    closeTab: vi.fn(),
    closeOtherTabs: vi.fn(),
    closeTabsToRight: vi.fn(),
    moveTab: vi.fn(),
    renamePane: vi.fn(),
    splitPane: vi.fn(),
    resetSplit: vi.fn(),
    swapSplit: vi.fn(),
    closePane: vi.fn(),
    getTerminalActions: vi.fn(),
    getEditorActions: vi.fn(),
    getBrowserActions: vi.fn(),
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
  }
}

function createMockContext(actions: MenuActions): MenuBuildContext {
  return {
    view: 'terminal',
    sidebarCollapsed: false,
    tabs: [
      {
        id: 'tab1',
        createRequestId: 'tab1',
        title: 'Tab 1',
        status: 'running',
        mode: 'shell',
        shell: 'system',
        createdAt: 1,
      },
    ],
    paneLayouts: {
      tab1: {
        type: 'leaf',
        id: 'pane1',
        content: { kind: 'terminal', mode: 'shell', status: 'running' },
      },
    },
    sessions: [],
    expandedProjects: new Set<string>(),
    contextElement: null,
    actions,
    platform: null,
  }
}

describe('buildMenuItems — pane context menu', () => {
  it('pane context menu includes split right and split down', () => {
    const mockActions = createMockActions()
    const mockContext = createMockContext(mockActions)
    const target: ContextTarget = { kind: 'pane', tabId: 'tab1', paneId: 'pane1' }
    const items = buildMenuItems(target, mockContext)
    const ids = items.filter(i => i.type === 'item').map(i => i.id)
    expect(ids).toContain('split-right')
    expect(ids).toContain('split-down')
  })

  it('split right calls splitPane with horizontal direction', () => {
    const mockActions = createMockActions()
    const mockContext = createMockContext(mockActions)
    const target: ContextTarget = { kind: 'pane', tabId: 'tab1', paneId: 'pane1' }
    const items = buildMenuItems(target, mockContext)
    const splitRight = items.find(i => i.type === 'item' && i.id === 'split-right')
    expect(splitRight).toBeDefined()
    if (splitRight?.type === 'item') splitRight.onSelect()
    expect(mockActions.splitPane).toHaveBeenCalledWith('tab1', 'pane1', 'horizontal')
  })

  it('split down calls splitPane with vertical direction', () => {
    const mockActions = createMockActions()
    const mockContext = createMockContext(mockActions)
    const target: ContextTarget = { kind: 'pane', tabId: 'tab1', paneId: 'pane1' }
    const items = buildMenuItems(target, mockContext)
    const splitDown = items.find(i => i.type === 'item' && i.id === 'split-down')
    expect(splitDown).toBeDefined()
    if (splitDown?.type === 'item') splitDown.onSelect()
    expect(mockActions.splitPane).toHaveBeenCalledWith('tab1', 'pane1', 'vertical')
  })

  it('split items appear before rename', () => {
    const mockActions = createMockActions()
    const mockContext = createMockContext(mockActions)
    const target: ContextTarget = { kind: 'pane', tabId: 'tab1', paneId: 'pane1' }
    const items = buildMenuItems(target, mockContext)
    const actionItems = items.filter(i => i.type === 'item')
    const splitRightIdx = actionItems.findIndex(i => i.id === 'split-right')
    const renameIdx = actionItems.findIndex(i => i.id === 'rename-pane')
    expect(splitRightIdx).toBeLessThan(renameIdx)
  })

  it('split items are separated from rename by a separator', () => {
    const mockActions = createMockActions()
    const mockContext = createMockContext(mockActions)
    const target: ContextTarget = { kind: 'pane', tabId: 'tab1', paneId: 'pane1' }
    const items = buildMenuItems(target, mockContext)
    const splitDownIdx = items.findIndex(i => i.type === 'item' && i.id === 'split-down')
    const separatorAfterSplit = items[splitDownIdx + 1]
    expect(separatorAfterSplit?.type).toBe('separator')
  })
})
