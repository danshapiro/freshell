import { describe, it, expect } from 'vitest'
import { createLogger, withLogContext } from '../../../server/logger'

function createCaptureLogger() {
  const entries: Record<string, unknown>[] = []
  const stream = {
    write(chunk: string) {
      const line = chunk.toString().trim()
      if (!line) return
      entries.push(JSON.parse(line))
    },
  }

  const log = createLogger(stream)

  return { log, entries }
}

describe('log context', () => {
  it('includes request context fields in log output', () => {
    const { log, entries } = createCaptureLogger()

    withLogContext(
      {
        requestId: 'req-123',
        requestPath: '/api/test',
        requestMethod: 'GET',
      },
      () => {
        log.info({ event: 'test_log' }, 'hello')
      },
    )

    expect(entries).toHaveLength(1)
    expect(entries[0].requestId).toBe('req-123')
    expect(entries[0].requestPath).toBe('/api/test')
    expect(entries[0].requestMethod).toBe('GET')
  })
})
