import {
  getClientPerfConfig,
  logClientPerf,
  markTerminalInputSent,
  markTerminalOutputSeen,
} from '@/lib/perf-logger'
import { getAuthToken } from '@/lib/auth'
import type { ServerMessage, SessionLocator } from '@shared/ws-protocol'
import { createLogger } from '@/lib/client-logger'

const log = createLogger('WsClient')

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'ready'
type MessageHandler = (msg: ServerMessage) => void
type ReconnectHandler = () => void
type HelloExtensionProvider = () => {
  sessions?: { active?: string; visible?: string[]; background?: string[] }
  sidebarOpenSessions?: SessionLocator[]
  client?: { mobile?: boolean }
}
type TabsSyncPushPayload = {
  deviceId: string
  deviceLabel: string
  records: unknown[]
}
type TabsSyncQueryPayload = {
  requestId: string
  deviceId: string
  rangeDays?: number
}

type TerminalInputClientMessage = {
  type: 'terminal.input'
  terminalId: string
  data: string
}

type TerminalCreateClientMessage = {
  type: 'terminal.create'
  requestId: string
}

type TerminalAttachClientMessage = {
  type: 'terminal.attach'
  terminalId: string
}

type InFlightCreate = {
  message: unknown
  lastResendEpoch: number
}

const CONNECTION_TIMEOUT_MS = 10_000
const WS_PROTOCOL_VERSION = 3
const perfConfig = getClientPerfConfig()

function isTerminalInputMessage(msg: unknown): msg is TerminalInputClientMessage {
  if (!msg || typeof msg !== 'object') return false
  const candidate = msg as { type?: unknown; terminalId?: unknown; data?: unknown }
  return candidate.type === 'terminal.input'
    && typeof candidate.terminalId === 'string'
    && typeof candidate.data === 'string'
}

function isTerminalCreateMessage(msg: unknown): msg is TerminalCreateClientMessage {
  if (!msg || typeof msg !== 'object') return false
  const candidate = msg as { type?: unknown; requestId?: unknown }
  return candidate.type === 'terminal.create' && typeof candidate.requestId === 'string' && candidate.requestId.length > 0
}

function isTerminalAttachMessage(msg: unknown): msg is TerminalAttachClientMessage {
  if (!msg || typeof msg !== 'object') return false
  const candidate = msg as { type?: unknown; terminalId?: unknown }
  return candidate.type === 'terminal.attach'
    && typeof candidate.terminalId === 'string'
    && candidate.terminalId.length > 0
}

export class WsClient {
  private ws: WebSocket | null = null
  private _state: ConnectionState = 'disconnected'
  private _serverInstanceId: string | undefined
  private connectPromise: Promise<void> | null = null
  private messageHandlers = new Set<MessageHandler>()
  private reconnectHandlers = new Set<ReconnectHandler>()
  private pendingMessages: unknown[] = []
  private intentionalClose = false
  private helloExtensionProvider?: HelloExtensionProvider

  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private baseReconnectDelay = 1000
  private wasConnectedOnce = false

  private maxQueueSize = 1000
  private connectStartedAt: number | null = null
  private lastQueueLogAt = 0
  private reconnectTimer: number | null = null
  private readyTimeout: number | null = null
  private reconnectEpoch = 0
  private inFlightCreates = new Map<string, InFlightCreate>()
  private preReadyCreateQueue = new Map<string, unknown>()

  constructor(private url: string) {}

  /**
   * Set a provider for additional data to include in the hello message.
   * Used to send session IDs for prioritized repair scanning.
   */
  setHelloExtensionProvider(provider: HelloExtensionProvider): void {
    this.helloExtensionProvider = provider
  }

  get state(): ConnectionState {
    return this._state
  }

  get isReady(): boolean {
    return this._state === 'ready'
  }

  get serverInstanceId(): string | undefined {
    return this._serverInstanceId
  }

