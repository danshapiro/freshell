import WebSocket from 'ws'
import type { LiveWebSocket } from '../ws-handler.js'
import { buildTerminalSessionRef, type TerminalRegistry } from '../terminal-registry.js'
import { logger } from '../logger.js'
import { logTerminalStreamPerfEvent, type TerminalStreamPerfEvent } from '../perf-logger.js'
import type { TerminalOutputRawEvent } from './registry-events.js'
import { ClientOutputQueue, isGapEvent, type GapEvent } from './client-output-queue.js'
import { ReplayRing, type ReplayFrame } from './replay-ring.js'
import {
  isTerminalStreamAttachRequestIdWithinSerializedBudget,
  measureTerminalOutputPayloadBytes,
  TERMINAL_STREAM_ATTACH_REQUEST_ID_RESERVE_VALUE,
  type JsonPayload,
} from './serialized-budget.js'
import {
  createTerminalStreamIdentityTracker,
  type TerminalStreamReplacementReason,
} from './stream-identity.js'
import {
  TERMINAL_BACKGROUND_BUFFERED_PAUSE_BYTES,
  TERMINAL_BACKGROUND_RETRY_FLUSH_MS,
  TERMINAL_STREAM_BATCH_MAX_BYTES,
  TERMINAL_STREAM_RETRY_FLUSH_MS,
  TERMINAL_WS_CATASTROPHIC_BUFFERED_BYTES,
  TERMINAL_WS_CATASTROPHIC_STALL_MS,
} from './constants.js'
import type { BrokerClientAttachment, BrokerTerminalState } from './types.js'

const log = logger.child({ component: 'terminal-stream-broker' })
const CODING_CLI_MIN_REPLAY_RING_MAX_BYTES = Number(
  process.env.CODING_CLI_MIN_REPLAY_RING_MAX_BYTES || 8 * 1024 * 1024,
)
const TERMINAL_STREAM_BUDGET_SEQ_PLACEHOLDER = Number.MAX_SAFE_INTEGER

type PerfLevel = 'debug' | 'info' | 'warn' | 'error'
type AttachIntent = 'viewport_hydrate' | 'keepalive_delta' | 'transport_reconnect'
type AttachPriority = 'foreground' | 'background'
type PerfEventLogger = (
  event: TerminalStreamPerfEvent,
  context: Record<string, unknown>,
  level?: PerfLevel,
) => void

export class TerminalStreamBroker {
  private terminals = new Map<string, BrokerTerminalState>()
  private wsToTerminals = new Map<LiveWebSocket, Set<string>>()
  private terminalLocks = new Map<string, Promise<void>>()
  private streamIdentity = createTerminalStreamIdentityTracker()

  private readonly onRawOutputBound = (event: TerminalOutputRawEvent) => {
    this.onTerminalOutputRaw(event)
  }

