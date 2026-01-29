import type http from 'http'
import WebSocket, { WebSocketServer } from 'ws'
import { z } from 'zod'
import { logger } from './logger'
import { getRequiredAuthToken, isLoopbackAddress, isOriginAllowed } from './auth'
import type { TerminalRegistry, TerminalMode } from './terminal-registry'
import { configStore } from './config-store'

const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS || 10)
const HELLO_TIMEOUT_MS = Number(process.env.HELLO_TIMEOUT_MS || 5_000)

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
})

const PingSchema = z.object({
  type: z.literal('ping'),
})

const ShellSchema = z.enum(['system', 'cmd', 'powershell', 'wsl'])

const TerminalCreateSchema = z.object({
  type: z.literal('terminal.create'),
  requestId: z.string().min(1),
  mode: z.enum(['shell', 'claude', 'codex']).default('shell'),
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
])

type ClientState = {
  authenticated: boolean
  attachedTerminalIds: Set<string>
  createdByRequestId: Map<string, string>
  helloTimer?: NodeJS.Timeout
}

export class WsHandler {
  private wss: WebSocketServer
  private connections = new Set<WebSocket>()

  constructor(server: http.Server, private registry: TerminalRegistry) {
    this.wss = new WebSocketServer({
      server,
      path: '/ws',
      maxPayload: 1_000_000,
    })

    this.wss.on('connection', (ws, req) => this.onConnection(ws, req))
  }

  getServer() {
    return this.wss
  }

  connectionCount() {
    return this.connections.size
  }

  private onConnection(ws: WebSocket, req: http.IncomingMessage) {
    if (this.connections.size >= MAX_CONNECTIONS) {
      ws.close(CLOSE_CODES.MAX_CONNECTIONS, 'Too many connections')
      return
    }

    const origin = req.headers.origin as string | undefined
    const remoteAddr = (req.socket.remoteAddress as string | undefined) || undefined

    // In dev/prod, browsers will set Origin. If missing, only allow loopback clients.
    if (origin) {
      const host = req.headers.host as string | undefined
      const hostOrigins = host ? [`http://${host}`, `https://${host}`] : []
      const allowed = isOriginAllowed(origin) || hostOrigins.includes(origin)
      if (!allowed) {
        ws.close(CLOSE_CODES.NOT_AUTHENTICATED, 'Origin not allowed')
        return
      }
    } else if (!isLoopbackAddress(remoteAddr)) {
      ws.close(CLOSE_CODES.NOT_AUTHENTICATED, 'Origin required')
      return
    }

    const state: ClientState = {
      authenticated: false,
      attachedTerminalIds: new Set(),
      createdByRequestId: new Map(),
    }

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

  private onClose(ws: WebSocket, state: ClientState) {
    if (state.helloTimer) clearTimeout(state.helloTimer)
    this.connections.delete(ws)
    // Detach from any terminals
    for (const terminalId of state.attachedTerminalIds) {
      this.registry.detach(terminalId, ws)
    }
    state.attachedTerminalIds.clear()
  }

  private send(ws: WebSocket, msg: unknown) {
    try {
      ws.send(JSON.stringify(msg))
    } catch {
      // ignore
    }
  }

  private sendError(ws: WebSocket, params: { code: z.infer<typeof ErrorCode>; message: string; requestId?: string }) {
    this.send(ws, {
      type: 'error',
      code: params.code,
      message: params.message,
      requestId: params.requestId,
      timestamp: nowIso(),
    })
  }

  private async onMessage(ws: WebSocket, state: ClientState, data: WebSocket.RawData) {
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

          const record = this.registry.create({
            mode: m.mode as TerminalMode,
            shell: m.shell as 'system' | 'cmd' | 'powershell' | 'wsl',
            cwd: m.cwd,
            resumeSessionId: m.resumeSessionId,
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
          this.sendError(ws, { code: 'INVALID_TERMINAL_ID', message: 'Unknown terminalId' })
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
          this.sendError(ws, { code: 'INVALID_TERMINAL_ID', message: 'Unknown terminalId' })
          return
        }
        this.send(ws, { type: 'terminal.detached', terminalId: m.terminalId })
        this.broadcast({ type: 'terminal.list.updated' })
        return
      }

      case 'terminal.input': {
        const ok = this.registry.input(m.terminalId, m.data)
        if (!ok) {
          this.sendError(ws, { code: 'INVALID_TERMINAL_ID', message: 'Terminal not running' })
        }
        return
      }

      case 'terminal.resize': {
        const ok = this.registry.resize(m.terminalId, m.cols, m.rows)
        if (!ok) {
          this.sendError(ws, { code: 'INVALID_TERMINAL_ID', message: 'Terminal not running' })
        }
        return
      }

      case 'terminal.kill': {
        const ok = this.registry.kill(m.terminalId)
        if (!ok) {
          this.sendError(ws, { code: 'INVALID_TERMINAL_ID', message: 'Unknown terminalId' })
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
