import { describe, it, expect } from 'vitest'
import { ApiError, NetworkError, isTransientRequestFailure } from '@/lib/api'

describe('isTransientRequestFailure', () => {
  it('treats a NetworkError (transport failure from request()) as transient', () => {
    expect(isTransientRequestFailure(new NetworkError('Failed to reach the server'))).toBe(true)
  })

  it('treats an aborted request as transient', () => {
    expect(isTransientRequestFailure(new DOMException('aborted', 'AbortError'))).toBe(true)
  })

  it('treats gateway-unavailable HTTP statuses (502/503/504) as transient', () => {
    expect(isTransientRequestFailure(new ApiError(502, 'Bad Gateway'))).toBe(true)
    expect(isTransientRequestFailure(new ApiError(503, 'Service Unavailable'))).toBe(true)
    expect(isTransientRequestFailure(new ApiError(504, 'Gateway Timeout'))).toBe(true)
  })

  it('does NOT treat an application HTTP error (500/404/401) as transient', () => {
    expect(isTransientRequestFailure(new ApiError(500, 'Internal Server Error'))).toBe(false)
    expect(isTransientRequestFailure(new ApiError(404, 'Not Found'))).toBe(false)
    expect(isTransientRequestFailure(new ApiError(401, 'Unauthorized'))).toBe(false)
  })

  it('does NOT treat a bare TypeError as transient (it is a real bug, must surface)', () => {
    // Regression guard: previously any TypeError was classified transient, which
    // silently swallowed null-derefs while processing a *successful* response.
    expect(isTransientRequestFailure(new TypeError('Cannot read properties of null'))).toBe(false)
    expect(isTransientRequestFailure(new TypeError('Failed to fetch'))).toBe(false)
  })

  it('does NOT treat a generic Error or unknown values as transient', () => {
    expect(isTransientRequestFailure(new Error('boom'))).toBe(false)
    expect(isTransientRequestFailure('nope')).toBe(false)
    expect(isTransientRequestFailure(undefined)).toBe(false)
    expect(isTransientRequestFailure(null)).toBe(false)
    expect(isTransientRequestFailure({ status: 503 })).toBe(false)
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

  it('serializes message via JSON.stringify despite Error.message being non-enumerable', () => {
    const err = new ApiError(403, 'Forbidden', { reason: 'nope' })
    const round = JSON.parse(JSON.stringify(err))
    expect(round).toEqual({ name: 'ApiError', status: 403, message: 'Forbidden', details: { reason: 'nope' } })
  })
})

describe('NetworkError', () => {
  it('is a real Error and preserves the underlying cause', () => {
    const cause = new TypeError('Failed to fetch')
    const err = new NetworkError('Failed to reach the server', cause)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('NetworkError')
    expect(err.message).toBe('Failed to reach the server')
    expect(err.cause).toBe(cause)
  })
})
