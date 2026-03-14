import { describe, it, expect } from 'vitest'
import { makeSelectKnownSessionKeys } from '@/store/selectors/sidebarSelectors'
import type { RootState } from '@/store/store'

function createState(projects: RootState['sessions']['projects']): RootState {
  return {
    sessions: {
      projects,
      loading: false,
      error: null,
      expandedProjects: {},
      projectColors: {},
      sessionColorOverrides: {},
      source: 'runtime',
    },
  } as unknown as RootState
}

describe('makeSelectKnownSessionKeys', () => {
  it('memoizes the key set for unrelated state changes', () => {
    const projects = [
      {
        projectPath: '/repo',
        sessions: [
          { sessionId: 'session-a', provider: 'claude', lastActivityAt: 1, projectPath: '/repo' },
          { sessionId: 'session-b', provider: 'codex', lastActivityAt: 2, projectPath: '/repo' },
        ],
      },
    ] as RootState['sessions']['projects']

    const stateA = createState(projects)
    const stateB = { ...stateA, tabs: { tabs: [], activeTabId: null } } as RootState

    const selector = makeSelectKnownSessionKeys()
    const keysA = selector(stateA)
    const keysB = selector(stateB)

    expect(keysB).toBe(keysA)
  })

  it('defaults provider-less sessions to claude', () => {
    const projects = [
      {
        projectPath: '/repo',
        sessions: [
          { sessionId: 'legacy-session', lastActivityAt: 1, projectPath: '/repo' },
        ],
      },
    ] as RootState['sessions']['projects']

    const selector = makeSelectKnownSessionKeys()
    const keys = selector(createState(projects))

    expect(Array.from(keys)).toEqual(['claude:legacy-session'])
  })
})
