import type http from 'http'
import { randomUUID } from 'crypto'
import WebSocket, { WebSocketServer } from 'ws'
import { z } from 'zod'
import { logger } from './logger.js'
import { getPerfConfig, logPerfEvent, shouldLog, startPerfTimer } from './perf-logger.js'
import { getRequiredAuthToken, isLoopbackAddress, isOriginAllowed, timingSafeCompare } from './auth.js'
import { modeSupportsResume } from './terminal-registry.js'
import type { TerminalRegistry, TerminalMode } from './terminal-registry.js'
import { configStore, type AppSettings, type ConfigReadError } from './config-store.js'
import type { CodingCliSessionManager } from './coding-cli/session-manager.js'
import type { ProjectGroup } from './coding-cli/types.js'
import type { TerminalMeta } from './terminal-metadata-service.js'
import type { SessionRepairService } from './session-scanner/service.js'
import type { SessionScanResult, SessionRepairResult } from './session-scanner/types.js'
import { isValidClaudeSessionId } from './claude-session-id.js'
import type { SdkBridge } from './sdk-bridge.js'
import type { SdkServerMessage } from '../shared/ws-protocol.js'
import { TerminalStreamBroker } from './terminal-stream/broker.js'
import { chunkProjects } from './ws-chunking.js'
import { TabRegistryRecordBaseSchema, TabRegistryRecordSchema } from './tabs-registry/types.js'
import type { TabsRegistryStore } from './tabs-registry/store.js'
import {
  ErrorCode,
  ShellSchema,
  CodingCliProviderSchema,
  TokenSummarySchema,
  TerminalMetaRecordSchema,
  TerminalMetaListResponseSchema,
  TerminalMetaUpdatedSchema,
  HelloSchema,
  PingSchema,
  TerminalCreateSchema,
  TerminalAttachSchema,
  TerminalDetachSchema,
  TerminalInputSchema,
  TerminalResizeSchema,
  TerminalKillSchema,
  TerminalListSchema,
  TerminalMetaListSchema,
  CodingCliCreateSchema,
  CodingCliInputSchema,
  CodingCliKillSchema,
  SdkCreateSchema,
  SdkSendSchema,
  SdkPermissionRespondSchema,
  SdkInterruptSchema,
  SdkKillSchema,
  SdkAttachSchema,
  SdkSetModelSchema,
  SdkSetPermissionModeSchema,
  WS_PROTOCOL_VERSION,
} from '../shared/ws-protocol.js'

const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS || 50)
const HELLO_TIMEOUT_MS = Number(process.env.HELLO_TIMEOUT_MS || 5_000)
const PING_INTERVAL_MS = Number(process.env.PING_INTERVAL_MS || 30_000)
const MAX_WS_BUFFERED_AMOUNT = Number(process.env.MAX_WS_BUFFERED_AMOUNT || 2 * 1024 * 1024)
// Max payload size per WebSocket message for mobile browser compatibility (500KB)
const MAX_CHUNK_BYTES = Number(process.env.MAX_WS_CHUNK_BYTES || 500 * 1024)
// Drain-aware sending: wait for buffer to drop below threshold between chunks
const DRAIN_THRESHOLD_BYTES = Number(process.env.WS_DRAIN_THRESHOLD_BYTES || 512 * 1024) // 512KB
const DRAIN_TIMEOUT_MS = Number(process.env.WS_DRAIN_TIMEOUT_MS || 30_000) // 30s
const DRAIN_POLL_INTERVAL_MS = 50
// Rate limit: max terminal.create requests per client within a sliding window
const TERMINAL_CREATE_RATE_LIMIT = Number(process.env.TERMINAL_CREATE_RATE_LIMIT || 10)
const TERMINAL_CREATE_RATE_WINDOW_MS = Number(process.env.TERMINAL_CREATE_RATE_WINDOW_MS || 10_000)
/** Sentinel value reserved in createdByRequestId while awaiting async session repair */
const REPAIR_PENDING_SENTINEL = '__repair_pending__'

const log = logger.child({ component: 'ws' })
const perfConfig = getPerfConfig()

// Extended WebSocket with liveness tracking for keepalive
export interface LiveWebSocket extends WebSocket {
  isAlive?: boolean
  connectionId?: string
  connectedAt?: number
  isMobileClient?: boolean
  // Generation counter for chunked session updates to prevent interleaving
  sessionUpdateGeneration?: number
}

const CLOSE_CODES = {
  NOT_AUTHENTICATED: 4001,
  HELLO_TIMEOUT: 4002,
  MAX_CONNECTIONS: 4003,
  BACKPRESSURE: 4008,
  SERVER_SHUTDOWN: 4009,
  PROTOCOL_MISMATCH: 4010,
}


function nowIso() {
  return new Date().toISOString()
}

function isMobileUserAgent(userAgent: string | undefined): boolean {
  if (!userAgent) return false
  return /Mobi|Android|iPhone|iPad|iPod/i.test(userAgent)
}

const TabsSyncPushRecordSchema = TabRegistryRecordBaseSchema.omit({
  serverInstanceId: true,
  deviceId: true,
  deviceLabel: true,
})

const TabsSyncPushSchema = z.object({
  type: z.literal('tabs.sync.push'),
  deviceId: z.string().min(1),
  deviceLabel: z.string().min(1),
  records: z.array(TabsSyncPushRecordSchema),
})

const TabsSyncQuerySchema = z.object({
  type: z.literal('tabs.sync.query'),
  requestId: z.string().min(1),
  deviceId: z.string().min(1),
  rangeDays: z.number().int().positive().optional(),
})

const ClientMessageSchema = z.discriminatedUnion('type', [
  HelloSchema,
  PingSchema,
  TerminalCreateSchema,
  TerminalAttachSchema,
  TerminalDetachSchema,
  TerminalInputSchema,
  TerminalResizeSchema,
  TerminalKillSchema,
  TerminalListSchema,
  TerminalMetaListSchema,
  TabsSyncPushSchema,
  TabsSyncQuerySchema,
  CodingCliCreateSchema,
  CodingCliInputSchema,
  CodingCliKillSchema,
  SdkCreateSchema,
  SdkSendSchema,
  SdkPermissionRespondSchema,
  SdkInterruptSchema,
  SdkKillSchema,
  SdkAttachSchema,
  SdkSetModelSchema,
  SdkSetPermissionModeSchema,
])

type ClientState = {
  authenticated: boolean
  supportsSessionsPatchV1: boolean
  sessionsSnapshotSent: boolean
  attachedTerminalIds: Set<string>
  createdByRequestId: Map<string, string>
  terminalCreateTimestamps: number[]
  codingCliSessions: Set<string>
  codingCliSubscriptions: Map<string, () => void>
  sdkSessions: Set<string>
  sdkSubscriptions: Map<string, () => void>
  interestedSessions: Set<string>
  helloTimer?: NodeJS.Timeout
}

type HandshakeSnapshot = {
  settings?: AppSettings
  projects?: ProjectGroup[]
  perfLogging?: boolean
  configFallback?: {
    reason: ConfigReadError
    backupExists: boolean
  }
}

