import { describe, it, expect } from 'vitest'
import { isCodingAgentContent } from '@/lib/coding-agent-detection'
import type { PaneContent } from '@/store/paneTypes'

const content = (c: Partial<PaneContent> & { kind: PaneContent['kind'] }): PaneContent =>
  c as unknown as PaneContent

describe('isCodingAgentContent', () => {
  it('is true for non-shell terminal modes, fresh-agent, and agent-chat', () => {
    expect(isCodingAgentContent(content({ kind: 'terminal', mode: 'claude' }))).toBe(true)
    expect(isCodingAgentContent(content({ kind: 'terminal', mode: 'codex' }))).toBe(true)
    expect(isCodingAgentContent(content({ kind: 'fresh-agent', sessionType: 'claude' }))).toBe(true)
    expect(isCodingAgentContent(content({ kind: 'agent-chat', provider: 'claude' }))).toBe(true)
  })

  it('is false for shell terminals (the critical scope boundary)', () => {
    expect(isCodingAgentContent(content({ kind: 'terminal', mode: 'shell' }))).toBe(false)
  })

  it('is false for browser, editor, and picker panes', () => {
    expect(isCodingAgentContent(content({ kind: 'browser' }))).toBe(false)
    expect(isCodingAgentContent(content({ kind: 'editor' }))).toBe(false)
    expect(isCodingAgentContent(content({ kind: 'picker' }))).toBe(false)
  })

  it('is false for nullish content', () => {
    expect(isCodingAgentContent(undefined)).toBe(false)
    expect(isCodingAgentContent(null)).toBe(false)
  })
})
