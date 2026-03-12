import { describe, it, expect } from 'vitest'
import { paginateProjects, type PaginatedResult } from '../../../server/session-pagination.js'
import type { ProjectGroup, CodingCliSession } from '../../../server/coding-cli/types.js'

function makeSession(
  provider: 'claude' | 'codex',
  sessionId: string,
  updatedAt: number,
  projectPath = '/project/a',
): CodingCliSession {
  return {
    provider,
    sessionId,
    projectPath,
    updatedAt,
    title: `Session ${sessionId}`,
  }
}

function makeProject(path: string, sessions: CodingCliSession[]): ProjectGroup {
  return { projectPath: path, sessions }
}

describe('paginateProjects', () => {
  it('returns all sessions when total is within limit', () => {
    const projects: ProjectGroup[] = [
      makeProject('/a', [
        makeSession('claude', 's1', 100, '/a'),
        makeSession('claude', 's2', 200, '/a'),
      ]),
    ]

    const result = paginateProjects(projects, {})
    expect(result.hasMore).toBe(false)
    expect(result.totalSessions).toBe(2)
    expect(result.projects).toHaveLength(1)
    expect(result.projects[0].sessions).toHaveLength(2)
  })

  it('returns most recent N sessions when total exceeds limit', () => {
    const projects: ProjectGroup[] = [
      makeProject('/a', [
        makeSession('claude', 's1', 100, '/a'),
        makeSession('claude', 's2', 200, '/a'),
        makeSession('claude', 's3', 300, '/a'),
      ]),
    ]

    const result = paginateProjects(projects, { limit: 2 })
    expect(result.hasMore).toBe(true)
    expect(result.totalSessions).toBe(3)
    // Should include the 2 most recent (updatedAt 300, 200)
    const allSessions = result.projects.flatMap(p => p.sessions)
    expect(allSessions).toHaveLength(2)
    const timestamps = allSessions.map(s => s.updatedAt).sort((a, b) => b - a)
    expect(timestamps).toEqual([300, 200])
    expect(result.oldestIncludedTimestamp).toBe(200)
  })

  it('regroups sessions into correct projects after pagination', () => {
    const projects: ProjectGroup[] = [
      makeProject('/a', [
        makeSession('claude', 's1', 100, '/a'),
        makeSession('claude', 's2', 400, '/a'),
      ]),
      makeProject('/b', [
        makeSession('claude', 's3', 200, '/b'),
        makeSession('claude', 's4', 300, '/b'),
      ]),
    ]

    const result = paginateProjects(projects, { limit: 3 })
    expect(result.hasMore).toBe(true)
    expect(result.totalSessions).toBe(4)
    // Top 3: s2(400), s4(300), s3(200) → projects /a has s2, /b has s3+s4
    const projectA = result.projects.find(p => p.projectPath === '/a')
    const projectB = result.projects.find(p => p.projectPath === '/b')
    expect(projectA?.sessions).toHaveLength(1)
    expect(projectA?.sessions[0].sessionId).toBe('s2')
    expect(projectB?.sessions).toHaveLength(2)
  })

  it('preserves project color in regrouped output', () => {
    const projects: ProjectGroup[] = [
      { projectPath: '/a', sessions: [makeSession('claude', 's1', 100, '/a')], color: '#ff0000' },
    ]

    const result = paginateProjects(projects, { limit: 10 })
    expect(result.projects[0].color).toBe('#ff0000')
  })

  it('filters sessions with before cursor', () => {
    const projects: ProjectGroup[] = [
      makeProject('/a', [
        makeSession('claude', 's1', 100, '/a'),
        makeSession('claude', 's2', 200, '/a'),
        makeSession('claude', 's3', 300, '/a'),
      ]),
    ]

    const result = paginateProjects(projects, { before: 300, limit: 10 })
    // Should only include sessions with updatedAt < 300
    const allSessions = result.projects.flatMap(p => p.sessions)
    expect(allSessions).toHaveLength(2)
    expect(allSessions.every(s => s.updatedAt < 300)).toBe(true)
    expect(result.oldestIncludedTimestamp).toBe(100)
    expect(result.hasMore).toBe(false)
  })

  it('handles duplicate timestamps with beforeId tie-breaker', () => {
    const projects: ProjectGroup[] = [
      makeProject('/a', [
        makeSession('claude', 'aaa', 1000, '/a'),
        makeSession('claude', 'bbb', 1000, '/a'),
        makeSession('claude', 'ccc', 1000, '/a'),
      ]),
    ]

    // Page 1: get first 2 (sorted by updatedAt desc, then sessionId desc)
    const page1 = paginateProjects(projects, { limit: 2 })
    const page1Sessions = page1.projects.flatMap(p => p.sessions)
    expect(page1Sessions).toHaveLength(2)
    expect(page1.hasMore).toBe(true)
    // Sessions with same timestamp sorted by sessionId desc: ccc, bbb, aaa
    expect(page1Sessions[0].sessionId).toBe('ccc')
    expect(page1Sessions[1].sessionId).toBe('bbb')

    // Page 2: use compound cursor to get remaining
    const page2 = paginateProjects(projects, {
      before: page1.oldestIncludedTimestamp,
      beforeId: page1.oldestIncludedSessionId,
      limit: 10,
    })
    const page2Sessions = page2.projects.flatMap(p => p.sessions)
    expect(page2Sessions).toHaveLength(1)
    expect(page2Sessions[0].sessionId).toBe('aaa')
    expect(page2.hasMore).toBe(false)
  })

  it('handles cross-provider sessionId collisions with compound cursor', () => {
    const projects: ProjectGroup[] = [
      makeProject('/a', [
        // Same sessionId, same updatedAt, different providers
        makeSession('claude', 'same-id', 1000, '/a'),
        makeSession('codex', 'same-id', 1000, '/a'),
        makeSession('claude', 'other', 500, '/a'),
      ]),
    ]

    // Page 1: get first 2
    const page1 = paginateProjects(projects, { limit: 2 })
    const page1Sessions = page1.projects.flatMap(p => p.sessions)
    expect(page1Sessions).toHaveLength(2)
    expect(page1.hasMore).toBe(true)

    // Page 2: use compound cursor — should get the remaining session
    const page2 = paginateProjects(projects, {
      before: page1.oldestIncludedTimestamp,
      beforeId: page1.oldestIncludedSessionId,
      limit: 10,
    })
    const page2Sessions = page2.projects.flatMap(p => p.sessions)
    expect(page2Sessions).toHaveLength(1)
    expect(page2Sessions[0].updatedAt).toBe(500)
    expect(page2.hasMore).toBe(false)
  })

  it('supports cursor-based pagination with before + limit', () => {
    const projects: ProjectGroup[] = [
      makeProject('/a', [
        makeSession('claude', 's1', 100, '/a'),
        makeSession('claude', 's2', 200, '/a'),
        makeSession('claude', 's3', 300, '/a'),
        makeSession('claude', 's4', 400, '/a'),
        makeSession('claude', 's5', 500, '/a'),
      ]),
    ]

    // Page 1: most recent 2
    const page1 = paginateProjects(projects, { limit: 2 })
    expect(page1.hasMore).toBe(true)
    expect(page1.oldestIncludedTimestamp).toBe(400)

    // Page 2: use compound cursor
    const page2 = paginateProjects(projects, {
      before: page1.oldestIncludedTimestamp,
      beforeId: page1.oldestIncludedSessionId,
      limit: 2,
    })
    expect(page2.hasMore).toBe(true)
    const page2Sessions = page2.projects.flatMap(p => p.sessions)
    const page2Timestamps = page2Sessions.map(s => s.updatedAt).sort((a, b) => b - a)
    expect(page2Timestamps).toEqual([300, 200])
    expect(page2.oldestIncludedTimestamp).toBe(200)

    // Page 3: remaining
    const page3 = paginateProjects(projects, {
      before: page2.oldestIncludedTimestamp,
      beforeId: page2.oldestIncludedSessionId,
      limit: 2,
    })
    expect(page3.hasMore).toBe(false)
    const page3Sessions = page3.projects.flatMap(p => p.sessions)
    expect(page3Sessions).toHaveLength(1)
    expect(page3Sessions[0].updatedAt).toBe(100)
  })

  it('handles empty input', () => {
    const result = paginateProjects([], {})
    expect(result.projects).toEqual([])
    expect(result.totalSessions).toBe(0)
    expect(result.oldestIncludedTimestamp).toBe(0)
    expect(result.hasMore).toBe(false)
  })

  it('handles projects with empty sessions arrays', () => {
    const projects: ProjectGroup[] = [
      makeProject('/a', []),
      makeProject('/b', [makeSession('claude', 's1', 100, '/b')]),
    ]

    const result = paginateProjects(projects, {})
    expect(result.totalSessions).toBe(1)
    // Empty project should be excluded from output
    expect(result.projects).toHaveLength(1)
    expect(result.projects[0].projectPath).toBe('/b')
  })

  it('uses default limit when none specified', () => {
    // Create more than default limit (100) sessions
    const sessions: CodingCliSession[] = []
    for (let i = 0; i < 150; i++) {
      sessions.push(makeSession('claude', `s${i}`, i * 10, '/a'))
    }
    const projects: ProjectGroup[] = [makeProject('/a', sessions)]

    const result = paginateProjects(projects, {})
    const allSessions = result.projects.flatMap(p => p.sessions)
    expect(allSessions).toHaveLength(100)
    expect(result.hasMore).toBe(true)
    expect(result.totalSessions).toBe(150)
  })

  it('force-includes older first-page sessions without duplicating in-window sessions and preserves the primary cursor', () => {
    const projects: ProjectGroup[] = [
      makeProject('/a', [
        makeSession('claude', 's1', 100, '/a'),
        makeSession('claude', 's2', 200, '/a'),
        makeSession('claude', 's3', 300, '/a'),
        makeSession('claude', 's4', 400, '/a'),
        makeSession('claude', 's5', 500, '/a'),
      ]),
    ]

    const result = paginateProjects(projects, {
      limit: 3,
      forceIncludeSessionKeys: new Set(['claude:s4', 'claude:s1']),
    })

    const sessionIds = result.projects.flatMap((project) => project.sessions).map((session) => session.sessionId)
    expect(sessionIds).toEqual(['s5', 's4', 's3', 's1'])
    expect(result.oldestIncludedTimestamp).toBe(300)
    expect(result.oldestIncludedSessionId).toBe('claude:s3')
    expect(result.hasMore).toBe(true)
  })

  it('ignores force inclusion on later pages', () => {
    const projects: ProjectGroup[] = [
      makeProject('/a', [
        makeSession('claude', 's1', 100, '/a'),
        makeSession('claude', 's2', 200, '/a'),
        makeSession('claude', 's3', 300, '/a'),
        makeSession('claude', 's4', 400, '/a'),
        makeSession('claude', 's5', 500, '/a'),
      ]),
    ]

    const page1 = paginateProjects(projects, {
      limit: 3,
      forceIncludeSessionKeys: new Set(['claude:s1']),
    })

    const page2 = paginateProjects(projects, {
      limit: 3,
      before: page1.oldestIncludedTimestamp,
      beforeId: page1.oldestIncludedSessionId,
      forceIncludeSessionKeys: new Set(['claude:s5']),
    })

    const sessionIds = page2.projects.flatMap((project) => project.sessions).map((session) => session.sessionId)
    expect(sessionIds).toEqual(['s2', 's1'])
  })

  it('reports no more pages when force-included extras already cover every remaining unique session', () => {
    const projects: ProjectGroup[] = [
      makeProject('/a', [
        makeSession('claude', 's1', 100, '/a'),
        makeSession('claude', 's2', 200, '/a'),
        makeSession('claude', 's3', 300, '/a'),
      ]),
    ]

    const result = paginateProjects(projects, {
      limit: 2,
      forceIncludeSessionKeys: new Set(['claude:s1']),
    })

    const sessionIds = result.projects.flatMap((project) => project.sessions).map((session) => session.sessionId)
    expect(sessionIds).toEqual(['s3', 's2', 's1'])
    expect(result.hasMore).toBe(false)
  })

  it('sets correct totalSessions counting all sessions including filtered', () => {
    const projects: ProjectGroup[] = [
      makeProject('/a', [
        makeSession('claude', 's1', 100, '/a'),
        makeSession('claude', 's2', 200, '/a'),
        makeSession('claude', 's3', 300, '/a'),
      ]),
    ]

    // totalSessions always reflects the full count, not the filtered/paged count
    const result = paginateProjects(projects, { before: 300, beforeId: 'claude:s3', limit: 1 })
    expect(result.totalSessions).toBe(3)
  })
})
