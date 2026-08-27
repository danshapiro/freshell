import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  api,
  getFreshAgentModelCapabilities,
  refreshFreshAgentModelCapabilities,
  getFreshAgentThreadSnapshot,
  fetchSidebarSessionsSnapshot,
  getBootstrap,
  getSessionDirectoryPage,
  getTerminalDirectoryPage,
  searchSessions,
  searchTerminalView,
  setSessionMetadata,
} from '@/lib/api'
import {
  RestoreStaleRevisionResponseSchema,
  SessionDirectoryQuerySchema,
  TerminalDirectoryQuerySchema,
} from '@shared/read-models'
import {
  codexContractSnapshot,
} from '../../../fixtures/fresh-agent/codex/contract-fixtures.js'

const mockFetch = vi.fn()
global.fetch = mockFetch

function mockJson(value: unknown) {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(value)),
  }
}

function mockJsonResponse(status: number, value: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 503 ? 'Service Unavailable' : 'Error',
    text: () => Promise.resolve(JSON.stringify(value)),
  }
}

function mockResponseWithHeaders(status: number, value: unknown, headers: Record<string, string>) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'Too Many Requests',
    text: async () => JSON.stringify(value),
    headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
  })
}

function successCapabilityResponse(
  sessionType: string,
  runtimeProvider: 'claude' | 'codex' | 'opencode',
) {
  return {
    ok: true,
    sessionType,
    runtimeProvider,
    status: 'fresh',
    fetchedAt: 1_234,
    models: [
      {
        id: `${runtimeProvider}-opus`,
        displayName: `${runtimeProvider} Opus`,
        provider: runtimeProvider,
        supportsEffort: true,
        supportedEffortLevels: ['high'],
        supportsAdaptiveThinking: true,
      },
    ],
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

  it('preserves typed capability errors from non-2xx capability reads and refreshes', async () => {
    mockFetch
      .mockResolvedValueOnce(mockJsonResponse(503, {
        ok: false,
        sessionType: 'freshclaude',
        runtimeProvider: 'claude',
        status: 'unavailable',
        models: [],
        error: {
          code: 'CAPABILITY_PROBE_FAILED',
          message: 'Probe failed upstream',
          retryable: true,
        },
      }))
      .mockResolvedValueOnce(mockJsonResponse(503, {
        ok: false,
        sessionType: 'freshclaude',
        runtimeProvider: 'claude',
        status: 'unavailable',
        models: [],
        error: {
          code: 'CAPABILITY_PAYLOAD_INVALID',
          message: 'Capability payload invalid',
          retryable: false,
        },
      }))

    await expect(getFreshAgentModelCapabilities('freshclaude')).resolves.toEqual({
      ok: false,
      sessionType: 'freshclaude',
      runtimeProvider: 'claude',
      status: 'unavailable',
      models: [],
      error: {
        code: 'CAPABILITY_PROBE_FAILED',
        message: 'Probe failed upstream',
        retryable: true,
      },
    })
    await expect(refreshFreshAgentModelCapabilities('freshclaude')).resolves.toEqual({
      ok: false,
      sessionType: 'freshclaude',
      runtimeProvider: 'claude',
      status: 'unavailable',
      models: [],
      error: {
        code: 'CAPABILITY_PAYLOAD_INVALID',
        message: 'Capability payload invalid',
        retryable: false,
      },
    })
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      '/api/fresh-agent/model-capabilities/freshclaude',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      '/api/fresh-agent/model-capabilities/freshclaude/refresh',
      expect.objectContaining({
        method: 'POST',
        headers: expect.any(Headers),
      }),
    )
  })

  it('passes cwd when fetching Freshopencode model capabilities', async () => {
    mockFetch.mockResolvedValueOnce(mockJson(successCapabilityResponse('freshopencode', 'opencode')))

    await getFreshAgentModelCapabilities('freshopencode', { cwd: '/repo/project-a' })

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/fresh-agent/model-capabilities/freshopencode?cwd=%2Frepo%2Fproject-a',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
  })

  it('fresh-agent snapshot helper targets the fresh-agent route family and pins provider and revision', async () => {
    const signal = new AbortController().signal
    mockFetch.mockResolvedValueOnce(mockJson(codexContractSnapshot))

    await getFreshAgentThreadSnapshot('freshcodex', 'codex', 'thread-1', { revision: 7, cwd: '/repo/worktree', signal })

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      '/api/fresh-agent/threads/freshcodex/codex/thread-1?revision=7&cwd=%2Frepo%2Fworktree',
      expect.objectContaining({ signal, headers: expect.any(Headers) }),
    )
  })

  it('appends the snapshot trigger to the fresh-agent snapshot query when provided', async () => {
    mockFetch.mockResolvedValueOnce(mockJson(codexContractSnapshot))

    await getFreshAgentThreadSnapshot('freshcodex', 'codex', 'thread-1', { revision: 7, trigger: 'poll' })

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/fresh-agent/threads/freshcodex/codex/thread-1?revision=7&trigger=poll',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
  })

  it('shares the stale-revision error contract from read-models', () => {
    expect(RestoreStaleRevisionResponseSchema.parse({
      error: 'Stale restore revision',
      code: 'RESTORE_STALE_REVISION',
      currentRevision: 13,
    })).toEqual({
      error: 'Stale restore revision',
      code: 'RESTORE_STALE_REVISION',
      currentRevision: 13,
    })
  })

  it('terminal search helper forwards AbortSignal', async () => {
    const signal = new AbortController().signal
    mockFetch.mockResolvedValueOnce(mockJson({ matches: [] }))
    await searchTerminalView('term-1', { query: 'error', cursor: 'hit-2', limit: 25 }, { signal })

    expect(mockFetch).toHaveBeenCalledWith(
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

  it('STATUS-STRIP: forwards includeKeys and maps tokenUsage onto window sessions + extras', async () => {
    const usage = {
      inputTokens: 1,
      outputTokens: 1,
      cachedTokens: 0,
      totalTokens: 2,
      contextTokens: 96000,
      compactPercent: 47,
      compactThresholdTokens: 200000,
    }
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [{
        sessionId: 'session-windowed',
        provider: 'claude',
        projectPath: '/tmp/project-alpha',
        isRunning: false,
        lastActivityAt: 1_000,
        tokenUsage: usage,
      }],
      nextCursor: null,
      revision: 1,
      contextUsageExtras: [
        { provider: 'claude', sessionId: 'session-excluded', tokenUsage: usage },
      ],
    }))

    const response = await fetchSidebarSessionsSnapshot({ includeKeys: ['claude:session-excluded'] })

    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('includeKeys=claude%3Asession-excluded')
    expect(response.projects[0]?.sessions[0]?.tokenUsage).toEqual(usage)
    expect(response.contextUsageExtras).toEqual([
      { provider: 'claude', sessionId: 'session-excluded', tokenUsage: usage },
    ])
  })

  it('preserves a quarantined identity-collision state in sidebar snapshots', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [],
      nextCursor: null,
      revision: 1,
      partial: true,
      integrityError: {
        kind: 'identity_collision',
        collisionCount: 1,
        duplicateItemCount: 2,
      },
    }))

    const response = await fetchSidebarSessionsSnapshot()

    expect(response).toMatchObject({
      partial: true,
      integrityError: {
        kind: 'identity_collision',
        collisionCount: 1,
        duplicateItemCount: 2,
      },
    })
  })

  it('preserves session-directory running state in sidebar snapshots', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [{
        sessionId: 'codex-live-1',
        provider: 'codex',
        projectPath: '/repo/live',
        title: 'Live Codex',
        sessionType: 'codex',
        isRunning: true,
        runningTerminalId: 'term-codex-1',
        lastActivityAt: 1_700,
      }],
      nextCursor: null,
      revision: 1_700,
    }))

    const response = await fetchSidebarSessionsSnapshot()

    expect(response.projects[0].sessions[0]).toMatchObject({
      provider: 'codex',
      sessionId: 'codex-live-1',
      isRunning: true,
      runningTerminalId: 'term-codex-1',
    })
  })

  it('preserves live-terminal-only state in sidebar snapshots', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [{
        sessionId: 'terminal:term-opencode-live',
        provider: 'opencode',
        projectPath: '/repo/live',
        title: 'OpenCode',
        sessionType: 'opencode',
        isRunning: true,
        runningTerminalId: 'term-opencode-live',
        liveTerminalOnly: true,
        lastActivityAt: 1_700,
      }],
      nextCursor: null,
      revision: 1_700,
    }))

    const response = await fetchSidebarSessionsSnapshot()

    expect(response.projects[0].sessions[0]).toMatchObject({
      provider: 'opencode',
      sessionId: 'terminal:term-opencode-live',
      isRunning: true,
      runningTerminalId: 'term-opencode-live',
      liveTerminalOnly: true,
    })
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

  it('preserves session-directory running state in search results', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [{
        sessionId: 'ses_live_opencode',
        provider: 'opencode',
        projectPath: '/repo/live',
        title: 'Live OpenCode',
        matchedIn: 'title',
        isRunning: true,
        runningTerminalId: 'term-opencode-1',
        lastActivityAt: 1_800,
      }],
      nextCursor: null,
      revision: 1_800,
    }))

    const response = await searchSessions({ query: 'live', tier: 'title' })

    expect(response.results[0]).toMatchObject({
      provider: 'opencode',
      sessionId: 'ses_live_opencode',
      isRunning: true,
      runningTerminalId: 'term-opencode-1',
    })
  })

  it('preserves live-terminal-only state in search results', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [{
        sessionId: 'terminal:term-opencode-live',
        provider: 'opencode',
        projectPath: '/repo/live',
        title: 'OpenCode',
        matchedIn: 'title',
        isRunning: true,
        runningTerminalId: 'term-opencode-live',
        liveTerminalOnly: true,
        lastActivityAt: 1_800,
      }],
      nextCursor: null,
      revision: 1_800,
    }))

    const response = await searchSessions({ query: 'OpenCode', tier: 'title' })

    expect(response.results[0]).toMatchObject({
      provider: 'opencode',
      sessionId: 'terminal:term-opencode-live',
      isRunning: true,
      runningTerminalId: 'term-opencode-live',
      liveTerminalOnly: true,
    })
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

  it('forwards a quarantined identity-collision state without exposing session ids', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [],
      nextCursor: null,
      revision: 1,
      partial: true,
      integrityError: {
        kind: 'identity_collision',
        collisionCount: 2,
        duplicateItemCount: 4,
      },
    }))

    const response = await searchSessions({ query: 'test', tier: 'title' })

    expect(response).toMatchObject({
      partial: true,
      integrityError: {
        kind: 'identity_collision',
        collisionCount: 2,
        duplicateItemCount: 4,
      },
    })
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

