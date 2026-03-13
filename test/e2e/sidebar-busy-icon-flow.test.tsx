import { describe, it, expect, vi, afterEach } from 'vitest'
import { createHash } from 'crypto'
import { act, cleanup, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import Sidebar from '@/components/Sidebar'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionsReducer from '@/store/sessionsSlice'
import sessionActivityReducer from '@/store/sessionActivitySlice'
import extensionsReducer from '@/store/extensionsSlice'
import codexActivityReducer, { type CodexActivityState } from '@/store/codexActivitySlice'
import terminalDirectoryReducer, { setTerminalDirectoryWindowData } from '@/store/terminalDirectorySlice'
import type { ProjectGroup, BackgroundTerminal } from '@/store/types'
import type { ClientExtensionEntry } from '@shared/extension-types'

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
vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: mockSend,
    onMessage: vi.fn(() => () => {}),
    connect: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual('@/lib/api')
  return {
    ...actual,
    fetchSidebarSessionsSnapshot: vi.fn(),
    getTerminalDirectoryPage: vi.fn(),
    searchSessions: vi.fn(),
  }
})

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

const sessionId = (label: string) => {
  const hex = createHash('md5').update(label).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function createStore(options: {
  projects: ProjectGroup[]
  tabs?: Array<{
    id: string
    terminalId?: string
    resumeSessionId?: string
    mode?: string
    status?: string
  }>
  activeTabId?: string | null
  codexActivity?: Partial<CodexActivityState>
}) {
  const projects = options.projects.map((project) => ({
    ...project,
    sessions: (project.sessions ?? []).map((session) => ({
      ...session,
      provider: session.provider ?? 'claude',
    })),
  }))

  const inferredLayouts: Record<string, any> = {}
  const inferredActivePane: Record<string, string> = {}
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
        terminalId: tab.terminalId,
        resumeSessionId: tab.resumeSessionId,
      },
    }
    inferredActivePane[tab.id] = paneId
  }

  return configureStore({
    reducer: {
      settings: settingsReducer,
      tabs: tabsReducer,
      panes: panesReducer,
      connection: connectionReducer,
      sessions: sessionsReducer,
      sessionActivity: sessionActivityReducer,
      extensions: extensionsReducer,
      codexActivity: codexActivityReducer,
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
            sortMode: 'activity',
            showProjectBadges: true,
            hideEmptySessions: false,
          },
        },
        loaded: true,
        lastSavedAt: undefined,
      },
      tabs: {
        tabs: options.tabs?.map((t) => ({
          id: t.id,
          title: t.id,
          mode: t.mode || 'shell',
          status: t.status || 'running',
          createdAt: Date.now(),
          createRequestId: `req-${t.id}`,
          shell: 'system',
          terminalId: t.terminalId,
          resumeSessionId: t.resumeSessionId,
        })) ?? [],
        activeTabId: options.activeTabId ?? null,
      },
      panes: {
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
      extensions: {
        entries: defaultCliExtensions,
      },
      codexActivity: {
        byTerminalId: {},
        lastSnapshotSeq: 0,
        liveMutationSeqByTerminalId: {},
        removedMutationSeqByTerminalId: {},
        ...(options.codexActivity ?? {}),
      },
      terminalDirectory: {
        windows: {
          sidebar: { items: [], nextCursor: null, revision: 1 },
        },
        searches: {},
      },
    },
  })
}

afterEach(() => cleanup())

describe('sidebar busy icon flow (e2e)', () => {
  it('shows blue icon for busy session, green for idle open session, muted for no-tab session', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    const terminalId = 'term-codex-1'
    const busySid = sessionId('busy-codex')
    const idleSid = sessionId('idle-open')
    const closedSid = sessionId('closed')

    const projects: ProjectGroup[] = [
      {
        projectPath: '/home/user/project',
        sessions: [
          {
            sessionId: busySid,
            projectPath: '/home/user/project',
            updatedAt: now,
            title: 'Busy Agent',
            cwd: '/home/user/project',
            provider: 'codex',
          },
          {
            sessionId: idleSid,
            projectPath: '/home/user/project',
            updatedAt: now - 1000,
            title: 'Idle Agent',
            cwd: '/home/user/project',
          },
          {
            sessionId: closedSid,
            projectPath: '/home/user/project',
            updatedAt: now - 2000,
            title: 'Closed Agent',
            cwd: '/home/user/project',
          },
        ],
      },
    ]

    const store = createStore({
      projects,
      tabs: [
        { id: 'tab-1', terminalId, resumeSessionId: busySid, mode: 'codex' },
        { id: 'tab-2', resumeSessionId: idleSid, mode: 'claude' },
      ],
      activeTabId: 'tab-1',
      codexActivity: {
        byTerminalId: {
          [terminalId]: {
            terminalId,
            sessionId: 'session-1',
            phase: 'busy',
            updatedAt: 10,
          },
        },
      },
    })

    // Inject the background terminal so the sidebar selector resolves runningTerminalId
    store.dispatch(setTerminalDirectoryWindowData({
      surface: 'sidebar',
      items: [{
        terminalId,
        title: 'Codex',
        createdAt: now,
        status: 'running',
        hasClients: true,
        mode: 'codex',
        resumeSessionId: busySid,
      }] as BackgroundTerminal[],
      nextCursor: null,
      revision: 2,
    }))

    render(
      <Provider store={store}>
        <Sidebar view="terminal" onNavigate={vi.fn()} />
      </Provider>,
    )

    await act(async () => {
      vi.advanceTimersByTime(100)
    })

    // Busy session → blue
    const busyButton = screen.getByRole('button', { name: /Busy Agent/ })
    expect(busyButton.querySelector('.text-blue-500')).toBeTruthy()
    expect(busyButton.querySelector('.text-success')).toBeFalsy()

    // Idle open session (has tab, not busy) → green
    const idleButton = screen.getByRole('button', { name: /Idle Agent/ })
    expect(idleButton.querySelector('.text-success')).toBeTruthy()
    expect(idleButton.querySelector('.text-blue-500')).toBeFalsy()

    // Closed session (no tab) → muted
    const closedButton = screen.getByRole('button', { name: /Closed Agent/ })
    expect(closedButton.querySelector('svg.text-muted-foreground')).toBeTruthy()
    expect(closedButton.querySelector('.text-success')).toBeFalsy()
    expect(closedButton.querySelector('.text-blue-500')).toBeFalsy()

    vi.useRealTimers()
  })
})