type HandshakeSnapshotProvider = () => Promise<HandshakeSnapshot>

export class WsHandler {
  private wss: WebSocketServer
  private connections = new Set<LiveWebSocket>()
  private clientStates = new Map<LiveWebSocket, ClientState>()
  private pingInterval: NodeJS.Timeout | null = null
  private closed = false
  private sessionRepairService?: SessionRepairService
  private handshakeSnapshotProvider?: HandshakeSnapshotProvider
  private terminalMetaListProvider?: () => TerminalMeta[]
  private tabsRegistryStore?: TabsRegistryStore
  private terminalStreamBroker: TerminalStreamBroker
  private readonly serverInstanceId: string
  private sessionRepairListeners?: {
    scanned: (result: SessionScanResult) => void
    repaired: (result: SessionRepairResult) => void
    error: (sessionId: string, error: Error) => void
  }

  constructor(
    server: http.Server,
    private registry: TerminalRegistry,
    private codingCliManager?: CodingCliSessionManager,
    private sdkBridge?: SdkBridge,
    sessionRepairService?: SessionRepairService,
    handshakeSnapshotProvider?: HandshakeSnapshotProvider,
    terminalMetaListProvider?: () => TerminalMeta[],
    tabsRegistryStore?: TabsRegistryStore,
    serverInstanceId?: string,
  ) {
    this.sessionRepairService = sessionRepairService
    this.handshakeSnapshotProvider = handshakeSnapshotProvider
    this.terminalMetaListProvider = terminalMetaListProvider
    this.tabsRegistryStore = tabsRegistryStore
    this.serverInstanceId = serverInstanceId && serverInstanceId.trim().length > 0
      ? serverInstanceId
      : `srv-${randomUUID()}`
    this.terminalStreamBroker = new TerminalStreamBroker(this.registry)
    this.wss = new WebSocketServer({
      server,
      path: '/ws',
      maxPayload: 1_000_000,
    })

    const originalClose = server.close.bind(server)
    ;(server as any).close = (callback?: (err?: Error) => void) => {
      this.close()
      return originalClose(callback)
    }

    this.wss.on('connection', (ws, req) => this.onConnection(ws as LiveWebSocket, req))

    // Start protocol-level ping interval for keepalive
    this.pingInterval = setInterval(() => {
      for (const ws of this.connections) {
        if (ws.isAlive === false) {
          ws.terminate()
          continue
        }
        ws.isAlive = false
        ws.ping()
      }
    }, PING_INTERVAL_MS)

    // Subscribe to session repair events
    if (this.sessionRepairService) {
      const onScanned = (result: SessionScanResult) => {
        this.broadcastSessionStatus(result.sessionId, {
          type: 'session.status',
          sessionId: result.sessionId,
          status: result.status === 'healthy' ? 'healthy' : 'corrupted',
          chainDepth: result.chainDepth,
        })

        this.broadcast({
          type: 'session.repair.activity',
          event: 'scanned',
          sessionId: result.sessionId,
          status: result.status,
          chainDepth: result.chainDepth,
          orphanCount: result.orphanCount,
        })
        logger.debug({ sessionId: result.sessionId, status: result.status }, 'Session repair scan complete')
      }

      const onRepaired = (result: SessionRepairResult) => {
        this.broadcastSessionStatus(result.sessionId, {
          type: 'session.status',
          sessionId: result.sessionId,
          status: 'repaired',
          chainDepth: result.newChainDepth,
          orphansFixed: result.orphansFixed,
        })

        this.broadcast({
          type: 'session.repair.activity',
          event: 'repaired',
          sessionId: result.sessionId,
          status: result.status,
          orphansFixed: result.orphansFixed,
          chainDepth: result.newChainDepth,
        })
        logger.info({ sessionId: result.sessionId, orphansFixed: result.orphansFixed }, 'Session repair completed')
      }

      const onError = (sessionId: string, error: Error) => {
        this.broadcast({
          type: 'session.repair.activity',
          event: 'error',
          sessionId,
          message: error.message,
        })
        logger.warn({ err: error, sessionId }, 'Session repair failed')
      }

      this.sessionRepairListeners = { scanned: onScanned, repaired: onRepaired, error: onError }
      this.sessionRepairService.on('scanned', onScanned)
      this.sessionRepairService.on('repaired', onRepaired)
      this.sessionRepairService.on('error', onError)
    }
  }

  /**
   * Broadcast session status to clients interested in that session.
   */
  private broadcastSessionStatus(sessionId: string, msg: unknown): void {
    for (const [ws, state] of this.clientStates) {
      if (state.authenticated && state.interestedSessions.has(sessionId)) {
        if (ws.readyState === WebSocket.OPEN) {
          this.send(ws, msg)
        }
      }
    }
  }

  getServer() {
    return this.wss
  }

  connectionCount() {
    return this.connections.size
  }

  private onConnection(ws: LiveWebSocket, req: http.IncomingMessage) {
    if (this.connections.size >= MAX_CONNECTIONS) {
      ws.close(CLOSE_CODES.MAX_CONNECTIONS, 'Too many connections')
      return
    }

    const origin = req.headers.origin as string | undefined
    const remoteAddr = (req.socket.remoteAddress as string | undefined) || undefined
    const userAgent = req.headers['user-agent'] as string | undefined

    // Origin validation is advisory-only — the auth token in the hello message
    // is the real security gate.  We log mismatches for diagnostics but never
    // reject connections based on Origin, because:
    // - VPNs may strip or rewrite the Origin header
    // - Some mobile browsers omit Origin on WebSocket upgrades
    // - In dev mode Vite's changeOrigin proxy masked this entirely
    const isLoopback = isLoopbackAddress(remoteAddr)

    if (!isLoopback) {
      const host = req.headers.host as string | undefined
      if (!origin) {
        log.warn({ event: 'ws_origin_missing', remoteAddr, host, userAgent },
          'WebSocket connection without Origin header (VPN or mobile browser) — allowing, auth token required')
      } else {
        const hostOrigins = host ? [`http://${host}`, `https://${host}`] : []
        const allowed = isOriginAllowed(origin) || hostOrigins.includes(origin)
        if (!allowed) {
          log.warn({ event: 'ws_origin_mismatch', origin, host, remoteAddr, userAgent },
            'WebSocket Origin does not match Host — allowing, auth token required')
        }
      }
    }

    const connectionId = randomUUID()
    ws.connectionId = connectionId
    ws.connectedAt = Date.now()
    ws.isMobileClient = isMobileUserAgent(userAgent)

    const state: ClientState = {
      authenticated: false,
      supportsSessionsPatchV1: false,
      sessionsSnapshotSent: false,
      attachedTerminalIds: new Set(),
      createdByRequestId: new Map(),
      terminalCreateTimestamps: [],
      codingCliSessions: new Set(),
      codingCliSubscriptions: new Map(),
      sdkSessions: new Set(),
      sdkSubscriptions: new Map(),
      interestedSessions: new Set(),
    }
    this.clientStates.set(ws, state)

    // Mark connection alive for keepalive pings
    ws.isAlive = true
    ws.on('pong', () => {
      ws.isAlive = true
    })

    this.connections.add(ws)

    log.info(
      {
        event: 'ws_connection_open',
        connectionId,
        origin,
        remoteAddr,
        userAgent,
        connectionCount: this.connections.size,
      },
      'WebSocket connection opened',
    )

    state.helloTimer = setTimeout(() => {
      if (!state.authenticated) {
        ws.close(CLOSE_CODES.HELLO_TIMEOUT, 'Hello timeout')
      }
    }, HELLO_TIMEOUT_MS)

    ws.on('message', (data) => void this.onMessage(ws, state, data))
    ws.on('close', (code, reason) => this.onClose(ws, state, code, reason))
    ws.on('error', (err) => log.debug({ err, connectionId }, 'WS error'))
  }

