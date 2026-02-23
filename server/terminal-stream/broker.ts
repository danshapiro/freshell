import WebSocket from 'ws'
import type { LiveWebSocket } from '../ws-handler.js'
import type { TerminalRegistry } from '../terminal-registry.js'
import { logger } from '../logger.js'
import { logTerminalStreamPerfEvent, type TerminalStreamPerfEvent } from '../perf-logger.js'
import type { TerminalOutputRawEvent } from './registry-events.js'
import { ClientOutputQueue, isGapEvent, type GapEvent } from './client-output-queue.js'
import { ReplayRing, type ReplayFrame } from './replay-ring.js'
import {
  TERMINAL_STREAM_BATCH_MAX_BYTES,
  TERMINAL_STREAM_RETRY_FLUSH_MS,
  TERMINAL_WS_CATASTROPHIC_BUFFERED_BYTES,
  TERMINAL_WS_CATASTROPHIC_STALL_MS,
} from './constants.js'
import type { BrokerClientAttachment, BrokerTerminalState } from './types.js'

const log = logger.child({ component: 'terminal-stream-broker' })

type CreatedEnvelope = {
  requestId: string
  terminalId: string
  createdAt: number
  effectiveResumeSessionId?: string
}

type PerfLevel = 'debug' | 'info' | 'warn' | 'error'
type PerfEventLogger = (
  event: TerminalStreamPerfEvent,
  context: Record<string, unknown>,
  level?: PerfLevel,
) => void

export class TerminalStreamBroker {
  private terminals = new Map<string, BrokerTerminalState>()
  private wsToTerminals = new Map<LiveWebSocket, Set<string>>()
  private terminalLocks = new Map<string, Promise<void>>()

  private readonly onRawOutputBound = (event: TerminalOutputRawEvent) => {
    this.onTerminalOutputRaw(event)
  }

  private readonly onTerminalExitBound = (payload: { terminalId?: string }) => {
    const terminalId = payload?.terminalId
    if (typeof terminalId === 'string' && terminalId) {
      this.handleTerminalExit(terminalId)
    }
  }

  constructor(
    private registry: TerminalRegistry,
    private perfEventLogger: PerfEventLogger = logTerminalStreamPerfEvent,
  ) {
    const eventSource = this.registry as unknown as {
      on?: (event: string, listener: (...args: any[]) => void) => void
    }
    if (typeof eventSource.on === 'function') {
      eventSource.on('terminal.output.raw', this.onRawOutputBound)
      eventSource.on('terminal.exit', this.onTerminalExitBound)
    }
  }

  close(): void {
    const eventSource = this.registry as unknown as {
      off?: (event: string, listener: (...args: any[]) => void) => void
    }
    if (typeof eventSource.off === 'function') {
      eventSource.off('terminal.output.raw', this.onRawOutputBound)
      eventSource.off('terminal.exit', this.onTerminalExitBound)
    }
    for (const state of this.terminals.values()) {
      for (const attachment of state.clients.values()) {
        if (attachment.flushTimer) clearTimeout(attachment.flushTimer)
      }
      state.clients.clear()
    }
    this.terminals.clear()
    this.wsToTerminals.clear()
    this.terminalLocks.clear()
  }

  async sendCreatedAndAttach(
    ws: LiveWebSocket,
    created: CreatedEnvelope,
    sinceSeq: number | undefined = 0,
  ): Promise<boolean> {
    const createdMsg: CreatedEnvelope & { type: 'terminal.created' } = {
      type: 'terminal.created',
      ...created,
    }

    if (!this.safeSend(ws, createdMsg)) return false
    return await this.attach(ws, created.terminalId, sinceSeq)
  }

