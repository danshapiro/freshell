// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ProjectGroup, CodingCliSession } from '../../../../server/coding-cli/types.js'
import type { TerminalMeta } from '../../../../server/terminal-metadata-service.js'
import { querySessionDirectory } from '../../../../server/session-directory/service.js'

function makeSession(overrides: Partial<CodingCliSession> & Pick<CodingCliSession, 'sessionId' | 'projectPath' | 'updatedAt'>): CodingCliSession {
  return {
    provider: 'claude',
    title: overrides.sessionId,
    ...overrides,
  }
}

function makeProject(projectPath: string, sessions: CodingCliSession[]): ProjectGroup {
  return { projectPath, sessions }
}

function makeTerminalMeta(overrides: Partial<TerminalMeta> & Pick<TerminalMeta, 'terminalId' | 'updatedAt'>): TerminalMeta {
  return {
    terminalId: overrides.terminalId,
    updatedAt: overrides.updatedAt,
    ...overrides,
  }
}

describe('querySessionDirectory', () => {
  const projects: ProjectGroup[] = [
    makeProject('/repo/alpha', [
      makeSession({
        sessionId: 'session-archived',
        projectPath: '/repo/alpha',
        updatedAt: 400,
        archived: true,
        title: 'Old archived session',
        summary: 'Archived deploy history',
      }),
      makeSession({
        sessionId: 'session-tie-z',
        projectPath: '/repo/alpha',
        updatedAt: 1_000,
        title: 'Zulu deploy',
        summary: 'Deploy summary',
        firstUserMessage: 'deploy alpha service',
        sessionType: 'claude',
      }),
      makeSession({
        sessionId: 'session-search',
        projectPath: '/repo/alpha',
        updatedAt: 900,
        title: 'Routine work',
        summary: 'This session investigates deploy failures in production and captures the remediation notes in detail.',
        firstUserMessage: 'Investigate deploy failures and remediate them safely.',
      }),
    ]),
    makeProject('/repo/beta', [
      makeSession({
        provider: 'codex',
        sessionId: 'session-tie-a',
        projectPath: '/repo/beta',
        updatedAt: 1_000,
        title: 'Alpha deploy',
        summary: 'Deploy beta',
        firstUserMessage: 'check beta deploy',
        sessionType: 'codex',
      }),
      makeSession({
        sessionId: 'session-recent',
        projectPath: '/repo/beta',
        updatedAt: 1_100,
        title: 'Newest session',
        firstUserMessage: 'latest visible work',
      }),
    ]),
  ]

  const terminalMeta: TerminalMeta[] = [
    makeTerminalMeta({
      terminalId: 'term-1',
      updatedAt: 1_500,
      provider: 'claude',
      sessionId: 'session-tie-z',
    }),
  ]

  it('returns canonical server-owned ordering with running metadata joined', async () => {
    const page = await querySessionDirectory({
      projects,
      terminalMeta,
      query: {
        priority: 'visible',
      },
    })

    expect(page.items.map((item) => item.sessionId)).toEqual([
      'session-recent',
      'session-tie-a',
      'session-tie-z',
      'session-search',
      'session-archived',
    ])
    expect(page.items.find((item) => item.sessionId === 'session-tie-z')).toMatchObject({
      sessionId: 'session-tie-z',
      isRunning: true,
      runningTerminalId: 'term-1',
    })
    expect(page.revision).toBe(1_500)
  })

  it('searches titles and snippets on the server and bounds snippet length', async () => {
    const page = await querySessionDirectory({
      projects,
      terminalMeta,
      query: {
        priority: 'visible',
        query: 'deploy',
      },
    })

    expect(page.items.map((item) => item.sessionId)).toEqual([
      'session-tie-a',
      'session-tie-z',
      'session-search',
      'session-archived',
    ])
    expect(page.items.every((item) => (item.snippet?.length ?? 0) <= 140)).toBe(true)
    expect(page.items[0]?.snippet?.toLowerCase()).toContain('deploy')
    expect(page.items[2]?.snippet?.toLowerCase()).toContain('deploy')
  })

  it('bounds page size and provides a deterministic cursor window', async () => {
    const firstPage = await querySessionDirectory({
      projects,
      terminalMeta,
      query: {
        priority: 'visible',
        limit: 2,
      },
    })

    expect(firstPage.items.map((item) => item.sessionId)).toEqual([
      'session-recent',
      'session-tie-a',
    ])
    expect(firstPage.nextCursor).toBeTruthy()

    const secondPage = await querySessionDirectory({
      projects,
      terminalMeta,
      query: {
        priority: 'visible',
        limit: 2,
        cursor: firstPage.nextCursor ?? undefined,
      },
    })

    expect(secondPage.items.map((item) => item.sessionId)).toEqual([
      'session-tie-z',
      'session-search',
    ])
  })

  it('rejects invalid cursors deterministically', async () => {
    await expect(querySessionDirectory({
      projects,
      terminalMeta,
      query: {
        priority: 'visible',
        cursor: 'not-a-valid-cursor',
      },
    })).rejects.toThrow(/invalid session-directory cursor/i)
  })

  it('caps page size at 50 even when a larger limit is requested', async () => {
    const manyProjects: ProjectGroup[] = [
      makeProject('/repo/many', Array.from({ length: 75 }, (_, index) => makeSession({
        sessionId: `session-${index}`,
        projectPath: '/repo/many',
        updatedAt: 5_000 - index,
      }))),
    ]

    const page = await querySessionDirectory({
      projects: manyProjects,
      terminalMeta: [],
      query: {
        priority: 'background',
        limit: 75,
      },
    })

    expect(page.items).toHaveLength(50)
    expect(page.nextCursor).toBeTruthy()
  })
})
