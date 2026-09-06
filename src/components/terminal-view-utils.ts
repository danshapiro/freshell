import type { SessionLocator, TerminalPaneContent } from '@/store/paneTypes'
import { sanitizeSessionRef } from '@shared/session-contract'

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
  tabId?: string
  intent: 'viewport_hydrate' | 'keepalive_delta' | 'transport_reconnect'
  cols: number
  rows: number
  sinceSeq: number
  attachRequestId: string
  priority: 'foreground' | 'background'
  maxReplayBytes?: number
  surfaceReset?: boolean
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
  surfaceReset?: boolean
  createRequestId?: string
  tabId?: string
} {
  const expectedSessionRef = getExpectedSessionRefForTerminalOperation(input.content)
  // Delta-r7-r2 (Finding F3): the attach carries the attaching pane's
  // createRequestId + tab so the server can re-stamp the terminal's Bound
  // ledger row onto THIS pane's identity (a sidebar reattach becomes the
  // row's pane key; the OLD pane's close record keeps covering only the old
  // pane).
  const createRequestId = input.content?.kind === 'terminal' && input.content.createRequestId
    ? input.content.createRequestId
    : undefined
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
    ...(input.surfaceReset ? { surfaceReset: true } : {}),
    ...(expectedSessionRef ? { expectedSessionRef } : {}),
    ...(createRequestId ? { createRequestId } : {}),
    ...(input.tabId ? { tabId: input.tabId } : {}),
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

function sessionRefsEqual(
  left?: { provider?: string; sessionId?: string },
  right?: { provider?: string; sessionId?: string },
): boolean {
  return left?.provider === right?.provider && left?.sessionId === right?.sessionId
}

/** The rebind swap window (sub-second: identity upsert -> ledger fsync ->
 *  broadcast -> client fold) can bounce in-flight input sent with the OLD
 *  ref. When the server's error echoes an actualSessionRef that already
 *  equals the pane's CURRENT sessionRef, the rebind fold has applied and
 *  this is a stale POST-fold bounce: suppress it silently (no notice, no
 *  repair). A bounce that OUTRUNS the fold stays visible by design (LB2
 *  residual, see the task notes). Unparseable/absent refs fail toward the
 *  visible path. */
export function isStaleSessionIdentityMismatch(
  currentSessionRef: unknown,
  actualSessionRef: unknown,
): boolean {
  const current = sanitizeSessionRef(currentSessionRef)
  const actual = sanitizeSessionRef(actualSessionRef)
  if (!current || !actual) return false
  return sessionRefsEqual(current, actual)
}
