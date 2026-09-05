import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildMenuItems, type MenuActions, type MenuBuildContext } from '@/components/context-menu/menu-defs'
import type { ContextTarget } from '@/components/context-menu/context-menu-types'
import { registerFreshAgentPaneActions, type FreshAgentPaneActions } from '@/lib/pane-action-registry'
import type { RegistryTabRecord } from '@/store/tabRegistryTypes'
import type { TabsRegistryGroups } from '@/lib/tab-registry-open'

function makeRegistryRecord(overrides: Partial<RegistryTabRecord> = {}): RegistryTabRecord {
  return {
    tabKey: 'device-a:tab-9',
    tabId: 'tab-9',
    serverInstanceId: 'srv-1',
    deviceId: 'device-a',
    deviceLabel: 'Device A',
    tabName: 'My Tab',
    status: 'open',
    revision: 1,
    createdAt: 1,
    updatedAt: 2,
    paneCount: 1,
    titleSetByUser: false,
    panes: [],
    ...overrides,
  }
}

function makeRegistryGroups(overrides: Partial<TabsRegistryGroups> = {}): TabsRegistryGroups {
  return { localOpen: [], sameDeviceOpen: [], remoteOpen: [], closed: [], ...overrides }
}

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
    copyFreshAgentCodeBlock: vi.fn(),
    copyFreshAgentToolInput: vi.fn(),
    copyFreshAgentToolOutput: vi.fn(),
    copyFreshAgentDiffNew: vi.fn(),
    copyFreshAgentDiffOld: vi.fn(),
    copyFreshAgentFilePath: vi.fn(),
    refreshTab: vi.fn(),
    refreshPane: vi.fn(),
    replacePane: vi.fn(),
    reopenClosedTab: vi.fn(),
    generateSessionTitle: vi.fn(),
    showKeyboardShortcuts: vi.fn(),
    openUrlInPane: vi.fn(),
    openUrlInTab: vi.fn(),
    openUrlInBrowser: vi.fn(),
    copyUrl: vi.fn(),
    jumpToTabRecord: vi.fn(),
    openTabRecordCopy: vi.fn(),
    openTabRecordPaneInNewTab: vi.fn(),
    copyTabRecordName: vi.fn(),
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
    clickTarget: null,
    actions,
    aiEnabled: false,
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

describe('buildMenuItems — fresh-agent context', () => {
  it('returns Copy and Select all for fresh-agent target', () => {
    const mockActions = createMockActions()
    const mockContext = createMockContext(mockActions)
    const target: ContextTarget = { kind: 'fresh-agent', sessionId: 'sess-1' }
    const items = buildMenuItems(target, mockContext)
    const ids = items.filter(i => i.type === 'item').map(i => i.id)
    expect(ids).toContain('fc-copy')
    expect(ids).toContain('fc-select-all')
  })

  it('always includes Copy, Select all, and Copy session ID', () => {
    const mockActions = createMockActions()
    const mockContext = createMockContext(mockActions)
    const target: ContextTarget = { kind: 'fresh-agent', sessionId: 'sess-1' }
    const items = buildMenuItems(target, mockContext)
    const actionItems = items.filter(i => i.type === 'item')
    expect(actionItems).toHaveLength(3)
    const ids = actionItems.map(i => i.id)
    expect(ids).toContain('fc-copy')
    expect(ids).toContain('fc-select-all')
    expect(ids).toContain('fc-copy-session')
  })

  it('disables Copy when no selection', () => {
    const mockActions = createMockActions()
    const mockContext = createMockContext(mockActions)
    const target: ContextTarget = { kind: 'fresh-agent', sessionId: 'sess-1' }
    const items = buildMenuItems(target, mockContext)
    const copyItem = items.find(i => i.type === 'item' && i.id === 'fc-copy')
    expect(copyItem).toBeDefined()
    if (copyItem?.type === 'item') {
      expect(copyItem.disabled).toBe(true)
    }
  })
})

describe('buildMenuItems — clickTarget passthrough', () => {
  it('receives clickTarget in context', () => {
    // Verify the interface accepts clickTarget without error
    const mockActions = createMockActions()
    const mockContext = createMockContext(mockActions)
    const el = document.createElement('span')
    mockContext.clickTarget = el
    const target: ContextTarget = { kind: 'global' }
    const items = buildMenuItems(target, mockContext)
    expect(items.length).toBeGreaterThan(0)
  })
})

