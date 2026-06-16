import { describe, expect, it } from 'vitest'
import { CODEX_DURABILITY_SCHEMA_VERSION } from '../../../shared/codex-durability.js'
import {
  buildSessionIdentityMismatchDetails,
  canonicalActualSessionRef,
  terminalMatchesExpectedSession,
} from '../../../server/terminal-session-identity.js'

describe('terminal-session-identity', () => {
  it('treats missing expected identity as a backwards-compatible match', () => {
    expect(terminalMatchesExpectedSession({
      mode: 'shell',
    } as any, undefined)).toBe(true)
  })

  it('matches canonical durable Codex identity only when registry identity proves it', () => {
    const record = {
      mode: 'codex',
      resumeSessionId: 'thread-durable',
      codexDurability: {
        schemaVersion: CODEX_DURABILITY_SCHEMA_VERSION,
        state: 'durable',
        durableThreadId: 'thread-durable',
      },
    } as const

    expect(canonicalActualSessionRef(record as any)).toEqual({
      provider: 'codex',
      sessionId: 'thread-durable',
    })
    expect(terminalMatchesExpectedSession(record as any, {
      provider: 'codex',
      sessionId: 'thread-durable',
    })).toBe(true)
  })

  it('does not match Codex candidate-only durability for side effects', () => {
    expect(terminalMatchesExpectedSession({
      mode: 'codex',
      resumeSessionId: 'thread-candidate',
      codexDurability: {
        schemaVersion: CODEX_DURABILITY_SCHEMA_VERSION,
        state: 'proof_checking',
        candidate: {
          provider: 'codex',
          candidateThreadId: 'thread-candidate',
          rolloutPath: '/tmp/rollout.jsonl',
          source: 'restored_client_state',
          capturedAt: 1,
        },
      },
    } as any, {
      provider: 'codex',
      sessionId: 'thread-candidate',
    })).toBe(false)
  })

  it('does not match Codex durable state when resumeSessionId disagrees', () => {
    expect(terminalMatchesExpectedSession({
      mode: 'codex',
      resumeSessionId: 'thread-old',
      codexDurability: {
        schemaVersion: CODEX_DURABILITY_SCHEMA_VERSION,
        state: 'durable',
        durableThreadId: 'thread-new',
      },
    } as any, {
      provider: 'codex',
      sessionId: 'thread-new',
    })).toBe(false)
  })

  it('fails on provider mismatch', () => {
    expect(terminalMatchesExpectedSession({
      mode: 'opencode',
      resumeSessionId: 'session-1',
    } as any, {
      provider: 'codex',
      sessionId: 'session-1',
    })).toBe(false)
  })

  it('builds mismatch details from the canonical actual identity only', () => {
    expect(buildSessionIdentityMismatchDetails({
      mode: 'codex',
      resumeSessionId: 'thread-old',
      codexDurability: {
        schemaVersion: CODEX_DURABILITY_SCHEMA_VERSION,
        state: 'durable',
        durableThreadId: 'thread-old',
      },
    } as any, {
      provider: 'codex',
      sessionId: 'thread-new',
    })).toEqual({
      expectedSessionRef: {
        provider: 'codex',
        sessionId: 'thread-new',
      },
      actualSessionRef: {
        provider: 'codex',
        sessionId: 'thread-old',
      },
    })
  })
})
