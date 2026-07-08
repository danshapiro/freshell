/**
 * AmplifierSessionController — thin bind gatekeeper for locator-discovered
 * fresh amplifier sessions (docs/plans/2026-07-08-amplifier-session-durability-plan.md
 * §5 step 5, Phase 3). Imitates OpencodeSessionController: validates the
 * terminal (exists, mode === 'amplifier', status === 'running', not already
 * session-bound), then binds through the shared
 * registry.bindSession(terminalId, 'amplifier', sessionId, 'association') path
 * and emits 'associated' so index.ts can broadcast via
 * broadcastTerminalSessionAssociation({ source: 'amplifier_locator' }) and the
 * activity integration can attach the events tailer at offset 0.
 *
 * Never hand-rolls binding or broadcasts; every reject path is logged.
 */

import { EventEmitter } from 'events'
import { logger } from '../logger.js'
import type { SessionBindingReason } from '../terminal-stream/registry-events.js'
import type { BindSessionResult } from '../terminal-registry.js'
import type { AmplifierSessionLocatedEvent } from './amplifier-session-locator.js'

type AmplifierLocatorLike = {
  on: (event: 'session.located', handler: (payload: AmplifierSessionLocatedEvent) => void) => unknown
  off: (event: 'session.located', handler: (payload: AmplifierSessionLocatedEvent) => void) => unknown
}

type AmplifierTerminalSnapshot = {
  terminalId: string
  mode: string
  status: string
  resumeSessionId?: string
}

type AmplifierSessionRegistry = {
  get: (terminalId: string) => AmplifierTerminalSnapshot | undefined | null
  bindSession: (
    terminalId: string,
    provider: 'amplifier',
    sessionId: string,
    reason?: SessionBindingReason,
  ) => BindSessionResult
}

type ControllerLogger = {
  warn: (payload: object, message?: string) => void
}

export type AmplifierSessionAssociatedEvent = {
  terminalId: string
  sessionId: string
  eventsPath: string
}

export class AmplifierSessionController extends EventEmitter {
  private readonly locator: AmplifierLocatorLike
  private readonly registry: AmplifierSessionRegistry
  private readonly log: ControllerLogger

  private readonly handleLocated = (payload: AmplifierSessionLocatedEvent) => {
    this.promote(payload)
  }

  constructor(input: {
    locator: AmplifierLocatorLike
    registry: AmplifierSessionRegistry
    log?: ControllerLogger
  }) {
    super()
    this.locator = input.locator
    this.registry = input.registry
    this.log = input.log ?? logger.child({ component: 'amplifier-session-controller' })

    this.locator.on('session.located', this.handleLocated)
  }

  dispose(): void {
    this.locator.off('session.located', this.handleLocated)
  }

  private reject(
    request: AmplifierSessionLocatedEvent,
    reason: string,
    extra: Record<string, unknown> = {},
  ): void {
    this.log.warn({
      terminalId: request.terminalId,
      sessionId: request.sessionId,
      reason,
      ...extra,
    }, 'Rejected Amplifier session association')
  }

  private promote(request: AmplifierSessionLocatedEvent): void {
    const terminal = this.registry.get(request.terminalId)
    if (!terminal) {
      this.reject(request, 'terminal_missing_or_not_running')
      return
    }
    if (terminal.mode !== 'amplifier') {
      this.reject(request, 'terminal_not_amplifier', { mode: terminal.mode })
      return
    }
    if (terminal.status !== 'running') {
      this.reject(request, 'terminal_missing_or_not_running', { status: terminal.status })
      return
    }
    if (terminal.resumeSessionId) {
      this.reject(request, 'terminal_already_bound', { previousSessionId: terminal.resumeSessionId })
      return
    }

    const result = this.registry.bindSession(request.terminalId, 'amplifier', request.sessionId, 'association')
    if (!result.ok) {
      this.reject(request, result.reason, 'owner' in result ? { ownerTerminalId: result.owner } : {})
      return
    }

    this.emit('associated', {
      terminalId: request.terminalId,
      sessionId: request.sessionId,
      eventsPath: request.eventsPath,
    } satisfies AmplifierSessionAssociatedEvent)
  }
}
