import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { enableMapSet } from 'immer'
import sessionsReducer, { setActiveSessionSurface } from '@/store/sessionsSlice'
import * as sessionsThunks from '@/store/sessionsThunks'

const {
  fetchSessionWindow,
  refreshActiveSessionWindow,
} = sessionsThunks
const queueActiveSessionWindowRefresh = ((sessionsThunks as any).queueActiveSessionWindowRefresh ?? refreshActiveSessionWindow) as typeof refreshActiveSessionWindow
const _resetSessionWindowThunkState = ((sessionsThunks as any)._resetSessionWindowThunkState ?? (() => {})) as () => void

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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

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

function createStoreWithSessions(preloadedSessions: Record<string, unknown>) {
  return configureStore({
    reducer: {
      sessions: sessionsReducer,
    },
    preloadedState: {
      sessions: {
        ...sessionsReducer(undefined, { type: '@@INIT' }),
        ...preloadedSessions,
      },
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
    _resetSessionWindowThunkState()
  })

  afterEach(() => {
    _resetSessionWindowThunkState()
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

  it('marks an initial visible load as blocking when no committed data exists', async () => {
    const deferred = createDeferred<any>()
    fetchSidebarSessionsSnapshot.mockReturnValueOnce(deferred.promise)

    const store = createStore()
    store.dispatch(setActiveSessionSurface('sidebar'))

    const request = store.dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)

    try {
      expect((store.getState().sessions.windows.sidebar as any).loadingKind).toBe('initial')
    } finally {
      deferred.resolve({
        projects: [],
        totalSessions: 0,
        oldestIncludedTimestamp: 0,
        oldestIncludedSessionId: '',
        hasMore: false,
      })

      await request
    }

    expect((store.getState().sessions.windows.sidebar as any).loadingKind).toBeUndefined()
  })

  it('classifies explicit query searches as visible search work and clears the kind when settled', async () => {
    const deferred = createDeferred<any>()
    searchSessions.mockReturnValueOnce(deferred.promise)

    const loadedProjects = [{
      projectPath: '/tmp/project-alpha',
      sessions: [{
        provider: 'claude',
        sessionId: 'session-alpha',
        projectPath: '/tmp/project-alpha',
        updatedAt: 1_000,
        title: 'Alpha',
      }],
    }]

    const store = createStoreWithSessions({
      activeSurface: 'sidebar',
      projects: loadedProjects,
      lastLoadedAt: 1_000,
      windows: {
        sidebar: {
          projects: loadedProjects,
          lastLoadedAt: 1_000,
          query: '',
          searchTier: 'title',
        },
      },
    })

    const request = store.dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
      query: 'needle',
      searchTier: 'fullText',
    }) as any)

    try {
      expect((store.getState().sessions.windows.sidebar as any).loadingKind).toBe('search')
    } finally {
      deferred.resolve({
        results: [],
        tier: 'fullText',
        query: 'needle',
        totalScanned: 0,
      })

      await request
    }

    expect((store.getState().sessions.windows.sidebar as any).loadingKind).toBeUndefined()
  })

  it('keeps tier changes and clearing a non-empty query in the visible search intent', async () => {
    const tierChange = createDeferred<any>()
    const clearSearch = createDeferred<any>()
    searchSessions.mockReturnValueOnce(tierChange.promise)
    fetchSidebarSessionsSnapshot.mockReturnValueOnce(clearSearch.promise)

    const existingSearchProjects = [{
      projectPath: '/tmp/search-project',
      sessions: [{
        provider: 'claude',
        sessionId: 'session-search',
        projectPath: '/tmp/search-project',
        updatedAt: 3_000,
        title: 'Search result',
      }],
    }]

    const store = createStoreWithSessions({
      activeSurface: 'sidebar',
      projects: existingSearchProjects,
      lastLoadedAt: 3_000,
      windows: {
        sidebar: {
          projects: existingSearchProjects,
          lastLoadedAt: 3_000,
          query: 'needle',
          searchTier: 'title',
        },
      },
    })

    const tierRequest = store.dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
      query: 'needle',
      searchTier: 'fullText',
    }) as any)

    try {
      expect((store.getState().sessions.windows.sidebar as any).loadingKind).toBe('search')
    } finally {
      tierChange.resolve({
        results: [],
        tier: 'fullText',
        query: 'needle',
        totalScanned: 0,
      })

      await tierRequest
    }

    const clearRequest = store.dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
      query: '',
      searchTier: 'title',
    }) as any)

    try {
      expect((store.getState().sessions.windows.sidebar as any).loadingKind).toBe('search')
    } finally {
      clearSearch.resolve({
        projects: [],
        totalSessions: 0,
        oldestIncludedTimestamp: 0,
        oldestIncludedSessionId: '',
        hasMore: false,
      })

      await clearRequest
    }

    expect((store.getState().sessions.windows.sidebar as any).loadingKind).toBeUndefined()
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

  it('refreshes the active active-query window silently while reusing its query context', async () => {
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

    const deferred = createDeferred<any>()
    searchSessions.mockReturnValueOnce(deferred.promise)

    const request = store.dispatch(refreshActiveSessionWindow() as any)

    try {
      expect((store.getState().sessions.windows.sidebar as any).loadingKind).toBe('background')
    } finally {
      deferred.resolve({
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

      await request
    }

    expect(searchSessions).toHaveBeenCalledWith({
      query: 'needle',
      tier: 'fullText',
      signal: expect.any(AbortSignal),
    })
  })

  it('marks websocket revalidation as background for both default lists and active queries', async () => {
    const defaultRefresh = createDeferred<any>()
    const searchRefresh = createDeferred<any>()
    fetchSidebarSessionsSnapshot.mockReturnValueOnce(defaultRefresh.promise)
    searchSessions.mockReturnValueOnce(searchRefresh.promise)

    const searchProjects = [{
      projectPath: '/tmp/search-project',
      sessions: [{
        provider: 'claude',
        sessionId: 'session-search',
        projectPath: '/tmp/search-project',
        updatedAt: 3_000,
        title: 'Search result',
      }],
    }]

    const defaultStore = createStoreWithSessions({
      activeSurface: 'sidebar',
      projects: searchProjects,
      lastLoadedAt: 3_000,
      windows: {
        sidebar: {
          projects: searchProjects,
          lastLoadedAt: 3_000,
          query: '',
          searchTier: 'title',
        },
      },
    })

    const defaultRequest = defaultStore.dispatch(queueActiveSessionWindowRefresh() as any)
    try {
      expect((defaultStore.getState().sessions.windows.sidebar as any).loadingKind).toBe('background')
    } finally {
      defaultRefresh.resolve({
        projects: searchProjects,
        totalSessions: 1,
        oldestIncludedTimestamp: 3_000,
        oldestIncludedSessionId: 'claude:session-search',
        hasMore: false,
      })

      await defaultRequest
    }

    const searchStore = createStoreWithSessions({
      activeSurface: 'sidebar',
      projects: searchProjects,
      lastLoadedAt: 3_000,
      windows: {
        sidebar: {
          projects: searchProjects,
          lastLoadedAt: 3_000,
          query: 'needle',
          searchTier: 'title',
        },
      },
    })

    const searchRequest = searchStore.dispatch(queueActiveSessionWindowRefresh() as any)
    try {
      expect((searchStore.getState().sessions.windows.sidebar as any).loadingKind).toBe('background')
    } finally {
      searchRefresh.resolve({
        results: [{
          provider: 'claude',
          sessionId: 'session-search',
          projectPath: '/tmp/search-project',
          title: 'Search result',
          updatedAt: 3_000,
          archived: false,
        }],
        tier: 'title',
        query: 'needle',
        totalScanned: 1,
      })

      await searchRequest
    }
  })

  it('treats websocket recovery without committed sidebar data as an initial blocking load', async () => {
    const deferred = createDeferred<any>()
    fetchSidebarSessionsSnapshot.mockReturnValueOnce(deferred.promise)

    const store = createStoreWithSessions({
      activeSurface: 'sidebar',
      projects: [],
      windows: {
        sidebar: {
          projects: [],
          query: '',
          searchTier: 'title',
        },
      },
    })

    const request = store.dispatch(queueActiveSessionWindowRefresh() as any)

    try {
      expect((store.getState().sessions.windows.sidebar as any).loadingKind).toBe('initial')
    } finally {
      deferred.resolve({
        projects: [],
        totalSessions: 0,
        oldestIncludedTimestamp: 0,
        oldestIncludedSessionId: '',
        hasMore: false,
      })

      await request
    }
  })

  it('coalesces repeated invalidations into one in-flight fetch plus one trailing refresh', async () => {
    const firstFetch = createDeferred<any>()
    fetchSidebarSessionsSnapshot
      .mockReturnValueOnce(firstFetch.promise)
      .mockResolvedValueOnce({
        projects: [],
        totalSessions: 0,
        oldestIncludedTimestamp: 0,
        oldestIncludedSessionId: '',
        hasMore: false,
      })

    const store = createStore()
    store.dispatch(setActiveSessionSurface('sidebar'))

    const first = store.dispatch(queueActiveSessionWindowRefresh() as any)
    const second = store.dispatch(queueActiveSessionWindowRefresh() as any)
    const third = store.dispatch(queueActiveSessionWindowRefresh() as any)

    expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1)
    expect(fetchSidebarSessionsSnapshot.mock.calls[0]?.[0]?.signal.aborted).toBe(false)

    firstFetch.resolve({
      projects: [],
      totalSessions: 0,
      oldestIncludedTimestamp: 0,
      oldestIncludedSessionId: '',
      hasMore: false,
    })

    await Promise.all([first, second, third])

    expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(2)
  })

  it('keeps explicit refreshes direct and abort-driven', async () => {
    const firstFetch = createDeferred<any>()
    fetchSidebarSessionsSnapshot
      .mockReturnValueOnce(firstFetch.promise)
      .mockResolvedValueOnce({
        projects: [],
        totalSessions: 0,
        oldestIncludedTimestamp: 0,
        oldestIncludedSessionId: '',
        hasMore: false,
      })

    const store = createStore()
    store.dispatch(setActiveSessionSurface('sidebar'))

    const first = store.dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)
    expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1)

    const firstSignal = fetchSidebarSessionsSnapshot.mock.calls[0]?.[0]?.signal as AbortSignal
    const second = store.dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)

    expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(2)
    expect(firstSignal.aborted).toBe(true)

    firstFetch.resolve({
      projects: [],
      totalSessions: 0,
      oldestIncludedTimestamp: 0,
      oldestIncludedSessionId: '',
      hasMore: false,
    })

    await Promise.all([first, second])
  })

  it('queues websocket invalidations behind an already-running direct fetch', async () => {
    const firstFetch = createDeferred<any>()
    fetchSidebarSessionsSnapshot
      .mockReturnValueOnce(firstFetch.promise)
      .mockResolvedValueOnce({
        projects: [],
        totalSessions: 0,
        oldestIncludedTimestamp: 0,
        oldestIncludedSessionId: '',
        hasMore: false,
      })

    const store = createStore()
    store.dispatch(setActiveSessionSurface('sidebar'))

    const first = store.dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)
    expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1)

    const firstSignal = fetchSidebarSessionsSnapshot.mock.calls[0]?.[0]?.signal as AbortSignal
    const queued = store.dispatch(queueActiveSessionWindowRefresh() as any)

    expect(firstSignal.aborted).toBe(false)
    expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1)

    firstFetch.resolve({
      projects: [],
      totalSessions: 0,
      oldestIncludedTimestamp: 0,
      oldestIncludedSessionId: '',
      hasMore: false,
    })

    await Promise.all([first, queued])

    expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(2)
  })

  it('does not let a queued invalidation abort a newer direct fetch', async () => {
    const firstFetch = createDeferred<any>()
    const secondFetch = createDeferred<any>()
    fetchSidebarSessionsSnapshot
      .mockReturnValueOnce(firstFetch.promise)
      .mockReturnValueOnce(secondFetch.promise)
      .mockResolvedValueOnce({
        projects: [],
        totalSessions: 0,
        oldestIncludedTimestamp: 0,
        oldestIncludedSessionId: '',
        hasMore: false,
      })

    const store = createStore()
    store.dispatch(setActiveSessionSurface('sidebar'))

    const first = store.dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)
    const queued = store.dispatch(queueActiveSessionWindowRefresh() as any)

    expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1)

    const firstSignal = fetchSidebarSessionsSnapshot.mock.calls[0]?.[0]?.signal as AbortSignal
    const second = store.dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)
    const secondSignal = fetchSidebarSessionsSnapshot.mock.calls[1]?.[0]?.signal as AbortSignal

    expect(firstSignal.aborted).toBe(true)
    expect(secondSignal.aborted).toBe(false)
    expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(2)

    firstFetch.resolve({
      projects: [],
      totalSessions: 0,
      oldestIncludedTimestamp: 0,
      oldestIncludedSessionId: '',
      hasMore: false,
    })

    await Promise.resolve()
    expect(secondSignal.aborted).toBe(false)
    expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(2)

    secondFetch.resolve({
      projects: [],
      totalSessions: 0,
      oldestIncludedTimestamp: 0,
      oldestIncludedSessionId: '',
      hasMore: false,
    })

    await Promise.all([first, second, queued])

    expect(secondSignal.aborted).toBe(false)
    expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(3)
  })

  it('reset hook cancels parked invalidation runners before they can dispatch follow-up fetches', async () => {
    const firstFetch = createDeferred<any>()
    fetchSidebarSessionsSnapshot.mockReturnValueOnce(firstFetch.promise)

    const store = createStore()
    store.dispatch(setActiveSessionSurface('sidebar'))

    const first = store.dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)
    const queued = store.dispatch(queueActiveSessionWindowRefresh() as any)

    expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1)

    _resetSessionWindowThunkState()

    firstFetch.resolve({
      projects: [],
      totalSessions: 0,
      oldestIncludedTimestamp: 0,
      oldestIncludedSessionId: '',
      hasMore: false,
    })

    await Promise.all([first, queued])

    expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1)
  })
})
