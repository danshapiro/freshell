import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import PaneContainer from '@/components/panes/PaneContainer'
import panesReducer from '@/store/panesSlice'
import tabsReducer from '@/store/tabsSlice'
import settingsReducer from '@/store/settingsSlice'
import connectionReducer, { ConnectionState } from '@/store/connectionSlice'
import extensionsReducer from '@/store/extensionsSlice'
import terminalMetaReducer from '@/store/terminalMetaSlice'
import sessionsReducer, { applySessionsPatch, type SessionsState } from '@/store/sessionsSlice'
import freshAgentReducer, { turnResult } from '@/store/freshAgentSlice'
import opencodeActivityReducer, { upsertOpencodeActivity } from '@/store/opencodeActivitySlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import { markTabAttention, markPaneAttention } from '@/store/turnCompletionSlice'
import type { PanesState } from '@/store/panesSlice'
import type { PaneNode, PaneContent, EditorPaneContent } from '@/store/paneTypes'
import type { FreshAgentSessionState, FreshAgentState } from '@/store/freshAgentTypes'
import type { ClientExtensionEntry } from '@shared/extension-types'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'

const defaultCliExtensions: ClientExtensionEntry[] = [
  {
    name: 'claude', version: '1.0.0', label: 'Claude CLI', description: '', category: 'cli',
    picker: { shortcut: 'L' },
    cli: { supportsPermissionMode: true, supportsResume: true, resumeCommandTemplate: ['claude', '--resume', '{{sessionId}}'] },
  },
  {
    name: 'codex', version: '1.0.0', label: 'Codex CLI', description: '', category: 'cli',
    picker: { shortcut: 'X' },
    cli: { supportsModel: true, supportsSandbox: true, supportsResume: true, resumeCommandTemplate: ['codex', 'resume', '{{sessionId}}'] },
  },
]

// Hoist mock functions so vi.mock can reference them
const {
  mockSend,
  mockTerminalView,
  mockFreshAgentView,
  mockBrowserPane,
  browserPaneMounts,
  browserPaneUnmounts,
  mockApiGet,
  mockApiPost,
  mockApiPatch,
  saveServerSettingsPatchSpy,
  cancelCreateSpy,
  cancelWsCreateSpy,
} = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockTerminalView: vi.fn(({ tabId, paneId, hidden }: { tabId: string; paneId: string; hidden?: boolean }) => (
    <div data-testid={`terminal-${paneId}`} data-hidden={String(hidden)}>Terminal for {tabId}/{paneId}</div>
  )),
  mockFreshAgentView: vi.fn(({ paneId }: { paneId: string }) => (
    <div data-testid={`fresh-agent-${paneId}`}>Fresh Agent</div>
  )),
  mockBrowserPane: vi.fn(),
  browserPaneMounts: [] as string[],
  browserPaneUnmounts: [] as string[],
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
  mockApiPatch: vi.fn(),
  saveServerSettingsPatchSpy: vi.fn((patch: unknown) => ({
    type: 'settings/saveServerSettingsPatch',
    payload: patch,
  })),
  cancelCreateSpy: vi.fn(),
  cancelWsCreateSpy: vi.fn(),
}))

// Mock the ws-client module
vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: mockSend,
    cancelCreate: cancelWsCreateSpy,
    onMessage: () => () => {},
  }),
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) => mockApiGet(path),
    post: (path: string, body: unknown) => mockApiPost(path, body),
    patch: (path: string, body: unknown) => mockApiPatch(path, body),
  },
  getFreshAgentThreadSnapshot: vi.fn().mockResolvedValue({
    status: 'idle',
    summary: 'Fresh agent test snapshot',
    capabilities: { send: false, interrupt: false, fork: false },
    turns: [],
  }),
}))

vi.mock('@/store/settingsThunks', () => ({
  saveServerSettingsPatch: (patch: unknown) => saveServerSettingsPatchSpy(patch),
}))

vi.mock('@/lib/create-cancellation', () => ({
  cancelCreate: (requestId: string) => cancelCreateSpy(requestId),
}))

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  X: ({ className }: { className?: string }) => (
    <svg data-testid="x-icon" className={className} />
  ),
  Plus: ({ className }: { className?: string }) => (
    <svg data-testid="plus-icon" className={className} />
  ),
  Globe: ({ className }: { className?: string }) => (
    <svg data-testid="globe-icon" className={className} />
  ),
  Terminal: ({ className }: { className?: string }) => (
    <svg data-testid="terminal-icon" className={className} />
  ),
  PanelLeftClose: ({ className }: { className?: string }) => (
    <svg data-testid="panel-left-close-icon" className={className} />
  ),
  PanelLeftOpen: ({ className }: { className?: string }) => (
    <svg data-testid="panel-left-open-icon" className={className} />
  ),
  Circle: ({ className }: { className?: string }) => (
    <svg data-testid="circle-icon" className={className} />
  ),
  FolderOpen: ({ className }: { className?: string }) => (
    <svg data-testid="folder-open-icon" className={className} />
  ),
  Eye: ({ className }: { className?: string }) => (
    <svg data-testid="eye-icon" className={className} />
  ),
  Code: ({ className }: { className?: string }) => (
    <svg data-testid="code-icon" className={className} />
  ),
  WrapText: ({ className }: { className?: string }) => (
    <svg data-testid="wrap-text-icon" className={className} />
  ),
  FileText: ({ className }: { className?: string }) => (
    <svg data-testid="file-text-icon" className={className} />
  ),
  LayoutGrid: ({ className }: { className?: string }) => (
    <svg data-testid="layout-grid-icon" className={className} />
  ),
  Maximize2: ({ className }: { className?: string }) => (
    <svg data-testid="maximize-icon" className={className} />
  ),
  Minimize2: ({ className }: { className?: string }) => (
    <svg data-testid="minimize-icon" className={className} />
  ),
  Pencil: ({ className }: { className?: string }) => (
    <svg data-testid="pencil-icon" className={className} />
  ),
  ChevronRight: ({ className }: { className?: string }) => (
    <svg data-testid="chevron-right-icon" className={className} />
  ),
  Loader2: ({ className }: { className?: string }) => (
    <svg data-testid="loader-icon" className={className} />
  ),
  Check: ({ className }: { className?: string }) => (
    <svg data-testid="check-icon" className={className} />
  ),
  ShieldAlert: ({ className }: { className?: string }) => (
    <svg data-testid="shield-alert-icon" className={className} />
  ),
  Send: ({ className }: { className?: string }) => (
    <svg data-testid="send-icon" className={className} />
  ),
  Square: ({ className }: { className?: string }) => (
    <svg data-testid="square-icon" className={className} />
  ),
  SquareTerminal: ({ className }: { className?: string }) => (
    <svg data-testid="square-terminal-icon" className={className} />
  ),
  Search: ({ className }: { className?: string }) => (
    <svg data-testid="search-icon" className={className} />
  ),
  RefreshCw: ({ className }: { className?: string }) => (
    <svg data-testid="refresh-icon" className={className} />
  ),
  Settings: ({ className }: { className?: string }) => (
    <svg data-testid="settings-icon" className={className} />
  ),
}))

// Mock TerminalView component to avoid xterm.js dependencies
vi.mock('@/components/TerminalView', () => ({
  default: mockTerminalView,
}))

vi.mock('@/components/fresh-agent/FreshAgentView', () => ({
  default: mockFreshAgentView,
}))

// Mock BrowserPane component
vi.mock('@/components/panes/BrowserPane', () => ({
  default: ({ paneId, url, browserInstanceId }: { paneId: string; url: string; browserInstanceId: string }) => {
    const React = require('react')
    React.useEffect(() => {
      browserPaneMounts.push(browserInstanceId)
      return () => {
        browserPaneUnmounts.push(browserInstanceId)
      }
    }, [browserInstanceId])
    mockBrowserPane({ paneId, url, browserInstanceId })
    return (
      <div data-testid={`browser-${paneId}`} data-browser-instance-id={browserInstanceId}>
        Browser: {url}
      </div>
    )
  },
}))

// Mock Monaco editor
vi.mock('@monaco-editor/react', () => {
  const MockEditor = ({ value, onChange }: any) => {
    const React = require('react')
    return React.createElement('textarea', {
      'data-testid': 'monaco-mock',
      value,
      onChange: (e: any) => onChange?.(e.target.value),
    })
  }
  return {
    default: MockEditor,
    Editor: MockEditor,
  }
})

function createTerminalContent(overrides: Partial<PaneContent & { kind: 'terminal' }> = {}): PaneContent {
  return {
    kind: 'terminal',
    mode: 'shell',
    ...overrides,
  }
}

function createFreshClaudeSession(
  overrides: Partial<FreshAgentSessionState> & { sessionId: string },
): FreshAgentSessionState {
  const sessionType = overrides.sessionType ?? 'freshclaude'
  const provider = overrides.provider ?? 'claude'
  const sessionKey = makeFreshAgentSessionKey({
    sessionType,
    provider,
    sessionId: overrides.sessionId,
  })

  return {
    sessionKey,
    sessionType,
    provider,
    sessionId: overrides.sessionId,
    threadId: overrides.threadId ?? overrides.sessionId,
    status: 'idle',
    turns: [],
    historyItems: [],
    historyBodies: {},
    streamingText: '',
    streamingActive: false,
    pendingPermissions: {},
    pendingQuestions: {},
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    ...overrides,
  }
}

