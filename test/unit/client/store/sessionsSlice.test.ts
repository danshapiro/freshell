import { describe, it, expect, beforeEach } from 'vitest'
import { enableMapSet } from 'immer'
import sessionsReducer, {
  setProjects,
  clearProjects,
  mergeProjects,
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
      }
      const state = sessionsReducer(stateWithProjects, clearProjects())
      expect(state.projects).toEqual([])
    })

    it('clears expandedProjects when clearing projects', () => {
      const stateWithExpanded = {
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
        projects: mockProjects,
        expandedProjects: new Set(['/project/one']),
      }
      const state = sessionsReducer(stateWithProjects, expandAll())
      expect(state.expandedProjects.size).toBe(3)
    })

    it('replaces expandedProjects with new Set', () => {
      const stateWithProjects = {
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
  })
})
