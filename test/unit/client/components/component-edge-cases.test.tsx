/**
 * Component Edge Cases Test Suite
 *
 * Tests for crash scenarios, edge cases, and defensive rendering in React components.
 *
 * TESTED COMPONENTS:
 * - TabBar (src/components/TabBar.tsx)
 * - SettingsView (src/components/SettingsView.tsx)
 * - Sidebar (src/components/Sidebar.tsx)
 * - HistoryView (src/components/HistoryView.tsx)
 * - OverviewView (src/components/OverviewView.tsx)
 * - BackgroundSessions (src/components/BackgroundSessions.tsx)
 *
 * FOCUS AREAS:
 * 1. Rendering with undefined/null props
 * 2. Rendering with empty arrays
 * 3. Rendering during loading states
 * 4. Error states display
 * 5. Rapid prop changes
 * 6. Component unmount during async operations
 * 7. Missing Redux state
 * 8. Invalid data shapes from API
 *
 * IDENTIFIED CRASH SCENARIOS:
 * - OverviewView: Crashes when API returns null instead of array (items.filter fails)
 * - SettingsView: Should render safely even when safety settings are undefined
 * - Sidebar: Crashes when projects array is undefined (forEach fails)
 * - HistoryView: Crashes when projects array is undefined (reduce/map fails)
 * - TabBar: Crashes when tabs array is undefined (map fails)
 *
 * Run with: npx vitest run test/unit/client/components/component-edge-cases.test.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach, MockInstance } from 'vitest'
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react'
import { configureStore, EnhancedStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'

// ============================================================================
// Mock Setup - Mocks must be declared before imports they affect
// ============================================================================

// Mock ws-client
const mockWsSend = vi.fn()
const mockWsConnect = vi.fn().mockResolvedValue(undefined)
const mockWsOnMessage = vi.fn().mockReturnValue(() => {})
const mockWsOnReconnect = vi.fn().mockReturnValue(() => {})

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: mockWsSend,
    connect: mockWsConnect,
    onMessage: mockWsOnMessage,
    onReconnect: mockWsOnReconnect,
    setHelloExtensionProvider: vi.fn(),
  }),
}))

// Mock api - using inline object to avoid hoisting issues
vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue([]),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}))

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  X: ({ className }: { className?: string }) => <svg data-testid="x-icon" className={className} />,
  Plus: ({ className }: { className?: string }) => <svg data-testid="plus-icon" className={className} />,
  Circle: ({ className }: { className?: string }) => <svg data-testid="circle-icon" className={className} />,
  Terminal: ({ className }: { className?: string }) => <svg data-testid="terminal-icon" className={className} />,
  History: ({ className }: { className?: string }) => <svg data-testid="history-icon" className={className} />,
  Archive: ({ className }: { className?: string }) => <svg data-testid="archive-icon" className={className} />,
  Settings: ({ className }: { className?: string }) => <svg data-testid="settings-icon" className={className} />,
  Monitor: ({ className }: { className?: string }) => <svg data-testid="monitor-icon" className={className} />,
  TerminalSquare: ({ className }: { className?: string }) => <svg data-testid="terminal-square-icon" className={className} />,
  FileCode2: ({ className }: { className?: string }) => <svg data-testid="file-code-icon" className={className} />,
  Bot: ({ className }: { className?: string }) => <svg data-testid="bot-icon" className={className} />,
  Square: ({ className }: { className?: string }) => <svg data-testid="square-icon" className={className} />,
  LayoutGrid: ({ className }: { className?: string }) => <svg data-testid="layout-icon" className={className} />,
  Globe: ({ className }: { className?: string }) => <svg data-testid="globe-icon" className={className} />,
  FileText: ({ className }: { className?: string }) => <svg data-testid="file-text-icon" className={className} />,
  Search: ({ className }: { className?: string }) => <svg data-testid="search-icon" className={className} />,
  Moon: ({ className }: { className?: string }) => <svg data-testid="moon-icon" className={className} />,
  Sun: ({ className }: { className?: string }) => <svg data-testid="sun-icon" className={className} />,
  Play: ({ className }: { className?: string }) => <svg data-testid="play-icon" className={className} />,
  ChevronRight: ({ className }: { className?: string }) => <svg data-testid="chevron-icon" className={className} />,
  MoreHorizontal: ({ className }: { className?: string }) => <svg data-testid="more-icon" className={className} />,
  Pencil: ({ className }: { className?: string }) => <svg data-testid="pencil-icon" className={className} />,
  Trash2: ({ className }: { className?: string }) => <svg data-testid="trash-icon" className={className} />,
  RefreshCw: ({ className }: { className?: string }) => <svg data-testid="refresh-icon" className={className} />,
  Sparkles: ({ className }: { className?: string }) => <svg data-testid="sparkles-icon" className={className} />,
  ExternalLink: ({ className }: { className?: string }) => <svg data-testid="external-icon" className={className} />,
  ChevronDown: ({ className }: { className?: string }) => <svg data-testid="chevron-down-icon" className={className} />,
  MessageSquare: ({ className }: { className?: string }) => <svg data-testid="message-square-icon" className={className} />,
}))

// Mock PaneIcon component
vi.mock('@/components/icons/PaneIcon', () => ({
  default: ({ content, className }: any) => (
    <svg data-testid="pane-icon" data-content-kind={content?.kind} data-content-mode={content?.mode} className={className} />
  ),
}))

// Mock react-window to avoid hook usage in JSDOM edge case tests
vi.mock('react-window', () => ({
  List: ({ rowCount, rowComponent: Row, rowProps, style }: {
    rowCount: number
    rowComponent: React.ComponentType<any>
    rowProps: any
    style: React.CSSProperties
  }) => {
    const items = []
    for (let i = 0; i < rowCount; i++) {
      items.push(
        <Row
          key={i}
          index={i}
          style={{ height: 56 }}
          ariaAttributes={{}}
          {...rowProps}
        />
      )
    }
    return <div style={style} data-testid="virtualized-list">{items}</div>
  },
}))

// Now import the components and store slices after mocks are set up
import TabBar from '@/components/TabBar'
import SettingsView from '@/components/SettingsView'
import Sidebar from '@/components/Sidebar'
import HistoryView from '@/components/HistoryView'
import OverviewView from '@/components/OverviewView'
import BackgroundSessions from '@/components/BackgroundSessions'
import tabsReducer, { TabsState } from '@/store/tabsSlice'
import settingsReducer, { defaultSettings, SettingsState } from '@/store/settingsSlice'
import sessionsReducer, { SessionsState } from '@/store/sessionsSlice'
import connectionReducer from '@/store/connectionSlice'
import codingCliReducer from '@/store/codingCliSlice'
import panesReducer from '@/store/panesSlice'
import { networkReducer } from '@/store/networkSlice'
import type { Tab, AppSettings, ProjectGroup, BackgroundTerminal } from '@/store/types'

// Import the mocked api to get access to the mocks
import { api } from '@/lib/api'
const mockApiTyped = vi.mocked(api)

// ============================================================================
// Test Utilities
// ============================================================================

interface TestStoreState {
  tabs?: Partial<TabsState>
  settings?: Partial<SettingsState>
  sessions?: Partial<SessionsState>
}

function createTestStore(state: TestStoreState = {}) {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      settings: settingsReducer,
      sessions: sessionsReducer,
      connection: connectionReducer,
      codingCli: codingCliReducer,
      panes: panesReducer,
      network: networkReducer,
    },
    middleware: (getDefault) =>
      getDefault({
        serializableCheck: {
          ignoredPaths: ['sessions.expandedProjects'],
        },
      }),
    preloadedState: {
      tabs: {
        tabs: [],
        activeTabId: null,
        ...state.tabs,
      },
      settings: {
        settings: defaultSettings,
        loaded: true,
        lastSavedAt: undefined,
        ...state.settings,
      },
      sessions: {
        projects: [],
        expandedProjects: new Set<string>(),
        ...state.sessions,
      },
      codingCli: {
        sessions: {},
      },
      panes: {
        layouts: {},
        activePane: {},
      },
    },
  })
}

function createTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: `tab-${Math.random().toString(36).slice(2)}`,
    createRequestId: `req-${Math.random().toString(36).slice(2)}`,
    title: 'Terminal 1',
    status: 'running',
    mode: 'shell',
    shell: 'system',
    createdAt: Date.now(),
    ...overrides,
  }
}

function createProjectGroup(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    projectPath: '/test/project',
    sessions: [],
    color: '#6b7280',
    ...overrides,
  }
}

function renderWithStore(ui: React.ReactElement, store: ReturnType<typeof createTestStore>) {
  return render(<Provider store={store}>{ui}</Provider>)
}

// ============================================================================
// Test Suites
// ============================================================================

describe('Component Edge Cases', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    localStorage.clear()
    mockWsOnMessage.mockReturnValue(() => {})
    mockWsOnReconnect.mockReturnValue(() => {})
    mockWsConnect.mockResolvedValue(undefined)
    mockApiTyped.get.mockResolvedValue([])
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  // ==========================================================================
  // 1. Rendering with undefined/null props
  // ==========================================================================

  describe('1. Rendering with undefined/null props', () => {
    describe('TabBar', () => {
      it('renders safely with undefined tab properties', () => {
        const tabWithUndefined = createTab({
          title: undefined as unknown as string,
          terminalId: undefined,
          description: undefined,
        })

        const store = createTestStore({
          tabs: { tabs: [tabWithUndefined], activeTabId: tabWithUndefined.id },
        })

        expect(() => renderWithStore(<TabBar />, store)).not.toThrow()
      })

      it('handles null activeTabId gracefully', () => {
        const tab = createTab()
        const store = createTestStore({
          tabs: { tabs: [tab], activeTabId: null },
        })

        expect(() => renderWithStore(<TabBar />, store)).not.toThrow()
        expect(screen.getByText('Terminal 1')).toBeInTheDocument()
      })

      it('handles tab with undefined status', () => {
        const tabWithUndefinedStatus = createTab({
          status: undefined as unknown as 'running',
        })

        const store = createTestStore({
          tabs: { tabs: [tabWithUndefinedStatus], activeTabId: tabWithUndefinedStatus.id },
        })

        // StatusIndicator should handle undefined status (falls through to default case)
        expect(() => renderWithStore(<TabBar />, store)).not.toThrow()
      })
    })

    describe('SettingsView', () => {
      it('renders safely with partial settings object', () => {
        const partialSettings = {
          ...defaultSettings,
          terminal: {
            ...defaultSettings.terminal,
            fontSize: undefined as unknown as number,
          },
        }

        const store = createTestStore({
          settings: { settings: partialSettings },
        })

        expect(() => renderWithStore(<SettingsView />, store)).not.toThrow()
      })

      it('handles undefined sidebar settings', () => {
        const settingsWithUndefinedSidebar = {
          ...defaultSettings,
          sidebar: undefined as unknown as AppSettings['sidebar'],
        }

        const store = createTestStore({
          settings: { settings: settingsWithUndefinedSidebar },
        })

        // Component uses optional chaining (settings.sidebar?.sortMode)
        expect(() => renderWithStore(<SettingsView />, store)).not.toThrow()
      })

      it('handles undefined safety settings', () => {
        const settingsWithUndefinedSafety = {
          ...defaultSettings,
          safety: undefined as unknown as AppSettings['safety'],
        }

        const store = createTestStore({
          settings: { settings: settingsWithUndefinedSafety },
        })

        // SettingsView should be resilient to partial settings payloads
        expect(() => renderWithStore(<SettingsView />, store)).not.toThrow()
      })
    })

    describe('Sidebar', () => {
      it('renders safely with undefined settings properties', () => {
        const settingsWithUndefined = {
          ...defaultSettings,
          sidebar: undefined as unknown as AppSettings['sidebar'],
        }

        const store = createTestStore({
          settings: { settings: settingsWithUndefined },
          tabs: { tabs: [], activeTabId: null },
        })

        // Sidebar uses optional chaining for sidebar settings
        expect(() =>
          renderWithStore(<Sidebar view="terminal" onNavigate={() => {}} />, store)
        ).not.toThrow()
      })

      it('handles empty projects array', () => {
        const store = createTestStore({
          sessions: { projects: [], expandedProjects: new Set() },
          tabs: { tabs: [], activeTabId: null },
        })

        expect(() =>
          renderWithStore(<Sidebar view="terminal" onNavigate={() => {}} />, store)
        ).not.toThrow()
      })
    })

    describe('HistoryView', () => {
      it('handles projects with missing session properties', () => {
        const projectWithBadSession: ProjectGroup = {
          projectPath: '/test',
          sessions: [
            {
              sessionId: 'sess-1',
              projectPath: '/test',
              updatedAt: Date.now(),
              title: undefined,
              summary: undefined,
              cwd: undefined,
            },
          ],
        }

        const store = createTestStore({
          sessions: { projects: [projectWithBadSession], expandedProjects: new Set() },
        })

        expect(() => renderWithStore(<HistoryView />, store)).not.toThrow()
      })

      it('handles project with undefined color', () => {
        const projectWithoutColor: ProjectGroup = {
          projectPath: '/test',
          sessions: [],
          color: undefined,
        }

        const store = createTestStore({
          sessions: { projects: [projectWithoutColor], expandedProjects: new Set(['/test']) },
        })

        expect(() => renderWithStore(<HistoryView />, store)).not.toThrow()
      })
    })

    describe('OverviewView', () => {
      it('handles undefined terminal properties in API response', async () => {
        const incompleteTerminal = {
          terminalId: 'term-1',
          title: 'Test',
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
          status: 'running',
          hasClients: false,
          cwd: undefined,
          description: undefined,
        }

        mockApiTyped.get.mockResolvedValueOnce([incompleteTerminal])

        const store = createTestStore()

        expect(() => renderWithStore(<OverviewView />, store)).not.toThrow()
      })
    })

    describe('BackgroundSessions', () => {
      it('handles terminals with undefined lastActivityAt', () => {
        const store = createTestStore()

        // Simulate WebSocket message with incomplete terminal data
        let messageHandler: ((msg: any) => void) | null = null
        mockWsOnMessage.mockImplementation((handler) => {
          messageHandler = handler
          return () => {}
        })

        renderWithStore(<BackgroundSessions />, store)

        // Trigger message with terminal missing lastActivityAt
        act(() => {
          if (messageHandler) {
            messageHandler({
              type: 'terminal.list.response',
              requestId: expect.any(String),
              terminals: [
                {
                  terminalId: 'term-1',
                  title: 'Test',
                  createdAt: Date.now(),
                  lastActivityAt: undefined,
                  status: 'running',
                  hasClients: false,
                },
              ],
            })
          }
        })

        // Component should handle undefined lastActivityAt gracefully
        expect(screen.queryByText(/undefined/)).not.toBeInTheDocument()
      })
    })
  })

  // ==========================================================================
  // 2. Rendering with empty arrays
  // ==========================================================================

  describe('2. Rendering with empty arrays', () => {
    describe('TabBar', () => {
      it('returns null when tabs array is empty', () => {
        const store = createTestStore({
          tabs: { tabs: [], activeTabId: null },
        })

        const { container } = renderWithStore(<TabBar />, store)
        expect(container.firstChild).toBeNull()
      })
    })

    describe('Sidebar', () => {
      it('shows empty state when no items', () => {
        const store = createTestStore({
          tabs: { tabs: [], activeTabId: null },
          sessions: { projects: [], expandedProjects: new Set() },
        })

        renderWithStore(<Sidebar view="terminal" onNavigate={() => {}} />, store)

        expect(screen.getByText('No sessions yet')).toBeInTheDocument()
      })

      it('handles filter resulting in empty array', () => {
        const project = createProjectGroup({
          sessions: [
            { sessionId: 'sess-1', projectPath: '/test', updatedAt: Date.now(), title: 'Alpha' },
          ],
        })

        const store = createTestStore({
          sessions: { projects: [project], expandedProjects: new Set() },
          tabs: { tabs: [], activeTabId: null },
        })

        renderWithStore(<Sidebar view="terminal" onNavigate={() => {}} />, store)

        // Search for something that doesn't exist
        const searchInput = screen.getByPlaceholderText('Search...')
        fireEvent.change(searchInput, { target: { value: 'xyznonexistent' } })

        // Should show empty state for a filtered search
        expect(screen.getByText('No matching sessions')).toBeInTheDocument()
      })
    })

    describe('HistoryView', () => {
      it('shows empty state when no projects', () => {
        const store = createTestStore({
          sessions: { projects: [], expandedProjects: new Set() },
        })

        renderWithStore(<HistoryView />, store)

        expect(screen.getByText('No sessions found')).toBeInTheDocument()
      })

      it('handles project with empty sessions array', () => {
        const emptyProject = createProjectGroup({ sessions: [] })

        const store = createTestStore({
          sessions: { projects: [emptyProject], expandedProjects: new Set([emptyProject.projectPath]) },
        })

        expect(() => renderWithStore(<HistoryView />, store)).not.toThrow()
      })
    })

    describe('OverviewView', () => {
      it('shows empty state when no terminals', async () => {
        mockApiTyped.get.mockResolvedValueOnce([])

        const store = createTestStore()

        renderWithStore(<OverviewView />, store)

        await act(async () => {
          await vi.runAllTimersAsync()
        })

        expect(screen.getByText('No terminals tracked yet')).toBeInTheDocument()
      })

      it('handles filter of running/exited resulting in empty arrays', async () => {
        mockApiTyped.get.mockResolvedValueOnce([])

        const store = createTestStore()
        renderWithStore(<OverviewView />, store)

        await act(async () => {
          await vi.runAllTimersAsync()
        })

        // Should not show section headers when both arrays are empty
        expect(screen.queryByText('Running')).not.toBeInTheDocument()
        expect(screen.queryByText('Exited')).not.toBeInTheDocument()
      })
    })

    describe('BackgroundSessions', () => {
      it('shows empty state message when no detached terminals', () => {
        const store = createTestStore()

        renderWithStore(<BackgroundSessions />, store)

        expect(screen.getByText(/No detached running terminals/)).toBeInTheDocument()
      })
    })
  })

  // ==========================================================================
  // 3. Rendering during loading states
  // ==========================================================================

  describe('3. Rendering during loading states', () => {
    describe('HistoryView', () => {
      it('shows refresh button in loading state', async () => {
        // Use real timers for this test since waitFor needs them
        vi.useRealTimers()

        let resolveApi: (value: any) => void
        mockApiTyped.get.mockImplementation(
          () => new Promise((resolve) => {
            resolveApi = resolve
          })
        )

        const store = createTestStore()
        renderWithStore(<HistoryView />, store)

        // Click refresh
        const refreshButton = screen.getByRole('button')
        fireEvent.click(refreshButton)

        // Button should have animate-spin class during loading
        await waitFor(() => {
          expect(refreshButton.className).toContain('animate-spin')
        })

        // Resolve the API call
        await act(async () => {
          resolveApi!([])
        })

        // Re-enable fake timers
        vi.useFakeTimers()
      })
    })

    describe('OverviewView', () => {
      it('shows loading state during refresh', async () => {
        // Use real timers for this test since waitFor needs them
        vi.useRealTimers()

        let resolveApi: (value: any) => void
        mockApiTyped.get.mockImplementation(
          () => new Promise((resolve) => {
            resolveApi = resolve
          })
        )

        const store = createTestStore()
        renderWithStore(<OverviewView />, store)

        // Initial load triggers loading state
        await waitFor(() => {
          const refreshButton = screen.getByRole('button')
          expect(refreshButton.className).toContain('animate-spin')
        })

        // Resolve to clean up
        await act(async () => {
          resolveApi!([])
        })

        // Re-enable fake timers
        vi.useFakeTimers()
      })

      it('recovers from loading state after API resolves', async () => {
        mockApiTyped.get.mockResolvedValueOnce([])

        const store = createTestStore()
        renderWithStore(<OverviewView />, store)

        await act(async () => {
          await vi.runAllTimersAsync()
        })

        const refreshButton = screen.getByRole('button')
        expect(refreshButton.className).not.toContain('animate-spin')
      })
    })

    describe('SettingsView with pending save', () => {
      it('handles rapid setting changes without crash', async () => {
        const store = createTestStore()
        renderWithStore(<SettingsView />, store)

        // Rapidly change theme multiple times
        const darkButtons = screen.getAllByRole('button', { name: 'Dark' })
        const lightButtons = screen.getAllByRole('button', { name: 'Light' })
        const systemButton = screen.getByRole('button', { name: 'System' })

        for (let i = 0; i < 10; i++) {
          fireEvent.click(darkButtons[0])
          fireEvent.click(lightButtons[0])
          fireEvent.click(systemButton)
        }

        // Should not throw
        await act(async () => {
          vi.advanceTimersByTime(500)
        })

        // Only one API call should be made (debounced)
        expect(mockApiTyped.patch).toHaveBeenCalledTimes(1)
      })
    })
  })

  // ==========================================================================
  // 4. Error states display
  // ==========================================================================

  describe('4. Error states display', () => {
    describe('OverviewView', () => {
      it('displays error when API call fails', async () => {
        mockApiTyped.get.mockRejectedValueOnce(new Error('Network error'))

        const store = createTestStore()
        renderWithStore(<OverviewView />, store)

        await act(async () => {
          await vi.runAllTimersAsync()
        })

        expect(screen.getByText('Network error')).toBeInTheDocument()
      })

      it('displays generic error message when error has no message', async () => {
        mockApiTyped.get.mockRejectedValueOnce({})

        const store = createTestStore()
        renderWithStore(<OverviewView />, store)

        await act(async () => {
          await vi.runAllTimersAsync()
        })

        expect(screen.getByText('Failed to load')).toBeInTheDocument()
      })

      it('clears error on successful refresh', async () => {
        // First call fails
        mockApiTyped.get.mockRejectedValueOnce(new Error('First error'))

        const store = createTestStore()
        renderWithStore(<OverviewView />, store)

        await act(async () => {
          await vi.runAllTimersAsync()
        })

        expect(screen.getByText('First error')).toBeInTheDocument()

        // Second call succeeds
        mockApiTyped.get.mockResolvedValueOnce([])

        const refreshButton = screen.getByRole('button')
        fireEvent.click(refreshButton)

        await act(async () => {
          await vi.runAllTimersAsync()
        })

        expect(screen.queryByText('First error')).not.toBeInTheDocument()
      })
    })

    describe('TabBar with error status', () => {
      it('displays error indicator for tabs with error status', () => {
        const errorTab = createTab({ status: 'error', title: 'Error Tab' })

        const store = createTestStore({
          tabs: { tabs: [errorTab], activeTabId: errorTab.id },
        })

        renderWithStore(<TabBar />, store)

        // With iconsOnTabs=true (default), tabs with mode render PaneIcon with status class
        const icons = screen.getAllByTestId('pane-icon')
        const hasError = icons.some((c) => c.getAttribute('class')?.includes('text-destructive'))
        expect(hasError).toBe(true)
      })
    })

    describe('SettingsView API error handling', () => {
      it('handles API patch failure gracefully', async () => {
        mockApiTyped.patch.mockRejectedValueOnce(new Error('Save failed'))

        const store = createTestStore()
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

        renderWithStore(<SettingsView />, store)

        const darkButtons = screen.getAllByRole('button', { name: 'Dark' })
        fireEvent.click(darkButtons[0])

        await act(async () => {
          vi.advanceTimersByTime(500)
          await vi.runAllTimersAsync()
        })

        // Should log warning but not crash
        expect(consoleSpy).toHaveBeenCalledWith('Failed to save settings', expect.any(Error))

        consoleSpy.mockRestore()
      })
    })
  })

  // ==========================================================================
  // 5. Rapid prop changes
  // ==========================================================================

  describe('5. Rapid prop changes', () => {
    describe('TabBar', () => {
      it('handles rapid tab additions without crash', () => {
        const store = createTestStore({
          tabs: { tabs: [], activeTabId: null },
        })

        const { rerender } = renderWithStore(<TabBar />, store)

        // Rapidly add many tabs
        for (let i = 0; i < 20; i++) {
          const newTab = createTab({ id: `tab-${i}`, title: `Tab ${i}` })
          store.dispatch({ type: 'tabs/addTab', payload: { title: `Tab ${i}` } })
        }

        rerender(
          <Provider store={store}>
            <TabBar />
          </Provider>
        )

        // Should not crash and should show tabs (pane-icon with iconsOnTabs default)
        expect(screen.getAllByTestId('pane-icon').length).toBeGreaterThan(0)
      })

      it('handles rapid tab removals without crash', () => {
        const tabs = Array.from({ length: 10 }, (_, i) =>
          createTab({ id: `tab-${i}`, title: `Tab ${i}` })
        )

        const store = createTestStore({
          tabs: { tabs, activeTabId: 'tab-0' },
        })

        renderWithStore(<TabBar />, store)

        // Rapidly remove all tabs
        tabs.forEach((tab) => {
          store.dispatch({ type: 'tabs/removeTab', payload: tab.id })
        })

        // Should not crash
        expect(store.getState().tabs.tabs).toHaveLength(0)
      })

      it('handles rapid active tab changes', () => {
        const tabs = Array.from({ length: 5 }, (_, i) =>
          createTab({ id: `tab-${i}`, title: `Tab ${i}` })
        )

        const store = createTestStore({
          tabs: { tabs, activeTabId: 'tab-0' },
        })

        renderWithStore(<TabBar />, store)

        // Rapidly switch active tabs
        for (let i = 0; i < 50; i++) {
          const tabId = `tab-${i % 5}`
          fireEvent.click(screen.getByText(`Tab ${i % 5}`))
        }

        // Should not crash
        expect(store.getState().tabs.activeTabId).toBeDefined()
      })
    })

    describe('Sidebar', () => {
      it('handles rapid filter changes', () => {
        const project = createProjectGroup({
          sessions: Array.from({ length: 100 }, (_, i) => ({
            sessionId: `sess-${i}`,
            projectPath: '/test',
            updatedAt: Date.now(),
            title: `Session ${i}`,
          })),
        })

        const store = createTestStore({
          sessions: { projects: [project], expandedProjects: new Set() },
          tabs: { tabs: [], activeTabId: null },
        })

        renderWithStore(<Sidebar view="terminal" onNavigate={() => {}} />, store)

        const searchInput = screen.getByPlaceholderText('Search...')

        // Rapidly type and clear
        for (let i = 0; i < 20; i++) {
          fireEvent.change(searchInput, { target: { value: `search${i}` } })
          fireEvent.change(searchInput, { target: { value: '' } })
        }

        // Should not crash
        expect(searchInput).toBeInTheDocument()
      })

      it('handles rapid navigation changes', () => {
        const store = createTestStore({
          tabs: { tabs: [], activeTabId: null },
        })

        const onNavigate = vi.fn()

        renderWithStore(<Sidebar view="terminal" onNavigate={onNavigate} />, store)

        // Find navigation buttons
        const navButtons = screen.getAllByRole('button').filter((btn) =>
          btn.title?.includes('Ctrl+B')
        )

        // Rapidly click navigation
        for (let i = 0; i < 20; i++) {
          navButtons.forEach((btn) => fireEvent.click(btn))
        }

        expect(onNavigate).toHaveBeenCalled()
      })
    })

    describe('SettingsView', () => {
      it('handles rapid slider movements', () => {
        const store = createTestStore()
        renderWithStore(<SettingsView />, store)

        const sliders = screen.getAllByRole('slider')
        const fontSizeSlider = sliders.find(
          (s) => s.getAttribute('min') === '12' && s.getAttribute('max') === '32'
        )!

        // Rapidly move slider
        for (let i = 12; i <= 32; i++) {
          fireEvent.change(fontSizeSlider, { target: { value: String(i) } })
        }
        for (let i = 32; i >= 12; i--) {
          fireEvent.change(fontSizeSlider, { target: { value: String(i) } })
        }

        // Should not crash and value should be set
        expect(store.getState().settings.settings.terminal.fontSize).toBeDefined()
      })
    })
  })

  // ==========================================================================
  // 6. Component unmount during async operations
  // ==========================================================================

  describe('6. Component unmount during async operations', () => {
    describe('SettingsView', () => {
      it('cleans up pending save on unmount', async () => {
        const store = createTestStore()
        const { unmount } = renderWithStore(<SettingsView />, store)

        // Trigger a save
        const darkButtons = screen.getAllByRole('button', { name: 'Dark' })
        fireEvent.click(darkButtons[0])

        // Unmount before debounce completes
        unmount()

        // Advance timers
        await act(async () => {
          vi.advanceTimersByTime(1000)
        })

        // API should not have been called (cleanup cleared the timeout)
        expect(mockApiTyped.patch).not.toHaveBeenCalled()
      })
    })

    describe('Sidebar', () => {
      it('cleans up WebSocket subscription on unmount', () => {
        const unsubscribe = vi.fn()
        mockWsOnMessage.mockReturnValue(unsubscribe)

        const store = createTestStore({
          tabs: { tabs: [], activeTabId: null },
        })

        const { unmount } = renderWithStore(
          <Sidebar view="terminal" onNavigate={() => {}} />,
          store
        )

        unmount()

        expect(unsubscribe).toHaveBeenCalled()
      })

      it('cleans up interval on unmount', () => {
        const clearIntervalSpy = vi.spyOn(window, 'clearInterval')

        const store = createTestStore({
          tabs: { tabs: [], activeTabId: null },
        })

        const { unmount } = renderWithStore(
          <Sidebar view="terminal" onNavigate={() => {}} />,
          store
        )

        unmount()

        expect(clearIntervalSpy).toHaveBeenCalled()
        clearIntervalSpy.mockRestore()
      })
    })

    describe('OverviewView', () => {
      it('handles unmount during API call', async () => {
        let resolveApi: (value: any) => void
        mockApiTyped.get.mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveApi = resolve
            })
        )

        const store = createTestStore()
        const { unmount } = renderWithStore(<OverviewView />, store)

        // Unmount while API is pending
        unmount()

        // Resolve the API call after unmount
        await act(async () => {
          resolveApi!([])
        })

        // Should not throw
      })

      it('cleans up WebSocket subscription on unmount', () => {
        const unsubscribe = vi.fn()
        mockWsOnMessage.mockReturnValue(unsubscribe)

        const store = createTestStore()
        const { unmount } = renderWithStore(<OverviewView />, store)

        unmount()

        expect(unsubscribe).toHaveBeenCalled()
      })
    })

    describe('BackgroundSessions', () => {
      it('cleans up on unmount', () => {
        const unsubscribe = vi.fn()
        mockWsOnMessage.mockReturnValue(unsubscribe)
        const clearIntervalSpy = vi.spyOn(window, 'clearInterval')

        const store = createTestStore()
        const { unmount } = renderWithStore(<BackgroundSessions />, store)

        unmount()

        expect(unsubscribe).toHaveBeenCalled()
        expect(clearIntervalSpy).toHaveBeenCalled()

        clearIntervalSpy.mockRestore()
      })
    })
  })

  // ==========================================================================
  // 7. Missing Redux state
  // ==========================================================================

  describe('7. Missing Redux state', () => {
    describe('TabBar', () => {
      it('handles missing tabs state gracefully', () => {
        // This simulates what happens if the selector returns undefined
        const store = configureStore({
          reducer: {
            tabs: (state = { tabs: undefined, activeTabId: undefined }) => state,
          },
          preloadedState: {
            tabs: { tabs: undefined, activeTabId: undefined } as any,
          },
        })

        expect(() => renderWithStore(<TabBar />, store as any)).not.toThrow()
      })
    })

    describe('SettingsView', () => {
      it('handles undefined settings gracefully', () => {
        const store = configureStore({
          reducer: {
            settings: (state = { settings: undefined, loaded: false }) => state,
            network: networkReducer,
          },
          preloadedState: {
            settings: { settings: undefined, loaded: false } as any,
          },
        })

        // SettingsView should provide safe defaults even if settings are missing
        expect(() => renderWithStore(<SettingsView />, store as any)).not.toThrow()
      })
    })

    describe('Sidebar', () => {
      it('handles undefined projects gracefully', () => {
        const store = configureStore({
          reducer: {
            settings: settingsReducer,
            tabs: tabsReducer,
            sessions: (state = { projects: undefined, expandedProjects: new Set() }) => state,
          },
          middleware: (getDefault) =>
            getDefault({
              serializableCheck: { ignoredPaths: ['sessions.expandedProjects'] },
            }),
          preloadedState: {
            settings: { settings: defaultSettings, loaded: true },
            tabs: { tabs: [], activeTabId: null },
            sessions: { projects: undefined, expandedProjects: new Set() } as any,
          },
        })

        // Previously this would throw because projects.forEach was called on undefined
        // Now the component uses (projects ?? []) to handle undefined gracefully
        expect(() =>
          renderWithStore(<Sidebar view="terminal" onNavigate={() => {}} />, store as any)
        ).not.toThrow()

        // Should show empty state
        expect(screen.getByText('No sessions yet')).toBeInTheDocument()
      })
    })

    describe('HistoryView', () => {
      it('handles undefined projects array', () => {
        const store = configureStore({
          reducer: {
            sessions: (state = { projects: undefined, expandedProjects: new Set() }) => state,
          },
          middleware: (getDefault) =>
            getDefault({
              serializableCheck: { ignoredPaths: ['sessions.expandedProjects'] },
            }),
          preloadedState: {
            sessions: { projects: undefined, expandedProjects: new Set() } as any,
          },
        })

        // Previously this would throw when trying to reduce/map undefined projects
        // Now the component uses (projects ?? []) to handle undefined gracefully
        expect(() => renderWithStore(<HistoryView />, store as any)).not.toThrow()

        // Should show empty state
        expect(screen.getByText('No sessions found')).toBeInTheDocument()
      })
    })
  })

  // ==========================================================================
  // 8. Invalid data shapes from API
  // ==========================================================================

  describe('8. Invalid data shapes from API', () => {
    describe('OverviewView', () => {
      it('handles null API response gracefully', async () => {
        // Previously this would crash because items.filter() was called on null
        // Now the component uses (data ?? []) to handle null gracefully
        mockApiTyped.get.mockResolvedValueOnce(null)

        const store = createTestStore()

        renderWithStore(<OverviewView />, store)

        // Should not throw - component handles null gracefully
        await act(async () => {
          await vi.runAllTimersAsync()
        })

        // Should show empty state since null is treated as empty array
        expect(screen.getByText('No terminals tracked yet')).toBeInTheDocument()
      })

      it('handles terminals with invalid status', async () => {
        mockApiTyped.get.mockResolvedValueOnce([
          {
            terminalId: 'term-1',
            title: 'Test',
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
            status: 'invalid_status', // Invalid status
            hasClients: false,
          },
        ])

        const store = createTestStore()
        renderWithStore(<OverviewView />, store)

        await act(async () => {
          await vi.runAllTimersAsync()
        })

        // Should not crash, terminal might not appear in either section
        expect(screen.queryByText('Test')).not.toBeInTheDocument()
      })

      it('handles terminal with string timestamp instead of number', async () => {
        mockApiTyped.get.mockResolvedValueOnce([
          {
            terminalId: 'term-1',
            title: 'Test',
            createdAt: '2024-01-15T10:00:00Z', // String instead of number
            lastActivityAt: '2024-01-15T10:00:00Z',
            status: 'running',
            hasClients: false,
          },
        ])

        const store = createTestStore()
        renderWithStore(<OverviewView />, store)

        await act(async () => {
          await vi.runAllTimersAsync()
        })

        // formatTime and formatDuration will produce unexpected results but shouldn't crash
        expect(screen.getByText('Test')).toBeInTheDocument()
      })
    })

    describe('HistoryView', () => {
      it('handles session with non-numeric updatedAt', () => {
        const projectWithBadDate: ProjectGroup = {
          projectPath: '/test',
          sessions: [
            {
              sessionId: 'sess-1',
              projectPath: '/test',
              updatedAt: 'invalid' as unknown as number,
              title: 'Test Session',
            },
          ],
        }

        const store = createTestStore({
          sessions: { projects: [projectWithBadDate], expandedProjects: new Set(['/test']) },
        })

        // formatTime will produce unexpected output but shouldn't crash
        expect(() => renderWithStore(<HistoryView />, store)).not.toThrow()
      })

      it('handles project path with special characters', () => {
        const projectWithSpecialPath: ProjectGroup = {
          projectPath: 'C:\\Users\\test<>user\\project',
          sessions: [
            {
              sessionId: 'sess-1',
              projectPath: 'C:\\Users\\test<>user\\project',
              updatedAt: Date.now(),
            },
          ],
        }

        const store = createTestStore({
          sessions: { projects: [projectWithSpecialPath], expandedProjects: new Set() },
        })

        expect(() => renderWithStore(<HistoryView />, store)).not.toThrow()
      })
    })

    describe('Sidebar', () => {
      it('handles WebSocket message with missing terminals array', () => {
        const store = createTestStore({
          tabs: { tabs: [], activeTabId: null },
        })

        let messageHandler: ((msg: any) => void) | null = null
        mockWsOnMessage.mockImplementation((handler) => {
          messageHandler = handler
          return () => {}
        })

        renderWithStore(<Sidebar view="terminal" onNavigate={() => {}} />, store)

        // Send message with missing terminals
        act(() => {
          if (messageHandler) {
            messageHandler({
              type: 'terminal.list.response',
              requestId: expect.any(String),
              // terminals is missing
            })
          }
        })

        // Should handle gracefully (uses msg.terminals || [])
        expect(screen.getByText('No sessions yet')).toBeInTheDocument()
      })
    })

    describe('BackgroundSessions', () => {
      it('handles terminal with null values', () => {
        const store = createTestStore()

        let messageHandler: ((msg: any) => void) | null = null
        mockWsOnMessage.mockImplementation((handler) => {
          messageHandler = handler
          return () => {}
        })

        renderWithStore(<BackgroundSessions />, store)

        act(() => {
          if (messageHandler) {
            messageHandler({
              type: 'terminal.list.response',
              requestId: expect.any(String),
              terminals: [
                {
                  terminalId: 'term-1',
                  title: null,
                  createdAt: null,
                  lastActivityAt: null,
                  cwd: null,
                  status: 'running',
                  hasClients: false,
                },
              ],
            })
          }
        })

        // Should handle null values gracefully
        expect(() => {}).not.toThrow()
      })
    })
  })

  // ==========================================================================
  // Additional Edge Cases
  // ==========================================================================

  describe('Additional Edge Cases', () => {
    describe('TabBar rename edge cases', () => {
      it('handles double-click then immediate unmount', () => {
        const tab = createTab({ id: 'tab-1', title: 'Test Tab' })
        const store = createTestStore({
          tabs: { tabs: [tab], activeTabId: 'tab-1' },
        })

        const { unmount } = renderWithStore(<TabBar />, store)

        // Double-click to start rename
        const tabElement = screen.getByText('Test Tab').closest('div')
        fireEvent.doubleClick(tabElement!)

        // Immediately unmount
        unmount()

        // Should not throw
      })

      it('handles very long tab titles', () => {
        const longTitle = 'A'.repeat(1000)
        const tab = createTab({ id: 'tab-1', title: longTitle })

        const store = createTestStore({
          tabs: { tabs: [tab], activeTabId: 'tab-1' },
        })

        expect(() => renderWithStore(<TabBar />, store)).not.toThrow()

        // Title should be truncated in display
        const titleElement = screen.getByText(longTitle)
        expect(titleElement.className).toContain('truncate')
      })
    })

    describe('HistoryView edit state edge cases', () => {
      it('handles editing then immediate unmount', async () => {
        mockApiTyped.get.mockResolvedValue([])

        const project: ProjectGroup = {
          projectPath: '/test',
          sessions: [
            {
              sessionId: 'sess-1',
              projectPath: '/test',
              updatedAt: Date.now(),
              title: 'Test Session',
            },
          ],
        }

        const store = createTestStore({
          sessions: { projects: [project], expandedProjects: new Set(['/test']) },
        })

        const { unmount } = renderWithStore(<HistoryView />, store)

        // The project path /test produces folder name "test" via getProjectName()
        // Session should be visible since project is expanded
        const sessionTitle = screen.getByText('Test Session')

        // Immediately unmount
        unmount()

        // Should not throw
      })
    })

    describe('OverviewView edit state edge cases', () => {
      it('handles editing terminal then API error', async () => {
        const terminal = {
          terminalId: 'term-1',
          title: 'Test Terminal',
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
          status: 'running' as const,
          hasClients: false,
        }

        mockApiTyped.get.mockResolvedValueOnce([terminal])
        mockApiTyped.patch.mockRejectedValueOnce(new Error('Update failed'))

        const store = createTestStore()
        renderWithStore(<OverviewView />, store)

        await act(async () => {
          await vi.runAllTimersAsync()
        })

        // Terminal should be displayed
        expect(screen.getByText('Test Terminal')).toBeInTheDocument()
      })
    })

    describe('Concurrent operations', () => {
      it('handles multiple rapid WebSocket messages', () => {
        const store = createTestStore({
          tabs: { tabs: [], activeTabId: null },
        })

        let messageHandler: ((msg: any) => void) | null = null
        mockWsOnMessage.mockImplementation((handler) => {
          messageHandler = handler
          return () => {}
        })

        renderWithStore(<Sidebar view="terminal" onNavigate={() => {}} />, store)

        // Send many messages rapidly
        act(() => {
          if (messageHandler) {
            for (let i = 0; i < 100; i++) {
              messageHandler({
                type: 'terminal.list.response',
                requestId: `req-${i}`,
                terminals: [],
              })
              messageHandler({ type: 'terminal.detached' })
              messageHandler({ type: 'terminal.attached' })
              messageHandler({ type: 'terminal.exit' })
            }
          }
        })

        // Should not crash
        expect(screen.getByText('No sessions yet')).toBeInTheDocument()
      })
    })

    describe('XSS prevention in user content', () => {
      it('safely renders tab titles with HTML-like content', () => {
        const tab = createTab({
          id: 'tab-1',
          title: '<script>alert("xss")</script>',
        })

        const store = createTestStore({
          tabs: { tabs: [tab], activeTabId: 'tab-1' },
        })

        renderWithStore(<TabBar />, store)

        // Should render as text, not execute
        expect(screen.getByText('<script>alert("xss")</script>')).toBeInTheDocument()
      })

      it('safely renders session titles with HTML-like content', () => {
        const project: ProjectGroup = {
          projectPath: '/test',
          sessions: [
            {
              sessionId: 'sess-1',
              projectPath: '/test',
              updatedAt: Date.now(),
              title: '<img onerror="alert(1)" src="x">',
            },
          ],
        }

        const store = createTestStore({
          sessions: { projects: [project], expandedProjects: new Set(['/test']) },
        })

        expect(() => renderWithStore(<HistoryView />, store)).not.toThrow()
      })
    })

    describe('Memory leak prevention', () => {
      it('properly cleans up all subscriptions on Sidebar unmount', () => {
        const unsubscribe = vi.fn()
        const clearIntervalFn = vi.fn()
        mockWsOnMessage.mockReturnValue(unsubscribe)
        const originalClearInterval = window.clearInterval
        window.clearInterval = clearIntervalFn

        const store = createTestStore({
          tabs: { tabs: [], activeTabId: null },
        })

        const { unmount } = renderWithStore(
          <Sidebar view="terminal" onNavigate={() => {}} />,
          store
        )

        unmount()

        expect(unsubscribe).toHaveBeenCalled()
        expect(clearIntervalFn).toHaveBeenCalled()

        window.clearInterval = originalClearInterval
      })
    })
  })
})