  private onClose(ws: LiveWebSocket, state: ClientState, code?: number, reason?: Buffer) {
    if (state.helloTimer) clearTimeout(state.helloTimer)
    this.connections.delete(ws)
    this.clientStates.delete(ws)

    // Detach from any terminals (broker-managed stream path).
    this.terminalStreamBroker.detachAllForSocket(ws)
    state.attachedTerminalIds.clear()
    for (const off of state.codingCliSubscriptions.values()) {
      off()
    }
    state.codingCliSubscriptions.clear()
    for (const off of state.sdkSubscriptions.values()) {
      off()
    }
    state.sdkSubscriptions.clear()

    const durationMs = ws.connectedAt ? Date.now() - ws.connectedAt : undefined
    const reasonText = reason ? reason.toString() : undefined

    log.info(
      {
        event: 'ws_connection_closed',
        connectionId: ws.connectionId,
        code,
        reason: reasonText,
        durationMs,
        connectionCount: this.connections.size,
      },
      'WebSocket connection closed',
    )
  }

  private removeCodingCliSubscription(state: ClientState, sessionId: string) {
    const off = state.codingCliSubscriptions.get(sessionId)
    if (off) {
      off()
      state.codingCliSubscriptions.delete(sessionId)
    }
  }

  private closeForBackpressureIfNeeded(ws: LiveWebSocket, bufferedOverride?: number): boolean {
    const buffered = bufferedOverride ?? (ws.bufferedAmount as number | undefined)
    if (typeof buffered !== 'number' || buffered <= MAX_WS_BUFFERED_AMOUNT) return false

    if (perfConfig.enabled && shouldLog(`ws_backpressure_${ws.connectionId || 'unknown'}`, perfConfig.rateLimitMs)) {
      logPerfEvent(
        'ws_backpressure_close',
        {
          connectionId: ws.connectionId,
          bufferedBytes: buffered,
          limitBytes: MAX_WS_BUFFERED_AMOUNT,
        },
        'warn',
      )
    }
    ws.close(CLOSE_CODES.BACKPRESSURE, 'Backpressure')
    return true
  }

  private send(ws: LiveWebSocket, msg: unknown) {
    let messageType: string | undefined
    try {
      // Backpressure guard.
      const buffered = ws.bufferedAmount as number | undefined
      if (this.closeForBackpressureIfNeeded(ws, buffered)) return
      let serialized = ''
      let payloadBytes: number | undefined
      let serializeMs: number | undefined
      let shouldLogSend = false

      if (perfConfig.enabled) {
        if (msg && typeof msg === 'object' && 'type' in msg) {
          const typeValue = (msg as { type?: unknown }).type
          if (typeof typeValue === 'string') messageType = typeValue
        }

        const serializeStart = process.hrtime.bigint()
        serialized = JSON.stringify(msg)
        const serializeEnd = process.hrtime.bigint()
        payloadBytes = Buffer.byteLength(serialized)

        if (payloadBytes >= perfConfig.wsPayloadWarnBytes) {
          shouldLogSend = shouldLog(
            `ws_send_large_${ws.connectionId || 'unknown'}_${messageType || 'unknown'}`,
            perfConfig.rateLimitMs,
          )
          if (shouldLogSend) {
            serializeMs = Number((Number(serializeEnd - serializeStart) / 1e6).toFixed(2))
          }
        }
      } else {
        serialized = JSON.stringify(msg)
      }

      const sendStart = shouldLogSend ? process.hrtime.bigint() : null
      ws.send(serialized, (err) => {
        if (!shouldLogSend) return
        const sendMs = sendStart ? Number((Number(process.hrtime.bigint() - sendStart) / 1e6).toFixed(2)) : undefined
        logPerfEvent(
          'ws_send_large',
          {
            connectionId: ws.connectionId,
            messageType,
            payloadBytes,
            bufferedBytes: buffered,
            serializeMs,
            sendMs,
            error: !!err,
          },
          'warn',
        )
      })
    } catch (err) {
      log.warn(
        {
          err: err instanceof Error ? err : new Error(String(err)),
          connectionId: ws.connectionId || 'unknown',
          messageType: messageType || 'unknown',
        },
        'WebSocket send failed',
      )
    }
  }

  private safeSend(ws: LiveWebSocket, msg: unknown) {
    if (ws.readyState === WebSocket.OPEN) {
      this.send(ws, msg)
    }
  }

  private sendError(
    ws: LiveWebSocket,
    params: { code: z.infer<typeof ErrorCode>; message: string; requestId?: string; terminalId?: string }
  ) {
    this.send(ws, {
      type: 'error',
      code: params.code,
      message: params.message,
      requestId: params.requestId,
      terminalId: params.terminalId,
      timestamp: nowIso(),
    })
  }

  /**
   * Wait for ws.bufferedAmount to drop below threshold.
   * Returns true if drained, false if timed out, connection closed, or cancelled.
   * Uses polling because the ws library does not emit 'drain' on WebSocket instances.
   * Optional shouldCancel predicate enables early exit (e.g. when a newer generation supersedes).
   */
  private waitForDrain(
    ws: LiveWebSocket,
    thresholdBytes: number,
    timeoutMs: number,
    shouldCancel?: () => boolean,
  ): Promise<boolean> {
    if (ws.readyState !== WebSocket.OPEN) return Promise.resolve(false)
    if ((ws.bufferedAmount ?? 0) <= thresholdBytes) return Promise.resolve(true)
    if (shouldCancel?.()) return Promise.resolve(false)

    return new Promise<boolean>((resolve) => {
      let settled = false
      const settle = (result: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearInterval(poller)
        ws.off('close', onClose)
        resolve(result)
      }
      const onClose = () => settle(false)
      const timer = setTimeout(() => settle(false), timeoutMs)
      const poller = setInterval(() => {
        if (shouldCancel?.()) { settle(false); return }
        if (ws.readyState !== WebSocket.OPEN) { settle(false); return }
        if ((ws.bufferedAmount ?? 0) <= thresholdBytes) settle(true)
      }, DRAIN_POLL_INTERVAL_MS)
      ws.on('close', onClose)
    })
  }