  async attach(
    ws: LiveWebSocket,
    terminalId: string,
    sinceSeq: number | undefined,
    attachRequestId?: string,
  ): Promise<boolean> {
    const record = this.registry.attach(terminalId, ws, { suppressOutput: true })
    if (!record) return false

    const terminalState = this.getOrCreateTerminalState(terminalId)
    const attachment = this.getOrCreateAttachment(terminalState, ws, terminalId)
    const normalizedSinceSeq = sinceSeq === undefined || sinceSeq === 0 ? 0 : sinceSeq

    await this.withTerminalLock(terminalId, async () => {
      if (attachment.flushTimer) {
        clearTimeout(attachment.flushTimer)
        attachment.flushTimer = null
      }

      attachment.mode = 'attaching'
      attachment.activeAttachRequestId = attachRequestId
      attachment.attachStaging = []
      attachment.queue.clear()

      // Seed from the existing terminal buffer if this terminal predates broker wiring.
      if (terminalState.replayRing.headSeq() === 0) {
        const snapshot = record.buffer.snapshot()
        if (snapshot) {
          terminalState.replayRing.append(snapshot)
        }
      }

      const replay = terminalState.replayRing.replaySince(normalizedSinceSeq)
      const replayFrames = replay.frames
      const headSeq = terminalState.replayRing.headSeq()
      const replayFromSeq = replayFrames.length > 0 ? replayFrames[0].seqStart : headSeq + 1
      const replayToSeq = replayFrames.length > 0 ? replayFrames[replayFrames.length - 1].seqEnd : headSeq

      if (replayFrames.length > 0 && replay.missedFromSeq === undefined) {
        this.perfEventLogger('terminal_stream_replay_hit', {
          terminalId,
          connectionId: ws.connectionId,
          sinceSeq: normalizedSinceSeq,
          replayFromSeq,
          replayToSeq,
          replayFrameCount: replayFrames.length,
        })
      }

      if (!this.safeSend(ws, {
        type: 'terminal.attach.ready',
        terminalId,
        headSeq,
        replayFromSeq,
        replayToSeq,
        ...(attachment.activeAttachRequestId ? { attachRequestId: attachment.activeAttachRequestId } : {}),
      })) {
        return
      }

      if (replay.missedFromSeq !== undefined) {
        const missedToSeq = replayFromSeq - 1
        if (missedToSeq >= replay.missedFromSeq) {
          this.perfEventLogger('terminal_stream_replay_miss', {
            terminalId,
            connectionId: ws.connectionId,
            sinceSeq: normalizedSinceSeq,
            missedFromSeq: replay.missedFromSeq,
            missedToSeq,
            replayFromSeq,
            replayToSeq,
          }, 'warn')

          this.perfEventLogger('terminal_stream_gap', {
            terminalId,
            connectionId: ws.connectionId,
            fromSeq: replay.missedFromSeq,
            toSeq: missedToSeq,
            reason: 'replay_window_exceeded',
          }, 'warn')

          if (!this.safeSend(ws, {
            type: 'terminal.output.gap',
            terminalId,
            fromSeq: replay.missedFromSeq,
            toSeq: missedToSeq,
            reason: 'replay_window_exceeded',
            ...(attachment.activeAttachRequestId ? { attachRequestId: attachment.activeAttachRequestId } : {}),
          })) {
            return
          }
          attachment.lastSeq = Math.max(attachment.lastSeq, missedToSeq)
        }
      }

      for (const frame of replayFrames) {
        if (!this.sendFrame(ws, terminalId, frame, attachment.activeAttachRequestId)) return
        attachment.lastSeq = Math.max(attachment.lastSeq, frame.seqEnd)
      }

      const staged = attachment.attachStaging.filter((frame) => frame.seqStart > replayToSeq)
      attachment.attachStaging = []
      for (const frame of staged) {
        if (!this.sendFrame(ws, terminalId, frame, attachment.activeAttachRequestId)) return
        attachment.lastSeq = Math.max(attachment.lastSeq, frame.seqEnd)
      }

      attachment.mode = 'live'
      const residual = attachment.attachStaging.filter((frame) => frame.seqStart > attachment.lastSeq)
      attachment.attachStaging = []
      for (const frame of residual) {
        attachment.queue.enqueue(frame)
      }
      if (attachment.queue.pendingBytes() > 0) {
        this.scheduleFlush(terminalId, attachment)
      }
    })

    return true
  }

  detach(terminalId: string, ws: LiveWebSocket): boolean {
    const state = this.terminals.get(terminalId)
    if (!state) {
      return this.registry.detach(terminalId, ws)
    }

    const attachment = state.clients.get(ws)
    if (attachment?.flushTimer) {
      clearTimeout(attachment.flushTimer)
      attachment.flushTimer = null
    }

    state.clients.delete(ws)
    this.unregisterWsTerminal(ws, terminalId)
    this.registry.detach(terminalId, ws)
    return true
  }

  detachAllForSocket(ws: LiveWebSocket): void {
    const terminalIds = this.wsToTerminals.get(ws)
    if (!terminalIds) return
    for (const terminalId of Array.from(terminalIds)) {
      this.detach(terminalId, ws)
    }
    this.wsToTerminals.delete(ws)
  }

