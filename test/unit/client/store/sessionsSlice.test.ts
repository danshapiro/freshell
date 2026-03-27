import { describe, it, expect, beforeEach } from 'vitest'
import { enableMapSet } from 'immer'
import sessionsReducer, {
  markWsSnapshotReceived,
  setProjects,
  clearProjects,
  mergeProjects,
  applySessionsPatch,
  toggleProjectExpanded,
  setProjectExpanded,
  collapseAll,
  expandAll,
  SessionsState,
  setActiveSessionSurface,
  setSessionWindowData,
  setSessionWindowLoading,
} from '@/store/sessionsSlice'
import type { ProjectGroup } from '@/store/types'

// Enable Immer's MapSet plugin for Set/Map support in Redux state
enableMapSet()

describe('sessionsSlice', () => {
  const mockProjects: ProjectGroup[] = [
    {
      projectPath: '/project/one',
      sessions: [
        {
          sessionId: 'session-1',
          projectPath: '/project/one',
          lastActivityAt: 1700000000000,
          messageCount: 5,
          title: 'First Session',
        },
        {
          sessionId: 'session-2',
          projectPath: '/project/one',
          lastActivityAt: 1700000001000,
          messageCount: 3,
          title: 'Second Session',
        },
      ],
      color: '#ff0000',
    },
    {
      projectPath: '/project/two',
      sessions: [
        {
          sessionId: 'session-3',
          projectPath: '/project/two',
          lastActivityAt: 1700000002000,
          title: 'Third Session',
        },
      ],
    },
    {
      projectPath: '/project/three',
      sessions: [],
    },
  ]

  let initialState: SessionsState

  beforeEach(() => {
    initialState = {
      projects: [],
      expandedProjects: new Set<string>(),
      wsSnapshotReceived: false,
    }
  })

  describe('initial state', () => {
    it('has empty projects array', () => {
      const state = sessionsReducer(undefined, { type: 'unknown' })
      expect(state.projects).toEqual([])
    })

    it('has empty expandedProjects set', () => {
      const state = sessionsReducer(undefined, { type: 'unknown' })
      expect(state.expandedProjects).toBeInstanceOf(Set)
      expect(state.expandedProjects.size).toBe(0)
    })

    it('defaults to wsSnapshotReceived = false', () => {
      const state = sessionsReducer(undefined, { type: 'unknown' })
      expect(state.wsSnapshotReceived).toBe(false)
    })

    it('has no lastLoadedAt initially', () => {
      const state = sessionsReducer(undefined, { type: 'unknown' })
      expect(state.lastLoadedAt).toBeUndefined()
    })
  })

  describe('setProjects', () => {
    it('replaces the projects list', () => {
      const state = sessionsReducer(initialState, setProjects(mockProjects))
      expect(state.projects).toEqual(mockProjects)
      expect(state.projects.length).toBe(3)
    })

    it('sets lastLoadedAt timestamp', () => {
      const beforeTime = Date.now()
      const state = sessionsReducer(initialState, setProjects(mockProjects))
      const afterTime = Date.now()
      expect(state.lastLoadedAt).toBeGreaterThanOrEqual(beforeTime)
      expect(state.lastLoadedAt).toBeLessThanOrEqual(afterTime)
    })

    it('replaces existing projects with new list', () => {
      const stateWithProjects = {
        ...initialState,
        projects: mockProjects,
      }
      const newProjects: ProjectGroup[] = [
        {
          projectPath: '/new/project',
          sessions: [],
        },
      ]
      const state = sessionsReducer(stateWithProjects, setProjects(newProjects))
      expect(state.projects).toEqual(newProjects)
      expect(state.projects.length).toBe(1)
    })

    it('can set empty projects list', () => {
      const stateWithProjects = {
        ...initialState,
        projects: mockProjects,
      }
      const state = sessionsReducer(stateWithProjects, setProjects([]))
      expect(state.projects).toEqual([])
    })

    it('preserves expandedProjects when setting projects', () => {
      const stateWithExpanded = {
        ...initialState,
        expandedProjects: new Set(['/project/one']),
      }
      const state = sessionsReducer(stateWithExpanded, setProjects(mockProjects))
      expect(state.expandedProjects.has('/project/one')).toBe(true)
    })

    it('hydrates the active window when a surface is already active', () => {
      const stateWithActiveWindow: SessionsState = {
        ...initialState,
        activeSurface: 'sidebar',
        windows: {
          sidebar: {
            projects: [],
          },
        },
      }

      const state = sessionsReducer(stateWithActiveWindow, setProjects(mockProjects))
      expect(state.windows.sidebar.projects).toEqual(mockProjects)
    })
  })

  describe('window surfaces', () => {
    it('seeds the first activated surface from existing top-level projects', () => {
      const stateWithProjects: SessionsState = {
        ...initialState,
        projects: mockProjects,
        lastLoadedAt: 1700000000000,
        totalSessions: 3,
        oldestLoadedTimestamp: 1699999999000,
        oldestLoadedSessionId: 'claude:session-3',
        hasMore: true,
      }

      const state = sessionsReducer(stateWithProjects, setActiveSessionSurface('sidebar'))
      expect(state.activeSurface).toBe('sidebar')
      expect(state.windows.sidebar.projects).toEqual(mockProjects)
      expect(state.projects).toEqual(mockProjects)
      expect(state.windows.sidebar.hasMore).toBe(true)
    })

    it('stores per-surface window data without overwriting another surface', () => {
      let state: SessionsState = sessionsReducer(undefined, setProjects(mockProjects))
      state = sessionsReducer(state, setActiveSessionSurface('sidebar'))
      state = sessionsReducer(state, setSessionWindowData({
        surface: 'history',
        projects: [mockProjects[1]],
        totalSessions: 1,
        hasMore: false,
      }))

      expect(state.windows.sidebar.projects).toEqual(mockProjects)
      expect(state.windows.history.projects).toEqual([mockProjects[1]])
      expect(state.projects).toEqual(mockProjects)
    })
  })

  describe('clearProjects', () => {
    it('clears all projects', () => {
      const stateWithProjects = {
        ...initialState,
        projects: mockProjects,
        wsSnapshotReceived: true,
      }
      const state = sessionsReducer(stateWithProjects, clearProjects())
      expect(state.projects).toEqual([])
    })

    it('clears expandedProjects when clearing projects', () => {
      const stateWithExpanded = {
        ...initialState,
        projects: mockProjects,
        expandedProjects: new Set(['/project/one']),
      }
      const state = sessionsReducer(stateWithExpanded, clearProjects())
      expect(state.projects).toEqual([])
      expect(state.expandedProjects.has('/project/one')).toBe(false)
      expect(state.expandedProjects.size).toBe(0)
    })

    it('clears lastLoadedAt', () => {
      const stateWithTimestamp = {
        ...initialState,
        projects: mockProjects,
        lastLoadedAt: 1700000000000,
        wsSnapshotReceived: true,
      }
      const state = sessionsReducer(stateWithTimestamp, clearProjects())
      expect(state.lastLoadedAt).toBeUndefined()
    })
  })

  describe('mergeProjects', () => {
    it('adds new projects to empty state', () => {
      const state = sessionsReducer(initialState, mergeProjects(mockProjects))
      expect(state.projects.length).toBe(3)
    })

    it('merges projects with existing by projectPath', () => {
      const existingProjects: ProjectGroup[] = [
        {
          projectPath: '/project/one',
          sessions: [{ sessionId: 'old-session', projectPath: '/project/one', lastActivityAt: 1600000000000 }],
        },
        {
          projectPath: '/project/existing',
          sessions: [],
        },
      ]
      const stateWithProjects = {
        ...initialState,
        projects: existingProjects,
      }

      const newProjects: ProjectGroup[] = [
        {
          projectPath: '/project/one',
          sessions: [{ sessionId: 'new-session', projectPath: '/project/one', lastActivityAt: 1700000000000 }],
          color: '#ff0000',
        },
        {
          projectPath: '/project/new',
          sessions: [],
        },
      ]

      const state = sessionsReducer(stateWithProjects, mergeProjects(newProjects))
      expect(state.projects.length).toBe(3)
      // /project/one should be updated with new data
      const projectOne = state.projects.find(p => p.projectPath === '/project/one')
      expect(projectOne?.sessions[0].sessionId).toBe('new-session')
      expect(projectOne?.color).toBe('#ff0000')
      // /project/existing should still be there
      expect(state.projects.some(p => p.projectPath === '/project/existing')).toBe(true)
      // /project/new should be added
      expect(state.projects.some(p => p.projectPath === '/project/new')).toBe(true)
    })

    it('sets lastLoadedAt timestamp', () => {
      const beforeTime = Date.now()
      const state = sessionsReducer(initialState, mergeProjects(mockProjects))
      const afterTime = Date.now()
      expect(state.lastLoadedAt).toBeGreaterThanOrEqual(beforeTime)
      expect(state.lastLoadedAt).toBeLessThanOrEqual(afterTime)
    })

    it('handles empty merge array', () => {
      const stateWithProjects = {
        ...initialState,
        projects: mockProjects,
      }
      const state = sessionsReducer(stateWithProjects, mergeProjects([]))
      expect(state.projects.length).toBe(3)
    })

    it('supports chunked loading workflow', () => {
      // First chunk with clear
      let state = sessionsReducer(initialState, clearProjects())
      state = sessionsReducer(state, mergeProjects([mockProjects[0]]))
      expect(state.projects.length).toBe(1)

      // Second chunk with append
      state = sessionsReducer(state, mergeProjects([mockProjects[1]]))
      expect(state.projects.length).toBe(2)

      // Third chunk with append
      state = sessionsReducer(state, mergeProjects([mockProjects[2]]))
      expect(state.projects.length).toBe(3)
      expect(state.projects.map(p => p.projectPath)).toEqual([
        '/project/one',
        '/project/two',
        '/project/three',
      ])
    })
  })

  describe('applySessionsPatch', () => {
    it('ignores patches until a WS sessions.updated snapshot has been received', () => {
      const starting = sessionsReducer(undefined, setProjects([
        { projectPath: '/p1', sessions: [{ provider: 'claude', sessionId: 's1', projectPath: '/p1', lastActivityAt: 1 }] },
      ] as any))

      const next = sessionsReducer(starting, applySessionsPatch({
        upsertProjects: [{ projectPath: '/p2', sessions: [{ provider: 'claude', sessionId: 's2', projectPath: '/p2', lastActivityAt: 2 }] }],
        removeProjectPaths: [],
      }))

      expect(next.projects).toEqual(starting.projects)
      expect(next.lastLoadedAt).toBe(starting.lastLoadedAt)
    })

    it('upserts projects and removes deleted project paths', () => {
      let starting = sessionsReducer(undefined, setProjects([
        { projectPath: '/p1', sessions: [{ provider: 'claude', sessionId: 's1', projectPath: '/p1', lastActivityAt: 1 }] },
        { projectPath: '/p2', sessions: [{ provider: 'claude', sessionId: 's2', projectPath: '/p2', lastActivityAt: 2 }] },
      ] as any))
      starting = sessionsReducer(starting, markWsSnapshotReceived())

      const next = sessionsReducer(starting, applySessionsPatch({
        upsertProjects: [{ projectPath: '/p3', sessions: [{ provider: 'claude', sessionId: 's3', projectPath: '/p3', lastActivityAt: 3 }] }],
        removeProjectPaths: ['/p1'],
      }))

      expect(next.projects.map((p) => p.projectPath).sort()).toEqual(['/p2', '/p3'])
    })

    it('keeps HistoryView project ordering stable by sorting projects by newest session lastActivityAt', () => {
      let starting = sessionsReducer(undefined, setProjects([
        { projectPath: '/p2', sessions: [{ provider: 'claude', sessionId: 's2', projectPath: '/p2', lastActivityAt: 20 }] },
        { projectPath: '/p1', sessions: [{ provider: 'claude', sessionId: 's1', projectPath: '/p1', lastActivityAt: 10 }] },
      ] as any))
      starting = sessionsReducer(starting, markWsSnapshotReceived())

      const next = sessionsReducer(starting, applySessionsPatch({
        upsertProjects: [{ projectPath: '/p1', sessions: [{ provider: 'claude', sessionId: 's1', projectPath: '/p1', lastActivityAt: 30 }] }],
        removeProjectPaths: [],
      }))

      expect(next.projects[0]?.projectPath).toBe('/p1')
      expect(next.projects[1]?.projectPath).toBe('/p2')
    })
  })

  describe('toggleProjectExpanded', () => {
    it('expands a collapsed project', () => {
      const state = sessionsReducer(initialState, toggleProjectExpanded('/project/one'))
      expect(state.expandedProjects.has('/project/one')).toBe(true)
    })

    it('collapses an expanded project', () => {
      const stateWithExpanded = {
        ...initialState,
        expandedProjects: new Set(['/project/one']),
      }
      const state = sessionsReducer(stateWithExpanded, toggleProjectExpanded('/project/one'))
      expect(state.expandedProjects.has('/project/one')).toBe(false)
    })

    it('only toggles the specified project', () => {
      const stateWithExpanded = {
        ...initialState,
        expandedProjects: new Set(['/project/one', '/project/two']),
      }
      const state = sessionsReducer(stateWithExpanded, toggleProjectExpanded('/project/one'))
      expect(state.expandedProjects.has('/project/one')).toBe(false)
      expect(state.expandedProjects.has('/project/two')).toBe(true)
    })

    it('can expand multiple projects', () => {
      let state = sessionsReducer(initialState, toggleProjectExpanded('/project/one'))
      state = sessionsReducer(state, toggleProjectExpanded('/project/two'))
      expect(state.expandedProjects.has('/project/one')).toBe(true)
      expect(state.expandedProjects.has('/project/two')).toBe(true)
    })
  })

  describe('setProjectExpanded', () => {
    it('expands a project when expanded is true', () => {
      const state = sessionsReducer(
        initialState,
        setProjectExpanded({ projectPath: '/project/one', expanded: true })
      )
      expect(state.expandedProjects.has('/project/one')).toBe(true)
    })

    it('collapses a project when expanded is false', () => {
      const stateWithExpanded = {
        ...initialState,
        expandedProjects: new Set(['/project/one']),
      }
      const state = sessionsReducer(
        stateWithExpanded,
        setProjectExpanded({ projectPath: '/project/one', expanded: false })
      )
      expect(state.expandedProjects.has('/project/one')).toBe(false)
    })

    it('is idempotent when expanding already expanded project', () => {
      const stateWithExpanded = {
        ...initialState,
        expandedProjects: new Set(['/project/one']),
      }
      const state = sessionsReducer(
        stateWithExpanded,
        setProjectExpanded({ projectPath: '/project/one', expanded: true })
      )
      expect(state.expandedProjects.has('/project/one')).toBe(true)
      expect(state.expandedProjects.size).toBe(1)
    })

    it('is idempotent when collapsing already collapsed project', () => {
      const state = sessionsReducer(
        initialState,
        setProjectExpanded({ projectPath: '/project/one', expanded: false })
      )
      expect(state.expandedProjects.has('/project/one')).toBe(false)
    })

    it('does not affect other projects', () => {
      const stateWithExpanded = {
        ...initialState,
        expandedProjects: new Set(['/project/one', '/project/two']),
      }
      const state = sessionsReducer(
        stateWithExpanded,
        setProjectExpanded({ projectPath: '/project/one', expanded: false })
      )
      expect(state.expandedProjects.has('/project/one')).toBe(false)
      expect(state.expandedProjects.has('/project/two')).toBe(true)
    })
  })

  describe('collapseAll', () => {
    it('collapses all expanded projects', () => {
      const stateWithExpanded = {
        ...initialState,
        expandedProjects: new Set(['/project/one', '/project/two', '/project/three']),
      }
      const state = sessionsReducer(stateWithExpanded, collapseAll())
      expect(state.expandedProjects.size).toBe(0)
    })

    it('works when no projects are expanded', () => {
      const state = sessionsReducer(initialState, collapseAll())
      expect(state.expandedProjects.size).toBe(0)
    })

    it('preserves projects list', () => {
      const stateWithProjects = {
        ...initialState,
        projects: mockProjects,
        expandedProjects: new Set(['/project/one']),
      }
      const state = sessionsReducer(stateWithProjects, collapseAll())
      expect(state.projects).toEqual(mockProjects)
    })
  })

  describe('expandAll', () => {
    it('expands all projects in the list', () => {
      const stateWithProjects = {
        ...initialState,
        projects: mockProjects,
        expandedProjects: new Set<string>(),
      }
      const state = sessionsReducer(stateWithProjects, expandAll())
      expect(state.expandedProjects.size).toBe(3)
      expect(state.expandedProjects.has('/project/one')).toBe(true)
      expect(state.expandedProjects.has('/project/two')).toBe(true)
      expect(state.expandedProjects.has('/project/three')).toBe(true)
    })

    it('works when some projects are already expanded', () => {
      const stateWithProjects = {
        ...initialState,
        projects: mockProjects,
        expandedProjects: new Set(['/project/one']),
      }
      const state = sessionsReducer(stateWithProjects, expandAll())
      expect(state.expandedProjects.size).toBe(3)
    })

    it('replaces expandedProjects with new Set', () => {
      const stateWithProjects = {
        ...initialState,
        projects: mockProjects,
        expandedProjects: new Set(['/old/project']),
      }
      const state = sessionsReducer(stateWithProjects, expandAll())
      expect(state.expandedProjects.has('/old/project')).toBe(false)
      expect(state.expandedProjects.size).toBe(3)
    })

    it('handles empty projects list', () => {
      const state = sessionsReducer(initialState, expandAll())
      expect(state.expandedProjects.size).toBe(0)
    })
  })

  describe('state immutability', () => {
    it('does not mutate original state on setProjects', () => {
      const originalProjects = [...initialState.projects]
      sessionsReducer(initialState, setProjects(mockProjects))
      expect(initialState.projects).toEqual(originalProjects)
    })

    it('does not mutate original state on toggleProjectExpanded', () => {
      const stateWithExpanded = {
        ...initialState,
        expandedProjects: new Set(['/project/one']),
      }
      const originalSize = stateWithExpanded.expandedProjects.size
      sessionsReducer(stateWithExpanded, toggleProjectExpanded('/project/one'))
      expect(stateWithExpanded.expandedProjects.size).toBe(originalSize)
    })
  })

  describe('complex scenarios', () => {
    it('handles workflow: load projects, expand some, collapse all, expand all', () => {
      let state = sessionsReducer(initialState, setProjects(mockProjects))
      expect(state.projects.length).toBe(3)

      state = sessionsReducer(state, toggleProjectExpanded('/project/one'))
      state = sessionsReducer(state, toggleProjectExpanded('/project/two'))
      expect(state.expandedProjects.size).toBe(2)

      state = sessionsReducer(state, collapseAll())
      expect(state.expandedProjects.size).toBe(0)

      state = sessionsReducer(state, expandAll())
      expect(state.expandedProjects.size).toBe(3)
    })

    it('handles replacing projects while some are expanded', () => {
      let state = sessionsReducer(initialState, setProjects(mockProjects))
      state = sessionsReducer(state, expandAll())
      expect(state.expandedProjects.size).toBe(3)

      const newProjects: ProjectGroup[] = [
        { projectPath: '/new/project', sessions: [] },
      ]
      state = sessionsReducer(state, setProjects(newProjects))
      expect(state.projects.length).toBe(1)
      expect(state.expandedProjects.has('/project/one')).toBe(false)
    })
  })

  describe('robustness', () => {
    it('does not throw if setProjects receives a non-array payload', () => {
      const state = sessionsReducer(initialState, setProjects({} as any))
      expect(state.projects).toEqual([])
      expect(state.expandedProjects.size).toBe(0)
    })

    it('does not throw if mergeProjects receives a non-array payload', () => {
      const state = sessionsReducer(initialState, mergeProjects('nope' as any))
      expect(state.projects).toEqual([])
      expect(state.expandedProjects.size).toBe(0)
    })

    it('passes through duplicate projectPath entries without merging', () => {
      // normalizeProjects validates and normalizes but does not deduplicate
      // by projectPath — downstream reducers handle merging when needed.
      const duplicated: ProjectGroup[] = [
        {
          projectPath: '/large/project',
          sessions: [
            { sessionId: 's1', projectPath: '/large/project', lastActivityAt: 1 },
          ],
        },
        {
          projectPath: '/large/project',
          sessions: [
            { sessionId: 's2', projectPath: '/large/project', lastActivityAt: 2 },
          ],
        },
        {
          projectPath: '/other/project',
          sessions: [
            { sessionId: 's3', projectPath: '/other/project', lastActivityAt: 3 },
          ],
        },
      ]

      const state = sessionsReducer(initialState, setProjects(duplicated))
      // All three entries are preserved as-is (no merging)
      expect(state.projects).toHaveLength(3)
    })

    it('filters non-object session entries to prevent downstream crashes', () => {
      const bad: ProjectGroup[] = [
        {
          projectPath: '/project/one',
          sessions: [1, 'x', null, [], { sessionId: 's1', projectPath: '/project/one', lastActivityAt: 1 }] as any,
        },
      ]

      const state = sessionsReducer(initialState, setProjects(bad))
      expect(state.projects).toHaveLength(1)
      expect(state.projects[0].sessions).toHaveLength(1)
    })
  })

  describe('deepSearchPending', () => {
    it('defaults deepSearchPending to false when setSessionWindowData omits it', () => {
      // Start with a sidebar window that has deepSearchPending: true
      const stateWithPending: SessionsState = {
        ...initialState,
        activeSurface: 'sidebar',
        windows: {
          sidebar: {
            projects: [],
            deepSearchPending: true,
          },
        },
      }

      const state = sessionsReducer(stateWithPending, setSessionWindowData({
        surface: 'sidebar',
        projects: mockProjects,
        totalSessions: 3,
        hasMore: false,
      }))

      expect(state.windows.sidebar.deepSearchPending).toBe(false)
    })

    it('clears deepSearchPending when setSessionWindowLoading sets loading to true', () => {
      const stateWithPending: SessionsState = {
        ...initialState,
        activeSurface: 'sidebar',
        windows: {
          sidebar: {
            projects: mockProjects,
            deepSearchPending: true,
          },
        },
      }

      const state = sessionsReducer(stateWithPending, setSessionWindowLoading({
        surface: 'sidebar',
        loading: true,
        loadingKind: 'search',
      }))

      expect(state.windows.sidebar.deepSearchPending).toBe(false)
    })
  })

  describe('requested vs applied search state', () => {
    it('setSessionWindowLoading updates the requested query and tier without changing the applied search context', () => {
      const stateWithAppliedSearch: SessionsState = {
        ...initialState,
        activeSurface: 'sidebar',
        windows: {
          sidebar: {
            projects: [mockProjects[0]],
            query: 'alpha',
            searchTier: 'title',
            appliedQuery: 'alpha',
            appliedSearchTier: 'title',
          } as any,
        },
      }

      const state = sessionsReducer(stateWithAppliedSearch, setSessionWindowLoading({
        surface: 'sidebar',
        loading: true,
        loadingKind: 'search',
        query: 'beta',
        searchTier: 'fullText',
      }))

      expect(state.windows.sidebar.query).toBe('beta')
      expect(state.windows.sidebar.searchTier).toBe('fullText')
      expect((state.windows.sidebar as any).appliedQuery).toBe('alpha')
      expect((state.windows.sidebar as any).appliedSearchTier).toBe('title')
    })

    it('setSessionWindowData commits requested and applied search fields together with the visible result set', () => {
      const stateWithAppliedSearch: SessionsState = {
        ...initialState,
        activeSurface: 'sidebar',
        windows: {
          sidebar: {
            projects: [mockProjects[0]],
            query: 'alpha',
            searchTier: 'title',
            appliedQuery: 'alpha',
            appliedSearchTier: 'title',
          } as any,
        },
      }

      const state = sessionsReducer(stateWithAppliedSearch, setSessionWindowData({
        surface: 'sidebar',
        projects: [mockProjects[1]],
        totalSessions: 1,
        hasMore: false,
        query: 'beta',
        searchTier: 'fullText',
      }))

      expect(state.windows.sidebar.projects).toEqual([mockProjects[1]])
      expect(state.windows.sidebar.query).toBe('beta')
      expect(state.windows.sidebar.searchTier).toBe('fullText')
      expect((state.windows.sidebar as any).appliedQuery).toBe('beta')
      expect((state.windows.sidebar as any).appliedSearchTier).toBe('fullText')
      expect(state.projects).toEqual([mockProjects[1]])
    })

    it('keeps the previous applied search context during a search-to-browse transition until browse data commits', () => {
      const stateWithAppliedSearch: SessionsState = {
        ...initialState,
        activeSurface: 'sidebar',
        windows: {
          sidebar: {
            projects: [mockProjects[0]],
            query: 'alpha',
            searchTier: 'title',
            appliedQuery: 'alpha',
            appliedSearchTier: 'title',
          } as any,
        },
      }

      const loadingState = sessionsReducer(stateWithAppliedSearch, setSessionWindowLoading({
        surface: 'sidebar',
        loading: true,
        loadingKind: 'search',
        query: '',
        searchTier: 'title',
      }))

      expect(loadingState.windows.sidebar.query).toBe('')
      expect(loadingState.windows.sidebar.searchTier).toBe('title')
      expect((loadingState.windows.sidebar as any).appliedQuery).toBe('alpha')
      expect((loadingState.windows.sidebar as any).appliedSearchTier).toBe('title')

      const committedState = sessionsReducer(loadingState, setSessionWindowData({
        surface: 'sidebar',
        projects: mockProjects,
        totalSessions: mockProjects.length,
        hasMore: true,
        query: '',
        searchTier: 'title',
      }))

      expect((committedState.windows.sidebar as any).appliedQuery).toBe('')
      expect((committedState.windows.sidebar as any).appliedSearchTier).toBe('title')
    })
  })
})
