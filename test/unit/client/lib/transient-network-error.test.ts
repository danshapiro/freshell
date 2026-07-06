import { describe, it, expect } from 'vitest'
import { ApiError, isTransientNetworkError } from '@/lib/api'

describe('isTransientNetworkError', () => {
  it('treats a fetch network failure (TypeError) as transient', () => {
    // fetch() rejects with a TypeError when the request never reaches the server.
    expect(isTransientNetworkError(new TypeError('Failed to fetch'))).toBe(true)
  })

  it('classifies by type, not by engine-specific message text', () => {
    // Chromium: "Failed to fetch"; Firefox: "NetworkError..."; WebKit: "Load failed".
    expect(isTransientNetworkError(new TypeError('NetworkError when attempting to fetch resource'))).toBe(true)
    expect(isTransientNetworkError(new TypeError('Load failed'))).toBe(true)
  })

  it('treats an aborted request as transient', () => {
    expect(isTransientNetworkError(new DOMException('The operation was aborted.', 'AbortError'))).toBe(true)
  })

  it('does NOT treat an HTTP ApiError (the server responded) as transient', () => {
    expect(isTransientNetworkError(new ApiError(503, 'Service Unavailable'))).toBe(false)
    expect(isTransientNetworkError(new ApiError(500, 'Internal Server Error'))).toBe(false)
  })

  it('does NOT treat a generic Error as transient', () => {
    expect(isTransientNetworkError(new Error('boom'))).toBe(false)
  })

  it('does NOT treat unknown / non-error values as transient', () => {
    expect(isTransientNetworkError('nope')).toBe(false)
    expect(isTransientNetworkError(undefined)).toBe(false)
    expect(isTransientNetworkError(null)).toBe(false)
    expect(isTransientNetworkError({ status: 500 })).toBe(false)
  })
})

describe('ApiError', () => {
  it('is a real Error carrying status/message/details', () => {
    const err = new ApiError(404, 'Not Found', { path: '/x' })
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('ApiError')
    expect(err.status).toBe(404)
    expect(err.message).toBe('Not Found')
    expect(err.details).toEqual({ path: '/x' })
  })

  it('stringifies to a readable message (never "[object Object]")', () => {
    const err = new ApiError(500, 'Internal Server Error')
    expect(String(err)).toContain('Internal Server Error')
    expect(String(err)).not.toContain('[object Object]')
  })
})