describe('buildMenuItems — fresh-agent context-sensitive items', () => {
  function makeContextWithClickTarget(clickTarget: HTMLElement, contextElement?: HTMLElement) {
    const mockActions = createMockActions()
    return {
      ctx: { ...createMockContext(mockActions), clickTarget, contextElement: contextElement ?? null },
      actions: mockActions,
    }
  }

  it('adds "Copy code block" when clicking inside a <pre><code> in .prose', () => {
    const prose = document.createElement('div')
    prose.className = 'prose'
    const pre = document.createElement('pre')
    const code = document.createElement('code')
    code.textContent = 'const x = 1'
    pre.appendChild(code)
    prose.appendChild(pre)

    const { ctx } = makeContextWithClickTarget(code)
    const target: ContextTarget = { kind: 'fresh-agent', sessionId: 's1' }
    const items = buildMenuItems(target, ctx)
    const ids = items.filter(i => i.type === 'item').map(i => i.id)
    expect(ids).toContain('fc-copy-code-block')
  })

  it('adds "Copy command" when clicking inside a [data-tool-input] for Bash', () => {
    const pre = document.createElement('pre')
    pre.setAttribute('data-tool-input', '')
    pre.setAttribute('data-tool-name', 'Bash')
    pre.textContent = 'echo hello'

    const { ctx } = makeContextWithClickTarget(pre)
    const target: ContextTarget = { kind: 'fresh-agent', sessionId: 's1' }
    const items = buildMenuItems(target, ctx)
    const ids = items.filter(i => i.type === 'item').map(i => i.id)
    expect(ids).toContain('fc-copy-command')
  })

  it('adds "Copy input" (not "Copy command") for non-Bash tools', () => {
    const pre = document.createElement('pre')
    pre.setAttribute('data-tool-input', '')
    pre.setAttribute('data-tool-name', 'Grep')
    pre.textContent = '{"pattern":"foo"}'

    const { ctx } = makeContextWithClickTarget(pre)
    const target: ContextTarget = { kind: 'fresh-agent', sessionId: 's1' }
    const items = buildMenuItems(target, ctx)
    const ids = items.filter(i => i.type === 'item').map(i => i.id)
    expect(ids).toContain('fc-copy-input')
    expect(ids).not.toContain('fc-copy-command')
  })

  it('adds "Copy output" when clicking inside a [data-tool-output]', () => {
    const pre = document.createElement('pre')
    pre.setAttribute('data-tool-output', '')
    pre.textContent = 'file1.txt\nfile2.txt'

    const { ctx } = makeContextWithClickTarget(pre)
    const target: ContextTarget = { kind: 'fresh-agent', sessionId: 's1' }
    const items = buildMenuItems(target, ctx)
    const ids = items.filter(i => i.type === 'item').map(i => i.id)
    expect(ids).toContain('fc-copy-output')
  })

  it('adds diff-specific items when clicking inside a [data-diff]', () => {
    const diff = document.createElement('div')
    diff.setAttribute('data-diff', '')
    diff.setAttribute('data-file-path', '/tmp/test.ts')
    const span = document.createElement('span')
    diff.appendChild(span)

    const { ctx } = makeContextWithClickTarget(span)
    const target: ContextTarget = { kind: 'fresh-agent', sessionId: 's1' }
    const items = buildMenuItems(target, ctx)
    const ids = items.filter(i => i.type === 'item').map(i => i.id)
    expect(ids).toContain('fc-copy-new-version')
    expect(ids).toContain('fc-copy-old-version')
    expect(ids).toContain('fc-copy-file-path')
  })

  it('always includes Copy and Select all', () => {
    const div = document.createElement('div')
    const { ctx } = makeContextWithClickTarget(div)
    const target: ContextTarget = { kind: 'fresh-agent', sessionId: 's1' }
    const items = buildMenuItems(target, ctx)
    const ids = items.filter(i => i.type === 'item').map(i => i.id)
    expect(ids).toContain('fc-copy')
    expect(ids).toContain('fc-select-all')
  })

  it('includes "Copy session ID" after a separator', () => {
    const div = document.createElement('div')
    const { ctx } = makeContextWithClickTarget(div)
    const target: ContextTarget = { kind: 'fresh-agent', sessionId: 's1' }
    const items = buildMenuItems(target, ctx)
    const sessionIdx = items.findIndex(i => i.type === 'item' && i.id === 'fc-copy-session')
    expect(sessionIdx).toBeGreaterThan(0)
    expect(items[sessionIdx - 1]?.type).toBe('separator')
  })
})

