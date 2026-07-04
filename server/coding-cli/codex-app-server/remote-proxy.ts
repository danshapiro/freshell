import WebSocket, { WebSocketServer } from 'ws'
import { allocateLocalhostPort, type LoopbackServerEndpoint } from '../../local-port.js'
import {
  CodexFsChangedNotificationSchema,
  CodexThreadLifecycleNotificationSchema,
  CodexTurnInterruptParamsSchema,
  CodexTurnCompletedNotificationSchema,
  CodexTurnStartedNotificationSchema,
  type CodexThreadHandle,
} from './protocol.js'
import type { CodexThreadLifecycleEvent, CodexThreadLifecycleLossEvent, CodexTurnEvent } from './client.js'
import { logger } from '../../logger.js'
import {
  MAX_FULL_PARSE_BYTES,
  MAX_RAW_FORWARD_BYTES,
  scanJsonRpcEnvelope,
} from './json-rpc-envelope.js'
import {
  extractForkResponseCandidate,
  extractFsChangedRepairTrigger,
  extractThreadLifecycleEvent,
  extractThreadStartResponseCandidate,
  extractThreadStartedNotificationSideEffects,
  extractTurnNotificationEvent,
  normalizeThreadForkResponseForTui,
  rewriteThreadForkRequestExcludeTurns,
} from './json-rpc-side-effects.js'

const log = logger.child({ component: 'codex-remote-proxy' })

export type CodexRemoteProxyCandidate = {
  thread: CodexThreadHandle
  source: 'thread_start_response' | 'thread_started_notification' | 'thread_fork_response'
}

export type CodexRemoteProxyRepairTrigger =
  | { kind: 'proxy_close' | 'proxy_error' | 'candidate_capture_timeout'; error?: Error }
  | { kind: 'fs_changed'; watchId: string; changedPaths: string[] }

type JsonRpcId = string | number

type ProxyFrame = {
  data: WebSocket.RawData | string
  binary: boolean
  byteLength: number
}

type UpstreamSideEffects = {
  candidates?: CodexRemoteProxyCandidate[]
  lifecycleEvents?: CodexThreadLifecycleEvent[]
  lifecycleLossEvents?: CodexThreadLifecycleLossEvent[]
  repairTriggers?: CodexRemoteProxyRepairTrigger[]
  threadId?: string
  turnCompletedParams?: Array<{ threadId: string; turnId?: string } & Record<string, unknown>>
  turnStartedParams?: Array<{ threadId: string; turnId?: string } & Record<string, unknown>>
}

type HeldProxyFrame = {
  connection: ProxyConnection
  direction: 'client' | 'upstream'
  frame: ProxyFrame
  id?: JsonRpcId
  method?: string
  upstreamEffects?: UpstreamSideEffects
}

type IdentityGateReason = 'initial_capture' | 'fork_handoff'

type IdentityGate = {
  reason: IdentityGateReason
  heldFrames: HeldProxyFrame[]
  heldBytes: number
  forkThreadId?: string
  requestTimer?: NodeJS.Timeout
}

type ProxyConnection = {
  client: WebSocket
  upstream: WebSocket
  pendingMethods: Map<JsonRpcId, string>
  pendingForkRequests: Map<JsonRpcId, { parentThreadId?: string }>
}

type CodexRemoteProxyOptions = {
  upstreamWsUrl: string
  portAllocator?: () => Promise<LoopbackServerEndpoint>
  requestHoldTimeoutMs?: number
  candidateCaptureTimeoutMs?: number
  requireCandidatePersistence?: boolean
  maxRawForwardBytes?: number
}

const DEFAULT_REQUEST_HOLD_TIMEOUT_MS = 5_000
const DEFAULT_CANDIDATE_CAPTURE_TIMEOUT_MS = 45_000
const MAX_COMPLETED_TURN_KEYS = 256
const MAX_HELD_IDENTITY_GATE_FRAMES = 32
const FORK_HANDOFF_STATEFUL_CLIENT_METHODS = new Set([
  'turn/start',
  'turn/steer',
  'turn/interrupt',
])
const STATEFUL_RESPONSE_METHODS = new Set(['thread/start', 'thread/fork'])
const STATEFUL_NOTIFICATION_METHODS = new Set([
  'thread/started',
  'turn/started',
  'turn/completed',
  'fs/changed',
  'thread/closed',
  'thread/status/changed',
])

export class CodexRemoteProxy {
  private readonly upstreamWsUrl: string
  private readonly portAllocator: () => Promise<LoopbackServerEndpoint>
  private readonly requestHoldTimeoutMs: number
  private readonly candidateCaptureTimeoutMs: number
  private readonly requireCandidatePersistence: boolean
  private readonly maxRawForwardBytes: number
  private server: WebSocketServer | null = null
  private endpoint: LoopbackServerEndpoint | null = null
  private identityGate: IdentityGate | undefined
  private candidateCaptureFailed = false
  private candidateCapturePaused = false
  private candidateCaptureTimer: NodeJS.Timeout | null = null
  private readonly connections = new Set<ProxyConnection>()
  private readonly candidateHandlers = new Set<(candidate: CodexRemoteProxyCandidate) => void>()
  private readonly turnStartedHandlers = new Set<(event: CodexTurnEvent) => void>()
  private readonly turnCompletedHandlers = new Set<(event: CodexTurnEvent) => void>()
  private readonly repairTriggerHandlers = new Set<(event: CodexRemoteProxyRepairTrigger) => void>()
  private readonly lifecycleHandlers = new Set<(event: CodexThreadLifecycleEvent) => void>()
  private readonly lifecycleLossHandlers = new Set<(event: CodexThreadLifecycleLossEvent) => void>()
  private readonly activeTurnKeys = new Set<string>()
  private readonly completedTurnKeys = new Set<string>()

  constructor(options: CodexRemoteProxyOptions) {
    this.upstreamWsUrl = options.upstreamWsUrl
    this.portAllocator = options.portAllocator ?? allocateLocalhostPort
    this.requestHoldTimeoutMs = options.requestHoldTimeoutMs ?? DEFAULT_REQUEST_HOLD_TIMEOUT_MS
    this.candidateCaptureTimeoutMs = options.candidateCaptureTimeoutMs ?? DEFAULT_CANDIDATE_CAPTURE_TIMEOUT_MS
    this.requireCandidatePersistence = options.requireCandidatePersistence ?? true
    this.maxRawForwardBytes = options.maxRawForwardBytes ?? MAX_RAW_FORWARD_BYTES
    this.identityGate = this.requireCandidatePersistence ? this.createIdentityGate('initial_capture') : undefined
  }

  get wsUrl(): string {
    if (!this.endpoint) {
      throw new Error('Codex remote proxy has not been started.')
    }
    return `ws://${this.endpoint.hostname}:${this.endpoint.port}`
  }

