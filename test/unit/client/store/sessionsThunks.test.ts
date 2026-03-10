import { describe, it, expect, vi, beforeEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { enableMapSet } from 'immer'
import sessionsReducer, { setActiveSessionSurface } from '@/store/sessionsSlice'
import {
  fetchSessionWindow,
  refreshActiveSessionWindow,
} from '@/store/sessionsThunks'

const fetchSidebarSessionsSnapshot = vi.fn()
const searchSessions = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    fetchSidebarSessionsSnapshot: (...args: any[]) => fetchSidebarSessionsSnapshot(...args),
    searchSessions: (...args: any[]) => searchSessions(...args),
  }
})

enableMapSet()

function createStore() {
  return configureStore({
    reducer: {
      sessions: sessionsReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({
        serializableCheck: false,
      }),
  })
}

describe('sessionsThunks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads a visible session window into the targeted surface', async () => {
    fetchSidebarSessionsSnapshot.mockResolvedValue({
      projects: [
        {
          projectPath: '/tmp/project-alpha',
          sessions: [
            {
              provider: 'claude',
              sessionId: 'session-alpha',
              projectPath: '/tmp/project-alpha',
              updatedAt: 1_000,
              title: 'Alpha',
            },
          ],
        },
      ],
      totalSessions: 1,
      oldestIncludedTimestamp: 1_000,
      oldestIncludedSessionId: 'claude:session-alpha',
      hasMore: false,
    })

    const store = createStore()

    store.dispatch(setActiveSessionSurface('sidebar'))
    await store.dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)

    expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledWith({
      limit: 50,
      signal: expect.any(AbortSignal),
    })
    expect(store.getState().sessions.windows.sidebar.projects[0]?.projectPath).toBe('/tmp/project-alpha')
    expect(store.getState().sessions.projects[0]?.projectPath).toBe('/tmp/project-alpha')
  })

  it('appends a later page into the same surface window', async () => {
    fetchSidebarSessionsSnapshot
      .mockResolvedValueOnce({
        projects: [
          {
            projectPath: '/tmp/project-alpha',
            sessions: [
              {
                provider: 'claude',
                sessionId: 'session-alpha',
                projectPath: '/tmp/project-alpha',
                updatedAt: 2_000,
                title: 'Alpha',
              },
            ],
          },
        ],
        totalSessions: 2,
        oldestIncludedTimestamp: 2_000,
        oldestIncludedSessionId: 'claude:session-alpha',
        hasMore: true,
      })
      .mockResolvedValueOnce({
        projects: [
          {
            projectPath: '/tmp/project-beta',
            sessions: [
              {
                provider: 'claude',
                sessionId: 'session-beta',
                projectPath: '/tmp/project-beta',
                updatedAt: 1_000,
                title: 'Beta',
              },
            ],
          },
        ],
        totalSessions: 2,
        oldestIncludedTimestamp: 1_000,
        oldestIncludedSessionId: 'claude:session-beta',
        hasMore: false,
      })

    const store = createStore()
    store.dispatch(setActiveSessionSurface('sidebar'))

    await store.dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)

    await store.dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
      append: true,
    }) as any)

    expect(fetchSidebarSessionsSnapshot).toHaveBeenNthCalledWith(2, {
      limit: 50,
      before: 2_000,
      beforeId: 'claude:session-alpha',
      signal: expect.any(AbortSignal),
    })
    expect(store.getState().sessions.windows.sidebar.projects.map((project) => project.projectPath)).toEqual([
      '/tmp/project-alpha',
      '/tmp/project-beta',
    ])
  })

  it('refreshes the active window using its query context', async () => {
    searchSessions.mockResolvedValue({
      results: [
        {
          provider: 'claude',
          sessionId: 'session-search',
          projectPath: '/tmp/search-project',
          title: 'Search result',
          updatedAt: 3_000,
          archived: false,
        },
      ],
      tier: 'fullText',
      query: 'needle',
      totalScanned: 1,
    })

    const store = createStore()
    store.dispatch(setActiveSessionSurface('sidebar'))

    await store.dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
      query: 'needle',
      searchTier: 'fullText',
    }) as any)

    searchSessions.mockClear()

    await store.dispatch(refreshActiveSessionWindow() as any)

    expect(searchSessions).toHaveBeenCalledWith({
      query: 'needle',
      tier: 'fullText',
      signal: expect.any(AbortSignal),
    })
  })
})