describe('searchSessions cursor pagination', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    localStorage.setItem('freshell.auth-token', 'test-token')
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('surfaces nextCursor and hasMore=true when the server returns a non-null nextCursor', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [{
        sessionId: 'session-42',
        provider: 'claude',
        projectPath: '/repo',
        title: 'Match 42',
        matchedIn: 'title',
        isRunning: false,
        lastActivityAt: 4_200,
      }],
      nextCursor: 'cursor-page-2',
      revision: 7,
    }))

    const response = await searchSessions({ query: 'widget' })

    expect(response.nextCursor).toBe('cursor-page-2')
    expect(response.hasMore).toBe(true)
  })

  it('reports hasMore=false and a null nextCursor when the server has no further pages', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [],
      nextCursor: null,
      revision: 7,
    }))

    const response = await searchSessions({ query: 'widget' })

    expect(response.nextCursor).toBeNull()
    expect(response.hasMore).toBe(false)
  })

  it('forwards the cursor to the session-directory request when paginating a search', async () => {
    mockFetch.mockResolvedValueOnce(mockJson({
      items: [],
      nextCursor: null,
      revision: 7,
    }))

    await searchSessions({ query: 'widget', cursor: 'cursor-page-2' })

    const requestUrl = mockFetch.mock.calls[0]?.[0] as string
    expect(requestUrl).toContain('cursor=cursor-page-2')
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

  it('POSTs to /api/session-metadata with provider, sessionId, sessionType, and explicit source by default', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(''),
    })

    await setSessionMetadata('claude', 'sess-abc', 'freshclaude')

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/session-metadata',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          provider: 'claude',
          sessionId: 'sess-abc',
          sessionType: 'freshclaude',
          sessionTypeSource: 'explicit',
        }),
      }),
    )
  })

  it('POSTs materialized session metadata source when requested', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(''),
    })

    await setSessionMetadata('opencode', 'ses_real_1', 'freshopencode', {
      sessionTypeSource: 'materialized',
    })

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/session-metadata',
      expect.objectContaining({
        body: JSON.stringify({
          provider: 'opencode',
          sessionId: 'ses_real_1',
          sessionType: 'freshopencode',
          sessionTypeSource: 'materialized',
        }),
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

  it('carries retryAfterMs from a 429 Retry-After seconds header', async () => {
    mockResponseWithHeaders(429, { error: 'Too many requests' }, { 'retry-after': '17' })
    await expect(api.get('/api/fresh-agent/threads/freshopencode/opencode/ses_1')).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 17_000,
    })
  })

  it('leaves retryAfterMs undefined when the header is absent', async () => {
    mockResponseWithHeaders(429, { error: 'Too many requests' }, {})
    await expect(api.get('/api/x')).rejects.toMatchObject({ status: 429, retryAfterMs: undefined })
  })

  it('parses an HTTP-date Retry-After into a forward delta', async () => {
    const future = new Date(Date.now() + 30_000).toUTCString()
    mockResponseWithHeaders(429, { error: 'Too many requests' }, { 'retry-after': future })
    const err = await api.get('/api/x').catch((e) => e)
    expect(err.status).toBe(429)
    expect(err.retryAfterMs).toBeGreaterThan(20_000)
    expect(err.retryAfterMs).toBeLessThanOrEqual(31_000)
  })

  it('locks the delete contract the failure-surfacing UI relies on: a 404 JSON body rejects as an ApiError', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse(404, { error: 'Not found' }))

    await expect(api.delete('/api/sessions/claude%3Amissing')).rejects.toMatchObject({
      status: 404,
      message: 'Not found',
    })
  })
})
