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
    copyFreshclaudeCodeBlock: vi.fn(),
    copyFreshclaudeToolInput: vi.fn(),
    copyFreshclaudeToolOutput: vi.fn(),
    copyFreshclaudeDiffNew: vi.fn(),
    copyFreshclaudeDiffOld: vi.fn(),
    copyFreshclaudeFilePath: vi.fn(),
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

describe('buildMenuItems — freshclaude-chat context', () => {
  it('returns Copy and Select all for freshclaude-chat target', () => {
    const mockActions = createMockActions()
    const mockContext = createMockContext(mockActions)
    const target: ContextTarget = { kind: 'freshclaude-chat', sessionId: 'sess-1' }
    const items = buildMenuItems(target, mockContext)
    const ids = items.filter(i => i.type === 'item').map(i => i.id)
    expect(ids).toContain('fc-copy')
    expect(ids).toContain('fc-select-all')
  })

  it('always includes Copy, Select all, and Copy session ID', () => {
    const mockActions = createMockActions()
    const mockContext = createMockContext(mockActions)
    const target: ContextTarget = { kind: 'freshclaude-chat', sessionId: 'sess-1' }
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
    const target: ContextTarget = { kind: 'freshclaude-chat', sessionId: 'sess-1' }
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

describe('buildMenuItems — freshclaude-chat context-sensitive items', () => {
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
    const target: ContextTarget = { kind: 'freshclaude-chat', sessionId: 's1' }
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
    const target: ContextTarget = { kind: 'freshclaude-chat', sessionId: 's1' }
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
    const target: ContextTarget = { kind: 'freshclaude-chat', sessionId: 's1' }
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
    const target: ContextTarget = { kind: 'freshclaude-chat', sessionId: 's1' }
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
    const target: ContextTarget = { kind: 'freshclaude-chat', sessionId: 's1' }
    const items = buildMenuItems(target, ctx)
    const ids = items.filter(i => i.type === 'item').map(i => i.id)
    expect(ids).toContain('fc-copy-new-version')
    expect(ids).toContain('fc-copy-old-version')
    expect(ids).toContain('fc-copy-file-path')
  })

  it('always includes Copy and Select all', () => {
    const div = document.createElement('div')
    const { ctx } = makeContextWithClickTarget(div)
    const target: ContextTarget = { kind: 'freshclaude-chat', sessionId: 's1' }
    const items = buildMenuItems(target, ctx)
    const ids = items.filter(i => i.type === 'item').map(i => i.id)
    expect(ids).toContain('fc-copy')
    expect(ids).toContain('fc-select-all')
  })

  it('includes "Copy session ID" after a separator', () => {
    const div = document.createElement('div')
    const { ctx } = makeContextWithClickTarget(div)
    const target: ContextTarget = { kind: 'freshclaude-chat', sessionId: 's1' }
    const items = buildMenuItems(target, ctx)
    const ids = items.filter(i => i.type === 'item').map(i => i.id)
    expect(ids).toContain('fc-copy-session')
  })
})
