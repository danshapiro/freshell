import { describe, expect, it } from 'vitest'

import { resolveFreshAgentType } from '@/lib/fresh-agent-registry'

describe('fresh-agent registry', () => {
  it('keeps kilroy as a hidden claude-backed fresh-agent type', () => {
    expect(resolveFreshAgentType('kilroy')).toMatchObject({
      runtimeProvider: 'claude',
      hidden: true,
    })
  })

  it('registers freshcodex as a codex-backed session type', () => {
    expect(resolveFreshAgentType('freshcodex')).toMatchObject({
      runtimeProvider: 'codex',
      label: 'Freshcodex',
    })
  })
})
