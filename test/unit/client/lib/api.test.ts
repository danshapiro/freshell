import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  api,
  fetchSidebarSessionsSnapshot,
  getAgentTimelinePage,
  getAgentTurnBody,
  getBootstrap,
  getSessionDirectoryPage,
  getTerminalDirectoryPage,
  searchSessions,
  getTerminalScrollbackPage,
  getTerminalViewport,
  searchTerminalView,
  setSessionMetadata,
} from '@/lib/api'
import {
  SessionDirectoryQuerySchema,
  TerminalDirectoryQuerySchema,
} from '@shared/read-models'

const mockFetch = vi.fn()
global.fetch = mockFetch

function mockJson(value: unknown) {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(value)),
  }
}

describe('visible-first read-model helpers', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    localStorage.setItem('freshell.auth-token', 'test-token')
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('getBootstrap targets only /api/bootstrap', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({ shell: { authenticated: true } }))

    await getBootstrap()

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/bootstrap',
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    )
  })

  it('getSessionDirectoryPage encodes query, cursor, priority, revision, and limit while forwarding AbortSignal', async () => {
    const signal = new AbortController().signal
    mockFetch.mockResolvedValueOnce(mockJson({ items: [] }))

    await getSessionDirectoryPage(
      {
        query: 'alpha',
        cursor: 'cursor-1',
        priority: 'visible',
        revision: 4,
        limit: 10,
      },
      { signal },
    )

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/session-directory?query=alpha&cursor=cursor-1&priority=visible&revision=4&limit=10',
      expect.objectContaining({
        signal,
        headers: expect.any(Headers),
      }),
    )
  })

  it('getTerminalDirectoryPage encodes cursor, priority, revision, and limit consistently', async () => {
    const signal = new AbortController().signal
    mockFetch.mockResolvedValueOnce(mockJson({ items: [] }))

    await getTerminalDirectoryPage(
      {
        cursor: 'cursor-2',
        priority: 'background',
        revision: 6,
        limit: 5,
      },
      { signal },
    )

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/terminals?cursor=cursor-2&priority=background&revision=6&limit=5',
      expect.objectContaining({
        signal,
        headers: expect.any(Headers),
      }),
    )
  })

  it('agent chat helpers target only the new route family and forward AbortSignal', async () => {
    const signal = new AbortController().signal
    mockFetch
      .mockResolvedValueOnce(mockJson({ items: [], nextCursor: null }))
      .mockResolvedValueOnce(mockJson({ turnId: 'turn-1', body: [] }))

    await getAgentTimelinePage('session-1', { cursor: 'page-2', limit: 20 }, { signal })
    await getAgentTurnBody('session-1', 'turn-1', { signal })

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      '/api/agent-sessions/session-1/timeline?cursor=page-2&limit=20',
      expect.objectContaining({
        signal,
        headers: expect.any(Headers),
      }),
    )
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      '/api/agent-sessions/session-1/turns/turn-1',
      expect.objectContaining({
        signal,
        headers: expect.any(Headers),
      }),
    )
  })

  it('terminal view helpers target only viewport, scrollback, and search routes while forwarding AbortSignal', async () => {
    const signal = new AbortController().signal
    mockFetch
      .mockResolvedValueOnce(mockJson({ terminalId: 'term-1' }))
      .mockResolvedValueOnce(mockJson({ items: [] }))
      .mockResolvedValueOnce(mockJson({ matches: [] }))

    await getTerminalViewport('term-1', { signal })
    await getTerminalScrollbackPage('term-1', { cursor: 'line-100', limit: 50 }, { signal })
    await searchTerminalView('term-1', { query: 'error', cursor: 'hit-2', limit: 25 }, { signal })

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      '/api/terminals/term-1/viewport',
      expect.objectContaining({
        signal,
        headers: expect.any(Headers),
      }),
    )
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      '/api/terminals/term-1/scrollback?cursor=line-100&limit=50',
      expect.objectContaining({
        signal,
        headers: expect.any(Headers),
      }),
    )
    expect(mockFetch).toHaveBeenNthCalledWith(
      3,
      '/api/terminals/term-1/search?query=error&cursor=hit-2&limit=25',
      expect.objectContaining({
        signal,
        headers: expect.any(Headers),
      }),
    )
  })

  it('keeps critical out of public client directory query schemas', () => {
    expect(() =>
      SessionDirectoryQuerySchema.parse({
        priority: 'critical',
      }),
    ).toThrow()

    expect(() =>
      TerminalDirectoryQuerySchema.parse({
        priority: 'critical',
      }),
    ).toThrow()
  })

  it('preserves sidebar visibility metadata when grouping session-directory items', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [{
        sessionId: 'session-1',
        provider: 'codex',
        projectPath: '/tmp/project-alpha',
        title: 'Hidden session',
        sessionType: 'codex',
        firstUserMessage: '__AUTO__ worktree cleanup',
        isSubagent: true,
        isNonInteractive: true,
        isRunning: false,
        lastActivityAt: 1_000,
      }],
      nextCursor: null,
      revision: 1,
    }))

    const response = await fetchSidebarSessionsSnapshot()

    expect(response.projects).toEqual([
      expect.objectContaining({
        projectPath: '/tmp/project-alpha',
        sessions: [
          expect.objectContaining({
            sessionId: 'session-1',
            lastActivityAt: 1_000,
            sessionType: 'codex',
            firstUserMessage: '__AUTO__ worktree cleanup',
            isSubagent: true,
            isNonInteractive: true,
          }),
        ],
      }),
    ])
  })

  it('encodes session-directory cursors with lastActivityAt', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [],
      nextCursor: null,
      revision: 0,
    }))

    await fetchSidebarSessionsSnapshot({
      before: 1_000,
      beforeId: 'codex:session-1',
    })

    const requestUrl = mockFetch.mock.calls[0]?.[0] as string
    const cursor = new URL(`http://localhost${requestUrl}`).searchParams.get('cursor')
    expect(cursor).toBeTruthy()
    expect(JSON.parse(Buffer.from(cursor!, 'base64url').toString('utf8'))).toEqual({
      lastActivityAt: 1_000,
      key: 'codex:session-1',
    })
  })

  it('preserves search visibility metadata from session-directory items', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [{
        sessionId: 'session-2',
        provider: 'codex',
        projectPath: '/tmp/project-beta',
        title: 'Queued session',
        matchedIn: 'title',
        sessionType: 'codex',
        firstUserMessage: 'queued task',
        isSubagent: false,
        isNonInteractive: true,
        isRunning: false,
        lastActivityAt: 2_000,
      }],
      nextCursor: null,
      revision: 2,
    }))

    const response = await searchSessions({ query: 'queued' })

    expect(response.results).toEqual([
      expect.objectContaining({
        sessionId: 'session-2',
        lastActivityAt: 2_000,
        sessionType: 'codex',
        firstUserMessage: 'queued task',
        isSubagent: false,
        isNonInteractive: true,
      }),
    ])
  })
})

