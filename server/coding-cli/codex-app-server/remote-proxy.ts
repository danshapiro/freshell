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

const log = logger.child({ component: 'codex-remote-proxy' })

export type CodexRemoteProxyCandidate = {
  thread: CodexThreadHandle
  source: 'thread_start_response' | 'thread_started_notification'
}

export type CodexRemoteProxyRepairTrigger =
  | { kind: 'proxy_close' | 'proxy_error' | 'candidate_capture_timeout'; error?: Error }
  | { kind: 'fs_changed'; watchId: string; changedPaths: string[] }

type JsonRpcId = string | number

type PendingTurnStart = {
  raw: WebSocket.RawData | string
  client: WebSocket
  upstream: WebSocket
  id?: JsonRpcId
  timer: NodeJS.Timeout
}

type ProxyConnection = {
  client: WebSocket
  upstream: WebSocket
  pendingMethods: Map<JsonRpcId, string>
}

type CodexRemoteProxyOptions = {
  upstreamWsUrl: string
  portAllocator?: () => Promise<LoopbackServerEndpoint>
  requestHoldTimeoutMs?: number
  candidateCaptureTimeoutMs?: number
  requireCandidatePersistence?: boolean
}

const DEFAULT_REQUEST_HOLD_TIMEOUT_MS = 5_000
const DEFAULT_CANDIDATE_CAPTURE_TIMEOUT_MS = 45_000
const MAX_COMPLETED_TURN_KEYS = 256