  async start(): Promise<{ wsUrl: string }> {
    if (this.server) return { wsUrl: this.wsUrl }
    const endpoint = await this.portAllocator()
    await new Promise<void>((resolve, reject) => {
      const server = new WebSocketServer({
        host: endpoint.hostname,
        maxPayload: this.maxRawForwardBytes,
        port: endpoint.port,
      }, () => resolve())
      server.once('error', reject)
      server.on('connection', (client) => this.handleClientConnection(client))
      this.server = server
      this.endpoint = endpoint
    })
    if (this.requireCandidatePersistence) {
      this.ensureCandidateCaptureTimer()
    }
    log.info({
      wsUrl: this.wsUrl,
      upstreamWsUrl: this.upstreamWsUrl,
      requireCandidatePersistence: this.requireCandidatePersistence,
      maxRawForwardBytes: this.maxRawForwardBytes,
    }, 'Codex remote proxy listening')
    return { wsUrl: this.wsUrl }
  }

  async close(): Promise<void> {
    this.clearCandidateCaptureTimer()
    const gate = this.identityGate
    if (gate) {
      this.identityGate = undefined
      this.clearIdentityGateRequestTimer(gate)
      for (const held of gate.heldFrames) {
        if (held.direction === 'client') {
          this.sendJsonRpcError(
            held.connection.client,
            held.id,
            'Codex remote proxy is closing before restore identity persistence completed.',
          )
        }
      }
    }
    for (const connection of [...this.connections]) {
      connection.pendingForkRequests.clear()
      connection.client.close()
      connection.upstream.close()
    }
    const server = this.server
    this.server = null
    this.endpoint = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  markCandidatePersisted(): void {
    const gate = this.identityGate
    if (!gate) return
    if (gate.reason === 'initial_capture' && this.candidateCaptureFailed) return
    this.identityGate = undefined
    this.clearIdentityGateRequestTimer(gate)
    if (gate.reason === 'initial_capture') {
      this.clearCandidateCaptureTimer()
    }
    for (const held of gate.heldFrames) {
      if (held.direction === 'client') {
        if (held.method === 'thread/fork') {
          this.handleThreadForkRequest(held.connection, held.frame, held.id)
        } else {
          this.forwardClientFrame(held.connection, held.frame, {
            id: held.id,
            method: held.method,
          })
        }
      } else {
        if (held.upstreamEffects) {
          this.applyUpstreamSideEffects(held.upstreamEffects)
        }
        sendFrameIfOpen(held.connection.client, held.frame)
      }
    }
  }

  failCandidateCapture(message = 'Freshell could not persist Codex restore identity before accepting user input.'): void {
    if (this.identityGate?.reason !== 'initial_capture') return
    if (this.candidateCaptureFailed) return
    this.candidateCaptureFailed = true
    this.clearCandidateCaptureTimer()
    this.failIdentityGate(this.identityGate, message, { closeAllConnections: true })
  }

  pauseCandidateCapture(reason: string): void {
    if (this.identityGate?.reason !== 'initial_capture') return
    if (this.candidateCaptureFailed) return
    this.candidateCapturePaused = true
    this.clearCandidateCaptureTimer()
    log.info({ reason }, 'Paused Codex restore identity candidate-capture timeout')
  }

  resumeCandidateCapture(reason: string): void {
    if (this.identityGate?.reason !== 'initial_capture') return
    if (this.candidateCaptureFailed) return
    this.candidateCapturePaused = false
    this.ensureCandidateCaptureTimer()
    log.info({ reason }, 'Resumed Codex restore identity candidate-capture timeout')
  }

  onCandidate(handler: (candidate: CodexRemoteProxyCandidate) => void): () => void {
    this.candidateHandlers.add(handler)
    return () => this.candidateHandlers.delete(handler)
  }

  onTurnStarted(handler: (event: CodexTurnEvent) => void): () => void {
    this.turnStartedHandlers.add(handler)
    return () => this.turnStartedHandlers.delete(handler)
  }

  onTurnCompleted(handler: (event: CodexTurnEvent) => void): () => void {
    this.turnCompletedHandlers.add(handler)
    return () => this.turnCompletedHandlers.delete(handler)
  }

  onRepairTrigger(handler: (event: CodexRemoteProxyRepairTrigger) => void): () => void {
    this.repairTriggerHandlers.add(handler)
    return () => this.repairTriggerHandlers.delete(handler)
  }

  onThreadLifecycle(handler: (event: CodexThreadLifecycleEvent) => void): () => void {
    this.lifecycleHandlers.add(handler)
    return () => this.lifecycleHandlers.delete(handler)
  }

  onLifecycleLoss(handler: (event: CodexThreadLifecycleLossEvent) => void): () => void {
    this.lifecycleLossHandlers.add(handler)
    return () => this.lifecycleLossHandlers.delete(handler)
  }

  private handleClientConnection(client: WebSocket): void {
    if (this.candidateCaptureFailed) {
      this.sendJsonRpcError(client, undefined, 'Freshell timed out before Codex restore identity was captured.')
      client.close()
      return
    }
    const upstream = new WebSocket(this.upstreamWsUrl, {
      maxPayload: this.maxRawForwardBytes,
      perMessageDeflate: false,
    })
    const connection: ProxyConnection = {
      client,
      upstream,
      pendingMethods: new Map(),
      pendingForkRequests: new Map(),
    }
    this.connections.add(connection)
    if (this.requireCandidatePersistence) {
      this.ensureCandidateCaptureTimer()
    }
    log.info({
      proxyWsUrl: this.wsUrl,
      upstreamWsUrl: this.upstreamWsUrl,
      requireCandidatePersistence: this.requireCandidatePersistence,
      activeConnections: this.connections.size,
    }, 'Codex remote proxy client connected')

    client.on('message', (raw, isBinary) => this.handleClientMessage(connection, raw, isBinary))
    upstream.on('message', (raw, isBinary) => this.handleUpstreamMessage(connection, raw, isBinary))
    upstream.on('open', () => {
      log.info({
        proxyWsUrl: this.wsUrl,
        upstreamWsUrl: this.upstreamWsUrl,
      }, 'Codex remote proxy upstream connected')
    })

    const closeBoth = () => {
      this.connections.delete(connection)
      connection.pendingForkRequests.clear()
      client.close()
      upstream.close()
    }
    client.on('close', (code, reason) => {
      log.info({
        proxyWsUrl: this.endpoint ? this.wsUrl : undefined,
        upstreamWsUrl: this.upstreamWsUrl,
        code,
        reason: reason.toString(),
        activeConnections: Math.max(0, this.connections.size - 1),
      }, 'Codex remote proxy client closed')
      closeBoth()
    })
    upstream.on('close', (code, reason) => {
      log.warn({
        proxyWsUrl: this.endpoint ? this.wsUrl : undefined,
        upstreamWsUrl: this.upstreamWsUrl,
        code,
        reason: reason.toString(),
        activeConnections: Math.max(0, this.connections.size - 1),
      }, 'Codex remote proxy upstream closed')
      this.emitRepairTrigger({ kind: 'proxy_close' })
      closeBoth()
    })
    client.on('error', (error) => {
      log.warn({
        err: error,
        proxyWsUrl: this.endpoint ? this.wsUrl : undefined,
        upstreamWsUrl: this.upstreamWsUrl,
      }, 'Codex remote proxy client error')
      this.emitRepairTrigger({ kind: 'proxy_error', error })
      closeBoth()
    })
    upstream.on('error', (error) => {
      log.warn({
        err: error,
        proxyWsUrl: this.endpoint ? this.wsUrl : undefined,
        upstreamWsUrl: this.upstreamWsUrl,
      }, 'Codex remote proxy upstream error')
      this.emitRepairTrigger({ kind: 'proxy_error', error })
      closeBoth()
    })
  }

  private handleClientMessage(connection: ProxyConnection, raw: WebSocket.RawData, isBinary: boolean): void {
    const frame = createProxyFrame(raw, isBinary)
    const sizeEnvelope = frame.byteLength <= MAX_FULL_PARSE_BYTES
      ? scanJsonRpcEnvelope(frame.data)
      : undefined
    if (frame.byteLength > this.maxRawForwardBytes) {
      const id = sizeEnvelope?.ok ? sizeEnvelope.id : undefined
      log.warn({
        proxyWsUrl: this.endpoint ? this.wsUrl : undefined,
        upstreamWsUrl: this.upstreamWsUrl,
        frameBytes: frame.byteLength,
        maxRawForwardBytes: this.maxRawForwardBytes,
        id,
      }, 'Codex remote proxy rejected oversized client frame')
      this.rejectClientFrame(
        connection,
        id,
        'Codex remote proxy rejected a JSON-RPC frame because it is too large.',
        { close: true, repairKind: 'proxy_error' },
      )
      return
    }

    const envelope = sizeEnvelope ?? scanJsonRpcEnvelope(frame.data)
    if (!envelope.ok) {
      log.warn({
        proxyWsUrl: this.endpoint ? this.wsUrl : undefined,
        upstreamWsUrl: this.upstreamWsUrl,
        reason: envelope.reason,
        frameBytes: frame.byteLength,
      }, 'Codex remote proxy rejected unsupported client JSON-RPC frame')
      this.rejectClientFrame(
        connection,
        undefined,
        clientEnvelopeFailureMessage(envelope.reason),
        { close: true, repairKind: 'proxy_error' },
      )
      return
    }

    const method = envelope.method
    const id = envelope.id
    if (typeof method === 'string') {
      log.debug({
        proxyWsUrl: this.endpoint ? this.wsUrl : undefined,
        upstreamWsUrl: this.upstreamWsUrl,
        method,
        id,
      }, 'Codex remote proxy received client request')
    }

    if (this.identityGate?.reason === 'initial_capture' && (method === 'turn/start' || method === 'thread/fork')) {
      this.holdIdentityGateFrame(connection, frame, { id, method })
      return
    }

    if (method === 'thread/fork') {
      this.handleThreadForkRequest(connection, frame, id)
      return
    }

    if (this.identityGate?.reason === 'fork_handoff' && method && FORK_HANDOFF_STATEFUL_CLIENT_METHODS.has(method)) {
      this.holdIdentityGateFrame(connection, frame, { id, method })
      return
    }

    if (method === 'turn/interrupt') {
      const parsed = frame.byteLength <= MAX_FULL_PARSE_BYTES ? parseJsonFrame(frame) : undefined
      const completedTurnInterrupt = this.completedTurnInterrupt(parsed)
      if (id !== undefined && completedTurnInterrupt) {
        log.info({
          proxyWsUrl: this.endpoint ? this.wsUrl : undefined,
          upstreamWsUrl: this.upstreamWsUrl,
          method,
          id,
          threadId: completedTurnInterrupt.threadId,
          turnId: completedTurnInterrupt.turnId,
        }, 'Codex remote proxy acknowledged interrupt for completed turn')
        this.sendJsonRpcSuccess(connection.client, id, {})
        return
      }
    }

    this.forwardClientFrame(connection, frame, { id, method })
  }

  private handleUpstreamMessage(connection: ProxyConnection, raw: WebSocket.RawData, isBinary: boolean): void {
    const frame = createProxyFrame(raw, isBinary)
    if (frame.byteLength > this.maxRawForwardBytes) {
      this.failUnsafeUpstreamFrame(connection, undefined, 'raw_forward_cap_exceeded')
      return
    }

    const envelope = scanJsonRpcEnvelope(frame.data)
    if (!envelope.ok) {
      this.failUnsafeUpstreamFrame(connection, undefined, envelope.reason)
      return
    }

    const id = envelope.id
    if (id !== undefined) {
      const method = connection.pendingMethods.get(id)
      const forkRequest = connection.pendingForkRequests.get(id)
      if (method !== undefined) {
        connection.pendingMethods.delete(id)
      }
      log.debug({
        proxyWsUrl: this.endpoint ? this.wsUrl : undefined,
        upstreamWsUrl: this.upstreamWsUrl,
        method,
        id,
      }, 'Codex remote proxy forwarding upstream response')

      if (method === 'thread/start') {
        this.handleThreadStartResponse(connection, frame, id)
        return
      }
      if (method === 'thread/fork' || forkRequest) {
        this.handleThreadForkResponse(connection, frame, id, forkRequest)
        return
      }
      sendFrameIfOpen(connection.client, frame)
      return
    }

    const method = envelope.method
    if (typeof method === 'string') {
      log.debug({
        proxyWsUrl: this.endpoint ? this.wsUrl : undefined,
        upstreamWsUrl: this.upstreamWsUrl,
        method,
      }, 'Codex remote proxy forwarding upstream notification')
    }

    if (typeof method === 'string' && STATEFUL_NOTIFICATION_METHODS.has(method)) {
      this.handleStatefulUpstreamNotification(connection, frame, method)
      return
    }

    sendFrameIfOpen(connection.client, frame)
  }

  private maybeEmitThreadStartResponseCandidate(parsed: unknown): void {
    if (!parsed || typeof parsed !== 'object') return
    const result = (parsed as Record<string, unknown>).result
    const thread = result && typeof result === 'object'
      ? normalizeCandidateThread((result as Record<string, unknown>).thread)
      : undefined
    if (!thread) return
    this.emitCandidate({
      thread,
      source: 'thread_start_response',
    })
  }

  private handleThreadStartResponse(connection: ProxyConnection, frame: ProxyFrame, id: JsonRpcId): void {
    if (frame.byteLength <= MAX_FULL_PARSE_BYTES) {
      this.maybeEmitThreadStartResponseCandidate(parseJsonFrame(frame))
      sendFrameIfOpen(connection.client, frame)
      return
    }

    const extracted = extractThreadStartResponseCandidate(frame.data, {
      pendingThreadStartRequestIds: new Set([id]),
    })
    if (!extracted.ok) {
      this.failUnsafeUpstreamFrame(connection, 'thread/start', extracted.reason)
      return
    }

    this.emitCandidate(extracted.candidate)
    sendFrameIfOpen(connection.client, frame)
  }

  private handleThreadForkResponse(
    connection: ProxyConnection,
    frame: ProxyFrame,
    id: JsonRpcId,
    forkRequest: { parentThreadId?: string } | undefined,
  ): void {
    if (this.identityGate?.reason === 'initial_capture') {
      this.failUnsafeUpstreamFrame(connection, 'thread/fork', 'initial_capture_active')
      return
    }
    if (this.identityGate?.reason === 'fork_handoff') {
      this.failUnsafeUpstreamFrame(connection, 'thread/fork', 'fork_handoff_active')
      return
    }

    const extracted = extractForkResponseCandidate(frame.data, {
      parentThreadId: forkRequest?.parentThreadId,
      pendingForkRequestIds: forkRequest ? new Set([id]) : new Set(),
      provenForkPathField: 'path',
    })
    connection.pendingForkRequests.delete(id)
    if (!extracted.ok) {
      this.failUnsafeUpstreamFrame(connection, 'thread/fork', extracted.reason)
      return
    }

    const normalized = normalizeThreadForkResponseForTui(frame.data)
    if (!normalized.ok) {
      this.failUnsafeUpstreamFrame(connection, 'thread/fork', normalized.reason)
      return
    }

    const candidate = extracted.candidate
    this.identityGate = this.createIdentityGate('fork_handoff', candidate.thread.id)
    this.emitCandidate(candidate)

    const forwardedFrame = createProxyFrame(normalized.raw, frame.binary)
    if (forwardedFrame.byteLength > this.maxRawForwardBytes) {
      this.failUnsafeUpstreamFrame(connection, 'thread/fork', 'raw_forward_cap_exceeded')
      return
    }
    sendFrameIfOpen(connection.client, forwardedFrame)
  }

  private handleStatefulUpstreamNotification(
    connection: ProxyConnection,
    frame: ProxyFrame,
    method: string,
  ): void {
    const parsed = frame.byteLength <= MAX_FULL_PARSE_BYTES ? parseJsonFrame(frame) : undefined
    const effects = parsed !== undefined
      ? this.collectParsedUpstreamNotificationSideEffects(parsed)
      : this.extractLargeUpstreamNotificationSideEffects(frame, method)

    if (!effects) {
      if (frame.byteLength > MAX_FULL_PARSE_BYTES || this.identityGate?.reason === 'fork_handoff') {
        this.failUnsafeUpstreamFrame(connection, method, 'unrecoverable_stateful_frame')
        return
      }
      sendFrameIfOpen(connection.client, frame)
      return
    }

    const gate = this.identityGate
    if (gate?.reason === 'fork_handoff' && effects.threadId === gate.forkThreadId) {
      this.holdIdentityGateUpstreamFrame(connection, frame, method, effects)
      return
    }

    this.applyUpstreamSideEffects(effects)
    sendFrameIfOpen(connection.client, frame)
  }

  private collectParsedUpstreamNotificationSideEffects(parsed: unknown): UpstreamSideEffects | undefined {
    const method = parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>).method
      : undefined
    if (method === 'thread/started') {
      const params = (parsed as Record<string, unknown>).params
      const thread = params && typeof params === 'object'
        ? normalizeCandidateThread((params as Record<string, unknown>).thread)
        : undefined
      if (!thread) return
      return {
        candidates: [{
          thread,
          source: 'thread_started_notification',
        }],
        lifecycleEvents: [{
          kind: 'thread_started',
          thread,
        }],
        threadId: thread.id,
      }
    }

    const turnStarted = CodexTurnStartedNotificationSchema.safeParse(parsed)
    if (turnStarted.success) {
      return {
        threadId: turnStarted.data.params.threadId,
        turnStartedParams: [turnStarted.data.params],
      }
    }

    const turnCompleted = CodexTurnCompletedNotificationSchema.safeParse(parsed)
    if (turnCompleted.success) {
      return {
        threadId: turnCompleted.data.params.threadId,
        turnCompletedParams: [turnCompleted.data.params],
      }
    }

    const fsChanged = CodexFsChangedNotificationSchema.safeParse(parsed)
    if (fsChanged.success) {
      return {
        repairTriggers: [{ kind: 'fs_changed', ...fsChanged.data.params }],
      }
    }

    const lifecycle = CodexThreadLifecycleNotificationSchema.safeParse(parsed)
    if (lifecycle.success) {
      if (lifecycle.data.method === 'thread/closed') {
        return {
          lifecycleEvents: [{ kind: 'thread_closed', threadId: lifecycle.data.params.threadId }],
          lifecycleLossEvents: [{ method: 'thread/closed', threadId: lifecycle.data.params.threadId }],
          threadId: lifecycle.data.params.threadId,
        }
      }
      if (lifecycle.data.method === 'thread/status/changed') {
        const lossEvents: CodexThreadLifecycleLossEvent[] = []
        const status = lifecycle.data.params.status.type
        if (status === 'notLoaded' || status === 'systemError') {
          lossEvents.push({
            method: 'thread/status/changed',
            threadId: lifecycle.data.params.threadId,
            status,
          })
        }
        return {
          lifecycleEvents: [{
            kind: 'thread_status_changed',
            threadId: lifecycle.data.params.threadId,
            status: lifecycle.data.params.status,
          }],
          ...(lossEvents.length > 0 ? { lifecycleLossEvents: lossEvents } : {}),
          threadId: lifecycle.data.params.threadId,
        }
      }
    }

    return undefined
  }

