import { describe, it, expect } from 'vitest'
import { ok, approx, ignored, fail } from '../../../server/agent-api/response'

describe('agent response helpers', () => {
  it('builds ok/approx/ignored/error responses', () => {
    expect(ok({ value: 1 }, 'done')).toEqual({ status: 'ok', message: 'done', data: { value: 1 } })
    expect(approx({ value: 2 }, 'used fallback').status).toBe('approx')
    expect(ignored('noop').status).toBe('ignored')
    expect(fail('bad').status).toBe('error')
  })
})