describe('searchSessions tier forwarding', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    localStorage.setItem('freshell.auth-token', 'test-token')
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('includes tier in session directory URL when not title', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [],
      nextCursor: null,
      revision: 0,
    }))

    await searchSessions({ query: 'test', tier: 'fullText' })

    const requestUrl = mockFetch.mock.calls[0]?.[0] as string
    expect(requestUrl).toContain('tier=fullText')
  })

  it('omits tier from URL when tier is title (the default)', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [],
      nextCursor: null,
      revision: 0,
    }))

    await searchSessions({ query: 'test', tier: 'title' })

    const requestUrl = mockFetch.mock.calls[0]?.[0] as string
    expect(requestUrl).not.toContain('tier=')
  })

  it('defaults tier to title when not specified', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [],
      nextCursor: null,
      revision: 0,
    }))

    await searchSessions({ query: 'test' })

    const requestUrl = mockFetch.mock.calls[0]?.[0] as string
    expect(requestUrl).not.toContain('tier=')
  })

  it('includes tier=userMessages in URL', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [],
      nextCursor: null,
      revision: 0,
    }))

    await searchSessions({ query: 'test', tier: 'userMessages' })

    const requestUrl = mockFetch.mock.calls[0]?.[0] as string
    expect(requestUrl).toContain('tier=userMessages')
  })

  it('forwards partial and partialReason from server response', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [{
        sessionId: 'session-1',
        provider: 'claude',
        projectPath: '/repo',
        title: 'Result',
        matchedIn: 'userMessage',
        snippet: 'found it',
        isRunning: false,
        lastActivityAt: 1000,
      }],
      nextCursor: null,
      revision: 1,
      partial: true,
      partialReason: 'budget',
    }))

    const response = await searchSessions({ query: 'test', tier: 'userMessages' })

    expect(response.partial).toBe(true)
    expect(response.partialReason).toBe('budget')
  })

  it('does not include partial fields when server omits them', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [],
      nextCursor: null,
      revision: 0,
    }))

    const response = await searchSessions({ query: 'test', tier: 'userMessages' })

    expect(response.partial).toBeUndefined()
    expect(response.partialReason).toBeUndefined()
  })
})

describe('setSessionMetadata()', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    localStorage.setItem('freshell.auth-token', 'test-token')
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('POSTs to /api/session-metadata with provider, sessionId, and sessionType', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(''),
    })

    await setSessionMetadata('claude', 'sess-abc', 'freshclaude')

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/session-metadata',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ provider: 'claude', sessionId: 'sess-abc', sessionType: 'freshclaude' }),
      }),
    )
  })

  it('sends auth token in headers', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(''),
    })

    await setSessionMetadata('claude', 'sess-abc', 'freshclaude')

    const call = mockFetch.mock.calls[0]
    const headers = call[1].headers as Headers
    expect(headers.get('x-auth-token')).toBe('test-token')
  })

  it('sets Content-Type to application/json', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(''),
    })

    await setSessionMetadata('claude', 'sess-abc', 'freshclaude')

    const call = mockFetch.mock.calls[0]
    const headers = call[1].headers as Headers
    expect(headers.get('Content-Type')).toBe('application/json')
  })
})

describe('api error mapping', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    localStorage.setItem('freshell.auth-token', 'test-token')
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('prefers agent-api message fields on error responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: () => Promise.resolve(JSON.stringify({ status: 'error', message: 'name required' })),
    })

    await expect(api.patch('/api/panes/pane-1', { name: '' })).rejects.toMatchObject({
      status: 400,
      message: 'name required',
    })
  })
})
