import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest'

// Mock fetch globally
const mockFetch = vi.fn()
global.fetch = mockFetch

import { api, searchSessions, setSessionMetadata, type SearchResponse } from '@/lib/api'

describe('searchSessions()', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    localStorage.setItem('freshell.auth-token', 'test-token')
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('calls /api/sessions/search with query', async () => {
    const mockResponse: SearchResponse = {
      results: [],
      tier: 'title',
      query: 'test',
      totalScanned: 0,
    }
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(mockResponse)),
    })

    await searchSessions({ query: 'test' })

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/sessions/search?q=test&tier=title',
      expect.objectContaining({
        headers: expect.any(Headers),
      })
    )
  })

  it('includes tier parameter', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ results: [], tier: 'fullText', query: 'test', totalScanned: 0 })),
    })

    await searchSessions({ query: 'test', tier: 'fullText' })

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/sessions/search?q=test&tier=fullText',
      expect.anything()
    )
  })

  it('includes limit parameter when provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ results: [], tier: 'title', query: 'test', totalScanned: 0 })),
    })

    await searchSessions({ query: 'test', limit: 10 })

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/sessions/search?q=test&tier=title&limit=10',
      expect.anything()
    )
  })

  it('returns search response', async () => {
    const mockResponse: SearchResponse = {
      results: [
        { sessionId: 'abc', provider: 'claude', projectPath: '/proj', matchedIn: 'title', updatedAt: 1000 },
      ],
      tier: 'title',
      query: 'test',
      totalScanned: 5,
    }
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(mockResponse)),
    })

    const result = await searchSessions({ query: 'test' })

    expect(result.results).toHaveLength(1)
    expect(result.results[0].sessionId).toBe('abc')
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