  connect(): Promise<void> {
    // StrictMode / double-mount safe: callers can call connect() multiple times and should
    // receive the same in-flight promise until the socket is "ready".
    if (this._state === 'ready') {
      return Promise.resolve()
    }

    if (this.connectPromise) return this.connectPromise

    this.intentionalClose = false
    this.clearReconnectTimer()
    this.clearReadyTimeout()
    this._state = 'connecting'
    if (perfConfig.enabled) {
      this.connectStartedAt = performance.now()
    }

    const promise = new Promise<void>((resolve, reject) => {
      let finished = false
      const finishResolve = () => {
        if (!finished) {
          finished = true
          this.connectPromise = null
          resolve()
        }
      }
      const finishReject = (err: Error) => {
        if (!finished) {
          finished = true
          this.connectPromise = null
          reject(err)
        }
      }

      this.readyTimeout = window.setTimeout(() => {
        finishReject(new Error('Connection timeout: ready not received'))
        this.ws?.close()
      }, CONNECTION_TIMEOUT_MS)

      this.ws = new WebSocket(this.url)

      this.ws.onopen = () => {
        this._state = 'connected'
        this.reconnectAttempts = 0

        // Send hello with token in message body (not URL).
        const token = getAuthToken()
        const extensions = this.helloExtensionProvider?.() || {}
        this.ws?.send(JSON.stringify({
          type: 'hello',
          token,
          protocolVersion: WS_PROTOCOL_VERSION,
          capabilities: { sessionsPatchV1: true, sessionsPaginationV1: true, uiScreenshotV1: true },
          ...extensions,
        }))
      }

      this.ws.onmessage = (event) => {
        let msg: ServerMessage
        try {
          msg = JSON.parse(event.data) as ServerMessage
        } catch {
          // Ignore invalid JSON
          return
        }

        if (msg.type === 'ready') {
          this._serverInstanceId = typeof msg.serverInstanceId === 'string' && msg.serverInstanceId.trim()
            ? msg.serverInstanceId
            : undefined
          this.clearReadyTimeout()
          const isReconnect = this.wasConnectedOnce
          this.wasConnectedOnce = true
          this._state = 'ready'
          if (isReconnect) {
            this.reconnectEpoch += 1
          }

          if (perfConfig.enabled && this.connectStartedAt !== null) {
            const durationMs = performance.now() - this.connectStartedAt
            this.connectStartedAt = null
            if (durationMs >= perfConfig.wsReadySlowMs) {
              logClientPerf('perf.ws_ready_slow', {
                durationMs: Number(durationMs.toFixed(2)),
                reconnect: isReconnect,
              }, 'warn')
            } else {
              logClientPerf('perf.ws_ready', {
                durationMs: Number(durationMs.toFixed(2)),
                reconnect: isReconnect,
              })
            }
          }

          const createRequestIdsFlushed = new Set<string>()
          for (const [requestId, createMsg] of this.preReadyCreateQueue.entries()) {
            if (!this.inFlightCreates.has(requestId)) continue
            this.sendNow(createMsg)
            createRequestIdsFlushed.add(requestId)
          }
          this.preReadyCreateQueue.clear()

          const pendingMessages = isReconnect
            ? this.pendingMessages.filter((msg) => !isTerminalAttachMessage(msg))
            : this.pendingMessages
          this.pendingMessages = []

          for (const next of pendingMessages) {
            if (!next) continue
            this.sendNow(next)
          }

          if (isReconnect) {
            for (const [requestId, entry] of this.inFlightCreates.entries()) {
              if (entry.lastResendEpoch === this.reconnectEpoch) continue
              if (createRequestIdsFlushed.has(requestId)) {
                entry.lastResendEpoch = this.reconnectEpoch
                continue
              }
              this.sendNow(entry.message)
              entry.lastResendEpoch = this.reconnectEpoch
            }
          }

          if (isReconnect) {
            this.reconnectHandlers.forEach((h) => h())
          }

          finishResolve()
        }

        if (msg.type === 'terminal.output' && typeof msg.terminalId === 'string') {
          markTerminalOutputSeen(msg.terminalId)
        }

        if (msg.type === 'terminal.created') {
          const create = this.inFlightCreates.get(msg.requestId)
          if (create) {
            this.inFlightCreates.delete(msg.requestId)
            this.preReadyCreateQueue.delete(msg.requestId)
          }
        }

        if (msg.type === 'error' && typeof msg.requestId === 'string') {
          this.inFlightCreates.delete(msg.requestId)
          this.preReadyCreateQueue.delete(msg.requestId)
        }

        if (msg.type === 'error' && msg.code === 'NOT_AUTHENTICATED') {
          this.clearReadyTimeout()
          this.intentionalClose = true
          const err = new Error('Authentication failed')
          ;(err as any).wsCloseCode = 4001
          finishReject(err)
          return
        }

        if (msg.type === 'error' && msg.code === 'PROTOCOL_MISMATCH') {
          this.clearReadyTimeout()
          this.intentionalClose = true
          const err = new Error('Protocol version mismatch')
          ;(err as any).wsCloseCode = 4010
          finishReject(err)
          return
        }

        if (perfConfig.enabled) {
          const start = performance.now()
          this.messageHandlers.forEach((handler) => handler(msg))
          const durationMs = performance.now() - start
          if (durationMs >= perfConfig.wsMessageSlowMs) {
            logClientPerf('perf.ws_message_handlers_slow', {
              durationMs: Number(durationMs.toFixed(2)),
              messageType: msg?.type,
            }, 'warn')
          }
        } else {
          this.messageHandlers.forEach((handler) => handler(msg))
        }
      }

      this.ws.onclose = (event) => {
        this.clearReadyTimeout()
        const wasReady = this._state === 'ready'
        const closedBeforeReady = !wasReady
        this._state = 'disconnected'
        this.ws = null

        // Close codes:
        // 4001 NOT_AUTHENTICATED: fatal, do not reconnect.
        // 4002 HELLO_TIMEOUT: transient (handshake timeout), do reconnect.
        if (event.code === 4001) {
          this.intentionalClose = true
          const err = new Error(`Authentication failed (code ${event.code})`)
          ;(err as any).wsCloseCode = 4001
          finishReject(err)
          return
        }
        if (event.code === 4002) {
          finishReject(new Error('Handshake timeout'))
          this.scheduleReconnect()
          return
        }

        if (event.code === 4003) {
          this.intentionalClose = true
          const err = new Error('Server busy: max connections reached')
          ;(err as any).wsCloseCode = 4003
          finishReject(err)
          return
        }

        if (event.code === 4010) {
          this.intentionalClose = true
          const err = new Error('Protocol version mismatch')
          ;(err as any).wsCloseCode = 4010
          finishReject(err)
          return
        }

        if (event.code === 4008) {
          // Backpressure close - surface as warning, but don't reconnect aggressively.
          finishReject(new Error('Connection too slow (backpressure)'))
          this.scheduleReconnect({ minDelayMs: 5000 })
          return
        }

        if (event.code === 4009) {
          // SERVER_SHUTDOWN — server is rebinding and will be back shortly.
          // Reset backoff for a fast ~1s reconnect.
          this.reconnectAttempts = 0
          finishReject(new Error('Server restarting (rebind)'))
          this.scheduleReconnect()
          return
        }

        if (closedBeforeReady) {
          finishReject(new Error('Connection closed before ready'))
        }

        if (perfConfig.enabled) {
          logClientPerf('perf.ws_closed', {
            code: event.code,
            reason: event.reason,
            closedBeforeReady,
          }, 'warn')
        }

        if (!this.intentionalClose) {
          this.scheduleReconnect()
        }
      }

      this.ws.onerror = () => {
        // onclose will fire with details; if still connecting, reject quickly.
        if (this._state === 'connecting') {
          finishReject(new Error('WebSocket error'))
        }
      }
    })

    this.connectPromise = promise
    return promise
  }

