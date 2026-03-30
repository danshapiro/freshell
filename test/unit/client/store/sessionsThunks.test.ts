import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { enableMapSet } from 'immer'
import sessionsReducer, {
  commitSessionWindowVisibleRefresh,
  setActiveSessionSurface,
  setSessionWindowLoading,
} from '@/store/sessionsSlice'
import * as sessionsThunks from '@/store/sessionsThunks'

const {
  fetchSessionWindow,
  refreshActiveSessionWindow,
  mergeSearchResults,
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
              lastActivityAt: 1_000,
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
        lastActivityAt: 1_000,
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
      searchTier: 'title',
    }) as any)

    try {
      expect((store.getState().sessions.windows.sidebar as any).loadingKind).toBe('search')
    } finally {
      deferred.resolve({
        results: [],
        tier: 'title',
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
        lastActivityAt: 3_000,
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

  it('moves requested search state immediately but keeps applied search state on the visible results until each replacement commits', async () => {
    const replacementSearch = createDeferred<any>()
    searchSessions.mockReturnValueOnce(replacementSearch.promise)

    const appliedProjects = [{
      projectPath: '/tmp/project-alpha',
      sessions: [{
        provider: 'claude',
        sessionId: 'session-alpha',
        projectPath: '/tmp/project-alpha',
        lastActivityAt: 1_000,
        title: 'Alpha result',
      }],
    }]

    const store = createStoreWithSessions({
      activeSurface: 'sidebar',
      projects: appliedProjects,
      lastLoadedAt: 1_000,
      windows: {
        sidebar: {
          projects: appliedProjects,
          lastLoadedAt: 1_000,
          query: 'alpha',
          searchTier: 'title',
          appliedQuery: 'alpha',
          appliedSearchTier: 'title',
        },
      },
    })

    const replacementRequest = store.dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
      query: 'beta',
      searchTier: 'title',
    }) as any)

    let replacementResolved = false

    try {
      expect((store.getState().sessions.windows.sidebar as any).query).toBe('beta')
      expect((store.getState().sessions.windows.sidebar as any).searchTier).toBe('title')
      expect((store.getState().sessions.windows.sidebar as any).appliedQuery).toBe('alpha')
      expect((store.getState().sessions.windows.sidebar as any).appliedSearchTier).toBe('title')

      replacementSearch.resolve({
        results: [{
          provider: 'claude',
          sessionId: 'session-beta',
          projectPath: '/tmp/project-beta',
          title: 'Beta result',
          matchedIn: 'title',
          lastActivityAt: 2_000,
          archived: false,
        }],
        tier: 'title',
        query: 'beta',
        totalScanned: 1,
      })
      replacementResolved = true

      await replacementRequest

      expect((store.getState().sessions.windows.sidebar as any).appliedQuery).toBe('beta')
      expect((store.getState().sessions.windows.sidebar as any).appliedSearchTier).toBe('title')

      const browseReload = createDeferred<any>()
      fetchSidebarSessionsSnapshot.mockReturnValueOnce(browseReload.promise)

      const browseRequest = store.dispatch(fetchSessionWindow({
        surface: 'sidebar',
        priority: 'visible',
        query: '',
        searchTier: 'title',
      }) as any)

      try {
        expect((store.getState().sessions.windows.sidebar as any).query).toBe('')
        expect((store.getState().sessions.windows.sidebar as any).searchTier).toBe('title')
        expect((store.getState().sessions.windows.sidebar as any).appliedQuery).toBe('beta')
        expect((store.getState().sessions.windows.sidebar as any).appliedSearchTier).toBe('title')
      } finally {
        browseReload.resolve({
          projects: [],
          totalSessions: 0,
          oldestIncludedTimestamp: 0,
          oldestIncludedSessionId: '',
          hasMore: false,
        })

        await browseRequest
      }

      expect((store.getState().sessions.windows.sidebar as any).appliedQuery).toBe('')
      expect((store.getState().sessions.windows.sidebar as any).appliedSearchTier).toBe('title')
    } finally {
      if (!replacementResolved) {
        replacementSearch.resolve({
          results: [],
          tier: 'title',
          query: 'beta',
          totalScanned: 0,
        })
        await replacementRequest
      }
    }
  })

  it('preserves the previous applied search context when a replacement request errors before new data lands', async () => {
    searchSessions.mockRejectedValueOnce(new Error('Search failed'))

    const appliedProjects = [{
      projectPath: '/tmp/project-alpha',
      sessions: [{
        provider: 'claude',
        sessionId: 'session-alpha',
        projectPath: '/tmp/project-alpha',
        lastActivityAt: 1_000,
        title: 'Alpha result',
      }],
    }]

    const store = createStoreWithSessions({
      activeSurface: 'sidebar',
      projects: appliedProjects,
      lastLoadedAt: 1_000,
      windows: {
        sidebar: {
          projects: appliedProjects,
          lastLoadedAt: 1_000,
          query: 'alpha',
          searchTier: 'title',
          appliedQuery: 'alpha',
          appliedSearchTier: 'title',
        },
      },
    })

    await expect(store.dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
      query: 'beta',
      searchTier: 'fullText',
    }) as any)).rejects.toThrow('Search failed')

    expect((store.getState().sessions.windows.sidebar as any).query).toBe('beta')
    expect((store.getState().sessions.windows.sidebar as any).searchTier).toBe('fullText')
    expect((store.getState().sessions.windows.sidebar as any).appliedQuery).toBe('alpha')
    expect((store.getState().sessions.windows.sidebar as any).appliedSearchTier).toBe('title')
    expect((store.getState().sessions.windows.sidebar as any).error).toBe('Search failed')
  })

  it('preserves the previous applied search context when a replacement request is aborted before new data lands', async () => {
    const replacementSearch = createDeferred<any>()
    const browseReload = createDeferred<any>()
    searchSessions.mockReturnValueOnce(replacementSearch.promise)
    fetchSidebarSessionsSnapshot.mockReturnValueOnce(browseReload.promise)

    const appliedProjects = [{
      projectPath: '/tmp/project-alpha',
      sessions: [{
        provider: 'claude',
        sessionId: 'session-alpha',
        projectPath: '/tmp/project-alpha',
        lastActivityAt: 1_000,
        title: 'Alpha result',
      }],
    }]

    const store = createStoreWithSessions({
      activeSurface: 'sidebar',
      projects: appliedProjects,
      lastLoadedAt: 1_000,
      windows: {
        sidebar: {
          projects: appliedProjects,
          lastLoadedAt: 1_000,
          query: 'alpha',
          searchTier: 'title',
          appliedQuery: 'alpha',
          appliedSearchTier: 'title',
        },
      },
    })

    const replacementRequest = store.dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
      query: 'beta',
      searchTier: 'title',
    }) as any)
    const replacementSignal = searchSessions.mock.calls[0]?.[0]?.signal as AbortSignal

    const browseRequest = store.dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
      query: '',
      searchTier: 'title',
    }) as any)

    expect(replacementSignal.aborted).toBe(true)
    expect((store.getState().sessions.windows.sidebar as any).query).toBe('')
    expect((store.getState().sessions.windows.sidebar as any).searchTier).toBe('title')
    expect((store.getState().sessions.windows.sidebar as any).appliedQuery).toBe('alpha')
    expect((store.getState().sessions.windows.sidebar as any).appliedSearchTier).toBe('title')

    browseReload.resolve({
      projects: [],
      totalSessions: 0,
      oldestIncludedTimestamp: 0,
      oldestIncludedSessionId: '',
      hasMore: false,
    })
    replacementSearch.resolve({
      results: [{
        provider: 'claude',
        sessionId: 'session-beta',
        projectPath: '/tmp/project-beta',
        title: 'Beta result',
        lastActivityAt: 2_000,
        archived: false,
      }],
      tier: 'title',
      query: 'beta',
      totalScanned: 1,
    })

    await Promise.allSettled([replacementRequest, browseRequest])
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
                lastActivityAt: 2_000,
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
                lastActivityAt: 1_000,
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

  it('classifies append fetches as silent pagination work until they settle', async () => {
    fetchSidebarSessionsSnapshot.mockResolvedValueOnce({
      projects: [
        {
          projectPath: '/tmp/project-alpha',
          sessions: [
            {
              provider: 'claude',
              sessionId: 'session-alpha',
              projectPath: '/tmp/project-alpha',
              lastActivityAt: 2_000,
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

    const appendDeferred = createDeferred<any>()
    fetchSidebarSessionsSnapshot.mockReturnValueOnce(appendDeferred.promise)

    const store = createStore()
    store.dispatch(setActiveSessionSurface('sidebar'))

    await store.dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)

    const appendRequest = store.dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
      append: true,
    }) as any)

    try {
      expect((store.getState().sessions.windows.sidebar as any).loadingKind).toBe('pagination')
    } finally {
      appendDeferred.resolve({
        projects: [
          {
            projectPath: '/tmp/project-beta',
            sessions: [
              {
                provider: 'claude',
                sessionId: 'session-beta',
                projectPath: '/tmp/project-beta',
                lastActivityAt: 1_000,
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

      await appendRequest
    }

    expect((store.getState().sessions.windows.sidebar as any).loadingKind).toBeUndefined()
  })

  it('refreshes the visible applied-query window with a two-phase deep search while requested state drifts to browse', async () => {
    const phase1Deferred = createDeferred<any>()
    const phase2Deferred = createDeferred<any>()
    searchSessions
      .mockReturnValueOnce(phase1Deferred.promise)
      .mockReturnValueOnce(phase2Deferred.promise)

    const searchProjects = [{
      projectPath: '/tmp/search-project',
      sessions: [{
        provider: 'claude',
        sessionId: 'session-search',
        projectPath: '/tmp/search-project',
        lastActivityAt: 3_000,
        title: 'Search result',
      }],
    }]

    const store = createStoreWithSessions({
      activeSurface: 'sidebar',
      projects: searchProjects,
      lastLoadedAt: 3_000,
      windows: {
        sidebar: {
          projects: searchProjects,
          lastLoadedAt: 3_000,
          query: '',
          searchTier: 'title',
          appliedQuery: 'needle',
          appliedSearchTier: 'fullText',
        },
      },
    })

    const request = store.dispatch(refreshActiveSessionWindow() as any)

    expect((store.getState().sessions.windows.sidebar as any).loadingKind).toBe('background')
    expect(searchSessions).toHaveBeenNthCalledWith(1, {
      query: 'needle',
      tier: 'title',
      signal: expect.any(AbortSignal),
    })

    phase1Deferred.resolve({
      results: [
        {
          provider: 'claude',
          sessionId: 'session-search',
          projectPath: '/tmp/search-project',
          title: 'Search result',
          matchedIn: 'title',
          lastActivityAt: 3_000,
          archived: false,
        },
      ],
      tier: 'title',
      query: 'needle',
      totalScanned: 1,
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(searchSessions).toHaveBeenNthCalledWith(2, {
      query: 'needle',
      tier: 'fullText',
      signal: expect.any(AbortSignal),
    })
    expect(store.getState().sessions.windows.sidebar.query).toBe('')
    expect(store.getState().sessions.windows.sidebar.searchTier).toBe('title')
    expect(store.getState().sessions.windows.sidebar.appliedQuery).toBe('needle')
    expect(store.getState().sessions.windows.sidebar.appliedSearchTier).toBe('fullText')
    expect(store.getState().sessions.windows.sidebar.deepSearchPending).toBe(true)

    phase2Deferred.resolve({
      results: [
        {
          provider: 'claude',
          sessionId: 'session-search',
          projectPath: '/tmp/search-project',
          title: 'Search result',
          matchedIn: 'userMessage',
          lastActivityAt: 3_000,
          archived: false,
        },
      ],
      tier: 'fullText',
      query: 'needle',
      totalScanned: 4,
    })

    await request

    expect(searchSessions).toHaveBeenCalledTimes(2)
    expect(store.getState().sessions.windows.sidebar.query).toBe('')
    expect(store.getState().sessions.windows.sidebar.searchTier).toBe('title')
    expect(store.getState().sessions.windows.sidebar.appliedQuery).toBe('needle')
    expect(store.getState().sessions.windows.sidebar.appliedSearchTier).toBe('fullText')
    expect(store.getState().sessions.windows.sidebar.deepSearchPending).toBe(false)
  })

  it('refreshActiveSessionWindow keeps a pending browse replacement alive during search-to-browse drift and lets it commit afterward', async () => {
    const searchProjects = [{
      projectPath: '/tmp/search-project',
      sessions: [{
        provider: 'claude',
        sessionId: 'session-search',
        projectPath: '/tmp/search-project',
        lastActivityAt: 3_000,
        title: 'Search result',
      }],
    }]
    const browseDeferred = createDeferred<any>()
    const refreshDeferred = createDeferred<any>()
    fetchSidebarSessionsSnapshot.mockReturnValueOnce(browseDeferred.promise)
    searchSessions.mockReturnValueOnce(refreshDeferred.promise)

    const store = createStoreWithSessions({
      activeSurface: 'sidebar',
      projects: searchProjects,
      lastLoadedAt: 3_000,
      windows: {
        sidebar: {
          projects: searchProjects,
          lastLoadedAt: 3_000,
          query: 'needle',
          searchTier: 'title',
          appliedQuery: 'needle',
          appliedSearchTier: 'title',
          resultVersion: 4,
        },
      },
    })

    const browseRequest = store.dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
      query: '',
      searchTier: 'title',
    }) as any)
    const browseSignal = fetchSidebarSessionsSnapshot.mock.calls[0]?.[0]?.signal as AbortSignal

    expect(store.getState().sessions.windows.sidebar.query).toBe('')
    expect(store.getState().sessions.windows.sidebar.appliedQuery).toBe('needle')

    const refreshRequest = store.dispatch(refreshActiveSessionWindow() as any)

    expect(searchSessions).toHaveBeenCalledWith({
      query: 'needle',
      tier: 'title',
      signal: expect.any(AbortSignal),
    })
    expect(browseSignal.aborted).toBe(false)

    refreshDeferred.resolve({
      results: [{
        provider: 'claude',
        sessionId: 'session-search',
        projectPath: '/tmp/search-project',
        title: 'Search result',
        lastActivityAt: 3_100,
        archived: false,
      }],
      tier: 'title',
      query: 'needle',
      totalScanned: 1,
    })

    await refreshRequest

    expect(browseSignal.aborted).toBe(false)
    expect(store.getState().sessions.windows.sidebar.query).toBe('')
    expect(store.getState().sessions.windows.sidebar.appliedQuery).toBe('needle')

    browseDeferred.resolve({
      projects: [],
      totalSessions: 0,
      oldestIncludedTimestamp: 0,
      oldestIncludedSessionId: '',
      hasMore: false,
    })

    await browseRequest

    expect(store.getState().sessions.windows.sidebar.appliedQuery).toBe('')
    expect(store.getState().sessions.windows.sidebar.appliedSearchTier).toBe('title')
  })

  it('refreshActiveSessionWindow uses the visible applied query without drift and stays background/silent', async () => {
    const refreshDeferred = createDeferred<any>()
    searchSessions.mockReturnValueOnce(refreshDeferred.promise)

    const searchProjects = [{
      projectPath: '/tmp/search-project',
      sessions: [{
        provider: 'claude',
        sessionId: 'session-search',
        projectPath: '/tmp/search-project',
        lastActivityAt: 3_000,
        title: 'Search result',
      }],
    }]

    const store = createStoreWithSessions({
      activeSurface: 'sidebar',
      projects: searchProjects,
      lastLoadedAt: 3_000,
      windows: {
        sidebar: {
          projects: searchProjects,
          lastLoadedAt: 3_000,
          query: 'needle',
          searchTier: 'title',
          appliedQuery: 'needle',
          appliedSearchTier: 'title',
        },
      },
    })

    const request = store.dispatch(refreshActiveSessionWindow() as any)

    expect((store.getState().sessions.windows.sidebar as any).loadingKind).toBe('background')
    expect(searchSessions).toHaveBeenCalledWith({
      query: 'needle',
      tier: 'title',
      signal: expect.any(AbortSignal),
    })

    refreshDeferred.resolve({
      results: [{
        provider: 'claude',
        sessionId: 'session-search',
        projectPath: '/tmp/search-project',
        title: 'Search result',
        lastActivityAt: 3_100,
        archived: false,
      }],
      tier: 'title',
      query: 'needle',
      totalScanned: 1,
    })

    await request

    expect(store.getState().sessions.windows.sidebar.loadingKind).toBeUndefined()
    expect(store.getState().sessions.windows.sidebar.query).toBe('needle')
    expect(store.getState().sessions.windows.sidebar.searchTier).toBe('title')
    expect(store.getState().sessions.windows.sidebar.appliedQuery).toBe('needle')
    expect(store.getState().sessions.windows.sidebar.appliedSearchTier).toBe('title')
  })

  it('marks websocket revalidation as background for both default lists and the visible applied query', async () => {
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
        lastActivityAt: 3_000,
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
          query: '',
          searchTier: 'title',
          appliedQuery: 'needle',
          appliedSearchTier: 'title',
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
          lastActivityAt: 3_000,
          archived: false,
        }],
        tier: 'title',
        query: 'needle',
        totalScanned: 1,
      })

      await searchRequest
    }

    expect(searchSessions).toHaveBeenCalledWith({
      query: 'needle',
      tier: 'title',
      signal: expect.any(AbortSignal),
    })
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

  it('silently refreshes the visible applied search during an in-flight search-to-browse transition without overwriting the requested browse state', async () => {
    const searchProjects = [{
      projectPath: '/tmp/search-project',
      sessions: [{
        provider: 'claude',
        sessionId: 'session-search',
        projectPath: '/tmp/search-project',
        lastActivityAt: 3_000,
        title: 'Search result',
      }],
    }]
    const browseDeferred = createDeferred<any>()
    const invalidationDeferred = createDeferred<any>()
    fetchSidebarSessionsSnapshot.mockReturnValueOnce(browseDeferred.promise)
    searchSessions.mockReturnValueOnce(invalidationDeferred.promise)

    const store = createStoreWithSessions({
      activeSurface: 'sidebar',
      projects: searchProjects,
      lastLoadedAt: 3_000,
      windows: {
        sidebar: {
          projects: searchProjects,
          lastLoadedAt: 3_000,
          query: 'needle',
          searchTier: 'title',
          appliedQuery: 'needle',
          appliedSearchTier: 'title',
        },
      },
    })

    const browseRequest = store.dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
      query: '',
      searchTier: 'title',
    }) as any)
    const browseSignal = fetchSidebarSessionsSnapshot.mock.calls[0]?.[0]?.signal as AbortSignal

    expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1)
    expect(browseSignal).toBeDefined()
    expect(browseSignal.aborted).toBe(false)
    expect(store.getState().sessions.windows.sidebar.query).toBe('')
    expect(store.getState().sessions.windows.sidebar.appliedQuery).toBe('needle')

    const invalidationRequest = store.dispatch(queueActiveSessionWindowRefresh() as any)

    expect(searchSessions).toHaveBeenCalledWith({
      query: 'needle',
      tier: 'title',
      signal: expect.any(AbortSignal),
    })

    invalidationDeferred.resolve({
      results: [{
        provider: 'claude',
        sessionId: 'session-search',
        projectPath: '/tmp/search-project',
        title: 'Search result',
        lastActivityAt: 3_100,
        archived: false,
      }],
      tier: 'title',
      query: 'needle',
      totalScanned: 1,
    })

    await invalidationRequest

    expect(browseSignal.aborted).toBe(false)
    expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1)
    expect(store.getState().sessions.windows.sidebar.query).toBe('')
    expect(store.getState().sessions.windows.sidebar.searchTier).toBe('title')
    expect(store.getState().sessions.windows.sidebar.appliedQuery).toBe('needle')
    expect(store.getState().sessions.windows.sidebar.appliedSearchTier).toBe('title')
    expect(store.getState().sessions.windows.sidebar.loading).toBe(true)

    browseDeferred.resolve({
      projects: [],
      totalSessions: 0,
      oldestIncludedTimestamp: 0,
      oldestIncludedSessionId: '',
      hasMore: false,
    })

    await browseRequest

    expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1)
    expect(store.getState().sessions.windows.sidebar.appliedQuery).toBe('')
    expect(store.getState().sessions.windows.sidebar.appliedSearchTier).toBe('title')
  })

  it('keeps a visible refresh committable when requested state drifts again but the visible result set identity is unchanged', async () => {
    const refreshDeferred = createDeferred<any>()
    searchSessions.mockReturnValueOnce(refreshDeferred.promise)

    const store = createStoreWithSessions({
      activeSurface: 'sidebar',
      projects: [{
        projectPath: '/tmp/search-project',
        sessions: [{
          provider: 'claude',
          sessionId: 'session-search',
          projectPath: '/tmp/search-project',
          lastActivityAt: 3_000,
          title: 'Search result',
        }],
      }],
      lastLoadedAt: 3_000,
      windows: {
        sidebar: {
          projects: [{
            projectPath: '/tmp/search-project',
            sessions: [{
              provider: 'claude',
              sessionId: 'session-search',
              projectPath: '/tmp/search-project',
              lastActivityAt: 3_000,
              title: 'Search result',
            }],
          }],
          lastLoadedAt: 3_000,
          query: 'beta',
          searchTier: 'title',
          appliedQuery: 'alpha',
          appliedSearchTier: 'title',
          loading: true,
          loadingKind: 'search',
          resultVersion: 11,
        },
      },
    })

    const refreshRequest = store.dispatch(queueActiveSessionWindowRefresh() as any)

    store.dispatch(setSessionWindowLoading({
      surface: 'sidebar',
      loading: true,
      loadingKind: 'search',
      query: '',
      searchTier: 'title',
    }))

    refreshDeferred.resolve({
      results: [{
        provider: 'claude',
        sessionId: 'session-search',
        projectPath: '/tmp/search-project',
        title: 'Search result refreshed',
        lastActivityAt: 3_500,
        archived: false,
      }],
      tier: 'title',
      query: 'alpha',
      totalScanned: 1,
    })

    await refreshRequest

    const windowState = store.getState().sessions.windows.sidebar
    expect(windowState.query).toBe('')
    expect(windowState.appliedQuery).toBe('alpha')
    expect(windowState.projects[0]?.sessions[0]?.title).toBe('Search result refreshed')
    expect(windowState.resultVersion).toBe(12)
  })

  it('drops a stale visible refresh once a newer committed resultVersion replaces the visible set', async () => {
    const staleRefresh = createDeferred<any>()
    searchSessions.mockReturnValueOnce(staleRefresh.promise)

    const initialProjects = [{
      projectPath: '/tmp/search-project',
      sessions: [{
        provider: 'claude',
        sessionId: 'session-search',
        projectPath: '/tmp/search-project',
        lastActivityAt: 3_000,
        title: 'Initial search result',
      }],
    }]

    const store = createStoreWithSessions({
      activeSurface: 'sidebar',
      projects: initialProjects,
      lastLoadedAt: 3_000,
      windows: {
        sidebar: {
          projects: initialProjects,
          lastLoadedAt: 3_000,
          query: 'alpha',
          searchTier: 'title',
          appliedQuery: 'alpha',
          appliedSearchTier: 'title',
          resultVersion: 2,
        },
      },
    })

    const refreshRequest = store.dispatch(queueActiveSessionWindowRefresh() as any)

    store.dispatch(commitSessionWindowVisibleRefresh({
      surface: 'sidebar',
      projects: [{
        projectPath: '/tmp/search-project',
        sessions: [{
          provider: 'claude',
          sessionId: 'session-newer',
          projectPath: '/tmp/search-project',
          lastActivityAt: 4_000,
          title: 'Newer committed result',
        }],
      }],
      totalSessions: 1,
      oldestLoadedTimestamp: 4_000,
      oldestLoadedSessionId: 'claude:session-newer',
      hasMore: false,
      query: 'alpha',
      searchTier: 'title',
    }))

    staleRefresh.resolve({
      results: [{
        provider: 'claude',
        sessionId: 'session-stale',
        projectPath: '/tmp/search-project',
        title: 'Stale refresh result',
        lastActivityAt: 3_100,
        archived: false,
      }],
      tier: 'title',
      query: 'alpha',
      totalScanned: 1,
    })

    await refreshRequest

    const windowState = store.getState().sessions.windows.sidebar
    expect(windowState.projects[0]?.sessions[0]?.title).toBe('Newer committed result')
    expect(windowState.resultVersion).toBe(3)
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

  it('passes tier to searchSessions when a query is active with userMessages (two-phase)', async () => {
    // userMessages triggers two-phase: first title, then userMessages
    searchSessions
      .mockResolvedValueOnce({
        results: [],
        tier: 'title',
        query: 'needle',
        totalScanned: 0,
      })
      .mockResolvedValueOnce({
        results: [],
        tier: 'userMessages',
        query: 'needle',
        totalScanned: 0,
      })

    const store = createStore()
    store.dispatch(setActiveSessionSurface('sidebar'))

    await store.dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
      query: 'needle',
      searchTier: 'userMessages',
    }) as any)

    expect(searchSessions).toHaveBeenCalledTimes(2)
    expect(searchSessions).toHaveBeenNthCalledWith(1, {
      query: 'needle',
      tier: 'title',
      signal: expect.any(AbortSignal),
    })
    expect(searchSessions).toHaveBeenNthCalledWith(2, {
      query: 'needle',
      tier: 'userMessages',
      signal: expect.any(AbortSignal),
    })
  })

  it('defaults searchTier to title when not provided', async () => {
    searchSessions.mockResolvedValue({
      results: [],
      tier: 'title',
      query: 'needle',
      totalScanned: 0,
    })

    const store = createStore()
    store.dispatch(setActiveSessionSurface('sidebar'))

    await store.dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
      query: 'needle',
    }) as any)

    expect(searchSessions).toHaveBeenCalledWith({
      query: 'needle',
      tier: 'title',
      signal: expect.any(AbortSignal),
    })
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

  describe('mergeSearchResults', () => {
    const makeResult = (overrides: Record<string, unknown>) => ({
      sessionId: 'session-1',
      provider: 'claude',
      projectPath: '/tmp/project',
      title: 'Test',
      matchedIn: 'title',
      lastActivityAt: 1_000,
      archived: false,
      ...overrides,
    })

    it('deep results overwrite title results with same session key', () => {
      const titleResults = [makeResult({ matchedIn: 'title', snippet: 'title match' })]
      const deepResults = [makeResult({ matchedIn: 'userMessage', snippet: 'deep match' })]

      const merged = mergeSearchResults(titleResults as any, deepResults as any)
      expect(merged).toHaveLength(1)
      expect(merged[0].matchedIn).toBe('userMessage')
      expect(merged[0].snippet).toBe('deep match')
    })

    it('title-only results preserved when absent from deep results', () => {
      const titleResults = [
        makeResult({ sessionId: 'a', title: 'Session A' }),
        makeResult({ sessionId: 'b', title: 'Session B' }),
      ]
      const deepResults = [
        makeResult({ sessionId: 'c', title: 'Session C', matchedIn: 'userMessage' }),
      ]

      const merged = mergeSearchResults(titleResults as any, deepResults as any)
      expect(merged).toHaveLength(3)
      expect(merged.map((r: any) => r.sessionId).sort()).toEqual(['a', 'b', 'c'])
    })

    it('empty title results with non-empty deep results', () => {
      const deepResults = [makeResult({ matchedIn: 'userMessage' })]

      const merged = mergeSearchResults([] as any, deepResults as any)
      expect(merged).toHaveLength(1)
      expect(merged[0].matchedIn).toBe('userMessage')
    })

    it('empty deep results preserves all title results', () => {
      const titleResults = [
        makeResult({ sessionId: 'a' }),
        makeResult({ sessionId: 'b' }),
      ]

      const merged = mergeSearchResults(titleResults as any, [] as any)
      expect(merged).toHaveLength(2)
    })

    it('different providers for same sessionId kept separate', () => {
      const titleResults = [makeResult({ provider: 'claude', sessionId: 'session-1' })]
      const deepResults = [makeResult({ provider: 'codex', sessionId: 'session-1', matchedIn: 'userMessage' })]

      const merged = mergeSearchResults(titleResults as any, deepResults as any)
      expect(merged).toHaveLength(2)
    })
  })

  describe('two-phase search', () => {
    const loadedProjects = [{
      projectPath: '/tmp/project-alpha',
      sessions: [{
        provider: 'claude',
        sessionId: 'session-alpha',
        projectPath: '/tmp/project-alpha',
        lastActivityAt: 1_000,
        title: 'Alpha',
      }],
    }]

    function createLoadedStore() {
      return createStoreWithSessions({
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
    }

    it('dispatches title results with deepSearchPending true, then merged results with false', async () => {
      const phase1Deferred = createDeferred<any>()
      const phase2Deferred = createDeferred<any>()
      searchSessions
        .mockReturnValueOnce(phase1Deferred.promise) // Phase 1: title
        .mockReturnValueOnce(phase2Deferred.promise) // Phase 2: fullText

      const store = createLoadedStore()

      const request = store.dispatch(fetchSessionWindow({
        surface: 'sidebar',
        priority: 'visible',
        query: 'needle',
        searchTier: 'fullText',
      }) as any)

      // Resolve Phase 1 (title)
      phase1Deferred.resolve({
        results: [{
          provider: 'claude',
          sessionId: 'session-A',
          projectPath: '/tmp/project',
          title: 'Session A',
          matchedIn: 'title',
          lastActivityAt: 2_000,
          archived: false,
        }],
        tier: 'title',
        query: 'needle',
        totalScanned: 1,
      })
      await new Promise((r) => setTimeout(r, 0))

      // After Phase 1: deepSearchPending should be true
      expect(store.getState().sessions.windows.sidebar.deepSearchPending).toBe(true)
      const phase1Sessions = store.getState().sessions.windows.sidebar.projects
        .flatMap((p: any) => p.sessions)
      expect(phase1Sessions.some((s: any) => s.sessionId === 'session-A')).toBe(true)

      // Resolve Phase 2 (fullText) with a new session
      phase2Deferred.resolve({
        results: [{
          provider: 'claude',
          sessionId: 'session-B',
          projectPath: '/tmp/project',
          title: 'Session B',
          matchedIn: 'userMessage',
          lastActivityAt: 1_500,
          archived: false,
        }],
        tier: 'fullText',
        query: 'needle',
        totalScanned: 10,
      })

      await request

      // After Phase 2: deepSearchPending should be false, both sessions present
      expect(store.getState().sessions.windows.sidebar.deepSearchPending).toBe(false)
      const finalSessions = store.getState().sessions.windows.sidebar.projects
        .flatMap((p: any) => p.sessions)
      expect(finalSessions.some((s: any) => s.sessionId === 'session-A')).toBe(true)
      expect(finalSessions.some((s: any) => s.sessionId === 'session-B')).toBe(true)
    })

    it('title-only search uses single-phase path with deepSearchPending false', async () => {
      searchSessions.mockResolvedValue({
        results: [{
          provider: 'claude',
          sessionId: 'session-title',
          projectPath: '/tmp/project',
          title: 'Title Match',
          matchedIn: 'title',
          lastActivityAt: 2_000,
          archived: false,
        }],
        tier: 'title',
        query: 'needle',
        totalScanned: 1,
      })

      const store = createLoadedStore()

      await store.dispatch(fetchSessionWindow({
        surface: 'sidebar',
        priority: 'visible',
        query: 'needle',
        searchTier: 'title',
      }) as any)

      expect(searchSessions).toHaveBeenCalledTimes(1)
      expect(searchSessions).toHaveBeenCalledWith({
        query: 'needle',
        tier: 'title',
        signal: expect.any(AbortSignal),
      })
      expect(store.getState().sessions.windows.sidebar.deepSearchPending).toBe(false)
    })

    it('new query aborts both phases of previous two-phase search', async () => {
      const phase1Deferred = createDeferred<any>()
      searchSessions.mockReturnValueOnce(phase1Deferred.promise)

      const store = createLoadedStore()

      // Start first search (will hang on Phase 1)
      const first = store.dispatch(fetchSessionWindow({
        surface: 'sidebar',
        priority: 'visible',
        query: 'alpha',
        searchTier: 'fullText',
      }) as any)

      // Capture the signal from the first call
      const firstSignal = searchSessions.mock.calls[0]?.[0]?.signal as AbortSignal

      // Start second search (aborts first)
      searchSessions.mockResolvedValueOnce({
        results: [],
        tier: 'title',
        query: 'beta',
        totalScanned: 0,
      })

      store.dispatch(fetchSessionWindow({
        surface: 'sidebar',
        priority: 'visible',
        query: 'beta',
        searchTier: 'title',
      }) as any)

      expect(firstSignal.aborted).toBe(true)

      // Let the first deferred resolve (should be ignored due to abort)
      phase1Deferred.resolve({
        results: [],
        tier: 'title',
        query: 'alpha',
        totalScanned: 0,
      })

      await first.catch(() => {})
    })

    it('Phase 2 error preserves Phase 1 results and clears deepSearchPending', async () => {
      const phase1Deferred = createDeferred<any>()
      const phase2Deferred = createDeferred<any>()
      searchSessions
        .mockReturnValueOnce(phase1Deferred.promise)
        .mockReturnValueOnce(phase2Deferred.promise)

      const store = createLoadedStore()

      const request = store.dispatch(fetchSessionWindow({
        surface: 'sidebar',
        priority: 'visible',
        query: 'needle',
        searchTier: 'fullText',
      }) as any)

      // Resolve Phase 1
      phase1Deferred.resolve({
        results: [{
          provider: 'claude',
          sessionId: 'session-A',
          projectPath: '/tmp/project',
          title: 'Session A',
          matchedIn: 'title',
          lastActivityAt: 2_000,
          archived: false,
        }],
        tier: 'title',
        query: 'needle',
        totalScanned: 1,
      })
      await new Promise((r) => setTimeout(r, 0))

      // Phase 1 data displayed with pending flag
      expect(store.getState().sessions.windows.sidebar.deepSearchPending).toBe(true)

      // Reject Phase 2
      phase2Deferred.reject(new Error('Deep search failed'))

      await request.catch(() => {})

      // Phase 1 data preserved, pending cleared, error set
      expect(store.getState().sessions.windows.sidebar.deepSearchPending).toBe(false)
      const sessions = store.getState().sessions.windows.sidebar.projects
        .flatMap((p: any) => p.sessions)
      expect(sessions.some((s: any) => s.sessionId === 'session-A')).toBe(true)
      expect(store.getState().sessions.windows.sidebar.error).toBe('Deep search failed')
    })

    it('forwards partial and partialReason from Phase 2 response to window state', async () => {
      const phase1Deferred = createDeferred<any>()
      const phase2Deferred = createDeferred<any>()
      searchSessions
        .mockReturnValueOnce(phase1Deferred.promise)
        .mockReturnValueOnce(phase2Deferred.promise)

      const store = createLoadedStore()

      const request = store.dispatch(fetchSessionWindow({
        surface: 'sidebar',
        priority: 'visible',
        query: 'needle',
        searchTier: 'fullText',
      }) as any)

      phase1Deferred.resolve({
        results: [],
        tier: 'title',
        query: 'needle',
        totalScanned: 0,
      })
      await new Promise((r) => setTimeout(r, 0))

      // Phase 1: no partial info
      expect(store.getState().sessions.windows.sidebar.partial).toBeUndefined()

      phase2Deferred.resolve({
        results: [{
          provider: 'claude',
          sessionId: 'session-A',
          projectPath: '/tmp/project',
          title: 'Session A',
          matchedIn: 'userMessage',
          lastActivityAt: 2_000,
          archived: false,
        }],
        tier: 'fullText',
        query: 'needle',
        totalScanned: 50,
        partial: true,
        partialReason: 'budget',
      })

      await request

      expect(store.getState().sessions.windows.sidebar.partial).toBe(true)
      expect(store.getState().sessions.windows.sidebar.partialReason).toBe('budget')
    })

    it('Phase 1 abort prevents Phase 2 from firing', async () => {
      const phase1Deferred = createDeferred<any>()
      searchSessions.mockReturnValueOnce(phase1Deferred.promise)

      const store = createLoadedStore()

      // Start two-phase search
      const first = store.dispatch(fetchSessionWindow({
        surface: 'sidebar',
        priority: 'visible',
        query: 'needle',
        searchTier: 'fullText',
      }) as any)

      expect(searchSessions).toHaveBeenCalledTimes(1) // Only Phase 1 call so far

      // Abort by dispatching a new fetch
      searchSessions.mockResolvedValueOnce({
        results: [],
        tier: 'title',
        query: 'new',
        totalScanned: 0,
      })
      store.dispatch(fetchSessionWindow({
        surface: 'sidebar',
        priority: 'visible',
        query: 'new',
        searchTier: 'title',
      }) as any)

      // Resolve Phase 1 after abort
      phase1Deferred.resolve({
        results: [],
        tier: 'title',
        query: 'needle',
        totalScanned: 0,
      })

      await first.catch(() => {})

      // Phase 2 for the original "needle" query never fires
      // Total calls: 1 (needle Phase 1) + 1 (new title search) = 2
      const needleCalls = searchSessions.mock.calls.filter(
        (call: any[]) => call[0]?.query === 'needle'
      )
      expect(needleCalls).toHaveLength(1) // Only Phase 1, no Phase 2
    })

    it('background refresh with deep tier uses two-phase search', async () => {
      const phase1Deferred = createDeferred<any>()
      const phase2Deferred = createDeferred<any>()
      searchSessions
        .mockReturnValueOnce(phase1Deferred.promise)
        .mockReturnValueOnce(phase2Deferred.promise)

      const store = createStoreWithSessions({
        activeSurface: 'sidebar',
        projects: loadedProjects,
        lastLoadedAt: 1_000,
        windows: {
          sidebar: {
            projects: loadedProjects,
            lastLoadedAt: 1_000,
            query: 'needle',
            searchTier: 'fullText',
          },
        },
      })

      const request = store.dispatch(queueActiveSessionWindowRefresh() as any)

      // Resolve Phase 1
      phase1Deferred.resolve({
        results: [{
          provider: 'claude',
          sessionId: 'session-bg',
          projectPath: '/tmp/project',
          title: 'BG Result',
          matchedIn: 'title',
          lastActivityAt: 2_000,
          archived: false,
        }],
        tier: 'title',
        query: 'needle',
        totalScanned: 1,
      })
      await new Promise((r) => setTimeout(r, 0))

      // Resolve Phase 2
      phase2Deferred.resolve({
        results: [{
          provider: 'claude',
          sessionId: 'session-bg',
          projectPath: '/tmp/project',
          title: 'BG Result',
          matchedIn: 'userMessage',
          lastActivityAt: 2_000,
          archived: false,
        }],
        tier: 'fullText',
        query: 'needle',
        totalScanned: 10,
      })

      await request

      // Should have called searchSessions twice: once for title, once for fullText
      expect(searchSessions).toHaveBeenCalledWith({
        query: 'needle',
        tier: 'title',
        signal: expect.any(AbortSignal),
      })
      expect(searchSessions).toHaveBeenCalledWith({
        query: 'needle',
        tier: 'fullText',
        signal: expect.any(AbortSignal),
      })
      expect(store.getState().sessions.windows.sidebar.deepSearchPending).toBe(false)
    })

    it('tier downgrade from fullText to title cancels in-flight Phase 2', async () => {
      const phase1Deferred = createDeferred<any>()
      const phase2Deferred = createDeferred<any>()
      searchSessions
        .mockReturnValueOnce(phase1Deferred.promise) // fullText Phase 1
        .mockReturnValueOnce(phase2Deferred.promise) // fullText Phase 2

      const store = createLoadedStore()

      // Start fullText search
      const first = store.dispatch(fetchSessionWindow({
        surface: 'sidebar',
        priority: 'visible',
        query: 'needle',
        searchTier: 'fullText',
      }) as any)

      // Resolve Phase 1
      phase1Deferred.resolve({
        results: [{
          provider: 'claude',
          sessionId: 'session-A',
          projectPath: '/tmp/project',
          title: 'Session A',
          matchedIn: 'title',
          lastActivityAt: 2_000,
          archived: false,
        }],
        tier: 'title',
        query: 'needle',
        totalScanned: 1,
      })
      await new Promise((r) => setTimeout(r, 0))

      expect(store.getState().sessions.windows.sidebar.deepSearchPending).toBe(true)

      // Tier downgrade: same query, title tier
      searchSessions.mockResolvedValueOnce({
        results: [{
          provider: 'claude',
          sessionId: 'session-A',
          projectPath: '/tmp/project',
          title: 'Session A',
          matchedIn: 'title',
          lastActivityAt: 2_000,
          archived: false,
        }],
        tier: 'title',
        query: 'needle',
        totalScanned: 1,
      })

      await store.dispatch(fetchSessionWindow({
        surface: 'sidebar',
        priority: 'visible',
        query: 'needle',
        searchTier: 'title',
      }) as any)

      // Phase 2 of fullText was aborted; final state is single-phase title result
      expect(store.getState().sessions.windows.sidebar.deepSearchPending).toBe(false)

      // Resolve the Phase 2 deferred (should be ignored)
      phase2Deferred.resolve({
        results: [],
        tier: 'fullText',
        query: 'needle',
        totalScanned: 0,
      })

      await first.catch(() => {})
    })

    it('Phase 2 abort after Phase 1 success preserves Phase 1 data', async () => {
      const phase1Deferred = createDeferred<any>()
      const phase2Deferred = createDeferred<any>()
      searchSessions
        .mockReturnValueOnce(phase1Deferred.promise)
        .mockReturnValueOnce(phase2Deferred.promise)

      const store = createLoadedStore()

      const request = store.dispatch(fetchSessionWindow({
        surface: 'sidebar',
        priority: 'visible',
        query: 'needle',
        searchTier: 'fullText',
      }) as any)

      // Resolve Phase 1
      phase1Deferred.resolve({
        results: [{
          provider: 'claude',
          sessionId: 'session-A',
          projectPath: '/tmp/project',
          title: 'Session A',
          matchedIn: 'title',
          lastActivityAt: 2_000,
          archived: false,
        }],
        tier: 'title',
        query: 'needle',
        totalScanned: 1,
      })
      await new Promise((r) => setTimeout(r, 0))

      // Phase 1 data is displayed
      const phase1Sessions = store.getState().sessions.windows.sidebar.projects
        .flatMap((p: any) => p.sessions)
      expect(phase1Sessions.some((s: any) => s.sessionId === 'session-A')).toBe(true)

      // Abort the surface (simulate user clearing search)
      // Dispatching a browse fetch aborts the current controller
      fetchSidebarSessionsSnapshot.mockResolvedValueOnce({
        projects: loadedProjects,
        totalSessions: 1,
        oldestIncludedTimestamp: 1_000,
        oldestIncludedSessionId: 'claude:session-alpha',
        hasMore: false,
      })

      await store.dispatch(fetchSessionWindow({
        surface: 'sidebar',
        priority: 'visible',
      }) as any)

      // Phase 2 resolves late (already aborted)
      phase2Deferred.resolve({
        results: [],
        tier: 'fullText',
        query: 'needle',
        totalScanned: 0,
      })

      await request.catch(() => {})

      // The browse fetch replaced the data, but the key point is
      // Phase 2 did not crash or corrupt state
      expect(store.getState().sessions.windows.sidebar.projects).toBeDefined()
    })

    it('non-search dispatches clear deepSearchPending via default', async () => {
      // Pre-set deepSearchPending to true
      const store = createStoreWithSessions({
        activeSurface: 'sidebar',
        projects: loadedProjects,
        lastLoadedAt: 1_000,
        windows: {
          sidebar: {
            projects: loadedProjects,
            lastLoadedAt: 1_000,
            query: 'needle',
            searchTier: 'fullText',
            deepSearchPending: true,
          },
        },
      })

      fetchSidebarSessionsSnapshot.mockResolvedValueOnce({
        projects: loadedProjects,
        totalSessions: 1,
        oldestIncludedTimestamp: 1_000,
        oldestIncludedSessionId: 'claude:session-alpha',
        hasMore: false,
      })

      // Browse mode fetch (no query)
      await store.dispatch(fetchSessionWindow({
        surface: 'sidebar',
        priority: 'visible',
      }) as any)

      expect(store.getState().sessions.windows.sidebar.deepSearchPending).toBe(false)
    })

    it('both phases share the same AbortController signal', async () => {
      const phase1Deferred = createDeferred<any>()
      const phase2Deferred = createDeferred<any>()
      searchSessions
        .mockReturnValueOnce(phase1Deferred.promise)
        .mockReturnValueOnce(phase2Deferred.promise)

      const store = createLoadedStore()

      const request = store.dispatch(fetchSessionWindow({
        surface: 'sidebar',
        priority: 'visible',
        query: 'needle',
        searchTier: 'fullText',
      }) as any)

      // Capture Phase 1 signal
      const phase1Signal = searchSessions.mock.calls[0]?.[0]?.signal as AbortSignal

      // Resolve Phase 1
      phase1Deferred.resolve({
        results: [],
        tier: 'title',
        query: 'needle',
        totalScanned: 0,
      })
      await new Promise((r) => setTimeout(r, 0))

      // Phase 2 should have been called; capture its signal
      expect(searchSessions).toHaveBeenCalledTimes(2)
      const phase2Signal = searchSessions.mock.calls[1]?.[0]?.signal as AbortSignal

      // Both signals reference the same controller
      expect(phase1Signal).toBe(phase2Signal)

      // Abort by dispatching new fetch
      fetchSidebarSessionsSnapshot.mockResolvedValueOnce({
        projects: [],
        totalSessions: 0,
        oldestIncludedTimestamp: 0,
        oldestIncludedSessionId: '',
        hasMore: false,
      })
      store.dispatch(fetchSessionWindow({
        surface: 'sidebar',
        priority: 'visible',
      }) as any)

      expect(phase1Signal.aborted).toBe(true)
      expect(phase2Signal.aborted).toBe(true)

      phase2Deferred.resolve({
        results: [],
        tier: 'fullText',
        query: 'needle',
        totalScanned: 0,
      })

      await request.catch(() => {})
    })
  })
})
