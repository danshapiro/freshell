import { describe, expect, it } from 'vitest'
import {
  dedupeSessionRefs,
  sanitizeSessionRef,
} from '@shared/session-contract'

describe('client session-contract helpers', () => {
  it('sanitizes sidebar/bootstrap session refs down to canonical durable identity', () => {
    expect(sanitizeSessionRef({
      provider: 'opencode',
      sessionId: 'opencode-session-1',
      serverInstanceId: 'srv-remote',
    })).toEqual({
      provider: 'opencode',
      sessionId: 'opencode-session-1',
    })
  })

  it('dedupes canonical session refs even when inputs disagree only by locality', () => {
    expect(dedupeSessionRefs([
      {
        provider: 'codex',
        sessionId: 'codex-session-1',
      },
      {
        provider: 'codex',
        sessionId: 'codex-session-1',
        serverInstanceId: 'srv-remote',
      } as any,
      {
        provider: 'claude',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
      },
    ])).toEqual([
      {
        provider: 'codex',
        sessionId: 'codex-session-1',
      },
      {
        provider: 'claude',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
      },
    ])
  })
})
