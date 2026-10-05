import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import HistoryView from '@/components/HistoryView'
import sessionsReducer from '@/store/sessionsSlice'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'

const apiMocks = vi.hoisted(() => ({
  get: vi.fn().mockResolvedValue([]),
  put: vi.fn().mockResolvedValue({}),
  patch: vi.fn().mockResolvedValue({}),
  delete: vi.fn().mockResolvedValue({}),
  fetchSidebarSessionsSnapshot: vi.fn().mockResolvedValue({
    projects: [],
    totalSessions: 0,
    oldestIncludedTimestamp: 0,
    oldestIncludedSessionId: '',
    hasMore: false,
  }),
  searchSessions: vi.fn().mockResolvedValue({ results: [], hasMore: false }),
}))

// Same stub shape as HistoryView.mobile.test.tsx: spread the real module so
// pure named exports (e.g. isApiUnauthorizedError, consulted by
// fetchSessionWindow's rejection handler) stay live, and stub the thunk's
// direct network entry points so no real fetch escapes.
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: apiMocks,
    fetchSidebarSessionsSnapshot: apiMocks.fetchSidebarSessionsSnapshot,
    searchSessions: apiMocks.searchSessions,
  }
})

function renderHistoryView() {
  const projectPath = '/test/project'
  const session = {
    provider: 'claude' as const,
    sessionId: 'session-123',
    projectPath,
    lastActivityAt: Date.now(),
    title: 'Test Session',
    summary: 'summary',
  }
  const projects = [
    {
      projectPath,
      color: '#6b7280',
      sessions: [session],
    },
  ]

  // HistoryView loads its own window on mount. Keep that server response
  // consistent with the session already present in this test's initial store.
  apiMocks.fetchSidebarSessionsSnapshot.mockResolvedValueOnce({
    projects,
    totalSessions: 1,
    oldestIncludedTimestamp: session.lastActivityAt,
    oldestIncludedSessionId: session.sessionId,
    hasMore: false,
  })

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
        projects,
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
  return store
}

describe('HistoryView session delete', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('deletes through the composite-key route and removes the session from store state', async () => {
    const store = renderHistoryView()

    fireEvent.click(screen.getByRole('button', { name: 'Delete session' }))

    await waitFor(() => {
      expect(apiMocks.delete).toHaveBeenCalledWith(
        `/api/sessions/${encodeURIComponent('claude:session-123')}`,
      )
    })
    await waitFor(() => {
      expect(
        store.getState().sessions.projects
          .flatMap((p: any) => p.sessions)
          .some((s: any) => s.sessionId === 'session-123'),
      ).toBe(false)
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('surfaces a failed delete inline and keeps the session (SESSION-03)', async () => {
    apiMocks.delete.mockRejectedValueOnce(new Error('boom'))
    const store = renderHistoryView()

    fireEvent.click(screen.getByRole('button', { name: 'Delete session' }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Failed to delete session: boom')
    })
    expect(
      store.getState().sessions.projects
        .flatMap((p: any) => p.sessions)
        .some((s: any) => s.sessionId === 'session-123'),
    ).toBe(true)
  })

  it('the delete-error banner is dismissable with an X (error clears, session kept)', async () => {
    apiMocks.delete.mockRejectedValueOnce(new Error('boom'))
    renderHistoryView()

    fireEvent.click(screen.getByRole('button', { name: 'Delete session' }))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Failed to delete session: boom')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })
})
