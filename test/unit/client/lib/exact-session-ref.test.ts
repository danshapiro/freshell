import { describe, expect, it } from 'vitest'
import {
  buildExactSessionRef,
  sanitizeExactSessionRef,
} from '@/lib/exact-session-ref'

const VALID_CLAUDE_SESSION_ID = '550e8400-e29b-41d4-a716-446655440000'

describe('exact-session-ref', () => {
  it('builds an exact local codex session ref when the server instance is known', () => {
    expect(buildExactSessionRef({
      provider: 'codex',
      sessionId: 'codex-session-123',
      serverInstanceId: 'srv-local',
    })).toEqual({
      provider: 'codex',
      sessionId: 'codex-session-123',
      serverInstanceId: 'srv-local',
    })
  })

  it('builds an exact local claude ref only for UUID sessions', () => {
    expect(buildExactSessionRef({
      provider: 'claude',
      sessionId: VALID_CLAUDE_SESSION_ID,
      serverInstanceId: 'srv-local',
    })).toEqual({
      provider: 'claude',
      sessionId: VALID_CLAUDE_SESSION_ID,
      serverInstanceId: 'srv-local',
    })

    expect(buildExactSessionRef({
      provider: 'claude',
      sessionId: 'named-claude-resume',
      serverInstanceId: 'srv-local',
    })).toBeUndefined()
  })

  it('refuses to synthesize exact refs for providers that still use compatibility association', () => {
    expect(buildExactSessionRef({
      provider: 'opencode',
      sessionId: 'opencode-session-123',
      serverInstanceId: 'srv-local',
    })).toBeUndefined()
  })

  it('sanitizes explicit refs using the same provider-aware exactness rule', () => {
    expect(sanitizeExactSessionRef({
      provider: 'codex',
      sessionId: 'codex-session-123',
      serverInstanceId: 'srv-remote',
    })).toEqual({
      provider: 'codex',
      sessionId: 'codex-session-123',
      serverInstanceId: 'srv-remote',
    })

    expect(sanitizeExactSessionRef({
      provider: 'claude',
      sessionId: 'named-claude-resume',
      serverInstanceId: 'srv-local',
    })).toBeUndefined()

    expect(sanitizeExactSessionRef({
      provider: 'codex',
      sessionId: 'codex-session-123',
    })).toBeUndefined()
  })

  it('drops explicit refs when the expected provider does not match', () => {
    expect(sanitizeExactSessionRef({
      provider: 'claude',
      sessionId: VALID_CLAUDE_SESSION_ID,
      serverInstanceId: 'srv-local',
    }, 'codex')).toBeUndefined()

    expect(sanitizeExactSessionRef({
      provider: 'codex',
      sessionId: 'codex-session-123',
      serverInstanceId: 'srv-local',
    }, 'codex')).toEqual({
      provider: 'codex',
      sessionId: 'codex-session-123',
      serverInstanceId: 'srv-local',
    })
  })
})
