import type { SessionRef } from '../../../shared/session-contract.js'
import type { CodexCandidateIdentity, CodexDurabilityRef } from '../../../shared/codex-durability.js'

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
  | { kind: 'durable_session_ref_resume'; sessionRef: SessionRef & { provider: 'codex' }; sessionId: string }

export type CodexCreateRestoreDecision<TLiveTerminal extends CodexLiveRestoreTerminal = CodexLiveRestoreTerminal> =
  | CodexCreateRestorePlan

export const INVALID_RAW_CODEX_RESUME_MESSAGE =
  'Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity.'

export const MISSING_CODEX_SESSION_REF_MESSAGE = 'Restore requires a canonical session reference.'

export function planCodexCreateRestoreDecision(input: {
  restoreRequested?: boolean
  legacyResumeSessionId?: string
  sessionRef?: SessionRef
  codexDurability?: CodexDurabilityRef
}): CodexCreateRestorePlan {
  const codexSessionRef = isCodexSessionRef(input.sessionRef) ? input.sessionRef : undefined

  if (hasRawLegacyResume(input.legacyResumeSessionId) && !codexSessionRef) {
    return {
      kind: 'reject_invalid_raw_codex_resume_request',
      code: 'INVALID_MESSAGE',
      message: INVALID_RAW_CODEX_RESUME_MESSAGE,
    }
  }

  if (codexSessionRef) {
    return {
      kind: 'durable_session_ref_resume',
      sessionRef: codexSessionRef,
      sessionId: codexSessionRef.sessionId,
    }
  }

  if (input.restoreRequested) {
    return {
      kind: 'reject_missing_codex_session_ref',
      code: 'RESTORE_UNAVAILABLE',
      message: MISSING_CODEX_SESSION_REF_MESSAGE,
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
    findLiveTerminalByCandidate?: (candidate: CodexCandidateIdentity) => MaybePromise<TLiveTerminal | undefined>
  },
): Promise<CodexCreateRestoreDecision<TLiveTerminal>> {
  return planCodexCreateRestoreDecision(input)
}

function isCodexSessionRef(value: SessionRef | undefined): value is SessionRef & { provider: 'codex' } {
  return value?.provider === 'codex'
}

function hasRawLegacyResume(value: string | undefined): boolean {
  return typeof value === 'string' && value.length > 0
}

export function isExactLiveCodexCandidate(
  terminal: CodexLiveRestoreTerminal,
  candidate: Pick<CodexCandidateIdentity, 'candidateThreadId' | 'rolloutPath'>,
): boolean {
  const liveCandidate = terminal.codexDurability?.candidate
  return liveCandidate?.candidateThreadId === candidate.candidateThreadId
    && liveCandidate.rolloutPath === candidate.rolloutPath
}