function createStore(
  initialPanesState: Partial<PanesState> = {},
  initialConnectionState: Partial<ConnectionState> = {},
  initialSessionsState: Partial<SessionsState> = {},
  initialFreshAgentState: Partial<FreshAgentState> = {},
) {
  return configureStore({
    reducer: {
      panes: panesReducer,
      tabs: tabsReducer,
      settings: settingsReducer,
      connection: connectionReducer,
      extensions: extensionsReducer,
      terminalMeta: terminalMetaReducer,
      sessions: sessionsReducer,
      freshAgent: freshAgentReducer,
      opencodeActivity: opencodeActivityReducer,
      turnCompletion: turnCompletionReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({
        serializableCheck: {
          ignoredPaths: ['sessions.expandedProjects'],
        },
      }),
    preloadedState: {
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        ...initialPanesState,
      },
      tabs: {
        tabs: [{ id: 'tab-1', createRequestId: 'tab-1', title: 'Tab 1', mode: 'shell' as const, status: 'running' as const, createdAt: 1 }],
        activeTabId: 'tab-1',
      },
      extensions: {
        entries: defaultCliExtensions,
      },
      connection: {
        status: 'disconnected',
        platform: null,
        availableClis: {},
        ...initialConnectionState,
      },
      terminalMeta: {
        byTerminalId: {},
      },
      sessions: {
        projects: [],
        expandedProjects: new Set(),
        wsSnapshotReceived: true,
        ...initialSessionsState,
      },
      freshAgent: {
        sessions: {},
        pendingCreates: {},
        pendingCreateFailures: {},
        availableModels: [],
        ...initialFreshAgentState,
      },
      opencodeActivity: {
        byTerminalId: {},
        lastSnapshotSeq: 0,
        liveMutationSeqByTerminalId: {},
        removedMutationSeqByTerminalId: {},
      },
    },
  })
}

function renderWithStore(
  ui: React.ReactElement,
  store: ReturnType<typeof createStore>
) {
  return render(<Provider store={store}>{ui}</Provider>)
}

// Helper to create a proper mock response for the api module
const createMockResponse = (data: unknown, ok = true) => ({
  ok,
  text: async () => JSON.stringify(data),
})