  private scheduleReconnect(opts?: { minDelayMs?: number }) {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log.error('max reconnect attempts reached')
      return
    }

    const baseDelay = this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts)
    const delay = Math.max(baseDelay, opts?.minDelayMs ?? 0)
    this.reconnectAttempts++

    this.clearReconnectTimer()
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      if (!this.intentionalClose) {
        this.connect().catch((err) => log.error('reconnect failed', err))
      }
    }, delay)

    if (perfConfig.enabled) {
      logClientPerf('perf.ws_reconnect_scheduled', {
        delayMs: delay,
        attempt: this.reconnectAttempts,
      })
    }
  }

  disconnect() {
    this.intentionalClose = true
    this.clearReconnectTimer()
    this.clearReadyTimeout()
    this.ws?.close()
    this.ws = null
    this._state = 'disconnected'
    this.pendingMessages = []
    this.inFlightCreates.clear()
    this.preReadyCreateQueue.clear()
    this._serverInstanceId = undefined
    this.connectPromise = null
    this.reconnectAttempts = 0
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private clearReadyTimeout() {
    if (this.readyTimeout !== null) {
      window.clearTimeout(this.readyTimeout)
      this.readyTimeout = null
    }
  }

  /**
   * Reliable send: if not ready yet, queues messages until ready.
   */
  send(msg: unknown) {
    if (this.intentionalClose) return

    if (isTerminalInputMessage(msg)) {
      markTerminalInputSent(msg.terminalId)
    }

    if (isTerminalCreateMessage(msg)) {
      this.inFlightCreates.set(msg.requestId, {
        message: msg,
        lastResendEpoch: -1,
      })
    }

    if (this._state === 'ready' && this.ws?.readyState === WebSocket.OPEN) {
      this.sendNow(msg)
      return
    }

    if (isTerminalCreateMessage(msg)) {
      if (!this.preReadyCreateQueue.has(msg.requestId) && this.preReadyCreateQueue.size >= this.maxQueueSize) {
        const oldestRequestId = this.preReadyCreateQueue.keys().next().value
        if (typeof oldestRequestId === 'string') {
          this.preReadyCreateQueue.delete(oldestRequestId)
          this.inFlightCreates.delete(oldestRequestId)
        }
      }
      this.preReadyCreateQueue.set(msg.requestId, msg)
      return
    }

    // Queue until ready (handles connecting, connected, and temporary disconnects)
    if (this.pendingMessages.length >= this.maxQueueSize) {
      // Drop oldest to prevent unbounded memory.
      const dropped = this.pendingMessages.shift()
      if (isTerminalCreateMessage(dropped)) {
        this.inFlightCreates.delete(dropped.requestId)
      }
    }
    this.pendingMessages.push(msg)

    if (perfConfig.enabled && this.pendingMessages.length >= perfConfig.wsQueueWarnSize) {
      const now = Date.now()
      if (now - this.lastQueueLogAt >= perfConfig.rateLimitMs) {
        this.lastQueueLogAt = now
        logClientPerf('perf.ws_queue_backlog', {
          queueSize: this.pendingMessages.length,
        }, 'warn')
      }
    }
  }

  sendTabsSyncPush(payload: TabsSyncPushPayload) {
    this.send({
      type: 'tabs.sync.push',
      ...payload,
    })
  }

  sendTabsSyncQuery(payload: TabsSyncQueryPayload) {
    this.send({
      type: 'tabs.sync.query',
      ...payload,
    })
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler)
    return () => this.messageHandlers.delete(handler)
  }

  onReconnect(handler: ReconnectHandler): () => void {
    this.reconnectHandlers.add(handler)
    return () => this.reconnectHandlers.delete(handler)
  }

  private sendNow(msg: unknown) {
    this.ws?.send(JSON.stringify(msg))
  }
}

let wsClient: WsClient | null = null

export function getWsClient(): WsClient {
  if (!wsClient) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.host
    wsClient = new WsClient(`${protocol}//${host}/ws`)
  }
  return wsClient
}

export function resetWsClientForTests(): void {
  wsClient?.disconnect()
  wsClient = null
}
