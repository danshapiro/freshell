import { describe, it, expect } from 'vitest'
import type { ProjectGroup } from '../../../../server/coding-cli/types.js'
import { diffProjects } from '../../../../server/sessions-sync/diff.js'

function pg(projectPath: string, sessions: ProjectGroup['sessions'], color?: string): ProjectGroup {
  return { projectPath, sessions, ...(color ? { color } : {}) }
}

describe('diffProjects', () => {
  it('upserts newly added projects', () => {
    const prev: ProjectGroup[] = []
    const next: ProjectGroup[] = [
      pg('/p1', [{ provider: 'claude', sessionId: 's1', projectPath: '/p1', updatedAt: 1 }]),
    ]

    const diff = diffProjects(prev, next)
    expect(diff.removeProjectPaths).toEqual([])
    expect(diff.upsertProjects).toEqual(next)
  })

  it('removes deleted projects', () => {
    const prev: ProjectGroup[] = [
      pg('/p1', [{ provider: 'claude', sessionId: 's1', projectPath: '/p1', updatedAt: 1 }]),
      pg('/p2', [{ provider: 'claude', sessionId: 's2', projectPath: '/p2', updatedAt: 2 }]),
    ]
    const next: ProjectGroup[] = [
      pg('/p2', [{ provider: 'claude', sessionId: 's2', projectPath: '/p2', updatedAt: 2 }]),
    ]

    const diff = diffProjects(prev, next)
    expect(diff.removeProjectPaths).toEqual(['/p1'])
    expect(diff.upsertProjects).toEqual([])
  })

  it('upserts projects when a session field changes', () => {
    const prev: ProjectGroup[] = [
      pg('/p1', [{ provider: 'claude', sessionId: 's1', projectPath: '/p1', updatedAt: 1, title: 'Old' }]),
    ]
    const next: ProjectGroup[] = [
      pg('/p1', [{ provider: 'claude', sessionId: 's1', projectPath: '/p1', updatedAt: 1, title: 'New' }]),
    ]

    const diff = diffProjects(prev, next)
    expect(diff.removeProjectPaths).toEqual([])
    expect(diff.upsertProjects).toEqual(next)
  })

  it('does not upsert unchanged projects', () => {
    const prev: ProjectGroup[] = [
      pg('/p1', [{ provider: 'claude', sessionId: 's1', projectPath: '/p1', updatedAt: 1 }], '#aaa'),
    ]
    const next: ProjectGroup[] = [
      pg('/p1', [{ provider: 'claude', sessionId: 's1', projectPath: '/p1', updatedAt: 1 }], '#aaa'),
    ]

    const diff = diffProjects(prev, next)
    expect(diff.removeProjectPaths).toEqual([])
    expect(diff.upsertProjects).toEqual([])
  })

  it('does not upsert when tokenUsage object instances differ but values are identical', () => {
    const prev: ProjectGroup[] = [
      pg('/p1', [{
        provider: 'claude',
        sessionId: 's1',
        projectPath: '/p1',
        updatedAt: 1,
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 20,
          cachedTokens: 30,
          totalTokens: 60,
          compactPercent: 25,
        },
      }]),
    ]
    const next: ProjectGroup[] = [
      pg('/p1', [{
        provider: 'claude',
        sessionId: 's1',
        projectPath: '/p1',
        updatedAt: 1,
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 20,
          cachedTokens: 30,
          totalTokens: 60,
          compactPercent: 25,
        },
      }]),
    ]

    expect(prev[0].sessions[0].tokenUsage).not.toBe(next[0].sessions[0].tokenUsage)

    const diff = diffProjects(prev, next)
    expect(diff.removeProjectPaths).toEqual([])
    expect(diff.upsertProjects).toEqual([])
  })

  it('upserts when tokenUsage values change', () => {
    const prev: ProjectGroup[] = [
      pg('/p1', [{
        provider: 'claude',
        sessionId: 's1',
        projectPath: '/p1',
        updatedAt: 1,
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 20,
          cachedTokens: 30,
          totalTokens: 60,
        },
      }]),
    ]
    const next: ProjectGroup[] = [
      pg('/p1', [{
        provider: 'claude',
        sessionId: 's1',
        projectPath: '/p1',
        updatedAt: 1,
        tokenUsage: {
          inputTokens: 11,
          outputTokens: 20,
          cachedTokens: 30,
          totalTokens: 61,
        },
      }]),
    ]

    const diff = diffProjects(prev, next)
    expect(diff.removeProjectPaths).toEqual([])
    expect(diff.upsertProjects).toEqual(next)
  })

  it('stays strict for internal metadata changes that are invisible to the directory read model', () => {
    const prev: ProjectGroup[] = [
      pg('/p1', [{
        provider: 'codex',
        sessionId: 's1',
        projectPath: '/p1',
        updatedAt: 1,
        title: 'Deploy',
        sourceFile: '/tmp/a.jsonl',
      }]),
    ]
    const next: ProjectGroup[] = [
      pg('/p1', [{
        provider: 'codex',
        sessionId: 's1',
        projectPath: '/p1',
        updatedAt: 1,
        title: 'Deploy',
        sourceFile: '/tmp/b.jsonl',
      }]),
    ]

    const diff = diffProjects(prev, next)
    expect(diff.removeProjectPaths).toEqual([])
    expect(diff.upsertProjects).toEqual(next)
  })
})
