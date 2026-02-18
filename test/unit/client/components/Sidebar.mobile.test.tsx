import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'crypto'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import Sidebar from '@/components/Sidebar'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionsReducer from '@/store/sessionsSlice'
import sessionActivityReducer from '@/store/sessionActivitySlice'
import type { ProjectGroup } from '@/store/types'

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
    searchSessions: vi.fn(),
  }
})

const sessionId = (label: string) => {
  const hex = createHash('md5').update(label).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function createTestStore(options?: { projects?: ProjectGroup[] }) {
  const projects = (options?.projects ?? []).map((project) => ({
    ...project,
    sessions: (project.sessions ?? []).map((session) => ({
      ...session,
      provider: session.provider ?? 'claude',
    })),
  }))

  return configureStore({
    reducer: {
      settings: settingsReducer,
      tabs: tabsReducer,
      panes: panesReducer,
      connection: connectionReducer,
      sessions: sessionsReducer,
      sessionActivity: sessionActivityReducer,
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
        projects,
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
  let messageCallback: ((msg: any) => void) | null = null

  mockSend.mockImplementation((msg: any) => {
    if (msg.type === 'terminal.list' && messageCallback) {
      setTimeout(() => {
        messageCallback!({
          type: 'terminal.list.response',
          requestId: msg.requestId,
          terminals: [],
        })
      }, 0)
    }
  })

  mockOnMessage.mockImplementation((callback: (msg: any) => void) => {
    messageCallback = callback
    return () => { messageCallback = null }
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
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('session item button has py-3 md:py-2 classes for mobile touch target', async () => {
    const projects: ProjectGroup[] = [
      {
        projectPath: '/home/user/project',
        sessions: [
          {
            sessionId: sessionId('session-1'),
            projectPath: '/home/user/project',
            updatedAt: Date.now(),
            title: 'Test session',
            cwd: '/home/user/project',
          },
        ],
      },
    ]

    const store = createTestStore({ projects })
    renderSidebar(store)

    await act(async () => {
      vi.advanceTimersByTime(100)
    })

    const sessionButton = screen.getByText('Test session').closest('button')
    expect(sessionButton).not.toBeNull()
    expect(sessionButton!.className).toMatch(/py-3/)
    expect(sessionButton!.className).toMatch(/md:py-2/)
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

  it('search clear button has min-h-11 min-w-11 md:min-h-0 md:min-w-0 classes for mobile touch target', () => {
    const store = createTestStore()
    renderSidebar(store)

    act(() => {
      vi.advanceTimersByTime(100)
    })

    // Type in search to reveal clear button
    const searchInput = screen.getByPlaceholderText('Search...')
    fireEvent.change(searchInput, { target: { value: 'test' } })

    const clearButton = screen.getByRole('button', { name: /clear search/i })
    expect(clearButton.className).toMatch(/min-h-11/)
    expect(clearButton.className).toMatch(/min-w-11/)
    expect(clearButton.className).toMatch(/md:min-h-0/)
    expect(clearButton.className).toMatch(/md:min-w-0/)
  })
})
