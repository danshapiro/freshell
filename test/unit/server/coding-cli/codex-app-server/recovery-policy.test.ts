import { describe, expect, it } from 'vitest'
import { CodexRecoveryPolicy } from '../../../../../server/coding-cli/codex-app-server/recovery-policy.js'

describe('CodexRecoveryPolicy', () => {
  it('keeps issuing attempts with capped delay instead of exhausting', () => {
    const policy = new CodexRecoveryPolicy({ now: () => 0 })

    expect(policy.nextAttempt()).toEqual({ attempt: 1, delayMs: 0 })
    expect(policy.nextAttempt()).toEqual({ attempt: 2, delayMs: 250 })
    expect(policy.nextAttempt()).toEqual({ attempt: 3, delayMs: 1000 })
    expect(policy.nextAttempt()).toEqual({ attempt: 4, delayMs: 2000 })
    expect(policy.nextAttempt()).toEqual({ attempt: 5, delayMs: 5000 })
    expect(policy.nextAttempt()).toEqual({ attempt: 6, delayMs: 5000 })
    expect(policy.nextAttempt()).toEqual({ attempt: 7, delayMs: 5000 })
  })

  it('keeps capped attempts while time passes during ongoing recovery', () => {
    let now = 0
    const policy = new CodexRecoveryPolicy({ now: () => now })

    for (let index = 0; index < 5; index += 1) {
      policy.nextAttempt()
    }
    now += 2 * 60 * 1000

    expect(policy.nextAttempt()).toEqual({ attempt: 6, delayMs: 5000 })
    expect(policy.nextAttempt()).toEqual({ attempt: 7, delayMs: 5000 })
  })

  it('resets the retry sequence after a stable running window', () => {
    let now = 0
    const policy = new CodexRecoveryPolicy({ now: () => now })

    for (let index = 0; index < 8; index += 1) {
      policy.nextAttempt()
    }

    policy.markStableRunning()
    now += 10 * 60 * 1000 + 1

    expect(policy.nextAttempt()).toEqual({ attempt: 1, delayMs: 0 })
  })

  it('does not consume retry budget for recovery-retire cleanup callbacks', () => {
    const policy = new CodexRecoveryPolicy({ now: () => 0 })

    policy.noteRecoveryRetireCallback()

    expect(policy.nextAttempt()).toEqual({ attempt: 1, delayMs: 0 })
  })

  it('buffers input during recovery and expires it after the ttl', () => {
    let now = 0
    const policy = new CodexRecoveryPolicy({ now: () => now })

    expect(policy.bufferInput('abc')).toEqual({ ok: true })
    now += 10_001

    expect(policy.drainBufferedInput()).toEqual({
      ok: false,
      reason: 'expired',
    })
  })

  it('caps buffered input at eight KiB', () => {
    const policy = new CodexRecoveryPolicy({ now: () => 0 })

    expect(policy.bufferInput('x'.repeat(8 * 1024))).toEqual({ ok: true })
    expect(policy.bufferInput('y')).toEqual({
      ok: false,
      reason: 'overflow',
    })
  })
})
