import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  api,
  getAgentTimelinePage,
  getAgentTurnBody,
  getBootstrap,
  getSessionDirectoryPage,
  getTerminalDirectoryPage,
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
