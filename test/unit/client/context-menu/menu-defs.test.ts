import { describe, it, expect, vi } from 'vitest'
import { buildMenuItems, type MenuActions, type MenuBuildContext } from '../../../../src/components/context-menu/menu-defs'
import type { ContextTarget } from '../../../../src/components/context-menu/context-menu-types'

function stubActions(): MenuActions {
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
    replacePane: vi.fn(),
    resetSplit: vi.fn(),
    swapSplit: vi.fn(),
    closePane: vi.fn(),
    getTerminalActions: vi.fn(() => ({
      copySelection: vi.fn(),
      paste: vi.fn(),
      selectAll: vi.fn(),
      clearScrollback: vi.fn(),
      reset: vi.fn(),
      hasSelection: vi.fn(() => false),
      openSearch: vi.fn(),
    })),
    getEditorActions: vi.fn(() => ({
      cut: vi.fn(),
      copy: vi.fn(),
      paste: vi.fn(),
      selectAll: vi.fn(),
      openWithSystemViewer: vi.fn(),
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
    actions,
    platform: 'linux',
    ...overrides,
  }
}

describe('buildMenuItems - "Replace pane" item', () => {
  it('includes "Replace pane" for target.kind === "pane"', () => {
    const actions = stubActions()
    const target: ContextTarget = { kind: 'pane', tabId: 'tab-1', paneId: 'pane-1' }
    const items = buildMenuItems(target, makeCtx(actions))

    const replaceItem = items.find((i) => i.type === 'item' && i.id === 'replace-pane')
    expect(replaceItem).toBeDefined()
    expect(replaceItem!.type).toBe('item')
    if (replaceItem!.type === 'item') {
      expect(replaceItem!.label).toBe('Replace pane')
    }
  })

  it('"Replace pane" appears after "Rename pane" in pane menu', () => {
    const actions = stubActions()
    const target: ContextTarget = { kind: 'pane', tabId: 'tab-1', paneId: 'pane-1' }
    const items = buildMenuItems(target, makeCtx(actions))

    const renameIdx = items.findIndex((i) => i.type === 'item' && i.id === 'rename-pane')
    const replaceIdx = items.findIndex((i) => i.type === 'item' && i.id === 'replace-pane')
    expect(renameIdx).toBeGreaterThanOrEqual(0)
    expect(replaceIdx).toBeGreaterThan(renameIdx)
  })

  it('includes "Replace pane" for target.kind === "terminal"', () => {
    const actions = stubActions()
    const target: ContextTarget = { kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1' }
    const items = buildMenuItems(target, makeCtx(actions))

    const replaceItem = items.find((i) => i.type === 'item' && i.id === 'replace-pane')
    expect(replaceItem).toBeDefined()
    if (replaceItem!.type === 'item') {
      expect(replaceItem!.label).toBe('Replace pane')
    }
  })

  it('includes "Replace pane" for target.kind === "browser"', () => {
    const actions = stubActions()
    const target: ContextTarget = { kind: 'browser', tabId: 'tab-1', paneId: 'pane-1' }
    const items = buildMenuItems(target, makeCtx(actions))

    const replaceItem = items.find((i) => i.type === 'item' && i.id === 'replace-pane')
    expect(replaceItem).toBeDefined()
    if (replaceItem!.type === 'item') {
      expect(replaceItem!.label).toBe('Replace pane')
    }
  })

  it('includes "Replace pane" for target.kind === "editor"', () => {
    const actions = stubActions()
    const target: ContextTarget = { kind: 'editor', tabId: 'tab-1', paneId: 'pane-1' }
    const ctx = makeCtx(actions, {
      paneLayouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: { kind: 'editor', filePath: '/test.ts', language: 'typescript', readOnly: false, content: '', viewMode: 'source' as const },
        },
      },
    })
    const items = buildMenuItems(target, ctx)

    const replaceItem = items.find((i) => i.type === 'item' && i.id === 'replace-pane')
    expect(replaceItem).toBeDefined()
    if (replaceItem!.type === 'item') {
      expect(replaceItem!.label).toBe('Replace pane')
    }
  })

  it('calls actions.replacePane when selected', () => {
    const actions = stubActions()
    const target: ContextTarget = { kind: 'pane', tabId: 'tab-1', paneId: 'pane-1' }
    const items = buildMenuItems(target, makeCtx(actions))

    const replaceItem = items.find((i) => i.type === 'item' && i.id === 'replace-pane')
    expect(replaceItem).toBeDefined()
    if (replaceItem!.type === 'item') {
      replaceItem!.onSelect()
      expect(actions.replacePane).toHaveBeenCalledWith('tab-1', 'pane-1')
    }
  })
})

describe('buildMenuItems - terminal "Search" item', () => {
  it('includes "Search" item in terminal context menu', () => {
    const actions = stubActions()
    const target: ContextTarget = { kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1' }
    const items = buildMenuItems(target, makeCtx(actions))

    const searchItem = items.find((i) => i.type === 'item' && i.id === 'terminal-search')
    expect(searchItem).toBeDefined()
    expect(searchItem!.type).toBe('item')
    if (searchItem!.type === 'item') {
      expect(searchItem!.label).toBe('Search')
    }
  })

  it('"Search" appears after "Select all" in terminal menu', () => {
    const actions = stubActions()
    const target: ContextTarget = { kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1' }
    const items = buildMenuItems(target, makeCtx(actions))

    const selectAllIdx = items.findIndex((i) => i.type === 'item' && i.id === 'terminal-select-all')
    const searchIdx = items.findIndex((i) => i.type === 'item' && i.id === 'terminal-search')
    expect(selectAllIdx).toBeGreaterThanOrEqual(0)
    expect(searchIdx).toBeGreaterThan(selectAllIdx)
  })

  it('calls terminalActions.openSearch when selected', () => {
    const actions = stubActions()
    const target: ContextTarget = { kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1' }
    const items = buildMenuItems(target, makeCtx(actions))

    // buildMenuItems already called getTerminalActions once; grab that return value
    const terminalActions = (actions.getTerminalActions as ReturnType<typeof vi.fn>).mock.results[0].value

    const searchItem = items.find((i) => i.type === 'item' && i.id === 'terminal-search')
    expect(searchItem).toBeDefined()
    if (searchItem!.type === 'item') {
      searchItem!.onSelect()
      expect(terminalActions!.openSearch).toHaveBeenCalled()
    }
  })
})