  private extractLargeUpstreamNotificationSideEffects(frame: ProxyFrame, method: string): UpstreamSideEffects | undefined {
    if (method === 'thread/started') {
      const extracted = extractThreadStartedNotificationSideEffects(frame.data)
      if (!extracted.ok) return undefined
      return {
        candidates: [extracted.candidate],
        lifecycleEvents: [extracted.lifecycle],
        threadId: extracted.candidate.thread.id,
      }
    }

    if (method === 'turn/started' || method === 'turn/completed') {
      const extracted = extractTurnNotificationEvent(frame.data)
      if (!extracted.ok) return undefined
      const params = {
        threadId: extracted.event.threadId,
        ...(typeof extracted.event.turnId === 'string' ? { turnId: extracted.event.turnId } : {}),
        ...('status' in extracted.event && typeof extracted.event.status === 'string'
          ? { status: extracted.event.status }
          : {}),
      }
      if (extracted.event.kind === 'turn_started') {
        return {
          threadId: extracted.event.threadId,
          turnStartedParams: [params],
        }
      }
      return {
        threadId: extracted.event.threadId,
        turnCompletedParams: [params],
      }
    }

    if (method === 'fs/changed') {
      const extracted = extractFsChangedRepairTrigger(frame.data)
      if (!extracted.ok) return undefined
      return {
        repairTriggers: [extracted.trigger],
      }
    }

    if (method === 'thread/closed' || method === 'thread/status/changed') {
      const extracted = extractThreadLifecycleEvent(frame.data)
      if (!extracted.ok) return undefined
      if (extracted.event.kind === 'thread_closed') {
        return {
          lifecycleEvents: [extracted.event],
          lifecycleLossEvents: [{ method: 'thread/closed', threadId: extracted.event.threadId }],
          threadId: extracted.event.threadId,
        }
      }
      const lossEvents: CodexThreadLifecycleLossEvent[] = []
      const status = extracted.event.status.type
      if (status === 'notLoaded' || status === 'systemError') {
        lossEvents.push({
          method: 'thread/status/changed',
          threadId: extracted.event.threadId,
          status,
        })
      }
      return {
        lifecycleEvents: [extracted.event],
        ...(lossEvents.length > 0 ? { lifecycleLossEvents: lossEvents } : {}),
        threadId: extracted.event.threadId,
      }
    }

    return undefined
  }

