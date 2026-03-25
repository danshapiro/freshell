import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import HistoryView from '@/components/HistoryView'
import sessionsReducer from '@/store/sessionsSlice'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import { api } from '@/lib/api'

const searchSessions = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue([]),
    put: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
  fetchSidebarSessionsSnapshot: vi.fn().mockResolvedValue({
    projects: [],
    totalSessions: 0,
    oldestIncludedTimestamp: 0,
    oldestIncludedSessionId: '',
    hasMore: false,
  }),
  searchSessions: (...args: any[]) => searchSessions(...args),
}))

function renderHistoryView(
  onOpenSession = vi.fn(),
  sessionsOverride?: any,
) {
  const projectPath = sessionsOverride?.projects?.[0]?.projectPath ?? '/test/project'
  const store = configureStore({
    reducer: {
      sessions: sessionsReducer,
      tabs: tabsReducer,
      panes: panesReducer,
    },
    middleware: (getDefault) =>
      getDefault({
        serializableCheck: {
          ignoredPaths: ['sessions.expandedProjects'],
        },
      }),
    preloadedState: {
      sessions: {
        projects: sessionsOverride?.projects ?? [
          {
            projectPath,
            color: '#6b7280',
            sessions: [
              {
                provider: 'claude',
                sessionId: 'session-123',
                projectPath,
                lastActivityAt: Date.now(),
                title: 'Test Session',
                summary: 'summary',
              },
            ],
          },
        ],
        expandedProjects: sessionsOverride?.expandedProjects ?? new Set([projectPath]),
        windows: sessionsOverride?.windows,
      },
      tabs: { tabs: [], activeTabId: null },
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
    } as any,
  })

  const utils = render(
    <Provider store={store}>
      <HistoryView onOpenSession={onOpenSession} />
    </Provider>
  )
  return { store, ...utils }
}

