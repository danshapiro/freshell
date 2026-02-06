import { getClientPerfConfig, isClientPerfLoggingEnabled, logClientPerf } from '@/lib/perf-logger'
import { getAuthToken } from '@/lib/auth'

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'ready'
type MessageHandler = (msg: any) => void
type ReconnectHandler = () => void
type HelloExtensionProvider = () => { sessions?: { active?: string; visible?: string[]; background?: string[] } }

const CONNECTION_TIMEOUT_MS = 10_000
const perfConfig = getClientPerfConfig()

export class WsClient {
  private ws: WebSocket | null = null
  private _state: ConnectionState = 'disconnected'
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

  connect(): Promise<void> {
    if (this._state === 'ready') return Promise.resolve()
    if (this.connectPromise) return this.connectPromise

    this.intentionalClose = false
    this._state = 'connecting'
    if (perfConfig.enabled) {
      this.connectStartedAt = performance.now()
    }

    this.connectPromise = new Promise((resolve, reject) => {
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

      const timeout = window.setTimeout(() => {
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
        this.ws?.send(JSON.stringify({ type: 'hello', token, ...extensions }))
      }

      this.ws.onmessage = (event) => {
        let payloadBytes: number | undefined
        if (perfConfig.enabled) {
          if (typeof event.data === 'string') payloadBytes = event.data.length
          else if (event.data instanceof Blob) payloadBytes = event.data.size
          else if (event.data instanceof ArrayBuffer) payloadBytes = event.data.byteLength
        }

        let msg: any
        try {
          msg = JSON.parse(event.data)
        } catch {
          // Ignore invalid JSON
          return
        }

        if (msg.type === 'ready') {
          window.clearTimeout(timeout)
          const isReconnect = this.wasConnectedOnce
          this.wasConnectedOnce = true
          this._state = 'ready'

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

          // Flush queued messages
          while (this.pendingMessages.length > 0) {
            const next = this.pendingMessages.shift()
            if (next) this.ws?.send(JSON.stringify(next))
          }

          if (isReconnect) {
            this.reconnectHandlers.forEach((h) => h())
          }

          finishResolve()
        }

        if (msg.type === 'error' && msg.code === 'NOT_AUTHENTICATED') {
          window.clearTimeout(timeout)
          finishReject(new Error('Authentication failed'))
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
              payloadBytes,
              handlerCount: this.messageHandlers.size,
            }, 'warn')
          }
        } else {
          this.messageHandlers.forEach((handler) => handler(msg))
        }
      }

      this.ws.onclose = (event) => {
        window.clearTimeout(timeout)
        const wasConnecting = this._state === 'connecting'
        this._state = 'disconnected'
        this.ws = null

        if (event.code === 4001) {
          this.intentionalClose = true
          finishReject(new Error(`Authentication failed (code ${event.code})`))
          return
        }

        if (event.code === 4002) {
          // HELLO_TIMEOUT: transient handshake issue (treat like a reconnectable timeout).
          finishReject(new Error('Handshake timeout'))
          if (!this.intentionalClose) {
            this.scheduleReconnect()
          }
          return
        }

        if (event.code === 4003) {
          this.intentionalClose = true
          finishReject(new Error('Server busy: max connections reached'))
          return
        }

        if (event.code === 4008) {
          // Backpressure close - surface as warning and reconnect with a minimum delay.
          finishReject(new Error('Connection closed due to backpressure'))
          if (!this.intentionalClose) {
            this.scheduleReconnect({ minDelayMs: 5000 })
          }
          return
        }

        if (wasConnecting) {
          finishReject(new Error('Connection closed before ready'))
        }

        if (perfConfig.enabled) {
          logClientPerf('perf.ws_closed', {
            code: event.code,
            reason: event.reason,
            wasConnecting,
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
    return this.connectPromise
  }

  private scheduleReconnect(options: { minDelayMs?: number } = {}) {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('WsClient: max reconnect attempts reached')
      return
    }

    const minDelayMs = options.minDelayMs ?? 0
    const delay = Math.max(minDelayMs, this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts))
    this.reconnectAttempts++

    window.setTimeout(() => {
      if (!this.intentionalClose) {
        this.connect().catch((err) => console.error('WsClient: reconnect failed', err))
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
    this.ws?.close()
    this.ws = null
    this._state = 'disconnected'
    this.pendingMessages = []
  }

  /**
   * Reliable send: if not ready yet, queues messages until ready.
   */
  send(msg: unknown) {
    if (this.intentionalClose) return

    if (this._state === 'ready' && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
      return
    }

    // Queue until ready (handles connecting, connected, and temporary disconnects)
    if (this.pendingMessages.length >= this.maxQueueSize) {
      // Drop oldest to prevent unbounded memory.
      this.pendingMessages.shift()
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

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler)
    return () => this.messageHandlers.delete(handler)
  }

  onReconnect(handler: ReconnectHandler): () => void {
    this.reconnectHandlers.add(handler)
    return () => this.reconnectHandlers.delete(handler)
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