describe('buildMenuItems — fresh-agent rollback rows (kata 1wxv)', () => {
  const unregisters: Array<() => void> = []
  afterEach(() => {
    let unregister: (() => void) | undefined
    while ((unregister = unregisters.pop()) !== undefined) unregister()
  })

  function buildFreshAgentMenu(paneId: string, actions?: FreshAgentPaneActions) {
    if (actions) unregisters.push(registerFreshAgentPaneActions(paneId, actions))
    const mockActions = createMockActions()
    const mockContext = createMockContext(mockActions)
    const target: ContextTarget = { kind: 'fresh-agent', sessionId: 'sess-1', paneId }
    return buildMenuItems(target, mockContext)
  }

  function expectStructurallyIntact(items: ReturnType<typeof buildMenuItems>) {
    // Hiding rows must never leave orphan separators behind.
    expect(items[0]?.type).not.toBe('separator')
    expect(items.at(-1)?.type).not.toBe('separator')
    for (let i = 1; i < items.length; i += 1) {
      expect(items[i - 1].type === 'separator' && items[i].type === 'separator').toBe(false)
    }
  }

  it('a freshcodex pane menu NEVER renders the "Redo last turn" row (enabled or disabled) — the undo row stands alone after one separator', () => {
    const items = buildFreshAgentMenu('pane-rb-codex', {
      undo: vi.fn(),
      redo: vi.fn(),
      canUndo: true,
      canRedo: false,
      // freshcodex server-side capability stamp: undo only.
      undoSupported: true,
      redoSupported: false,
    })
    const itemIds = items.filter(i => i.type === 'item').map(i => i.id)
    expect(itemIds).toContain('fresh-agent-undo')
    expect(itemIds).not.toContain('fresh-agent-redo')
    expect(items.find(i => i.type === 'item' && i.label === 'Redo last turn')).toBeUndefined()
    const undoIdx = items.findIndex(i => i.id === 'fresh-agent-undo')
    expect(items[undoIdx - 1]).toMatchObject({ type: 'separator', id: 'fc-rollback-sep' })
    expect(items.filter(i => i.id === 'fc-rollback-sep')).toHaveLength(1)
    // The undo row itself is shown enabled (no dim stand-ins for the hidden row).
    expect(items[undoIdx]).toMatchObject({ disabled: false })
    expectStructurallyIntact(items)
  })

  it('a freshclaude pane menu shows an enabled "Redo last turn" row beside the undo row when canRedo', () => {
    const undo = vi.fn()
    const redo = vi.fn()
    const items = buildFreshAgentMenu('pane-rb-claude', {
      undo,
      redo,
      canUndo: true,
      canRedo: true,
      undoSupported: true,
      redoSupported: true,
    })
    const redoItem = items.find(i => i.type === 'item' && i.id === 'fresh-agent-redo')
    expect(redoItem).toBeDefined()
    if (redoItem?.type === 'item') {
      expect(redoItem.label).toBe('Redo last turn')
      expect(redoItem.disabled ?? false).toBe(false)
      redoItem.onSelect()
      expect(redo).toHaveBeenCalledTimes(1)
    }
    expect(items.filter(i => i.type === 'item').map(i => i.id)).toContain('fresh-agent-undo')
    expectStructurallyIntact(items)
  })

  it('a redo-capable pane with nothing to redo keeps the row disabled — only capability omission hides the row', () => {
    const items = buildFreshAgentMenu('pane-rb-idle', {
      undo: vi.fn(),
      redo: vi.fn(),
      canUndo: true,
      canRedo: false,
      undoSupported: true,
      redoSupported: true,
    })
    expect(items.find(i => i.type === 'item' && i.id === 'fresh-agent-redo')).toMatchObject({ disabled: true })
    expectStructurallyIntact(items)
  })

  it('omits the whole rollback section — separator included — when the pane stamps neither capability', () => {
    const items = buildFreshAgentMenu('pane-rb-legacy', {
      undo: vi.fn(),
      redo: vi.fn(),
      canUndo: false,
      canRedo: false,
      undoSupported: false,
      redoSupported: false,
    })
    const itemIds = items.filter(i => i.type === 'item').map(i => i.id)
    expect(itemIds).not.toContain('fresh-agent-undo')
    expect(itemIds).not.toContain('fresh-agent-redo')
    expect(items.find(i => i.id === 'fc-rollback-sep')).toBeUndefined()
    // The remainder of the menu stays exactly as before.
    expect(itemIds).toEqual(['fc-copy', 'fc-select-all', 'fc-copy-session'])
    expectStructurallyIntact(items)
  })

  it('an unregistered pane leaves no rollback rows and no orphan separator', () => {
    const items = buildFreshAgentMenu('pane-rb-unregistered')
    const itemIds = items.filter(i => i.type === 'item').map(i => i.id)
    expect(itemIds).not.toContain('fresh-agent-undo')
    expect(itemIds).not.toContain('fresh-agent-redo')
    expect(items.find(i => i.id === 'fc-rollback-sep')).toBeUndefined()
    expectStructurallyIntact(items)
  })
})

