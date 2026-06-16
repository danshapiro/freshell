import type { SessionLocator, TerminalPaneContent } from '@/store/paneTypes'

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
  const content = ref.current
  const sessionRef = getExpectedSessionRefForTerminalOperation(content)
  const codexDurability = content?.codexDurability
  const liveTerminal = getSafeLiveTerminalForCreate(content)
  return {
    ...(sessionRef ? { sessionRef } : {}),
    ...(!sessionRef && codexDurability ? { codexDurability } : {}),
    ...(liveTerminal ? { liveTerminal } : {}),
  }
}

export function getExpectedSessionRefForTerminalOperation(
  content: TerminalPaneContent | null | undefined,
): SessionLocator | undefined {
  return content?.sessionRef
}

export function getSafeLiveTerminalForCreate(
  content: TerminalPaneContent | null | undefined,
  options: { allowLiveTerminalWithSessionRef?: boolean } = {},
): { terminalId: string; serverInstanceId: string } | undefined {
  if (!content?.terminalId || !content.serverInstanceId) return undefined
  if (content.sessionRef && !options.allowLiveTerminalWithSessionRef) return undefined
  return {
    terminalId: content.terminalId,
    serverInstanceId: content.serverInstanceId,
  }
}

export function buildTerminalInputMessage(
  content: TerminalPaneContent | null | undefined,
  terminalId: string,
  data: string,
): {
  type: 'terminal.input'
  terminalId: string
  data: string
  expectedSessionRef?: SessionLocator
} {
  const expectedSessionRef = getExpectedSessionRefForTerminalOperation(content)
  return {
    type: 'terminal.input',
    terminalId,
    data,
    ...(expectedSessionRef ? { expectedSessionRef } : {}),
  }
}

export function buildTerminalResizeMessage(
  content: TerminalPaneContent | null | undefined,
  terminalId: string,
  cols: number,
  rows: number,
): {
  type: 'terminal.resize'
  terminalId: string
  cols: number
  rows: number
  expectedSessionRef?: SessionLocator
} {
  const expectedSessionRef = getExpectedSessionRefForTerminalOperation(content)
  return {
    type: 'terminal.resize',
    terminalId,
    cols,
    rows,
    ...(expectedSessionRef ? { expectedSessionRef } : {}),
  }
}

export function buildTerminalAttachMessage(input: {
  content: TerminalPaneContent | null | undefined
  terminalId: string
  intent: 'viewport_hydrate' | 'keepalive_delta' | 'transport_reconnect'
  cols: number
  rows: number
  sinceSeq: number
  attachRequestId: string
  priority: 'foreground' | 'background'
  maxReplayBytes?: number
}): {
  type: 'terminal.attach'
  terminalId: string
  intent: 'viewport_hydrate' | 'keepalive_delta' | 'transport_reconnect'
  cols: number
  rows: number
  sinceSeq: number
  attachRequestId: string
  priority: 'foreground' | 'background'
  maxReplayBytes?: number
  expectedSessionRef?: SessionLocator
} {
  const expectedSessionRef = getExpectedSessionRefForTerminalOperation(input.content)
  return {
    type: 'terminal.attach',
    terminalId: input.terminalId,
    intent: input.intent,
    cols: input.cols,
    rows: input.rows,
    sinceSeq: input.sinceSeq,
    attachRequestId: input.attachRequestId,
    priority: input.priority,
    ...(input.maxReplayBytes ? { maxReplayBytes: input.maxReplayBytes } : {}),
    ...(expectedSessionRef ? { expectedSessionRef } : {}),
  }
}

export function buildCodexIdentityMismatchRepairContent(
  content: TerminalPaneContent | null | undefined,
  expectedSessionRef: SessionLocator,
  createRequestId: string,
): Partial<TerminalPaneContent> | undefined {
  if (!content) return undefined
  const matchingDurableCodexIdentity = expectedSessionRef.provider === 'codex'
    && content.codexDurability?.state === 'durable'
    && content.codexDurability.durableThreadId === expectedSessionRef.sessionId
      ? content.codexDurability
      : undefined
  return {
    terminalId: undefined,
    serverInstanceId: undefined,
    streamId: undefined,
    createRequestId,
    status: 'creating',
    sessionRef: expectedSessionRef,
    codexDurability: matchingDurableCodexIdentity,
  }
}
