import type { CodingCliProviderName } from '../../shared/ws-protocol.js'

export type SessionBindingReason = 'start' | 'resume' | 'association'
export type SessionUnbindReason = 'exit' | 'rebind' | 'stale_owner' | 'repair_duplicate'

export type TerminalInputRawEvent = {
  terminalId: string
  data: string
  at: number
}

export type TerminalOutputRawEvent = {
  terminalId: string
  data: string
  at: number
}

export type TerminalSessionBoundEvent = {
  terminalId: string
  provider: CodingCliProviderName
  sessionId: string
  reason: SessionBindingReason
  /**
   * Present ONLY on a server-authoritative mid-session rebind (e.g. codex fork
   * handoff). Names the session id this binding supersedes so the
   * terminal.session.associated fanout can carry it as previousSessionId.
   */
  previousSessionId?: string
}

export type TerminalSessionUnboundEvent = {
  terminalId: string
  provider: CodingCliProviderName
  sessionId: string
  reason: SessionUnbindReason
}

export type CodexTurnStartedEvent = {
  terminalId: string
  /**
   * The codex thread that emitted `turn/started` -- NOT necessarily the
   * terminal's bound thread: sub-agent, review, and fork threads share the
   * app-server connection (kata codex-turn-thread-scope, spike scenario D).
   * Consumers MUST scope by the terminal's bound session id.
   */
  threadId: string
  turnId?: string
  at: number
}

export type CodexTurnCompletedEvent = {
  terminalId: string
  /** See CodexTurnStartedEvent.threadId -- may be a foreign thread. */
  threadId: string
  turnId?: string
  /**
   * Raw turn status: 'completed' | 'interrupted' | 'failed' | 'inProgress'
   * (absent on older protocol forms). Only 'completed' is a positive,
   * bell-worthy completion -- see shared/ws-protocol.ts terminal.idle.
   */
  status?: string
  at: number
}