describe('buildMenuItems — terminal context with hoveredUrl', () => {
  function buildTerminalItems(hoveredUrl?: string) {
    const mockActions = createMockActions()
    const mockContext = createMockContext(mockActions)
    ;(mockActions.getTerminalActions as ReturnType<typeof vi.fn>).mockReturnValue({
      hasSelection: () => false,
      copySelection: vi.fn(),
      paste: vi.fn(),
      selectAll: vi.fn(),
      clearScrollback: vi.fn(),
      reset: vi.fn(),
      scrollToBottom: vi.fn(),
      openSearch: vi.fn(),
    })
    const target: ContextTarget = { kind: 'terminal', tabId: 'tab1', paneId: 'pane1', hoveredUrl }
    const items = buildMenuItems(target, mockContext)
    return { items, mockActions }
  }

  it('terminal target with hoveredUrl includes URL menu items at the top', () => {
    const { items } = buildTerminalItems('https://example.com')
    const actionItems = items.filter(i => i.type === 'item')
    const ids = actionItems.map(i => i.id)
    expect(ids[0]).toBe('url-open-pane')
    expect(ids[1]).toBe('url-open-tab')
    expect(ids[2]).toBe('url-open-browser')
    expect(ids[3]).toBe('url-copy')
    // After URL items there should be a separator, then clipboard items
    const urlSepIdx = items.findIndex(i => i.type === 'separator' && i.id === 'url-sep')
    expect(urlSepIdx).toBeGreaterThan(0)
  })

  it('terminal target without hoveredUrl has no URL menu items', () => {
    const { items } = buildTerminalItems()
    const ids = items.filter(i => i.type === 'item').map(i => i.id)
    expect(ids).not.toContain('url-open-pane')
    expect(ids).not.toContain('url-open-tab')
    expect(ids).not.toContain('url-open-browser')
    expect(ids).not.toContain('url-copy')
    // First item should be terminal-copy
    expect(ids[0]).toBe('terminal-copy')
  })

  it('url-open-pane item calls openUrlInPane with correct args', () => {
    const { items, mockActions } = buildTerminalItems('https://test.url')
    const item = items.find(i => i.type === 'item' && i.id === 'url-open-pane')
    expect(item).toBeDefined()
    if (item?.type === 'item') item.onSelect()
    expect(mockActions.openUrlInPane).toHaveBeenCalledWith('tab1', 'pane1', 'https://test.url')
  })

  it('url-open-tab item calls openUrlInTab with correct args', () => {
    const { items, mockActions } = buildTerminalItems('https://test.url')
    const item = items.find(i => i.type === 'item' && i.id === 'url-open-tab')
    expect(item).toBeDefined()
    if (item?.type === 'item') item.onSelect()
    expect(mockActions.openUrlInTab).toHaveBeenCalledWith('https://test.url')
  })

  it('url-open-browser item calls openUrlInBrowser with correct args', () => {
    const { items, mockActions } = buildTerminalItems('https://test.url')
    const item = items.find(i => i.type === 'item' && i.id === 'url-open-browser')
    expect(item).toBeDefined()
    if (item?.type === 'item') item.onSelect()
    expect(mockActions.openUrlInBrowser).toHaveBeenCalledWith('https://test.url')
  })

  it('url-copy item calls copyUrl with correct args', () => {
    const { items, mockActions } = buildTerminalItems('https://test.url')
    const item = items.find(i => i.type === 'item' && i.id === 'url-copy')
    expect(item).toBeDefined()
    if (item?.type === 'item') item.onSelect()
    expect(mockActions.copyUrl).toHaveBeenCalledWith('https://test.url')
  })

  it('URL items have correct labels', () => {
    const { items } = buildTerminalItems('https://example.com')
    const urlItems = items.filter(i => i.type === 'item' && i.id.startsWith('url-'))
    expect(urlItems).toHaveLength(4)
    const labels = urlItems.map(i => i.type === 'item' ? i.label : '')
    expect(labels).toEqual([
      'Open URL in pane',
      'Open URL in new tab',
      'Open in external browser',
      'Copy URL',
    ])
  })

  it('existing terminal menu items still present after URL items', () => {
    const { items } = buildTerminalItems('https://example.com')
    const ids = items.filter(i => i.type === 'item').map(i => i.id)
    expect(ids).toContain('terminal-copy')
    expect(ids).toContain('terminal-paste')
    expect(ids).toContain('terminal-select-all')
    expect(ids).toContain('terminal-search')
    expect(ids).toContain('terminal-clear')
    expect(ids).toContain('terminal-reset')
    expect(ids).toContain('replace-pane')
  })
})

