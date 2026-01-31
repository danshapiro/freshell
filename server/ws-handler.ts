import type http from 'http'
import WebSocket, { WebSocketServer } from 'ws'
import { z } from 'zod'
import { logger } from './logger.js'
import { getRequiredAuthToken, isLoopbackAddress, isOriginAllowed } from './auth.js'
import type { TerminalRegistry, TerminalMode } from './terminal-registry.js'
import { configStore } from './config-store.js'
import type { CodingCliSessionManager } from './coding-cli/session-manager.js'
import type { SessionRepairService } from './session-scanner/service.js'
import type { SessionScanResult, SessionRepairResult } from './session-scanner/types.js'

const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS || 10)
const HELLO_TIMEOUT_MS = Number(process.env.HELLO_TIMEOUT_MS || 5_000)
const PING_INTERVAL_MS = Number(process.env.PING_INTERVAL_MS || 30_000)
const MAX_WS_BUFFERED_AMOUNT = Number(process.env.MAX_WS_BUFFERED_AMOUNT || 2 * 1024 * 1024)

// Extended WebSocket with liveness tracking for keepalive
interface LiveWebSocket extends WebSocket {
  isAlive?: boolean
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
  codingCliSessions: Set<string>
  codingCliSubscriptions: Map<string, () => void>
  interestedSessions: Set<string>
  helloTimer?: NodeJS.Timeout
}

export class WsHandler {
  private wss: WebSocketServer
  private connections = new Set<LiveWebSocket>()
  private clientStates = new Map<LiveWebSocket, ClientState>()
  private pingInterval: NodeJS.Timeout | null = null
  private sessionRepairService?: SessionRepairService
  private sessionRepairListeners?: {
    scanned: (result: SessionScanResult) => void
    repaired: (result: SessionRepairResult) => void
  }

  constructor(
    server: http.Server,
    private registry: TerminalRegistry,
    private codingCliManager?: CodingCliSessionManager,
    sessionRepairService?: SessionRepairService
  ) {
    this.sessionRepairService = sessionRepairService
    this.wss = new WebSocketServer({
      server,
      path: '/ws',
      maxPayload: 1_000_000,
    })

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
      }

      const onRepaired = (result: SessionRepairResult) => {
        this.broadcastSessionStatus(result.sessionId, {
          type: 'session.status',
          sessionId: result.sessionId,
          status: 'repaired',
          chainDepth: result.newChainDepth,
          orphansFixed: result.orphansFixed,
        })
      }

      this.sessionRepairListeners = { scanned: onScanned, repaired: onRepaired }
      this.sessionRepairService.on('scanned', onScanned)
      this.sessionRepairService.on('repaired', onRepaired)
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

    const state: ClientState = {
      authenticated: false,
      attachedTerminalIds: new Set(),
      createdByRequestId: new Map(),
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

    state.helloTimer = setTimeout(() => {
      if (!state.authenticated) {
        ws.close(CLOSE_CODES.HELLO_TIMEOUT, 'Hello timeout')
      }
    }, HELLO_TIMEOUT_MS)

    ws.on('message', (data) => void this.onMessage(ws, state, data))
    ws.on('close', () => this.onClose(ws, state))
    ws.on('error', (err) => logger.debug({ err }, 'WS error'))
  }

  private onClose(ws: LiveWebSocket, state: ClientState) {
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
        ws.close(CLOSE_CODES.BACKPRESSURE, 'Backpressure')
        return
      }
      ws.send(JSON.stringify(msg))
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

