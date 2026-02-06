import type http from 'http'
import { randomUUID } from 'crypto'
import WebSocket, { WebSocketServer } from 'ws'
import { z } from 'zod'
import { logger } from './logger.js'
import { getPerfConfig, logPerfEvent, shouldLog, startPerfTimer } from './perf-logger.js'
import { getRequiredAuthToken, isLoopbackAddress, isOriginAllowed } from './auth.js'
import type { TerminalRegistry, TerminalMode } from './terminal-registry.js'
import { configStore, type AppSettings } from './config-store.js'
import type { CodingCliSessionManager } from './coding-cli/session-manager.js'
import type { ProjectGroup } from './coding-cli/types.js'
import type { SessionRepairService } from './session-scanner/service.js'
import type { SessionScanResult, SessionRepairResult } from './session-scanner/types.js'
import { isValidClaudeSessionId } from './claude-session-id.js'

const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS || 10)
const HELLO_TIMEOUT_MS = Number(process.env.HELLO_TIMEOUT_MS || 5_000)
const PING_INTERVAL_MS = Number(process.env.PING_INTERVAL_MS || 30_000)
const MAX_WS_BUFFERED_AMOUNT = Number(process.env.MAX_WS_BUFFERED_AMOUNT || 2 * 1024 * 1024)
// Max payload size per WebSocket message for mobile browser compatibility (500KB)
const MAX_CHUNK_BYTES = Number(process.env.MAX_WS_CHUNK_BYTES || 500 * 1024)
// Rate limit: max terminal.create requests per client within a sliding window
const TERMINAL_CREATE_RATE_LIMIT = Number(process.env.TERMINAL_CREATE_RATE_LIMIT || 10)
const TERMINAL_CREATE_RATE_WINDOW_MS = Number(process.env.TERMINAL_CREATE_RATE_WINDOW_MS || 10_000)

const log = logger.child({ component: 'ws' })
const perfConfig = getPerfConfig()

// Extended WebSocket with liveness tracking for keepalive
interface LiveWebSocket extends WebSocket {
  isAlive?: boolean
  connectionId?: string
  connectedAt?: number
  // Generation counter for chunked session updates to prevent interleaving
  sessionUpdateGeneration?: number
}

const CLOSE_CODES = {
  NOT_AUTHENTICATED: 4001,
  HELLO_TIMEOUT: 4002,
  MAX_CONNECTIONS: 4003,
  BACKPRESSURE: 4008,
  SERVER_SHUTDOWN: 4009,
}

const ErrorCode = z.enum([
  'NOT_AUTHENTICATED',
  'INVALID_MESSAGE',
  'UNKNOWN_MESSAGE',
  'INVALID_TERMINAL_ID',
  'INVALID_SESSION_ID',
  'PTY_SPAWN_FAILED',
  'FILE_WATCHER_ERROR',
  'INTERNAL_ERROR',
  'RATE_LIMITED',
])

function nowIso() {
  return new Date().toISOString()
}

/**
 * Chunk projects array into batches that fit within MAX_CHUNK_BYTES when serialized.
 * This ensures mobile browsers with limited WebSocket buffers can receive the data.
 * Uses Buffer.byteLength for accurate UTF-8 byte counting (not UTF-16 code units).
 */
export function chunkProjects(projects: ProjectGroup[], maxBytes: number): ProjectGroup[][] {
  if (projects.length === 0) return [[]]

  const chunks: ProjectGroup[][] = []
  let currentChunk: ProjectGroup[] = []
  let currentSize = 0
  // Base overhead for message wrapper, plus max flag length ('"append":true' is longer than '"clear":true')
  const baseOverhead = Buffer.byteLength(JSON.stringify({ type: 'sessions.updated', projects: [] }))
  const flagOverhead = Buffer.byteLength(',"append":true')
  const overhead = baseOverhead + flagOverhead

  for (const project of projects) {
    const projectJson = JSON.stringify(project)
    const projectSize = Buffer.byteLength(projectJson)
    // Account for comma separator between array elements (except first element)
    const separatorSize = currentChunk.length > 0 ? 1 : 0
    if (currentChunk.length > 0 && currentSize + separatorSize + projectSize + overhead > maxBytes) {
      chunks.push(currentChunk)
      currentChunk = []
      currentSize = 0
    }
    currentChunk.push(project)
    currentSize += (currentChunk.length > 1 ? 1 : 0) + projectSize // Add comma for non-first elements
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk)
  }

  return chunks
}