export class CodexRemoteProxy {
  private readonly upstreamWsUrl: string
  private readonly portAllocator: () => Promise<LoopbackServerEndpoint>
  private readonly requestHoldTimeoutMs: number
  private readonly candidateCaptureTimeoutMs: number
  private readonly requireCandidatePersistence: boolean
  private server: WebSocketServer | null = null
  private endpoint: LoopbackServerEndpoint | null = null
  private candidatePersisted = false
  private candidateCaptureFailed = false
  private candidateCapturePaused = false
  private candidateCaptureTimer: NodeJS.Timeout | null = null
  private readonly pendingTurnStarts = new Set<PendingTurnStart>()
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
    this.candidatePersisted = !this.requireCandidatePersistence
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
      const server = new WebSocketServer({ host: endpoint.hostname, port: endpoint.port }, () => resolve())
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
    }, 'Codex remote proxy listening')
    return { wsUrl: this.wsUrl }
  }

  async close(): Promise<void> {
    this.clearCandidateCaptureTimer()
    for (const pending of [...this.pendingTurnStarts]) {
      this.failHeldTurnStart(pending, 'Codex remote proxy is closing before restore identity persistence completed.')
    }
    for (const connection of [...this.connections]) {
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
    if (this.candidatePersisted) return
    if (this.candidateCaptureFailed) return
    this.candidatePersisted = true
    this.clearCandidateCaptureTimer()
    for (const pending of [...this.pendingTurnStarts]) {
      this.releaseHeldTurnStart(pending)
    }
  }

  failCandidateCapture(message = 'Freshell could not persist Codex restore identity before accepting user input.'): void {
    if (!this.requireCandidatePersistence) return
    if (this.candidateCaptureFailed || this.candidatePersisted) return
    this.candidateCaptureFailed = true
    this.clearCandidateCaptureTimer()
    this.emitRepairTrigger({ kind: 'candidate_capture_timeout' })
    for (const pending of [...this.pendingTurnStarts]) {
      this.failHeldTurnStart(pending, message)
    }
    for (const connection of [...this.connections]) {
      this.sendJsonRpcError(connection.client, undefined, message)
      connection.client.close()
      connection.upstream.close()
    }
  }

  pauseCandidateCapture(reason: string): void {
    if (!this.requireCandidatePersistence) return
    if (this.candidatePersisted || this.candidateCaptureFailed) return
    this.candidateCapturePaused = true
    this.clearCandidateCaptureTimer()
    log.info({ reason }, 'Paused Codex restore identity candidate-capture timeout')
  }

  resumeCandidateCapture(reason: string): void {
    if (!this.requireCandidatePersistence) return
    if (this.candidatePersisted || this.candidateCaptureFailed) return
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
    const upstream = new WebSocket(this.upstreamWsUrl)
    const connection: ProxyConnection = {
      client,
      upstream,
      pendingMethods: new Map(),
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
    const forward = framePayload(raw, isBinary)
    const parsed = parseJson(raw)
    const method = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).method : undefined
    const id = jsonRpcId(parsed)
    if (typeof method === 'string') {
      log.debug({
        proxyWsUrl: this.endpoint ? this.wsUrl : undefined,
        upstreamWsUrl: this.upstreamWsUrl,
        method,
        id,
      }, 'Codex remote proxy received client request')
    }

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

    if (id !== undefined && typeof method === 'string') {
      connection.pendingMethods.set(id, method)
    }

    if (this.requireCandidatePersistence && method === 'turn/start' && !this.candidatePersisted) {
      this.holdTurnStart(connection, forward, id)
      return
    }

    sendIfOpen(connection.upstream, forward)
  }

  private handleUpstreamMessage(connection: ProxyConnection, raw: WebSocket.RawData, isBinary: boolean): void {
    const forward = framePayload(raw, isBinary)
    const parsed = parseJson(raw)
    const id = jsonRpcId(parsed)
    if (id !== undefined) {
      const method = connection.pendingMethods.get(id)
      connection.pendingMethods.delete(id)
      log.debug({
        proxyWsUrl: this.endpoint ? this.wsUrl : undefined,
        upstreamWsUrl: this.upstreamWsUrl,
        method,
        id,
      }, 'Codex remote proxy forwarding upstream response')
      if (method === 'thread/start') {
        this.maybeEmitThreadStartResponseCandidate(parsed)
      }
    } else {
      const method = parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>).method
        : undefined
      if (typeof method === 'string') {
        log.debug({
          proxyWsUrl: this.endpoint ? this.wsUrl : undefined,
          upstreamWsUrl: this.upstreamWsUrl,
          method,
        }, 'Codex remote proxy forwarding upstream notification')
      }
      this.handleUpstreamNotification(parsed)
    }
    sendIfOpen(connection.client, forward)
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

  private handleUpstreamNotification(parsed: unknown): void {
    const method = parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>).method
      : undefined
    if (method === 'thread/started') {
      const params = (parsed as Record<string, unknown>).params
      const thread = params && typeof params === 'object'
        ? normalizeCandidateThread((params as Record<string, unknown>).thread)
        : undefined
      if (!thread) return
      this.emitCandidate({
        thread,
        source: 'thread_started_notification',
      })
      this.emitThreadLifecycle({
        kind: 'thread_started',
        thread,
      })
      return
    }

    const turnStarted = CodexTurnStartedNotificationSchema.safeParse(parsed)
    if (turnStarted.success) {
      this.recordTurnStarted(turnStarted.data.params)
      this.emitTurnEvent(this.turnStartedHandlers, turnStarted.data.params)
      return
    }

    const turnCompleted = CodexTurnCompletedNotificationSchema.safeParse(parsed)
    if (turnCompleted.success) {
      this.recordTurnCompleted(turnCompleted.data.params)
      this.emitTurnEvent(this.turnCompletedHandlers, turnCompleted.data.params)
      return
    }

    const fsChanged = CodexFsChangedNotificationSchema.safeParse(parsed)
    if (fsChanged.success) {
      this.emitRepairTrigger({ kind: 'fs_changed', ...fsChanged.data.params })
      return
    }

    const lifecycle = CodexThreadLifecycleNotificationSchema.safeParse(parsed)
    if (lifecycle.success) {
      if (lifecycle.data.method === 'thread/closed') {
        this.emitThreadLifecycle({ kind: 'thread_closed', threadId: lifecycle.data.params.threadId })
        this.emitLifecycleLoss({ method: 'thread/closed', threadId: lifecycle.data.params.threadId })
      } else if (lifecycle.data.method === 'thread/status/changed') {
        this.emitThreadLifecycle({
          kind: 'thread_status_changed',
          threadId: lifecycle.data.params.threadId,
          status: lifecycle.data.params.status,
        })
        const status = lifecycle.data.params.status.type
        if (status === 'notLoaded' || status === 'systemError') {
          this.emitLifecycleLoss({
            method: 'thread/status/changed',
            threadId: lifecycle.data.params.threadId,
            status,
          })
        }
      }
    }
  }

  private holdTurnStart(connection: ProxyConnection, raw: WebSocket.RawData | string, id?: JsonRpcId): void {
    const pending: PendingTurnStart = {
      raw,
      client: connection.client,
      upstream: connection.upstream,
      id,
      timer: setTimeout(() => {
        this.failHeldTurnStart(
          pending,
          'Freshell could not persist Codex restore identity before accepting user input.',
        )
      }, this.requestHoldTimeoutMs),
    }
    pending.timer.unref?.()
    this.pendingTurnStarts.add(pending)
  }

  private releaseHeldTurnStart(pending: PendingTurnStart): void {
    if (!this.pendingTurnStarts.delete(pending)) return
    clearTimeout(pending.timer)
    sendIfOpen(pending.upstream, pending.raw)
  }

  private failHeldTurnStart(pending: PendingTurnStart, message: string): void {
    if (!this.pendingTurnStarts.delete(pending)) return
    clearTimeout(pending.timer)
    this.emitRepairTrigger({ kind: 'candidate_capture_timeout' })
    this.sendJsonRpcError(pending.client, pending.id, message)
    pending.client.close()
    pending.upstream.close()
  }

  private sendJsonRpcError(client: WebSocket, id: JsonRpcId | undefined, message: string): void {
    sendIfOpen(client, JSON.stringify({
      jsonrpc: '2.0',
      ...(id !== undefined ? { id } : {}),
      error: {
        code: -32000,
        message,
      },
    }))
  }

  private sendJsonRpcSuccess(client: WebSocket, id: JsonRpcId, result: Record<string, never>): void {
    sendIfOpen(client, JSON.stringify({ id, result }))
  }

  private ensureCandidateCaptureTimer(): void {
    if (!this.requireCandidatePersistence) return
    if (this.candidatePersisted || this.candidateCaptureFailed || this.candidateCapturePaused || this.candidateCaptureTimer) return
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

function parseJson(raw: WebSocket.RawData): unknown {
  try {
    return JSON.parse(raw.toString())
  } catch {
    return undefined
  }
}

function jsonRpcId(parsed: unknown): JsonRpcId | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined
  const id = (parsed as Record<string, unknown>).id
  return typeof id === 'string' || typeof id === 'number' ? id : undefined
}

function framePayload(raw: WebSocket.RawData, isBinary: boolean): WebSocket.RawData | string {
  return isBinary ? raw : raw.toString()
}

function sendIfOpen(socket: WebSocket, data: WebSocket.RawData | string): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(data)
  } else if (socket.readyState === WebSocket.CONNECTING) {
    socket.once('open', () => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data)
    })
  }
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
