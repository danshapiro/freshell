import { EventEmitter } from 'events'
import type { SessionBindingReason } from '../terminal-stream/registry-events.js'
import type { BindSessionResult, TerminalRecord } from '../terminal-registry.js'
import { logger } from '../logger.js'
import type {
  OpencodeAssociationRequestedEvent,
} from './opencode-activity-tracker.js'

type OpencodeActivityTrackerLike = {
  confirmSessionAssociation: (input: { terminalId: string; sessionId: string }) => void
  rejectSessionAssociation: (input: { terminalId: string; sessionId: string }) => void
  on: (event: 'association.requested', handler: (payload: OpencodeAssociationRequestedEvent) => void) => void
  off: (event: 'association.requested', handler: (payload: OpencodeAssociationRequestedEvent) => void) => void
}

type OpencodeSessionRegistry = {
  get: (terminalId: string) => TerminalRecord | undefined | null
  bindSession: (
    terminalId: string,
    provider: 'opencode',
    sessionId: string,
    reason?: SessionBindingReason,
  ) => BindSessionResult
  on: (event: 'terminal.exit', handler: (payload: { terminalId?: string }) => void) => void
  off: (event: 'terminal.exit', handler: (payload: { terminalId?: string }) => void) => void
}

type ControllerLogger = {
  warn: (payload: object, message?: string) => void
}

export type OpencodeSessionAssociatedEvent = {
  terminalId: string
  sessionId: string
}

export class OpencodeSessionController extends EventEmitter {
  private readonly tracker: OpencodeActivityTrackerLike
  private readonly registry: OpencodeSessionRegistry
  private readonly log: ControllerLogger
  private readonly associatedSessionIds = new Map<string, string>()

  private readonly handleAssociationRequested = (payload: OpencodeAssociationRequestedEvent) => {
    this.promoteAssociation(payload)
  }

  private readonly handleTerminalExit = (payload: { terminalId?: string }) => {
    if (!payload.terminalId) return
    this.associatedSessionIds.delete(payload.terminalId)
  }

  constructor(input: {
    tracker: OpencodeActivityTrackerLike
    registry: OpencodeSessionRegistry
    log?: ControllerLogger
  }) {
    super()
    this.tracker = input.tracker
    this.registry = input.registry
    this.log = input.log ?? logger.child({ component: 'opencode-session-controller' })

    this.tracker.on('association.requested', this.handleAssociationRequested)
    this.registry.on('terminal.exit', this.handleTerminalExit)
  }

  dispose(): void {
    this.tracker.off('association.requested', this.handleAssociationRequested)
    this.registry.off('terminal.exit', this.handleTerminalExit)
    this.associatedSessionIds.clear()
  }

  private rejectAssociation(
    request: OpencodeAssociationRequestedEvent,
    reason: string,
    extra: Record<string, unknown> = {},
  ): void {
    this.log.warn({
      terminalId: request.terminalId,
      sessionId: request.sessionId,
      reason,
      ...extra,
    }, 'Rejected OpenCode association request')
  }

  private promoteAssociation(request: OpencodeAssociationRequestedEvent): void {
    const terminal = this.registry.get(request.terminalId)
    if (!terminal) {
      this.rejectAssociation(request, 'terminal_missing_or_not_running')
      this.tracker.rejectSessionAssociation(request)
      return
    }
    if (terminal.mode !== 'opencode') {
      this.rejectAssociation(request, 'terminal_not_opencode', { mode: terminal.mode })
      this.tracker.rejectSessionAssociation(request)
      return
    }
    if (terminal.status !== 'running') {
      this.rejectAssociation(request, 'terminal_missing_or_not_running', { status: terminal.status })
      this.tracker.rejectSessionAssociation(request)
      return
    }

    const previousSessionId = this.associatedSessionIds.get(request.terminalId) ?? terminal.resumeSessionId
    if (previousSessionId === request.sessionId) {
      this.associatedSessionIds.set(request.terminalId, request.sessionId)
      this.tracker.confirmSessionAssociation(request)
      return
    }

    const result = this.registry.bindSession(request.terminalId, 'opencode', request.sessionId, 'association')

    if (!result.ok) {
      this.rejectAssociation(request, result.reason, {
        ...(previousSessionId ? { previousSessionId } : {}),
        ...('owner' in result ? { ownerTerminalId: result.owner } : {}),
      })
      this.tracker.rejectSessionAssociation(request)
      return
    }

    this.associatedSessionIds.set(request.terminalId, request.sessionId)
    this.emit('associated', {
      terminalId: request.terminalId,
      sessionId: request.sessionId,
    } satisfies OpencodeSessionAssociatedEvent)
    this.tracker.confirmSessionAssociation(request)
  }
}
