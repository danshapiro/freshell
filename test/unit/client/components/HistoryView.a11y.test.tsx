import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, act, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'

import HistoryView from '@/components/HistoryView'
import sessionsReducer, { commitSessionWindowVisibleRefresh } from '@/store/sessionsSlice'
import { queueActiveSessionWindowRefresh, _resetSessionWindowThunkState } from '@/store/sessionsThunks'
import tabsReducer from '@/store/tabsSlice'
import { fetchSidebarSessionsSnapshot } from '@/lib/api'

// HistoryView calls into api helpers for refresh/rename/delete; keep tests isolated.
// Spread the real module so pure named exports (e.g. isApiUnauthorizedError,
// consumed by fetchSessionWindow's rejection handler) stay live; `api` stays
// fully stubbed, and the thunk's direct network entry points are stubbed
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

function createSidebarLoadedStore() {
  const project = {
    projectPath: '/sidebar/already-loaded',
    sessions: [{
      provider: 'codex',
      sessionId: 'already-loaded-from-sidebar',
      projectPath: '/sidebar/already-loaded',
      lastActivityAt: Date.now(),
      title: 'Already loaded session',
    }],
  }
  const store = configureStore({
    reducer: {
      sessions: sessionsReducer,
      tabs: tabsReducer,
    },
    middleware: (getDefault) =>
      getDefault({
        serializableCheck: {
          ignoredPaths: ['sessions.expandedProjects'],
        },
      }),
    preloadedState: {
      sessions: {
        projects: [project],
        expandedProjects: new Set([project.projectPath]),
        activeSurface: 'sidebar',
        windows: {
          sidebar: {
            projects: [project],
            lastLoadedAt: Date.now(),
          },
        },
      },
      tabs: { tabs: [], activeTabId: null },
    } as any,
  })

  return { project, store }
}

