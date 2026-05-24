import { EventEmitter } from 'events'
import { describe, expect, it } from 'vitest'
import { createRequestAbortSignal } from '../../../../server/read-models/request-abort.js'

function createMockRequestResponse() {
  const req = new EventEmitter()
  const res = new EventEmitter()
  return { req, res }
}

describe('createRequestAbortSignal', () => {
  it('does not abort on the request close event emitted during normal request completion', () => {
    const { req, res } = createMockRequestResponse()
    const signal = createRequestAbortSignal(req as any, res as any)

    req.emit('close')

    expect(signal.aborted).toBe(false)
  })

  it('aborts when the client aborts the request before response finish', () => {
    const { req, res } = createMockRequestResponse()
    const signal = createRequestAbortSignal(req as any, res as any)

    req.emit('aborted')

    expect(signal.aborted).toBe(true)
  })

  it('does not abort on response close because finite read-model routes can see it before finish', () => {
    const { req, res } = createMockRequestResponse()
    const signal = createRequestAbortSignal(req as any, res as any)

    res.emit('close')

    expect(signal.aborted).toBe(false)
  })

  it('keeps ignoring response close after the response finishes', () => {
    const { req, res } = createMockRequestResponse()
    const signal = createRequestAbortSignal(req as any, res as any)

    res.emit('finish')
    res.emit('close')

    expect(signal.aborted).toBe(false)
  })
})
