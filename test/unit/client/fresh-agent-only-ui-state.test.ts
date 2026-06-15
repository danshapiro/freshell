import { describe, expect, it } from 'vitest'
import { store } from '@/store/store'
import { isCodingAgentPane } from '@/lib/coding-agent-detection'

describe('fresh-agent only UI state', () => {
  it('does not mount legacy agentChat Redux state', () => {
    expect(Object.keys(store.getState())).not.toContain('agentChat')
  })

  it('recognizes fresh-agent panes as coding agents without accepting agent-chat panes', () => {
    expect(isCodingAgentPane({ kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude' } as never)).toBe(true)
    expect(isCodingAgentPane({ kind: 'agent-chat', provider: 'freshclaude' } as never)).toBe(false)
  })
})
