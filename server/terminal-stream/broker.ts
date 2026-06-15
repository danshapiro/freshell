import WebSocket from 'ws'
import type { LiveWebSocket } from '../ws-handler.js'
import { buildTerminalSessionRef, type TerminalRegistry } from '../terminal-registry.js'
import { logger } from '../logger.js'
import { logTerminalStreamPerfEvent, type TerminalStreamPerfEvent } from '../perf-logger.js'
import type { TerminalOutputRawEvent } from './registry-events.js'
import {
  ClientOutputQueue,
  isGapEvent,
  type GapEvent,
} from './client-output-queue.js'
import { ReplayRing, type ReplayFrame } from './replay-ring.js'
import type { TerminalOutputBatch } from './output-batch.js'
import { fragmentTerminalOutputForPayloadBudget } from './output-fragments.js'
import {
  prepareJsonMessage,
  readWebSocketBufferedAmount,
  sendJsonMessage,
  sendPreparedJsonMessage,
  type PreparedJsonMessage,
  type SendJsonResult,
} from '../ws-send.js'
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
import type { BrokerClientAttachment, BrokerTerminalState, ReplayProgressLogState } from './types.js'
import type { TerminalGeometryAuthority } from '../../shared/ws-protocol.js'

const log = logger.child({ component: 'terminal-stream-broker' })
const DEFAULT_CODING_CLI_REPLAY_RING_MAX_BYTES = 32 * 1024 * 1024
const CODING_CLI_MIN_REPLAY_RING_MAX_BYTES = Number(
  process.env.CODING_CLI_MIN_REPLAY_RING_MAX_BYTES || DEFAULT_CODING_CLI_REPLAY_RING_MAX_BYTES,
)
const TERMINAL_STREAM_BUDGET_SEQ_PLACEHOLDER = Number.MAX_SAFE_INTEGER
const CONFIGURED_FOREGROUND_REPLAY_BUFFERED_PAUSE_BYTES = Number(
  process.env.TERMINAL_FOREGROUND_REPLAY_BUFFERED_PAUSE_BYTES || 512 * 1024 + 64 * 1024,
)
const TERMINAL_FOREGROUND_REPLAY_BUFFERED_PAUSE_BYTES = Math.min(
  Math.max(
    TERMINAL_BACKGROUND_BUFFERED_PAUSE_BYTES + 1024,
    Number.isFinite(CONFIGURED_FOREGROUND_REPLAY_BUFFERED_PAUSE_BYTES)
      && CONFIGURED_FOREGROUND_REPLAY_BUFFERED_PAUSE_BYTES > 0
      ? Math.floor(CONFIGURED_FOREGROUND_REPLAY_BUFFERED_PAUSE_BYTES)
      : 512 * 1024 + 64 * 1024,
  ),
  Math.max(1024, TERMINAL_WS_CATASTROPHIC_BUFFERED_BYTES - 1),
)
const CONFIGURED_REPLAY_BACKPRESSURE_LOG_RATE_LIMIT_MS = Number(
  process.env.TERMINAL_REPLAY_BACKPRESSURE_LOG_RATE_LIMIT_MS || 5000,
)
const TERMINAL_REPLAY_BACKPRESSURE_LOG_RATE_LIMIT_MS = Math.max(
  1,
  Number.isFinite(CONFIGURED_REPLAY_BACKPRESSURE_LOG_RATE_LIMIT_MS)
    && CONFIGURED_REPLAY_BACKPRESSURE_LOG_RATE_LIMIT_MS > 0
    ? Math.floor(CONFIGURED_REPLAY_BACKPRESSURE_LOG_RATE_LIMIT_MS)
    : 5000,
)
const CONFIGURED_REPLAY_PROGRESS_LOG_INTERVAL_MS = Number(
  process.env.TERMINAL_REPLAY_PROGRESS_LOG_INTERVAL_MS || 5000,
)
const TERMINAL_REPLAY_PROGRESS_LOG_INTERVAL_MS = Math.max(
  1,
  Number.isFinite(CONFIGURED_REPLAY_PROGRESS_LOG_INTERVAL_MS)
    && CONFIGURED_REPLAY_PROGRESS_LOG_INTERVAL_MS > 0
    ? Math.floor(CONFIGURED_REPLAY_PROGRESS_LOG_INTERVAL_MS)
    : 5000,
)
const FOREGROUND_REPLAY_BACKPRESSURE_WARN_MS = 10_000
const CONFIGURED_REPLAY_RETENTION_LOG_RATE_LIMIT_MS = Number(
  process.env.TERMINAL_REPLAY_RETENTION_LOG_RATE_LIMIT_MS || 1000,
)
const TERMINAL_REPLAY_RETENTION_LOG_RATE_LIMIT_MS = Math.max(
  1,
  Number.isFinite(CONFIGURED_REPLAY_RETENTION_LOG_RATE_LIMIT_MS)
    && CONFIGURED_REPLAY_RETENTION_LOG_RATE_LIMIT_MS > 0
    ? Math.floor(CONFIGURED_REPLAY_RETENTION_LOG_RATE_LIMIT_MS)
    : 1000,
)

type PerfLevel = 'debug' | 'info' | 'warn' | 'error'
type AttachIntent = 'viewport_hydrate' | 'keepalive_delta' | 'transport_reconnect'
type AttachPriority = 'foreground' | 'background'
type ReplayGapRange = {
  fromSeq: number
  toSeq: number
}
type ReplaySendOutcome =
  | { status: 'sent'; pauseAfter: boolean; sentSeqEnd: number }
  | { status: 'paused' | 'failed' }
type LiveSendOutcome =
  | { status: 'sent'; sentFrameCount: number; sentSeqEnd: number }
  | { status: 'failed'; sentFrameCount: number; sentSeqEnd?: number; reason?: SendJsonResult['reason'] }
type PerfEventLogger = (
  event: TerminalStreamPerfEvent,
  context: Record<string, unknown>,
  level?: PerfLevel,
) => void
type ReplayGapReason = 'replay_window_exceeded' | 'replay_budget_exceeded' | 'queue_overflow'
type ReplayBackpressurePayloadFields = {
  seqStart?: number
  seqEnd?: number
  rawFrameCount: number
  dataBytes: number
}
type ReplayProgressFlushReason = 'interval' | 'completed' | 'abandoned' | 'superseded' | 'backpressure'

function jsonNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function jsonString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function jsonNumberField(payload: JsonPayload, field: string): number | undefined {
  return jsonNumber(payload[field])
}

function jsonStringField(payload: JsonPayload, field: string): string | undefined {
  return jsonString(payload[field])
}

function payloadRawFrameCount(payload: JsonPayload): number {
  const segments = Array.isArray(payload.segments) ? payload.segments : []
  if (segments.length > 0) {
    return segments.reduce((sum, segment) => {
      const rawFrameCount = jsonNumber((segment as { rawFrameCount?: unknown }).rawFrameCount)
      return sum + Math.max(0, Math.floor(rawFrameCount ?? 0))
    }, 0)
  }

  const seqStart = jsonNumberField(payload, 'seqStart')
  const seqEnd = jsonNumberField(payload, 'seqEnd')
  if (seqStart === undefined || seqEnd === undefined || seqEnd < seqStart) return 0
  return Math.max(1, Math.floor(seqEnd - seqStart + 1))
}