const HelloSchema = z.object({
  type: z.literal('hello'),
  token: z.string().optional(),
  sessions: z.object({
    active: z.string().optional(),
    visible: z.array(z.string()).optional(),
    background: z.array(z.string()).optional(),
  }).optional(),
})

const PingSchema = z.object({
  type: z.literal('ping'),
})

const ShellSchema = z.enum(['system', 'cmd', 'powershell', 'wsl'])

const TerminalCreateSchema = z.object({
  type: z.literal('terminal.create'),
  requestId: z.string().min(1),
  // Mode supports shell and all coding CLI providers (future providers need spawn logic)
  mode: z.enum(['shell', 'claude', 'codex', 'opencode', 'gemini', 'kimi']).default('shell'),
  shell: ShellSchema.default('system'),
  cwd: z.string().optional(),
  resumeSessionId: z.string().optional(),
  restore: z.boolean().optional(),
})

const TerminalAttachSchema = z.object({
  type: z.literal('terminal.attach'),
  terminalId: z.string().min(1),
})

const TerminalDetachSchema = z.object({
  type: z.literal('terminal.detach'),
  terminalId: z.string().min(1),
})

const TerminalInputSchema = z.object({
  type: z.literal('terminal.input'),
  terminalId: z.string().min(1),
  data: z.string(),
})

const TerminalResizeSchema = z.object({
  type: z.literal('terminal.resize'),
  terminalId: z.string().min(1),
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(2).max(500),
})

const TerminalKillSchema = z.object({
  type: z.literal('terminal.kill'),
  terminalId: z.string().min(1),
})

const TerminalListSchema = z.object({
  type: z.literal('terminal.list'),
  requestId: z.string().min(1),
})

const CodingCliProviderSchema = z.enum(['claude', 'codex', 'opencode', 'gemini', 'kimi'])

// Coding CLI session schemas
const CodingCliCreateSchema = z.object({
  type: z.literal('codingcli.create'),
  requestId: z.string().min(1),
  provider: CodingCliProviderSchema,
  prompt: z.string().min(1),
  cwd: z.string().optional(),
  resumeSessionId: z.string().optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  permissionMode: z.enum(['default', 'plan', 'acceptEdits', 'bypassPermissions']).optional(),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
})

const CodingCliInputSchema = z.object({
  type: z.literal('codingcli.input'),
  sessionId: z.string().min(1),
  data: z.string(),
})

const CodingCliKillSchema = z.object({
  type: z.literal('codingcli.kill'),
  sessionId: z.string().min(1),
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
  CodingCliCreateSchema,
  CodingCliInputSchema,
  CodingCliKillSchema,
])

type ClientState = {
  authenticated: boolean
  attachedTerminalIds: Set<string>
  createdByRequestId: Map<string, string>
  terminalCreateTimestamps: number[]
  codingCliSessions: Set<string>
  codingCliSubscriptions: Map<string, () => void>
  interestedSessions: Set<string>
  helloTimer?: NodeJS.Timeout
}

