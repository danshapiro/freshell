import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import HistoryView from '@/components/HistoryView'
import sessionsReducer from '@/store/sessionsSlice'
import sessionNamesReducer, { receiveSessionNames } from '@/store/sessionNamesSlice'
import tabsReducer, { addTab } from '@/store/tabsSlice'
import panesReducer, { initLayout } from '@/store/panesSlice'

const HISTORY_SESSION_ID = '11111111-2222-4333-8444-555555555555'

// Keep api helpers stubbed; spread the real module so pure named exports
// (e.g. isApiUnauthorizedError, consumed by fetchSessionWindow's rejection
// handler) stay live, and stub the thunk's direct network entry points
// benignly so no real fetch escapes.
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
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
    searchSessions: vi.fn().mockResolvedValue({ results: [], hasMore: false }),
  }
})

function renderHistoryView(onOpenSession = vi.fn(), sessionType?: string, historyLoaded = false) {
  const projectPath = '/test/project'
  const projects = [
    {
      projectPath,
      color: '#6b7280',
      sessions: [
        {
          provider: 'claude',
          sessionId: HISTORY_SESSION_ID,
          projectPath,
          lastActivityAt: Date.now(),
          title: 'Test Session',
          summary: 'summary',
          nameRef: { kind: 'session', provider: 'claude', sessionId: HISTORY_SESSION_ID },
          ...(sessionType ? { sessionType } : {}),
        },
      ],
    },
  ]
  const store = configureStore({
    reducer: {
      sessions: sessionsReducer,
      sessionNames: sessionNamesReducer,
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
        projects,
        ...(historyLoaded ? { windows: { history: { projects, lastLoadedAt: 1 } } } : {}),
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

  it('keeps the existing pane checkpoint workspace when history reopens that session with its current flavor', async () => {
    const { store } = renderHistoryView(vi.fn(), 'freshclaude', true)
    const checkpointWorkspace = { path: '/selected/project', provenance: 'directory-picker' as const }
    act(() => {
      store.dispatch(addTab({
        id: 'tab-source',
        title: 'Existing Kilroy',
        status: 'running',
        mode: 'claude',
        sessionRef: { provider: 'claude', sessionId: HISTORY_SESSION_ID },
      }))
      store.dispatch(initLayout({
        tabId: 'tab-source',
        paneId: 'pane-source',
        content: {
          kind: 'fresh-agent',
          sessionType: 'kilroy',
          provider: 'claude',
          createRequestId: 'req-source',
          resumeSessionId: HISTORY_SESSION_ID,
          sessionRef: { provider: 'claude', sessionId: HISTORY_SESSION_ID },
          status: 'idle',
          checkpointWorkspace,
        },
      }))
    })

    fireEvent.click(screen.getByRole('button', { name: /open session test session/i }))

    await waitFor(() => {
      expect(store.getState().panes.layouts['tab-source']).toMatchObject({
        type: 'leaf',
        content: { kind: 'fresh-agent', sessionType: 'freshclaude', checkpointWorkspace },
      })
    })
  })

  it('shows a nonblocking native-sync status row in the mobile session details sheet', async () => {
    ;(globalThis as any).setMobileForTest(true)
    const { store } = renderHistoryView()

    fireEvent.click(screen.getByRole('button', { name: /open session test session/i }))
    expect(screen.getByText('Session details')).toBeInTheDocument()
    // No writeback state yet: no status row.
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    act(() => {
      store.dispatch(receiveSessionNames([{
        record: {
          ref: { kind: 'session', provider: 'claude', sessionId: HISTORY_SESSION_ID },
          name: 'Test Session',
          source: 'first_message',
          revision: 1,
        },
        documentGeneration: 5,
        redirects: [],
        changed: true,
        nativeSync: {
          status: 'unsynced',
          desiredRevision: 1,
          locationRevision: 0,
          reason: 'provider writeback timed out',
        },
      }]))
    })

    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent(/native sync: unsynced/i)
    expect(status).toHaveTextContent(/provider writeback timed out/i)
    // Nonblocking display only: no retry/reset/generate control appears.
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /reset/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /generate/i })).not.toBeInTheDocument()
  })

  it('uses 44px touch targets for mobile session actions', () => {
    ;(globalThis as any).setMobileForTest(true)

    renderHistoryView()

    expect(screen.getByRole('button', { name: 'Open session' }).className).toContain('min-h-11')
    expect(screen.getByRole('button', { name: 'Edit session' }).className).toContain('min-h-11')
    expect(screen.getByRole('button', { name: 'Delete session' }).className).toContain('min-h-11')
  })

  it('opens fresh-agent sessions with their sessionType instead of falling back to a terminal tab', async () => {
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
          kind: 'fresh-agent',
          sessionType: 'freshclaude',
          provider: 'claude',
          resumeSessionId: '550e8400-e29b-41d4-a716-446655440000',
          sessionRef: {
            provider: 'claude',
            sessionId: '550e8400-e29b-41d4-a716-446655440000',
          },
        })
      }
    })
  })
})
