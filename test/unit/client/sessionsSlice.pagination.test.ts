import { describe, it, expect } from 'vitest'
import sessionsReducer, {
  clearPaginationMeta,
  setPaginationMeta,
  appendSessionsPage,
  setLoadingMore,
  setProjects,
  clearProjects,
  markWsSnapshotReceived,
  type SessionsState,
} from '../../../src/store/sessionsSlice'
import type { ProjectGroup } from '../../../src/store/types'

function makeSession(provider: string, sessionId: string, updatedAt: number, projectPath: string) {
  return { provider, sessionId, projectPath, updatedAt, title: `Session ${sessionId}` }
}

function makeProject(path: string, sessions: any[]): ProjectGroup {
  return { projectPath: path, sessions }
}

function stateWith(projects: ProjectGroup[]): SessionsState {
  let state = sessionsReducer(undefined, { type: 'init' })
  state = sessionsReducer(state, setProjects(projects))
  state = sessionsReducer(state, markWsSnapshotReceived())
  return state
}

describe('sessionsSlice pagination', () => {
  describe('setPaginationMeta', () => {
    it('stores pagination metadata', () => {
      const state = stateWith([])
      const next = sessionsReducer(state, setPaginationMeta({
        totalSessions: 500,
        oldestLoadedTimestamp: 1000,
        oldestLoadedSessionId: 'claude:abc',
        hasMore: true,
      }))
      expect(next.totalSessions).toBe(500)
      expect(next.oldestLoadedTimestamp).toBe(1000)
      expect(next.oldestLoadedSessionId).toBe('claude:abc')
      expect(next.hasMore).toBe(true)
    })

    it('updates existing metadata', () => {
      let state = stateWith([])
      state = sessionsReducer(state, setPaginationMeta({
        totalSessions: 500,
        oldestLoadedTimestamp: 1000,
        oldestLoadedSessionId: 'claude:abc',
        hasMore: true,
      }))
      state = sessionsReducer(state, setPaginationMeta({
        totalSessions: 500,
        oldestLoadedTimestamp: 500,
        oldestLoadedSessionId: 'claude:xyz',
        hasMore: false,
      }))
      expect(state.oldestLoadedTimestamp).toBe(500)
      expect(state.hasMore).toBe(false)
    })
  })

  describe('clearPaginationMeta', () => {
    it('resets pagination state without affecting projects', () => {
      let state = stateWith([makeProject('/a', [makeSession('claude', 's1', 200, '/a')])])
      state = sessionsReducer(state, setPaginationMeta({
        totalSessions: 500,
        oldestLoadedTimestamp: 1000,
        oldestLoadedSessionId: 'claude:abc',
        hasMore: true,
      }))
      state = sessionsReducer(state, setLoadingMore(true))

      state = sessionsReducer(state, clearPaginationMeta())
      expect(state.projects).toHaveLength(1) // projects preserved
      expect(state.totalSessions).toBeUndefined()
      expect(state.hasMore).toBeUndefined()
      expect(state.loadingMore).toBeUndefined()
    })
  })

  describe('appendSessionsPage', () => {
    it('merges older sessions into existing projects', () => {
      const existing = [
        makeProject('/a', [makeSession('claude', 's1', 200, '/a')]),
      ]
      let state = stateWith(existing)

      const olderPage = [
        makeProject('/a', [makeSession('claude', 's2', 100, '/a')]),
      ]
      state = sessionsReducer(state, appendSessionsPage(olderPage))

      expect(state.projects).toHaveLength(1)
      expect(state.projects[0].sessions).toHaveLength(2)
    })

    it('adds new projects from older pages', () => {
      const existing = [
        makeProject('/a', [makeSession('claude', 's1', 200, '/a')]),
      ]
      let state = stateWith(existing)

      const olderPage = [
        makeProject('/b', [makeSession('claude', 's2', 100, '/b')]),
      ]
      state = sessionsReducer(state, appendSessionsPage(olderPage))

      expect(state.projects).toHaveLength(2)
    })

    it('deduplicates by provider:sessionId', () => {
      const existing = [
        makeProject('/a', [makeSession('claude', 's1', 200, '/a')]),
      ]
      let state = stateWith(existing)

      // Append page that includes an already-known session
      const page = [
        makeProject('/a', [
          makeSession('claude', 's1', 200, '/a'),
          makeSession('claude', 's2', 100, '/a'),
        ]),
      ]
      state = sessionsReducer(state, appendSessionsPage(page))

      expect(state.projects).toHaveLength(1)
      // Should have 2, not 3 (s1 deduped)
      expect(state.projects[0].sessions).toHaveLength(2)
    })

    it('preserves unique coverage when a personalized first page overlaps with the natural next page', () => {
      let state = stateWith([
        makeProject('/a', [
          makeSession('codex', 'newest', 300, '/a'),
          makeSession('codex', 'cursor-boundary', 200, '/a'),
          makeSession('codex', 'older-open', 10, '/a'),
        ]),
      ])
      state = sessionsReducer(state, setPaginationMeta({
        totalSessions: 4,
        oldestLoadedTimestamp: 200,
        oldestLoadedSessionId: 'codex:cursor-boundary',
        hasMore: true,
      }))

      state = sessionsReducer(state, appendSessionsPage([
        makeProject('/a', [
          makeSession('codex', 'older-natural', 100, '/a'),
          makeSession('codex', 'older-open', 10, '/a'),
        ]),
      ]))

      expect(state.projects).toHaveLength(1)
      expect(state.projects[0].sessions.map((session) => session.sessionId)).toEqual([
        'newest',
        'cursor-boundary',
        'older-open',
        'older-natural',
      ])
      expect(state.projects[0].sessions.filter((session) => session.sessionId === 'older-open')).toHaveLength(1)
      expect(state.oldestLoadedTimestamp).toBe(200)
      expect(state.oldestLoadedSessionId).toBe('codex:cursor-boundary')
      expect(state.hasMore).toBe(true)
    })

    it('treats a missing provider as claude when deduplicating older pages', () => {
      const existing = [
        makeProject('/a', [{ sessionId: 's1', projectPath: '/a', updatedAt: 200, title: 'Session s1' } as any]),
      ]
      let state = stateWith(existing)

      const page = [
        makeProject('/a', [
          makeSession('claude', 's1', 200, '/a'),
          makeSession('claude', 's2', 100, '/a'),
        ]),
      ]
      state = sessionsReducer(state, appendSessionsPage(page))

      expect(state.projects[0].sessions.map((session) => session.sessionId)).toEqual(['s1', 's2'])
    })

    it('clears loadingMore flag', () => {
      let state = stateWith([])
      state = sessionsReducer(state, setLoadingMore(true))
      expect(state.loadingMore).toBe(true)

      state = sessionsReducer(state, appendSessionsPage([]))
      expect(state.loadingMore).toBe(false)
    })
  })

  describe('clearProjects', () => {
    it('resets pagination state', () => {
      let state = stateWith([makeProject('/a', [makeSession('claude', 's1', 200, '/a')])])
      state = sessionsReducer(state, setPaginationMeta({
        totalSessions: 500,
        oldestLoadedTimestamp: 1000,
        oldestLoadedSessionId: 'claude:abc',
        hasMore: true,
      }))
      state = sessionsReducer(state, setLoadingMore(true))

      state = sessionsReducer(state, clearProjects())
      expect(state.projects).toHaveLength(0)
      expect(state.totalSessions).toBeUndefined()
      expect(state.oldestLoadedTimestamp).toBeUndefined()
      expect(state.oldestLoadedSessionId).toBeUndefined()
      expect(state.hasMore).toBeUndefined()
      expect(state.loadingMore).toBeUndefined()
    })
  })

  describe('setLoadingMore', () => {
    it('sets the loading flag', () => {
      const state = stateWith([])
      const next = sessionsReducer(state, setLoadingMore(true))
      expect(next.loadingMore).toBe(true)
    })

    it('clears the loading flag', () => {
      let state = stateWith([])
      state = sessionsReducer(state, setLoadingMore(true))
      state = sessionsReducer(state, setLoadingMore(false))
      expect(state.loadingMore).toBe(false)
    })
  })
})
