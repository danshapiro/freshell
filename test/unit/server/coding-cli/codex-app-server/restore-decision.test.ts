import { describe, expect, it, vi } from 'vitest'
import { CODEX_DURABILITY_SCHEMA_VERSION, type CodexCandidateIdentity, type CodexDurabilityRef } from '../../../../../shared/codex-durability.js'
import {
  INVALID_RAW_CODEX_RESUME_MESSAGE,
  MISSING_CODEX_SESSION_REF_MESSAGE,
  planCodexCreateRestoreDecision,
  resolveCodexCreateRestoreDecision,
  type CodexLiveRestoreTerminal,
} from '../../../../../server/coding-cli/codex-app-server/restore-decision.js'
import type { CodexRolloutProofResult } from '../../../../../server/coding-cli/codex-app-server/durability-proof.js'

const candidate: CodexCandidateIdentity = {
  provider: 'codex',
  candidateThreadId: 'thread-1',
  rolloutPath: '/tmp/freshell-codex/rollout.jsonl',
  source: 'restored_client_state',
  capturedAt: 1,
}

const durability: CodexDurabilityRef = {
  schemaVersion: CODEX_DURABILITY_SCHEMA_VERSION,
  state: 'durability_unproven_after_completion',
  candidate,
  turnCompletedAt: 2,
}

const durableDurability: CodexDurabilityRef = {
  schemaVersion: CODEX_DURABILITY_SCHEMA_VERSION,
  state: 'durable',
  candidate,
  durableThreadId: 'thread-durable',
  turnCompletedAt: 3,
}

const proofOk: CodexRolloutProofResult = {
  ok: true,
  candidateThreadId: candidate.candidateThreadId,
  rolloutPath: candidate.rolloutPath,
  rolloutProofId: candidate.candidateThreadId,
}

