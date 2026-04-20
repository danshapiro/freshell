import type { TerminalPaneContent } from '@/store/paneTypes'

export type TerminalContentRef = { current: TerminalPaneContent | null }

export function getResumeSessionIdFromRef(ref: TerminalContentRef): string | undefined {
  return ref.current?.resumeSessionId
}

export function getCreateSessionStateFromRef(ref: TerminalContentRef): {
  sessionRef?: TerminalPaneContent['sessionRef']
  resumeSessionId?: string
} {
  const sessionRef = ref.current?.sessionRef
  if (sessionRef) {
    return { sessionRef }
  }
  const resumeSessionId = ref.current?.resumeSessionId
  return resumeSessionId ? { resumeSessionId } : {}
}
