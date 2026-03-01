import { describe, it, expect } from 'vitest'
import { resolveSessionTypeConfig } from '@/lib/session-type-utils'

describe('resolveSessionTypeConfig', () => {
  it('returns claude config for "claude"', () => {
    const config = resolveSessionTypeConfig('claude')
    expect(config.label).toBe('Claude CLI')
    expect(config.icon).toBeDefined()
  })

  it('returns codex config for "codex"', () => {
    const config = resolveSessionTypeConfig('codex')
    expect(config.label).toBe('Codex CLI')
  })

  it('returns freshclaude config for "freshclaude"', () => {
    const config = resolveSessionTypeConfig('freshclaude')
    expect(config.label).toBe('Freshclaude')
    expect(config.icon).toBeDefined()
  })

  it('returns kilroy config for "kilroy"', () => {
    const config = resolveSessionTypeConfig('kilroy')
    expect(config.label).toBe('Kilroy')
  })

  it('returns fallback for unknown type', () => {
    const config = resolveSessionTypeConfig('graphviz-viewer')
    expect(config.label).toBe('graphviz-viewer')
    expect(config.icon).toBeDefined() // generic fallback icon
  })
})