  private scheduleHandshakeSnapshot(ws: LiveWebSocket, state: ClientState) {
    if (!this.handshakeSnapshotProvider) return
    setTimeout(() => {
      void this.sendHandshakeSnapshot(ws, state)
    }, 0)
  }

  private async sendHandshakeSnapshot(ws: LiveWebSocket, state: ClientState) {
    if (!this.handshakeSnapshotProvider) return
    try {
      const snapshot = await this.handshakeSnapshotProvider()
      if (snapshot.settings) {
        this.safeSend(ws, { type: 'settings.updated', settings: snapshot.settings })
      }
      if (snapshot.projects) {
        const allSent = await this.sendChunkedSessions(ws, snapshot.projects)
        state.sessionsSnapshotSent = allSent
      }
      if (typeof snapshot.perfLogging === 'boolean') {
        this.safeSend(ws, { type: 'perf.logging', enabled: snapshot.perfLogging })
      }
      if (snapshot.configFallback) {
        this.safeSend(ws, { type: 'config.fallback', ...snapshot.configFallback })
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to send handshake snapshot')
    }
  }

  /**
   * Send chunked sessions to a single WebSocket client with interleave protection.
   * Uses a generation counter to cancel in-flight sends when a new update arrives.
   * Returns true if all chunks were sent, false if sending was interrupted.
   */
  private async sendChunkedSessions(ws: LiveWebSocket, projects: ProjectGroup[]): Promise<boolean> {
    // Increment generation to cancel any in-flight sends for this connection
    const generation = (ws.sessionUpdateGeneration = (ws.sessionUpdateGeneration || 0) + 1)
    const isSuperseded = () => ws.sessionUpdateGeneration !== generation
    const chunks = chunkProjects(projects, MAX_CHUNK_BYTES)

    for (let i = 0; i < chunks.length; i++) {
      // Bail out if connection closed or a newer update has started
      if (ws.readyState !== WebSocket.OPEN) return false
      if (isSuperseded()) return false

      const isFirst = i === 0
      let msg: { type: 'sessions.updated'; projects: ProjectGroup[]; clear?: true; append?: true }

      if (chunks.length === 1) {
        // Single chunk: no flags needed (backwards compatible)
        msg = { type: 'sessions.updated', projects: chunks[i] }
      } else if (isFirst) {
        // First chunk: clear existing data
        msg = { type: 'sessions.updated', projects: chunks[i], clear: true }
      } else {
        // Subsequent chunks: append to existing
        msg = { type: 'sessions.updated', projects: chunks[i], append: true }
      }

      this.safeSend(ws, msg)

      // Wait for buffer to drain before sending next chunk
      if (i < chunks.length - 1) {
        const buffered = ws.bufferedAmount as number | undefined
        if (typeof buffered === 'number' && buffered > DRAIN_THRESHOLD_BYTES) {
          if (!await this.waitForDrain(ws, DRAIN_THRESHOLD_BYTES, DRAIN_TIMEOUT_MS, isSuperseded)) return false
        } else {
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
      }
    }
    // Verify connection survived the final send (safeSend can trigger backpressure close)
    return ws.readyState === WebSocket.OPEN && !isSuperseded()
  }
  private async onMessage(ws: LiveWebSocket, state: ClientState, data: WebSocket.RawData) {
    const endMessageTimer = startPerfTimer(
      'ws_message',
      { connectionId: ws.connectionId },
      { minDurationMs: perfConfig.wsSlowMs, level: 'warn' },
    )
    let messageType: string | undefined
    let payloadBytes: number | undefined
    if (perfConfig.enabled) {
      if (Buffer.isBuffer(data)) payloadBytes = data.length
      else if (Array.isArray(data)) payloadBytes = data.reduce((sum, item) => sum + item.length, 0)
      else if (data instanceof ArrayBuffer) payloadBytes = data.byteLength
    }

    try {
      let msg: any
      try {
        msg = JSON.parse(data.toString())
      } catch {
        this.sendError(ws, { code: 'INVALID_MESSAGE', message: 'Invalid JSON' })
        return
      }

      if (msg?.type === 'hello' && msg?.protocolVersion !== WS_PROTOCOL_VERSION) {
        this.sendError(ws, {
          code: 'PROTOCOL_MISMATCH',
          message: `Expected protocol version ${WS_PROTOCOL_VERSION}`,
        })
        ws.close(CLOSE_CODES.PROTOCOL_MISMATCH, 'Protocol version mismatch')
        return
      }

      const parsed = ClientMessageSchema.safeParse(msg)
      if (!parsed.success) {
        this.sendError(ws, { code: 'INVALID_MESSAGE', message: parsed.error.message, requestId: msg?.requestId })
        return
      }

      const m = parsed.data
      messageType = m.type

      if (m.type === 'ping') {
        // Respond to confirm liveness.
        this.send(ws, { type: 'pong', timestamp: nowIso() })
        return
      }

      if (m.type === 'hello') {
        const expected = getRequiredAuthToken()
        if (!m.token || !timingSafeCompare(m.token, expected)) {
          log.warn({ event: 'ws_auth_failed', connectionId: ws.connectionId }, 'WebSocket auth failed')
          this.sendError(ws, { code: 'NOT_AUTHENTICATED', message: 'Invalid token' })
          ws.close(CLOSE_CODES.NOT_AUTHENTICATED, 'Invalid token')
          return
        }
        state.authenticated = true
        state.supportsSessionsPatchV1 = !!m.capabilities?.sessionsPatchV1
        if (typeof m.client?.mobile === 'boolean') {
          ws.isMobileClient = m.client.mobile
        }
        if (state.helloTimer) clearTimeout(state.helloTimer)

        log.info({ event: 'ws_authenticated', connectionId: ws.connectionId }, 'WebSocket client authenticated')

        // Track and prioritize sessions from client
        if (m.sessions && this.sessionRepairService) {
          const allSessions = [
            m.sessions.active,
            ...(m.sessions.visible || []),
            ...(m.sessions.background || []),
          ].filter((s): s is string => !!s)

          for (const sessionId of allSessions) {
            state.interestedSessions.add(sessionId)
          }

          this.sessionRepairService.prioritizeSessions(m.sessions)
        }

        this.send(ws, { type: 'ready', timestamp: nowIso(), serverInstanceId: this.serverInstanceId })
        this.scheduleHandshakeSnapshot(ws, state)
        return
      }

      if (!state.authenticated) {
        this.sendError(ws, { code: 'NOT_AUTHENTICATED', message: 'Send hello first' })
        ws.close(CLOSE_CODES.NOT_AUTHENTICATED, 'Not authenticated')
        return
      }

      switch (m.type) {
      case 'terminal.create': {
        log.debug({
          requestId: m.requestId,
          connectionId: ws.connectionId,
          mode: m.mode,
          resumeSessionId: m.resumeSessionId,
        }, '[TRACE resumeSessionId] terminal.create received')
        const endCreateTimer = startPerfTimer(
          'terminal_create',
          { connectionId: ws.connectionId, mode: m.mode, shell: m.shell },
          { minDurationMs: perfConfig.slowTerminalCreateMs, level: 'warn' },
        )
        let terminalId: string | undefined
        let reused = false
        let error = false
        let rateLimited = false
        try {
          // Load config before the synchronous idempotency check to avoid
          // async yield points between the check and registration.
          const cfg = await awaitConfig()
          const providerSettings = m.mode !== 'shell'
            ? cfg.settings?.codingCli?.providers?.[m.mode as keyof typeof cfg.settings.codingCli.providers] || {}
            : undefined

          const existingId = state.createdByRequestId.get(m.requestId)
          if (existingId) {
            if (existingId === REPAIR_PENDING_SENTINEL) {
              log.debug({ requestId: m.requestId, connectionId: ws.connectionId },
                'terminal.create already in progress (repair pending), ignoring duplicate')
              return
            }
            const existing = this.registry.get(existingId)
            if (existing) {
              const attached = await this.terminalStreamBroker.sendCreatedAndAttach(ws, {
                requestId: m.requestId,
                terminalId: existingId,
                createdAt: existing.createdAt,
                effectiveResumeSessionId: existing.resumeSessionId,
              })
              if (!attached) {
                this.sendError(ws, { code: 'INVALID_TERMINAL_ID', message: 'Unknown terminalId', terminalId: existingId })
                return
              }
              state.attachedTerminalIds.add(existingId)
              terminalId = existingId
              reused = true
              this.broadcast({ type: 'terminal.list.updated' })
              return
            }
            // If it no longer exists, fall through and create a new one.
            state.createdByRequestId.delete(m.requestId)
          }

          // Rate limit: prevent runaway terminal creation (e.g., infinite respawn loops)
          if (!m.restore) {
            const now = Date.now()
            state.terminalCreateTimestamps = state.terminalCreateTimestamps.filter(
              (t) => now - t < TERMINAL_CREATE_RATE_WINDOW_MS
            )
            if (state.terminalCreateTimestamps.length >= TERMINAL_CREATE_RATE_LIMIT) {
              rateLimited = true
              log.warn({ connectionId: ws.connectionId, count: state.terminalCreateTimestamps.length }, 'terminal.create rate limited')
              this.sendError(ws, { code: 'RATE_LIMITED', message: 'Too many terminal.create requests', requestId: m.requestId })
              return
            }
            state.terminalCreateTimestamps.push(now)
          }
          // Resolve session repair before terminal creation.
          let effectiveResumeSessionId = m.resumeSessionId
          if (m.mode === 'claude' && effectiveResumeSessionId && !isValidClaudeSessionId(effectiveResumeSessionId)) {
            log.warn({ resumeSessionId: effectiveResumeSessionId, connectionId: ws.connectionId }, 'Ignoring invalid Claude resumeSessionId')
            effectiveResumeSessionId = undefined
          }

          if (modeSupportsResume(m.mode as TerminalMode) && effectiveResumeSessionId) {
            let existing = this.registry.getCanonicalRunningTerminalBySession(
              m.mode as TerminalMode,
              effectiveResumeSessionId,
            )
            if (!existing) {
              this.registry.repairLegacySessionOwners(
                m.mode as TerminalMode,
                effectiveResumeSessionId,
              )
              existing = this.registry.getCanonicalRunningTerminalBySession(
                m.mode as TerminalMode,
                effectiveResumeSessionId,
              )
            }
            if (existing) {
              const attached = await this.terminalStreamBroker.sendCreatedAndAttach(ws, {
                requestId: m.requestId,
                terminalId: existing.terminalId,
                createdAt: existing.createdAt,
                effectiveResumeSessionId: existing.resumeSessionId,
              })
              if (!attached) {
                this.sendError(ws, {
                  code: 'INVALID_TERMINAL_ID',
                  message: 'Unknown terminalId',
                  terminalId: existing.terminalId,
                })
                return
              }
              state.attachedTerminalIds.add(existing.terminalId)
              state.createdByRequestId.set(m.requestId, existing.terminalId)
              terminalId = existing.terminalId
              reused = true
              this.broadcast({ type: 'terminal.list.updated' })
              return
            }
          }

          // Session repair is Claude-specific (uses JSONL session files).
          // Other providers (codex, opencode, etc.) don't use the same file
          // structure, so this block correctly remains gated on mode === 'claude'.
          if (m.mode === 'claude' && effectiveResumeSessionId && this.sessionRepairService) {
            const sessionId = effectiveResumeSessionId
            const cached = this.sessionRepairService.getResult(sessionId)
            if (cached?.status === 'missing') {
              log.info({ sessionId, connectionId: ws.connectionId }, 'Session previously marked missing; resume will start fresh')
              effectiveResumeSessionId = undefined
            } else {
              // Reserve requestId to prevent duplicate creates during async repair wait
              state.createdByRequestId.set(m.requestId, REPAIR_PENDING_SENTINEL)
              const endRepairTimer = startPerfTimer(
                'terminal_create_repair_wait',
                { connectionId: ws.connectionId, sessionId },
                { minDurationMs: perfConfig.slowTerminalCreateMs, level: 'warn' },
              )
              try {
                const result = await this.sessionRepairService.waitForSession(sessionId, 10000)
                endRepairTimer({ status: result.status })
                if (result.status === 'missing') {
                  log.info({ sessionId, connectionId: ws.connectionId }, 'Session file missing; resume will start fresh')
                  effectiveResumeSessionId = undefined
                }
              } catch (err) {
                endRepairTimer({ error: err instanceof Error ? err.message : String(err) })
                log.debug({ err, sessionId, connectionId: ws.connectionId }, 'Session repair wait failed, proceeding with resume')
              }
            }
          }

          // After async repair wait, check if the client disconnected
          if (ws.readyState !== WebSocket.OPEN) {
            log.debug({ connectionId: ws.connectionId, requestId: m.requestId },
              'Client disconnected during session repair wait, aborting terminal.create')
            if (state.createdByRequestId.get(m.requestId) === REPAIR_PENDING_SENTINEL) {
              state.createdByRequestId.delete(m.requestId)
            }
            return
          }

          log.debug({
            requestId: m.requestId,
            connectionId: ws.connectionId,
            originalResumeSessionId: m.resumeSessionId,
            effectiveResumeSessionId,
          }, '[TRACE resumeSessionId] about to create terminal')

          const record = this.registry.create({
            mode: m.mode as TerminalMode,
            shell: m.shell as 'system' | 'cmd' | 'powershell' | 'wsl',
            cwd: m.cwd,
            resumeSessionId: effectiveResumeSessionId,
            providerSettings: providerSettings ? { permissionMode: providerSettings.permissionMode } : undefined,
          })

          if (m.mode !== 'shell' && typeof m.cwd === 'string' && m.cwd.trim()) {
            const recentDirectory = m.cwd.trim()
            void configStore.pushRecentDirectory(recentDirectory).catch((err) => {
              log.warn({ err, recentDirectory }, 'Failed to record recent directory')
            })
          }

          state.createdByRequestId.set(m.requestId, record.terminalId)
          terminalId = record.terminalId

          // Attach creator immediately through broker (snapshot-free v2 flow).
          const attached = await this.terminalStreamBroker.sendCreatedAndAttach(ws, {
            requestId: m.requestId,
            terminalId: record.terminalId,
            createdAt: record.createdAt,
            effectiveResumeSessionId,
          })
          if (attached) {
            state.attachedTerminalIds.add(record.terminalId)
          }

          // Notify all clients that list changed
          this.broadcast({ type: 'terminal.list.updated' })
        } catch (err: any) {
          error = true
          // Clean up repair sentinel if terminal creation failed
          if (state.createdByRequestId.get(m.requestId) === REPAIR_PENDING_SENTINEL) {
            state.createdByRequestId.delete(m.requestId)
          }
          log.warn({ err, connectionId: ws.connectionId }, 'terminal.create failed')
          this.sendError(ws, {
            code: 'PTY_SPAWN_FAILED',
            message: err?.message || 'Failed to spawn PTY',
            requestId: m.requestId,
          })
        } finally {
          endCreateTimer({ terminalId, reused, error, rateLimited })
        }
        return
      }

      case 'terminal.attach': {
        const attached = await this.terminalStreamBroker.attach(ws, m.terminalId, m.sinceSeq)
        if (!attached) {
          this.sendError(ws, { code: 'INVALID_TERMINAL_ID', message: 'Unknown terminalId', terminalId: m.terminalId })
          return
        }
        state.attachedTerminalIds.add(m.terminalId)
        this.broadcast({ type: 'terminal.list.updated' })
        return
      }

      case 'terminal.detach': {
        const ok = this.terminalStreamBroker.detach(m.terminalId, ws)
        state.attachedTerminalIds.delete(m.terminalId)
        if (!ok) {
          this.sendError(ws, { code: 'INVALID_TERMINAL_ID', message: 'Unknown terminalId', terminalId: m.terminalId })
          return
        }
        this.send(ws, { type: 'terminal.detached', terminalId: m.terminalId })
        this.broadcast({ type: 'terminal.list.updated' })
        return
      }

      case 'terminal.input': {
        const ok = this.registry.input(m.terminalId, m.data)
        if (!ok) {
          this.sendError(ws, { code: 'INVALID_TERMINAL_ID', message: 'Terminal not running', terminalId: m.terminalId })
        }
        return
      }

      case 'terminal.resize': {
        const ok = this.registry.resize(m.terminalId, m.cols, m.rows)
        if (!ok) {
          this.sendError(ws, { code: 'INVALID_TERMINAL_ID', message: 'Terminal not running', terminalId: m.terminalId })
        }
        return
      }

      case 'terminal.kill': {
        const ok = this.registry.kill(m.terminalId)
        if (!ok) {
          this.sendError(ws, { code: 'INVALID_TERMINAL_ID', message: 'Unknown terminalId', terminalId: m.terminalId })
          return
        }
        this.broadcast({ type: 'terminal.list.updated' })
        return
      }

      case 'terminal.list': {
        const cfg = await awaitConfig()
        // Merge terminal overrides into list output.
        const list = this.registry.list().filter((t) => !cfg.terminalOverrides?.[t.terminalId]?.deleted)
        const merged = list.map((t) => {
          const ov = cfg.terminalOverrides?.[t.terminalId]
          return {
            ...t,
            title: ov?.titleOverride || t.title,
            description: ov?.descriptionOverride || t.description,
          }
        })
        this.send(ws, { type: 'terminal.list.response', requestId: m.requestId, terminals: merged })
        return
      }

      case 'terminal.meta.list': {
        const terminals = this.terminalMetaListProvider ? this.terminalMetaListProvider() : []
        const response = TerminalMetaListResponseSchema.safeParse({
          type: 'terminal.meta.list.response',
          requestId: m.requestId,
          terminals,
        })
        if (!response.success) {
          log.warn({ issues: response.error.issues }, 'Invalid terminal.meta.list.response payload')
          this.sendError(ws, {
            code: 'INTERNAL_ERROR',
            message: 'Terminal metadata unavailable',
            requestId: m.requestId,
          })
          return
        }
        this.send(ws, response.data)
        return
      }

      case 'tabs.sync.push': {
        if (!this.tabsRegistryStore) {
          this.sendError(ws, {
            code: 'INTERNAL_ERROR',
            message: 'Tabs registry unavailable',
          })
          return
        }
        for (const record of m.records) {
          await this.tabsRegistryStore.upsert({
            ...record,
            serverInstanceId: this.serverInstanceId,
            deviceId: m.deviceId,
            deviceLabel: m.deviceLabel,
          })
        }
        this.send(ws, { type: 'tabs.sync.ack', updated: m.records.length })
        return
      }

      case 'tabs.sync.query': {
        if (!this.tabsRegistryStore) {
          this.send(ws, {
            type: 'tabs.sync.snapshot',
            requestId: m.requestId,
            data: { localOpen: [], remoteOpen: [], closed: [] },
          })
          return
        }
        const data = await this.tabsRegistryStore.query({
          deviceId: m.deviceId,
          rangeDays: m.rangeDays,
        })
        this.send(ws, {
          type: 'tabs.sync.snapshot',
          requestId: m.requestId,
          data,
        })
        return
      }

      case 'codingcli.create': {
        if (!this.codingCliManager) {
          this.sendError(ws, {
            code: 'INTERNAL_ERROR',
            message: 'Coding CLI sessions not enabled',
            requestId: m.requestId,
          })
          return
        }

        const endCodingTimer = startPerfTimer(
          'codingcli_create',
          { connectionId: ws.connectionId, provider: m.provider },
          { minDurationMs: perfConfig.slowTerminalCreateMs, level: 'warn' },
        )
        let sessionId: string | undefined
        let error = false
        try {
          const cfg = await awaitConfig()
          if (!this.codingCliManager.hasProvider(m.provider)) {
            this.sendError(ws, {
              code: 'INVALID_MESSAGE',
              message: `Provider not supported: ${m.provider}`,
              requestId: m.requestId,
            })
            return
          }
          const enabledProviders = cfg.settings?.codingCli?.enabledProviders
          if (enabledProviders && !enabledProviders.includes(m.provider)) {
            this.sendError(ws, {
              code: 'INVALID_MESSAGE',
              message: `Provider disabled: ${m.provider}`,
              requestId: m.requestId,
            })
            return
          }

          const providerDefaults = cfg.settings?.codingCli?.providers?.[m.provider] || {}
          const session = this.codingCliManager.create(m.provider, {
            prompt: m.prompt,
            cwd: m.cwd,
            resumeSessionId: m.resumeSessionId,
            model: m.model ?? providerDefaults.model,
            maxTurns: m.maxTurns ?? providerDefaults.maxTurns,
            permissionMode: m.permissionMode ?? providerDefaults.permissionMode,
            sandbox: m.sandbox ?? providerDefaults.sandbox,
          })

          // Track this client's session
          state.codingCliSessions.add(session.id)
          sessionId = session.id

          // Stream events to client with detachable listeners
          const onEvent = (event: unknown) => {
            this.safeSend(ws, {
              type: 'codingcli.event',
              sessionId: session.id,
              provider: session.provider.name,
              event,
            })
          }

          const onExit = (code: number) => {
            this.safeSend(ws, {
              type: 'codingcli.exit',
              sessionId: session.id,
              provider: session.provider.name,
              exitCode: code,
            })
            this.removeCodingCliSubscription(state, session.id)
          }

          const onStderr = (text: string) => {
            this.safeSend(ws, {
              type: 'codingcli.stderr',
              sessionId: session.id,
              provider: session.provider.name,
              text,
            })
          }

          session.on('event', onEvent)
          session.on('exit', onExit)
          session.on('stderr', onStderr)

          state.codingCliSubscriptions.set(session.id, () => {
            session.off('event', onEvent)
            session.off('exit', onExit)
            session.off('stderr', onStderr)
          })

          this.send(ws, {
            type: 'codingcli.created',
            requestId: m.requestId,
            sessionId: session.id,
            provider: session.provider.name,
          })
        } catch (err: any) {
          error = true
          log.warn({ err, connectionId: ws.connectionId }, 'codingcli.create failed')
          this.sendError(ws, {
            code: 'INTERNAL_ERROR',
            message: err?.message || 'Failed to create coding CLI session',
            requestId: m.requestId,
          })
        } finally {
          endCodingTimer({ sessionId, error })
        }
        return
      }

      case 'codingcli.input': {
        if (!this.codingCliManager) {
          this.sendError(ws, { code: 'INTERNAL_ERROR', message: 'Coding CLI sessions not enabled' })
          return
        }

        const session = this.codingCliManager.get(m.sessionId)
        if (!session) {
          this.sendError(ws, { code: 'INVALID_SESSION_ID', message: 'Session not found' })
          return
        }

        session.sendInput(m.data)
        return
      }

      case 'codingcli.kill': {
        if (!this.codingCliManager) {
          this.sendError(ws, { code: 'INTERNAL_ERROR', message: 'Coding CLI sessions not enabled' })
          return
        }

        const removed = this.codingCliManager.remove(m.sessionId)
        state.codingCliSessions.delete(m.sessionId)
        this.removeCodingCliSubscription(state, m.sessionId)
        this.send(ws, {
          type: 'codingcli.killed',
          sessionId: m.sessionId,
          success: removed,
        })
        return
      }

      case 'sdk.create': {
        if (!this.sdkBridge) {
          this.sendError(ws, { code: 'INTERNAL_ERROR', message: 'SDK bridge not enabled', requestId: m.requestId })
          return
        }
        try {
          const session = await this.sdkBridge.createSession({
            cwd: m.cwd,
            resumeSessionId: m.resumeSessionId,
            model: m.model,
            permissionMode: m.permissionMode,
            effort: m.effort,
          })
          state.sdkSessions.add(session.sessionId)

          // Send sdk.created FIRST so the client creates the Redux session
          // before any buffered messages (sdk.session.init, sdk.error) arrive.
          this.send(ws, { type: 'sdk.created', requestId: m.requestId, sessionId: session.sessionId })

          // Send preliminary sdk.session.init so the client can start interacting.
          // The SDK subprocess only emits system/init after the first user message,
          // which deadlocks with the UI waiting for init before showing the input.
          // This breaks the deadlock using the info we already have from create options.
          // When system/init arrives (after first user message), session info updates.
          this.send(ws, {
            type: 'sdk.session.init',
            sessionId: session.sessionId,
            model: session.model,
            cwd: session.cwd,
            tools: [],
          })

          // Subscribe this client to session events (replays buffered messages)
          const off = this.sdkBridge.subscribe(session.sessionId, (msg: SdkServerMessage) => {
            this.safeSend(ws, msg)
          })
          if (off) state.sdkSubscriptions.set(session.sessionId, off)

          if (m.cwd?.trim()) {
            void configStore.pushRecentDirectory(m.cwd.trim()).catch((err) => {
              log.warn({ err, cwd: m.cwd }, 'Failed to record recent directory for SDK session')
            })
          }
        } catch (err: any) {
          log.warn({ err }, 'sdk.create failed')
          this.sendError(ws, { code: 'INTERNAL_ERROR', message: err?.message || 'Failed to create SDK session', requestId: m.requestId })
        }
        return
      }

      case 'sdk.send': {
        if (!this.sdkBridge) {
          this.sendError(ws, { code: 'INTERNAL_ERROR', message: 'SDK bridge not enabled' })
          return
        }
        if (!state.sdkSessions.has(m.sessionId) && !state.sdkSubscriptions.has(m.sessionId)) {
          this.sendError(ws, { code: 'UNAUTHORIZED', message: 'Not subscribed to this SDK session' })
          return
        }
        const ok = this.sdkBridge.sendUserMessage(m.sessionId, m.text, m.images)
        if (!ok) {
          this.sendError(ws, { code: 'INVALID_SESSION_ID', message: 'SDK session not found' })
        }
        return
      }

      case 'sdk.permission.respond': {
        if (!this.sdkBridge) {
          this.sendError(ws, { code: 'INTERNAL_ERROR', message: 'SDK bridge not enabled' })
          return
        }
        if (!state.sdkSessions.has(m.sessionId) && !state.sdkSubscriptions.has(m.sessionId)) {
          this.sendError(ws, { code: 'UNAUTHORIZED', message: 'Not subscribed to this SDK session' })
          return
        }
        const decision: import('./sdk-bridge-types.js').PermissionResult = m.behavior === 'allow'
          ? {
              behavior: 'allow',
              updatedInput: m.updatedInput ?? {},
              ...(m.updatedPermissions && { updatedPermissions: m.updatedPermissions as import('./sdk-bridge-types.js').PermissionUpdate[] }),
            }
          : { behavior: 'deny', message: m.message || 'Denied by user', ...(m.interrupt !== undefined && { interrupt: m.interrupt }) }
        const ok = this.sdkBridge.respondPermission(m.sessionId, m.requestId, decision)
        if (!ok) {
          this.sendError(ws, { code: 'INVALID_SESSION_ID', message: 'SDK session not found' })
        }
        return
      }

      case 'sdk.interrupt': {
        if (!this.sdkBridge) {
          this.sendError(ws, { code: 'INTERNAL_ERROR', message: 'SDK bridge not enabled' })
          return
        }
        if (!state.sdkSessions.has(m.sessionId) && !state.sdkSubscriptions.has(m.sessionId)) {
          this.sendError(ws, { code: 'UNAUTHORIZED', message: 'Not subscribed to this SDK session' })
          return
        }
        this.sdkBridge.interrupt(m.sessionId)
        return
      }

      case 'sdk.kill': {
        if (!this.sdkBridge) {
          this.sendError(ws, { code: 'INTERNAL_ERROR', message: 'SDK bridge not enabled' })
          return
        }
        if (!state.sdkSessions.has(m.sessionId) && !state.sdkSubscriptions.has(m.sessionId)) {
          this.sendError(ws, { code: 'UNAUTHORIZED', message: 'Not subscribed to this SDK session' })
          return
        }
        const killed = this.sdkBridge.killSession(m.sessionId)
        state.sdkSessions.delete(m.sessionId)
        const off = state.sdkSubscriptions.get(m.sessionId)
        if (off) {
          off()
          state.sdkSubscriptions.delete(m.sessionId)
        }
        this.send(ws, { type: 'sdk.killed', sessionId: m.sessionId, success: killed })
        return
      }

      case 'sdk.set-model': {
        if (!this.sdkBridge) {
          this.sendError(ws, { code: 'INTERNAL_ERROR', message: 'SDK bridge not enabled' })
          return
        }
        if (!state.sdkSessions.has(m.sessionId) && !state.sdkSubscriptions.has(m.sessionId)) {
          this.sendError(ws, { code: 'UNAUTHORIZED', message: 'Not subscribed to this SDK session' })
          return
        }
        this.sdkBridge.setModel(m.sessionId, m.model)
        return
      }

      case 'sdk.set-permission-mode': {
        if (!this.sdkBridge) {
          this.sendError(ws, { code: 'INTERNAL_ERROR', message: 'SDK bridge not enabled' })
          return
        }
        if (!state.sdkSessions.has(m.sessionId) && !state.sdkSubscriptions.has(m.sessionId)) {
          this.sendError(ws, { code: 'UNAUTHORIZED', message: 'Not subscribed to this SDK session' })
          return
        }
        this.sdkBridge.setPermissionMode(m.sessionId, m.permissionMode)
        return
      }

      case 'sdk.attach': {
        if (!this.sdkBridge) {
          this.sendError(ws, { code: 'INTERNAL_ERROR', message: 'SDK bridge not enabled' })
          return
        }
        const session = this.sdkBridge.getSession(m.sessionId)
        if (!session) {
          this.sendError(ws, { code: 'INVALID_SESSION_ID', message: 'SDK session not found' })
          return
        }

        // Subscribe this client to session events if not already
        if (!state.sdkSubscriptions.has(m.sessionId)) {
          const off = this.sdkBridge.subscribe(m.sessionId, (msg: SdkServerMessage) => {
            this.safeSend(ws, msg)
          })
          if (off) state.sdkSubscriptions.set(m.sessionId, off)
        }

        // Send history replay
        this.send(ws, {
          type: 'sdk.history',
          sessionId: m.sessionId,
          messages: session.messages,
        })

        // Send current status
        this.send(ws, {
          type: 'sdk.status',
          sessionId: m.sessionId,
          status: session.status,
        })
        return
      }

      default:
        this.sendError(ws, { code: 'UNKNOWN_MESSAGE', message: 'Unknown message type' })
        return
      }
    } finally {
      endMessageTimer({ messageType, payloadBytes })
    }
  }

  broadcast(msg: unknown) {
    for (const ws of this.connections) {
      if (ws.readyState === WebSocket.OPEN) {
        this.send(ws, msg)
      }
    }
  }

  /**
   * Broadcast sessions.updated to all connected clients with chunking for mobile compatibility.
   * This handles backpressure per-client to avoid overwhelming mobile WebSocket buffers.
   */
  broadcastSessionsUpdated(projects: ProjectGroup[]): void {
    for (const ws of this.connections) {
      if (ws.readyState === WebSocket.OPEN) {
        // Fire and forget - each client handles its own backpressure
        void this.sendChunkedSessions(ws, projects)
      }
    }
  }

  broadcastSessionsUpdatedToLegacy(projects: ProjectGroup[]): void {
    for (const ws of this.connections) {
      if (ws.readyState !== WebSocket.OPEN) continue
      const state = this.clientStates.get(ws)
      if (!state?.authenticated) continue
      if (state.supportsSessionsPatchV1 && state.sessionsSnapshotSent) continue
      // Update sessionsSnapshotSent on success so patch-capable clients
      // can transition to patch mode after a successful full snapshot.
      void this.sendChunkedSessions(ws, projects).then((allSent) => {
        if (allSent && state.supportsSessionsPatchV1) {
          state.sessionsSnapshotSent = true
        }
      })
    }
  }

  broadcastSessionsPatch(msg: { type: 'sessions.patch'; upsertProjects: ProjectGroup[]; removeProjectPaths: string[] }): void {
    for (const ws of this.connections) {
      if (ws.readyState !== WebSocket.OPEN) continue
      const state = this.clientStates.get(ws)
      if (!state?.authenticated) continue
      if (!state.supportsSessionsPatchV1) continue
      if (!state.sessionsSnapshotSent) continue
      this.safeSend(ws, msg)
    }
  }

  broadcastTerminalMetaUpdated(msg: { upsert?: TerminalMeta[]; remove?: string[] }): void {
    const parsed = TerminalMetaUpdatedSchema.safeParse({
      type: 'terminal.meta.updated',
      upsert: msg.upsert || [],
      remove: msg.remove || [],
    })

    if (!parsed.success) {
      log.warn({ issues: parsed.error.issues }, 'Invalid terminal.meta.updated payload')
      return
    }

    this.broadcast(parsed.data)
  }

  /**
   * Prepare for hot rebind: close all client connections and set the closed
   * flag so the patched server.close() → this.close() is a no-op.
   */
  prepareForRebind(): void {
    for (const ws of this.connections) {
      try {
        ws.close(CLOSE_CODES.SERVER_SHUTDOWN, 'Server rebinding')
        setTimeout(() => {
          if (ws.readyState !== ws.CLOSED) {
            ws.terminate()
          }
        }, 5000)
      } catch {
        try { ws.terminate() } catch { /* ignore */ }
      }
    }

    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }

    this.closed = true
    log.info('WsHandler prepared for rebind (connections closed, WSS preserved)')
  }

  /**
   * Resume after hot rebind: reset the closed flag and restart ping interval.
   */
  resumeAfterRebind(): void {
    this.closed = false

    this.pingInterval = setInterval(() => {
      for (const ws of this.connections) {
        if (ws.isAlive === false) {
          ws.terminate()
          continue
        }
        ws.isAlive = false
        ws.ping()
      }
    }, PING_INTERVAL_MS)

    log.info('WsHandler resumed after rebind')
  }

  /**
   * Gracefully close all WebSocket connections and the server.
   */
  close(): void {
    if (this.closed) return
    this.closed = true

    if (this.sessionRepairService && this.sessionRepairListeners) {
      this.sessionRepairService.off('scanned', this.sessionRepairListeners.scanned)
      this.sessionRepairService.off('repaired', this.sessionRepairListeners.repaired)
      this.sessionRepairService.off('error', this.sessionRepairListeners.error)
      this.sessionRepairListeners = undefined
    }

    // Stop keepalive ping interval
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }

    this.terminalStreamBroker.close()

    // Close all client connections
    for (const ws of this.connections) {
      try {
        ws.close(CLOSE_CODES.SERVER_SHUTDOWN, 'Server shutting down')
      } catch {
        // Ignore errors during shutdown
      }
    }
    this.connections.clear()

    // Close the WebSocket server
    this.wss.close()

    log.info('WebSocket server closed')
  }
}

async function awaitConfig() {
  return await configStore.snapshot()
}