  private applyUpstreamSideEffects(effects: UpstreamSideEffects): void {
    for (const candidate of effects.candidates ?? []) {
      this.emitCandidate(candidate)
    }
    for (const params of effects.turnStartedParams ?? []) {
      this.recordTurnStarted(params)
      this.emitTurnEvent(this.turnStartedHandlers, params)
    }
    for (const params of effects.turnCompletedParams ?? []) {
      this.recordTurnCompleted(params)
      this.emitTurnEvent(this.turnCompletedHandlers, params)
    }
    for (const trigger of effects.repairTriggers ?? []) {
      this.emitRepairTrigger(trigger)
    }
    for (const event of effects.lifecycleEvents ?? []) {
      this.emitThreadLifecycle(event)
    }
    for (const event of effects.lifecycleLossEvents ?? []) {
      this.emitLifecycleLoss(event)
    }
  }

  private handleThreadForkRequest(connection: ProxyConnection, frame: ProxyFrame, id: JsonRpcId | undefined): void {
    if (this.identityGate?.reason === 'fork_handoff') {
      this.rejectClientFrame(
        connection,
        id,
        'Codex remote proxy rejected nested thread/fork while a fork handoff is waiting for persistence.',
        { close: true, repairKind: 'proxy_error' },
      )
      return
    }

    const rewritten = rewriteThreadForkRequestExcludeTurns(frame.data)
    if (!rewritten.ok) {
      this.rejectClientFrame(
        connection,
        id,
        `Codex remote proxy could not safely rewrite thread/fork request: ${rewritten.reason}.`,
      )
      return
    }

    const rewrittenFrame = createProxyFrame(rewritten.raw, frame.binary)
    if (rewrittenFrame.byteLength > this.maxRawForwardBytes) {
      this.rejectClientFrame(
        connection,
        id,
        'Codex remote proxy rejected a rewritten thread/fork request because it is too large.',
        { close: true, repairKind: 'proxy_error' },
      )
      return
    }

    if (id !== undefined) {
      connection.pendingForkRequests.set(id, {
        parentThreadId: extractThreadForkParentThreadId(frame),
      })
    }
    this.forwardClientFrame(connection, rewrittenFrame, { id, method: 'thread/fork' })
  }

