import {
  getClientPerfConfig,
  logClientPerf,
  markTerminalInputSent,
  markTerminalOutputSeen,
} from '@/lib/perf-logger'
import { getAuthToken } from '@/lib/auth'
import { sanitizeSessionLocators } from '@/lib/session-utils'
import { WS_PROTOCOL_VERSION } from '@shared/ws-version'
import type { ReadyCapabilities, ServerMessage, SessionLocator } from '@shared/ws-protocol'
import type { TerminalInterestSnapshot } from '@/lib/terminal-interest'
import { createLogger } from '@/lib/client-logger'

const log = createLogger('WsClient')

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'ready'
type MessageHandler = (msg: ServerMessage) => void
type ReconnectHandler = () => void
type DisconnectHandler = () => void
type OutboundMessageObserver = (msg: unknown) => void
type HelloExtensionProvider = () => {
  sessions?: { active?: string; visible?: string[]; background?: string[] }
  sidebarOpenSessions?: SessionLocator[]
  client?: { mobile?: boolean }
}
type TabsSyncPushPayload = {
  deviceId: string
  deviceLabel: string
  clientInstanceId: string
  snapshotRevision: number
  records: unknown[]
}
type TabsSyncQueryPayload = {
  requestId: string
  deviceId: string
  clientInstanceId: string
  closedTabRetentionDays: number
}
type TabsSyncClientRetirePayload = {
  deviceId: string
  clientInstanceId: string
  snapshotRevision: number
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

type FreshAgentCreateClientMessage = {
  type: 'freshAgent.create'
  requestId: string
}

type TerminalAttachClientMessage = {
  type: 'terminal.attach'
  terminalId: string
}

type CreateClientMessage = TerminalCreateClientMessage | FreshAgentCreateClientMessage

type InFlightCreate = {
  message: CreateClientMessage
  lastResendEpoch: number
}

const CONNECTION_TIMEOUT_MS = 10_000

// App-level transport liveness. Server-side WS pings are invisible to JS, so
// liveness is proven by an app-level {type:'ping'}→{type:'pong'} round trip
// that both servers implement. 10s tick so a probe's 10s timeout is
// re-evaluated 10s after it was sent (a 30s tick would delay abandonment to
// t=60 — fresh-eyes F1). Probe fires once inbound silence reaches 30s (both
// servers' keepalive cadence); the foreground abandon threshold is >2 server
// keepalive windows.
const LIVENESS_TICK_MS = 10_000
const PROBE_AFTER_SILENCE_MS = 30_000
const PONG_TIMEOUT_MS = 10_000
const FOREGROUND_RECYCLE_SILENCE_MS = 65_000

// Bounded pre-verdict create hold: when the server acks paneReconcileV1, pane
// creates are held until their pane's reconcile verdict folds — or this
// wall-clock bound elapses and every still-held create flushes (legacy-eager
// fallback; never a silent wedge). Must exceed the server's single 2s warming
// deferral plus round-trip margin. The ONE definition — view layers import it.
export const RECONCILE_VERDICT_WAIT_MS = 4_000

const perfConfig = getClientPerfConfig()

function isTerminalInputMessage(msg: unknown): msg is TerminalInputClientMessage {
  if (!msg || typeof msg !== 'object') return false
  const candidate = msg as { type?: unknown; terminalId?: unknown; data?: unknown }
  return candidate.type === 'terminal.input'
    && typeof candidate.terminalId === 'string'
    && typeof candidate.data === 'string'
}

function isCreateMessage(msg: unknown): msg is CreateClientMessage {
  if (!msg || typeof msg !== 'object') return false
  const candidate = msg as { type?: unknown; requestId?: unknown }
  return (candidate.type === 'terminal.create' || candidate.type === 'freshAgent.create')
    && typeof candidate.requestId === 'string'
    && candidate.requestId.length > 0
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
  private disconnectHandlers = new Set<DisconnectHandler>()
  private outboundMessageObserver?: OutboundMessageObserver
  private pendingMessages: unknown[] = []
  private intentionalClose = false
  private helloExtensionProvider?: HelloExtensionProvider

  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private baseReconnectDelay = 1000
  private maxReconnectDelay = 4000
  private postShutdownBaseDelay = 500
  private slowReconnectDelay = 15000
  private slowRetryAnnounced = false
  private wasConnectedOnce = false
  private fastReconnectMode = false

  private maxQueueSize = 1000
  private connectStartedAt: number | null = null
  private lastQueueLogAt = 0
  private reconnectTimer: number | null = null
  private readyTimeout: number | null = null
  private reconnectEpoch = 0
  private inFlightCreates = new Map<string, InFlightCreate>()
  private preReadyCreateQueue = new Map<string, unknown>()
  // Sender-level pre-verdict create hold (only when paneReconcileV1 is acked):
  // pane creates wait here until their pane's verdict folds (cancelCreate
  // retracts, or the view re-sends with fold-corrected fields), the boot
  // reconcile request narrows the set, clearReconcileCreateHold() flushes, or
  // the RECONCILE_VERDICT_WAIT_MS bound elapses. Bounded — never a silent wedge.
  private heldCreates = new Map<string, unknown>()
  private reconcileHoldActive = false
  private reconcileHoldPendingSet: Set<string> | null = null
  private reconcileHoldTimer: number | null = null
  // Per-connection: {} until a ready with capabilities arrives on the CURRENT
  // socket; reset on disconnect so a downgraded server is honored.
  private serverCapabilities: NonNullable<ReadyCapabilities> = {}
  private terminalInterestRevision = 0

  // Bumped for every new WebSocket; each socket's handlers capture their
  // generation and no-op once superseded (a late event from an abandoned socket
  // must never touch the live connection's state).
  private socketGen = 0
  private lastInboundAt = 0
  private probeSentAt: number | null = null
  private livenessTimer: number | null = null

  constructor(private url: string) {}

  private clearTrackedCreate(requestId: string): void {
    this.inFlightCreates.delete(requestId)
    this.preReadyCreateQueue.delete(requestId)
    this.heldCreates.delete(requestId)
  }

  private clearQueuedMessagesAfterProtocolMismatch(): void {
    this.pendingMessages = []
    this.inFlightCreates.clear()
    this.preReadyCreateQueue.clear()
    this.resetReconcileHold({ requeueHeld: false })
  }

  cancelCreate(requestId: string): void {
    this.clearTrackedCreate(requestId)
  }

  /**
   * Narrow the pre-verdict hold to exactly the createRequestIds named in the
   * boot reconcile request. Held creates NOT in the set have no verdict coming
   * — they are released (sent) immediately, same requestId (never re-minted).
   */
  setReconcilePendingCreates(requestIds: string[]): void {
    if (!this.reconcileHoldActive) return
    const pendingSet = new Set(requestIds)
    this.reconcileHoldPendingSet = pendingSet
    for (const [requestId, msg] of this.heldCreates.entries()) {
      if (pendingSet.has(requestId)) continue
      this.heldCreates.delete(requestId)
      if (!this.inFlightCreates.has(requestId)) continue
      this.sendNow(msg)
    }
  }

  /**
   * End the pre-verdict hold: flush any still-held creates (legacy-eager
   * fallback for cardinality gaps and the timeout path) and cancel the timer.
   * Idempotent; safe to call when no hold is active.
   */
  clearReconcileCreateHold(): void {
    if (this.reconcileHoldTimer !== null) {
      window.clearTimeout(this.reconcileHoldTimer)
      this.reconcileHoldTimer = null
    }
    const held = this.heldCreates
    this.heldCreates = new Map()
    this.reconcileHoldActive = false
    this.reconcileHoldPendingSet = null
    for (const [requestId, msg] of held.entries()) {
      if (!this.inFlightCreates.has(requestId)) continue
      if (this._state === 'ready' && this.ws?.readyState === WebSocket.OPEN) {
        this.sendNow(msg)
      } else {
        // Socket gone mid-flush: re-enter the normal pre-ready path so the
        // create is delivered exactly once on the next connection.
        this.preReadyCreateQueue.set(requestId, msg)
      }
    }
  }

  private resetReconcileHold(opts: { requeueHeld: boolean }): void {
    if (this.reconcileHoldTimer !== null) {
      window.clearTimeout(this.reconcileHoldTimer)
      this.reconcileHoldTimer = null
    }
    if (opts.requeueHeld) {
      // Connection dropped mid-hold: held creates were never on the wire —
      // re-enter via the normal preReadyCreateQueue path on the next connection.
      for (const [requestId, msg] of this.heldCreates.entries()) {
        if (!this.inFlightCreates.has(requestId)) continue
        this.preReadyCreateQueue.set(requestId, msg)
      }
    }
    this.heldCreates.clear()
    this.reconcileHoldActive = false
    this.reconcileHoldPendingSet = null
  }

  private handleIncomingMessage(msg: ServerMessage): void {
    // Any parsed inbound frame is liveness evidence (a socket relaying traffic
    // is not half-open): resets the silence clock and clears an outstanding probe.
    this.lastInboundAt = Date.now()
    this.probeSentAt = null
    if (msg.type === 'ready') {
      this._serverInstanceId = typeof msg.serverInstanceId === 'string' && msg.serverInstanceId.trim()
        ? msg.serverInstanceId
        : undefined
      // Capture BEFORE the replay block below: the CURRENT socket's ack decides
      // whether the blind in-flight create replay runs.
      this.serverCapabilities = msg.capabilities ?? {}
      this.terminalInterestRevision = 0
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

      const reconcileHold = this.serverCapabilities.paneReconcileV1 === true
      const createRequestIdsFlushed = new Set<string>()
      if (reconcileHold) {
        // Sender-level pre-verdict hold (the authoritative gate): queued pane
        // creates move to heldCreates instead of the wire. They flush when a
        // verdict folds (via cancelCreate retraction / view re-send), when
        // setReconcilePendingCreates narrows the set, when
        // clearReconcileCreateHold() fires, or at the wall-clock bound below.
        this.reconcileHoldActive = true
        this.reconcileHoldPendingSet = null
        for (const [requestId, createMsg] of this.preReadyCreateQueue.entries()) {
          if (!this.inFlightCreates.has(requestId)) continue
          this.heldCreates.set(requestId, createMsg)
        }
        if (this.reconcileHoldTimer !== null) {
          window.clearTimeout(this.reconcileHoldTimer)
        }
        this.reconcileHoldTimer = window.setTimeout(() => {
          this.reconcileHoldTimer = null
          // Bounded wait: degrade to today's eager behavior, never a silent wedge.
          this.clearReconcileCreateHold()
        }, RECONCILE_VERDICT_WAIT_MS)
      } else {
        for (const [requestId, createMsg] of this.preReadyCreateQueue.entries()) {
          if (!this.inFlightCreates.has(requestId)) continue
          this.sendNow(createMsg)
          createRequestIdsFlushed.add(requestId)
        }
      }
      this.preReadyCreateQueue.clear()

      // Reconnect replay must not blind-fire terminal.attach (recovery
      // re-attaches deliberately) NOR terminal.input (kata dtfn: the queued
      // frames carry the PRE-restart terminalId; the server answers
      // terminal.input.blocked{unknown_terminal} at best, and the bytes are
      // gone. TerminalView buffers un-anchored keystrokes and flushes them
      // after the pane's next anchor instead).
      const pendingMessages = isReconnect
        ? this.pendingMessages.filter(
            (queued) => !isTerminalAttachMessage(queued) && !isTerminalInputMessage(queued),
          )
        : this.pendingMessages
      this.pendingMessages = []

      for (const next of pendingMessages) {
        if (!next) continue
        this.sendNow(next)
      }

      // When paneReconcileV1 was acked on THIS socket's ready, verdicts (not blind
      // resends) decide the fate of in-flight creates — and the preReadyCreateQueue
      // creates above were moved into the pre-verdict hold rather than flushed:
      // mount-time creates are queued/flushed before any App/Redux handler runs,
      // so this sender-level hold is the only gate that closes the reload race.
      if (isReconnect && !this.serverCapabilities.paneReconcileV1) {
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
    }

    if (
      (msg.type === 'terminal.output' || msg.type === 'terminal.output.batch')
      && typeof msg.terminalId === 'string'
    ) {
      markTerminalOutputSeen(msg.terminalId)
    }

    if (
      msg.type === 'terminal.created'
      || msg.type === 'freshAgent.created'
      || msg.type === 'freshAgent.create.failed'
    ) {
      this.clearTrackedCreate(msg.requestId)
    }

    if (msg.type === 'error' && typeof msg.requestId === 'string') {
      this.clearTrackedCreate(msg.requestId)
    }

    if (msg.type === 'error' && msg.code === 'NOT_AUTHENTICATED') {
      this.clearReadyTimeout()
      this.intentionalClose = true
      return
    }

    if (msg.type === 'error' && msg.code === 'PROTOCOL_MISMATCH') {
      this.clearReadyTimeout()
      this.clearQueuedMessagesAfterProtocolMismatch()
      this.intentionalClose = true
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

  /**
   * Set a provider for additional data to include in the hello message.
   * Used to send session IDs for prioritized repair scanning.
   */
  setHelloExtensionProvider(provider: HelloExtensionProvider): void {
    this.helloExtensionProvider = provider
  }

  setOutboundMessageObserver(observer?: OutboundMessageObserver): void {
    this.outboundMessageObserver = observer
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

  /**
   * Capabilities acked by the server on the CURRENT socket's ready.
   * Returns {} until a ready with capabilities arrives; reset on disconnect.
   */
  getServerCapabilities(): NonNullable<ReadyCapabilities> {
    return this.serverCapabilities
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
      // Generation guard: each socket's handlers capture their generation and
      // no-op once superseded — a late event from an abandoned socket must
      // never touch the live connection's state (LB-3).
      const gen = ++this.socketGen
      const socket = this.ws

      this.ws.onopen = () => {
        if (gen !== this.socketGen || this.ws !== socket) return
        this._state = 'connected'
        this.lastInboundAt = Date.now()
        this.probeSentAt = null
        this.startLivenessWatch()
        this.reconnectAttempts = 0
        this.fastReconnectMode = false
        this.slowRetryAnnounced = false

        // Send hello with token in message body (not URL).
        const token = getAuthToken()
        const extensions = this.helloExtensionProvider?.() || {}
        const helloExtensions = {
          ...extensions,
          ...(extensions.sidebarOpenSessions !== undefined
            ? { sidebarOpenSessions: sanitizeSessionLocators(extensions.sidebarOpenSessions) }
            : {}),
        }
        this.sendNow({
          type: 'hello',
          token,
          protocolVersion: WS_PROTOCOL_VERSION,
          capabilities: { uiScreenshotV1: true, terminalOutputBatchV1: true, terminalInterestV1: true, paneReconcileV1: true, paneReconcileFreshAgentV1: true },
          ...helloExtensions,
        })
      }

      this.ws.onmessage = (event) => {
        if (gen !== this.socketGen || this.ws !== socket) return
        let msg: ServerMessage
        try {
          msg = JSON.parse(event.data) as ServerMessage
        } catch {
          // Ignore invalid JSON
          return
        }
        this.handleIncomingMessage(msg)
        if (msg.type === 'ready') {
          finishResolve()
          return
        }
        if (msg.type === 'error' && msg.code === 'NOT_AUTHENTICATED') {
          const err = new Error('Authentication failed')
          ;(err as any).wsCloseCode = 4001
          finishReject(err)
          return
        }
        if (msg.type === 'error' && msg.code === 'PROTOCOL_MISMATCH') {
          this.clearReadyTimeout()
          this.intentionalClose = true
          const err = new Error(typeof msg.message === 'string' && msg.message
            ? msg.message
            : 'Protocol version mismatch. Reload this Freshell browser tab to use the latest client bundle.')
          ;(err as any).wsCloseCode = 4010
          finishReject(err)
        }
      }

      this.ws.onclose = (event) => {
        if (gen !== this.socketGen || this.ws !== socket) return
        this.clearReadyTimeout()
        this.clearLivenessWatch()
        const wasReady = this._state === 'ready'
        const closedBeforeReady = !wasReady
        this._state = 'disconnected'
        this.ws = null
        // Capabilities are per-connection: reset so a downgraded server (next
        // ready without the ack) is honored.
        this.serverCapabilities = {}
        // Hold state is per-connection too: held creates were never on the
        // wire, so re-queue them for the next connection's pre-ready path.
        this.resetReconcileHold({ requeueHeld: true })
        this.disconnectHandlers.forEach((handler) => handler())

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
          // Reset backoff and use faster base delay for quick recovery.
          this.reconnectAttempts = 0
          this.fastReconnectMode = true
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
        if (gen !== this.socketGen || this.ws !== socket) return
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
    let delay: number
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      // Fast-backoff budget exhausted. Never give up permanently: an expected
      // outage can outlast the budget (slow rebuild/restart), and recovery
      // paths elsewhere (disk-sync poll, editor restore) are gated on this
      // connection coming back. Fall back to a slow steady retry and surface
      // the degraded state once, at warn (it is not an error/crash — the
      // server may simply be down for a while).
      if (!this.slowRetryAnnounced) {
        this.slowRetryAnnounced = true
        log.warn('max reconnect attempts reached; falling back to slow retry')
      }
      // Honor caller-requested floors (e.g. the 4008 backpressure path) even in
      // slow mode; slowReconnectDelay is normally the larger of the two.
      delay = Math.max(this.slowReconnectDelay, opts?.minDelayMs ?? 0)
    } else {
      const base = this.fastReconnectMode ? this.postShutdownBaseDelay : this.baseReconnectDelay
      const exponential = base * Math.pow(2, this.reconnectAttempts)
      const capped = Math.min(exponential, this.maxReconnectDelay)
      const jitter = capped * (0.8 + Math.random() * 0.4)
      delay = Math.max(Math.round(jitter), opts?.minDelayMs ?? 0)
      this.reconnectAttempts++
    }

    this.clearReconnectTimer()
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      if (!this.intentionalClose) {
        // A failed reconnect attempt is expected while the server is restarting;
        // the backoff loop keeps trying and 'max reconnect attempts reached'
        // warns if we ultimately give up. Log at debug so restarts stay quiet.
        this.connect().catch((err) => log.debug('reconnect failed', err))
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
    this.clearLivenessWatch()
    // Bump the generation so a torn-down socket's late events are inert.
    this.socketGen += 1
    this.ws?.close()
    this.ws = null
    this._state = 'disconnected'
    this.pendingMessages = []
    this.inFlightCreates.clear()
    this.preReadyCreateQueue.clear()
    this.resetReconcileHold({ requeueHeld: false })
    this.serverCapabilities = {}
    this._serverInstanceId = undefined
    this.connectPromise = null
    this.reconnectAttempts = 0
    // Keep state resets symmetric with onopen: a later reconnect cycle that
    // exhausts its fast budget should announce the slow fallback again.
    this.slowRetryAnnounced = false
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

  private startLivenessWatch(): void {
    this.clearLivenessWatch()
    this.livenessTimer = window.setInterval(() => this.tickLiveness(), LIVENESS_TICK_MS)
  }

  private clearLivenessWatch(): void {
    if (this.livenessTimer !== null) {
      window.clearInterval(this.livenessTimer)
      this.livenessTimer = null
    }
    this.probeSentAt = null
  }

  private tickLiveness(): void {
    if (this._state !== 'ready' || !this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const now = Date.now()
    if (this.probeSentAt !== null) {
      if (now - this.probeSentAt >= PONG_TIMEOUT_MS) {
        this.abandonStaleSocket('liveness probe unanswered')
      }
      return
    }
    if (now - this.lastInboundAt < PROBE_AFTER_SILENCE_MS) return
    this.probeSentAt = now
    this.sendNow({ type: 'ping' })
  }

  /**
   * Half-open socket disposal. A dead transport cannot be trusted to deliver
   * onclose promptly (or ever), so recycling never waits on the old socket's
   * events: handlers detach, connection-local state is forced down, and a fresh
   * connect is driven NOW. The generation guard makes the old socket's late
   * events no-ops (LB-3: the bare this.ws swap in connect() would otherwise let
   * the old onclose corrupt the new connection).
   */
  private abandonStaleSocket(reason: string): void {
    const old = this.ws
    if (old) {
      old.onopen = null
      old.onmessage = null
      old.onclose = null
      old.onerror = null
      try { old.close() } catch { /* best effort: resource hygiene only */ }
    }
    this.ws = null
    this._state = 'disconnected'
    this.serverCapabilities = {}
    this.resetReconcileHold({ requeueHeld: true })
    this.clearLivenessWatch()
    // A normal close notifies disconnectHandlers (App flips Redux
    // connection.status at App.tsx's onDisconnect subscription) — abandonment
    // must too, or Redux sits at 'ready' forever and every status-keyed
    // recovery wedges.
    this.disconnectHandlers.forEach((h) => h())
    log.warn(`abandoning stale socket: ${reason}`)
    this.connect().catch((err) => log.debug('reconnect after abandon failed', err))
  }

  /**
   * Foreground poke: re-assert connectivity when the page becomes visible/online.
   * - ready + recently active   → probe immediately (fast failure discovery).
   * - ready + silent past two server keepalive windows → abandon: the peer may
   *   already be reaped, and reconnect convergence is cheaper than the probe wait.
   * - down with a (possibly background-clamped) backoff timer pending → connect now.
   */
  poke(): void {
    if (this.intentionalClose) return
    if (this._state === 'ready') {
      if (this.probeSentAt !== null && Date.now() - this.probeSentAt >= PONG_TIMEOUT_MS) {
        this.abandonStaleSocket('foreground poke: outstanding probe expired')
        return
      }
      if (Date.now() - this.lastInboundAt >= FOREGROUND_RECYCLE_SILENCE_MS) {
        this.abandonStaleSocket('foreground poke past keepalive windows')
        return
      }
      // Foreground means "ask now": probe immediately, bypassing the 30s silence
      // gate (fresh-eyes F1 — routing this through tickLiveness's guard could
      // never fire the immediate probe the tests pin).
      if (this.probeSentAt === null) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          // Ready state with a non-open socket: a dead-in-flight close that
          // may never deliver onclose — abandon rather than throw into send().
          this.abandonStaleSocket('foreground poke: socket not open')
          return
        }
        this.probeSentAt = Date.now()
        this.sendNow({ type: 'ping' })
      }
      return
    }
    if (this.connectPromise) return
    if (this._state === 'connecting') return
    this.clearReconnectTimer()
    this.connect().catch((err) => log.debug('poke reconnect failed', err))
  }

  /**
   * Reliable send: if not ready yet, queues messages until ready.
   */
  send(msg: unknown) {
    if (this.intentionalClose) return

    if (isTerminalInputMessage(msg)) {
      markTerminalInputSent(msg.terminalId)
    }

    if (isCreateMessage(msg)) {
      this.inFlightCreates.set(msg.requestId, {
        message: msg,
        lastResendEpoch: -1,
      })
    }

    if (this._state === 'ready' && this.ws?.readyState === WebSocket.OPEN) {
      // Pre-verdict hold: mount effects that commit after ready still race the
      // reconcile verdicts. Before setReconcilePendingCreates arrives, hold ALL
      // creates; after, hold only requestIds the boot reconcile request named.
      if (
        this.reconcileHoldActive
        && isCreateMessage(msg)
        && (this.reconcileHoldPendingSet === null || this.reconcileHoldPendingSet.has(msg.requestId))
      ) {
        this.heldCreates.set(msg.requestId, msg)
        return
      }
      this.sendNow(msg)
      return
    }

    if (isCreateMessage(msg)) {
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
      if (isCreateMessage(dropped)) {
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

  /** Presentation updates are sent only on the current negotiated socket.
   * Never put stale interest in the reconnect/reliable-command queue. */
  sendTerminalInterest(snapshot: TerminalInterestSnapshot): boolean {
    if (this.intentionalClose || this._state !== 'ready'
      || this.ws?.readyState !== WebSocket.OPEN
      || this.serverCapabilities.terminalInterestV1 !== true
      || this.terminalInterestRevision >= Number.MAX_SAFE_INTEGER) return false
    const revision = ++this.terminalInterestRevision
    try {
      this.sendNow({ type: 'terminal.interest', revision,
        focusedTerminalId: snapshot.focusedTerminalId, visibleTerminalIds: snapshot.visibleTerminalIds })
      return true
    } catch {
      return false
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

  sendTabsSyncClientRetire(payload: TabsSyncClientRetirePayload) {
    this.send({
      type: 'tabs.sync.client.retire',
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

  onDisconnect(handler: DisconnectHandler): () => void {
    this.disconnectHandlers.add(handler)
    return () => this.disconnectHandlers.delete(handler)
  }

  receiveMessageForTest(msg: ServerMessage): void {
    this.handleIncomingMessage(msg)
  }

  private sendNow(msg: unknown) {
    this.ws?.send(JSON.stringify(msg))
    this.outboundMessageObserver?.(msg)
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