describe('PaneContainer', () => {
  beforeEach(() => {
    mockSend.mockClear()
    mockTerminalView.mockClear()
    mockFreshAgentView.mockClear()
    mockBrowserPane.mockClear()
    browserPaneMounts.length = 0
    browserPaneUnmounts.length = 0
    mockApiGet.mockReset()
    mockApiPost.mockReset()
    mockApiPatch.mockReset()
    saveServerSettingsPatchSpy.mockClear()
    cancelCreateSpy.mockClear()
    cancelWsCreateSpy.mockClear()
    mockApiGet.mockResolvedValue({ directories: [] })
    mockApiPost.mockResolvedValue({ valid: true, resolvedPath: '/resolved/path' })
    mockApiPatch.mockResolvedValue({})
    // Mock fetch for EditorPane's /api/terminals call
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (url === '/api/terminals') return createMockResponse([])
      if (url.startsWith('/api/files/complete')) return createMockResponse({ suggestions: [] })
      return createMockResponse({}, false)
    }))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  describe('terminal cleanup on pane close', () => {
    it('sends terminal.detach message when closing a pane with terminalId', () => {
      const pane1Id = 'pane-1'
      const pane2Id = 'pane-2'
      const terminalId = 'term-123'

      const rootNode: PaneNode = {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          {
            type: 'leaf',
            id: pane1Id,
            content: createTerminalContent({ terminalId }),
          },
          {
            type: 'leaf',
            id: pane2Id,
            content: createTerminalContent({ terminalId: 'term-456' }),
          },
        ],
      }

      const store = createStore({
        layouts: { 'tab-1': rootNode },
        activePane: { 'tab-1': pane1Id },
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={rootNode} />,
        store
      )

      // Click the close button on the first pane
      const closeButtons = screen.getAllByTitle('Close pane')
      fireEvent.click(closeButtons[0])

      // Should have sent terminal.detach with the correct terminalId
      expect(mockSend).toHaveBeenCalledWith({
        type: 'terminal.detach',
        terminalId: terminalId,
      })
    })

    it('does not send terminal.detach when closing a pane without terminalId', () => {
      const pane1Id = 'pane-1'
      const pane2Id = 'pane-2'

      const rootNode: PaneNode = {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          {
            type: 'leaf',
            id: pane1Id,
            content: createTerminalContent({ terminalId: undefined }),
          },
          {
            type: 'leaf',
            id: pane2Id,
            content: createTerminalContent({ terminalId: 'term-456' }),
          },
        ],
      }

      const store = createStore({
        layouts: { 'tab-1': rootNode },
        activePane: { 'tab-1': pane1Id },
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={rootNode} />,
        store
      )

      // Click the close button on the first pane (no terminalId)
      const closeButtons = screen.getAllByTitle('Close pane')
      fireEvent.click(closeButtons[0])

      // Should NOT have sent any message
      expect(mockSend).not.toHaveBeenCalled()
    })

    it('does not send terminal.detach when closing a browser pane', () => {
      const pane1Id = 'pane-1'
      const pane2Id = 'pane-2'

      const browserContent: PaneContent = {
        kind: 'browser',
        browserInstanceId: 'browser-1',
        url: 'https://example.com',
        devToolsOpen: false,
      }

      const rootNode: PaneNode = {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          {
            type: 'leaf',
            id: pane1Id,
            content: browserContent,
          },
          {
            type: 'leaf',
            id: pane2Id,
            content: createTerminalContent({ terminalId: 'term-456' }),
          },
        ],
      }

      const store = createStore({
        layouts: { 'tab-1': rootNode },
        activePane: { 'tab-1': pane1Id },
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={rootNode} />,
        store
      )

      // Click the close button on the first pane (browser)
      const closeButtons = screen.getAllByTitle('Close pane')
      fireEvent.click(closeButtons[0])

      // Should NOT have sent any message
      expect(mockSend).not.toHaveBeenCalled()
    })

    it('sends correct terminalId when closing the second pane', () => {
      const pane1Id = 'pane-1'
      const pane2Id = 'pane-2'

      const rootNode: PaneNode = {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          {
            type: 'leaf',
            id: pane1Id,
            content: createTerminalContent({ terminalId: 'term-111' }),
          },
          {
            type: 'leaf',
            id: pane2Id,
            content: createTerminalContent({ terminalId: 'term-222' }),
          },
        ],
      }

      const store = createStore({
        layouts: { 'tab-1': rootNode },
        activePane: { 'tab-1': pane1Id },
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={rootNode} />,
        store
      )

      // Click the close button on the second pane
      const closeButtons = screen.getAllByTitle('Close pane')
      fireEvent.click(closeButtons[1])

      // Should have sent terminal.detach with the second terminal's ID
      expect(mockSend).toHaveBeenCalledWith({
        type: 'terminal.detach',
        terminalId: 'term-222',
      })
    })
  })

  describe('pane rename sync', () => {
    it('commits local pane and tab title changes only after the pane rename API succeeds for a single-pane tab', async () => {
      mockApiPatch.mockResolvedValueOnce({
        status: 'ok',
        data: { tabId: 'tab-1', paneId: 'pane-1', tabRenamed: true },
        message: 'pane renamed',
      })

      const leafNode: PaneNode = {
        type: 'leaf',
        id: 'pane-1',
        content: createTerminalContent({ terminalId: 'term-1' }),
      }

      const store = createStore({
        layouts: { 'tab-1': leafNode },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: { 'tab-1': { 'pane-1': 'Shell' } },
        renameRequestTabId: 'tab-1',
        renameRequestPaneId: 'pane-1',
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={leafNode} />,
        store
      )

      const renameInput = await screen.findByLabelText('Rename pane')
      fireEvent.change(renameInput, { target: { value: 'Ops desk' } })
      fireEvent.blur(renameInput)

      await waitFor(() => {
        expect(mockApiPatch).toHaveBeenCalledWith('/api/panes/pane-1', { name: 'Ops desk' })
      })
      await waitFor(() => {
        expect(store.getState().panes.paneTitles['tab-1']?.['pane-1']).toBe('Ops desk')
      })
      expect(store.getState().tabs.tabs[0].title).toBe('Ops desk')
    })

    it('applies the single-pane sync rule locally even if the server response omits tabRenamed', async () => {
      mockApiPatch.mockResolvedValueOnce({
        status: 'ok',
        data: { tabId: 'tab-1', paneId: 'pane-1', tabRenamed: false },
        message: 'pane renamed',
      })

      const leafNode: PaneNode = {
        type: 'leaf',
        id: 'pane-1',
        content: createTerminalContent({ terminalId: 'term-1' }),
      }

      const store = createStore({
        layouts: { 'tab-1': leafNode },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: { 'tab-1': { 'pane-1': 'Shell' } },
        renameRequestTabId: 'tab-1',
        renameRequestPaneId: 'pane-1',
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={leafNode} />,
        store
      )

      const renameInput = await screen.findByLabelText('Rename pane')
      fireEvent.change(renameInput, { target: { value: 'Ops desk' } })
      fireEvent.blur(renameInput)

      await waitFor(() => {
        expect(mockApiPatch).toHaveBeenCalledWith('/api/panes/pane-1', { name: 'Ops desk' })
      })
      await waitFor(() => {
        expect(store.getState().panes.paneTitles['tab-1']?.['pane-1']).toBe('Ops desk')
      })
      expect(store.getState().tabs.tabs[0].title).toBe('Ops desk')
    })

    it('keeps the rename editor open and does not update local titles when the server reports pane not found in a 200 response', async () => {
      mockApiPatch.mockResolvedValueOnce({
        status: 'ok',
        message: 'pane not found',
      })

      const leafNode: PaneNode = {
        type: 'leaf',
        id: 'pane-1',
        content: createTerminalContent({ terminalId: 'term-1' }),
      }

      const store = createStore({
        layouts: { 'tab-1': leafNode },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: { 'tab-1': { 'pane-1': 'Shell' } },
        renameRequestTabId: 'tab-1',
        renameRequestPaneId: 'pane-1',
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={leafNode} />,
        store
      )

      const renameInput = await screen.findByLabelText('Rename pane')
      fireEvent.change(renameInput, { target: { value: 'Ops desk' } })
      fireEvent.blur(renameInput)

      await waitFor(() => {
        expect(mockApiPatch).toHaveBeenCalledWith('/api/panes/pane-1', { name: 'Ops desk' })
      })
      expect(await screen.findByLabelText('Rename pane')).toHaveValue('Ops desk')
      expect(screen.getByRole('alert')).toHaveTextContent('pane not found')
      expect(store.getState().panes.paneTitles['tab-1']?.['pane-1']).toBe('Shell')
      expect(store.getState().tabs.tabs[0].title).toBe('Tab 1')
    })

    it('does not update local pane titles when the pane rename API rejects the request', async () => {
      mockApiPatch.mockRejectedValueOnce(new Error('name must be 500 characters or fewer'))

      const leafNode: PaneNode = {
        type: 'leaf',
        id: 'pane-1',
        content: createTerminalContent({ terminalId: 'term-1' }),
      }

      const store = createStore({
        layouts: { 'tab-1': leafNode },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: { 'tab-1': { 'pane-1': 'Shell' } },
        renameRequestTabId: 'tab-1',
        renameRequestPaneId: 'pane-1',
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={leafNode} />,
        store
      )

      const renameInput = await screen.findByLabelText('Rename pane')
      fireEvent.change(renameInput, { target: { value: 'x'.repeat(600) } })
      fireEvent.blur(renameInput)

      await waitFor(() => {
        expect(mockApiPatch).toHaveBeenCalledWith('/api/panes/pane-1', { name: 'x'.repeat(600) })
      })
      expect(store.getState().panes.paneTitles['tab-1']?.['pane-1']).toBe('Shell')
      expect(store.getState().tabs.tabs[0].title).toBe('Tab 1')
    })

    it('keeps the rename editor open with the typed value when the pane rename API rejects the request', async () => {
      mockApiPatch.mockRejectedValueOnce(new Error('name must be 500 characters or fewer'))

      const leafNode: PaneNode = {
        type: 'leaf',
        id: 'pane-1',
        content: createTerminalContent({ terminalId: 'term-1' }),
      }

      const store = createStore({
        layouts: { 'tab-1': leafNode },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: { 'tab-1': { 'pane-1': 'Shell' } },
        renameRequestTabId: 'tab-1',
        renameRequestPaneId: 'pane-1',
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={leafNode} />,
        store
      )

      const renameInput = await screen.findByLabelText('Rename pane')
      fireEvent.change(renameInput, { target: { value: 'x'.repeat(600) } })
      fireEvent.blur(renameInput)

      await waitFor(() => {
        expect(mockApiPatch).toHaveBeenCalledWith('/api/panes/pane-1', { name: 'x'.repeat(600) })
      })
      expect(await screen.findByLabelText('Rename pane')).toHaveValue('x'.repeat(600))
      expect(screen.getByRole('alert')).toHaveTextContent('name must be 500 characters or fewer')
      expect(store.getState().panes.paneTitles['tab-1']?.['pane-1']).toBe('Shell')
    })
  })

  describe('pane close behavior', () => {
    it('closes the pane from Redux state when close button is clicked', () => {
      const pane1Id = 'pane-1'
      const pane2Id = 'pane-2'

      const rootNode: PaneNode = {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          {
            type: 'leaf',
            id: pane1Id,
            content: createTerminalContent({ terminalId: 'term-123' }),
          },
          {
            type: 'leaf',
            id: pane2Id,
            content: createTerminalContent({ terminalId: 'term-456' }),
          },
        ],
      }

      const store = createStore({
        layouts: { 'tab-1': rootNode },
        activePane: { 'tab-1': pane1Id },
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={rootNode} />,
        store
      )

      // Click the close button on the first pane
      const closeButtons = screen.getAllByTitle('Close pane')
      fireEvent.click(closeButtons[0])

      // Verify the pane was removed from state (layout should collapse to single leaf)
      const state = store.getState().panes
      expect(state.layouts['tab-1'].type).toBe('leaf')
      expect((state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).id).toBe(pane2Id)
    })

    it('shows close button for single pane (root is leaf)', () => {
      const paneId = 'pane-1'
      const leafNode: PaneNode = {
        type: 'leaf',
        id: paneId,
        content: createTerminalContent(),
      }

      const store = createStore({
        layouts: { 'tab-1': leafNode },
        activePane: { 'tab-1': paneId },
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={leafNode} />,
        store
      )

      // Header is always visible, including single-pane tabs.
      expect(screen.getByTitle('Close pane')).toBeInTheDocument()
    })

    it('closes second pane when its close button is clicked', () => {
      const pane1Id = 'pane-1'
      const pane2Id = 'pane-2'

      const rootNode: PaneNode = {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          {
            type: 'leaf',
            id: pane1Id,
            content: createTerminalContent({ terminalId: 'term-111' }),
          },
          {
            type: 'leaf',
            id: pane2Id,
            content: createTerminalContent({ terminalId: 'term-222' }),
          },
        ],
      }

      const store = createStore({
        layouts: { 'tab-1': rootNode },
        activePane: { 'tab-1': pane1Id },
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={rootNode} />,
        store
      )

      // Click the close button on the second pane
      const closeButtons = screen.getAllByTitle('Close pane')
      fireEvent.click(closeButtons[1])

      // First pane should remain
      const state = store.getState().panes
      expect(state.layouts['tab-1'].type).toBe('leaf')
      expect((state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).id).toBe(pane1Id)
    })

    it('sends freshAgent.kill when a fresh-agent pane is closed', () => {
      const node: PaneNode = {
        type: 'leaf',
        id: 'pane-fresh-agent',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshcodex',
          provider: 'codex',
          createRequestId: 'req-fresh-close',
          sessionId: 'thread-codex-1',
          status: 'connected',
        },
      }

      const store = createStore(
        {
          layouts: { 'tab-1': node },
          activePane: { 'tab-1': 'pane-fresh-agent' },
        },
      )

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store,
      )

      fireEvent.click(screen.getByRole('button', { name: /close pane/i }))

      expect(mockSend).toHaveBeenCalledWith({
        type: 'freshAgent.kill',
        sessionId: 'thread-codex-1',
        sessionType: 'freshcodex',
        provider: 'codex',
      })
    })

    it('sends the pane cwd when a FreshOpenCode pane is closed', () => {
      const node: PaneNode = {
        type: 'leaf',
        id: 'pane-freshopencode',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshopencode',
          provider: 'opencode',
          createRequestId: 'req-freshopencode-close',
          sessionId: 'ses_freshopencode_close',
          initialCwd: '/repo/route-aware',
          status: 'connected',
        },
      }

      const store = createStore(
        {
          layouts: { 'tab-1': node },
          activePane: { 'tab-1': 'pane-freshopencode' },
        },
      )

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store,
      )

      fireEvent.click(screen.getByRole('button', { name: /close pane/i }))

      expect(mockSend).toHaveBeenCalledWith({
        type: 'freshAgent.kill',
        sessionId: 'ses_freshopencode_close',
        sessionType: 'freshopencode',
        provider: 'opencode',
        cwd: '/repo/route-aware',
      })
    })

    it('uses session-state cwd when closing a recovered FreshOpenCode pane without initialCwd', () => {
      const node: PaneNode = {
        type: 'leaf',
        id: 'pane-freshopencode',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshopencode',
          provider: 'opencode',
          createRequestId: 'req-freshopencode-close',
          sessionId: 'ses_freshopencode_close',
          status: 'connected',
        },
      }

      const store = createStore(
        {
          layouts: { 'tab-1': node },
          activePane: { 'tab-1': 'pane-freshopencode' },
        },
        {},
        {},
        {
          sessions: {
            'freshopencode:opencode:ses_freshopencode_close': {
              sessionType: 'freshopencode',
              provider: 'opencode',
              sessionId: 'ses_freshopencode_close',
              cwd: '/repo/session-state',
              pendingPermissions: {},
              pendingQuestions: {},
            },
          },
        } as Partial<FreshAgentState>,
      )

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store,
      )

      fireEvent.click(screen.getByRole('button', { name: /close pane/i }))

      expect(mockSend).toHaveBeenCalledWith({
        type: 'freshAgent.kill',
        sessionId: 'ses_freshopencode_close',
        sessionType: 'freshopencode',
        provider: 'opencode',
        cwd: '/repo/session-state',
      })
    })

    it('cancels a pending fresh-agent create when the pane closes before session creation finishes', () => {
      const node: PaneNode = {
        type: 'leaf',
        id: 'pane-fresh-agent-pending',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshcodex',
          provider: 'codex',
          createRequestId: 'req-fresh-pending',
          status: 'creating',
        },
      }

      const store = createStore(
        {
          layouts: { 'tab-1': node },
          activePane: { 'tab-1': 'pane-fresh-agent-pending' },
        },
        {},
        {},
        {
          pendingCreates: {
            'req-fresh-pending': {
              sessionId: undefined,
              expectsHistoryHydration: false,
            },
          },
        } as Partial<FreshAgentState>,
      )

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store,
      )

      fireEvent.click(screen.getByRole('button', { name: /close pane/i }))

      expect(cancelCreateSpy).toHaveBeenCalledWith('req-fresh-pending')
      expect(cancelWsCreateSpy).toHaveBeenCalledWith('req-fresh-pending')
      expect(mockSend).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'freshAgent.kill' }))
    })

    it('updates active pane when closing the active pane', () => {
      const pane1Id = 'pane-1'
      const pane2Id = 'pane-2'

      const rootNode: PaneNode = {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          {
            type: 'leaf',
            id: pane1Id,
            content: createTerminalContent(),
          },
          {
            type: 'leaf',
            id: pane2Id,
            content: createTerminalContent(),
          },
        ],
      }

      const store = createStore({
        layouts: { 'tab-1': rootNode },
        activePane: { 'tab-1': pane1Id },
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={rootNode} />,
        store
      )

      // Close the active pane (pane1)
      const closeButtons = screen.getAllByTitle('Close pane')
      fireEvent.click(closeButtons[0])

      // Active pane should switch to the remaining pane
      const state = store.getState().panes
      expect(state.activePane['tab-1']).toBe(pane2Id)
    })
  })

  describe('rendering leaf pane', () => {
    it('renders terminal content for leaf node', () => {
      const paneId = 'pane-1'
      const leafNode: PaneNode = {
        type: 'leaf',
        id: paneId,
        content: createTerminalContent(),
      }

      const store = createStore({
        layouts: { 'tab-1': leafNode },
        activePane: { 'tab-1': paneId },
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={leafNode} />,
        store
      )

      expect(screen.getByTestId(`terminal-${paneId}`)).toBeInTheDocument()
    })

    it('marks an opencode pane busy when the exact terminal has live activity', () => {
      const paneId = 'pane-1'
      const leafNode: PaneNode = {
        type: 'leaf',
        id: paneId,
        content: createTerminalContent({
          mode: 'opencode',
          status: 'running',
          createRequestId: 'req-pane-1',
          terminalId: 'term-opencode',
        }),
      }

      const store = createStore({
        layouts: { 'tab-1': leafNode },
        activePane: { 'tab-1': paneId },
      })
      store.dispatch(upsertOpencodeActivity({
        terminals: [{
          terminalId: 'term-opencode',
          sessionId: 'session-opencode',
          phase: 'busy',
          updatedAt: 10,
        }],
      }))

      renderWithStore(
        <PaneContainer tabId="tab-1" node={leafNode} />,
        store
      )

      const pane = screen.getByRole('group', { name: /pane: opencode/i })
      expect(pane.querySelector('svg.text-blue-500')).toBeTruthy()
    })

    it('renders browser content for leaf node', () => {
      const paneId = 'pane-1'
      const browserContent: PaneContent = {
        kind: 'browser',
        browserInstanceId: 'browser-1',
        url: 'https://example.com',
        devToolsOpen: false,
      }
      const leafNode: PaneNode = {
        type: 'leaf',
        id: paneId,
        content: browserContent,
      }

      const store = createStore({
        layouts: { 'tab-1': leafNode },
        activePane: { 'tab-1': paneId },
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={leafNode} />,
        store
      )

      expect(screen.getByTestId(`browser-${paneId}`)).toBeInTheDocument()
      expect(screen.getByText('Browser: https://example.com')).toBeInTheDocument()
      expect(screen.getByTestId(`browser-${paneId}`)).toHaveAttribute('data-browser-instance-id', 'browser-1')
    })

    it('remounts browser runtime when browserInstanceId changes under the same pane id', () => {
      const paneId = 'pane-1'
      const initialNode: PaneNode = {
        type: 'leaf',
        id: paneId,
        content: {
          kind: 'browser',
          browserInstanceId: 'browser-1',
          url: 'https://example.com',
          devToolsOpen: false,
        },
      }
      const nextNode: PaneNode = {
        type: 'leaf',
        id: paneId,
        content: {
          kind: 'browser',
          browserInstanceId: 'browser-2',
          url: 'https://example.org',
          devToolsOpen: false,
        },
      }

      const store = createStore({
        layouts: { 'tab-1': initialNode },
        activePane: { 'tab-1': paneId },
      })

      const { rerender } = renderWithStore(
        <PaneContainer tabId="tab-1" node={initialNode} />,
        store
      )

      rerender(
        <Provider store={store}>
          <PaneContainer tabId="tab-1" node={nextNode} />
        </Provider>
      )

      expect(browserPaneMounts).toEqual(['browser-1', 'browser-2'])
      expect(browserPaneUnmounts).toContain('browser-1')
      expect(screen.getByTestId(`browser-${paneId}`)).toHaveAttribute('data-browser-instance-id', 'browser-2')
    })
  })

  describe('rendering split pane', () => {
    it('renders both children in a split', () => {
      const pane1Id = 'pane-1'
      const pane2Id = 'pane-2'

      const rootNode: PaneNode = {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          {
            type: 'leaf',
            id: pane1Id,
            content: createTerminalContent(),
          },
          {
            type: 'leaf',
            id: pane2Id,
            content: createTerminalContent(),
          },
        ],
      }

      const store = createStore({
        layouts: { 'tab-1': rootNode },
        activePane: { 'tab-1': pane1Id },
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={rootNode} />,
        store
      )

      expect(screen.getByTestId(`terminal-${pane1Id}`)).toBeInTheDocument()
      expect(screen.getByTestId(`terminal-${pane2Id}`)).toBeInTheDocument()
    })
  })

  describe('focus handling', () => {
    it('updates active pane when pane is clicked', () => {
      const pane1Id = 'pane-1'
      const pane2Id = 'pane-2'

      const rootNode: PaneNode = {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          {
            type: 'leaf',
            id: pane1Id,
            content: createTerminalContent(),
          },
          {
            type: 'leaf',
            id: pane2Id,
            content: createTerminalContent(),
          },
        ],
      }

      const store = createStore({
        layouts: { 'tab-1': rootNode },
        activePane: { 'tab-1': pane1Id },
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={rootNode} />,
        store
      )

      // Initially pane1 is active
      expect(store.getState().panes.activePane['tab-1']).toBe(pane1Id)

      // MouseDown on the second pane's terminal (we use mouseDown not click because
      // xterm.js may capture click events and prevent them from bubbling)
      const secondTerminal = screen.getByTestId(`terminal-${pane2Id}`)
      fireEvent.mouseDown(secondTerminal)

      // Now pane2 should be active
      expect(store.getState().panes.activePane['tab-1']).toBe(pane2Id)
    })
  })

  describe('hidden prop propagation', () => {
    it('passes hidden=true to TerminalView', () => {
      const paneId = 'pane-1'
      const leafNode: PaneNode = {
        type: 'leaf',
        id: paneId,
        content: createTerminalContent(),
      }

      const store = createStore({
        layouts: { 'tab-1': leafNode },
        activePane: { 'tab-1': paneId },
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={leafNode} hidden={true} />,
        store
      )

      // The mock TerminalView should have received hidden=true
      expect(mockTerminalView).toHaveBeenLastCalledWith(
        expect.objectContaining({ hidden: true }),
        expect.anything()
      )
    })

    it('passes hidden=false to TerminalView when not hidden', () => {
      const paneId = 'pane-1'
      const leafNode: PaneNode = {
        type: 'leaf',
        id: paneId,
        content: createTerminalContent(),
      }

      const store = createStore({
        layouts: { 'tab-1': leafNode },
        activePane: { 'tab-1': paneId },
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={leafNode} hidden={false} />,
        store
      )

      expect(mockTerminalView).toHaveBeenLastCalledWith(
        expect.objectContaining({ hidden: false }),
        expect.anything()
      )
    })

    it('propagates hidden through nested splits', () => {
      const rootNode: PaneNode = {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          { type: 'leaf', id: 'pane-1', content: createTerminalContent() },
          { type: 'leaf', id: 'pane-2', content: createTerminalContent() },
        ],
      }

      const store = createStore({
        layouts: { 'tab-1': rootNode },
        activePane: { 'tab-1': 'pane-1' },
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={rootNode} hidden={true} />,
        store
      )

      // Both terminals should receive hidden=true
      const calls = mockTerminalView.mock.calls
      expect(calls.length).toBe(2)
      expect(calls[0][0]).toMatchObject({ hidden: true })
      expect(calls[1][0]).toMatchObject({ hidden: true })
    })
  })

  describe('pane title rendering', () => {
    it('passes explicit pane title to Pane component', () => {
      const layout: PaneNode = {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          { type: 'leaf', id: 'pane-1', content: createTerminalContent({ mode: 'shell' }) },
          { type: 'leaf', id: 'pane-2', content: createTerminalContent({ mode: 'shell' }) },
        ],
      }

      const store = createStore({
        layouts: { 'tab-1': layout },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: { 'tab-1': { 'pane-1': 'First Terminal', 'pane-2': 'Second Terminal' } },
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={layout} />,
        store
      )

      expect(screen.getByText('First Terminal')).toBeInTheDocument()
      expect(screen.getByText('Second Terminal')).toBeInTheDocument()
    })

    it('shows derived title when no explicit title is set', () => {
      const layout: PaneNode = {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          { type: 'leaf', id: 'pane-1', content: createTerminalContent({ mode: 'claude' }) },
          { type: 'leaf', id: 'pane-2', content: createTerminalContent({ mode: 'shell' }) },
        ],
      }

      const store = createStore({
        layouts: { 'tab-1': layout },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {}, // No explicit titles
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={layout} />,
        store
      )

      expect(screen.getByText('Claude CLI')).toBeInTheDocument()
      expect(screen.getByText('Shell')).toBeInTheDocument()
    })
  })

  describe('rendering editor pane', () => {
    it('renders a loading shell before resolving EditorPane for editor content', async () => {
      const editorContent: EditorPaneContent = {
        kind: 'editor',
        filePath: '/test.ts',
        language: 'typescript',
        readOnly: false,
        content: 'code',
        viewMode: 'source',
      }

      const node: PaneNode = {
        type: 'leaf',
        id: 'pane-1',
        content: editorContent,
      }

      const store = createStore({
        layouts: { 'tab-1': node },
        activePane: { 'tab-1': 'pane-1' },
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store
      )

      const loadingShell = screen.queryByTestId('editor-pane-loading')
      if (loadingShell) {
        expect(loadingShell).toBeInTheDocument()
        expect(screen.getByRole('status')).toHaveTextContent('Loading editor...')
      }
      expect(await screen.findByTestId('monaco-mock')).toBeInTheDocument()
    })

    it('renders word wrap toggle and dispatches wordWrap update to store when clicked', async () => {
      const editorContent: EditorPaneContent = {
        kind: 'editor',
        filePath: '/test.ts',
        language: 'typescript',
        readOnly: false,
        content: 'code',
        viewMode: 'source',
        wordWrap: true,
      }

      const node: PaneNode = {
        type: 'leaf',
        id: 'pane-1',
        content: editorContent,
      }

      const store = createStore({
        layouts: { 'tab-1': node },
        activePane: { 'tab-1': 'pane-1' },
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store
      )

      expect(await screen.findByTestId('monaco-mock')).toBeInTheDocument()

      const wrapButton = screen.getByRole('button', { name: /disable line wrap/i })
      expect(wrapButton).toBeInTheDocument()

      fireEvent.click(wrapButton)

      await waitFor(() => {
        const state = store.getState()
        const layout = state.panes.layouts['tab-1']
        expect(layout).toBeDefined()
        if (layout?.type === 'leaf') {
          const content = layout.content
          if (content.kind === 'editor') {
            expect(content.wordWrap).toBe(false)
          }
        }
      })
    })
  })

  describe('PickerWrapper shell type handling', () => {
    // Helper to create a picker pane
    function createPickerNode(paneId: string): PaneNode {
      return {
        type: 'leaf',
        id: paneId,
        content: { kind: 'picker' },
      }
    }

    // Helper to find the picker container (the div with tabIndex for scoped shortcuts)
    function getPickerContainer() {
      const container = document.querySelector('[data-context="pane-picker"]')
      if (!container) throw new Error('Picker container not found')
      return container
    }

    it('creates terminal with shell=cmd when cmd is selected', () => {
      const node = createPickerNode('pane-1')
      const store = createStore(
        { layouts: { 'tab-1': node }, activePane: { 'tab-1': 'pane-1' } },
        { platform: 'win32' }
      )

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store
      )

      const container = getPickerContainer()
      // Press 'c' key for CMD on the picker container (shortcuts are scoped)
      fireEvent.keyDown(container, { key: 'c' })

      // Wait for transition to complete (the picker has a fade animation)
      fireEvent.transitionEnd(container)

      // Verify the pane content was updated with shell=cmd
      const state = store.getState().panes
      const paneContent = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).content
      expect(paneContent.kind).toBe('terminal')
      if (paneContent.kind === 'terminal') {
        expect(paneContent.shell).toBe('cmd')
        expect(paneContent.mode).toBe('shell')
        expect(paneContent.status).toBe('creating')
        expect(paneContent.createRequestId).toBeDefined()
      }
    })

    it('creates terminal with shell=powershell when powershell is selected', () => {
      const node = createPickerNode('pane-1')
      const store = createStore(
        { layouts: { 'tab-1': node }, activePane: { 'tab-1': 'pane-1' } },
        { platform: 'win32' }
      )

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store
      )

      const container = getPickerContainer()
      fireEvent.keyDown(container, { key: 'p' })
      fireEvent.transitionEnd(container)

      // Verify the pane content was updated with shell=powershell
      const state = store.getState().panes
      const paneContent = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).content
      expect(paneContent.kind).toBe('terminal')
      if (paneContent.kind === 'terminal') {
        expect(paneContent.shell).toBe('powershell')
        expect(paneContent.mode).toBe('shell')
        expect(paneContent.status).toBe('creating')
      }
    })

    it('creates terminal with shell=wsl when wsl is selected', () => {
      const node = createPickerNode('pane-1')
      const store = createStore(
        { layouts: { 'tab-1': node }, activePane: { 'tab-1': 'pane-1' } },
        { platform: 'win32' }
      )

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store
      )

      const container = getPickerContainer()
      fireEvent.keyDown(container, { key: 'w' })
      fireEvent.transitionEnd(container)

      // Verify the pane content was updated with shell=wsl
      const state = store.getState().panes
      const paneContent = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).content
      expect(paneContent.kind).toBe('terminal')
      if (paneContent.kind === 'terminal') {
        expect(paneContent.shell).toBe('wsl')
        expect(paneContent.mode).toBe('shell')
        expect(paneContent.status).toBe('creating')
      }
    })

    function createStoreWithClaude(
      node: PaneNode,
      providerSettings?: { cwd?: string; permissionMode?: 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions' },
      providerSettingsByName?: Record<string, { cwd?: string; permissionMode?: string; model?: string; effort?: string }>,
      enabledProviders: string[] = ['claude'],
      availableClis: Record<string, boolean> = { claude: true },
      freshAgentProviderSettingsByName?: Record<string, { effort?: string }>,
    ) {
      return configureStore({
        reducer: {
          panes: panesReducer,
          tabs: tabsReducer,
          settings: settingsReducer,
          connection: connectionReducer,
          extensions: extensionsReducer,
          terminalMeta: terminalMetaReducer,
          turnCompletion: turnCompletionReducer,
        },
        preloadedState: {
          panes: {
            layouts: { 'tab-1': node },
            activePane: { 'tab-1': 'pane-1' },
            paneTitles: {},
            paneTitleSetByUser: {},
            renameRequestTabId: null,
            renameRequestPaneId: null,
            zoomedPane: {},
          },
          tabs: {
            tabs: [{ id: 'tab-1', createRequestId: 'tab-1', title: 'Tab 1', mode: 'shell' as const, status: 'running' as const, createdAt: 1 }],
            activeTabId: 'tab-1',
          },
          extensions: {
            entries: defaultCliExtensions,
          },
          connection: {
            status: 'ready' as const,
            platform: 'linux',
            availableClis,
          },
          settings: {
            settings: {
              theme: 'system' as const,
              uiScale: 1,
              terminal: {
                fontSize: 14,
                fontFamily: 'monospace',
                lineHeight: 1.2,
                cursorBlink: true,
                scrollback: 5000,
                theme: 'auto' as const,
              },
              safety: { autoKillIdleMinutes: 180 },
              sidebar: { sortMode: 'activity' as const, showProjectBadges: true, width: 288, collapsed: false },
              panes: { defaultNewPane: 'ask' as const },
              codingCli: {
                enabledProviders: enabledProviders as any[],
                providers: providerSettingsByName ?? (providerSettings ? { claude: providerSettings } : {}),
              },
              freshAgent: {
                enabled: true,
                providers: freshAgentProviderSettingsByName ?? {},
              },
              logging: { debug: false },
            },
            loaded: true,
            lastSavedAt: null,
          },
          terminalMeta: {
            byTerminalId: {},
          },
        },
      })
    }

    it('shows directory picker after coding CLI selection', () => {
      const node = createPickerNode('pane-1')
      const store = createStoreWithClaude(node, { cwd: '/home/user/projects' })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store
      )

      const container = getPickerContainer()
      fireEvent.keyDown(container, { key: 'l' })
      fireEvent.transitionEnd(container)

      const input = screen.getByLabelText('Starting directory for Claude CLI') as HTMLInputElement
      expect(input.value).toBe('/home/user/projects')

      const state = store.getState().panes
      const paneContent = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).content
      expect(paneContent.kind).toBe('picker')
    })

    it('creates terminal on directory confirm and persists provider cwd through saveServerSettingsPatch', async () => {
      const node = createPickerNode('pane-1')
      const store = createStoreWithClaude(node, { cwd: '/home/user/projects', permissionMode: 'plan' })
      mockApiPost.mockResolvedValueOnce({ valid: true, resolvedPath: '/home/user/new-project' })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store
      )

      const container = getPickerContainer()
      fireEvent.keyDown(container, { key: 'l' })
      fireEvent.transitionEnd(container)

      const input = screen.getByLabelText('Starting directory for Claude CLI')
      fireEvent.change(input, { target: { value: '/home/user/new-project' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        const state = store.getState().panes
        const paneContent = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).content
        expect(paneContent.kind).toBe('terminal')
        if (paneContent.kind === 'terminal') {
          expect(paneContent.mode).toBe('claude')
          expect(paneContent.initialCwd).toBe('/home/user/new-project')
          expect(paneContent.status).toBe('creating')
        }
      })

      expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
        codingCli: { providers: { claude: { permissionMode: 'plan', cwd: '/home/user/new-project' } } },
      })
      expect(mockApiPatch).not.toHaveBeenCalledWith('/api/settings', expect.anything())
    })

    it('persists Freshcodex directory under the Codex runtime provider key', async () => {
      const node = createPickerNode('pane-1')
      const store = createStoreWithClaude(node, undefined, undefined, ['claude', 'codex'], { claude: true, codex: true })
      mockApiPost.mockResolvedValueOnce({ valid: true, resolvedPath: '/home/user/freshcodex-project' })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store
      )

      fireEvent.click(screen.getByRole('button', { name: 'Freshcodex' }))
      fireEvent.transitionEnd(getPickerContainer())

      const input = screen.getByLabelText('Starting directory for Freshcodex')
      fireEvent.change(input, { target: { value: '/home/user/freshcodex-project' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        const state = store.getState().panes
        const paneContent = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).content
        expect(paneContent.kind).toBe('fresh-agent')
        if (paneContent.kind === 'fresh-agent') {
          expect(paneContent.sessionType).toBe('freshcodex')
          expect(paneContent.provider).toBe('codex')
          expect(paneContent.initialCwd).toBe('/home/user/freshcodex-project')
          expect(paneContent.model).toBe('gpt-5.5')
          expect(paneContent.effort).toBe('max')
        }
      })

      expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
        codingCli: { providers: { codex: { cwd: '/home/user/freshcodex-project' } } },
      })
      expect(saveServerSettingsPatchSpy).not.toHaveBeenCalledWith(expect.objectContaining({
        codingCli: { providers: expect.objectContaining({ freshcodex: expect.anything() }) },
      }))
    })

    it('normalizes stale Freshcodex effort from provider settings against the active model', async () => {
      const node = createPickerNode('pane-1')
      const store = createStoreWithClaude(
        node,
        undefined,
        { codex: { model: 'gpt-5.4-flash' } },
        ['claude', 'codex'],
        { claude: true, codex: true },
        { freshcodex: { effort: 'xhigh' } },
      )
      mockApiPost.mockResolvedValueOnce({ valid: true, resolvedPath: '/home/user/freshcodex-project' })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store
      )

      fireEvent.click(screen.getByRole('button', { name: 'Freshcodex' }))
      fireEvent.transitionEnd(getPickerContainer())

      const input = screen.getByLabelText('Starting directory for Freshcodex')
      fireEvent.change(input, { target: { value: '/home/user/freshcodex-project' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        const state = store.getState().panes
        const paneContent = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).content
        expect(paneContent.kind).toBe('fresh-agent')
        if (paneContent.kind === 'fresh-agent') {
          expect(paneContent.model).toBe('gpt-5.4-flash')
          expect(paneContent.effort).toBe('high')
        }
      })
    })

    it('enables Freshopencode from the picker with OpenCode defaults', async () => {
      const node = createPickerNode('pane-1')
      const store = createStoreWithClaude(node, undefined, undefined, ['claude', 'opencode'], { claude: true, opencode: true })
      mockApiPost.mockResolvedValueOnce({ valid: true, resolvedPath: '/home/user/freshopencode-project' })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store
      )

      fireEvent.click(screen.getByRole('button', { name: 'Freshopencode' }))
      fireEvent.transitionEnd(getPickerContainer())

      const input = screen.getByLabelText('Starting directory for Freshopencode')
      fireEvent.change(input, { target: { value: '/home/user/freshopencode-project' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        const state = store.getState().panes
        const paneContent = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).content
        expect(paneContent.kind).toBe('fresh-agent')
        if (paneContent.kind === 'fresh-agent') {
          expect(paneContent.sessionType).toBe('freshopencode')
          expect(paneContent.provider).toBe('opencode')
          expect(paneContent.initialCwd).toBe('/home/user/freshopencode-project')
          expect(paneContent.model).toBe('opencode-go/deepseek-v4-flash')
          expect(paneContent.effort).toBe('max')
          expect(paneContent.permissionMode).toBeUndefined()
        }
      })

      expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
        codingCli: { providers: { opencode: { cwd: '/home/user/freshopencode-project' } } },
      })
    })

    it('preloads Freshcodex directory from the Codex runtime provider key', () => {
      const node = createPickerNode('pane-1')
      const store = createStoreWithClaude(node, undefined, {
        codex: { cwd: '/home/user/saved-codex-cwd' },
        freshcodex: { cwd: '/home/user/wrong-freshcodex-cwd' },
      }, ['claude', 'codex'], { claude: true, codex: true })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store
      )

      fireEvent.click(screen.getByRole('button', { name: 'Freshcodex' }))
      fireEvent.transitionEnd(getPickerContainer())

      expect(screen.getByLabelText('Starting directory for Freshcodex')).toHaveValue('/home/user/saved-codex-cwd')
    })

    it('returns to pane type picker when back is clicked in directory picker', () => {
      const node = createPickerNode('pane-1')
      const store = createStoreWithClaude(node)

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store
      )

      const container = getPickerContainer()
      fireEvent.keyDown(container, { key: 'l' })
      fireEvent.transitionEnd(container)

      fireEvent.click(screen.getByRole('button', { name: 'Back' }))

      expect(screen.getByRole('toolbar', { name: 'Pane type picker' })).toBeInTheDocument()
    })

    it('creates terminal with shell=system when shell is selected (non-Windows)', () => {
      const node = createPickerNode('pane-1')
      const store = createStore(
        { layouts: { 'tab-1': node }, activePane: { 'tab-1': 'pane-1' } },
        { platform: 'linux' }
      )

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store
      )

      const container = getPickerContainer()
      fireEvent.keyDown(container, { key: 's' })
      fireEvent.transitionEnd(container)

      // Verify the pane content was updated with shell=system
      const state = store.getState().panes
      const paneContent = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).content
      expect(paneContent.kind).toBe('terminal')
      if (paneContent.kind === 'terminal') {
        expect(paneContent.shell).toBe('system')
        expect(paneContent.mode).toBe('shell')
        expect(paneContent.status).toBe('creating')
      }
    })

    it('pre-fills directory picker with tab-preferred cwd instead of global default', () => {
      // Tab already has a Claude CLI pane working in /code/tab-project
      const existingClaude: PaneNode = {
        type: 'leaf',
        id: 'pane-existing',
        content: {
          kind: 'terminal',
          mode: 'claude',
          shell: 'system',
          createRequestId: 'cr-existing',
          status: 'running',
          terminalId: 'term-existing',
          initialCwd: '/code/tab-project',
        },
      }
      const pickerNode: PaneNode = {
        type: 'leaf',
        id: 'pane-1',
        content: { kind: 'picker' },
      }
      const splitNode: PaneNode = {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [existingClaude, pickerNode],
      }

      // Global provider default is /code/global-default — should NOT be used
      const store = createStoreWithClaude(splitNode, { cwd: '/code/global-default' })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={splitNode} />,
        store
      )

      // Navigate to directory picker by selecting Claude CLI
      const container = document.querySelector('[data-context="pane-picker"]')!
      fireEvent.keyDown(container, { key: 'l' })
      fireEvent.transitionEnd(container)

      // The input should pre-fill with the tab's directory, not the global default
      const input = screen.getByLabelText('Starting directory for Claude CLI') as HTMLInputElement
      expect(input.value).toBe('/code/tab-project')
    })
  })

  describe('attention clearing on pane focus (click mode)', () => {
    function createAttentionStore(opts: {
      activePane: string
      attentionPanes?: string[]
      attentionTabs?: string[]
      attentionDismiss?: 'click' | 'type'
    }) {
      const store = configureStore({
        reducer: {
          panes: panesReducer,
          tabs: tabsReducer,
          settings: settingsReducer,
          connection: connectionReducer,
          extensions: extensionsReducer,
          terminalMeta: terminalMetaReducer,
          turnCompletion: turnCompletionReducer,
        },
        preloadedState: {
          panes: {
            layouts: {
              'tab-1': {
                type: 'split',
                id: 'split-1',
                direction: 'horizontal',
                sizes: [50, 50],
                children: [
                  { type: 'leaf', id: 'pane-1', content: createTerminalContent() },
                  { type: 'leaf', id: 'pane-2', content: createTerminalContent() },
                ],
              },
            },
            activePane: { 'tab-1': opts.activePane },
            paneTitles: {},
            paneTitleSetByUser: {},
            renameRequestTabId: null,
            renameRequestPaneId: null,
            zoomedPane: {},
          },
          tabs: {
            tabs: [{ id: 'tab-1', createRequestId: 'tab-1', title: 'Tab 1', mode: 'shell' as const, status: 'running' as const, createdAt: 1 }],
            activeTabId: 'tab-1',
          },
          extensions: { entries: defaultCliExtensions },
          connection: { status: 'disconnected', platform: null, availableClis: {} },
          terminalMeta: { byTerminalId: {} },
          settings: {
            settings: {
              ...defaultSettingsForTest(),
              panes: {
                defaultNewPane: 'ask' as const,
                snapThreshold: 2,
                iconsOnTabs: true,
                tabAttentionStyle: 'highlight' as const,
                attentionDismiss: opts.attentionDismiss ?? 'click' as const,
              },
            },
            loaded: true,
            lastSavedAt: undefined,
          },
        },
      })

      // Set up attention state via dispatches
      for (const paneId of opts.attentionPanes ?? []) {
        store.dispatch(markPaneAttention({ paneId }))
      }
      for (const tabId of opts.attentionTabs ?? []) {
        store.dispatch(markTabAttention({ tabId }))
      }

      return store
    }

    function defaultSettingsForTest() {
      return {
        theme: 'system' as const,
        uiScale: 1,
        terminal: {
          fontSize: 14,
          fontFamily: 'monospace',
          lineHeight: 1.2,
          cursorBlink: true,
          scrollback: 5000,
          theme: 'auto' as const,
        },
        safety: { autoKillIdleMinutes: 180 },
        sidebar: { sortMode: 'activity' as const, showProjectBadges: true, width: 288, collapsed: false },
        codingCli: { enabledProviders: [] as any[], providers: {} },
        logging: { debug: false },
      }
    }

    it('clicking a non-active pane with attention clears pane attention', () => {
      // pane-1 is active, pane-2 has attention
      const store = createAttentionStore({
        activePane: 'pane-1',
        attentionPanes: ['pane-2'],
        attentionTabs: ['tab-1'],
      })

      const rootNode = store.getState().panes.layouts['tab-1']
      renderWithStore(
        <PaneContainer tabId="tab-1" node={rootNode} />,
        store
      )

      // Verify attention is set
      expect(store.getState().turnCompletion.attentionByPane['pane-2']).toBe(true)

      // Click (mouseDown) on the second pane to focus it
      const secondTerminal = screen.getByTestId('terminal-pane-2')
      fireEvent.mouseDown(secondTerminal)

      // Pane attention should be cleared
      expect(store.getState().turnCompletion.attentionByPane['pane-2']).toBeUndefined()
    })

    it('clicking a non-active pane with attention clears tab attention', () => {
      const store = createAttentionStore({
        activePane: 'pane-1',
        attentionPanes: ['pane-2'],
        attentionTabs: ['tab-1'],
      })

      const rootNode = store.getState().panes.layouts['tab-1']
      renderWithStore(
        <PaneContainer tabId="tab-1" node={rootNode} />,
        store
      )

      expect(store.getState().turnCompletion.attentionByTab['tab-1']).toBe(true)

      const secondTerminal = screen.getByTestId('terminal-pane-2')
      fireEvent.mouseDown(secondTerminal)

      // Tab attention should also be cleared — user is actively engaging with the tab
      expect(store.getState().turnCompletion.attentionByTab['tab-1']).toBeUndefined()
    })

    it('clicking the already-active pane with attention clears attention', () => {
      // pane-1 is active AND has attention
      const store = createAttentionStore({
        activePane: 'pane-1',
        attentionPanes: ['pane-1'],
        attentionTabs: ['tab-1'],
      })

      const rootNode = store.getState().panes.layouts['tab-1']
      renderWithStore(
        <PaneContainer tabId="tab-1" node={rootNode} />,
        store
      )

      expect(store.getState().turnCompletion.attentionByPane['pane-1']).toBe(true)

      const firstTerminal = screen.getByTestId('terminal-pane-1')
      fireEvent.mouseDown(firstTerminal)

      expect(store.getState().turnCompletion.attentionByPane['pane-1']).toBeUndefined()
      expect(store.getState().turnCompletion.attentionByTab['tab-1']).toBeUndefined()
    })

    it('clicking a pane without attention does not touch attention state', () => {
      const store = createAttentionStore({
        activePane: 'pane-1',
        attentionPanes: [],
        attentionTabs: [],
      })

      const rootNode = store.getState().panes.layouts['tab-1']
      renderWithStore(
        <PaneContainer tabId="tab-1" node={rootNode} />,
        store
      )

      const secondTerminal = screen.getByTestId('terminal-pane-2')
      fireEvent.mouseDown(secondTerminal)

      // No attention entries should exist
      expect(store.getState().turnCompletion.attentionByPane).toEqual({})
      expect(store.getState().turnCompletion.attentionByTab).toEqual({})
    })

    it('clears attention in type mode', () => {
      const store = createAttentionStore({
        activePane: 'pane-1',
        attentionPanes: ['pane-2'],
        attentionTabs: ['tab-1'],
        attentionDismiss: 'type',
      })

      const rootNode = store.getState().panes.layouts['tab-1']
      renderWithStore(
        <PaneContainer tabId="tab-1" node={rootNode} />,
        store
      )

      const secondTerminal = screen.getByTestId('terminal-pane-2')
      fireEvent.mouseDown(secondTerminal)

      // Pane focus is real engagement, so it clears attention in both modes.
      expect(store.getState().turnCompletion.attentionByPane['pane-2']).toBeUndefined()
      expect(store.getState().turnCompletion.attentionByTab['tab-1']).toBeUndefined()
    })
  })

  describe('FreshClaude runtime metadata', () => {
    it('renders FreshClaude header token usage from the indexed Claude session linked by cliSessionId and does not approximate from SDK totals', async () => {
      const node: PaneNode = {
        type: 'leaf',
        id: 'pane-fresh',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshclaude',
          provider: 'claude',
          createRequestId: 'req-fresh',
          sessionId: 'sdk-session-1',
          status: 'idle',
        },
      }

      const store = createStore(
        {
          layouts: { 'tab-1': node },
          activePane: { 'tab-1': 'pane-fresh' },
        },
        {},
        {
          projects: [
            {
              projectPath: '/home/user/code/freshell',
              sessions: [
                {
                  provider: 'claude',
                  sessionType: 'freshclaude',
                  sessionId: 'claude-session-1',
                  projectPath: '/home/user/code/freshell',
                  cwd: '/home/user/code/freshell/.worktrees/issue-163',
                  gitBranch: 'main',
                  isDirty: true,
                  lastActivityAt: 1,
                  tokenUsage: {
                    inputTokens: 10,
                    outputTokens: 5,
                    cachedTokens: 0,
                    totalTokens: 15,
                    contextTokens: 15,
                    compactThresholdTokens: 60,
                    compactPercent: 25,
                  },
                },
              ],
            },
          ],
        },
        {
          sessions: {
            [makeFreshAgentSessionKey({
              sessionType: 'freshclaude',
              provider: 'claude',
              sessionId: 'sdk-session-1',
            })]: createFreshClaudeSession({
              sessionId: 'sdk-session-1',
              cliSessionId: 'claude-session-1',
              totalInputTokens: 4000,
              totalOutputTokens: 2000,
            }),
          },
        },
      )

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store,
      )

      const meta = screen.getByText(/freshell \(main\*\)\s+25%/)
      expect(meta).toHaveAttribute(
        'title',
        'Directory: /home/user/code/freshell/.worktrees/issue-163\nbranch: main*\nTokens: 15/60(25% full)',
      )

      store.dispatch(turnResult({
        sessionId: 'sdk-session-1',
        sessionType: 'freshclaude',
        provider: 'claude',
        usage: { input_tokens: 999999, output_tokens: 999999 },
      }))

      expect(screen.getByText(/freshell \(main\*\)\s+25%/)).toBeInTheDocument()

      store.dispatch(applySessionsPatch({
        upsertProjects: [],
        removeProjectPaths: ['/home/user/code/freshell'],
      }))

      expect(store.getState().sessions.projects).toEqual([])

      await waitFor(() => {
        expect(screen.queryByText(/freshell \(main\*\)\s+25%/)).not.toBeInTheDocument()
      })

      store.dispatch(turnResult({
        sessionId: 'sdk-session-1',
        sessionType: 'freshclaude',
        provider: 'claude',
        usage: { input_tokens: 500000, output_tokens: 500000 },
      }))

      expect(screen.queryByText(/%$/)).not.toBeInTheDocument()
    })

    it('prefers cliSessionId over resumeSessionId when both identities exist', () => {
      const node: PaneNode = {
        type: 'leaf',
        id: 'pane-fresh',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshclaude',
          provider: 'claude',
          createRequestId: 'req-fresh',
          sessionId: 'sdk-session-1',
          resumeSessionId: 'resume-session-2',
          status: 'idle',
        },
      }

      const store = createStore(
        {
          layouts: { 'tab-1': node },
          activePane: { 'tab-1': 'pane-fresh' },
        },
        {},
        {
          projects: [
            {
              projectPath: '/home/user/code/freshell',
              sessions: [
                {
                  provider: 'claude',
                  sessionType: 'freshclaude',
                  sessionId: 'cli-session-1',
                  projectPath: '/home/user/code/freshell',
                  cwd: '/home/user/code/freshell',
                  gitBranch: 'main',
                  isDirty: true,
                  lastActivityAt: 2,
                  tokenUsage: {
                    inputTokens: 10,
                    outputTokens: 5,
                    cachedTokens: 0,
                    totalTokens: 15,
                    contextTokens: 15,
                    compactThresholdTokens: 60,
                    compactPercent: 25,
                  },
                },
                {
                  provider: 'claude',
                  sessionType: 'freshclaude',
                  sessionId: 'resume-session-2',
                  projectPath: '/home/user/code/freshell',
                  cwd: '/home/user/code/freshell/other',
                  gitBranch: 'stale',
                  isDirty: false,
                  lastActivityAt: 1,
                  tokenUsage: {
                    inputTokens: 1,
                    outputTokens: 1,
                    cachedTokens: 0,
                    totalTokens: 2,
                    contextTokens: 2,
                    compactThresholdTokens: 20,
                    compactPercent: 10,
                  },
                },
              ],
            },
          ],
        },
        {
          sessions: {
            [makeFreshAgentSessionKey({
              sessionType: 'freshclaude',
              provider: 'claude',
              sessionId: 'sdk-session-1',
            })]: createFreshClaudeSession({
              sessionId: 'sdk-session-1',
              cliSessionId: 'cli-session-1',
            }),
          },
        },
      )

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store,
      )

      const meta = screen.getByText(/freshell \(main\*\)\s+25%/)
      expect(meta).toHaveAttribute(
        'title',
        'Directory: /home/user/code/freshell\nbranch: main*\nTokens: 15/60(25% full)',
      )
      expect(screen.queryByText(/other \(stale\)\s+10%/)).not.toBeInTheDocument()
    })

    it('prefers historySessionId over a stale resumeSessionId before cliSessionId exists', () => {
      const node: PaneNode = {
        type: 'leaf',
        id: 'pane-fresh',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshclaude',
          provider: 'claude',
          createRequestId: 'req-fresh',
          sessionId: 'sdk-session-1',
          resumeSessionId: 'resume-session-stale',
          status: 'idle',
        },
      }

      const store = createStore(
        {
          layouts: { 'tab-1': node },
          activePane: { 'tab-1': 'pane-fresh' },
        },
        {},
        {
          projects: [
            {
              projectPath: '/home/user/code/freshell',
              sessions: [
                {
                  provider: 'claude',
                  sessionType: 'freshclaude',
                  sessionId: 'timeline-session-1',
                  projectPath: '/home/user/code/freshell',
                  cwd: '/home/user/code/freshell',
                  gitBranch: 'main',
                  isDirty: true,
                  lastActivityAt: 2,
                  tokenUsage: {
                    inputTokens: 10,
                    outputTokens: 5,
                    cachedTokens: 0,
                    totalTokens: 15,
                    contextTokens: 15,
                    compactThresholdTokens: 60,
                    compactPercent: 25,
                  },
                },
                {
                  provider: 'claude',
                  sessionType: 'freshclaude',
                  sessionId: 'resume-session-stale',
                  projectPath: '/home/user/code/freshell',
                  cwd: '/home/user/code/freshell/other',
                  gitBranch: 'stale',
                  isDirty: false,
                  lastActivityAt: 1,
                  tokenUsage: {
                    inputTokens: 1,
                    outputTokens: 1,
                    cachedTokens: 0,
                    totalTokens: 2,
                    contextTokens: 2,
                    compactThresholdTokens: 20,
                    compactPercent: 10,
                  },
                },
              ],
            },
          ],
        },
        {
          sessions: {
            [makeFreshAgentSessionKey({
              sessionType: 'freshclaude',
              provider: 'claude',
              sessionId: 'sdk-session-1',
            })]: createFreshClaudeSession({
              sessionId: 'sdk-session-1',
              historySessionId: 'timeline-session-1',
            }),
          },
        },
      )

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store,
      )

      const meta = screen.getByText(/freshell \(main\*\)\s+25%/)
      expect(meta).toHaveAttribute(
        'title',
        'Directory: /home/user/code/freshell\nbranch: main*\nTokens: 15/60(25% full)',
      )
      expect(screen.queryByText(/other \(stale\)\s+10%/)).not.toBeInTheDocument()
    })

    it('prefers a canonical cliSessionId over a named historySessionId when both exist', () => {
      const node: PaneNode = {
        type: 'leaf',
        id: 'pane-fresh',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshclaude',
          provider: 'claude',
          createRequestId: 'req-fresh',
          sessionId: 'sdk-session-2',
          resumeSessionId: 'resume-session-stale',
          status: 'idle',
        },
      }

      const store = createStore(
        {
          layouts: { 'tab-1': node },
          activePane: { 'tab-1': 'pane-fresh' },
        },
        {},
        {
          projects: [
            {
              projectPath: '/home/user/code/freshell',
              sessions: [
                {
                  provider: 'claude',
                  sessionType: 'freshclaude',
                  sessionId: '00000000-0000-4000-8000-000000000321',
                  projectPath: '/home/user/code/freshell',
                  cwd: '/home/user/code/freshell',
                  gitBranch: 'main',
                  isDirty: true,
                  lastActivityAt: 2,
                  tokenUsage: {
                    inputTokens: 10,
                    outputTokens: 5,
                    cachedTokens: 0,
                    totalTokens: 15,
                    contextTokens: 15,
                    compactThresholdTokens: 60,
                    compactPercent: 25,
                  },
                },
                {
                  provider: 'claude',
                  sessionType: 'freshclaude',
                  sessionId: 'named-resume',
                  projectPath: '/home/user/code/freshell',
                  cwd: '/home/user/code/freshell/other',
                  gitBranch: 'stale',
                  isDirty: false,
                  lastActivityAt: 1,
                  tokenUsage: {
                    inputTokens: 1,
                    outputTokens: 1,
                    cachedTokens: 0,
                    totalTokens: 2,
                    contextTokens: 2,
                    compactThresholdTokens: 20,
                    compactPercent: 10,
                  },
                },
              ],
            },
          ],
        },
        {
          sessions: {
            [makeFreshAgentSessionKey({
              sessionType: 'freshclaude',
              provider: 'claude',
              sessionId: 'sdk-session-2',
            })]: createFreshClaudeSession({
              sessionId: 'sdk-session-2',
              historySessionId: 'named-resume',
              cliSessionId: '00000000-0000-4000-8000-000000000321',
            }),
          },
        },
      )

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store,
      )

      const meta = screen.getByText(/freshell \(main\*\)\s+25%/)
      expect(meta).toHaveAttribute(
        'title',
        'Directory: /home/user/code/freshell\nbranch: main*\nTokens: 15/60(25% full)',
      )
      expect(screen.queryByText(/other \(stale\)\s+10%/)).not.toBeInTheDocument()
    })

    it('falls back to resumeSessionId for FreshClaude panes before sdk.session.init arrives', () => {
      const node: PaneNode = {
        type: 'leaf',
        id: 'pane-fresh',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshclaude',
          provider: 'claude',
          createRequestId: 'req-fresh',
          status: 'starting',
          resumeSessionId: 'claude-session-restored',
        },
      }

      const store = createStore(
        {
          layouts: { 'tab-1': node },
          activePane: { 'tab-1': 'pane-fresh' },
        },
        {},
        {
          projects: [
            {
              projectPath: '/home/user/code/freshell',
              sessions: [
                {
                  provider: 'claude',
                  sessionType: 'freshclaude',
                  sessionId: 'claude-session-restored',
                  projectPath: '/home/user/code/freshell',
                  cwd: '/home/user/code/freshell/.worktrees/issue-163',
                  gitBranch: 'main',
                  isDirty: false,
                  lastActivityAt: 1,
                  tokenUsage: {
                    inputTokens: 10,
                    outputTokens: 5,
                    cachedTokens: 0,
                    totalTokens: 15,
                    contextTokens: 15,
                    compactThresholdTokens: 60,
                    compactPercent: 25,
                  },
                },
              ],
            },
          ],
        },
        {
          sessions: {},
          pendingCreates: {},
          availableModels: [],
        },
      )

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store,
      )

      expect(screen.getByText(/freshell \(main\)\s+25%/)).toBeInTheDocument()
    })

    it('resolves Claude-backed runtime metadata for fresh-agent kilroy panes', () => {
      const node: PaneNode = {
        type: 'leaf',
        id: 'pane-kilroy-fresh',
        content: {
          kind: 'fresh-agent',
          provider: 'claude',
          sessionType: 'kilroy',
          createRequestId: 'req-kilroy-fresh',
          status: 'starting',
          resumeSessionId: 'kilroy-session-restored',
        },
      }

      const store = createStore(
        {
          layouts: { 'tab-1': node },
          activePane: { 'tab-1': 'pane-kilroy-fresh' },
        },
        {},
        {
          projects: [
            {
              projectPath: '/home/user/code/freshell',
              sessions: [
                {
                  provider: 'claude',
                  sessionType: 'kilroy',
                  sessionId: 'kilroy-session-restored',
                  projectPath: '/home/user/code/freshell',
                  cwd: '/home/user/code/freshell/.worktrees/issue-163',
                  gitBranch: 'main',
                  isDirty: false,
                  lastActivityAt: 1,
                  tokenUsage: {
                    inputTokens: 10,
                    outputTokens: 5,
                    cachedTokens: 0,
                    totalTokens: 15,
                    contextTokens: 15,
                    compactThresholdTokens: 60,
                    compactPercent: 25,
                  },
                },
              ],
            },
          ],
        },
        {
          sessions: {},
          pendingCreates: {},
          availableModels: [],
        },
      )

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store,
      )

      expect(screen.getByTitle('Kilroy session')).toHaveTextContent('Kilroy')
      expect(screen.getByText(/freshell \(main\)\s+25%/)).toBeInTheDocument()
    })

  })

  describe('refresh button integration', () => {
    it('renders refresh button for terminal pane with terminalId', () => {
      const node: PaneNode = {
        type: 'leaf',
        id: 'pane-1',
        content: createTerminalContent({ terminalId: 'term-1', status: 'running', createRequestId: 'cr-1' }),
      }

      const store = createStore({
        layouts: { 'tab-1': node },
        activePane: { 'tab-1': 'pane-1' },
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store,
      )

      expect(screen.getByTitle('Refresh pane')).toBeInTheDocument()
    })

    it('does not render refresh button for terminal pane without terminalId', () => {
      const node: PaneNode = {
        type: 'leaf',
        id: 'pane-1',
        content: createTerminalContent({ terminalId: undefined, status: 'creating', createRequestId: 'cr-1' }),
      }

      const store = createStore({
        layouts: { 'tab-1': node },
        activePane: { 'tab-1': 'pane-1' },
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store,
      )

      expect(screen.queryByTitle('Refresh pane')).toBeNull()
    })

    it('renders refresh button for browser pane with URL', () => {
      const node: PaneNode = {
        type: 'leaf',
        id: 'pane-1',
        content: {
          kind: 'browser',
          browserInstanceId: 'bi-1',
          url: 'https://example.com',
          devToolsOpen: false,
        },
      }

      const store = createStore({
        layouts: { 'tab-1': node },
        activePane: { 'tab-1': 'pane-1' },
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store,
      )

      expect(screen.getByTitle('Refresh pane')).toBeInTheDocument()
    })

    it('does not render refresh button for picker pane', () => {
      const node: PaneNode = {
        type: 'leaf',
        id: 'pane-1',
        content: { kind: 'picker' },
      }

      const store = createStore({
        layouts: { 'tab-1': node },
        activePane: { 'tab-1': 'pane-1' },
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store,
      )

      expect(screen.queryByTitle('Refresh pane')).toBeNull()
    })

    it('renders refresh button for fresh-agent pane with a session id', () => {
      const node: PaneNode = {
        type: 'leaf',
        id: 'pane-1',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshcodex',
          provider: 'codex',
          createRequestId: 'fresh-req-1',
          sessionId: 'fresh-session-1',
          status: 'idle',
        },
      }

      const store = createStore({
        layouts: { 'tab-1': node },
        activePane: { 'tab-1': 'pane-1' },
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store,
      )

      expect(screen.getByTitle('Refresh pane')).toBeInTheDocument()
    })

    it('clicking refresh button dispatches requestPaneRefresh to Redux store', () => {
      const node: PaneNode = {
        type: 'leaf',
        id: 'pane-1',
        content: createTerminalContent({ terminalId: 'term-1', status: 'running', createRequestId: 'cr-1' }),
      }

      const store = createStore({
        layouts: { 'tab-1': node },
        activePane: { 'tab-1': 'pane-1' },
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store,
      )

      fireEvent.click(screen.getByTitle('Refresh pane'))

      const state = store.getState()
      const tabRequests = state.panes.refreshRequestsByPane?.['tab-1']
      expect(tabRequests).toBeDefined()
      expect(tabRequests?.['pane-1']).toBeDefined()
      expect(tabRequests?.['pane-1'].target).toEqual({
        kind: 'terminal',
        createRequestId: 'cr-1',
      })
    })

    it('clicking fresh-agent refresh queues a fresh-agent refresh target', () => {
      const node: PaneNode = {
        type: 'leaf',
        id: 'pane-1',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshcodex',
          provider: 'codex',
          createRequestId: 'fresh-req-1',
          sessionId: 'fresh-session-1',
          status: 'idle',
        },
      }

      const store = createStore({
        layouts: { 'tab-1': node },
        activePane: { 'tab-1': 'pane-1' },
      })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store,
      )

      fireEvent.click(screen.getByTitle('Refresh pane'))

      expect(store.getState().panes.refreshRequestsByPane?.['tab-1']?.['pane-1'].target).toEqual({
        kind: 'fresh-agent',
        createRequestId: 'fresh-req-1',
        sessionId: 'fresh-session-1',
        sessionType: 'freshcodex',
        provider: 'codex',
      })
    })
  })
})