  private forwardClientFrame(
    connection: ProxyConnection,
    frame: ProxyFrame,
    request: { id?: JsonRpcId; method?: string },
  ): void {
    if (request.id !== undefined && typeof request.method === 'string') {
      connection.pendingMethods.set(request.id, request.method)
    }
    sendFrameIfOpen(connection.upstream, frame)
  }

  private holdIdentityGateFrame(
    connection: ProxyConnection,
    frame: ProxyFrame,
    request: { id?: JsonRpcId; method?: string },
  ): void {
    const gate = this.identityGate
    if (!gate) {
      this.forwardClientFrame(connection, frame, request)
      return
    }

    const nextHeldBytes = gate.heldBytes + frame.byteLength
    if (
      gate.heldFrames.length >= MAX_HELD_IDENTITY_GATE_FRAMES ||
      nextHeldBytes > this.maxRawForwardBytes
    ) {
      gate.heldFrames.push({
        connection,
        direction: 'client',
        frame,
        id: request.id,
        method: request.method,
      })
      gate.heldBytes = nextHeldBytes
      this.failIdentityGate(
        gate,
        identityGateOverflowMessage(gate.reason),
        { closeAllConnections: gate.reason === 'initial_capture' },
      )
      return
    }

    gate.heldFrames.push({
      connection,
      direction: 'client',
      frame,
      id: request.id,
      method: request.method,
    })
    gate.heldBytes = nextHeldBytes
    if (!gate.requestTimer) {
      gate.requestTimer = setTimeout(() => {
        this.failIdentityGate(
          gate,
          identityGateTimeoutMessage(gate.reason),
          { closeAllConnections: gate.reason === 'initial_capture' },
        )
      }, this.requestHoldTimeoutMs)
      gate.requestTimer.unref?.()
    }
  }

  private holdIdentityGateUpstreamFrame(
    connection: ProxyConnection,
    frame: ProxyFrame,
    method: string,
    upstreamEffects: UpstreamSideEffects,
  ): void {
    const gate = this.identityGate
    if (gate?.reason !== 'fork_handoff') {
      this.applyUpstreamSideEffects(upstreamEffects)
      sendFrameIfOpen(connection.client, frame)
      return
    }

    const nextHeldBytes = gate.heldBytes + frame.byteLength
    if (
      gate.heldFrames.length >= MAX_HELD_IDENTITY_GATE_FRAMES ||
      nextHeldBytes > this.maxRawForwardBytes
    ) {
      gate.heldFrames.push({
        connection,
        direction: 'upstream',
        frame,
        method,
        upstreamEffects,
      })
      gate.heldBytes = nextHeldBytes
      this.failIdentityGate(
        gate,
        identityGateOverflowMessage(gate.reason),
        { closeAllConnections: false },
      )
      return
    }

    gate.heldFrames.push({
      connection,
      direction: 'upstream',
      frame,
      method,
      upstreamEffects,
    })
    gate.heldBytes = nextHeldBytes
    if (!gate.requestTimer) {
      gate.requestTimer = setTimeout(() => {
        this.failIdentityGate(
          gate,
          identityGateTimeoutMessage(gate.reason),
          { closeAllConnections: false },
        )
      }, this.requestHoldTimeoutMs)
      gate.requestTimer.unref?.()
    }
  }

