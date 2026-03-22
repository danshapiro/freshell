import type { TerminalPaneContent } from '@/store/paneTypes'
import { sanitizeExactSessionRef } from '@/lib/exact-session-ref'

export type TerminalContentRef = { current: TerminalPaneContent | null }

export function getResumeSessionIdFromRef(ref: TerminalContentRef): string | undefined {
  return ref.current?.resumeSessionId
}

export type ResumeTargetDecision =
  | { kind: 'send'; resumeSessionId: string | undefined }
  | { kind: 'wait' }
  | { kind: 'blocked' }

export function getResumeTarget(input: {
  restore: boolean
  mode: TerminalPaneContent['mode']
  sessionRef?: TerminalPaneContent['sessionRef']
  mirroredResumeSessionId?: string
  localServerInstanceId?: string
}): ResumeTargetDecision {
  const rawExactSessionRef = sanitizeExactSessionRef(input.sessionRef)
  const exactSessionRef = sanitizeExactSessionRef(input.sessionRef, input.mode)
  if (!input.restore) {
    if (rawExactSessionRef) {
      const localExactSessionId = exactSessionRef && input.localServerInstanceId
        && exactSessionRef.serverInstanceId === input.localServerInstanceId
        ? exactSessionRef.sessionId
        : undefined
      return {
        kind: 'send',
        resumeSessionId: localExactSessionId,
      }
    }

    return {
      kind: 'send',
      resumeSessionId: input.mirroredResumeSessionId,
    }
  }

  if (input.mode === 'shell') {
    return {
      kind: 'send',
      resumeSessionId: input.mirroredResumeSessionId,
    }
  }

  if (!input.localServerInstanceId) {
    return { kind: 'wait' }
  }

  if (!exactSessionRef || exactSessionRef.serverInstanceId !== input.localServerInstanceId) {
    return { kind: 'blocked' }
  }

  return {
    kind: 'send',
    resumeSessionId: exactSessionRef.sessionId,
  }
}
