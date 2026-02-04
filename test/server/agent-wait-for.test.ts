import { describe, it, expect } from 'vitest'
import { waitForMatch } from '../../server/agent-api/wait-for'

describe('waitForMatch', () => {
  it('resolves when pattern appears', async () => {
    let snapshot = 'booting...'
    const promise = waitForMatch(() => snapshot, /ready/, { timeoutMs: 200 })
    snapshot = 'ready'
    await expect(promise).resolves.toEqual({ matched: true })
  })
})
