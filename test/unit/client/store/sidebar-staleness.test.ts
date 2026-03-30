// Tests for sidebar session staleness bug: WebSocket patches must reach sidebar
// window state even when sidebar is not the active surface.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { enableMapSet } from 'immer'
import sessionsReducer, {
  applySessionsPatch,
  commitSessionWindowReplacement,
  commitSessionWindowVisibleRefresh,
  markWsSnapshotReceived,
  setActiveSessionSurface,
  setSessionWindowLoading,
} from '@/store/sessionsSlice'
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

function makeProject(path: string, sessionId: string, lastActivityAt: number) {
  return {
    projectPath: path,
    sessions: [{
      provider: 'claude',
      sessionId,
      projectPath: path,
      lastActivityAt,
      title: `Session in ${path}`,
    }],
  }
}

function createStore() {
  return configureStore({
    reducer: { sessions: sessionsReducer },
    middleware: (m) => m({ serializableCheck: false }),
  })
}

function createStoreWithSessions(preloaded: Record<string, unknown>) {
  return configureStore({
    reducer: { sessions: sessionsReducer },
    preloadedState: {
      sessions: {
        ...sessionsReducer(undefined, { type: '@@INIT' }),
        ...preloaded,
      },
    },
    middleware: (m) => m({ serializableCheck: false }),
  })
}

describe('sidebar staleness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetSessionWindowThunkState()
  })
  afterEach(() => {
    _resetSessionWindowThunkState()
  })

  describe('applySessionsPatch syncs to all windows', () => {
    it('updates sidebar window when history is the active surface', () => {
      const sidebarProjects = [makeProject('/proj-a', 'old-session', 1_000)]

      const store = createStoreWithSessions({
        activeSurface: 'history',
        wsSnapshotReceived: true,
        projects: sidebarProjects,
        windows: {
          sidebar: {
            projects: sidebarProjects,
            lastLoadedAt: 1_000,
          },
          history: {
            projects: sidebarProjects,
            lastLoadedAt: 1_000,
          },
        },
      })

      const freshProject = makeProject('/proj-b', 'new-session', 5_000)
      store.dispatch(applySessionsPatch({
        upsertProjects: [freshProject],
        removeProjectPaths: [],
      }))

      // Top-level must have the new project
      const topLevel = store.getState().sessions.projects
      expect(topLevel.some(p => p.projectPath === '/proj-b')).toBe(true)

      // Sidebar window must ALSO have the new project
      const sidebarWindow = store.getState().sessions.windows.sidebar
      expect(sidebarWindow.projects.some((p: any) => p.projectPath === '/proj-b')).toBe(true)
    })

    it('updates sidebar window when no active surface is set', () => {
      const store = createStoreWithSessions({
        wsSnapshotReceived: true,
        projects: [makeProject('/proj-a', 's1', 1_000)],
        windows: {
          sidebar: {
            projects: [makeProject('/proj-a', 's1', 1_000)],
            lastLoadedAt: 1_000,
          },
        },
      })

      store.dispatch(applySessionsPatch({
        upsertProjects: [makeProject('/proj-c', 's3', 9_000)],
        removeProjectPaths: [],
      }))

      const sidebarWindow = store.getState().sessions.windows.sidebar
      expect(sidebarWindow.projects.some((p: any) => p.projectPath === '/proj-c')).toBe(true)
    })
  })

  describe('refresh path updates sidebar even when not active', () => {
    it('queueActiveSessionWindowRefresh updates sidebar data when sidebar is active', async () => {
      const freshProjects = [makeProject('/proj-fresh', 'fresh-1', 9_000)]
      fetchSidebarSessionsSnapshot.mockResolvedValue({
        projects: freshProjects,
        totalSessions: 1,
        oldestIncludedTimestamp: 9_000,
        oldestIncludedSessionId: 'claude:fresh-1',
        hasMore: false,
      })

      const staleProjects = [makeProject('/proj-stale', 'stale-1', 1_000)]
      const store = createStoreWithSessions({
        activeSurface: 'sidebar',
        wsSnapshotReceived: true,
        projects: staleProjects,
        lastLoadedAt: 1_000,
        windows: {
          sidebar: {
            projects: staleProjects,
            lastLoadedAt: 1_000,
            resultVersion: 1,
          },
        },
      })

      await store.dispatch(queueActiveSessionWindowRefresh() as any)

      const sidebar = store.getState().sessions.windows.sidebar
      expect(sidebar.projects.some((p: any) => p.projectPath === '/proj-fresh')).toBe(true)
      expect(sidebar.projects.some((p: any) => p.projectPath === '/proj-stale')).toBe(false)
    })
  })

  describe('error recovery in silent refresh', () => {
    it('surfaces error state when silent refresh fails', async () => {
      fetchSidebarSessionsSnapshot.mockRejectedValueOnce(new Error('Network error'))

      const existingProjects = [makeProject('/proj-a', 's1', 1_000)]
      const store = createStoreWithSessions({
        activeSurface: 'sidebar',
        wsSnapshotReceived: true,
        projects: existingProjects,
        lastLoadedAt: 1_000,
        windows: {
          sidebar: {
            projects: existingProjects,
            lastLoadedAt: 1_000,
            resultVersion: 1,
          },
        },
      })

      await store.dispatch(queueActiveSessionWindowRefresh() as any)

      const sidebar = store.getState().sessions.windows.sidebar
      // After a failed refresh, loading should be false
      expect(sidebar.loading).toBeFalsy()
      // The error should be surfaced, not swallowed
      expect(sidebar.error).toBeDefined()
    })
  })

  describe('activity sort does not let stale ratchetedActivity trump recent server timestamps', () => {
    it('sorts by most recent of ratchetedActivity or server timestamp', async () => {
      const { sortSessionItems } = await import('@/store/selectors/sidebarSelectors')

      const staleWithActivity = {
        id: 'stale',
        sessionId: 'stale',
        provider: 'claude',
        sessionType: 'claude',
        title: 'Stale session with old activity',
        hasTitle: true,
        timestamp: 1_000,  // old server timestamp
        hasTab: false,
        isRunning: false,
        ratchetedActivity: 2_000,  // slightly newer but still old
      }

      const freshNoActivity = {
        id: 'fresh',
        sessionId: 'fresh',
        provider: 'claude',
        sessionType: 'claude',
        title: 'Fresh session without activity tracking',
        hasTitle: true,
        timestamp: 9_000,  // recent server timestamp
        hasTab: false,
        isRunning: false,
        // no ratchetedActivity
      }

      const sorted = sortSessionItems(
        [staleWithActivity, freshNoActivity],
        'activity',
      )

      // Fresh session (timestamp 9000) should sort before stale session (activity 2000)
      expect(sorted[0].id).toBe('fresh')
      expect(sorted[1].id).toBe('stale')
    })
  })
})
