// @vitest-environment node
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import type { ProjectGroup, CodingCliSession } from '../../../../server/coding-cli/types.js'
import type { TerminalMeta } from '../../../../server/terminal-metadata-service.js'
import { querySessionDirectory } from '../../../../server/session-directory/service.js'
import { claudeProvider } from '../../../../server/coding-cli/providers/claude.js'
import { codexProvider } from '../../../../server/coding-cli/providers/codex.js'

function makeSession(overrides: Partial<CodingCliSession> & Pick<CodingCliSession, 'sessionId' | 'projectPath' | 'lastActivityAt'>): CodingCliSession {
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
        lastActivityAt: 400,
        archived: true,
        title: 'Old archived session',
        summary: 'Archived deploy history',
      }),
      makeSession({
        sessionId: 'session-tie-z',
        projectPath: '/repo/alpha',
        lastActivityAt: 1_000,
        title: 'Zulu deploy',
        summary: 'Deploy summary',
        firstUserMessage: 'deploy alpha service',
        sessionType: 'claude',
      }),
      makeSession({
        sessionId: 'session-search',
        projectPath: '/repo/alpha',
        lastActivityAt: 900,
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
        lastActivityAt: 1_000,
        title: 'Alpha deploy',
        summary: 'Deploy beta',
        firstUserMessage: 'check beta deploy',
        sessionType: 'codex',
      }),
      makeSession({
        sessionId: 'session-recent',
        projectPath: '/repo/beta',
        lastActivityAt: 1_100,
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
    expect(JSON.parse(Buffer.from(firstPage.nextCursor!, 'base64url').toString('utf8'))).toEqual({
      lastActivityAt: 1_000,
      key: 'codex:session-tie-a',
    })

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
        lastActivityAt: 5_000 - index,
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

describe('querySessionDirectory file-based search', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'session-dir-search-'))
  })

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  it('userMessages tier finds matches in user messages only', async () => {
    const sessionFile = path.join(tempDir, 'session-1.jsonl')
    await fsp.writeFile(sessionFile, [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Fix the authentication bug"}]}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Working on the login system"}]}}',
    ].join('\n'))

    const projects = [makeProject('/repo', [
      makeSession({
        sessionId: 'session-1',
        projectPath: '/repo',
        lastActivityAt: 1000,
        title: 'Some title',
        sourceFile: sessionFile,
      }),
    ])]

    const page = await querySessionDirectory({
      projects,
      terminalMeta: [],
      providers: [claudeProvider],
      query: { priority: 'visible', query: 'authentication', tier: 'userMessages' },
    })

    expect(page.items).toHaveLength(1)
    expect(page.items[0].matchedIn).toBe('userMessage')
    expect(page.items[0].snippet).toContain('authentication')
  })

  it('userMessages tier does NOT match assistant messages', async () => {
    const sessionFile = path.join(tempDir, 'session-1.jsonl')
    await fsp.writeFile(sessionFile, [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello"}]}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The authentication system is broken"}]}}',
    ].join('\n'))

    const projects = [makeProject('/repo', [
      makeSession({
        sessionId: 'session-1',
        projectPath: '/repo',
        lastActivityAt: 1000,
        title: 'Some title',
        sourceFile: sessionFile,
      }),
    ])]

    const page = await querySessionDirectory({
      projects,
      terminalMeta: [],
      providers: [claudeProvider],
      query: { priority: 'visible', query: 'authentication', tier: 'userMessages' },
    })

    expect(page.items).toHaveLength(0)
  })

  it('fullText tier finds matches in assistant messages', async () => {
    const sessionFile = path.join(tempDir, 'session-1.jsonl')
    await fsp.writeFile(sessionFile, [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello"}]}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The authentication system is broken"}]}}',
    ].join('\n'))

    const projects = [makeProject('/repo', [
      makeSession({
        sessionId: 'session-1',
        projectPath: '/repo',
        lastActivityAt: 1000,
        title: 'Some title',
        sourceFile: sessionFile,
      }),
    ])]

    const page = await querySessionDirectory({
      projects,
      terminalMeta: [],
      providers: [claudeProvider],
      query: { priority: 'visible', query: 'authentication', tier: 'fullText' },
    })

    expect(page.items).toHaveLength(1)
    expect(page.items[0].matchedIn).toBe('assistantMessage')
  })

  it('title tier still works without file I/O (does not require providers)', async () => {
    const projects = [makeProject('/repo', [
      makeSession({
        sessionId: 'session-1',
        projectPath: '/repo',
        lastActivityAt: 1000,
        title: 'Deploy pipeline fix',
      }),
    ])]

    const page = await querySessionDirectory({
      projects,
      terminalMeta: [],
      query: { priority: 'visible', query: 'deploy', tier: 'title' },
    })

    expect(page.items).toHaveLength(1)
    expect(page.items[0].matchedIn).toBe('title')
  })

  it('file-based search skips sessions without sourceFile', async () => {
    const projects = [makeProject('/repo', [
      makeSession({
        sessionId: 'session-no-file',
        projectPath: '/repo',
        lastActivityAt: 1000,
        title: 'No source file',
      }),
    ])]

    const page = await querySessionDirectory({
      projects,
      terminalMeta: [],
      providers: [claudeProvider],
      query: { priority: 'visible', query: 'anything', tier: 'userMessages' },
    })

    expect(page.items).toHaveLength(0)
  })

  it('file-based search handles missing files gracefully', async () => {
    const projects = [makeProject('/repo', [
      makeSession({
        sessionId: 'session-missing',
        projectPath: '/repo',
        lastActivityAt: 1000,
        title: 'Missing file',
        sourceFile: '/nonexistent/path.jsonl',
      }),
    ])]

    const page = await querySessionDirectory({
      projects,
      terminalMeta: [],
      providers: [claudeProvider],
      query: { priority: 'visible', query: 'anything', tier: 'fullText' },
    })

    expect(page.items).toHaveLength(0)
    // No throw -- graceful handling
  })

  it('file-based search respects abort signals', async () => {
    const sessionFile = path.join(tempDir, 'session-1.jsonl')
    await fsp.writeFile(sessionFile, '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello"}]}}\n')

    const controller = new AbortController()
    controller.abort()

    const projects = [makeProject('/repo', [
      makeSession({
        sessionId: 'session-1',
        projectPath: '/repo',
        lastActivityAt: 1000,
        title: 'Some title',
        sourceFile: sessionFile,
      }),
    ])]

    await expect(querySessionDirectory({
      projects,
      terminalMeta: [],
      providers: [claudeProvider],
      query: { priority: 'visible', query: 'Hello', tier: 'userMessages' },
      signal: controller.signal,
    })).rejects.toThrow(/aborted/i)
  })

  it('file-based search respects page limit for results', async () => {
    // Create multiple sessions, each matching
    for (let i = 0; i < 5; i++) {
      await fsp.writeFile(
        path.join(tempDir, `session-${i}.jsonl`),
        `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"needle match ${i}"}]}}\n`
      )
    }

    const sessions = Array.from({ length: 5 }, (_, i) => makeSession({
      sessionId: `session-${i}`,
      projectPath: '/repo',
      lastActivityAt: 5000 - i,
      title: `Session ${i}`,
      sourceFile: path.join(tempDir, `session-${i}.jsonl`),
    }))

    const page = await querySessionDirectory({
      projects: [makeProject('/repo', sessions)],
      terminalMeta: [],
      providers: [claudeProvider],
      query: { priority: 'visible', query: 'needle', tier: 'userMessages', limit: 2 },
    })

    expect(page.items).toHaveLength(2)
    expect(page.nextCursor).toBeTruthy()
  })

  it('sort order is preserved for file-based search results', async () => {
    // Create 3 sessions with different timestamps, one archived
    for (const id of ['a', 'b', 'c']) {
      await fsp.writeFile(
        path.join(tempDir, `session-${id}.jsonl`),
        `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"deploy fix"}]}}\n`
      )
    }

    const projects = [makeProject('/repo', [
      makeSession({
        sessionId: 'session-a',
        projectPath: '/repo',
        lastActivityAt: 3000,
        title: 'Session A',
        sourceFile: path.join(tempDir, 'session-a.jsonl'),
      }),
      makeSession({
        sessionId: 'session-b',
        projectPath: '/repo',
        lastActivityAt: 2000,
        title: 'Session B',
        sourceFile: path.join(tempDir, 'session-b.jsonl'),
        archived: true,
      }),
      makeSession({
        sessionId: 'session-c',
        projectPath: '/repo',
        lastActivityAt: 1000,
        title: 'Session C',
        sourceFile: path.join(tempDir, 'session-c.jsonl'),
      }),
    ])]

    const page = await querySessionDirectory({
      projects,
      terminalMeta: [],
      providers: [claudeProvider],
      query: { priority: 'visible', query: 'deploy', tier: 'userMessages' },
    })

    // Non-archived by recency desc, then archived by recency desc
    expect(page.items.map((item) => item.sessionId)).toEqual([
      'session-a',
      'session-c',
      'session-b',
    ])
  })

  it('file-based search with Codex provider finds user messages', async () => {
    const sessionFile = path.join(tempDir, 'codex-session.jsonl')
    // Codex format: response_item with message payload
    await fsp.writeFile(sessionFile, [
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"auth bug fix"}]}}',
    ].join('\n'))

    const projects = [makeProject('/repo', [
      makeSession({
        provider: 'codex',
        sessionId: 'codex-session',
        projectPath: '/repo',
        lastActivityAt: 1000,
        title: 'Codex session',
        sourceFile: sessionFile,
      }),
    ])]

    const page = await querySessionDirectory({
      projects,
      terminalMeta: [],
      providers: [codexProvider],
      query: { priority: 'visible', query: 'auth bug', tier: 'userMessages' },
    })

    expect(page.items).toHaveLength(1)
    expect(page.items[0].matchedIn).toBe('userMessage')
  })

  it('file-based search skips sessions with unknown provider', async () => {
    const sessionFile = path.join(tempDir, 'unknown-session.jsonl')
    await fsp.writeFile(sessionFile, '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"test content"}]}}\n')

    const projects = [makeProject('/repo', [
      makeSession({
        provider: 'unknown-cli' as any,
        sessionId: 'unknown-session',
        projectPath: '/repo',
        lastActivityAt: 1000,
        title: 'Unknown provider session',
        sourceFile: sessionFile,
      }),
    ])]

    const page = await querySessionDirectory({
      projects,
      terminalMeta: [],
      providers: [claudeProvider],
      query: { priority: 'visible', query: 'test content', tier: 'userMessages' },
    })

    expect(page.items).toHaveLength(0)
  })

  it('fullText tier prefers user message match over assistant when both contain the term', async () => {
    const sessionFile = path.join(tempDir, 'session-both.jsonl')
    await fsp.writeFile(sessionFile, [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"deploy the service"}]}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I will deploy it now"}]}}',
    ].join('\n'))

    const projects = [makeProject('/repo', [
      makeSession({
        sessionId: 'session-both',
        projectPath: '/repo',
        lastActivityAt: 1000,
        title: 'Some title',
        sourceFile: sessionFile,
      }),
    ])]

    const page = await querySessionDirectory({
      projects,
      terminalMeta: [],
      providers: [claudeProvider],
      query: { priority: 'visible', query: 'deploy', tier: 'fullText' },
    })

    expect(page.items).toHaveLength(1)
    // User message comes first in the file, so first hit is user message
    expect(page.items[0].matchedIn).toBe('userMessage')
  })

  it('reports partial with partialReason budget when scan budget is exhausted', async () => {
    // Create 25 sessions: only the last one (session-024) contains "needle".
    // With limit=2, maxScan = 2*10 = 20. We'll scan 20 sessions, none matching,
    // then hit the budget before reaching session-024.
    for (let i = 0; i < 25; i++) {
      const text = i === 24 ? 'needle here' : `unrelated content ${i}`
      await fsp.writeFile(
        path.join(tempDir, `session-${i}.jsonl`),
        `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"${text}"}]}}\n`
      )
    }

    const sessions = Array.from({ length: 25 }, (_, i) => makeSession({
      sessionId: `session-${String(i).padStart(3, '0')}`,
      projectPath: '/repo',
      lastActivityAt: 25000 - i,
      title: `Session ${i}`,
      sourceFile: path.join(tempDir, `session-${i}.jsonl`),
    }))

    const page = await querySessionDirectory({
      projects: [makeProject('/repo', sessions)],
      terminalMeta: [],
      providers: [claudeProvider],
      query: { priority: 'visible', query: 'needle', tier: 'userMessages', limit: 2 },
    })

    // The match is at position 24, but scan budget is 20, so it's never reached
    expect(page.items).toHaveLength(0)
    expect(page.partial).toBe(true)
    expect(page.partialReason).toBe('budget')
  })

  it('reports partial with partialReason io_error when file reads fail', async () => {
    const goodFile = path.join(tempDir, 'good.jsonl')
    await fsp.writeFile(goodFile, '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"needle here"}]}}\n')

    const projects = [makeProject('/repo', [
      makeSession({
        sessionId: 'session-bad',
        projectPath: '/repo',
        lastActivityAt: 2000,
        title: 'Bad file session',
        sourceFile: '/nonexistent/path.jsonl',
      }),
      makeSession({
        sessionId: 'session-good',
        projectPath: '/repo',
        lastActivityAt: 1000,
        title: 'Good file session',
        sourceFile: goodFile,
      }),
    ])]

    const page = await querySessionDirectory({
      projects,
      terminalMeta: [],
      providers: [claudeProvider],
      query: { priority: 'visible', query: 'needle', tier: 'userMessages' },
    })

    // The good session should still be found
    expect(page.items).toHaveLength(1)
    expect(page.items[0].sessionId).toBe('session-good')
    expect(page.partial).toBe(true)
    expect(page.partialReason).toBe('io_error')
  })

  it('does not report partial when all files are scanned without errors within budget', async () => {
    const sessionFile = path.join(tempDir, 'session-1.jsonl')
    await fsp.writeFile(sessionFile, '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"needle"}]}}\n')

    const projects = [makeProject('/repo', [
      makeSession({
        sessionId: 'session-1',
        projectPath: '/repo',
        lastActivityAt: 1000,
        title: 'Some title',
        sourceFile: sessionFile,
      }),
    ])]

    const page = await querySessionDirectory({
      projects,
      terminalMeta: [],
      providers: [claudeProvider],
      query: { priority: 'visible', query: 'needle', tier: 'userMessages' },
    })

    expect(page.items).toHaveLength(1)
    expect(page.partial).toBeUndefined()
    expect(page.partialReason).toBeUndefined()
  })

  it('propagates abort signal into file streaming within searchSessionFile', async () => {
    // Create a file with content that would match
    const sessionFile = path.join(tempDir, 'session-abort.jsonl')
    // Write many lines to make the file large enough that streaming takes time
    const lines = Array.from({ length: 100 }, (_, i) =>
      `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"line ${i} padding content to make file bigger"}]}}`
    )
    // Put the match at the end so the signal should be checked before reaching it
    lines.push('{"type":"user","message":{"role":"user","content":[{"type":"text","text":"needle at end"}]}}')
    await fsp.writeFile(sessionFile, lines.join('\n'))

    // Create a controller that aborts mid-scan
    const controller = new AbortController()

    const projects = [makeProject('/repo', [
      makeSession({
        sessionId: 'session-abort',
        projectPath: '/repo',
        lastActivityAt: 1000,
        title: 'Abort test',
        sourceFile: sessionFile,
      }),
    ])]

    // Abort after a microtask to allow search to start but not finish
    const abortPromise = Promise.resolve().then(() => controller.abort())

    const resultPromise = querySessionDirectory({
      projects,
      terminalMeta: [],
      providers: [claudeProvider],
      query: { priority: 'visible', query: 'needle at end', tier: 'userMessages' },
      signal: controller.signal,
    })

    await abortPromise

    // Should reject with abort or return partial results (not hang)
    await expect(resultPromise).rejects.toThrow(/aborted/i)
  })

  it('title-tier search completes quickly for many sessions (performance guard)', async () => {
    const sessions = Array.from({ length: 1000 }, (_, i) => makeSession({
      sessionId: `session-${i}`,
      projectPath: '/repo',
      lastActivityAt: 10000 - i,
      title: i % 10 === 0 ? `Deploy session ${i}` : `Other session ${i}`,
    }))

    const start = performance.now()
    const page = await querySessionDirectory({
      projects: [makeProject('/repo', sessions)],
      terminalMeta: [],
      query: { priority: 'visible', query: 'deploy', tier: 'title' },
    })
    const elapsed = performance.now() - start

    expect(page.items.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(50)
  })
})
