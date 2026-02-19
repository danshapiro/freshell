import { describe, expect, it } from 'vitest'
import { SessionBindingAuthority } from '../../../server/session-binding-authority'

describe('SessionBindingAuthority', () => {
  it('rejects binding the same session key to a second terminal', () => {
    const authority = new SessionBindingAuthority()
    const first = authority.bind({ provider: 'codex', sessionId: 's1', terminalId: 't1' })
    const second = authority.bind({ provider: 'codex', sessionId: 's1', terminalId: 't2' })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error('Expected failed bind')
    expect(second.reason).toBe('session_already_owned')
    expect(second.owner).toBe('t1')
  })

  it('is idempotent when binding same provider/session to same terminal', () => {
    const authority = new SessionBindingAuthority()
    const first = authority.bind({ provider: 'codex', sessionId: 's1', terminalId: 't1' })
    const second = authority.bind({ provider: 'codex', sessionId: 's1', terminalId: 't1' })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
  })

  it('rejects rebinding a terminal that already owns a different session', () => {
    const authority = new SessionBindingAuthority()
    const first = authority.bind({ provider: 'codex', sessionId: 's1', terminalId: 't1' })
    const second = authority.bind({ provider: 'codex', sessionId: 's2', terminalId: 't1' })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error('Expected failed bind')
    expect(second.reason).toBe('terminal_already_bound')
  })
})