  private failIdentityGate(
    gate: IdentityGate,
    message: string,
    options: { closeAllConnections: boolean },
  ): void {
    if (this.identityGate !== gate) return
    this.identityGate = undefined
    this.clearIdentityGateRequestTimer(gate)
    if (gate.reason === 'initial_capture') {
      this.candidateCaptureFailed = true
      this.clearCandidateCaptureTimer()
      this.emitRepairTrigger({ kind: 'candidate_capture_timeout' })
    } else {
      this.emitRepairTrigger({ kind: 'proxy_error', error: new Error(message) })
    }

    const connectionsToClose = options.closeAllConnections
      ? new Set(this.connections)
      : new Set(gate.heldFrames.map((held) => held.connection))
    const sentConnectionErrors = new Set<ProxyConnection>()
    for (const held of gate.heldFrames) {
      if (held.direction !== 'client') continue
      this.sendJsonRpcError(held.connection.client, held.id, message)
      sentConnectionErrors.add(held.connection)
    }
    for (const connection of connectionsToClose) {
      if (!sentConnectionErrors.has(connection)) {
        this.sendJsonRpcError(connection.client, undefined, message)
      }
      connection.client.close()
      connection.upstream.close()
    }
  }

  private rejectClientFrame(
    connection: ProxyConnection,
    id: JsonRpcId | undefined,
    message: string,
    options: { close?: boolean; repairKind?: 'proxy_error' } = {},
  ): void {
    this.sendJsonRpcError(connection.client, id, message)
    if (options.repairKind === 'proxy_error') {
      this.emitRepairTrigger({ kind: 'proxy_error', error: new Error(message) })
    }
    if (options.close) {
      connection.client.close()
      connection.upstream.close()
    }
  }

  private failUnsafeUpstreamFrame(
    connection: ProxyConnection,
    method: string | undefined,
    reason: string,
  ): void {
    const message = method
      ? `Codex remote proxy rejected an unsafe upstream ${method} frame: ${reason}.`
      : `Codex remote proxy rejected an unsafe upstream frame: ${reason}.`
    log.warn({
      proxyWsUrl: this.endpoint ? this.wsUrl : undefined,
      upstreamWsUrl: this.upstreamWsUrl,
      method,
      reason,
    }, 'Codex remote proxy failed closed on unsafe upstream frame')

    if (
      this.identityGate?.reason === 'initial_capture' &&
      typeof method === 'string' &&
      STATEFUL_RESPONSE_METHODS.has(method)
    ) {
      this.failCandidateCapture(
        'Freshell could not safely capture Codex restore identity from an oversized app-server frame.',
      )
      return
    }

    this.emitRepairTrigger({ kind: 'proxy_error', error: new Error(message) })
    connection.client.close()
    connection.upstream.close()
  }

  private createIdentityGate(reason: IdentityGateReason, forkThreadId?: string): IdentityGate {
    return {
      reason,
      heldFrames: [],
      heldBytes: 0,
      ...(forkThreadId !== undefined ? { forkThreadId } : {}),
    }
  }

  private clearIdentityGateRequestTimer(gate: IdentityGate): void {
    if (!gate.requestTimer) return
    clearTimeout(gate.requestTimer)
    gate.requestTimer = undefined
  }

  private sendJsonRpcError(client: WebSocket, id: JsonRpcId | undefined, message: string): void {
    sendIfOpen(client, JSON.stringify({
      jsonrpc: '2.0',
      ...(id !== undefined ? { id } : {}),
      error: {
        code: -32000,
        message,
      },
    }), false)
  }

  private sendJsonRpcSuccess(client: WebSocket, id: JsonRpcId, result: Record<string, never>): void {
    sendIfOpen(client, JSON.stringify({ id, result }), false)
  }

  private ensureCandidateCaptureTimer(): void {
    if (this.identityGate?.reason !== 'initial_capture') return
    if (this.candidateCaptureFailed || this.candidateCapturePaused || this.candidateCaptureTimer) return
    this.candidateCaptureTimer = setTimeout(() => {
      this.failCandidateCapture('Freshell timed out before Codex restore identity was captured.')
    }, this.candidateCaptureTimeoutMs)
    this.candidateCaptureTimer.unref?.()
  }

  private clearCandidateCaptureTimer(): void {
    if (!this.candidateCaptureTimer) return
    clearTimeout(this.candidateCaptureTimer)
    this.candidateCaptureTimer = null
  }

  private emitCandidate(candidate: CodexRemoteProxyCandidate): void {
    log.info({
      threadId: candidate.thread.id,
      rolloutPath: candidate.thread.path,
      source: candidate.source,
    }, 'Codex remote proxy observed candidate restore identity')
    for (const handler of this.candidateHandlers) {
      handler(candidate)
    }
  }

  private emitTurnEvent(handlers: Set<(event: CodexTurnEvent) => void>, params: { threadId: string; turnId?: string } & Record<string, unknown>): void {
    const event: CodexTurnEvent = {
      threadId: params.threadId,
      ...(typeof params.turnId === 'string' ? { turnId: params.turnId } : {}),
      params,
    }
    for (const handler of handlers) {
      handler(event)
    }
  }

  private recordTurnStarted(params: { threadId: string; turnId?: string }): void {
    if (typeof params.turnId !== 'string') return
    const key = turnKey(params.threadId, params.turnId)
    this.activeTurnKeys.add(key)
    this.completedTurnKeys.delete(key)
  }

  private recordTurnCompleted(params: { threadId: string; turnId?: string }): void {
    if (typeof params.turnId !== 'string') return
    const key = turnKey(params.threadId, params.turnId)
    this.activeTurnKeys.delete(key)
    this.rememberCompletedTurnKey(key)
  }

  private rememberCompletedTurnKey(key: string): void {
    this.completedTurnKeys.delete(key)
    this.completedTurnKeys.add(key)
    while (this.completedTurnKeys.size > MAX_COMPLETED_TURN_KEYS) {
      const oldest = this.completedTurnKeys.values().next().value
      if (typeof oldest !== 'string') return
      this.completedTurnKeys.delete(oldest)
    }
  }

  private completedTurnInterrupt(parsed: unknown): { threadId: string; turnId: string } | undefined {
    if (!parsed || typeof parsed !== 'object') return undefined
    const message = parsed as Record<string, unknown>
    if (message.method !== 'turn/interrupt') return undefined
    const params = CodexTurnInterruptParamsSchema.safeParse(message.params)
    if (!params.success) return undefined
    const key = turnKey(params.data.threadId, params.data.turnId)
    return this.completedTurnKeys.has(key) && !this.activeTurnKeys.has(key) ? params.data : undefined
  }

