import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, act, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'

import HistoryView from '@/components/HistoryView'
import sessionsReducer, { commitSessionWindowVisibleRefresh } from '@/store/sessionsSlice'
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

describe('HistoryView a11y', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.mocked(fetchSidebarSessionsSnapshot).mockResolvedValue({
      projects: [],
      totalSessions: 0,
      oldestIncludedTimestamp: 0,
      oldestIncludedSessionId: '',
      hasMore: false,
    })
  })

  afterEach(() => {
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
          projects: [{
            projectPath: '/sidebar/already-loaded',
            sessions: [{
              provider: 'codex',
              sessionId: 'already-loaded-from-sidebar',
              projectPath: '/sidebar/already-loaded',
              lastActivityAt: Date.now(),
              title: 'Already loaded session',
            }],
          }],
          expandedProjects: new Set(['/sidebar/already-loaded']),
        },
        tabs: { tabs: [], activeTabId: null },
      } as any,
    })

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

    const alert = screen.getByTestId('history-session-directory-integrity-error')
    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('history-session-directory-integrity-error')).toBeNull()
  })
})
