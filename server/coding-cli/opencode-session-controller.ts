import { EventEmitter } from 'events'
import type { SessionBindingReason } from '../terminal-stream/registry-events.js'
import type { BindSessionResult, TerminalRecord } from '../terminal-registry.js'
import { logger } from '../logger.js'
import type {
  OpencodeActivityChange,
  OpencodeActivityRecord,
} from './opencode-activity-tracker.js'

type OpencodeActivityTrackerLike = {
  list: () => OpencodeActivityRecord[]
  on: (event: 'changed', handler: (payload: OpencodeActivityChange) => void) => void
  off: (event: 'changed', handler: (payload: OpencodeActivityChange) => void) => void
}

type OpencodeSessionRegistry = {
  get: (terminalId: string) => TerminalRecord | undefined | null
  bindSession: (
    terminalId: string,
    provider: 'opencode',
    sessionId: string,
    reason?: SessionBindingReason,
  ) => BindSessionResult
  rebindSession?: (
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

  private readonly handleTrackerChanged = (payload: OpencodeActivityChange) => {
    for (const record of payload.upsert) {
      this.promoteRecord(record)
    }
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

    this.tracker.on('changed', this.handleTrackerChanged)
    this.registry.on('terminal.exit', this.handleTerminalExit)

    const existing = this.tracker.list()
    if (existing.length > 0) {
      this.handleTrackerChanged({
        upsert: existing,
        remove: [],
      })
    }
  }

  dispose(): void {
    this.tracker.off('changed', this.handleTrackerChanged)
    this.registry.off('terminal.exit', this.handleTerminalExit)
    this.associatedSessionIds.clear()
  }

  private promoteRecord(record: OpencodeActivityRecord): void {
    if (!record.sessionId) return

    const terminal = this.registry.get(record.terminalId)
    if (!terminal || terminal.mode !== 'opencode' || terminal.status !== 'running') {
      return
    }

    const previousSessionId = this.associatedSessionIds.get(record.terminalId) ?? terminal.resumeSessionId
    if (previousSessionId === record.sessionId) {
      this.associatedSessionIds.set(record.terminalId, record.sessionId)
      return
    }

    const bind = previousSessionId && this.registry.rebindSession
      ? this.registry.rebindSession.bind(this.registry)
      : this.registry.bindSession.bind(this.registry)
    const result = bind(record.terminalId, 'opencode', record.sessionId, 'association')

    if (!result.ok) {
      this.log.warn({
        terminalId: record.terminalId,
        sessionId: record.sessionId,
        reason: result.reason,
      }, 'Failed to promote OpenCode durable session from authoritative control data')
      return
    }

    this.associatedSessionIds.set(record.terminalId, record.sessionId)
    this.emit('associated', {
      terminalId: record.terminalId,
      sessionId: record.sessionId,
    } satisfies OpencodeSessionAssociatedEvent)
  }
}