function payloadBackpressureFields(payload: JsonPayload): ReplayBackpressurePayloadFields {
  const data = typeof payload.data === 'string' ? payload.data : ''
  const seqStart = jsonNumberField(payload, 'seqStart') ?? jsonNumberField(payload, 'fromSeq')
  const seqEnd = jsonNumberField(payload, 'seqEnd') ?? jsonNumberField(payload, 'toSeq')
  const rawFrameCount = jsonStringField(payload, 'type') === 'terminal.output.gap'
    ? 0
    : payloadRawFrameCount(payload)
  return {
    ...(seqStart !== undefined ? { seqStart } : {}),
    ...(seqEnd !== undefined ? { seqEnd } : {}),
    rawFrameCount,
    dataBytes: Buffer.byteLength(data, 'utf8'),
  }
}

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
    terminalOutputBatchV1 = false,
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

      const terminalState = existingState ?? this.getOrCreateTerminalState(terminalId)
      if (shouldResize && !this.registry.resize(terminalId, cols, rows)) {
        this.registry.detach(terminalId, ws)
        result = 'missing'
        return
      }
      if (shouldResize) {
        this.recordTerminalGeometry(
          terminalState,
          cols,
          rows,
          hasOtherAttachedSockets ? 'multi_client_unknown' : 'single_client',
        )
      } else if (hasOtherAttachedSockets) {
        terminalState.geometryAuthority = 'multi_client_unknown'
      }

      const attachment = existingAttachment ?? this.getOrCreateAttachment(terminalState, ws, terminalId)
      attachment.terminalOutputBatchV1 = terminalOutputBatchV1

      if (attachment.flushTimer) {
        clearTimeout(attachment.flushTimer)
        attachment.flushTimer = null
      }

      if (attachment.replayCursor || attachment.replayProgressLog) {
        this.flushTerminalReplayProgress(terminalId, attachment, 'superseded')
      }
      this.clearReplayBackpressureLogState(attachment)
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

      const streamId = this.streamIdentity.recordAttach(terminalId)
      const replayResetReason = terminalState.geometryAuthority === 'multi_client_unknown' && normalizedSinceSeq > 0
        ? 'geometry_authority_unknown' as const
        : undefined
      const effectiveSinceSeq = replayResetReason ? 0 : normalizedSinceSeq

      const replay = terminalState.replayRing.replaySince(effectiveSinceSeq)
      let replayFrames = replay.frames
      let effectiveMissedFromSeq = replay.missedFromSeq
      let budgetTruncated = false
      const headSeq = terminalState.replayRing.headSeq()

      // maxReplayBytes is a legacy protocol name; interpret it as serialized
      // application JSON bytes for the terminal.output payloads we will send.
      if (maxReplayBytes !== undefined && maxReplayBytes > 0 && replayFrames.length > 0) {
        const maxReplaySerializedApplicationJsonBytes = Math.floor(maxReplayBytes)
        let budgetRemaining = maxReplaySerializedApplicationJsonBytes
        let keepFromIndex = replayFrames.length
        for (let i = replayFrames.length - 1; i >= 0; i--) {
          const frameSerializedApplicationJsonBytes = this.measureOutputFrameSerializedApplicationJsonBytes(
            terminalId,
            replayFrames[i],
            attachment.activeAttachRequestId,
            'replay',
          )
          if (frameSerializedApplicationJsonBytes > budgetRemaining) break
          budgetRemaining -= frameSerializedApplicationJsonBytes
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
            maxReplaySerializedApplicationJsonBytes,
            droppedFrames: keepFromIndex,
            droppedFromSeq: truncatedFromSeq,
            droppedToSeq: truncatedToSeq,
            keptFrames: replayFrames.length,
          })
        }
      }

      const streamFilteredReplay = this.filterReplayFramesForStream(replayFrames, streamId)
      replayFrames = streamFilteredReplay.frames
      const skippedReplayGaps = streamFilteredReplay.skippedGaps

      const replayFromSeq = replayFrames.length > 0 ? replayFrames[0].seqStart : headSeq + 1
      const replayToSeq = replayFrames.length > 0 ? replayFrames[replayFrames.length - 1].seqEnd : headSeq

      if (replayFrames.length > 0 && effectiveMissedFromSeq === undefined) {
        this.perfEventLogger('terminal_stream_replay_hit', {
          terminalId,
          connectionId: ws.connectionId,
          sinceSeq: effectiveSinceSeq,
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
        geometryEpoch: terminalState.geometryEpoch,
        geometryAuthority: terminalState.geometryAuthority,
        requestedSinceSeq: normalizedSinceSeq,
        effectiveSinceSeq,
        ...(replayResetReason ? { replayResetReason } : {}),
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
            sinceSeq: effectiveSinceSeq,
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

          const gapPayload = {
            type: 'terminal.output.gap',
            terminalId,
            streamId,
            fromSeq: effectiveMissedFromSeq,
            toSeq: missedToSeq,
            reason: gapReason,
            ...(attachment.activeAttachRequestId ? { attachRequestId: attachment.activeAttachRequestId } : {}),
          }
          if (!this.safeSend(ws, gapPayload)) {
            return
          }
          this.logTerminalReplayGap({
            terminalId,
            connectionId: ws.connectionId,
            attachRequestId: attachment.activeAttachRequestId,
            streamId,
            fromSeq: effectiveMissedFromSeq,
            toSeq: missedToSeq,
            reason: gapReason,
            source: 'replay',
          })
          attachment.lastSeq = Math.max(attachment.lastSeq, missedToSeq)
        }
      }

      const preReplayGapLimit = replayFrames.length > 0 ? replayFromSeq - 1 : headSeq
      for (const gap of skippedReplayGaps) {
        if (gap.fromSeq > preReplayGapLimit) continue
        const fromSeq = Math.max(gap.fromSeq, attachment.lastSeq + 1)
        const toSeq = Math.min(gap.toSeq, preReplayGapLimit)
        if (toSeq < fromSeq) continue
        if (!this.sendReplayGap(
          ws,
          terminalId,
          fromSeq,
          toSeq,
          streamId,
          attachment.activeAttachRequestId,
        )) return
        attachment.lastSeq = Math.max(attachment.lastSeq, toSeq)
      }

      const staged = attachment.attachStaging.filter((frame) => frame.seqStart > replayToSeq)
      attachment.attachStaging = []
      attachment.replayCursor = replayFrames.length > 0
        ? { nextSeq: replayFromSeq, toSeq: replayToSeq, streamId }
        : null
      for (const frame of staged) {
        attachment.queue.enqueue(
          frame,
          this.measureOutputFrameSerializedApplicationJsonBytes(
            terminalId,
            frame,
            attachment.activeAttachRequestId,
            'live',
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
    if (attachment) {
      this.flushTerminalReplayProgress(terminalId, attachment, 'abandoned')
      this.clearReplayBackpressureLogState(attachment)
    }

    this.streamIdentity.recordDetach(terminalId)
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

  recordResize(terminalId: string, ws: LiveWebSocket, cols: number, rows: number): void {
    const state = this.terminals.get(terminalId)
    if (!state) return
    const hasOtherAttachedSockets = [...state.clients.keys()].some((attachedWs) => attachedWs !== ws)
    this.recordTerminalGeometry(
      state,
      cols,
      rows,
      hasOtherAttachedSockets ? 'multi_client_unknown' : 'single_client',
    )
  }

  private recordTerminalGeometry(
    state: BrokerTerminalState,
    cols: number,
    rows: number,
    authority: TerminalGeometryAuthority,
  ): void {
    const normalizedCols = Math.max(2, Math.floor(Number.isFinite(cols) ? cols : 80))
    const normalizedRows = Math.max(2, Math.floor(Number.isFinite(rows) ? rows : 24))
    const hasPreviousGeometry = typeof state.geometryCols === 'number'
      && typeof state.geometryRows === 'number'
    const geometryChanged = !hasPreviousGeometry
      ? false
      : state.geometryCols !== normalizedCols || state.geometryRows !== normalizedRows

    if (geometryChanged) {
      state.geometryEpoch += 1
    }
    state.geometryCols = normalizedCols
    state.geometryRows = normalizedRows
    state.geometryAuthority = authority
  }

  private getOrCreateTerminalState(terminalId: string): BrokerTerminalState {
    const replayRingMaxBytes = this.resolveReplayRingMaxBytes(terminalId)
    let state = this.terminals.get(terminalId)
    if (!state) {
      state = {
        replayRing: new ReplayRing(replayRingMaxBytes),
        clients: new Map(),
        geometryEpoch: 1,
        geometryAuthority: 'single_client',
      }
      this.terminals.set(terminalId, state)
    } else {
      state.replayRing.setMaxBytes(replayRingMaxBytes)
      this.handleReplayRetentionLoss(terminalId, state, this.streamIdentity.ensureStream(terminalId))
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
        terminalOutputBatchV1: false,
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
            'live',
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
    let streamId = this.streamIdentity.ensureStream(terminalId)
    const fragments = fragmentTerminalOutputForPayloadBudget({
      data,
      maxSerializedBytes: TERMINAL_STREAM_BATCH_MAX_BYTES,
      payloadForData: (chunk) => this.buildTerminalOutputPayload({
        terminalId,
        streamId,
        seqStart: TERMINAL_STREAM_BUDGET_SEQ_PLACEHOLDER,
        seqEnd: TERMINAL_STREAM_BUDGET_SEQ_PLACEHOLDER,
        data: chunk,
        attachRequestId: TERMINAL_STREAM_ATTACH_REQUEST_ID_RESERVE_VALUE,
        source: 'replay',
      }),
    })
    const frames: ReplayFrame[] = []
    for (const fragment of fragments) {
      const fragmentStreamId = streamId
      frames.push(state.replayRing.append(fragment, { streamId }))
      const retainedStreamId = this.handleReplayRetentionLoss(terminalId, state, fragmentStreamId)
      if (retainedStreamId) {
        this.retagFrames(frames, fragmentStreamId, retainedStreamId)
        streamId = retainedStreamId
      }
    }
    return frames
  }

  private retagFrames(frames: ReplayFrame[], fromStreamId: string, toStreamId: string): void {
    if (!fromStreamId || !toStreamId || fromStreamId === toStreamId) return
    for (const frame of frames) {
      if (frame.streamId === fromStreamId) {
        frame.streamId = toStreamId
      }
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
      if (this.hasPendingAttachmentOutput(attachment)) {
        this.scheduleFlush(terminalId, attachment, TERMINAL_STREAM_RETRY_FLUSH_MS)
      }
      return
    }

    const wsBuffered = readWebSocketBufferedAmount(ws)
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
    const preparedBatch = attachment.queue.prepareBatch(
      TERMINAL_STREAM_BATCH_MAX_BYTES,
      (frame) => this.measureOutputFrameSerializedApplicationJsonBytes(terminalId, frame, attachRequestId, 'live'),
      { terminalId, attachRequestId, source: 'live' },
    )
    if (preparedBatch.entries.length === 0) return

    let sentGaps = 0
    let sentFrames = 0
    const acknowledgeAndRetry = (reason?: SendJsonResult['reason']) => {
      attachment.queue.acknowledgePreparedBatch(preparedBatch, { gaps: sentGaps, frames: sentFrames })
      if (reason === 'closed' || ws.readyState !== WebSocket.OPEN) {
        this.detach(terminalId, ws)
        return
      }
      if (this.hasPendingAttachmentOutput(attachment)) {
        this.scheduleFlush(terminalId, attachment, TERMINAL_STREAM_RETRY_FLUSH_MS)
      }
    }

    for (const item of preparedBatch.entries) {
      if (isGapEvent(item)) {
        const gapQueueContext = item.reason === 'queue_overflow'
          ? {
              queueDepth: attachment.queue.pendingFrames(),
              droppedSerializedApplicationJsonBytes: attachment.queue.peekDroppedBytes(),
            }
          : undefined
        if (!this.sendGap(
          ws,
          terminalId,
          item,
          attachRequestId,
          gapQueueContext,
        )) {
          acknowledgeAndRetry()
          return
        }
        if (item.reason === 'queue_overflow') {
          attachment.queue.consumeDroppedBytes()
        }
        sentGaps += 1
        attachment.lastSeq = Math.max(attachment.lastSeq, item.toSeq)
        continue
      }

      const sendResult = this.sendFrame(ws, terminalId, item, attachRequestId, 'live', attachment.terminalOutputBatchV1)
      if (sendResult.sentFrameCount > 0) {
        sentFrames += sendResult.sentFrameCount
        if (typeof sendResult.sentSeqEnd === 'number') {
          attachment.lastSeq = Math.max(attachment.lastSeq, sendResult.sentSeqEnd)
        }
      }
      if (sendResult.status !== 'sent') {
        acknowledgeAndRetry(sendResult.reason)
        return
      }
    }

    attachment.queue.acknowledgePreparedBatch(preparedBatch, { gaps: sentGaps, frames: sentFrames })

    if (this.hasPendingAttachmentOutput(attachment)) {
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
      (frame) => this.measureOutputFrameSerializedApplicationJsonBytes(terminalId, frame, attachRequestId, 'replay'),
      { terminalId, attachRequestId, source: 'replay' },
    )

    if (replay.missedFromSeq !== undefined) {
      const replayFromSeq = replay.frames.length > 0
        ? replay.frames[0].seqStart
        : Math.min(cursor.toSeq + 1, terminalState.replayRing.headSeq() + 1)
      const missedToSeq = Math.min(cursor.toSeq, replayFromSeq - 1)
      if (missedToSeq >= replay.missedFromSeq) {
        const gapSend = this.sendReplayGapWithPacing(
          terminalId,
          attachment,
          replay.missedFromSeq,
          missedToSeq,
          cursor.streamId,
          attachRequestId,
        )
        if (gapSend.status !== 'sent') return
        attachment.lastSeq = Math.max(attachment.lastSeq, gapSend.sentSeqEnd)
        cursor.nextSeq = gapSend.sentSeqEnd + 1
        if (gapSend.pauseAfter) return
      }
    }

    let skippedGap: ReplayGapRange | null = null
    const flushSkippedGap = (): 'sent' | 'paused' | 'failed' | 'none' => {
      if (!skippedGap) return 'none'
      const gap = skippedGap
      const gapSend = this.sendReplayGapWithPacing(
        terminalId,
        attachment,
        gap.fromSeq,
        gap.toSeq,
        cursor.streamId,
        attachRequestId,
      )
      if (gapSend.status !== 'sent') return gapSend.status
      skippedGap = null
      attachment.lastSeq = Math.max(attachment.lastSeq, gap.toSeq)
      cursor.nextSeq = gap.toSeq + 1
      return gapSend.pauseAfter ? 'paused' : 'sent'
    }

    for (const frame of replay.frames) {
      if (frame.streamId !== cursor.streamId) {
        if (!skippedGap || frame.seqStart > skippedGap.toSeq + 1) {
          const gapResult = flushSkippedGap()
          if (gapResult === 'paused' || gapResult === 'failed') return
          skippedGap = { fromSeq: frame.seqStart, toSeq: frame.seqEnd }
        } else {
          skippedGap.toSeq = Math.max(skippedGap.toSeq, frame.seqEnd)
        }
        continue
      }
      const gapResult = flushSkippedGap()
      if (gapResult === 'paused' || gapResult === 'failed') return
      const frameSend = this.sendReplayFrameWithPacing(
        terminalId,
        attachment,
        frame,
        attachRequestId,
      )
      if (frameSend.status !== 'sent') return
      attachment.lastSeq = Math.max(attachment.lastSeq, frameSend.sentSeqEnd)
      cursor.nextSeq = frameSend.sentSeqEnd + 1
      if (frameSend.pauseAfter) return
    }
    const gapResult = flushSkippedGap()
    if (gapResult === 'paused' || gapResult === 'failed') return

    if (cursor.nextSeq > cursor.toSeq || replay.frames.length === 0) {
      this.flushTerminalReplayProgress(terminalId, attachment, 'completed')
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
    return Boolean(attachment.replayCursor) || attachment.queue.hasPendingEntries()
  }

  private filterReplayFramesForStream(
    frames: ReplayFrame[],
    streamId: string,
  ): { frames: ReplayFrame[]; skippedGaps: ReplayGapRange[] } {
    const keptFrames: ReplayFrame[] = []
    const skippedGaps: ReplayGapRange[] = []

    for (const frame of frames) {
      if (frame.streamId === streamId) {
        keptFrames.push(frame)
        continue
      }

      const lastGap = skippedGaps[skippedGaps.length - 1]
      if (!lastGap || frame.seqStart > lastGap.toSeq + 1) {
        skippedGaps.push({ fromSeq: frame.seqStart, toSeq: frame.seqEnd })
      } else {
        lastGap.toSeq = Math.max(lastGap.toSeq, frame.seqEnd)
      }
    }

    return { frames: keptFrames, skippedGaps }
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

  private recordTerminalReplayProgress(input: {
    terminalId: string
    attachment: BrokerClientAttachment
    attachRequestId?: string
    source: 'live' | 'replay'
    payload: JsonPayload
    result: SendJsonResult
    batch?: TerminalOutputBatch
  }): void {
    if (input.source !== 'replay') return

    const now = Date.now()
    const seqStart = jsonNumberField(input.payload, 'seqStart') ?? input.batch?.seqStart
    const seqEnd = jsonNumberField(input.payload, 'seqEnd') ?? input.batch?.seqEnd
    const streamId = jsonStringField(input.payload, 'streamId') ?? input.batch?.streamId
    const payloadType = jsonStringField(input.payload, 'type') ?? input.result.messageType ?? 'unknown'
    const rawFrameCount = payloadRawFrameCount(input.payload)
    const data = typeof input.payload.data === 'string' ? input.payload.data : ''
    const serializedBytes = input.result.serializedApplicationJsonBytes
      ?? jsonNumberField(input.payload, 'serializedBytes')
      ?? measureTerminalOutputPayloadBytes(input.payload)
    const bufferedAmount = input.result.bufferedAfter ?? input.result.bufferedBefore
    const state = input.attachment.replayProgressLog ?? this.createReplayProgressLogState(now)
    input.attachment.replayProgressLog = state

    state.batchCount += 1
    state.rawFrameCount += rawFrameCount
    state.dataBytes += Buffer.byteLength(data, 'utf8')
    state.serializedBytes += serializedBytes
    state.payloadTypes.add(payloadType)
    if (streamId) state.streamId = streamId
    if (typeof seqStart === 'number') {
      state.seqStart = typeof state.seqStart === 'number' ? Math.min(state.seqStart, seqStart) : seqStart
    }
    if (typeof seqEnd === 'number') {
      state.seqEnd = typeof state.seqEnd === 'number' ? Math.max(state.seqEnd, seqEnd) : seqEnd
    }
    if (typeof bufferedAmount === 'number') {
      state.maxBufferedAmount = typeof state.maxBufferedAmount === 'number'
        ? Math.max(state.maxBufferedAmount, bufferedAmount)
        : bufferedAmount
    }

    if (now - state.startedAt >= TERMINAL_REPLAY_PROGRESS_LOG_INTERVAL_MS) {
      this.flushTerminalReplayProgress(input.terminalId, input.attachment, 'interval')
    }
  }

  private createReplayProgressLogState(startedAt: number): ReplayProgressLogState {
    return {
      startedAt,
      batchCount: 0,
      rawFrameCount: 0,
      dataBytes: 0,
      serializedBytes: 0,
      payloadTypes: new Set(),
    }
  }

  private flushTerminalReplayProgress(
    terminalId: string,
    attachment: BrokerClientAttachment,
    reason: ReplayProgressFlushReason,
    extra: Record<string, unknown> = {},
  ): void {
    const state = attachment.replayProgressLog
    if (!state || state.batchCount <= 0) return

    const now = Date.now()
    const terminalState = this.terminals.get(terminalId)
    const cursor = attachment.replayCursor
    const nextSeqFromProgress = typeof state.seqEnd === 'number' ? state.seqEnd + 1 : undefined
    const nextSeq = typeof cursor?.nextSeq === 'number' && typeof nextSeqFromProgress === 'number'
      ? Math.max(cursor.nextSeq, nextSeqFromProgress)
      : nextSeqFromProgress ?? cursor?.nextSeq
    const toSeq = cursor?.toSeq
    const seqLag = typeof nextSeq === 'number' && typeof toSeq === 'number'
      ? Math.max(0, toSeq - nextSeq + 1)
      : undefined
    const payloadTypes = Array.from(state.payloadTypes).sort()

    log.debug({
      event: 'terminal.replay.progress',
      severity: 'debug',
      terminalId,
      source: 'replay',
      reason,
      connectionId: attachment.ws.connectionId,
      priority: attachment.priority,
      clientCount: terminalState?.clients.size ?? 0,
      ...(attachment.activeAttachRequestId ? { attachRequestId: attachment.activeAttachRequestId } : {}),
      ...(state.streamId ? { streamId: state.streamId } : {}),
      ...(typeof state.seqStart === 'number' ? { seqStart: state.seqStart } : {}),
      ...(typeof state.seqEnd === 'number' ? { seqEnd: state.seqEnd } : {}),
      ...(typeof nextSeq === 'number' ? { nextSeq } : {}),
      ...(typeof toSeq === 'number' ? { toSeq } : {}),
      ...(typeof seqLag === 'number' ? { seqLag } : {}),
      batchCount: state.batchCount,
      rawFrameCount: state.rawFrameCount,
      dataBytes: state.dataBytes,
      serializedBytes: state.serializedBytes,
      ...(typeof state.maxBufferedAmount === 'number' ? { maxBufferedAmount: state.maxBufferedAmount } : {}),
      ...(payloadTypes.length > 0 ? { payloadTypes } : {}),
      durationMs: Math.max(0, now - state.startedAt),
      backpressureActive: attachment.replayBackpressureActive === true,
      ...extra,
    }, 'Terminal replay progress summary')
    attachment.replayProgressLog = undefined
  }

  private logTerminalReplayGap(input: {
    terminalId: string
    attachRequestId?: string
    streamId?: string
    source?: 'live' | 'replay'
    fromSeq: number
    toSeq: number
    reason: ReplayGapReason
    connectionId?: string
    queueDepth?: number
    droppedSerializedApplicationJsonBytes?: number
  }): void {
    const event = input.source === 'replay' ? 'terminal.replay.gap' : 'terminal.output.gap'
    log.warn({
      event,
      severity: 'warn',
      terminalId: input.terminalId,
      fromSeq: input.fromSeq,
      toSeq: input.toSeq,
      reason: input.reason,
      ...(input.attachRequestId ? { attachRequestId: input.attachRequestId } : {}),
      ...(input.streamId ? { streamId: input.streamId } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      ...(typeof input.queueDepth === 'number' ? { queueDepth: input.queueDepth } : {}),
      ...(typeof input.droppedSerializedApplicationJsonBytes === 'number'
        ? {
            droppedSerializedApplicationJsonBytes: input.droppedSerializedApplicationJsonBytes,
            droppedBytes: input.droppedSerializedApplicationJsonBytes,
          }
        : {}),
    }, input.source === 'replay' ? 'Terminal replay gap emitted' : 'Terminal output gap emitted')
  }

  private logTerminalReplayRetention(input: {
    terminalId: string
    streamId: string
    previousStreamId?: string
    attachRequestIds: string[]
    attachmentCount: number
    reason: TerminalStreamReplacementReason
    retainedBytes: number
    maxBytes: number
    tailSeq: number
    headSeq: number
    suppressedCount?: number
  }): void {
    const basePayload = {
      event: 'terminal.replay.retention',
      severity: 'warn',
      terminalId: input.terminalId,
      streamId: input.streamId,
      ...(input.previousStreamId ? { previousStreamId: input.previousStreamId } : {}),
      attachRequestIds: input.attachRequestIds,
      attachmentCount: input.attachmentCount,
      reason: input.reason,
      retainedBytes: input.retainedBytes,
      maxBytes: input.maxBytes,
      tailSeq: input.tailSeq,
      headSeq: input.headSeq,
      ...(typeof input.suppressedCount === 'number' && input.suppressedCount > 0
        ? { suppressedCount: input.suppressedCount }
        : {}),
    }
    log.warn(basePayload, 'Terminal replay retention loss changed stream identity')
  }

  private sendFrame(
    ws: LiveWebSocket,
    terminalId: string,
    frame: ReplayFrame | TerminalOutputBatch,
    attachRequestId?: string,
    source: 'live' | 'replay' = 'live',
    terminalOutputBatchV1 = false,
  ): LiveSendOutcome {
    if (this.isTerminalOutputBatch(frame)) {
      if (terminalOutputBatchV1 && attachRequestId) {
        const payloads = this.buildTerminalOutputBatchPayloads({
          terminalId,
          batch: frame,
          attachRequestId,
          source,
        })
        for (let index = 0; index < payloads.length; index += 1) {
          const payload = payloads[index]
          const prepared = this.prepareSendPayload(payload)
          if (!prepared) return { status: 'failed', sentFrameCount: this.countSentBatchPayloadFrames(payloads, index) }
          const result = this.safeSendPrepared(ws, prepared)
          if (!result.sent) {
            const sentFrameCount = this.countSentBatchPayloadFrames(payloads, index)
            return {
              status: 'failed',
              sentFrameCount,
              ...(sentFrameCount > 0 ? { sentSeqEnd: this.payloadSeqEnd(payloads[index - 1]) } : {}),
              reason: result.reason,
            }
          }
        }
        return {
          status: 'sent',
          sentFrameCount: this.countSentBatchPayloadFrames(payloads, payloads.length),
          sentSeqEnd: frame.seqEnd,
        }
      }
      return this.sendLegacyOutputSegments(ws, terminalId, frame, attachRequestId)
    }

    const result = sendJsonMessage(ws, this.buildTerminalOutputPayload({
      type: 'terminal.output',
      terminalId,
      streamId: frame.streamId,
      seqStart: frame.seqStart,
      seqEnd: frame.seqEnd,
      data: frame.data,
      attachRequestId,
      source,
    }))
    if (!result.sent) {
      return { status: 'failed', sentFrameCount: 0, reason: result.reason }
    }
    return { status: 'sent', sentFrameCount: 1, sentSeqEnd: frame.seqEnd }
  }

  private isTerminalOutputBatch(frame: ReplayFrame | TerminalOutputBatch): frame is TerminalOutputBatch {
    return Array.isArray((frame as Partial<TerminalOutputBatch>).segments)
  }

  private countSentBatchPayloadFrames(payloads: JsonPayload[], sentPayloadCount: number): number {
    return payloads
      .slice(0, Math.max(0, sentPayloadCount))
      .reduce((sum, payload) => sum + payloadRawFrameCount(payload), 0)
  }

  private payloadSeqEnd(payload: JsonPayload | undefined): number | undefined {
    return typeof payload?.seqEnd === 'number' ? payload.seqEnd : undefined
  }

  private buildTerminalOutputBatchPayloads(input: {
    terminalId: string
    batch: TerminalOutputBatch
    attachRequestId: string
    source: 'live' | 'replay'
  }): JsonPayload[] {
    const fullPayload = this.buildTerminalOutputBatchPayload(input, 0, input.batch.segments.length)
    const fullPayloadBytes = typeof fullPayload.serializedBytes === 'number'
      ? fullPayload.serializedBytes
      : Number.POSITIVE_INFINITY
    if (fullPayloadBytes <= TERMINAL_STREAM_BATCH_MAX_BYTES) {
      return [fullPayload]
    }
    if (input.batch.segments.length <= 1) {
      return this.buildTerminalOutputBatchSingleSegmentFallbackPayloads(input, 0)
    }

    const payloads: JsonPayload[] = []
    let startIndex = 0
    while (startIndex < input.batch.segments.length) {
      let endIndex = startIndex + 1
      let currentPayload = this.buildTerminalOutputBatchPayload(input, startIndex, endIndex)
      const currentPayloadBytes = typeof currentPayload.serializedBytes === 'number'
        ? currentPayload.serializedBytes
        : Number.POSITIVE_INFINITY
      if (currentPayloadBytes > TERMINAL_STREAM_BATCH_MAX_BYTES) {
        payloads.push(...this.buildTerminalOutputBatchSingleSegmentFallbackPayloads(input, startIndex))
        startIndex = endIndex
        continue
      }

      while (endIndex < input.batch.segments.length) {
        const candidate = this.buildTerminalOutputBatchPayload(input, startIndex, endIndex + 1)
        const candidateBytes = typeof candidate.serializedBytes === 'number'
          ? candidate.serializedBytes
          : Number.POSITIVE_INFINITY
        if (candidateBytes > TERMINAL_STREAM_BATCH_MAX_BYTES) break
        currentPayload = candidate
        endIndex += 1
      }

      payloads.push(currentPayload)
      startIndex = endIndex
    }

    return payloads
  }

  private buildTerminalOutputBatchSingleSegmentFallbackPayloads(
    input: {
      terminalId: string
      batch: TerminalOutputBatch
      attachRequestId: string
      source: 'live' | 'replay'
    },
    segmentIndex: number,
  ): JsonPayload[] {
    const segment = input.batch.segments[segmentIndex]
    if (!segment) return []
    const startOffset = segmentIndex === 0
      ? 0
      : input.batch.segments[segmentIndex - 1]?.endOffset ?? 0
    const endOffset = Math.max(startOffset, Math.floor(segment.endOffset))
    return [this.buildTerminalOutputPayload({
      type: 'terminal.output',
      terminalId: input.terminalId,
      streamId: input.batch.streamId,
      seqStart: segment.seqStart,
      seqEnd: segment.seqEnd,
      data: input.batch.data.slice(startOffset, endOffset),
      attachRequestId: input.attachRequestId,
      source: input.source,
    })]
  }

  private buildTerminalOutputBatchPayload(
    input: {
      terminalId: string
      batch: TerminalOutputBatch
      attachRequestId: string
      source: 'live' | 'replay'
    },
    startSegmentIndex: number,
    endSegmentIndex: number,
  ): JsonPayload {
    const firstSegment = input.batch.segments[startSegmentIndex]
    const lastSegment = input.batch.segments[endSegmentIndex - 1]
    const startOffset = startSegmentIndex === 0
      ? 0
      : input.batch.segments[startSegmentIndex - 1]?.endOffset ?? 0
    const endOffset = lastSegment?.endOffset ?? startOffset
    const basePayload = {
      type: 'terminal.output.batch',
      terminalId: input.terminalId,
      streamId: input.batch.streamId,
      attachRequestId: input.attachRequestId,
      source: input.source,
      seqStart: firstSegment?.seqStart ?? input.batch.seqStart,
      seqEnd: lastSegment?.seqEnd ?? input.batch.seqEnd,
      data: input.batch.data.slice(startOffset, endOffset),
      serializedBytes: 0,
      segments: this.buildTerminalOutputBatchWireSegments(
        input.batch,
        startSegmentIndex,
        endSegmentIndex,
        startOffset,
      ),
    }

    let serializedBytes = 0
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const measured = measureTerminalOutputPayloadBytes({
        ...basePayload,
        serializedBytes,
      })
      if (measured === serializedBytes) break
      serializedBytes = measured
    }

    return {
      ...basePayload,
      serializedBytes,
    }
  }

  private buildTerminalOutputBatchWireSegments(
    batch: TerminalOutputBatch,
    startSegmentIndex: number,
    endSegmentIndex: number,
    baseOffset: number,
  ): JsonPayload[] {
    let previousEndOffset = 0
    return batch.segments.slice(startSegmentIndex, endSegmentIndex).map((segment) => {
      const relativeEndOffset = Math.max(previousEndOffset, Math.floor(segment.endOffset - baseOffset))
      previousEndOffset = relativeEndOffset
      return {
        seqStart: segment.seqStart,
        seqEnd: segment.seqEnd,
        endOffset: relativeEndOffset,
        rawFrameCount: Math.max(1, segment.seqEnd - segment.seqStart + 1),
        ...(segment.barrier && segment.barrierReason ? { barrier: segment.barrierReason } : {}),
      }
    })
  }

  private buildLegacyOutputSegmentPayloads(
    terminalId: string,
    batch: TerminalOutputBatch,
    attachRequestId?: string,
    source?: 'live' | 'replay',
  ): JsonPayload[] {
    const payloads: JsonPayload[] = []
    let previousEndOffset = 0
    for (const segment of batch.segments) {
      const endOffset = Math.max(previousEndOffset, Math.floor(segment.endOffset))
      const data = batch.data.slice(previousEndOffset, endOffset)
      previousEndOffset = endOffset
      payloads.push(this.buildTerminalOutputPayload({
        type: 'terminal.output',
        terminalId,
        streamId: batch.streamId,
        seqStart: segment.seqStart,
        seqEnd: segment.seqEnd,
        data,
        attachRequestId,
        source,
      }))
    }
    return payloads
  }

  private sendLegacyOutputSegments(
    ws: LiveWebSocket,
    terminalId: string,
    batch: TerminalOutputBatch,
    attachRequestId?: string,
  ): LiveSendOutcome {
    const source = batch.source === 'replay' ? 'replay' : 'live'
    const payloads = this.buildLegacyOutputSegmentPayloads(terminalId, batch, attachRequestId, source)
    for (let index = 0; index < payloads.length; index += 1) {
      const payload = payloads[index]
      const prepared = this.prepareSendPayload(payload)
      if (!prepared) {
        return { status: 'failed', sentFrameCount: index, ...(index > 0 ? { sentSeqEnd: this.payloadSeqEnd(payloads[index - 1]) } : {}) }
      }
      const result = this.safeSendPrepared(ws, prepared)
      if (!result.sent) {
        return {
          status: 'failed',
          sentFrameCount: index,
          ...(index > 0 ? { sentSeqEnd: this.payloadSeqEnd(payloads[index - 1]) } : {}),
          reason: result.reason,
        }
      }
    }
    return { status: 'sent', sentFrameCount: payloads.length, sentSeqEnd: batch.seqEnd }
  }

  private sendLegacyOutputSegmentsWithPacing(
    terminalId: string,
    attachment: BrokerClientAttachment,
    batch: TerminalOutputBatch,
    attachRequestId?: string,
  ): ReplaySendOutcome {
    let sentSeqEnd = attachment.lastSeq
    const source = batch.source === 'live' ? 'live' : 'replay'
    const payloads = this.buildLegacyOutputSegmentPayloads(terminalId, batch, attachRequestId, source)
    for (let index = 0; index < payloads.length; index += 1) {
      const payload = payloads[index]
      const prepared = this.prepareSendPayload(payload)
      if (!prepared) return { status: 'failed' }
      const payloadSeqEnd = typeof payload.seqEnd === 'number' ? payload.seqEnd : sentSeqEnd
      const result = this.sendPreparedReplayPayloadWithPacing(
        terminalId,
        attachment,
        prepared,
        payloadSeqEnd,
        {
          backpressureFields: payloadBackpressureFields(payload),
          onSent: (sendResult) => this.recordTerminalReplayProgress({
            terminalId,
            attachment,
            attachRequestId,
            source,
            payload,
            result: sendResult,
            batch,
          }),
        },
      )
      if (result.status !== 'sent') return result
      sentSeqEnd = result.sentSeqEnd
      if (result.pauseAfter) return result
    }
    return {
      status: 'sent',
      pauseAfter: false,
      sentSeqEnd,
    }
  }

  private sendReplayFrameWithPacing(
    terminalId: string,
    attachment: BrokerClientAttachment,
    frame: ReplayFrame | TerminalOutputBatch,
    attachRequestId?: string,
  ): ReplaySendOutcome {
    if (this.isTerminalOutputBatch(frame)) {
      if (attachment.terminalOutputBatchV1 && attachRequestId) {
        return this.sendBatchPayloadsWithPacing({
          terminalId,
          attachment,
          batch: frame,
          attachRequestId,
          source: 'replay',
        })
      }

      return this.sendLegacyOutputSegmentsWithPacing(terminalId, attachment, frame, attachRequestId)
    }

    const payload = this.buildTerminalOutputPayload({
      type: 'terminal.output',
      terminalId,
      streamId: frame.streamId,
      seqStart: frame.seqStart,
      seqEnd: frame.seqEnd,
      data: frame.data,
      attachRequestId,
      source: 'replay',
    })
    const prepared = this.prepareSendPayload(payload)
    if (!prepared) return { status: 'failed' }
    return this.sendPreparedReplayPayloadWithPacing(
      terminalId,
      attachment,
      prepared,
      frame.seqEnd,
      {
        backpressureFields: payloadBackpressureFields(payload),
        onSent: (sendResult) => this.recordTerminalReplayProgress({
          terminalId,
          attachment,
          attachRequestId,
          source: 'replay',
          payload,
          result: sendResult,
        }),
      },
    )
  }

  private sendBatchPayloadsWithPacing(input: {
    terminalId: string
    attachment: BrokerClientAttachment
    batch: TerminalOutputBatch
    attachRequestId: string
    source: 'live' | 'replay'
  }): ReplaySendOutcome {
    let sentSeqEnd = input.attachment.lastSeq
    const payloads = this.buildTerminalOutputBatchPayloads(input)
    for (let index = 0; index < payloads.length; index += 1) {
      const payload = payloads[index]
      const prepared = this.prepareSendPayload(payload)
      if (!prepared) return { status: 'failed' }
      const payloadSeqEnd = typeof payload.seqEnd === 'number' ? payload.seqEnd : sentSeqEnd
      const result = this.sendPreparedReplayPayloadWithPacing(
        input.terminalId,
        input.attachment,
        prepared,
        payloadSeqEnd,
        {
          backpressureFields: payloadBackpressureFields(payload),
          onSent: (sendResult) => this.recordTerminalReplayProgress({
            terminalId: input.terminalId,
            attachment: input.attachment,
            attachRequestId: input.attachRequestId,
            source: input.source,
            payload,
            result: sendResult,
            batch: input.batch,
          }),
        },
      )
      if (result.status !== 'sent') return result
      sentSeqEnd = result.sentSeqEnd
      if (result.pauseAfter) return result
    }
    return {
      status: 'sent',
      pauseAfter: false,
      sentSeqEnd,
    }
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
      streamId: gap.streamId,
      reason: gap.reason,
      ...(typeof queueContext?.queueDepth === 'number' ? { queueDepth: queueContext.queueDepth } : {}),
      ...(typeof droppedSerializedApplicationJsonBytes === 'number'
        ? {
            droppedSerializedApplicationJsonBytes,
            droppedBytes: droppedSerializedApplicationJsonBytes,
          }
        : {}),
    }, gap.reason === 'queue_overflow' ? 'warn' : 'info')

    const sent = this.safeSend(ws, {
      type: 'terminal.output.gap',
      terminalId,
      streamId: gap.streamId,
      fromSeq: gap.fromSeq,
      toSeq: gap.toSeq,
      reason: gap.reason,
      ...(attachRequestId ? { attachRequestId } : {}),
    })
    if (sent) {
      this.logTerminalReplayGap({
        terminalId,
        connectionId: ws.connectionId,
        attachRequestId,
        streamId: gap.streamId,
        source: 'live',
        fromSeq: gap.fromSeq,
        toSeq: gap.toSeq,
        reason: gap.reason,
        ...(typeof queueContext?.queueDepth === 'number' ? { queueDepth: queueContext.queueDepth } : {}),
        ...(typeof droppedSerializedApplicationJsonBytes === 'number'
          ? { droppedSerializedApplicationJsonBytes }
          : {}),
      })
    }
    return sent
  }

  private sendReplayGap(
    ws: LiveWebSocket,
    terminalId: string,
    fromSeq: number,
    toSeq: number,
    streamId: string,
    attachRequestId?: string,
  ): boolean {
    this.perfEventLogger('terminal_stream_gap', {
      terminalId,
      connectionId: ws.connectionId,
      fromSeq,
      toSeq,
      streamId,
      reason: 'replay_window_exceeded',
    }, 'warn')

    const sent = this.safeSend(ws, {
      type: 'terminal.output.gap',
      terminalId,
      streamId,
      fromSeq,
      toSeq,
      reason: 'replay_window_exceeded',
      ...(attachRequestId ? { attachRequestId } : {}),
    })
    if (sent) {
      this.logTerminalReplayGap({
        terminalId,
        connectionId: ws.connectionId,
        attachRequestId,
        streamId,
        fromSeq,
        toSeq,
        reason: 'replay_window_exceeded',
        source: 'replay',
      })
    }
    return sent
  }

  private sendReplayGapWithPacing(
    terminalId: string,
    attachment: BrokerClientAttachment,
    fromSeq: number,
    toSeq: number,
    streamId: string,
    attachRequestId?: string,
  ): ReplaySendOutcome {
    const payload = {
      type: 'terminal.output.gap',
      terminalId,
      streamId,
      fromSeq,
      toSeq,
      reason: 'replay_window_exceeded',
      ...(attachRequestId ? { attachRequestId } : {}),
    }
    const backpressureFields = payloadBackpressureFields(payload)
    const prepared = this.prepareSendPayload(payload)
    if (!prepared) return { status: 'failed' }
    if (this.shouldPauseReplayBeforeSend(terminalId, attachment, prepared, backpressureFields)) {
      return { status: 'paused' }
    }

    this.perfEventLogger('terminal_stream_gap', {
      terminalId,
      connectionId: attachment.ws.connectionId,
      fromSeq,
      toSeq,
      streamId,
      reason: 'replay_window_exceeded',
    }, 'warn')

    const result = this.safeSendPrepared(attachment.ws, prepared)
    if (!result.sent) return { status: 'failed' }
    this.logTerminalReplayGap({
      terminalId,
      connectionId: attachment.ws.connectionId,
      attachRequestId,
      streamId,
      fromSeq,
      toSeq,
      reason: 'replay_window_exceeded',
      source: 'replay',
    })
    return {
      status: 'sent',
      pauseAfter: this.shouldPauseReplayAfterSend(terminalId, attachment, result, backpressureFields),
      sentSeqEnd: toSeq,
    }
  }

  private sendPreparedReplayPayloadWithPacing(
    terminalId: string,
    attachment: BrokerClientAttachment,
    prepared: PreparedJsonMessage,
    sentSeqEnd: number,
    options?: {
      backpressureFields?: ReplayBackpressurePayloadFields
      onSent?: (result: SendJsonResult) => void
    },
  ): ReplaySendOutcome {
    if (this.shouldPauseReplayBeforeSend(terminalId, attachment, prepared, options?.backpressureFields)) {
      return { status: 'paused' }
    }
    const result = this.safeSendPrepared(attachment.ws, prepared)
    if (!result.sent) return { status: 'failed' }
    options?.onSent?.(result)
    return {
      status: 'sent',
      pauseAfter: this.shouldPauseReplayAfterSend(terminalId, attachment, result, options?.backpressureFields),
      sentSeqEnd,
    }
  }

  private shouldPauseReplayBeforeSend(
    terminalId: string,
    attachment: BrokerClientAttachment,
    prepared: PreparedJsonMessage,
    backpressureFields?: ReplayBackpressurePayloadFields,
  ): boolean {
    const buffered = readWebSocketBufferedAmount(attachment.ws)
    if (typeof buffered !== 'number') return false
    const threshold = this.replayBufferedPauseThreshold(attachment)
    const projectedBufferedAmount = buffered + prepared.serializedApplicationJsonBytes
    if (projectedBufferedAmount <= threshold) {
      this.recordReplayBackpressureRecovery(terminalId, attachment)
      return false
    }
    this.pauseReplayForBackpressure(terminalId, attachment, {
      bufferedAmount: buffered,
      projectedBufferedAmount,
      threshold,
      serializedApplicationJsonBytes: prepared.serializedApplicationJsonBytes,
      phase: 'before_send',
      ...(backpressureFields ?? {}),
    })
    return true
  }

  private shouldPauseReplayAfterSend(
    terminalId: string,
    attachment: BrokerClientAttachment,
    result: SendJsonResult,
    backpressureFields?: ReplayBackpressurePayloadFields,
  ): boolean {
    const buffered = result.bufferedAfter
    if (typeof buffered !== 'number') return false
    const threshold = this.replayBufferedPauseThreshold(attachment)
    if (buffered <= threshold) {
      this.recordReplayBackpressureRecovery(terminalId, attachment)
      return false
    }
    this.pauseReplayForBackpressure(terminalId, attachment, {
      bufferedAmount: buffered,
      threshold,
      serializedApplicationJsonBytes: result.serializedApplicationJsonBytes,
      phase: 'after_send',
      ...(backpressureFields ?? {}),
    })
    return true
  }

  private replayBufferedPauseThreshold(attachment: BrokerClientAttachment): number {
    return attachment.priority === 'background'
      ? TERMINAL_BACKGROUND_BUFFERED_PAUSE_BYTES
      : TERMINAL_FOREGROUND_REPLAY_BUFFERED_PAUSE_BYTES
  }

  private replayBufferedPauseDelayMs(attachment: BrokerClientAttachment): number {
    return attachment.priority === 'background'
      ? TERMINAL_BACKGROUND_RETRY_FLUSH_MS
      : TERMINAL_STREAM_RETRY_FLUSH_MS
  }

  private pauseReplayForBackpressure(
    terminalId: string,
    attachment: BrokerClientAttachment,
    context: {
      bufferedAmount: number
      threshold: number
      serializedApplicationJsonBytes?: number
      projectedBufferedAmount?: number
      phase: 'before_send' | 'after_send'
      seqStart?: number
      seqEnd?: number
      rawFrameCount?: number
      dataBytes?: number
    },
  ): void {
    const retryMs = this.replayBufferedPauseDelayMs(attachment)
    const now = Date.now()
    const lastLogAt = attachment.replayBackpressureLogLastAt

    if (attachment.replayBackpressureActive !== true) {
      attachment.replayBackpressureActive = true
      attachment.replayBackpressureSince = now
      attachment.replayBackpressureLogLastAt = now
      attachment.replayBackpressureLogSuppressed = 0
      this.logReplayBackpressureState(terminalId, attachment, 'entered', context, {
        retryMs,
        now,
      })
      this.scheduleFlush(terminalId, attachment, retryMs)
      return
    }

    if (
      typeof lastLogAt === 'number'
      && now - lastLogAt < TERMINAL_REPLAY_BACKPRESSURE_LOG_RATE_LIMIT_MS
    ) {
      attachment.replayBackpressureLogSuppressed = (attachment.replayBackpressureLogSuppressed ?? 0) + 1
      this.scheduleFlush(terminalId, attachment, retryMs)
      return
    }

    const suppressedCount = attachment.replayBackpressureLogSuppressed ?? 0
    attachment.replayBackpressureLogLastAt = now
    attachment.replayBackpressureLogSuppressed = 0
    const backpressureDurationMs = Math.max(0, now - (attachment.replayBackpressureSince ?? now))
    this.logReplayBackpressureState(terminalId, attachment, 'still_blocked', context, {
      retryMs,
      suppressedCount,
      now,
    })
    this.flushTerminalReplayProgress(terminalId, attachment, 'backpressure', {
      backpressureDurationMs,
      ...(suppressedCount > 0 ? { suppressedBackpressureCount: suppressedCount } : {}),
    })
    this.scheduleFlush(terminalId, attachment, retryMs)
  }

  private recordReplayBackpressureRecovery(
    terminalId: string,
    attachment: BrokerClientAttachment,
  ): void {
    if (attachment.replayBackpressureActive === true) {
      const now = Date.now()
      this.logReplayBackpressureState(terminalId, attachment, 'recovered', {}, {
        suppressedCount: attachment.replayBackpressureLogSuppressed ?? 0,
        now,
      })
    }
    this.clearReplayBackpressureLogState(attachment)
  }

  private clearReplayBackpressureLogState(attachment: BrokerClientAttachment): void {
    attachment.replayBackpressureLogLastAt = undefined
    attachment.replayBackpressureLogSuppressed = 0
    attachment.replayBackpressureActive = false
    attachment.replayBackpressureSince = undefined
  }

  private logReplayBackpressureState(
    terminalId: string,
    attachment: BrokerClientAttachment,
    state: 'entered' | 'still_blocked' | 'recovered',
    context: Partial<{
      bufferedAmount: number
      threshold: number
      serializedApplicationJsonBytes: number
      projectedBufferedAmount: number
      phase: 'before_send' | 'after_send'
      seqStart: number
      seqEnd: number
      rawFrameCount: number
      dataBytes: number
    }>,
    options: {
      retryMs?: number
      suppressedCount?: number
      now: number
    },
  ): void {
    const durationMs = attachment.replayBackpressureSince !== undefined
      ? Math.max(0, options.now - attachment.replayBackpressureSince)
      : 0
    const level: 'debug' | 'warn' = attachment.priority === 'foreground'
      && durationMs >= FOREGROUND_REPLAY_BACKPRESSURE_WARN_MS
      && state !== 'entered'
      ? 'warn'
      : 'debug'
    const payload = {
      event: 'terminal.replay.backpressure_state',
      severity: level,
      state,
      terminalId,
      source: 'replay',
      reason: 'websocket_buffered_amount',
      connectionId: attachment.ws.connectionId,
      priority: attachment.priority,
      ...(typeof options.retryMs === 'number' ? { retryMs: options.retryMs } : {}),
      ...(attachment.activeAttachRequestId ? { attachRequestId: attachment.activeAttachRequestId } : {}),
      ...(attachment.replayCursor?.streamId ? { streamId: attachment.replayCursor.streamId } : {}),
      ...(options.suppressedCount && options.suppressedCount > 0 ? { suppressedCount: options.suppressedCount } : {}),
      ...(typeof attachment.replayCursor?.nextSeq === 'number'
        ? { nextSeq: attachment.replayCursor.nextSeq }
        : {}),
      ...(typeof attachment.replayCursor?.toSeq === 'number'
        ? { toSeq: attachment.replayCursor.toSeq }
        : {}),
      ...(typeof context.seqStart === 'number' ? { seqStart: context.seqStart } : {}),
      ...(typeof context.seqEnd === 'number' ? { seqEnd: context.seqEnd } : {}),
      ...(typeof context.rawFrameCount === 'number' ? { rawFrameCount: context.rawFrameCount } : {}),
      ...(typeof context.dataBytes === 'number' ? { dataBytes: context.dataBytes } : {}),
      ...(typeof context.bufferedAmount === 'number' ? { bufferedAmount: context.bufferedAmount } : {}),
      ...(typeof context.projectedBufferedAmount === 'number'
        ? { projectedBufferedAmount: context.projectedBufferedAmount }
        : {}),
      ...(typeof context.threshold === 'number' ? { threshold: context.threshold } : {}),
      ...(typeof context.serializedApplicationJsonBytes === 'number'
        ? {
            serializedBytes: context.serializedApplicationJsonBytes,
            serializedApplicationJsonBytes: context.serializedApplicationJsonBytes,
          }
        : {}),
      ...(context.phase ? { phase: context.phase } : {}),
      durationMs,
    }
    if (level === 'warn') {
      log.warn(payload, 'Terminal replay websocket backpressure state')
    } else {
      log.debug(payload, 'Terminal replay websocket backpressure state')
    }
  }

  private prepareSendPayload(payload: unknown): PreparedJsonMessage | null {
    try {
      return prepareJsonMessage(payload)
    } catch (error) {
      log.warn({
        err: error instanceof Error ? error : new Error(String(error)),
      }, 'WebSocket message serialization failed')
      return null
    }
  }

  private safeSendPrepared(ws: LiveWebSocket, prepared: PreparedJsonMessage): SendJsonResult {
    return sendPreparedJsonMessage(ws, prepared)
  }

  private safeSend(ws: LiveWebSocket, msg: unknown): boolean {
    return sendJsonMessage(ws, msg).sent
  }

  private handleTerminalExit(terminalId: string): void {
    const state = this.terminals.get(terminalId)
    if (!state) {
      this.streamIdentity.forgetStream(terminalId)
      return
    }
    for (const attachment of state.clients.values()) {
      if (attachment.flushTimer) clearTimeout(attachment.flushTimer)
      this.flushTerminalReplayProgress(terminalId, attachment, 'abandoned')
      this.clearReplayBackpressureLogState(attachment)
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
    source?: 'live' | 'replay'
  }): JsonPayload {
    return {
      type: input.type ?? 'terminal.output',
      terminalId: input.terminalId,
      streamId: input.streamId,
      seqStart: input.seqStart,
      seqEnd: input.seqEnd,
      data: input.data,
      ...(input.attachRequestId ? { attachRequestId: input.attachRequestId } : {}),
      ...(input.source ? { source: input.source } : {}),
    }
  }

  private measureOutputFrameSerializedApplicationJsonBytes(
    terminalId: string,
    frame: ReplayFrame,
    attachRequestId?: string,
    source?: 'live' | 'replay',
  ): number {
    return measureTerminalOutputPayloadBytes(this.buildTerminalOutputPayload({
      terminalId,
      streamId: frame.streamId,
      seqStart: frame.seqStart,
      seqEnd: frame.seqEnd,
      data: frame.data,
      attachRequestId,
      source,
    }))
  }

  private replaceStreamIdentity(terminalId: string, reason: TerminalStreamReplacementReason): string {
    const previousStreamId = this.streamIdentity.getStream(terminalId)
    const streamId = this.streamIdentity.replaceStream(terminalId, reason)
    const state = this.terminals.get(terminalId)
    if (state) {
      for (const attachment of state.clients.values()) {
        if (previousStreamId && reason === 'retention_lost') {
          attachment.queue.retagPendingStream(previousStreamId, streamId)
          for (const frame of attachment.attachStaging) {
            if (frame.streamId === previousStreamId) {
              frame.streamId = streamId
            }
          }
        }
        this.sendStreamChanged(
          attachment.ws,
          terminalId,
          streamId,
          reason,
          attachment.activeAttachRequestId,
        )
        this.convertReplayCursorToCurrentStreamGap(terminalId, attachment, streamId)
      }
    }
    log.info({
      terminalId,
      streamId,
      reason,
    }, 'Terminal output stream identity replaced')
    return streamId
  }

  private sendStreamChanged(
    ws: LiveWebSocket,
    terminalId: string,
    streamId: string,
    reason: TerminalStreamReplacementReason,
    attachRequestId?: string,
  ): boolean {
    return this.safeSend(ws, {
      type: 'terminal.stream.changed',
      terminalId,
      streamId,
      reason,
      ...(attachRequestId ? { attachRequestId } : {}),
    })
  }

  private convertReplayCursorToCurrentStreamGap(
    terminalId: string,
    attachment: BrokerClientAttachment,
    streamId: string,
  ): void {
    const cursor = attachment.replayCursor
    if (!cursor) return

    attachment.replayCursor = null
    const fromSeq = Math.max(cursor.nextSeq, attachment.lastSeq + 1)
    const toSeq = cursor.toSeq
    if (toSeq < fromSeq) return

    if (this.sendReplayGap(
      attachment.ws,
      terminalId,
      fromSeq,
      toSeq,
      streamId,
      attachment.activeAttachRequestId,
    )) {
      attachment.lastSeq = Math.max(attachment.lastSeq, toSeq)
    }
  }

  private handleReplayRetentionLoss(
    terminalId: string,
    state: BrokerTerminalState,
    retainedSuffixStreamId: string,
  ): string | undefined {
    if (!state.replayRing.consumeRetentionLoss()) return undefined
    const previousStreamId = this.streamIdentity.getStream(terminalId)
    const streamId = this.replaceStreamIdentity(terminalId, 'retention_lost')
    state.replayRing.retagRetainedStreamSuffix(retainedSuffixStreamId, streamId)
    const now = Date.now()
    const lastLogAt = state.replayRetentionLogLastAt
    if (
      typeof lastLogAt === 'number'
      && now - lastLogAt < TERMINAL_REPLAY_RETENTION_LOG_RATE_LIMIT_MS
    ) {
      state.replayRetentionLogSuppressed = (state.replayRetentionLogSuppressed ?? 0) + 1
      return streamId
    }
    const suppressedCount = state.replayRetentionLogSuppressed ?? 0
    state.replayRetentionLogLastAt = now
    state.replayRetentionLogSuppressed = 0
    this.logTerminalReplayRetention({
      terminalId,
      streamId,
      ...(previousStreamId ? { previousStreamId } : {}),
      attachRequestIds: [...state.clients.values()]
        .map((attachment) => attachment.activeAttachRequestId)
        .filter((attachRequestId): attachRequestId is string => Boolean(attachRequestId)),
      attachmentCount: state.clients.size,
      reason: 'retention_lost',
      retainedBytes: state.replayRing.retainedBytes(),
      maxBytes: state.replayRing.retentionMaxBytes(),
      tailSeq: state.replayRing.tailSeq(),
      headSeq: state.replayRing.headSeq(),
      ...(suppressedCount > 0 ? { suppressedCount } : {}),
    })
    return streamId
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
