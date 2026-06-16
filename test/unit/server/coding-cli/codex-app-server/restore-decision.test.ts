import { describe, expect, it, vi } from 'vitest'
import { CODEX_DURABILITY_SCHEMA_VERSION, type CodexDurabilityRef } from '../../../../../shared/codex-durability.js'
import {
  INVALID_RAW_CODEX_RESUME_MESSAGE,
  MISSING_CODEX_SESSION_REF_MESSAGE,
  isExactLiveCodexCandidate,
  planCodexCreateRestoreDecision,
  resolveCodexCreateRestoreDecision,
  type CodexLiveRestoreTerminal,
} from '../../../../../server/coding-cli/codex-app-server/restore-decision.js'

const candidateDurability: CodexDurabilityRef = {
  schemaVersion: CODEX_DURABILITY_SCHEMA_VERSION,
  state: 'durability_unproven_after_completion',
  candidate: {
    provider: 'codex',
    candidateThreadId: 'thread-candidate',
    rolloutPath: '/tmp/freshell-codex/rollout.jsonl',
    source: 'restored_client_state',
    capturedAt: 1,
  },
  turnCompletedAt: 2,
}

const durableDurability: CodexDurabilityRef = {
  schemaVersion: CODEX_DURABILITY_SCHEMA_VERSION,
  state: 'durable',
  durableThreadId: 'thread-durable',
  turnCompletedAt: 3,
}

describe('Codex create/restore decision', () => {
  it('rejects restore requests that only provide a raw legacy resume id', () => {
    expect(planCodexCreateRestoreDecision({
      restoreRequested: true,
      legacyResumeSessionId: 'thread-raw',
    })).toEqual({
      kind: 'reject_invalid_raw_codex_resume_request',
      code: 'INVALID_MESSAGE',
      message: INVALID_RAW_CODEX_RESUME_MESSAGE,
    })
  })

  it('rejects non-restore creates that provide a raw legacy Codex resume id', () => {
    expect(planCodexCreateRestoreDecision({
      legacyResumeSessionId: 'thread-raw',
    })).toEqual({
      kind: 'reject_invalid_raw_codex_resume_request',
      code: 'INVALID_MESSAGE',
      message: INVALID_RAW_CODEX_RESUME_MESSAGE,
    })
  })

  it('requires a canonical sessionRef for Codex restore', () => {
    expect(planCodexCreateRestoreDecision({ restoreRequested: true })).toEqual({
      kind: 'reject_missing_codex_session_ref',
      code: 'RESTORE_UNAVAILABLE',
      message: MISSING_CODEX_SESSION_REF_MESSAGE,
    })
  })

  it('routes canonical sessionRef restores directly', async () => {
    const findLiveTerminalByCandidate = vi.fn()

    const decision = await resolveCodexCreateRestoreDecision({
      restoreRequested: true,
      sessionRef: { provider: 'codex', sessionId: 'thread-durable' },
      codexDurability: candidateDurability,
      findLiveTerminalByCandidate,
    })

    expect(decision).toEqual({
      kind: 'durable_session_ref_resume',
      sessionRef: { provider: 'codex', sessionId: 'thread-durable' },
      sessionId: 'thread-durable',
    })
    expect(findLiveTerminalByCandidate).not.toHaveBeenCalled()
  })

  it('ignores durable Codex durability without a canonical sessionRef', () => {
    expect(planCodexCreateRestoreDecision({
      restoreRequested: true,
      codexDurability: durableDurability,
    })).toEqual({
      kind: 'reject_missing_codex_session_ref',
      code: 'RESTORE_UNAVAILABLE',
      message: MISSING_CODEX_SESSION_REF_MESSAGE,
    })
  })

  it('ignores candidate Codex durability without a canonical sessionRef', async () => {
    const findLiveTerminalByCandidate = vi.fn()

    const decision = await resolveCodexCreateRestoreDecision({
      restoreRequested: true,
      codexDurability: candidateDurability,
      findLiveTerminalByCandidate,
    })

    expect(decision).toEqual({
      kind: 'reject_missing_codex_session_ref',
      code: 'RESTORE_UNAVAILABLE',
      message: MISSING_CODEX_SESSION_REF_MESSAGE,
    })
    expect(findLiveTerminalByCandidate).not.toHaveBeenCalled()
  })

  it('uses explicit sessionRef before any durability evidence', () => {
    expect(planCodexCreateRestoreDecision({
      restoreRequested: true,
      sessionRef: { provider: 'codex', sessionId: 'thread-explicit' },
      codexDurability: durableDurability,
    })).toEqual({
      kind: 'durable_session_ref_resume',
      sessionRef: { provider: 'codex', sessionId: 'thread-explicit' },
      sessionId: 'thread-explicit',
    })
  })

  it('fresh-creates when restore is not requested, even if durability is present', () => {
    expect(planCodexCreateRestoreDecision({
      restoreRequested: false,
      codexDurability: candidateDurability,
    })).toEqual({
      kind: 'fresh_codex_launch',
    })

    expect(planCodexCreateRestoreDecision({
      restoreRequested: false,
      codexDurability: durableDurability,
    })).toEqual({
      kind: 'fresh_codex_launch',
    })
  })

  it('matches exact live candidates only by rollout path and candidate thread id', () => {
    const liveTerminal: CodexLiveRestoreTerminal = {
      terminalId: 'term-live',
      createdAt: 10,
      codexDurability: candidateDurability,
    }

    expect(isExactLiveCodexCandidate(liveTerminal, {
      candidateThreadId: 'thread-candidate',
      rolloutPath: '/tmp/freshell-codex/rollout.jsonl',
    })).toBe(true)

    expect(isExactLiveCodexCandidate(liveTerminal, {
      candidateThreadId: 'thread-other',
      rolloutPath: '/tmp/freshell-codex/rollout.jsonl',
    })).toBe(false)
  })
})
