import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import PaneLayout from '@/components/panes/PaneLayout'
import panesReducer from '@/store/panesSlice'
import type { PanesState } from '@/store/panesSlice'
import type { PaneNode, PaneContent } from '@/store/paneTypes'

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
    setHelloExtensionProvider: vi.fn(),
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
Circle: ({ className }: { className?: string }) => (
    <svg data-testid="circle-icon" className={className} />
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

function createTerminalContent(): PaneContent {
  return {
    kind: 'terminal',
    mode: 'shell',
  }
}

function createBrowserContent(url: string = 'https://example.com'): PaneContent {
  return {
    kind: 'browser',
    url,
    devToolsOpen: false,
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
        paneTitles: {},
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

describe('PaneLayout', () => {
  beforeEach(() => {
    mockSend.mockClear()
    mockTerminalView.mockClear()
    // Mock getBoundingClientRect for split direction calculation
    Element.prototype.getBoundingClientRect = vi.fn(() => ({
      width: 1000,
      height: 600,
      top: 0,
      left: 0,
      right: 1000,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => {},
    }))
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  describe('layout initialization', () => {
    it('initializes layout with defaultContent when no layout exists', async () => {
      const store = createStore()
      const tabId = 'tab-1'
      const defaultContent = createTerminalContent()

      renderWithStore(
        <PaneLayout tabId={tabId} defaultContent={defaultContent} />,
        store
      )

      // Wait for useEffect to run
      await waitFor(() => {
        const state = store.getState().panes
        expect(state.layouts[tabId]).toBeDefined()
      })

      const state = store.getState().panes
      expect(state.layouts[tabId].type).toBe('leaf')
      expect((state.layouts[tabId] as Extract<PaneNode, { type: 'leaf' }>).content.kind).toBe('terminal')
    })

    it('does not overwrite existing layout', async () => {
      const existingPaneId = 'existing-pane'
      const existingLayout: PaneNode = {
        type: 'leaf',
        id: existingPaneId,
        content: createBrowserContent('https://existing.com'),
      }

      const store = createStore({
        layouts: { 'tab-1': existingLayout },
        activePane: { 'tab-1': existingPaneId },
      })

      renderWithStore(
        <PaneLayout tabId="tab-1" defaultContent={createTerminalContent()} />,
        store
      )

      // Wait a bit to ensure useEffect has run
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
      })

      // Layout should remain unchanged
      const state = store.getState().panes
      expect(state.layouts['tab-1'].id).toBe(existingPaneId)
      expect((state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).content.kind).toBe('browser')
    })

    it('sets active pane when initializing layout', async () => {
      const store = createStore()
      const tabId = 'tab-1'

      renderWithStore(
        <PaneLayout tabId={tabId} defaultContent={createTerminalContent()} />,
        store
      )

      await waitFor(() => {
        const state = store.getState().panes
        expect(state.activePane[tabId]).toBeDefined()
      })

      const state = store.getState().panes
      // The active pane should be the same as the layout's pane id
      expect(state.activePane[tabId]).toBe(state.layouts[tabId].id)
    })
  })

  describe('rendering', () => {
    it('renders loading state before layout is initialized', () => {
      const store = createStore()

      const { container } = renderWithStore(
        <PaneLayout tabId="tab-1" defaultContent={createTerminalContent()} />,
        store
      )

      // Before layout is initialized, should render an empty div
      // (The component shows an empty div as loading state)
      expect(container.querySelector('div.h-full.w-full')).toBeInTheDocument()
    })

    it('renders PaneContainer after layout is initialized', async () => {
      const existingPaneId = 'pane-1'
      const store = createStore({
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: existingPaneId,
            content: createTerminalContent(),
          },
        },
        activePane: { 'tab-1': existingPaneId },
      })

      renderWithStore(
        <PaneLayout tabId="tab-1" defaultContent={createTerminalContent()} />,
        store
      )

      // Should render the terminal
      expect(screen.getByTestId(`terminal-${existingPaneId}`)).toBeInTheDocument()
    })

    it('renders FloatingActionButton', async () => {
      const existingPaneId = 'pane-1'
      const store = createStore({
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: existingPaneId,
            content: createTerminalContent(),
          },
        },
        activePane: { 'tab-1': existingPaneId },
      })

      renderWithStore(
        <PaneLayout tabId="tab-1" defaultContent={createTerminalContent()} />,
        store
      )

      // FAB should be present
      expect(screen.getByTitle('Add pane')).toBeInTheDocument()
    })
  })

  describe('adding terminal pane', () => {
    it('splits active pane when adding terminal', async () => {
      const paneId = 'pane-1'
      const store = createStore({
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: paneId,
            content: createTerminalContent(),
          },
        },
        activePane: { 'tab-1': paneId },
      })

      renderWithStore(
        <PaneLayout tabId="tab-1" defaultContent={createTerminalContent()} />,
        store
      )

      // Click FAB to add picker pane
      const fabButton = screen.getByTitle('Add pane')
      fireEvent.click(fabButton)

      // Layout should now be a split
      const state = store.getState().panes
      expect(state.layouts['tab-1'].type).toBe('split')

      const splitNode = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      expect(splitNode.children).toHaveLength(2)
      expect(splitNode.children[0].type).toBe('leaf')
      expect(splitNode.children[1].type).toBe('leaf')
    })

    it('uses horizontal split when container is wider than tall', async () => {
      // Container is 1000x600 (wider)
      Element.prototype.getBoundingClientRect = vi.fn(() => ({
        width: 1000,
        height: 600,
        top: 0,
        left: 0,
        right: 1000,
        bottom: 600,
        x: 0,
        y: 0,
        toJSON: () => {},
      }))

      const paneId = 'pane-1'
      const store = createStore({
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: paneId,
            content: createTerminalContent(),
          },
        },
        activePane: { 'tab-1': paneId },
      })

      renderWithStore(
        <PaneLayout tabId="tab-1" defaultContent={createTerminalContent()} />,
        store
      )

      // Click FAB to add picker pane
      fireEvent.click(screen.getByTitle('Add pane'))

      const state = store.getState().panes
      const splitNode = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      expect(splitNode.direction).toBe('horizontal')
    })

    it('uses horizontal split for 2 panes regardless of container dimensions', async () => {
      // Container is 600x1000 (taller) - with grid layout, 2 panes are always side by side
      Element.prototype.getBoundingClientRect = vi.fn(() => ({
        width: 600,
        height: 1000,
        top: 0,
        left: 0,
        right: 600,
        bottom: 1000,
        x: 0,
        y: 0,
        toJSON: () => {},
      }))

      const paneId = 'pane-1'
      const store = createStore({
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: paneId,
            content: createTerminalContent(),
          },
        },
        activePane: { 'tab-1': paneId },
      })

      renderWithStore(
        <PaneLayout tabId="tab-1" defaultContent={createTerminalContent()} />,
        store
      )

      // Click FAB to add picker pane
      fireEvent.click(screen.getByTitle('Add pane'))

      // With grid layout, 2 panes are always horizontal (side by side)
      const state = store.getState().panes
      const splitNode = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      expect(splitNode.direction).toBe('horizontal')
    })

    it('sets new pane as active after adding', async () => {
      const paneId = 'pane-1'
      const store = createStore({
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: paneId,
            content: createTerminalContent(),
          },
        },
        activePane: { 'tab-1': paneId },
      })

      renderWithStore(
        <PaneLayout tabId="tab-1" defaultContent={createTerminalContent()} />,
        store
      )

      // Click FAB to add picker pane
      fireEvent.click(screen.getByTitle('Add pane'))

      const state = store.getState().panes
      const splitNode = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>

      // The new pane should be active
      expect(state.activePane['tab-1']).toBe(splitNode.children[1].id)
    })
  })

  describe('adding browser pane', () => {
    it('splits active pane when adding browser', async () => {
      const paneId = 'pane-1'
      const store = createStore({
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: paneId,
            content: createTerminalContent(),
          },
        },
        activePane: { 'tab-1': paneId },
      })

      renderWithStore(
        <PaneLayout tabId="tab-1" defaultContent={createTerminalContent()} />,
        store
      )

      // Click FAB to add picker pane
      fireEvent.click(screen.getByTitle('Add pane'))

      // Layout should now be a split with picker content
      const state = store.getState().panes
      expect(state.layouts['tab-1'].type).toBe('split')

      const splitNode = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      const newPane = splitNode.children[1] as Extract<PaneNode, { type: 'leaf' }>
      expect(newPane.content.kind).toBe('picker')
    })

    it('creates picker pane when FAB is clicked', async () => {
      const paneId = 'pane-1'
      const store = createStore({
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: paneId,
            content: createTerminalContent(),
          },
        },
        activePane: { 'tab-1': paneId },
      })

      renderWithStore(
        <PaneLayout tabId="tab-1" defaultContent={createTerminalContent()} />,
        store
      )

      // Click FAB to add picker pane
      fireEvent.click(screen.getByTitle('Add pane'))

      const state = store.getState().panes
      const splitNode = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      const newPane = splitNode.children[1] as Extract<PaneNode, { type: 'leaf' }>

      expect(newPane.content.kind).toBe('picker')
    })
  })

  describe('edge cases', () => {
    it('adds pane even when no active pane is set (grid layout does not require active pane)', async () => {
      const paneId = 'pane-1'
      const store = createStore({
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: paneId,
            content: createTerminalContent(),
          },
        },
        activePane: {}, // No active pane set
      })

      renderWithStore(
        <PaneLayout tabId="tab-1" defaultContent={createTerminalContent()} />,
        store
      )

      // Click FAB to add picker pane - with grid layout, this works without active pane
      fireEvent.click(screen.getByTitle('Add pane'))

      // Layout should now be a split with 2 panes
      const state = store.getState().panes
      expect(state.layouts['tab-1'].type).toBe('split')
    })

    it('handles rapid add operations', async () => {
      const paneId = 'pane-1'
      const store = createStore({
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: paneId,
            content: createTerminalContent(),
          },
        },
        activePane: { 'tab-1': paneId },
      })

      renderWithStore(
        <PaneLayout tabId="tab-1" defaultContent={createTerminalContent()} />,
        store
      )

      // Add first picker pane
      fireEvent.click(screen.getByTitle('Add pane'))

      // Get the new active pane (which should be the newly added one)
      let state = store.getState().panes
      const firstNewPaneId = state.activePane['tab-1']

      // Add second picker pane
      fireEvent.click(screen.getByTitle('Add pane'))

      state = store.getState().panes
      // Should have 3 panes now in a nested structure
      expect(state.activePane['tab-1']).not.toBe(firstNewPaneId)
    })
  })

  describe('hidden prop propagation', () => {
    it('passes hidden=true through to TerminalView', () => {
      const paneId = 'pane-1'
      const store = createStore({
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: paneId,
            content: createTerminalContent(),
          },
        },
        activePane: { 'tab-1': paneId },
      })

      renderWithStore(
        <PaneLayout tabId="tab-1" defaultContent={createTerminalContent()} hidden={true} />,
        store
      )

      // TerminalView should have received hidden=true
      expect(mockTerminalView).toHaveBeenLastCalledWith(
        expect.objectContaining({ hidden: true }),
        expect.anything()
      )
    })

    it('passes hidden=false through to TerminalView', () => {
      const paneId = 'pane-1'
      const store = createStore({
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: paneId,
            content: createTerminalContent(),
          },
        },
        activePane: { 'tab-1': paneId },
      })

      renderWithStore(
        <PaneLayout tabId="tab-1" defaultContent={createTerminalContent()} hidden={false} />,
        store
      )

      // TerminalView should have received hidden=false
      expect(mockTerminalView).toHaveBeenLastCalledWith(
        expect.objectContaining({ hidden: false }),
        expect.anything()
      )
    })
  })
})
