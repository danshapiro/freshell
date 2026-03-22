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
  const exactSessionRef = sanitizeExactSessionRef(input.sessionRef)
  if (!input.restore) {
    const localExactSessionId = exactSessionRef && input.localServerInstanceId
      && exactSessionRef.serverInstanceId === input.localServerInstanceId
      ? exactSessionRef.sessionId
      : undefined
    return {
      kind: 'send',
      resumeSessionId: input.mirroredResumeSessionId ?? localExactSessionId,
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
