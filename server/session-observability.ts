import { sessionLifecycleLogger } from './logger.js'
import type { CodingCliProviderName } from './coding-cli/types.js'
import type { TerminalMode } from './terminal-registry.js'

type SessionLifecycleSink = Pick<typeof sessionLifecycleLogger, 'info' | 'warn'>

type OptionalUiContext = {
  tabId?: string
  paneId?: string
  cwd?: string
}

export type SessionLifecycleEvent =
  | (OptionalUiContext & {
    kind: 'terminal_create_requested'
    requestId: string
    connectionId: string
    mode: TerminalMode
    restoreRequested: boolean
    hasRequestedSessionRef: boolean
    requestedSessionId?: string
  })
  | (OptionalUiContext & {
    kind: 'terminal_created'
    requestId: string
    connectionId: string
    terminalId: string
    mode: TerminalMode
    reused: boolean
    hasSessionRef: boolean
  })
  | (OptionalUiContext & {
    kind: 'restore_unavailable'
    requestId: string
    connectionId: string
    mode: TerminalMode
    reason: 'missing_canonical_session_id'
    restoreRequested: true
    hasSessionRef: boolean
  })
  | (OptionalUiContext & {
    kind: 'restore_unavailable_fresh_fallback'
    requestId: string
    connectionId: string
    mode: TerminalMode
    reason: 'fresh_after_restore_unavailable'
    restoreRequested: false
    treatedAsFresh: true
    hasSessionRef: false
  })
  | {
    kind: 'codex_durable_session_observed'
    provider: 'codex'
    terminalId: string
    sessionId: string
    generation: number
    attemptId?: string
    source: 'sidecar'
  }
  | {
    kind: 'session_association_broadcast'
    provider: CodingCliProviderName
    terminalId: string
    sessionId: string
    source: 'indexer_update' | 'claude_new_session' | 'opencode_controller'
  }
  | {
    kind: 'terminal_session_bound'
    provider: CodingCliProviderName
    terminalId: string
    sessionId: string
    reason: string
  }
  | {
    kind: 'terminal_exit_without_durable_session'
    terminalId: string
    mode: TerminalMode
    exitCode: number
    ageMs: number
    reason: 'pty_exit' | 'user_final_close'
    ptyPid?: number
    codexRecoveryState?: string
  }
  | (OptionalUiContext & {
    kind: 'invalid_terminal_id_without_session_ref'
    provider?: CodingCliProviderName
    terminalId: string
    connectionId: string
    operation:
      | 'terminal.attach'
      | 'terminal.input'
      | 'terminal.resize'
      | 'terminal.detach'
      | 'terminal.kill'
    attemptedInputBytes?: number
  })
  | (OptionalUiContext & {
    kind: 'client_restore_unavailable'
    terminalId?: string
    sessionId?: string
    connectionId: string
    mode?: string
    reason:
      | 'dead_live_handle'
      | 'restore_internal'
      | 'restore_not_found'
      | 'restore_unavailable'
    hasSessionRef: boolean
  })

let sink: SessionLifecycleSink = sessionLifecycleLogger

export function __setSessionLifecycleLoggerForTest(next: SessionLifecycleSink): void {
  sink = next
}

function isIncidentEvent(kind: SessionLifecycleEvent['kind']): boolean {
  return kind === 'terminal_exit_without_durable_session'
    || kind === 'invalid_terminal_id_without_session_ref'
    || kind === 'client_restore_unavailable'
    || kind === 'restore_unavailable'
    || kind === 'restore_unavailable_fresh_fallback'
}

function buildPayload(event: SessionLifecycleEvent): Record<string, unknown> {
  const base = {
    event: 'session_lifecycle',
    observedAt: new Date().toISOString(),
    kind: event.kind,
  }

  switch (event.kind) {
    case 'terminal_create_requested':
      return {
        ...base,
        requestId: event.requestId,
        connectionId: event.connectionId,
        tabId: event.tabId,
        paneId: event.paneId,
        cwd: event.cwd,
        mode: event.mode,
        restoreRequested: event.restoreRequested,
        hasRequestedSessionRef: event.hasRequestedSessionRef,
        requestedSessionId: event.requestedSessionId,
      }
    case 'terminal_created':
      return {
        ...base,
        requestId: event.requestId,
        connectionId: event.connectionId,
        terminalId: event.terminalId,
        tabId: event.tabId,
        paneId: event.paneId,
        cwd: event.cwd,
        mode: event.mode,
        reused: event.reused,
        hasSessionRef: event.hasSessionRef,
      }
    case 'restore_unavailable':
      return {
        ...base,
        requestId: event.requestId,
        connectionId: event.connectionId,
        tabId: event.tabId,
        paneId: event.paneId,
        mode: event.mode,
        reason: event.reason,
        restoreRequested: event.restoreRequested,
        hasSessionRef: event.hasSessionRef,
      }
    case 'restore_unavailable_fresh_fallback':
      return {
        ...base,
        requestId: event.requestId,
        connectionId: event.connectionId,
        tabId: event.tabId,
        paneId: event.paneId,
        mode: event.mode,
        reason: event.reason,
        restoreRequested: event.restoreRequested,
        treatedAsFresh: event.treatedAsFresh,
        hasSessionRef: event.hasSessionRef,
      }
    case 'codex_durable_session_observed':
      return {
        ...base,
        provider: event.provider,
        terminalId: event.terminalId,
        sessionId: event.sessionId,
        generation: event.generation,
        attemptId: event.attemptId,
        source: event.source,
      }
    case 'session_association_broadcast':
      return {
        ...base,
        provider: event.provider,
        terminalId: event.terminalId,
        sessionId: event.sessionId,
        source: event.source,
      }
    case 'terminal_session_bound':
      return {
        ...base,
        provider: event.provider,
        terminalId: event.terminalId,
        sessionId: event.sessionId,
        reason: event.reason,
      }
    case 'terminal_exit_without_durable_session':
      return {
        ...base,
        terminalId: event.terminalId,
        mode: event.mode,
        exitCode: event.exitCode,
        ageMs: event.ageMs,
        reason: event.reason,
        ptyPid: event.ptyPid,
        codexRecoveryState: event.codexRecoveryState,
      }
    case 'invalid_terminal_id_without_session_ref':
      return {
        ...base,
        provider: event.provider,
        terminalId: event.terminalId,
        connectionId: event.connectionId,
        tabId: event.tabId,
        paneId: event.paneId,
        cwd: event.cwd,
        operation: event.operation,
        attemptedInputBytes: event.attemptedInputBytes,
      }
    case 'client_restore_unavailable':
      return {
        ...base,
        terminalId: event.terminalId,
        sessionId: event.sessionId,
        connectionId: event.connectionId,
        tabId: event.tabId,
        paneId: event.paneId,
        cwd: event.cwd,
        mode: event.mode,
        reason: event.reason,
        hasSessionRef: event.hasSessionRef,
      }
  }
}

export function recordSessionLifecycleEvent(event: SessionLifecycleEvent): void {
  const payload = buildPayload(event)
  if (isIncidentEvent(event.kind)) {
    sink.warn(payload, event.kind)
  } else {
    sink.info(payload, event.kind)
  }
}
