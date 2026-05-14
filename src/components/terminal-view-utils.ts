import type { TerminalPaneContent } from '@/store/paneTypes'

export type TerminalContentRef = { current: TerminalPaneContent | null }

export function getResumeSessionIdFromRef(ref: TerminalContentRef): string | undefined {
  return ref.current?.resumeSessionId
}

export function getCreateSessionStateFromRef(ref: TerminalContentRef): {
  sessionRef?: TerminalPaneContent['sessionRef']
  codexDurability?: TerminalPaneContent['codexDurability']
  liveTerminal?: {
    terminalId: string
    serverInstanceId: string
  }
} {
  const sessionRef = ref.current?.sessionRef
  const codexDurability = ref.current?.codexDurability
  const terminalId = ref.current?.terminalId
  const serverInstanceId = ref.current?.serverInstanceId
  return {
    ...(sessionRef ? { sessionRef } : {}),
    ...(!sessionRef && codexDurability ? { codexDurability } : {}),
    ...(terminalId && serverInstanceId
      ? {
          liveTerminal: {
            terminalId,
            serverInstanceId,
          },
        }
      : {}),
  }
}
