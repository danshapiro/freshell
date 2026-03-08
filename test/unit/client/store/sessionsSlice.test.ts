import { describe, it, expect, beforeEach } from 'vitest'
import { enableMapSet } from 'immer'
import sessionsReducer, {
  markWsSnapshotReceived,
  setProjects,
  clearProjects,
  mergeProjects,
  mergeSnapshotProjects,
  applySessionsPatch,
  toggleProjectExpanded,
  setProjectExpanded,
  collapseAll,
  expandAll,
  SessionsState,
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
          updatedAt: 1700000000000,
          messageCount: 5,
          title: 'First Session',
        },
        {
          sessionId: 'session-2',
          projectPath: '/project/one',
          updatedAt: 1700000001000,
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
          updatedAt: 1700000002000,
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

    it('does not update lastLoadedAt', () => {
      const stateWithTimestamp = {
        ...initialState,
        projects: mockProjects,
        lastLoadedAt: 1700000000000,
        wsSnapshotReceived: true,
      }
      const state = sessionsReducer(stateWithTimestamp, clearProjects())
      expect(state.lastLoadedAt).toBe(1700000000000)
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
          sessions: [{ sessionId: 'old-session', projectPath: '/project/one', updatedAt: 1600000000000 }],
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
          sessions: [{ sessionId: 'new-session', projectPath: '/project/one', updatedAt: 1700000000000 }],
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
        { projectPath: '/p1', sessions: [{ provider: 'claude', sessionId: 's1', projectPath: '/p1', updatedAt: 1 }] },
      ] as any))

      const next = sessionsReducer(starting, applySessionsPatch({
        upsertProjects: [{ projectPath: '/p2', sessions: [{ provider: 'claude', sessionId: 's2', projectPath: '/p2', updatedAt: 2 }] }],
        removeProjectPaths: [],
      }))

      expect(next.projects).toEqual(starting.projects)
      expect(next.lastLoadedAt).toBe(starting.lastLoadedAt)
    })

    it('upserts projects and removes deleted project paths', () => {
      let starting = sessionsReducer(undefined, setProjects([
        { projectPath: '/p1', sessions: [{ provider: 'claude', sessionId: 's1', projectPath: '/p1', updatedAt: 1 }] },
        { projectPath: '/p2', sessions: [{ provider: 'claude', sessionId: 's2', projectPath: '/p2', updatedAt: 2 }] },
      ] as any))
      starting = sessionsReducer(starting, markWsSnapshotReceived())

      const next = sessionsReducer(starting, applySessionsPatch({
        upsertProjects: [{ projectPath: '/p3', sessions: [{ provider: 'claude', sessionId: 's3', projectPath: '/p3', updatedAt: 3 }] }],
        removeProjectPaths: ['/p1'],
      }))

      expect(next.projects.map((p) => p.projectPath).sort()).toEqual(['/p2', '/p3'])
    })

    it('keeps HistoryView project ordering stable by sorting projects by newest session updatedAt', () => {
      let starting = sessionsReducer(undefined, setProjects([
        { projectPath: '/p2', sessions: [{ provider: 'claude', sessionId: 's2', projectPath: '/p2', updatedAt: 20 }] },
        { projectPath: '/p1', sessions: [{ provider: 'claude', sessionId: 's1', projectPath: '/p1', updatedAt: 10 }] },
      ] as any))
      starting = sessionsReducer(starting, markWsSnapshotReceived())

      const next = sessionsReducer(starting, applySessionsPatch({
        upsertProjects: [{ projectPath: '/p1', sessions: [{ provider: 'claude', sessionId: 's1', projectPath: '/p1', updatedAt: 30 }] }],
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

    it('merges duplicate projectPath entries from split chunks', () => {
      // When chunkProjects splits an oversized project, multiple entries share
      // the same projectPath. normalizeProjects must merge their sessions.
      const splitChunks: ProjectGroup[] = [
        {
          projectPath: '/large/project',
          sessions: [
            { sessionId: 's1', projectPath: '/large/project', updatedAt: 1 },
            { sessionId: 's2', projectPath: '/large/project', updatedAt: 2 },
          ],
        },
        {
          projectPath: '/large/project',
          sessions: [
            { sessionId: 's3', projectPath: '/large/project', updatedAt: 3 },
          ],
        },
        {
          projectPath: '/other/project',
          sessions: [
            { sessionId: 's4', projectPath: '/other/project', updatedAt: 4 },
          ],
        },
      ]

      const state = sessionsReducer(initialState, setProjects(splitChunks))
      expect(state.projects).toHaveLength(2)

      const large = state.projects.find(p => p.projectPath === '/large/project')!
      expect(large.sessions).toHaveLength(3)
      expect(large.sessions.map((s: any) => s.sessionId)).toEqual(['s1', 's2', 's3'])

      const other = state.projects.find(p => p.projectPath === '/other/project')!
      expect(other.sessions).toHaveLength(1)
    })

    it('preserves color from first entry when merging duplicate projectPaths', () => {
      const splitChunks: ProjectGroup[] = [
        {
          projectPath: '/colored/project',
          sessions: [{ sessionId: 's1', projectPath: '/colored/project', updatedAt: 1 }],
          color: '#ff0000',
        },
        {
          projectPath: '/colored/project',
          sessions: [{ sessionId: 's2', projectPath: '/colored/project', updatedAt: 2 }],
        },
      ]

      const state = sessionsReducer(initialState, setProjects(splitChunks))
      expect(state.projects).toHaveLength(1)
      expect(state.projects[0].color).toBe('#ff0000')
      expect(state.projects[0].sessions).toHaveLength(2)
    })

    it('deduplicates sessions by provider:sessionId when merging split chunks', () => {
      // If overlapping chunks arrive (e.g., reconnect/retry), duplicate
      // sessions should not produce duplicate entries. Dedup uses composite
      // key provider:sessionId to match mergeSnapshotProjects convention.
      const overlapping: ProjectGroup[] = [
        {
          projectPath: '/project/dup',
          sessions: [
            { sessionId: 's1', projectPath: '/project/dup', updatedAt: 1 },
            { sessionId: 's2', projectPath: '/project/dup', updatedAt: 2 },
          ],
        },
        {
          projectPath: '/project/dup',
          sessions: [
            { sessionId: 's2', projectPath: '/project/dup', updatedAt: 2 },
            { sessionId: 's3', projectPath: '/project/dup', updatedAt: 3 },
          ],
        },
      ]

      const state = sessionsReducer(initialState, setProjects(overlapping))
      const project = state.projects.find(p => p.projectPath === '/project/dup')!
      expect(project.sessions).toHaveLength(3)
      expect(project.sessions.map((s: any) => s.sessionId)).toEqual(['s1', 's2', 's3'])
    })

    it('keeps sessions with same sessionId but different providers', () => {
      // Two providers can generate sessions with the same sessionId.
      // normalizeProjects must use provider:sessionId as the dedup key.
      const multiProvider: ProjectGroup[] = [
        {
          projectPath: '/project/multi',
          sessions: [
            { sessionId: 's1', projectPath: '/project/multi', updatedAt: 1, provider: 'claude' },
          ],
        },
        {
          projectPath: '/project/multi',
          sessions: [
            { sessionId: 's1', projectPath: '/project/multi', updatedAt: 2, provider: 'codex' },
          ],
        },
      ]

      const state = sessionsReducer(initialState, setProjects(multiProvider))
      const project = state.projects.find(p => p.projectPath === '/project/multi')!
      expect(project.sessions).toHaveLength(2)
      expect(project.sessions.map((s: any) => s.provider)).toEqual(['claude', 'codex'])
    })

    it('filters non-object session entries to prevent downstream crashes', () => {
      const bad: ProjectGroup[] = [
        {
          projectPath: '/project/one',
          sessions: [1, 'x', null, [], { sessionId: 's1', projectPath: '/project/one', updatedAt: 1 }] as any,
        },
      ]

      const state = sessionsReducer(initialState, setProjects(bad))
      expect(state.projects).toHaveLength(1)
      expect(state.projects[0].sessions).toHaveLength(1)
    })
  })

  describe('mergeSnapshotProjects', () => {
    it('adds new projects from snapshot', () => {
      const existing: ProjectGroup[] = [
        { projectPath: '/project/a', sessions: [
          { sessionId: 's1', projectPath: '/project/a', updatedAt: 1000, provider: 'claude' },
        ] },
      ]
      const snapshot: ProjectGroup[] = [
        { projectPath: '/project/b', sessions: [
          { sessionId: 's2', projectPath: '/project/b', updatedAt: 2000, provider: 'claude' },
        ] },
      ]
      let state = sessionsReducer(initialState, setProjects(existing))
      state = sessionsReducer(state, mergeSnapshotProjects(snapshot))

      const paths = state.projects.map(p => p.projectPath)
      expect(paths).toContain('/project/a')
      expect(paths).toContain('/project/b')
    })

    it('updates sessions from snapshot while preserving older sessions', () => {
      const existing: ProjectGroup[] = [
        { projectPath: '/project/a', sessions: [
          { sessionId: 's1', projectPath: '/project/a', updatedAt: 3000, provider: 'claude', title: 'Recent' },
          { sessionId: 's2', projectPath: '/project/a', updatedAt: 1000, provider: 'claude', title: 'Old paginated' },
        ] },
      ]
      // Snapshot only includes the recent session (paginated window)
      const snapshot: ProjectGroup[] = [
        { projectPath: '/project/a', sessions: [
          { sessionId: 's1', projectPath: '/project/a', updatedAt: 4000, provider: 'claude', title: 'Recent updated' },
        ] },
      ]
      let state = sessionsReducer(initialState, setProjects(existing))
      state = sessionsReducer(state, mergeSnapshotProjects(snapshot))

      const project = state.projects.find(p => p.projectPath === '/project/a')!
      expect(project.sessions).toHaveLength(2)

      const s1 = project.sessions.find((s: any) => s.sessionId === 's1') as any
      expect(s1.title).toBe('Recent updated')
      expect(s1.updatedAt).toBe(4000)

      const s2 = project.sessions.find((s: any) => s.sessionId === 's2') as any
      expect(s2.title).toBe('Old paginated')
    })

    it('does not duplicate sessions that appear in both snapshot and existing', () => {
      const existing: ProjectGroup[] = [
        { projectPath: '/project/a', sessions: [
          { sessionId: 's1', projectPath: '/project/a', updatedAt: 1000, provider: 'claude' },
          { sessionId: 's2', projectPath: '/project/a', updatedAt: 500, provider: 'claude' },
        ] },
      ]
      const snapshot: ProjectGroup[] = [
        { projectPath: '/project/a', sessions: [
          { sessionId: 's1', projectPath: '/project/a', updatedAt: 2000, provider: 'claude' },
          { sessionId: 's2', projectPath: '/project/a', updatedAt: 1500, provider: 'claude' },
        ] },
      ]
      let state = sessionsReducer(initialState, setProjects(existing))
      state = sessionsReducer(state, mergeSnapshotProjects(snapshot))

      const project = state.projects.find(p => p.projectPath === '/project/a')!
      expect(project.sessions).toHaveLength(2)
    })

    it('preserves projects not in the snapshot', () => {
      const existing: ProjectGroup[] = [
        { projectPath: '/project/a', sessions: [
          { sessionId: 's1', projectPath: '/project/a', updatedAt: 1000, provider: 'claude' },
        ] },
        { projectPath: '/project/old', sessions: [
          { sessionId: 's-old', projectPath: '/project/old', updatedAt: 100, provider: 'claude' },
        ] },
      ]
      // Snapshot only has project/a (paginated, doesn't include old projects)
      const snapshot: ProjectGroup[] = [
        { projectPath: '/project/a', sessions: [
          { sessionId: 's1', projectPath: '/project/a', updatedAt: 2000, provider: 'claude' },
        ] },
      ]
      let state = sessionsReducer(initialState, setProjects(existing))
      state = sessionsReducer(state, mergeSnapshotProjects(snapshot))

      const paths = state.projects.map(p => p.projectPath)
      expect(paths).toContain('/project/a')
      expect(paths).toContain('/project/old')
    })

    it('handles different providers for the same sessionId', () => {
      const existing: ProjectGroup[] = [
        { projectPath: '/project/a', sessions: [
          { sessionId: 's1', projectPath: '/project/a', updatedAt: 1000, provider: 'claude' },
          { sessionId: 's1', projectPath: '/project/a', updatedAt: 500, provider: 'codex' },
        ] },
      ]
      const snapshot: ProjectGroup[] = [
        { projectPath: '/project/a', sessions: [
          { sessionId: 's1', projectPath: '/project/a', updatedAt: 2000, provider: 'claude' },
        ] },
      ]
      let state = sessionsReducer(initialState, setProjects(existing))
      state = sessionsReducer(state, mergeSnapshotProjects(snapshot))

      const project = state.projects.find(p => p.projectPath === '/project/a')!
      // Should have both: updated claude session + preserved codex session
      expect(project.sessions).toHaveLength(2)
      const claudeSession = project.sessions.find((s: any) => s.provider === 'claude') as any
      expect(claudeSession.updatedAt).toBe(2000)
      const codexSession = project.sessions.find((s: any) => s.provider === 'codex') as any
      expect(codexSession.updatedAt).toBe(500)
    })
  })
})