type HandshakeSnapshot = {
  settings?: AppSettings
  projects?: ProjectGroup[]
  perfLogging?: boolean
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
  private sessionRepairListeners?: {
    scanned: (result: SessionScanResult) => void
    repaired: (result: SessionRepairResult) => void
    error: (sessionId: string, error: Error) => void
  }

  constructor(
    server: http.Server,
    private registry: TerminalRegistry,
    private codingCliManager?: CodingCliSessionManager,
    sessionRepairService?: SessionRepairService,
    handshakeSnapshotProvider?: HandshakeSnapshotProvider
  ) {
    this.sessionRepairService = sessionRepairService
    this.handshakeSnapshotProvider = handshakeSnapshotProvider
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

    // Trust loopback connections (e.g., Vite dev proxy) regardless of Origin header.
    // In dev mode, Vite proxies WebSocket requests from remote clients but the connection
    // arrives from localhost. The original client's Origin header is preserved but may not
    // match the Host header due to changeOrigin, so we skip origin validation for loopback.
    const isLoopback = isLoopbackAddress(remoteAddr)

    if (!isLoopback) {
      // Remote connections must have a valid Origin
      if (!origin) {
        ws.close(CLOSE_CODES.NOT_AUTHENTICATED, 'Origin required')
        return
      }
      const host = req.headers.host as string | undefined
      const hostOrigins = host ? [`http://${host}`, `https://${host}`] : []
      const allowed = isOriginAllowed(origin) || hostOrigins.includes(origin)
      if (!allowed) {
        ws.close(CLOSE_CODES.NOT_AUTHENTICATED, 'Origin not allowed')
        return
      }
    }

    const connectionId = randomUUID()
    ws.connectionId = connectionId
    ws.connectedAt = Date.now()

    const state: ClientState = {
      authenticated: false,
      attachedTerminalIds: new Set(),
      createdByRequestId: new Map(),
      terminalCreateTimestamps: [],
      codingCliSessions: new Set(),
      codingCliSubscriptions: new Map(),
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
    // Detach from any terminals
    for (const terminalId of state.attachedTerminalIds) {
      this.registry.detach(terminalId, ws)
    }
    state.attachedTerminalIds.clear()
    for (const off of state.codingCliSubscriptions.values()) {
      off()
    }
    state.codingCliSubscriptions.clear()

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

  private send(ws: LiveWebSocket, msg: unknown) {
    try {
      // Backpressure guard.
      // @ts-ignore
      const buffered = ws.bufferedAmount as number | undefined
      if (typeof buffered === 'number' && buffered > MAX_WS_BUFFERED_AMOUNT) {
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
        return
      }
      let serialized = ''
      let payloadBytes: number | undefined
      let messageType: string | undefined
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
    } catch {
      // ignore
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

  private scheduleHandshakeSnapshot(ws: LiveWebSocket) {
    if (!this.handshakeSnapshotProvider) return
    setTimeout(() => {
      void this.sendHandshakeSnapshot(ws)
    }, 0)
  }

  private async sendHandshakeSnapshot(ws: LiveWebSocket) {
    if (!this.handshakeSnapshotProvider) return
    try {
      const snapshot = await this.handshakeSnapshotProvider()
      if (snapshot.settings) {
        this.safeSend(ws, { type: 'settings.updated', settings: snapshot.settings })
      }
      if (snapshot.projects) {
        await this.sendChunkedSessions(ws, snapshot.projects)
      }
      if (typeof snapshot.perfLogging === 'boolean') {
        this.safeSend(ws, { type: 'perf.logging', enabled: snapshot.perfLogging })
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to send handshake snapshot')
    }
  }

  /**
   * Send chunked sessions to a single WebSocket client with interleave protection.
   * Uses a generation counter to cancel in-flight sends when a new update arrives.
   */
  private async sendChunkedSessions(ws: LiveWebSocket, projects: ProjectGroup[]): Promise<void> {
    // Increment generation to cancel any in-flight sends for this connection
    const generation = (ws.sessionUpdateGeneration = (ws.sessionUpdateGeneration || 0) + 1)
    const chunks = chunkProjects(projects, MAX_CHUNK_BYTES)

    for (let i = 0; i < chunks.length; i++) {
      // Bail out if connection closed or a newer update has started
      if (ws.readyState !== WebSocket.OPEN) return
      if (ws.sessionUpdateGeneration !== generation) return

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

      // Yield to event loop between chunks to allow other processing
      // This helps prevent blocking and allows the buffer to flush
      if (i < chunks.length - 1) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
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
      if (Array.isArray(data)) payloadBytes = data.reduce((sum, item) => sum + item.length, 0)
      else if (Buffer.isBuffer(data)) payloadBytes = data.length
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
        if (!m.token || m.token !== expected) {
          log.warn({ event: 'ws_auth_failed', connectionId: ws.connectionId }, 'WebSocket auth failed')
          this.sendError(ws, { code: 'NOT_AUTHENTICATED', message: 'Invalid token' })
          ws.close(CLOSE_CODES.NOT_AUTHENTICATED, 'Invalid token')
          return
        }
        state.authenticated = true
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

        this.send(ws, { type: 'ready', timestamp: nowIso() })
        this.scheduleHandshakeSnapshot(ws)
        return
      }

      if (!state.authenticated) {
        this.sendError(ws, { code: 'NOT_AUTHENTICATED', message: 'Send hello first' })
        ws.close(CLOSE_CODES.NOT_AUTHENTICATED, 'Not authenticated')
        return
      }

      switch (m.type) {
      case 'terminal.create': {
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
          const existingId = state.createdByRequestId.get(m.requestId)
          if (existingId) {
            const existing = this.registry.get(existingId)
            if (existing) {
              this.registry.attach(existingId, ws, { pendingSnapshot: true })
              state.attachedTerminalIds.add(existingId)
              terminalId = existingId
              reused = true
              this.send(ws, {
                type: 'terminal.created',
                requestId: m.requestId,
                terminalId: existingId,
                snapshot: existing.buffer.snapshot(),
                createdAt: existing.createdAt,
                effectiveResumeSessionId: existing.resumeSessionId,
              })
              setImmediate(() => this.registry.finishAttachSnapshot(existingId, ws))
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
          // Kick off session repair without blocking terminal creation.
          let effectiveResumeSessionId = m.resumeSessionId
          if (m.mode === 'claude' && effectiveResumeSessionId && !isValidClaudeSessionId(effectiveResumeSessionId)) {
            log.warn({ resumeSessionId: effectiveResumeSessionId, connectionId: ws.connectionId }, 'Ignoring invalid Claude resumeSessionId')
            effectiveResumeSessionId = undefined
          }

          if (m.mode === 'claude' && effectiveResumeSessionId) {
            const existing = this.registry.findRunningClaudeTerminalBySession(effectiveResumeSessionId)
            if (existing) {
              this.registry.attach(existing.terminalId, ws, { pendingSnapshot: true })
              state.attachedTerminalIds.add(existing.terminalId)
              state.createdByRequestId.set(m.requestId, existing.terminalId)
              terminalId = existing.terminalId
              reused = true
              this.send(ws, {
                type: 'terminal.created',
                requestId: m.requestId,
                terminalId: existing.terminalId,
                snapshot: existing.buffer.snapshot(),
                createdAt: existing.createdAt,
                effectiveResumeSessionId: existing.resumeSessionId,
              })
              setImmediate(() => this.registry.finishAttachSnapshot(existing.terminalId, ws))
              this.broadcast({ type: 'terminal.list.updated' })
              return
            }
          }

          // Kick off session repair without blocking terminal creation.
          if (m.mode === 'claude' && effectiveResumeSessionId && this.sessionRepairService) {
            const sessionId = effectiveResumeSessionId
            const cached = this.sessionRepairService.getResult(sessionId)
            if (cached?.status === 'missing') {
              log.info({ sessionId, connectionId: ws.connectionId }, 'Session previously marked missing; resume will start fresh')
              effectiveResumeSessionId = undefined
            } else {
              const endRepairTimer = startPerfTimer(
                'terminal_create_repair_wait',
                { connectionId: ws.connectionId, sessionId },
                { minDurationMs: perfConfig.slowTerminalCreateMs, level: 'warn' },
              )
              void this.sessionRepairService.waitForSession(sessionId, 10000)
                .then((result) => {
                  endRepairTimer({ status: result.status })
                  if (result.status === 'missing') {
                    log.info({ sessionId, connectionId: ws.connectionId }, 'Session file missing; resume may start fresh')
                  }
                })
                .catch((err) => {
                  endRepairTimer({ error: err instanceof Error ? err.message : String(err) })
                  log.debug({ err, sessionId, connectionId: ws.connectionId }, 'Session repair wait failed, proceeding')
                })
            }
          }

          const record = this.registry.create({
            mode: m.mode as TerminalMode,
            shell: m.shell as 'system' | 'cmd' | 'powershell' | 'wsl',
            cwd: m.cwd,
            resumeSessionId: effectiveResumeSessionId,
          })

          state.createdByRequestId.set(m.requestId, record.terminalId)
          terminalId = record.terminalId

          // Attach creator immediately
          this.registry.attach(record.terminalId, ws, { pendingSnapshot: true })
          state.attachedTerminalIds.add(record.terminalId)

          this.send(ws, {
            type: 'terminal.created',
            requestId: m.requestId,
            terminalId: record.terminalId,
            snapshot: record.buffer.snapshot(),
            createdAt: record.createdAt,
            effectiveResumeSessionId,
          })
          setImmediate(() => this.registry.finishAttachSnapshot(record.terminalId, ws))

          // Notify all clients that list changed
          this.broadcast({ type: 'terminal.list.updated' })
        } catch (err: any) {
          error = true
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
        const rec = this.registry.attach(m.terminalId, ws, { pendingSnapshot: true })
        if (!rec) {
          this.sendError(ws, { code: 'INVALID_TERMINAL_ID', message: 'Unknown terminalId', terminalId: m.terminalId })
          return
        }
        state.attachedTerminalIds.add(m.terminalId)
        this.send(ws, { type: 'terminal.attached', terminalId: m.terminalId, snapshot: rec.buffer.snapshot() })
        setImmediate(() => this.registry.finishAttachSnapshot(m.terminalId, ws))
        this.broadcast({ type: 'terminal.list.updated' })
        return
      }

      case 'terminal.detach': {
        const ok = this.registry.detach(m.terminalId, ws)
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
