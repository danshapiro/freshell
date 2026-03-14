import { describe, it, expect } from 'vitest'
import { shouldPromoteSessionTitle } from '../../../server/session-title-sync'

describe('shouldPromoteSessionTitle', () => {
  it('treats the default Claude CLI title as replaceable', () => {
    expect(shouldPromoteSessionTitle('Claude CLI', 'claude')).toBe(true)
  })

  it('treats the default Codex CLI title as replaceable', () => {
    expect(shouldPromoteSessionTitle('Codex CLI', 'codex')).toBe(true)
  })

  it('keeps custom titles intact', () => {
    expect(shouldPromoteSessionTitle('Release Prep', 'claude')).toBe(false)
    expect(shouldPromoteSessionTitle('Implement tests', 'codex')).toBe(false)
  })

  it('still accepts the older short default labels', () => {
    expect(shouldPromoteSessionTitle('Claude', 'claude')).toBe(true)
    expect(shouldPromoteSessionTitle('Codex', 'codex')).toBe(true)
  })
})