  getAttachedClientCount(terminalId: string): number {
    return this.terminals.get(terminalId)?.clients.size || 0
  }

  private getOrCreateTerminalState(terminalId: string): BrokerTerminalState {
    const replayRingMaxBytes = this.resolveReplayRingMaxBytes()
    let state = this.terminals.get(terminalId)
    if (!state) {
      state = {
        replayRing: new ReplayRing(replayRingMaxBytes),
        clients: new Map(),
      }
      this.terminals.set(terminalId, state)
    } else {
      state.replayRing.setMaxBytes(replayRingMaxBytes)
    }
    return state
  }

  private resolveReplayRingMaxBytes(): number | undefined {
    // Some tests inject lightweight registry doubles that may omit this method.
    // Fall back to ReplayRing defaults when no budget provider is available.
    const getReplayRingMaxChars = (
      this.registry as Partial<{ getReplayRingMaxChars: () => number | undefined }>
    ).getReplayRingMaxChars
    if (typeof getReplayRingMaxChars !== 'function') {
      return undefined
    }

    // TerminalRegistry clamp is character-based; reusing the same numeric
    // budget as bytes keeps replay retention conservative.
    const value = getReplayRingMaxChars.call(this.registry)
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return undefined
    }
    return Math.floor(value)
  }

  private getOrCreateAttachment(
    terminalState: BrokerTerminalState,
    ws: LiveWebSocket,
    terminalId: string,
  ): BrokerClientAttachment {
    let attachment = terminalState.clients.get(ws)
    if (!attachment) {
      attachment = {
        ws,
        mode: 'live',
        queue: new ClientOutputQueue(),
        attachStaging: [],
        lastSeq: 0,
        flushTimer: null,
        catastrophicClosed: false,
      }
      terminalState.clients.set(ws, attachment)
      this.registerWsTerminal(ws, terminalId)
    }
    return attachment
  }

  private registerWsTerminal(ws: LiveWebSocket, terminalId: string): void {
    const existing = this.wsToTerminals.get(ws) || new Set<string>()
    existing.add(terminalId)
    this.wsToTerminals.set(ws, existing)
  }

  private unregisterWsTerminal(ws: LiveWebSocket, terminalId: string): void {
    const existing = this.wsToTerminals.get(ws)
    if (!existing) return
    existing.delete(terminalId)
    if (existing.size === 0) this.wsToTerminals.delete(ws)
  }

  private onTerminalOutputRaw(event: TerminalOutputRawEvent): void {
    const state = this.getOrCreateTerminalState(event.terminalId)
    const frame = state.replayRing.append(event.data)

    for (const attachment of state.clients.values()) {
      if (attachment.mode === 'attaching') {
        attachment.attachStaging.push(frame)
        continue
      }
      attachment.queue.enqueue(frame)
      this.scheduleFlush(event.terminalId, attachment)
    }
  }

  private scheduleFlush(
    terminalId: string,
    attachment: BrokerClientAttachment,
    delayMs = 0,
  ): void {
    if (attachment.flushTimer) return
    attachment.flushTimer = setTimeout(() => {
      attachment.flushTimer = null
      this.flushAttachment(terminalId, attachment)
    }, delayMs)
  }

  private flushAttachment(terminalId: string, attachment: BrokerClientAttachment): void {
    if (attachment.mode !== 'live') return
    const { ws } = attachment
    if (ws.readyState !== WebSocket.OPEN) {
      this.detach(terminalId, ws)
      return
    }

    if (this.catastrophicBlocked(terminalId, attachment)) {
      if (attachment.catastrophicClosed) {
        this.detach(terminalId, ws)
        return
      }
      if (attachment.queue.pendingBytes() > 0) {
        this.scheduleFlush(terminalId, attachment, TERMINAL_STREAM_RETRY_FLUSH_MS)
      }
      return
    }

    const pendingBytes = attachment.queue.pendingBytes()
    if (pendingBytes > TERMINAL_STREAM_BATCH_MAX_BYTES) {
      this.perfEventLogger('terminal_stream_queue_pressure', {
        terminalId,
        connectionId: ws.connectionId,
        pendingBytes,
        batchMaxBytes: TERMINAL_STREAM_BATCH_MAX_BYTES,
        bufferedAmount: ws.bufferedAmount,
      }, 'warn')
    }

    const batch = attachment.queue.nextBatch(TERMINAL_STREAM_BATCH_MAX_BYTES)
    if (batch.length === 0) return

    const attachRequestId = attachment.activeAttachRequestId
    for (const item of batch) {
      if (isGapEvent(item)) {
        if (!this.sendGap(ws, terminalId, item, attachRequestId)) return
        attachment.lastSeq = Math.max(attachment.lastSeq, item.toSeq)
        continue
      }

      if (!this.sendFrame(ws, terminalId, item, attachRequestId)) return
      attachment.lastSeq = Math.max(attachment.lastSeq, item.seqEnd)
    }

    if (attachment.queue.pendingBytes() > 0) {
      this.scheduleFlush(terminalId, attachment)
    }
  }

  private catastrophicBlocked(terminalId: string, attachment: BrokerClientAttachment): boolean {
    if (attachment.catastrophicClosed) return true

    const wsBuffered = attachment.ws.bufferedAmount as number | undefined
    const buffered = typeof wsBuffered === 'number' ? wsBuffered : 0
    const now = Date.now()

    if (buffered <= TERMINAL_WS_CATASTROPHIC_BUFFERED_BYTES) {
      attachment.catastrophicSince = undefined
      attachment.catastrophicClosed = false
      return false
    }

    if (attachment.catastrophicSince === undefined) {
      attachment.catastrophicSince = now
      return true
    }

    if (now - attachment.catastrophicSince < TERMINAL_WS_CATASTROPHIC_STALL_MS) {
      return true
    }

    attachment.catastrophicClosed = true
    this.perfEventLogger('terminal_stream_catastrophic_close', {
      terminalId,
      connectionId: attachment.ws.connectionId,
      bufferedAmount: buffered,
      threshold: TERMINAL_WS_CATASTROPHIC_BUFFERED_BYTES,
      stallMs: now - attachment.catastrophicSince,
    }, 'warn')

    try {
      attachment.ws.close(4008, 'Catastrophic backpressure')
    } catch {
      // ignore
    }
    log.warn({
      connectionId: attachment.ws.connectionId,
      bufferedAmount: buffered,
      threshold: TERMINAL_WS_CATASTROPHIC_BUFFERED_BYTES,
      stallMs: now - attachment.catastrophicSince,
    }, 'Closing websocket due to sustained catastrophic backpressure')
    return true
  }

  private sendFrame(
    ws: LiveWebSocket,
    terminalId: string,
    frame: ReplayFrame,
    attachRequestId?: string,
  ): boolean {
    return this.safeSend(ws, {
      type: 'terminal.output',
      terminalId,
      seqStart: frame.seqStart,
      seqEnd: frame.seqEnd,
      data: frame.data,
      ...(attachRequestId ? { attachRequestId } : {}),
    })
  }

  private sendGap(
    ws: LiveWebSocket,
    terminalId: string,
    gap: GapEvent,
    attachRequestId?: string,
  ): boolean {
    this.perfEventLogger('terminal_stream_gap', {
      terminalId,
      connectionId: ws.connectionId,
      fromSeq: gap.fromSeq,
      toSeq: gap.toSeq,
      reason: gap.reason,
    }, gap.reason === 'queue_overflow' ? 'warn' : 'info')

    return this.safeSend(ws, {
      type: 'terminal.output.gap',
      terminalId,
      fromSeq: gap.fromSeq,
      toSeq: gap.toSeq,
      reason: gap.reason,
      ...(attachRequestId ? { attachRequestId } : {}),
    })
  }

  private safeSend(ws: LiveWebSocket, msg: unknown): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false
    try {
      ws.send(JSON.stringify(msg))
      return true
    } catch {
      return false
    }
  }

  private handleTerminalExit(terminalId: string): void {
    const state = this.terminals.get(terminalId)
    if (!state) return
    for (const attachment of state.clients.values()) {
      if (attachment.flushTimer) clearTimeout(attachment.flushTimer)
      this.unregisterWsTerminal(attachment.ws, terminalId)
    }
    state.clients.clear()
    this.terminals.delete(terminalId)
  }

  private withTerminalLock(terminalId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.terminalLocks.get(terminalId) ?? Promise.resolve()

    let current: Promise<void>
    current = previous
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        if (this.terminalLocks.get(terminalId) === current) {
          this.terminalLocks.delete(terminalId)
        }
      })

    this.terminalLocks.set(terminalId, current)
    return current
  }
}