  private readonly onStreamReplacedBound = (payload: {
    terminalId?: string
    reason?: TerminalStreamReplacementReason
  }) => {
    const terminalId = payload?.terminalId
    if (typeof terminalId !== 'string' || !terminalId) return
    this.replaceStreamIdentity(
      terminalId,
      payload.reason ?? 'server_restart_incompatible_retention',
    )
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
      eventSource.on('terminal.stream.replaced', this.onStreamReplacedBound)
      eventSource.on('terminal.exit', this.onTerminalExitBound)
    }
  }

  close(): void {
    const eventSource = this.registry as unknown as {
      off?: (event: string, listener: (...args: any[]) => void) => void
    }
    if (typeof eventSource.off === 'function') {
      eventSource.off('terminal.output.raw', this.onRawOutputBound)
      eventSource.off('terminal.stream.replaced', this.onStreamReplacedBound)
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

  async attach(
    ws: LiveWebSocket,
    terminalId: string,
    intent: AttachIntent,
    cols: number,
    rows: number,
    sinceSeq: number | undefined,
    attachRequestId?: string,
    maxReplayBytes?: number,
    priority: AttachPriority = 'foreground',
  ): Promise<'attached' | 'duplicate' | 'missing' | 'invalid_attach_request_id'> {
    if (!isTerminalStreamAttachRequestIdWithinSerializedBudget(attachRequestId)) {
      return 'invalid_attach_request_id'
    }

    const normalizedSinceSeq = sinceSeq === undefined || sinceSeq === 0 ? 0 : sinceSeq
    let result: 'attached' | 'duplicate' | 'missing' | 'invalid_attach_request_id' = 'attached'

    await this.withTerminalLock(terminalId, async () => {
      const existingState = this.terminals.get(terminalId)
      const existingAttachment = existingState?.clients.get(ws)
      if (attachRequestId && existingAttachment?.activeAttachRequestId === attachRequestId) {
        result = 'duplicate'
        return
      }

      const record = this.registry.attach(terminalId, ws, { suppressOutput: true })
      if (!record) {
        result = 'missing'
        return
      }

      const hasOtherAttachedSockets = Boolean(
        existingState
        && [...existingState.clients.keys()].some((attachedWs) => attachedWs !== ws)
      )
      const shouldResize = intent === 'viewport_hydrate'
        || (
          intent === 'transport_reconnect'
          && (!hasOtherAttachedSockets || Boolean(existingAttachment))
        )

      if (shouldResize && !this.registry.resize(terminalId, cols, rows)) {
        this.registry.detach(terminalId, ws)
        result = 'missing'
        return
      }

      const terminalState = existingState ?? this.getOrCreateTerminalState(terminalId)
      const streamId = this.streamIdentity.recordAttach(terminalId, attachRequestId)
      const attachment = existingAttachment ?? this.getOrCreateAttachment(terminalState, ws, terminalId)

      if (attachment.flushTimer) {
        clearTimeout(attachment.flushTimer)
        attachment.flushTimer = null
      }

      attachment.mode = 'attaching'
      attachment.priority = priority
      attachment.activeAttachRequestId = attachRequestId
      attachment.replayCursor = null
      attachment.attachStaging = []
      attachment.queue.clear()

      // Seed from the existing terminal buffer if this terminal predates broker wiring.
      if (terminalState.replayRing.headSeq() === 0) {
        const snapshot = record.buffer.snapshot()
        if (snapshot) {
          this.appendOutputFrames(terminalId, snapshot)
        }
      }

      const replay = terminalState.replayRing.replaySince(normalizedSinceSeq)
      let replayFrames = replay.frames
      let effectiveMissedFromSeq = replay.missedFromSeq
      let budgetTruncated = false
      const headSeq = terminalState.replayRing.headSeq()

      // Truncate replay to tail frames within byte budget
      if (maxReplayBytes !== undefined && maxReplayBytes > 0 && replayFrames.length > 0) {
        let budgetRemaining = maxReplayBytes
        let keepFromIndex = replayFrames.length
        for (let i = replayFrames.length - 1; i >= 0; i--) {
          if (replayFrames[i].bytes > budgetRemaining) break
          budgetRemaining -= replayFrames[i].bytes
          keepFromIndex = i
        }
        if (keepFromIndex > 0) {
          const truncatedFromSeq = replayFrames[0].seqStart
          const truncatedToSeq = replayFrames[keepFromIndex - 1].seqEnd
          effectiveMissedFromSeq = effectiveMissedFromSeq ?? truncatedFromSeq
          budgetTruncated = true
          replayFrames = replayFrames.slice(keepFromIndex)

          this.perfEventLogger('terminal_stream_replay_truncated', {
            terminalId,
            connectionId: ws.connectionId,
            maxReplayBytes,
            droppedFrames: keepFromIndex,
            droppedFromSeq: truncatedFromSeq,
            droppedToSeq: truncatedToSeq,
            keptFrames: replayFrames.length,
          })
        }
      }

      const replayFromSeq = replayFrames.length > 0 ? replayFrames[0].seqStart : headSeq + 1
      const replayToSeq = replayFrames.length > 0 ? replayFrames[replayFrames.length - 1].seqEnd : headSeq

      if (replayFrames.length > 0 && effectiveMissedFromSeq === undefined) {
        this.perfEventLogger('terminal_stream_replay_hit', {
          terminalId,
          connectionId: ws.connectionId,
          sinceSeq: normalizedSinceSeq,
          replayFromSeq,
          replayToSeq,
          replayFrameCount: replayFrames.length,
        })
      }

      const sessionRef = buildTerminalSessionRef(record)
      if (!this.safeSend(ws, {
        type: 'terminal.attach.ready',
        terminalId,
        streamId,
        headSeq,
        replayFromSeq,
        replayToSeq,
        ...(attachment.activeAttachRequestId ? { attachRequestId: attachment.activeAttachRequestId } : {}),
        ...(sessionRef ? { sessionRef } : {}),
      })) {
        return
      }

      if (effectiveMissedFromSeq !== undefined) {
        const missedToSeq = replayFromSeq - 1
        const gapReason = budgetTruncated ? 'replay_budget_exceeded' as const : 'replay_window_exceeded' as const
        if (missedToSeq >= effectiveMissedFromSeq) {
          this.perfEventLogger('terminal_stream_replay_miss', {
            terminalId,
            connectionId: ws.connectionId,
            sinceSeq: normalizedSinceSeq,
            missedFromSeq: effectiveMissedFromSeq,
            missedToSeq,
            replayFromSeq,
            replayToSeq,
          }, 'warn')

          this.perfEventLogger('terminal_stream_gap', {
            terminalId,
            connectionId: ws.connectionId,
            fromSeq: effectiveMissedFromSeq,
            toSeq: missedToSeq,
            reason: gapReason,
          }, 'warn')

          if (!this.safeSend(ws, {
            type: 'terminal.output.gap',
            terminalId,
            streamId,
            fromSeq: effectiveMissedFromSeq,
            toSeq: missedToSeq,
            reason: gapReason,
            ...(attachment.activeAttachRequestId ? { attachRequestId: attachment.activeAttachRequestId } : {}),
          })) {
            return
          }
          attachment.lastSeq = Math.max(attachment.lastSeq, missedToSeq)
        }
      }

      const staged = attachment.attachStaging.filter((frame) => frame.seqStart > replayToSeq)
      attachment.attachStaging = []
      attachment.replayCursor = replayFrames.length > 0
        ? { nextSeq: replayFromSeq, toSeq: replayToSeq }
        : null
      for (const frame of staged) {
        attachment.queue.enqueue(
          frame,
          this.measureOutputFrameSerializedApplicationJsonBytes(
            terminalId,
            frame,
            attachment.activeAttachRequestId,
          ),
        )
      }

      attachment.mode = 'live'
      if (attachment.replayCursor || attachment.queue.pendingBytes() > 0) {
        this.scheduleFlush(terminalId, attachment)
      }
    })

    return result
  }

  hasActiveAttachRequest(ws: LiveWebSocket, terminalId: string, attachRequestId: string): boolean {
    const state = this.terminals.get(terminalId)
    const attachment = state?.clients.get(ws)
    return attachment?.activeAttachRequestId === attachRequestId
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

    this.streamIdentity.recordDetach(terminalId, attachment?.activeAttachRequestId)
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
    const replayRingMaxBytes = this.resolveReplayRingMaxBytes(terminalId)
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

  private resolveReplayRingMaxBytes(terminalId: string): number | undefined {
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
    let replayBudget = typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : undefined

    const getRecord = (
      this.registry as Partial<{ get: (id: string) => { mode?: string } | undefined }>
    ).get
    const terminalRecord = typeof getRecord === 'function' ? getRecord.call(this.registry, terminalId) : undefined
    const isCodingCliTerminal = terminalRecord?.mode && terminalRecord.mode !== 'shell'
    const codingCliFloor = Number.isFinite(CODING_CLI_MIN_REPLAY_RING_MAX_BYTES) && CODING_CLI_MIN_REPLAY_RING_MAX_BYTES > 0
      ? Math.floor(CODING_CLI_MIN_REPLAY_RING_MAX_BYTES)
      : undefined

    if (isCodingCliTerminal && codingCliFloor) {
      replayBudget = Math.max(replayBudget ?? 0, codingCliFloor)
    }

    return replayBudget
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
        priority: 'foreground',
        queue: new ClientOutputQueue(),
        replayCursor: null,
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
    const frames = this.appendOutputFrames(event.terminalId, event.data)

    for (const attachment of state.clients.values()) {
      for (const frame of frames) {
        if (attachment.mode === 'attaching') {
          attachment.attachStaging.push(frame)
          continue
        }
        attachment.queue.enqueue(
          frame,
          this.measureOutputFrameSerializedApplicationJsonBytes(
            event.terminalId,
            frame,
            attachment.activeAttachRequestId,
          ),
        )
      }
      if (frames.length > 0 && attachment.mode !== 'attaching') {
        this.scheduleFlush(event.terminalId, attachment)
      }
    }
  }

  private appendOutputFrames(terminalId: string, data: string): ReplayFrame[] {
    const state = this.getOrCreateTerminalState(terminalId)
    const streamId = this.streamIdentity.ensureStream(terminalId)
    return state.replayRing.appendFragmentedForPayloadBudget({
      data,
      streamId,
      maxSerializedBytes: TERMINAL_STREAM_BATCH_MAX_BYTES,
      payloadForData: (chunk) => this.buildTerminalOutputPayload({
        terminalId,
        streamId,
        seqStart: TERMINAL_STREAM_BUDGET_SEQ_PLACEHOLDER,
        seqEnd: TERMINAL_STREAM_BUDGET_SEQ_PLACEHOLDER,
        data: chunk,
        attachRequestId: TERMINAL_STREAM_ATTACH_REQUEST_ID_RESERVE_VALUE,
      }),
    })
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
      if (this.hasPendingAttachmentOutput(attachment)) {
        this.scheduleFlush(terminalId, attachment, TERMINAL_STREAM_RETRY_FLUSH_MS)
      }
      return
    }

    const wsBuffered = ws.bufferedAmount as number | undefined
    if (
      attachment.priority === 'background'
      && typeof wsBuffered === 'number'
      && wsBuffered > TERMINAL_BACKGROUND_BUFFERED_PAUSE_BYTES
    ) {
      if (this.hasPendingAttachmentOutput(attachment)) {
        this.scheduleFlush(terminalId, attachment, TERMINAL_BACKGROUND_RETRY_FLUSH_MS)
      }
      return
    }

    if (attachment.replayCursor) {
      this.flushReplayCursor(terminalId, attachment)
      return
    }

    const pendingSerializedApplicationJsonBytes = attachment.queue.pendingBytes()
    if (pendingSerializedApplicationJsonBytes > TERMINAL_STREAM_BATCH_MAX_BYTES) {
      const droppedSerializedApplicationJsonBytes = attachment.queue.peekDroppedBytes()
      this.perfEventLogger('terminal_stream_queue_pressure', {
        terminalId,
        connectionId: ws.connectionId,
        pendingSerializedApplicationJsonBytes,
        batchMaxSerializedApplicationJsonBytes: TERMINAL_STREAM_BATCH_MAX_BYTES,
        pendingBytes: pendingSerializedApplicationJsonBytes,
        batchMaxBytes: TERMINAL_STREAM_BATCH_MAX_BYTES,
        bufferedAmount: ws.bufferedAmount,
        queueDepth: attachment.queue.pendingFrames(),
        droppedSerializedApplicationJsonBytes,
        droppedBytes: droppedSerializedApplicationJsonBytes,
      }, 'warn')
    }

    const attachRequestId = attachment.activeAttachRequestId
    const batch = attachment.queue.nextBatch(
      TERMINAL_STREAM_BATCH_MAX_BYTES,
      (frame) => this.measureOutputFrameSerializedApplicationJsonBytes(terminalId, frame, attachRequestId),
    )
    if (batch.length === 0) return

    for (const item of batch) {
      if (isGapEvent(item)) {
        if (!this.sendGap(
          ws,
          terminalId,
          item,
          attachRequestId,
          item.reason === 'queue_overflow'
            ? {
                queueDepth: attachment.queue.pendingFrames(),
                droppedSerializedApplicationJsonBytes: attachment.queue.consumeDroppedBytes(),
              }
            : undefined,
        )) return
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

  private flushReplayCursor(terminalId: string, attachment: BrokerClientAttachment): void {
    const cursor = attachment.replayCursor
    if (!cursor) return

    const terminalState = this.terminals.get(terminalId)
    if (!terminalState) {
      attachment.replayCursor = null
      return
    }

    const attachRequestId = attachment.activeAttachRequestId
    const replay = terminalState.replayRing.replayBatchSince(
      cursor.nextSeq - 1,
      TERMINAL_STREAM_BATCH_MAX_BYTES,
      cursor.toSeq,
      (frame) => this.measureOutputFrameSerializedApplicationJsonBytes(terminalId, frame, attachRequestId),
    )

    if (replay.missedFromSeq !== undefined) {
      const replayFromSeq = replay.frames.length > 0
        ? replay.frames[0].seqStart
        : Math.min(cursor.toSeq + 1, terminalState.replayRing.headSeq() + 1)
      const missedToSeq = Math.min(cursor.toSeq, replayFromSeq - 1)
      if (missedToSeq >= replay.missedFromSeq) {
        if (!this.sendReplayGap(
          attachment.ws,
          terminalId,
          replay.missedFromSeq,
          missedToSeq,
          attachRequestId,
        )) return
        attachment.lastSeq = Math.max(attachment.lastSeq, missedToSeq)
        cursor.nextSeq = missedToSeq + 1
      }
    }

    for (const frame of replay.frames) {
      if (!this.sendFrame(attachment.ws, terminalId, frame, attachRequestId)) return
      attachment.lastSeq = Math.max(attachment.lastSeq, frame.seqEnd)
      cursor.nextSeq = frame.seqEnd + 1
    }

    if (cursor.nextSeq > cursor.toSeq || replay.frames.length === 0) {
      attachment.replayCursor = null
    }

    if (this.hasPendingAttachmentOutput(attachment)) {
      const replayFlushDelay = attachment.priority === 'foreground'
        ? 0
        : TERMINAL_STREAM_RETRY_FLUSH_MS
      this.scheduleFlush(terminalId, attachment, replayFlushDelay)
    }
  }

  private hasPendingAttachmentOutput(attachment: BrokerClientAttachment): boolean {
    return Boolean(attachment.replayCursor) || attachment.queue.pendingBytes() > 0
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
    return this.safeSend(ws, this.buildTerminalOutputPayload({
      type: 'terminal.output',
      terminalId,
      streamId: frame.streamId ?? this.streamIdentity.ensureStream(terminalId),
      seqStart: frame.seqStart,
      seqEnd: frame.seqEnd,
      data: frame.data,
      attachRequestId,
    }))
  }

  private sendGap(
    ws: LiveWebSocket,
    terminalId: string,
    gap: GapEvent,
    attachRequestId?: string,
    queueContext?: {
      queueDepth?: number
      droppedBytes?: number
      droppedSerializedApplicationJsonBytes?: number
    },
  ): boolean {
    const droppedSerializedApplicationJsonBytes = queueContext?.droppedSerializedApplicationJsonBytes
      ?? queueContext?.droppedBytes
    this.perfEventLogger('terminal_stream_gap', {
      terminalId,
      connectionId: ws.connectionId,
      fromSeq: gap.fromSeq,
      toSeq: gap.toSeq,
      reason: gap.reason,
      ...(typeof queueContext?.queueDepth === 'number' ? { queueDepth: queueContext.queueDepth } : {}),
      ...(typeof droppedSerializedApplicationJsonBytes === 'number'
        ? {
            droppedSerializedApplicationJsonBytes,
            droppedBytes: droppedSerializedApplicationJsonBytes,
          }
        : {}),
    }, gap.reason === 'queue_overflow' ? 'warn' : 'info')

    return this.safeSend(ws, {
      type: 'terminal.output.gap',
      terminalId,
      streamId: this.streamIdentity.ensureStream(terminalId),
      fromSeq: gap.fromSeq,
      toSeq: gap.toSeq,
      reason: gap.reason,
      ...(attachRequestId ? { attachRequestId } : {}),
    })
  }

  private sendReplayGap(
    ws: LiveWebSocket,
    terminalId: string,
    fromSeq: number,
    toSeq: number,
    attachRequestId?: string,
  ): boolean {
    this.perfEventLogger('terminal_stream_gap', {
      terminalId,
      connectionId: ws.connectionId,
      fromSeq,
      toSeq,
      reason: 'replay_window_exceeded',
    }, 'warn')

    return this.safeSend(ws, {
      type: 'terminal.output.gap',
      terminalId,
      streamId: this.streamIdentity.ensureStream(terminalId),
      fromSeq,
      toSeq,
      reason: 'replay_window_exceeded',
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
    this.streamIdentity.forgetStream(terminalId)
  }

  private buildTerminalOutputPayload(input: {
    type?: 'terminal.output'
    terminalId: string
    streamId: string
    seqStart: number
    seqEnd: number
    data: string
    attachRequestId?: string
  }): JsonPayload {
    return {
      type: input.type ?? 'terminal.output',
      terminalId: input.terminalId,
      streamId: input.streamId,
      seqStart: input.seqStart,
      seqEnd: input.seqEnd,
      data: input.data,
      ...(input.attachRequestId ? { attachRequestId: input.attachRequestId } : {}),
    }
  }

  private measureOutputFrameSerializedApplicationJsonBytes(
    terminalId: string,
    frame: ReplayFrame,
    attachRequestId?: string,
  ): number {
    return measureTerminalOutputPayloadBytes(this.buildTerminalOutputPayload({
      terminalId,
      streamId: frame.streamId ?? this.streamIdentity.ensureStream(terminalId),
      seqStart: frame.seqStart,
      seqEnd: frame.seqEnd,
      data: frame.data,
      attachRequestId,
    }))
  }

  private replaceStreamIdentity(terminalId: string, reason: TerminalStreamReplacementReason): void {
    const streamId = this.streamIdentity.replaceStream(terminalId, reason)
    log.info({
      terminalId,
      streamId,
      reason,
    }, 'Terminal output stream identity replaced')
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