  private async onMessage(ws: LiveWebSocket, state: ClientState, data: WebSocket.RawData) {
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

    if (m.type === 'ping') {
      // Respond to confirm liveness.
      this.send(ws, { type: 'pong', timestamp: nowIso() })
      return
    }

    if (m.type === 'hello') {
      const expected = getRequiredAuthToken()
      if (!m.token || m.token !== expected) {
        this.sendError(ws, { code: 'NOT_AUTHENTICATED', message: 'Invalid token' })
        ws.close(CLOSE_CODES.NOT_AUTHENTICATED, 'Invalid token')
        return
      }
      state.authenticated = true
      if (state.helloTimer) clearTimeout(state.helloTimer)

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
      return
    }

    if (!state.authenticated) {
      this.sendError(ws, { code: 'NOT_AUTHENTICATED', message: 'Send hello first' })
      ws.close(CLOSE_CODES.NOT_AUTHENTICATED, 'Not authenticated')
      return
    }

    switch (m.type) {
      case 'terminal.create': {
        try {
          const existingId = state.createdByRequestId.get(m.requestId)
          if (existingId) {
            const existing = this.registry.get(existingId)
            if (existing) {
              this.registry.attach(existingId, ws)
              state.attachedTerminalIds.add(existingId)
              this.send(ws, { type: 'terminal.created', requestId: m.requestId, terminalId: existingId, snapshot: existing.buffer.snapshot(), createdAt: existing.createdAt })
              return
            }
            // If it no longer exists, fall through and create a new one.
            state.createdByRequestId.delete(m.requestId)
          }

          // Wait for session repair before resuming Claude
          let effectiveResumeSessionId = m.resumeSessionId
          if (m.mode === 'claude' && m.resumeSessionId && this.sessionRepairService) {
            try {
              const result = await this.sessionRepairService.waitForSession(m.resumeSessionId, 10000)
              if (result.status === 'missing') {
                // Session file doesn't exist - don't try to resume
                logger.info({ sessionId: m.resumeSessionId }, 'Session file missing, starting fresh')
                effectiveResumeSessionId = undefined
              }
              // For 'healthy', 'corrupted' (which is now repaired), we proceed with resume
            } catch (err) {
              // Timeout or not in queue - proceed anyway, Claude will handle missing session
              logger.debug({ err, sessionId: m.resumeSessionId }, 'Session repair wait failed, proceeding')
            }
          }

          const record = this.registry.create({
            mode: m.mode as TerminalMode,
            shell: m.shell as 'system' | 'cmd' | 'powershell' | 'wsl',
            cwd: m.cwd,
            resumeSessionId: effectiveResumeSessionId,
          })

          state.createdByRequestId.set(m.requestId, record.terminalId)

          // Attach creator immediately
          this.registry.attach(record.terminalId, ws)
          state.attachedTerminalIds.add(record.terminalId)

          this.send(ws, {
            type: 'terminal.created',
            requestId: m.requestId,
            terminalId: record.terminalId,
            snapshot: record.buffer.snapshot(),
            createdAt: record.createdAt,
          })

          // Notify all clients that list changed
          this.broadcast({ type: 'terminal.list.updated' })
        } catch (err: any) {
          logger.warn({ err }, 'terminal.create failed')
          this.sendError(ws, {
            code: 'PTY_SPAWN_FAILED',
            message: err?.message || 'Failed to spawn PTY',
            requestId: m.requestId,
          })
        }
        return
      }

      case 'terminal.attach': {
        const rec = this.registry.attach(m.terminalId, ws)
        if (!rec) {
          this.sendError(ws, { code: 'INVALID_TERMINAL_ID', message: 'Unknown terminalId', terminalId: m.terminalId })
          return
        }
        state.attachedTerminalIds.add(m.terminalId)
        this.send(ws, { type: 'terminal.attached', terminalId: m.terminalId, snapshot: rec.buffer.snapshot() })
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
          logger.warn({ err }, 'codingcli.create failed')
          this.sendError(ws, {
            code: 'INTERNAL_ERROR',
            message: err?.message || 'Failed to create coding CLI session',
            requestId: m.requestId,
          })
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
  }

  broadcast(msg: unknown) {
    for (const ws of this.connections) {
      if (ws.readyState === WebSocket.OPEN) {
        this.send(ws, msg)
      }
    }
  }

  /**
   * Gracefully close all WebSocket connections and the server.
   */
  close(): void {
    if (this.sessionRepairService && this.sessionRepairListeners) {
      this.sessionRepairService.off('scanned', this.sessionRepairListeners.scanned)
      this.sessionRepairService.off('repaired', this.sessionRepairListeners.repaired)
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

    logger.info('WebSocket server closed')
  }
}

async function awaitConfig() {
  return await configStore.snapshot()
}
