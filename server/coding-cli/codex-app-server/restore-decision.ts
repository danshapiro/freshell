import type { SessionRef, RestoreError } from '../../../shared/session-contract.js'
import { buildRestoreError } from '../../../shared/session-contract.js'
import type { CodexCandidateIdentity, CodexDurabilityRef } from '../../../shared/codex-durability.js'
import { proofCodexRollout, type CodexRolloutProofResult } from './durability-proof.js'

type MaybePromise<T> = T | Promise<T>

export type CodexLiveRestoreTerminal = {
  terminalId: string
  createdAt: number
  resumeSessionId?: string
  codexDurability?: CodexDurabilityRef
}

export type RejectCodexCreateRestoreDecision = {
  kind: 'reject_invalid_raw_codex_resume_request' | 'reject_missing_codex_session_ref'
  code: 'INVALID_MESSAGE' | 'RESTORE_UNAVAILABLE'
  message: string
}

export type CodexCreateRestorePlan =
  | RejectCodexCreateRestoreDecision
  | { kind: 'fresh_codex_launch' }
  | { kind: 'proof_existing_candidate_first'; candidate: CodexCandidateIdentity }
  | { kind: 'durable_session_ref_resume'; sessionRef: SessionRef & { provider: 'codex' }; sessionId: string }
  | { kind: 'legacy_raw_resume_passthrough'; sessionId: string }

export type CodexCreateRestoreDecision<TLiveTerminal extends CodexLiveRestoreTerminal = CodexLiveRestoreTerminal> =
  | Exclude<CodexCreateRestorePlan, { kind: 'proof_existing_candidate_first' }>
  | {
    kind: 'proof_succeeded_resume_durable'
    candidate: CodexCandidateIdentity
    proof: Extract<CodexRolloutProofResult, { ok: true }>
    sessionId: string
    liveTerminal?: TLiveTerminal
  }
  | {
    kind: 'proof_failed_attach_live_candidate'
    candidate: CodexCandidateIdentity
    proof: Extract<CodexRolloutProofResult, { ok: false }>
    liveTerminal: TLiveTerminal
  }
  | {
    kind: 'proof_failed_fresh_create'
    candidate: CodexCandidateIdentity
    proof: Extract<CodexRolloutProofResult, { ok: false }>
    clearCodexDurability: true
    restoreError: RestoreError
  }

export const INVALID_RAW_CODEX_RESUME_MESSAGE =
  'Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity.'

export const MISSING_CODEX_SESSION_REF_MESSAGE = 'Restore requires a canonical session reference.'

export function planCodexCreateRestoreDecision(input: {
  restoreRequested?: boolean
  legacyResumeSessionId?: string
  sessionRef?: SessionRef
  codexDurability?: CodexDurabilityRef
}): CodexCreateRestorePlan {
  if (input.restoreRequested && input.legacyResumeSessionId && !input.sessionRef) {
    return {
      kind: 'reject_invalid_raw_codex_resume_request',
      code: 'INVALID_MESSAGE',
      message: INVALID_RAW_CODEX_RESUME_MESSAGE,
    }
  }

  if (isCodexSessionRef(input.sessionRef)) {
    return {
      kind: 'durable_session_ref_resume',
      sessionRef: input.sessionRef,
      sessionId: input.sessionRef.sessionId,
    }
  }

  const candidate = input.codexDurability?.candidate
  if (candidate && !input.legacyResumeSessionId) {
    return {
      kind: 'proof_existing_candidate_first',
      candidate,
    }
  }

  if (input.restoreRequested) {
    return {
      kind: 'reject_missing_codex_session_ref',
      code: 'RESTORE_UNAVAILABLE',
      message: MISSING_CODEX_SESSION_REF_MESSAGE,
    }
  }

  if (input.legacyResumeSessionId) {
    return {
      kind: 'legacy_raw_resume_passthrough',
      sessionId: input.legacyResumeSessionId,
    }
  }

  return { kind: 'fresh_codex_launch' }
}

export async function resolveCodexCreateRestoreDecision<TLiveTerminal extends CodexLiveRestoreTerminal>(
  input: {
    restoreRequested?: boolean
    legacyResumeSessionId?: string
    sessionRef?: SessionRef
    codexDurability?: CodexDurabilityRef
    proofRollout?: (input: { rolloutPath: string; candidateThreadId: string }) => Promise<CodexRolloutProofResult>
    findExactLiveTerminalByCandidate?: (candidate: CodexCandidateIdentity) => MaybePromise<TLiveTerminal | undefined>
  },
): Promise<CodexCreateRestoreDecision<TLiveTerminal>> {
  const plan = planCodexCreateRestoreDecision(input)
  if (plan.kind !== 'proof_existing_candidate_first') {
    return plan
  }

  const candidate = plan.candidate
  const proof = await (input.proofRollout ?? proofCodexRollout)({
    rolloutPath: candidate.rolloutPath,
    candidateThreadId: candidate.candidateThreadId,
  })
  const liveTerminal = await input.findExactLiveTerminalByCandidate?.(candidate)

  if (proof.ok) {
    return {
      kind: 'proof_succeeded_resume_durable',
      candidate,
      proof,
      sessionId: proof.rolloutProofId,
      ...(liveTerminal ? { liveTerminal } : {}),
    }
  }

  if (liveTerminal) {
    return {
      kind: 'proof_failed_attach_live_candidate',
      candidate,
      proof,
      liveTerminal,
    }
  }

  return {
    kind: 'proof_failed_fresh_create',
    candidate,
    proof,
    clearCodexDurability: true,
    restoreError: buildRestoreError('durable_artifact_missing'),
  }
}

function isCodexSessionRef(value: SessionRef | undefined): value is SessionRef & { provider: 'codex' } {
  return value?.provider === 'codex'
}
