import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { createHash } from 'crypto'
import Sidebar from '@/components/Sidebar'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionsReducer from '@/store/sessionsSlice'
import sessionActivityReducer from '@/store/sessionActivitySlice'
import type { ProjectGroup, BackgroundTerminal } from '@/store/types'

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

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual('@/lib/api')
  return { ...actual, searchSessions: vi.fn() }
})

const sessionId = (label: string) => {
  const hex = createHash('md5').update(label).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function createStore(options: {
  projects: ProjectGroup[]
  tabs?: Array<{
    id: string
    title?: string
    mode?: string
    status?: string
    createdAt?: number
    createRequestId?: string
    shell?: string
  }>
  activeTabId?: string | null
  panes?: {
    layouts: Record<string, any>
    activePane: Record<string, string>
    paneTitles?: Record<string, Record<string, string>>
  }
  terminals?: BackgroundTerminal[]
}) {
  const projects = options.projects.map((project) => ({
    ...project,
    sessions: (project.sessions ?? []).map((session) => ({
      ...session,
      provider: session.provider ?? 'claude',
    })),
  }))

  // Infer pane layouts from tabs if not explicitly provided
  const inferredLayouts: Record<string, any> = {}
  const inferredActivePane: Record<string, string> = {}
  if (!options.panes) {
    for (const tab of options.tabs ?? []) {
      const paneId = `pane-${tab.id}`
      inferredLayouts[tab.id] = {
        type: 'leaf',
        id: paneId,
        content: {
          kind: 'terminal',
          mode: tab.mode || 'shell',
          createRequestId: `req-${tab.id}`,
          status: tab.status || 'running',
        },
      }
      inferredActivePane[tab.id] = paneId
    }
  }

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
            sortMode: 'activity',
            showProjectBadges: true,
          },
        },
        loaded: true,
        lastSavedAt: undefined,
      },
      tabs: {
        tabs: options.tabs?.map((t) => ({
          id: t.id,
          title: t.title || t.id,
          mode: t.mode || 'shell',
          status: t.status || 'running',
          createdAt: t.createdAt || Date.now(),
          createRequestId: t.createRequestId || `req-${t.id}`,
          shell: t.shell || 'system',
        })) ?? [],
        activeTabId: options.activeTabId ?? null,
      },
      panes: options.panes ?? {
        layouts: inferredLayouts,
        activePane: inferredActivePane,
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

function renderSidebar(store: ReturnType<typeof createStore>, terminals: BackgroundTerminal[] = []) {
  const onNavigate = vi.fn()
  let messageCallback: ((msg: any) => void) | null = null

  mockSend.mockImplementation((msg: any) => {
    if (msg.type === 'terminal.list' && messageCallback) {
      setTimeout(() => {
        messageCallback!({
          type: 'terminal.list.response',
          requestId: msg.requestId,
          terminals,
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

  return { ...result, onNavigate, store }
}

describe('sidebar click opens pane (e2e)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('clicking a session splits a pane in the current tab', async () => {
    const projects: ProjectGroup[] = [
      {
        projectPath: '/home/user/project',
        sessions: [
          {
            sessionId: sessionId('new-session'),
            projectPath: '/home/user/project',
            updatedAt: Date.now(),
            title: 'New session to open',
            cwd: '/home/user/project',
          },
        ],
      },
    ]

    const store = createStore({
      projects,
      tabs: [
        { id: 'tab-1', mode: 'shell' },
      ],
      activeTabId: 'tab-1',
    })

    renderSidebar(store)

    await act(async () => {
      vi.advanceTimersByTime(100)
    })

    const sessionButton = screen.getByText('New session to open').closest('button')
    fireEvent.click(sessionButton!)

    const state = store.getState()

    // Should NOT create a new tab
    expect(state.tabs.tabs).toHaveLength(1)

    // The layout should now be a split with two children
    const layout = state.panes.layouts['tab-1']
    expect(layout.type).toBe('split')
    if (layout.type === 'split') {
      const leaves = [layout.children[0], layout.children[1]]
      const sessionPane = leaves.find(
        (child: any) =>
          child.type === 'leaf' &&
          child.content.kind === 'terminal' &&
          child.content.resumeSessionId === sessionId('new-session')
      )
      expect(sessionPane).toBeDefined()
      // The new pane should be in 'creating' status (not running, since no terminalId)
      expect(sessionPane!.content.status).toBe('creating')
      expect(sessionPane!.content.mode).toBe('claude')
    }
  })

  it('clicking a session already open focuses the existing pane', async () => {
    const targetId = sessionId('already-open')

    const projects: ProjectGroup[] = [
      {
        projectPath: '/home/user/project',
        sessions: [
          {
            sessionId: targetId,
            projectPath: '/home/user/project',
            updatedAt: Date.now(),
            title: 'Already open session',
            cwd: '/home/user/project',
          },
        ],
      },
    ]

    const store = createStore({
      projects,
      tabs: [
        { id: 'tab-1', mode: 'shell' },
        { id: 'tab-2', mode: 'claude' },
      ],
      activeTabId: 'tab-1',
      panes: {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'shell',
              createRequestId: 'req-1',
              status: 'running',
            },
          },
          'tab-2': {
            type: 'leaf',
            id: 'pane-2',
            content: {
              kind: 'terminal',
              mode: 'claude',
              createRequestId: 'req-2',
              status: 'running',
              resumeSessionId: targetId,
            },
          },
        },
        activePane: {
          'tab-1': 'pane-1',
          'tab-2': 'pane-2',
        },
        paneTitles: {},
      },
    })

    renderSidebar(store)

    await act(async () => {
      vi.advanceTimersByTime(100)
    })

    const sessionButton = screen.getByText('Already open session').closest('button')
    fireEvent.click(sessionButton!)

    const state = store.getState()

    // Should not create any new tabs or panes
    expect(state.tabs.tabs).toHaveLength(2)
    // Should switch to tab-2 where the session lives
    expect(state.tabs.activeTabId).toBe('tab-2')
    // Should focus the existing pane
    expect(state.panes.activePane['tab-2']).toBe('pane-2')
    // Layout should be unchanged (still a leaf, no split)
    expect(state.panes.layouts['tab-2'].type).toBe('leaf')
  })

  it('clicking a session already open in a claude-chat pane focuses it', async () => {
    const targetId = sessionId('freshclaude-open')

    const projects: ProjectGroup[] = [
      {
        projectPath: '/home/user/project',
        sessions: [
          {
            sessionId: targetId,
            projectPath: '/home/user/project',
            updatedAt: Date.now(),
            title: 'Freshclaude session',
            cwd: '/home/user/project',
          },
        ],
      },
    ]

    const store = createStore({
      projects,
      tabs: [
        { id: 'tab-1', mode: 'shell' },
        { id: 'tab-2', mode: 'claude' },
      ],
      activeTabId: 'tab-1',
      panes: {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'shell',
              createRequestId: 'req-1',
              status: 'running',
            },
          },
          'tab-2': {
            type: 'leaf',
            id: 'pane-chat',
            content: {
              kind: 'claude-chat',
              createRequestId: 'req-chat',
              status: 'idle',
              resumeSessionId: targetId,
            },
          },
        },
        activePane: {
          'tab-1': 'pane-1',
          'tab-2': 'pane-chat',
        },
        paneTitles: {},
      },
    })

    renderSidebar(store)

    await act(async () => {
      vi.advanceTimersByTime(100)
    })

    const sessionButton = screen.getByText('Freshclaude session').closest('button')
    fireEvent.click(sessionButton!)

    const state = store.getState()

    // Should not create any new tabs or panes
    expect(state.tabs.tabs).toHaveLength(2)
    // Should switch to tab-2 where the freshclaude session lives
    expect(state.tabs.activeTabId).toBe('tab-2')
    // Should focus the existing claude-chat pane
    expect(state.panes.activePane['tab-2']).toBe('pane-chat')
    // Layout should be unchanged (still a leaf, no split)
    expect(state.panes.layouts['tab-2'].type).toBe('leaf')
  })

  it('clicking a session with no active tab creates a new tab', async () => {
    const projects: ProjectGroup[] = [
      {
        projectPath: '/home/user/project',
        sessions: [
          {
            sessionId: sessionId('orphan-session'),
            projectPath: '/home/user/project',
            updatedAt: Date.now(),
            title: 'Orphan session',
            cwd: '/home/user/project',
          },
        ],
      },
    ]

    const store = createStore({
      projects,
      tabs: [],
      activeTabId: null,
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
      },
    })

    const { onNavigate } = renderSidebar(store)

    await act(async () => {
      vi.advanceTimersByTime(100)
    })

    const sessionButton = screen.getByText('Orphan session').closest('button')
    fireEvent.click(sessionButton!)

    const state = store.getState()

    // Should create a new tab via openSessionTab fallback
    expect(state.tabs.tabs).toHaveLength(1)
    expect(state.tabs.tabs[0].resumeSessionId).toBe(sessionId('orphan-session'))
    expect(state.tabs.tabs[0].mode).toBe('claude')
    expect(onNavigate).toHaveBeenCalledWith('terminal')
  })
})
