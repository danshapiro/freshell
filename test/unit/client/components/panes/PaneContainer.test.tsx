import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import PaneContainer from '@/components/panes/PaneContainer'
import panesReducer from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import connectionReducer, { ConnectionState } from '@/store/connectionSlice'
import type { PanesState } from '@/store/panesSlice'
import type { PaneNode, PaneContent, EditorPaneContent } from '@/store/paneTypes'

// Hoist mock functions so vi.mock can reference them
const { mockSend, mockTerminalView } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockTerminalView: vi.fn(({ tabId, paneId, hidden }: { tabId: string; paneId: string; hidden?: boolean }) => (
    <div data-testid={`terminal-${paneId}`} data-hidden={String(hidden)}>Terminal for {tabId}/{paneId}</div>
  )),
}))

// Mock the ws-client module
vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: mockSend,
  }),
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
  FileText: ({ className }: { className?: string }) => (
    <svg data-testid="file-text-icon" className={className} />
  ),
}))

// Mock TerminalView component to avoid xterm.js dependencies
vi.mock('@/components/TerminalView', () => ({
  default: mockTerminalView,
}))

// Mock BrowserPane component
vi.mock('@/components/panes/BrowserPane', () => ({
  default: ({ paneId, url }: { paneId: string; url: string }) => (
    <div data-testid={`browser-${paneId}`}>Browser: {url}</div>
  ),
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

function createStore(
  initialPanesState: Partial<PanesState> = {},
  initialConnectionState: Partial<ConnectionState> = {}
) {
  return configureStore({
    reducer: {
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
    },
    preloadedState: {
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
        ...initialPanesState,
      },
      connection: {
        status: 'disconnected',
        platform: null,
        ...initialConnectionState,
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

    it('does not show close button for single pane (root is leaf)', () => {
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

      // There should be no close button when it's the only pane
      expect(screen.queryByTitle('Close pane')).not.toBeInTheDocument()
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

    it('renders browser content for leaf node', () => {
      const paneId = 'pane-1'
      const browserContent: PaneContent = {
        kind: 'browser',
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

      // Click on the second pane's terminal
      const secondTerminal = screen.getByTestId(`terminal-${pane2Id}`)
      fireEvent.click(secondTerminal)

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

      expect(screen.getByText('Claude')).toBeInTheDocument()
      expect(screen.getByText('Shell')).toBeInTheDocument()
    })
  })

  describe('rendering editor pane', () => {
    it('renders EditorPane for editor content', () => {
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

      // Should render the mocked Monaco editor
      expect(screen.getByTestId('monaco-mock')).toBeInTheDocument()
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

      // Press 'c' key for CMD
      fireEvent.keyDown(document, { key: 'c' })

      // Wait for transition to complete (the picker has a fade animation)
      const picker = screen.getByText('CMD').closest('div[class*="transition"]')
      if (picker) {
        fireEvent.transitionEnd(picker)
      }

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

      // Press 'p' key for PowerShell
      fireEvent.keyDown(document, { key: 'p' })

      // Wait for transition to complete
      const picker = screen.getByText('PowerShell').closest('div[class*="transition"]')
      if (picker) {
        fireEvent.transitionEnd(picker)
      }

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

      // Press 'w' key for WSL
      fireEvent.keyDown(document, { key: 'w' })

      // Wait for transition to complete
      const picker = screen.getByText('WSL').closest('div[class*="transition"]')
      if (picker) {
        fireEvent.transitionEnd(picker)
      }

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

    it('creates terminal with shell=system when shell is selected (non-Windows)', () => {
      const node = createPickerNode('pane-1')
      // For non-Windows, platform will be null (default) which shows 'Shell' option
      const store = createStore(
        { layouts: { 'tab-1': node }, activePane: { 'tab-1': 'pane-1' } },
        { platform: 'linux' }
      )

      renderWithStore(
        <PaneContainer tabId="tab-1" node={node} />,
        store
      )

      // Press 's' key for Shell
      fireEvent.keyDown(document, { key: 's' })

      // Wait for transition to complete
      const picker = screen.getByText('Shell').closest('div[class*="transition"]')
      if (picker) {
        fireEvent.transitionEnd(picker)
      }

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
  })
})