  private emitRepairTrigger(event: CodexRemoteProxyRepairTrigger): void {
    for (const handler of this.repairTriggerHandlers) {
      handler(event)
    }
  }

  private emitThreadLifecycle(event: CodexThreadLifecycleEvent): void {
    for (const handler of this.lifecycleHandlers) {
      handler(event)
    }
  }

  private emitLifecycleLoss(event: CodexThreadLifecycleLossEvent): void {
    for (const handler of this.lifecycleLossHandlers) {
      handler(event)
    }
  }
}

function createProxyFrame(data: WebSocket.RawData | string, binary: boolean): ProxyFrame {
  return {
    data,
    binary,
    byteLength: frameByteLength(data),
  }
}

function parseJsonFrame(frame: ProxyFrame): unknown {
  try {
    return JSON.parse(rawDataToBuffer(frame.data).toString())
  } catch {
    return undefined
  }
}

function sendFrameIfOpen(socket: WebSocket, frame: ProxyFrame): void {
  sendIfOpen(socket, frame.data, frame.binary)
}

function sendIfOpen(socket: WebSocket, data: WebSocket.RawData | string, binary: boolean): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(data, { binary })
  } else if (socket.readyState === WebSocket.CONNECTING) {
    socket.once('open', () => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data, { binary })
    })
  }
}

function frameByteLength(data: WebSocket.RawData | string): number {
  if (typeof data === 'string') return Buffer.byteLength(data)
  if (Buffer.isBuffer(data)) return data.byteLength
  if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.byteLength, 0)
  return data.byteLength
}

function rawDataToBuffer(data: WebSocket.RawData | string): Buffer {
  if (typeof data === 'string') return Buffer.from(data)
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data.map((part) => Buffer.from(part)))
  return Buffer.from(data)
}

function extractThreadForkParentThreadId(frame: ProxyFrame): string | undefined {
  if (frame.byteLength <= MAX_FULL_PARSE_BYTES) {
    const parsed = parseJsonFrame(frame)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const params = (parsed as Record<string, unknown>).params
    if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined
    const threadId = (params as Record<string, unknown>).threadId
    return typeof threadId === 'string' && threadId.length > 0 ? threadId : undefined
  }

  const raw = rawDataToBuffer(frame.data)
  const params = findJsonObjectMember(raw, 0, 'params')
  if (!params || raw[params.valueStart] !== BYTE_OPEN_BRACE) return undefined
  const threadId = findJsonObjectMember(raw, params.valueStart, 'threadId')
  if (!threadId || raw[threadId.valueStart] !== BYTE_QUOTE) return undefined
  return decodeJsonString(raw, threadId.valueStart, threadId.valueEnd)
}

function clientEnvelopeFailureMessage(reason: string): string {
  if (reason === 'batch_unsupported') {
    return 'Codex remote proxy rejected a JSON-RPC batch frame.'
  }
  return `Codex remote proxy rejected an unsupported JSON-RPC frame: ${reason}.`
}

function identityGateTimeoutMessage(reason: IdentityGateReason): string {
  if (reason === 'fork_handoff') {
    return 'Freshell could not persist Codex fork handoff identity before accepting user input.'
  }
  return 'Freshell could not persist Codex restore identity before accepting user input.'
}

function identityGateOverflowMessage(reason: IdentityGateReason): string {
  if (reason === 'fork_handoff') {
    return 'Freshell could not persist Codex fork handoff identity because the held request queue overflowed.'
  }
  return 'Freshell could not persist Codex restore identity because the held request queue overflowed.'
}

type JsonObjectMember = {
  valueStart: number
  valueEnd: number
}

const BYTE_TAB = 0x09
const BYTE_LF = 0x0a
const BYTE_CR = 0x0d
const BYTE_SPACE = 0x20
const BYTE_QUOTE = 0x22
const BYTE_MINUS = 0x2d
const BYTE_COMMA = 0x2c
const BYTE_DOT = 0x2e
const BYTE_COLON = 0x3a
const BYTE_BACKSLASH = 0x5c
const BYTE_OPEN_BRACKET = 0x5b
const BYTE_CLOSE_BRACKET = 0x5d
const BYTE_OPEN_BRACE = 0x7b
const BYTE_CLOSE_BRACE = 0x7d

function findJsonObjectMember(raw: Buffer, objectStart: number, key: string): JsonObjectMember | undefined {
  let index = skipJsonWhitespace(raw, objectStart)
  if (raw[index] !== BYTE_OPEN_BRACE) return undefined
  index = skipJsonWhitespace(raw, index + 1)
  if (raw[index] === BYTE_CLOSE_BRACE) return undefined

  while (index < raw.length) {
    const keyBounds = scanJsonString(raw, index)
    if (!keyBounds) return undefined
    const decodedKey = decodeJsonString(raw, index, keyBounds.next)
    if (decodedKey === undefined) return undefined

    index = skipJsonWhitespace(raw, keyBounds.next)
    if (raw[index] !== BYTE_COLON) return undefined
    const valueStart = skipJsonWhitespace(raw, index + 1)
    const valueEnd = skipJsonValue(raw, valueStart)
    if (valueEnd === undefined) return undefined
    if (decodedKey === key) {
      return { valueStart, valueEnd }
    }

    index = skipJsonWhitespace(raw, valueEnd)
    if (raw[index] === BYTE_COMMA) {
      index = skipJsonWhitespace(raw, index + 1)
      continue
    }
    if (raw[index] === BYTE_CLOSE_BRACE) return undefined
    return undefined
  }

  return undefined
}