describe('tabs-card menu', () => {
  function buildFor(record: RegistryTabRecord, registryDeviceId: string) {
    const actions = createMockActions()
    const ctx = {
      ...createMockContext(actions),
      tabRegistryGroups: makeRegistryGroups({ remoteOpen: [record] }),
      registryDeviceId,
    }
    const items = buildMenuItems({ kind: 'tabs-card', tabKey: record.tabKey, status: record.status }, ctx)
    return { actions, items }
  }

  it('local open record: Jump to tab first, then Open copy', () => {
    const record = makeRegistryRecord({ deviceId: 'this-device', tabKey: 'this-device:tab-9' })
    const { actions, items } = buildFor(record, 'this-device')

    expect(items[0]).toMatchObject({ type: 'item', id: 'jump', label: 'Jump to tab' })
    const openCopy = items.find((i) => i.type === 'item' && i.id === 'open-copy')
    expect(openCopy).toMatchObject({ label: 'Open copy' })
    if (items[0].type === 'item') items[0].onSelect()
    expect(actions.jumpToTabRecord).toHaveBeenCalledWith(record)
  })

  it('remote open record: no Jump item, Pull to this device', () => {
    const record = makeRegistryRecord()
    const { actions, items } = buildFor(record, 'this-device')

    expect(items.find((i) => i.type === 'item' && i.id === 'jump')).toBeUndefined()
    const openCopy = items.find((i) => i.type === 'item' && i.id === 'open-copy')
    expect(openCopy).toMatchObject({ label: 'Pull to this device' })
    if (openCopy?.type === 'item') openCopy.onSelect()
    expect(actions.openTabRecordCopy).toHaveBeenCalledWith(record)
  })

  it('closed record: Reopen label', () => {
    const record = makeRegistryRecord({ status: 'closed', closedAt: 3 })
    const { items } = buildFor(record, 'this-device')
    const openCopy = items.find((i) => i.type === 'item' && i.id === 'open-copy')
    expect(openCopy).toMatchObject({ label: 'Reopen' })
  })

  it('multi-pane record: one open-in-new-tab item per pane', () => {
    const record = makeRegistryRecord({
      paneCount: 2,
      panes: [
        { paneId: 'p1', kind: 'terminal', title: 'my-shell', payload: {} },
        { paneId: 'p2', kind: 'browser', title: 'docs', payload: {} },
      ],
    })
    const { actions, items } = buildFor(record, 'this-device')

    const paneItem = items.find((i) => i.type === 'item' && i.id === 'pane-p2')
    expect(paneItem).toMatchObject({ label: 'Open docs in new tab' })
    expect(items.find((i) => i.type === 'item' && i.id === 'pane-p1')).toMatchObject({
      label: 'Open my-shell in new tab',
    })
    if (paneItem?.type === 'item') paneItem.onSelect()
    expect(actions.openTabRecordPaneInNewTab).toHaveBeenCalledWith(record, record.panes[1])
  })

  it('single-pane record: no per-pane items', () => {
    const record = makeRegistryRecord({
      panes: [{ paneId: 'p1', kind: 'terminal', title: 'my-shell', payload: {} }],
    })
    const { items } = buildFor(record, 'this-device')
    expect(items.find((i) => i.type === 'item' && i.id === 'pane-p1')).toBeUndefined()
  })

  it('copy-name delegates to copyTabRecordName', () => {
    const record = makeRegistryRecord()
    const { actions, items } = buildFor(record, 'this-device')
    const copyName = items.find((i) => i.type === 'item' && i.id === 'copy-name')
    expect(copyName).toMatchObject({ label: 'Copy tab name' })
    if (copyName?.type === 'item') copyName.onSelect()
    expect(actions.copyTabRecordName).toHaveBeenCalledWith(record)
  })

  it('returns no items when the record or groups are missing', () => {
    const actions = createMockActions()
    const noGroups = buildMenuItems(
      { kind: 'tabs-card', tabKey: 'x:y', status: 'open' },
      { ...createMockContext(actions) },
    )
    expect(noGroups).toEqual([])

    const unknownKey = buildMenuItems(
      { kind: 'tabs-card', tabKey: 'x:y', status: 'open' },
      { ...createMockContext(actions), tabRegistryGroups: makeRegistryGroups(), registryDeviceId: 'd' },
    )
    expect(unknownKey).toEqual([])
  })
})
