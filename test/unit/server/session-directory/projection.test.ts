import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '../../../../server/coding-cli/types.js'
import {
  hasSessionDirectorySnapshotChange,
  toSessionDirectoryComparableItem,
} from '../../../../server/session-directory/projection.js'

const baseSession = {
  provider: 'codex',
  sessionId: 's1',
  projectPath: '/repo',
  lastActivityAt: 100,
  title: 'Deploy',
} as const

describe('session-directory projection', () => {
  it('projects only directory-visible fields from a session', () => {
    expect(toSessionDirectoryComparableItem({
      provider: 'codex',
      sessionId: 's1',
      projectPath: '/repo',
      lastActivityAt: 100,
      createdAt: 50,
      title: 'Deploy',
      summary: 'Summary',
      firstUserMessage: 'ship it',
      cwd: '/repo',
      archived: false,
      sessionType: 'codex',
      isSubagent: false,
      isNonInteractive: false,
      tokenUsage: { inputTokens: 1, outputTokens: 2, cachedTokens: 3, totalTokens: 6 },
      codexTaskEvents: { latestTaskStartedAt: 99 },
      sourceFile: '/tmp/session.jsonl',
    })).toEqual({
      provider: 'codex',
      sessionId: 's1',
      sessionKey: 'codex:s1',
      projectPath: '/repo',
      lastActivityAt: 100,
      createdAt: 50,
      title: 'Deploy',
      summary: 'Summary',
      firstUserMessage: 'ship it',
      cwd: '/repo',
      archived: false,
      sessionType: 'codex',
      isSubagent: false,
      isNonInteractive: false,
    })
  })

  it('ignores invisible metadata, project color, and timestamp-only changes', () => {
    const first: ProjectGroup[] = [{
      projectPath: '/repo',
      color: '#f00',
      sessions: [{ ...baseSession, tokenUsage: { inputTokens: 1, outputTokens: 2, cachedTokens: 0, totalTokens: 3 } }],
    }]
    const second: ProjectGroup[] = [{
      projectPath: '/repo',
      color: '#0f0',
      sessions: [{ ...baseSession, tokenUsage: { inputTokens: 9, outputTokens: 9, cachedTokens: 9, totalTokens: 27 }, sourceFile: '/tmp/other.jsonl' }],
    }]
    const lastActivityAtChanged: ProjectGroup[] = [{
      projectPath: '/repo',
      sessions: [{ ...baseSession, lastActivityAt: 101 }],
    }]

    expect(hasSessionDirectorySnapshotChange(first, second)).toBe(false)
    expect(hasSessionDirectorySnapshotChange(
      [{ projectPath: '/repo', sessions: [{ ...baseSession, lastActivityAt: 100 }] }],
      lastActivityAtChanged,
    )).toBe(false)
  })

  it('returns false when only createdAt differs', () => {
    const before: ProjectGroup[] = [{
      projectPath: '/repo',
      sessions: [{ ...baseSession, createdAt: 50 }],
    }]
    const after: ProjectGroup[] = [{
      projectPath: '/repo',
      sessions: [{ ...baseSession, createdAt: 99 }],
    }]
    expect(hasSessionDirectorySnapshotChange(before, after)).toBe(false)
  })

  it('returns true when a sidebar-relevant field changes alongside timestamps', () => {
    const before: ProjectGroup[] = [{
      projectPath: '/repo',
      sessions: [{ ...baseSession, title: 'Deploy', lastActivityAt: 100, createdAt: 50 }],
    }]
    const after: ProjectGroup[] = [{
      projectPath: '/repo',
      sessions: [{ ...baseSession, title: 'Deploy v2', lastActivityAt: 200, createdAt: 50 }],
    }]
    expect(hasSessionDirectorySnapshotChange(before, after)).toBe(true)
  })
})