function skipJsonValue(raw: Buffer, start: number): number | undefined {
  let index = skipJsonWhitespace(raw, start)
  const first = raw[index]
  if (first === undefined) return undefined
  if (first === BYTE_QUOTE) return scanJsonString(raw, index)?.next
  if (first === BYTE_MINUS || isJsonDigit(first)) return scanJsonNumber(raw, index)
  if (jsonLiteralAt(raw, index, 'true')) return index + 4
  if (jsonLiteralAt(raw, index, 'false')) return index + 5
  if (jsonLiteralAt(raw, index, 'null')) return index + 4
  if (first !== BYTE_OPEN_BRACE && first !== BYTE_OPEN_BRACKET) return undefined

  const stack: Array<{ type: 'array' | 'object'; state: 'keyOrEnd' | 'key' | 'colon' | 'valueOrEnd' | 'value' | 'commaOrEnd' }> = [
    first === BYTE_OPEN_BRACE
      ? { type: 'object', state: 'keyOrEnd' }
      : { type: 'array', state: 'valueOrEnd' },
  ]
  index += 1

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!
    index = skipJsonWhitespace(raw, index)
    const byte = raw[index]
    if (byte === undefined) return undefined

    if (frame.type === 'object') {
      if (frame.state === 'keyOrEnd') {
        if (byte === BYTE_CLOSE_BRACE) {
          stack.pop()
          index += 1
          markJsonContainerValueComplete(stack)
        } else {
          frame.state = 'key'
        }
        continue
      }
      if (frame.state === 'key') {
        const key = scanJsonString(raw, index)
        if (!key) return undefined
        index = key.next
        frame.state = 'colon'
        continue
      }
      if (frame.state === 'colon') {
        if (byte !== BYTE_COLON) return undefined
        index += 1
        frame.state = 'value'
        continue
      }
      if (frame.state === 'value') {
        const next = consumeJsonContainerValue(raw, index, stack)
        if (next === undefined) return undefined
        index = next
        continue
      }
      if (byte === BYTE_COMMA) {
        index += 1
        frame.state = 'key'
        continue
      }
      if (byte === BYTE_CLOSE_BRACE) {
        stack.pop()
        index += 1
        markJsonContainerValueComplete(stack)
        continue
      }
      return undefined
    }

    if (frame.state === 'valueOrEnd') {
      if (byte === BYTE_CLOSE_BRACKET) {
        stack.pop()
        index += 1
        markJsonContainerValueComplete(stack)
      } else {
        frame.state = 'value'
      }
      continue
    }
    if (frame.state === 'value') {
      const next = consumeJsonContainerValue(raw, index, stack)
      if (next === undefined) return undefined
      index = next
      continue
    }
    if (byte === BYTE_COMMA) {
      index += 1
      frame.state = 'value'
      continue
    }
    if (byte === BYTE_CLOSE_BRACKET) {
      stack.pop()
      index += 1
      markJsonContainerValueComplete(stack)
      continue
    }
    return undefined
  }

  return index
}

function consumeJsonContainerValue(
  raw: Buffer,
  start: number,
  stack: Array<{ type: 'array' | 'object'; state: 'keyOrEnd' | 'key' | 'colon' | 'valueOrEnd' | 'value' | 'commaOrEnd' }>,
): number | undefined {
  const index = skipJsonWhitespace(raw, start)
  const first = raw[index]
  if (first === undefined) return undefined
  if (first === BYTE_OPEN_BRACE) {
    stack.push({ type: 'object', state: 'keyOrEnd' })
    return index + 1
  }
  if (first === BYTE_OPEN_BRACKET) {
    stack.push({ type: 'array', state: 'valueOrEnd' })
    return index + 1
  }
  const next = skipJsonValue(raw, index)
  if (next === undefined) return undefined
  markJsonContainerValueComplete(stack)
  return next
}

function markJsonContainerValueComplete(
  stack: Array<{ type: 'array' | 'object'; state: 'keyOrEnd' | 'key' | 'colon' | 'valueOrEnd' | 'value' | 'commaOrEnd' }>,
): void {
  const parent = stack[stack.length - 1]
  if (parent) parent.state = 'commaOrEnd'
}

function scanJsonString(raw: Buffer, start: number): { next: number } | undefined {
  if (raw[start] !== BYTE_QUOTE) return undefined
  let index = start + 1
  while (index < raw.length) {
    const byte = raw[index]!
    if (byte === BYTE_QUOTE) return { next: index + 1 }
    if (byte < 0x20) return undefined
    if (byte === BYTE_BACKSLASH) {
      if (index + 1 >= raw.length) return undefined
      const escaped = raw[index + 1]!
      if (
        escaped === BYTE_QUOTE ||
        escaped === BYTE_BACKSLASH ||
        escaped === 0x2f ||
        escaped === 0x62 ||
        escaped === 0x66 ||
        escaped === 0x6e ||
        escaped === 0x72 ||
        escaped === 0x74
      ) {
        index += 2
        continue
      }
      if (escaped === 0x75) {
        if (index + 5 >= raw.length) return undefined
        for (let offset = index + 2; offset <= index + 5; offset += 1) {
          if (!isJsonHex(raw[offset]!)) return undefined
        }
        index += 6
        continue
      }
      return undefined
    }
    index += 1
  }
  return undefined
}

function scanJsonNumber(raw: Buffer, start: number): number | undefined {
  let index = start
  if (raw[index] === BYTE_MINUS) index += 1
  if (index >= raw.length) return undefined
  if (raw[index] === 0x30) {
    index += 1
  } else if (isJsonDigitOneToNine(raw[index]!)) {
    index += 1
    while (index < raw.length && isJsonDigit(raw[index]!)) index += 1
  } else {
    return undefined
  }
  if (raw[index] === BYTE_DOT) {
    index += 1
    if (index >= raw.length || !isJsonDigit(raw[index]!)) return undefined
    while (index < raw.length && isJsonDigit(raw[index]!)) index += 1
  }
  if (raw[index] === 0x65 || raw[index] === 0x45) {
    index += 1
    if (raw[index] === 0x2b || raw[index] === BYTE_MINUS) index += 1
    if (index >= raw.length || !isJsonDigit(raw[index]!)) return undefined
    while (index < raw.length && isJsonDigit(raw[index]!)) index += 1
  }
  return index
}

function decodeJsonString(raw: Buffer, start: number, end: number): string | undefined {
  if (end - start > 8 * 1024) return undefined
  try {
    const decoded = JSON.parse(raw.subarray(start, end).toString()) as unknown
    return typeof decoded === 'string' ? decoded : undefined
  } catch {
    return undefined
  }
}

function skipJsonWhitespace(raw: Buffer, start: number): number {
  let index = start
  while (
    raw[index] === BYTE_SPACE ||
    raw[index] === BYTE_TAB ||
    raw[index] === BYTE_LF ||
    raw[index] === BYTE_CR
  ) {
    index += 1
  }
  return index
}

function jsonLiteralAt(raw: Buffer, start: number, literal: 'false' | 'null' | 'true'): boolean {
  if (start + literal.length > raw.length) return false
  for (let offset = 0; offset < literal.length; offset += 1) {
    if (raw[start + offset] !== literal.charCodeAt(offset)) return false
  }
  return true
}

function isJsonDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39
}

function isJsonDigitOneToNine(byte: number): boolean {
  return byte >= 0x31 && byte <= 0x39
}

function isJsonHex(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x46) ||
    (byte >= 0x61 && byte <= 0x66)
  )
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`
}

function normalizeCandidateThread(thread: unknown): CodexThreadHandle | undefined {
  if (!thread || typeof thread !== 'object') return undefined
  const candidate = thread as Record<string, unknown>
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return undefined
  return {
    id: candidate.id,
    path: typeof candidate.path === 'string' ? candidate.path : null,
    ephemeral: typeof candidate.ephemeral === 'boolean' ? candidate.ephemeral : false,
  }
}

function normalizeThread(thread: CodexThreadHandle): CodexThreadHandle {
  return {
    ...thread,
    path: thread.path ?? null,
    ephemeral: thread.ephemeral ?? false,
  }
}