describe('HistoryView a11y', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    _resetSessionWindowThunkState()
    vi.mocked(fetchSidebarSessionsSnapshot).mockReset()
    vi.mocked(fetchSidebarSessionsSnapshot).mockResolvedValue({
      projects: [],
      totalSessions: 0,
      oldestIncludedTimestamp: 0,
      oldestIncludedSessionId: '',
      hasMore: false,
    })
  })

  afterEach(() => {
    _resetSessionWindowThunkState()
    cleanup()
  })

  it('does not render nested <button> elements for session rows', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const projectPath = '/test/project'
    const store = configureStore({
      reducer: {
        sessions: sessionsReducer,
        tabs: tabsReducer,
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
                  sessionId: 'session-123',
                  projectPath,
                  lastActivityAt: Date.now(),
                  title: 'Test Session',
                },
              ],
            },
          ],
          expandedProjects: new Set([projectPath]),
        },
        tabs: { tabs: [], activeTabId: null },
      } as any,
    })

    const { container } = render(
      <Provider store={store}>
        <HistoryView />
      </Provider>
    )

    expect(container.querySelectorAll('button button').length).toBe(0)

    // The historical bug produced a validateDOMNesting warning for nested buttons.
    const nestingWarnings = consoleErrorSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((msg) => msg.includes('validateDOMNesting') && msg.includes('<button>'))
    expect(nestingWarnings).toEqual([])

    consoleErrorSpy.mockRestore()
  })

  it('announces a quarantined session-identity conflict on the history surface', () => {
    const store = configureStore({
      reducer: {
        sessions: sessionsReducer,
        tabs: tabsReducer,
      },
      middleware: (getDefault) =>
        getDefault({
          serializableCheck: {
            ignoredPaths: ['sessions.expandedProjects'],
          },
        }),
      preloadedState: {
        sessions: {
          projects: [],
          expandedProjects: new Set(),
          windows: {
            history: {
              projects: [],
              integrityError: {
                kind: 'identity_collision',
                collisionCount: 2,
                duplicateItemCount: 4,
              },
            },
          },
        },
        tabs: { tabs: [], activeTabId: null },
      } as any,
    })

    render(
      <Provider store={store}>
        <HistoryView />
      </Provider>,
    )

    const alert = screen.getByTestId('history-session-directory-integrity-error')
    expect(alert).toHaveAttribute('role', 'alert')
    expect(alert).toHaveTextContent('Running terminals remain available')

    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('history-session-directory-integrity-error')).toBeNull()
  })

  it('the integrity-error banner is dismissable with an X; a changed collision count re-shows it', () => {
    function storeWithIntegrityError(collisionCount: number) {
      return configureStore({
        reducer: {
          sessions: sessionsReducer,
          tabs: tabsReducer,
        },
        middleware: (getDefault) =>
          getDefault({
            serializableCheck: {
              ignoredPaths: ['sessions.expandedProjects'],
            },
          }),
        preloadedState: {
          sessions: {
            projects: [],
            expandedProjects: new Set(),
            windows: {
              history: {
                projects: [],
                integrityError: {
                  kind: 'identity_collision',
                  collisionCount,
                  duplicateItemCount: collisionCount * 2,
                },
              },
            },
          },
          tabs: { tabs: [], activeTabId: null },
        } as any,
      })
    }

    const store = storeWithIntegrityError(2)
    render(
      <Provider store={store}>
        <HistoryView />
      </Provider>,
    )
    const alert = screen.getByTestId('history-session-directory-integrity-error')
    expect(alert).toHaveAttribute('role', 'alert')

    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('history-session-directory-integrity-error')).toBeNull()

    // A NEW collision count (fresh data problem) re-arms the banner.
    act(() => {
      store.dispatch(commitSessionWindowVisibleRefresh({
        surface: 'history',
        projects: [],
        totalSessions: 0,
        hasMore: false,
        integrityError: { kind: 'identity_collision', collisionCount: 3, duplicateItemCount: 6 },
      }))
    })
    expect(screen.getByTestId('history-session-directory-integrity-error')).toHaveTextContent('3 conflicting saved session')
  })

  it('loads the History surface when Sidebar already populated top-level projects', async () => {
    vi.mocked(fetchSidebarSessionsSnapshot).mockResolvedValueOnce({
      projects: [],
      totalSessions: 0,
      oldestIncludedTimestamp: 0,
      oldestIncludedSessionId: '',
      hasMore: false,
      integrityError: {
        kind: 'identity_collision',
        collisionCount: 1,
        duplicateItemCount: 2,
      },
    })

    const { store } = createSidebarLoadedStore()

    render(
      <Provider store={store}>
        <HistoryView />
      </Provider>,
    )

    await waitFor(() => {
      expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1)
      const alert = screen.getByTestId('history-session-directory-integrity-error')
      expect(alert).toHaveAttribute('role', 'alert')
    })
    expect(screen.queryByRole('button', { name: 'Open session Already loaded session' })).toBeNull()

    const alert = screen.getByTestId('history-session-directory-integrity-error')
    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('history-session-directory-integrity-error')).toBeNull()
  })

  it('keeps Sidebar sessions visible while the History request is pending', async () => {
    let resolveHistoryRequest!: (value: any) => void
    const historyRequest = new Promise<any>((resolve) => {
      resolveHistoryRequest = resolve
    })
    vi.mocked(fetchSidebarSessionsSnapshot).mockReturnValueOnce(historyRequest)
    const { project: sidebarProject, store } = createSidebarLoadedStore()

    render(
      <Provider store={store}>
        <HistoryView />
      </Provider>,
    )

    await waitFor(() => expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'Open session Already loaded session' })).toBeInTheDocument()

    await act(async () => {
      resolveHistoryRequest({
        projects: [sidebarProject],
        totalSessions: 1,
        oldestIncludedTimestamp: Date.now(),
        oldestIncludedSessionId: 'codex:already-loaded-from-sidebar',
        hasMore: false,
      })
      await historyRequest
    })
    expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1)
  })

  it('keeps Sidebar sessions visible when the History request fails', async () => {
    let rejectHistoryRequest!: (reason?: unknown) => void
    const historyRequest = new Promise<any>((_resolve, reject) => {
      rejectHistoryRequest = reject
    })
    vi.mocked(fetchSidebarSessionsSnapshot).mockReturnValueOnce(historyRequest)
    const { store } = createSidebarLoadedStore()

    render(
      <Provider store={store}>
        <HistoryView />
      </Provider>,
    )

    await waitFor(() => expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1))
    await act(async () => {
      rejectHistoryRequest(new Error('History request failed'))
      await historyRequest.catch(() => {})
    })
    await waitFor(() => {
      expect(store.getState().sessions.windows.history.error).toBe('History request failed')
    })

    expect(screen.getByRole('button', { name: 'Open session Already loaded session' })).toBeInTheDocument()
    expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1)
  })

  it('refreshes Sidebar and History after invalidation when both windows are loaded', async () => {
    const { project: staleProject, store } = createSidebarLoadedStore()
    const freshProjects = [{
      projectPath: '/sidebar/refreshed',
      sessions: [{
        provider: 'codex',
        sessionId: 'refreshed-session',
        projectPath: '/sidebar/refreshed',
        lastActivityAt: 9_000,
        title: 'Refreshed session',
      }],
    }]
    vi.mocked(fetchSidebarSessionsSnapshot)
      .mockResolvedValueOnce({
        projects: [staleProject],
        totalSessions: 1,
        oldestIncludedTimestamp: staleProject.sessions[0].lastActivityAt,
        oldestIncludedSessionId: 'codex:already-loaded-from-sidebar',
        hasMore: false,
      })
      .mockResolvedValue({
        projects: freshProjects,
        totalSessions: 1,
        oldestIncludedTimestamp: 9_000,
        oldestIncludedSessionId: 'codex:refreshed-session',
        hasMore: false,
      })

    render(
      <Provider store={store}>
        <HistoryView />
      </Provider>,
    )

    await waitFor(() => {
      expect(store.getState().sessions.activeSurface).toBe('history')
      expect(store.getState().sessions.windows.history.lastLoadedAt).toEqual(expect.any(Number))
    })

    await act(async () => {
      await store.dispatch(queueActiveSessionWindowRefresh() as any)
    })

    expect(store.getState().sessions.windows.sidebar.projects).toMatchObject(freshProjects)
    expect(store.getState().sessions.windows.history.projects).toMatchObject(freshProjects)
  })

  it('retries the failed initial History load on the next session invalidation', async () => {
    const freshProjects = [{
      projectPath: '/history/recovered',
      sessions: [{
        provider: 'codex',
        sessionId: 'recovered-session',
        projectPath: '/history/recovered',
        lastActivityAt: 10_000,
        title: 'Recovered session',
      }],
    }]
    vi.mocked(fetchSidebarSessionsSnapshot)
      .mockRejectedValueOnce(new Error('History request failed'))
      .mockResolvedValue({
        projects: freshProjects,
        totalSessions: 1,
        oldestIncludedTimestamp: 10_000,
        oldestIncludedSessionId: 'codex:recovered-session',
        hasMore: false,
      })
    const { store } = createSidebarLoadedStore()

    render(
      <Provider store={store}>
        <HistoryView />
      </Provider>,
    )

    await waitFor(() => {
      expect(store.getState().sessions.windows.history.error).toBe('History request failed')
    })

    await act(async () => {
      await store.dispatch(queueActiveSessionWindowRefresh() as any)
    })

    expect(store.getState().sessions.windows.history.projects).toMatchObject(freshProjects)
    expect(store.getState().sessions.windows.history.lastLoadedAt).toEqual(expect.any(Number))
  })

  it('retries a failed initial History load when the view is mounted again', async () => {
    const freshProjects = [{
      projectPath: '/history/retried',
      sessions: [{
        provider: 'codex',
        sessionId: 'retried-session',
        projectPath: '/history/retried',
        lastActivityAt: 11_000,
        title: 'Retried session',
      }],
    }]
    vi.mocked(fetchSidebarSessionsSnapshot)
      .mockRejectedValueOnce(new Error('History request failed'))
      .mockResolvedValueOnce({
        projects: freshProjects,
        totalSessions: 1,
        oldestIncludedTimestamp: 11_000,
        oldestIncludedSessionId: 'codex:retried-session',
        hasMore: false,
      })
    const { store } = createSidebarLoadedStore()

    const firstRender = render(
      <Provider store={store}>
        <HistoryView />
      </Provider>,
    )

    await waitFor(() => {
      expect(store.getState().sessions.windows.history.error).toBe('History request failed')
    })

    firstRender.unmount()
    render(
      <Provider store={store}>
        <HistoryView />
      </Provider>,
    )

    await waitFor(() => {
      expect(store.getState().sessions.windows.history.projects).toMatchObject(freshProjects)
    })
    expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(2)
  })
})
