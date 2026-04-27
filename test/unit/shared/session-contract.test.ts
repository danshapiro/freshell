import { describe, expect, it } from 'vitest'
import {
  RestoreErrorSchema,
  SessionRefSchema,
  buildRestoreError,
  migrateLegacyAgentChatDurableState,
  migrateLegacyTerminalDurableState,
  sanitizeSessionRef,
} from '@shared/session-contract'

const VALID_CLAUDE_SESSION_ID = '550e8400-e29b-41d4-a716-446655440000'

describe('session-contract', () => {
  describe('SessionRefSchema', () => {
    it('accepts canonical durable session refs', () => {
      const parsed = SessionRefSchema.safeParse({
        provider: 'codex',
        sessionId: 'sess-123',
      })

      expect(parsed.success).toBe(true)
      if (!parsed.success) return

      expect(parsed.data).toEqual({
        provider: 'codex',
        sessionId: 'sess-123',
      })
    })

    it('rejects serverInstanceId inside canonical durable identity', () => {
      const parsed = SessionRefSchema.safeParse({
        provider: 'codex',
        sessionId: 'sess-123',
        serverInstanceId: 'srv-local',
      })

      expect(parsed.success).toBe(false)
    })
  })

  describe('sanitizeSessionRef', () => {
    it('drops locality fields when sanitizing canonical identity', () => {
      expect(sanitizeSessionRef({
        provider: 'codex',
        sessionId: 'sess-123',
        serverInstanceId: 'srv-local',
      })).toEqual({
        provider: 'codex',
        sessionId: 'sess-123',
      })
    })
  })

  describe('migrateLegacyTerminalDurableState', () => {
    it('promotes legacy claude UUID resume ids to canonical sessionRef', () => {
      expect(migrateLegacyTerminalDurableState({
        provider: 'claude',
        resumeSessionId: VALID_CLAUDE_SESSION_ID,
      })).toEqual({
        sessionRef: {
          provider: 'claude',
          sessionId: VALID_CLAUDE_SESSION_ID,
        },
      })
    })

    it('marks legacy codex fresh thread ids as restore-unavailable', () => {
      expect(migrateLegacyTerminalDurableState({
        provider: 'codex',
        resumeSessionId: 'thread-new-1',
      })).toEqual({
        restoreError: {
          code: 'RESTORE_UNAVAILABLE',
          reason: 'invalid_legacy_restore_target',
        },
      })
    })
  })

  describe('migrateLegacyAgentChatDurableState', () => {
    it('promotes canonical Claude CLI identity for agent-chat panes', () => {
      expect(migrateLegacyAgentChatDurableState({
        cliSessionId: VALID_CLAUDE_SESSION_ID,
        resumeSessionId: 'named-resume',
      })).toEqual({
        sessionRef: {
          provider: 'claude',
          sessionId: VALID_CLAUDE_SESSION_ID,
        },
      })
    })

    it('marks legacy raw agent-chat resume ids as restore-unavailable when no canonical Claude id exists', () => {
      expect(migrateLegacyAgentChatDurableState({
        resumeSessionId: VALID_CLAUDE_SESSION_ID,
      })).toEqual({
        restoreError: {
          code: 'RESTORE_UNAVAILABLE',
          reason: 'invalid_legacy_restore_target',
        },
      })
    })
  })

  describe('RestoreErrorSchema', () => {
    it('accepts canonical restore-unavailable payloads', () => {
      const restoreError = buildRestoreError('dead_live_handle')
      const parsed = RestoreErrorSchema.safeParse(restoreError)

      expect(parsed.success).toBe(true)
      if (!parsed.success) return

      expect(parsed.data).toEqual({
        code: 'RESTORE_UNAVAILABLE',
        reason: 'dead_live_handle',
      })
    })
  })
})