const proofMissing: CodexRolloutProofResult = {
  ok: false,
  reason: 'missing',
  message: 'Codex rollout proof file does not exist.',
  candidateThreadId: candidate.candidateThreadId,
  rolloutPath: candidate.rolloutPath,
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

  it('rejects restore requests without sessionRef, durable ref, or candidate', () => {
    expect(planCodexCreateRestoreDecision({ restoreRequested: true })).toEqual({
      kind: 'reject_missing_codex_session_ref',
      code: 'RESTORE_UNAVAILABLE',
      message: MISSING_CODEX_SESSION_REF_MESSAGE,
    })
  })

  it('routes canonical sessionRef restores without using candidate proof', async () => {
    const proofRollout = vi.fn(async () => proofOk)

    const decision = await resolveCodexCreateRestoreDecision({
      restoreRequested: true,
      legacyResumeSessionId: 'thread-raw',
      sessionRef: { provider: 'codex', sessionId: 'thread-durable' },
      codexDurability: durability,
      proofRollout,
    })

    expect(decision).toEqual({
      kind: 'durable_session_ref_resume',
      sessionRef: { provider: 'codex', sessionId: 'thread-durable' },
      sessionId: 'thread-durable',
    })
    expect(proofRollout).not.toHaveBeenCalled()
  })

  it('uses durable Codex durability state as a canonical restore sessionRef', () => {
    expect(planCodexCreateRestoreDecision({
      restoreRequested: true,
      codexDurability: {
        schemaVersion: CODEX_DURABILITY_SCHEMA_VERSION,
        state: 'durable',
        durableThreadId: 'thread-durable',
      },
    })).toEqual({
      kind: 'durable_session_ref_resume',
      sessionRef: { provider: 'codex', sessionId: 'thread-durable' },
      sessionId: 'thread-durable',
    })
  })

  it('uses explicit sessionRef before durable Codex durability state', () => {
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

  it('uses durable Codex durability state before candidate proof', async () => {
    const proofRollout = vi.fn(async () => proofOk)

    const decision = await resolveCodexCreateRestoreDecision({
      restoreRequested: true,
      codexDurability: durableDurability,
      proofRollout,
    })

    expect(decision).toEqual({
      kind: 'durable_session_ref_resume',
      sessionRef: { provider: 'codex', sessionId: 'thread-durable' },
      sessionId: 'thread-durable',
    })
    expect(proofRollout).not.toHaveBeenCalled()
  })

  it('rejects raw legacy resume ids even when durable Codex durability is present without sessionRef', () => {
    expect(planCodexCreateRestoreDecision({
      restoreRequested: true,
      legacyResumeSessionId: 'thread-raw',
      codexDurability: durableDurability,
    })).toEqual({
      kind: 'reject_invalid_raw_codex_resume_request',
      code: 'INVALID_MESSAGE',
      message: INVALID_RAW_CODEX_RESUME_MESSAGE,
    })
  })

  it('plans candidate proof before a restored candidate can become durable', () => {
    expect(planCodexCreateRestoreDecision({
      restoreRequested: true,
      codexDurability: durability,
    })).toEqual({
      kind: 'proof_existing_candidate_first',
      candidate,
    })
  })

  it('ignores captured Codex candidates for non-restore fresh creates', () => {
    expect(planCodexCreateRestoreDecision({
      restoreRequested: false,
      codexDurability: durability,
    })).toEqual({
      kind: 'fresh_codex_launch',
    })
  })

  it('ignores durable Codex durability state for non-restore fresh creates', () => {
    expect(planCodexCreateRestoreDecision({
      restoreRequested: false,
      codexDurability: durableDurability,
    })).toEqual({
      kind: 'fresh_codex_launch',
    })
  })

  it('uses exact rollout proof as the durable session id and returns a matching live terminal when present', async () => {
    const liveTerminal: CodexLiveRestoreTerminal = {
      terminalId: 'term-live',
      createdAt: 10,
      codexDurability: durability,
    }

    const decision = await resolveCodexCreateRestoreDecision({
      restoreRequested: true,
      codexDurability: durability,
      proofRollout: async () => proofOk,
      findLiveTerminalByCandidate: () => liveTerminal,
    })

    expect(decision).toEqual({
      kind: 'proof_succeeded_resume_durable',
      candidate,
      proof: proofOk,
      sessionId: 'thread-1',
      liveTerminal,
    })
  })

  it('attaches the exact live candidate when proof fails but the terminal still exists', async () => {
    const liveTerminal: CodexLiveRestoreTerminal = {
      terminalId: 'term-unproved-live',
      createdAt: 10,
      codexDurability: durability,
    }

    const decision = await resolveCodexCreateRestoreDecision({
      restoreRequested: true,
      codexDurability: durability,
      proofRollout: async () => proofMissing,
      findLiveTerminalByCandidate: () => liveTerminal,
    })

    expect(decision).toEqual({
      kind: 'proof_failed_attach_live_candidate',
      candidate,
      proof: proofMissing,
      liveTerminal,
    })
  })

  it('fresh-creates with a restore-failed marker when candidate proof fails and no exact live terminal exists', async () => {
    const decision = await resolveCodexCreateRestoreDecision({
      restoreRequested: true,
      codexDurability: durability,
      proofRollout: async () => proofMissing,
      findLiveTerminalByCandidate: () => undefined,
    })

    expect(decision).toEqual({
      kind: 'proof_failed_fresh_create',
      candidate,
      proof: proofMissing,
      clearCodexDurability: true,
      restoreError: {
        code: 'RESTORE_UNAVAILABLE',
        reason: 'durable_artifact_missing',
      },
    })
  })

  it('does not accept a loose live terminal candidate returned by the caller', async () => {
    const looseLiveTerminal: CodexLiveRestoreTerminal = {
      terminalId: 'term-loose-live',
      createdAt: 10,
      codexDurability: {
        ...durability,
        candidate: {
          ...candidate,
          candidateThreadId: 'thread-other',
        },
      },
    }

    const decision = await resolveCodexCreateRestoreDecision({
      restoreRequested: true,
      codexDurability: durability,
      proofRollout: async () => proofMissing,
      findLiveTerminalByCandidate: () => looseLiveTerminal,
    })

    expect(decision).toEqual({
      kind: 'proof_failed_fresh_create',
      candidate,
      proof: proofMissing,
      clearCodexDurability: true,
      restoreError: {
        code: 'RESTORE_UNAVAILABLE',
        reason: 'durable_artifact_missing',
      },
    })
  })
})
