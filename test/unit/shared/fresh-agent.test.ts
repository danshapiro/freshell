import { describe, expect, it } from 'vitest'

import { migrateLegacyFreshAgentDurableState } from '../../../shared/fresh-agent.js'

describe('fresh-agent shared migration', () => {
  it('keeps durable Freshopencode session refs', () => {
    expect(migrateLegacyFreshAgentDurableState({
      provider: 'opencode',
      sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' },
    })).toEqual({
      sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' },
    })
  })

  it('promotes a durable Freshopencode resume id when a legacy placeholder ref is present', () => {
    expect(migrateLegacyFreshAgentDurableState({
      provider: 'opencode',
      sessionRef: { provider: 'opencode', sessionId: 'freshopencode-req-1' },
      resumeSessionId: 'ses_real_1',
    })).toEqual({
      sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' },
    })
  })

  it('marks Freshopencode placeholders as non-restorable when no durable id exists', () => {
    expect(migrateLegacyFreshAgentDurableState({
      provider: 'opencode',
      sessionRef: { provider: 'opencode', sessionId: 'freshopencode-req-1' },
    })).toEqual({
      restoreError: {
        code: 'RESTORE_UNAVAILABLE',
        reason: 'invalid_legacy_restore_target',
      },
    })

    expect(migrateLegacyFreshAgentDurableState({
      provider: 'opencode',
      resumeSessionId: 'freshopencode-req-1',
    })).toEqual({
      restoreError: {
        code: 'RESTORE_UNAVAILABLE',
        reason: 'invalid_legacy_restore_target',
      },
    })
  })
})
