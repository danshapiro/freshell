import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import Sidebar from '@/components/Sidebar'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionsReducer from '@/store/sessionsSlice'
import sessionActivityReducer from '@/store/sessionActivitySlice'
import terminalDirectoryReducer from '@/store/terminalDirectorySlice'

// Mock react-window's List component
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

// Mock the WebSocket client
const mockSend = vi.fn()
const mockOnMessage = vi.fn(() => () => {})
const mockConnect = vi.fn().mockResolvedValue(undefined)
const mockFetchSidebarSessionsSnapshot = vi.fn()
const mockGetTerminalDirectoryPage = vi.fn()

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: mockSend,
    onMessage: mockOnMessage,
    connect: mockConnect,
  }),
}))

// Mock the searchSessions API
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual('@/lib/api')
  return {
    ...actual,
    fetchSidebarSessionsSnapshot: (...args: any[]) => mockFetchSidebarSessionsSnapshot(...args),
    getTerminalDirectoryPage: (...args: any[]) => mockGetTerminalDirectoryPage(...args),
    searchSessions: vi.fn(),
  }
})

function createTestStore() {
  return configureStore({
    reducer: {
      settings: settingsReducer,
      tabs: tabsReducer,
      panes: panesReducer,
      connection: connectionReducer,
      sessions: sessionsReducer,
      sessionActivity: sessionActivityReducer,
      terminalDirectory: terminalDirectoryReducer,
    },
    middleware: (getDefault) =>
      getDefault({
        serializableCheck: {
          ignoredPaths: ['sessions.expandedProjects'],
        },
      }),
    preloadedState: {
      settings: {
        settings: {
          ...defaultSettings,
          sidebar: {
            ...defaultSettings.sidebar,
            sortMode: 'activity' as const,
            showProjectBadges: true,
            hideEmptySessions: false,
          },
        },
        loaded: true,
        lastSavedAt: undefined,
      },
      tabs: {
        tabs: [],
        activeTabId: null,
      },
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
      },
      sessions: {
        projects: [],
        expandedProjects: new Set<string>(),
        isLoading: false,
        error: null,
      },
      connection: {
        status: 'connected',
        error: null,
      },
      sessionActivity: {
        sessions: {},
      },
    },
  })
}

function renderSidebar(store: ReturnType<typeof createTestStore>) {
  const onNavigate = vi.fn()
  mockGetTerminalDirectoryPage.mockResolvedValue({
    items: [],
    nextCursor: null,
    revision: 1,
  })

  const result = render(
    <Provider store={store}>
      <Sidebar view="terminal" onNavigate={onNavigate} />
    </Provider>
  )

  return { ...result, onNavigate }
}

describe('Sidebar mobile touch targets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockFetchSidebarSessionsSnapshot.mockReset()
    mockFetchSidebarSessionsSnapshot.mockResolvedValue({ projects: [] })
    mockGetTerminalDirectoryPage.mockReset()
    mockGetTerminalDirectoryPage.mockResolvedValue({
      items: [],
      nextCursor: null,
      revision: 1,
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('nav buttons have py-2.5 md:py-1.5 and min-h-11 md:min-h-0 classes for mobile touch target', () => {
    const store = createTestStore()
    renderSidebar(store)

    act(() => {
      vi.advanceTimersByTime(100)
    })

    // Nav buttons have title attributes like "Coding Agents (Ctrl+B T)"
    const terminalNavButton = screen.getByTitle('Coding Agents (Ctrl+B T)')
    expect(terminalNavButton.className).toMatch(/py-2\.5/)
    expect(terminalNavButton.className).toMatch(/md:py-1\.5/)
    expect(terminalNavButton.className).toMatch(/min-h-11/)
    expect(terminalNavButton.className).toMatch(/md:min-h-0/)
  })
})