describe('HistoryView mobile behavior', () => {
  afterEach(() => {
    cleanup()
    searchSessions.mockReset()
    vi.useRealTimers()
    ;(globalThis as any).setMobileForTest(false)
  })

  it('opens mobile bottom sheet for session details before opening session', () => {
    ;(globalThis as any).setMobileForTest(true)
    const onOpenSession = vi.fn()

    renderHistoryView(onOpenSession)

    fireEvent.click(screen.getByRole('button', { name: /open session test session/i }))

    expect(screen.getByText('Session details')).toBeInTheDocument()
    expect(onOpenSession).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(onOpenSession).toHaveBeenCalledTimes(1)
  })

  it('uses 44px touch targets for mobile session actions', () => {
    ;(globalThis as any).setMobileForTest(true)

    renderHistoryView()

    expect(screen.getByRole('button', { name: 'Open session' }).className).toContain('min-h-11')
    expect(screen.getByRole('button', { name: 'Edit session' }).className).toContain('min-h-11')
    expect(screen.getByRole('button', { name: 'Delete session' }).className).toContain('min-h-11')
  })

  it('opens agent-chat sessions with their sessionType instead of falling back to a terminal tab', async () => {
    const projectPath = '/test/project'
    const store = configureStore({
      reducer: {
        sessions: sessionsReducer,
        tabs: tabsReducer,
        panes: panesReducer,
      },
      middleware: (getDefault) =>
        getDefault({
          serializableCheck: {
            ignoredPaths: ['sessions.expandedProjects'],
          },
        }),
      preloadedState: {
        sessions: {
          projects: [
            {
              projectPath,
              color: '#6b7280',
              sessions: [
                {
                  provider: 'claude',
                  sessionType: 'freshclaude',
                  sessionId: '550e8400-e29b-41d4-a716-446655440000',
                  projectPath,
                  updatedAt: Date.now(),
                  title: 'FreshClaude Session',
                  summary: 'summary',
                },
              ],
            },
          ],
          expandedProjects: new Set([projectPath]),
        },
        tabs: { tabs: [], activeTabId: null },
        panes: {
          layouts: {},
          activePane: {},
          paneTitles: {},
          paneTitleSetByUser: {},
          renameRequestTabId: null,
          renameRequestPaneId: null,
          zoomedPane: {},
          refreshRequestsByPane: {},
        },
      } as any,
    })

    render(
      <Provider store={store}>
        <HistoryView />
      </Provider>
    )

    fireEvent.click(screen.getByRole('button', { name: /open session freshclaude session/i }))

    await waitFor(() => {
      const state = store.getState()
      const tabId = state.tabs.activeTabId as string
      const layout = state.panes?.layouts?.[tabId]
      expect(layout?.type).toBe('leaf')
      if (layout?.type === 'leaf') {
        expect(layout.content).toMatchObject({
          kind: 'agent-chat',
          provider: 'freshclaude',
          resumeSessionId: '550e8400-e29b-41d4-a716-446655440000',
        })
      }
    })
  })

  it('renames the targeted duplicate Kimi history session using its opaque cwd-scoped key', async () => {
    const projectPath = '/repo/root'
    const store = configureStore({
      reducer: {
        sessions: sessionsReducer,
        tabs: tabsReducer,
        panes: panesReducer,
      },
      middleware: (getDefault) =>
        getDefault({
          serializableCheck: {
            ignoredPaths: ['sessions.expandedProjects'],
          },
        }),
      preloadedState: {
        sessions: {
          projects: [
            {
              projectPath,
              sessions: [
                {
                  provider: 'kimi',
                  sessionId: 'shared-kimi-session',
                  sessionKey: `kimi:cwd=${Buffer.from('/repo/root/packages/app-a', 'utf8').toString('base64url')}:sid=${Buffer.from('shared-kimi-session', 'utf8').toString('base64url')}`,
                  projectPath,
                  cwd: '/repo/root/packages/app-a',
                  lastActivityAt: Date.now(),
                  title: 'Kimi app A',
                },
                {
                  provider: 'kimi',
                  sessionId: 'shared-kimi-session',
                  sessionKey: `kimi:cwd=${Buffer.from('/repo/root/packages/app-b', 'utf8').toString('base64url')}:sid=${Buffer.from('shared-kimi-session', 'utf8').toString('base64url')}`,
                  projectPath,
                  cwd: '/repo/root/packages/app-b',
                  lastActivityAt: Date.now() - 1000,
                  title: 'Kimi app B',
                },
              ],
            },
          ],
          expandedProjects: new Set([projectPath]),
        },
        tabs: { tabs: [], activeTabId: null },
        panes: {
          layouts: {},
          activePane: {},
          paneTitles: {},
          paneTitleSetByUser: {},
          renameRequestTabId: null,
          renameRequestPaneId: null,
          zoomedPane: {},
          refreshRequestsByPane: {},
        },
      } as any,
    })

    render(
      <Provider store={store}>
        <HistoryView />
      </Provider>
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit session' })[1])
    fireEvent.change(screen.getByLabelText('Session title'), { target: { value: 'Renamed Kimi app B' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(vi.mocked(api.patch)).toHaveBeenCalledWith(
      `/api/sessions/${encodeURIComponent(`kimi:cwd=${Buffer.from('/repo/root/packages/app-b', 'utf8').toString('base64url')}:sid=${Buffer.from('shared-kimi-session', 'utf8').toString('base64url')}`)}`,
      { titleOverride: 'Renamed Kimi app B', summaryOverride: undefined },
    )
  })

  it('routes history search through backend deep search instead of local filtering only', async () => {
    searchSessions
      .mockResolvedValueOnce({
        results: [],
        tier: 'title',
        query: 'visible-assistant-token-kimi',
        totalScanned: 1,
      })
      .mockResolvedValueOnce({
        results: [{
          provider: 'kimi',
          sessionId: 'kimi-session-1',
          projectPath: '/repo/root/packages/app-b',
          title: 'Transcript Match',
          matchedIn: 'assistantMessage',
          lastActivityAt: Date.now(),
          cwd: '/repo/root/packages/app-b',
        }],
        tier: 'fullText',
        query: 'visible-assistant-token-kimi',
        totalScanned: 1,
      })

    renderHistoryView(undefined, {
      projects: [
        {
          projectPath: '/repo/root/packages/app-a',
          color: '#6b7280',
          sessions: [
            {
              provider: 'claude',
              sessionId: 'session-123',
              projectPath: '/repo/root/packages/app-a',
              lastActivityAt: Date.now(),
              title: 'Local session only',
              summary: 'summary',
            },
          ],
        },
      ],
      expandedProjects: new Set(['/repo/root/packages/app-a']),
    })

    fireEvent.change(screen.getByPlaceholderText('Search sessions, projects...'), {
      target: { value: 'visible-assistant-token-kimi' },
    })
    await new Promise((resolve) => setTimeout(resolve, 350))

    await waitFor(() => {
      expect(searchSessions).toHaveBeenNthCalledWith(1, expect.objectContaining({
        query: 'visible-assistant-token-kimi',
        tier: 'title',
      }))
      expect(searchSessions).toHaveBeenNthCalledWith(2, expect.objectContaining({
        query: 'visible-assistant-token-kimi',
        tier: 'fullText',
      }))
    })

    expect(await screen.findByText('/repo/root/packages/app-b')).toBeInTheDocument()
    expect(screen.queryByText('/repo/root/packages/app-a')).not.toBeInTheDocument()
  })
})
