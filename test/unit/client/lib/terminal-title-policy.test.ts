import { describe, it, expect } from 'vitest'
import { terminalFollowsOscTitle } from '@/lib/terminal-title-policy'

describe('terminalFollowsOscTitle', () => {
  it('lets shell terminals follow the running program via OSC titles', () => {
    expect(terminalFollowsOscTitle('shell')).toBe(true)
  })

  it('freezes coding-agent terminals from OSC titles (named by the server session)', () => {
    expect(terminalFollowsOscTitle('claude')).toBe(false)
    expect(terminalFollowsOscTitle('codex')).toBe(false)
    expect(terminalFollowsOscTitle('opencode')).toBe(false)
  })

  it('treats an unknown/missing mode as a coding agent (frozen) — never accidentally unfreezes', () => {
    expect(terminalFollowsOscTitle(undefined)).toBe(false)
    expect(terminalFollowsOscTitle('')).toBe(false)
  })
})
