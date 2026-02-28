/**
 * E2E integration test for the freshclaude context menu flow.
 *
 * Renders AgentChatView with realistic tool blocks and diffs, queries the
 * actual DOM for data-* attributes, and feeds those DOM elements into
 * buildMenuItems to verify the full pipeline:
 *   component rendering -> data attributes -> context-sensitive menu items.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import AgentChatView from '@/components/agent-chat/AgentChatView'
import agentChatReducer, {
  sessionCreated,
  addUserMessage,
  addAssistantMessage,
  setSessionStatus,
} from '@/store/agentChatSlice'
import panesReducer from '@/store/panesSlice'
import type { AgentChatPaneContent } from '@/store/paneTypes'
import { buildMenuItems, type MenuActions, type MenuBuildContext } from '@/components/context-menu/menu-defs'
import type { ContextTarget } from '@/components/context-menu/context-menu-types'

// jsdom doesn't implement scrollIntoView
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: vi.fn(),
    onReconnect: vi.fn(() => vi.fn()),
  }),
}))

function makeStore() {
  return configureStore({
    reducer: {
      agentChat: agentChatReducer,
      panes: panesReducer,
    },
  })
}

const BASE_PANE: AgentChatPaneContent = {
  kind: 'agent-chat', provider: 'freshclaude',
  createRequestId: 'req-1',
  sessionId: 'sess-1',
  status: 'idle',
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
    replacePane: vi.fn(),
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
    copyAgentChatCodeBlock: vi.fn(),
    copyAgentChatToolInput: vi.fn(),
    copyAgentChatToolOutput: vi.fn(),
    copyAgentChatDiffNew: vi.fn(),
    copyAgentChatDiffOld: vi.fn(),
    copyAgentChatFilePath: vi.fn(),
  }
}

function createMockContext(actions: MenuActions, overrides?: Partial<MenuBuildContext>): MenuBuildContext {
  return {
    view: 'terminal',
    sidebarCollapsed: false,
    tabs: [],
    paneLayouts: {},
    sessions: [],
    expandedProjects: new Set<string>(),
    contextElement: null,
    clickTarget: null,
    actions,
    platform: null,
    ...overrides,
  }
}

describe('freshclaude context menu integration', () => {
  afterEach(cleanup)

  it('right-click on tool input in rendered DOM produces "Copy command" menu item', () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(addUserMessage({ sessionId: 'sess-1', text: 'Run a command' }))
    store.dispatch(addAssistantMessage({
      sessionId: 'sess-1',
      content: [
        { type: 'text', text: 'Running the command...' },
        { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'echo hello world' } },
        { type: 'tool_result', tool_use_id: 'tool-1', content: 'hello world' },
      ],
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))

    const { container } = render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    // Step 1: Verify the data attributes are present in the rendered DOM
    const toolInputEl = container.querySelector('[data-tool-input]')
    expect(toolInputEl).not.toBeNull()
    expect(toolInputEl?.getAttribute('data-tool-name')).toBe('Bash')

    // Step 2: Feed the actual DOM element into buildMenuItems as clickTarget
    const mockActions = createMockActions()
    const ctx = createMockContext(mockActions, {
      clickTarget: toolInputEl as HTMLElement,
    })
    const target: ContextTarget = { kind: 'agent-chat', sessionId: 'sess-1' }
    const items = buildMenuItems(target, ctx)
    const ids = items.filter(i => i.type === 'item').map(i => i.id)

    // Step 3: Verify the correct context-sensitive menu items appear
    expect(ids).toContain('fc-copy')
    expect(ids).toContain('fc-select-all')
    expect(ids).toContain('fc-copy-command')
    expect(ids).toContain('fc-copy-session')
  })

  it('right-click on diff in rendered DOM produces diff-specific menu items', () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(addUserMessage({ sessionId: 'sess-1', text: 'Edit a file' }))
    store.dispatch(addAssistantMessage({
      sessionId: 'sess-1',
      content: [
        {
          type: 'tool_use',
          id: 'edit-1',
          name: 'Edit',
          input: {
            file_path: '/tmp/test.ts',
            old_string: 'const foo = 1',
            new_string: 'const bar = 2',
          },
        },
        {
          type: 'tool_result',
          tool_use_id: 'edit-1',
          content: 'File edited successfully',
        },
      ],
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))

    const { container } = render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    // Step 1: Verify the data attributes are present in the rendered DOM
    const diffEl = container.querySelector('[data-diff]')
    expect(diffEl).not.toBeNull()
    expect(diffEl?.getAttribute('data-file-path')).toBe('/tmp/test.ts')

    // The click target would be a child element inside the diff (e.g. a span with diff text)
    const clickTarget = diffEl?.querySelector('span') ?? diffEl
    expect(clickTarget).not.toBeNull()

    // Step 2: Feed the actual DOM element into buildMenuItems as clickTarget
    const mockActions = createMockActions()
    const ctx = createMockContext(mockActions, {
      clickTarget: clickTarget as HTMLElement,
    })
    const target: ContextTarget = { kind: 'agent-chat', sessionId: 'sess-1' }
    const items = buildMenuItems(target, ctx)
    const ids = items.filter(i => i.type === 'item').map(i => i.id)

    // Step 3: Verify the correct context-sensitive menu items appear
    expect(ids).toContain('fc-copy')
    expect(ids).toContain('fc-select-all')
    expect(ids).toContain('fc-copy-new-version')
    expect(ids).toContain('fc-copy-old-version')
    expect(ids).toContain('fc-copy-file-path')
    expect(ids).toContain('fc-copy-session')
  })

  it('right-click on tool output in rendered DOM produces "Copy output" menu item', () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(addUserMessage({ sessionId: 'sess-1', text: 'List files' }))
    store.dispatch(addAssistantMessage({
      sessionId: 'sess-1',
      content: [
        { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_result', tool_use_id: 'tool-1', content: 'file1.txt\nfile2.txt\nfile3.txt' },
      ],
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))

    const { container } = render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    // Verify the tool output data attribute exists in the DOM
    const toolOutputEl = container.querySelector('[data-tool-output]')
    expect(toolOutputEl).not.toBeNull()

    // Feed it into buildMenuItems
    const mockActions = createMockActions()
    const ctx = createMockContext(mockActions, {
      clickTarget: toolOutputEl as HTMLElement,
    })
    const target: ContextTarget = { kind: 'agent-chat', sessionId: 'sess-1' }
    const items = buildMenuItems(target, ctx)
    const ids = items.filter(i => i.type === 'item').map(i => i.id)

    expect(ids).toContain('fc-copy')
    expect(ids).toContain('fc-select-all')
    expect(ids).toContain('fc-copy-output')
    expect(ids).toContain('fc-copy-session')
  })
})
