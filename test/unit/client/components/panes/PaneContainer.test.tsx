import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import PaneContainer from '@/components/panes/PaneContainer'
import panesReducer from '@/store/panesSlice'
import type { PanesState } from '@/store/panesSlice'
import type { PaneNode, PaneContent } from '@/store/paneTypes'

// Mock the ws-client module
const mockSend = vi.fn()
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
}))

// Mock TerminalView component to avoid xterm.js dependencies
vi.mock('@/components/TerminalView', () => ({
  default: ({ tabId, paneId }: { tabId: string; paneId: string }) => (
    <div data-testid={`terminal-${paneId}`}>Terminal for {tabId}/{paneId}</div>
  ),
}))

// Mock BrowserPane component
vi.mock('@/components/panes/BrowserPane', () => ({
  default: ({ paneId, url }: { paneId: string; url: string }) => (
    <div data-testid={`browser-${paneId}`}>Browser: {url}</div>
  ),
}))

function createTerminalContent(overrides: Partial<PaneContent & { kind: 'terminal' }> = {}): PaneContent {
  return {
    kind: 'terminal',
    mode: 'shell',
    ...overrides,
  }
}

function createStore(initialPanesState: Partial<PanesState> = {}) {
  return configureStore({
    reducer: {
      panes: panesReducer,
    },
    preloadedState: {
      panes: {
        layouts: {},
        activePane: {},
        ...initialPanesState,
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

describe('PaneContainer', () => {
  beforeEach(() => {
    mockSend.mockClear()
  })

  afterEach(() => {
    cleanup()
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
})
