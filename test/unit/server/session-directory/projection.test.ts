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
      // STATUS-STRIP: usage is now a directory-visible field — usage ticks must
      // trigger sessions.changed so the strip's context meter refetches.
      tokenUsage: { inputTokens: 1, outputTokens: 2, cachedTokens: 3, totalTokens: 6 },
    })
  })

  it('ignores invisible metadata and project color but still treats lastActivityAt and tokenUsage as visible', () => {
    const first: ProjectGroup[] = [{
      projectPath: '/repo',
      color: '#f00',
      sessions: [{ ...baseSession, tokenUsage: { inputTokens: 1, outputTokens: 2, cachedTokens: 0, totalTokens: 3 } }],
    }]
    const sameUsageDifferentColor: ProjectGroup[] = [{
      projectPath: '/repo',
      color: '#0f0',
      sessions: [{ ...baseSession, tokenUsage: { inputTokens: 1, outputTokens: 2, cachedTokens: 0, totalTokens: 3 }, sourceFile: '/tmp/other.jsonl' }],
    }]
    const usageChanged: ProjectGroup[] = [{
      projectPath: '/repo',
      sessions: [{ ...baseSession, tokenUsage: { inputTokens: 9, outputTokens: 9, cachedTokens: 9, totalTokens: 27 } }],
    }]
    const lastActivityAtChanged: ProjectGroup[] = [{
      projectPath: '/repo',
      sessions: [{ ...baseSession, lastActivityAt: 101 }],
    }]

    expect(hasSessionDirectorySnapshotChange(first, sameUsageDifferentColor)).toBe(false)
    // STATUS-STRIP: usage ticks count as a change so sessions.changed fires and
    // the strip's context meter refetches even when nothing else moved.
    expect(hasSessionDirectorySnapshotChange(first, usageChanged)).toBe(true)
    expect(hasSessionDirectorySnapshotChange(
      [{ projectPath: '/repo', sessions: [{ ...baseSession, lastActivityAt: 100 }] }],
      lastActivityAtChanged,
    )).toBe(true)
  })

  it('treats title-override provenance as comparable: a rename and a clear both fire sessions.changed', () => {
    // b5fb: provenance changes must produce a detectable snapshot diff —
    // otherwise a rename/clear writes the override but no client is told to
    // refetch the directory page that carries the reset-flow fields.
    const bare: ProjectGroup[] = [{ projectPath: '/repo', sessions: [{ ...baseSession }] }]
    const renamed: ProjectGroup[] = [{
      projectPath: '/repo',
      sessions: [{
        ...baseSession,
        title: 'Accidental pane label',
        titleOverridden: true,
        providerTitle: baseSession.title,
        titleOverrideSource: 'user',
      }],
    }]

    // Rename applied → the override title AND its provenance appear.
    expect(hasSessionDirectorySnapshotChange(bare, renamed)).toBe(true)
    // Clear → back to the parsed title with provenance gone.
    expect(hasSessionDirectorySnapshotChange(renamed, bare)).toBe(true)

    // Discriminating case: provenance ALONE differs (the displayed title is
    // identical on both sides). Equality must still detect it — this is what
    // pins titleOverridden/providerTitle/titleOverrideSource as comparable.
    const provenanceOnly: ProjectGroup[] = [{
      projectPath: '/repo',
      sessions: [{
        ...baseSession,
        titleOverridden: true,
        providerTitle: baseSession.title,
        titleOverrideSource: 'user',
      }],
    }]
    expect(hasSessionDirectorySnapshotChange(bare, provenanceOnly)).toBe(true)
  })
})
