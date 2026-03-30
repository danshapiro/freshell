// Verify that rate-limit retry backoff outlasts the server's rate window
import { describe, it, expect } from 'vitest'
import {
  RATE_LIMIT_RETRY_MAX_ATTEMPTS,
  RATE_LIMIT_RETRY_BASE_MS,
  RATE_LIMIT_RETRY_MAX_MS,
} from '@/components/TerminalView'

const SERVER_RATE_WINDOW_MS = 10_000

describe('rate-limit retry backoff', () => {
  it('total retry span exceeds the server rate-limit window', () => {
    let totalDelayMs = 0
    for (let i = 1; i <= RATE_LIMIT_RETRY_MAX_ATTEMPTS; i++) {
      totalDelayMs += Math.min(
        RATE_LIMIT_RETRY_BASE_MS * (2 ** (i - 1)),
        RATE_LIMIT_RETRY_MAX_MS
      )
    }
    expect(totalDelayMs).toBeGreaterThan(SERVER_RATE_WINDOW_MS)
  })

  it('at least one retry fires after the rate-limit window expires', () => {
    let cumulativeMs = 0
    let retriesAfterWindow = 0
    for (let i = 1; i <= RATE_LIMIT_RETRY_MAX_ATTEMPTS; i++) {
      cumulativeMs += Math.min(
        RATE_LIMIT_RETRY_BASE_MS * (2 ** (i - 1)),
        RATE_LIMIT_RETRY_MAX_MS
      )
      if (cumulativeMs > SERVER_RATE_WINDOW_MS) retriesAfterWindow++
    }
    expect(retriesAfterWindow).toBeGreaterThanOrEqual(1)
  })
})
