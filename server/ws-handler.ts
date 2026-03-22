import type http from 'http'
import { randomUUID } from 'crypto'
import WebSocket, { WebSocketServer } from 'ws'
import { z } from 'zod'
import { logger } from './logger.js'
import { getPerfConfig, logPerfEvent, shouldLog, startPerfTimer } from './perf-logger.js'
import { getRequiredAuthToken, isLoopbackAddress, isOriginAllowed, timingSafeCompare } from './auth.js'
import { modeSupportsResume } from './terminal-registry.js'
import type { TerminalRegistry, TerminalMode } from './terminal-registry.js'
import { configStore, type ConfigReadError } from './config-store.js'
import type { CodingCliSessionManager } from './coding-cli/session-manager.js'
import type { ProjectGroup } from './coding-cli/types.js'
import type { TerminalMeta } from './terminal-metadata-service.js'
import type { SessionRepairService } from './session-scanner/service.js'
import type { SessionScanResult, SessionRepairResult } from './session-scanner/types.js'
import { isValidClaudeSessionId } from './claude-session-id.js'
import type { SdkBridge } from './sdk-bridge.js'
import type { CodexActivityRecord, SdkServerMessage } from '../shared/ws-protocol.js'
import type { ExtensionManager } from './extension-manager.js'
import { TerminalStreamBroker } from './terminal-stream/broker.js'
import { buildSidebarOpenSessionKeys, type SidebarSessionLocator } from './sidebar-session-selection.js'
import { loadSessionHistory, type ChatMessage } from './session-history-loader.js'
import { TabRegistryRecordBaseSchema, TabRegistryRecordSchema } from './tabs-registry/types.js'
import type { TabsRegistryStore } from './tabs-registry/store.js'
import type { ServerSettings } from '../shared/settings.js'
import {
  ErrorCode,
  ShellSchema,
  CodingCliProviderSchema,
  TerminalMetaUpdatedSchema,
  CodexActivityListResponseSchema,
  CodexActivityListSchema,
  CodexActivityUpdatedSchema,
  HelloSchema,
  PingSchema,
  TerminalAttachSchema,
  TerminalDetachSchema,
  TerminalInputSchema,
  TerminalResizeSchema,
  TerminalKillSchema,
  CodingCliInputSchema,
  CodingCliKillSchema,
  SdkCreateSchema,
  SdkSendSchema,
  SdkPermissionRespondSchema,
  SdkQuestionRespondSchema,
  SdkInterruptSchema,
  SdkKillSchema,
  SdkAttachSchema,
  SdkSetModelSchema,
  SdkSetPermissionModeSchema,
  UiScreenshotResultSchema,
  WS_PROTOCOL_VERSION,
} from '../shared/ws-protocol.js'
import { UiLayoutSyncSchema } from './agent-api/layout-schema.js'
import type { LayoutStore } from './agent-api/layout-store.js'

type WsHandlerConfig = {
  maxConnections: number
  helloTimeoutMs: number
  pingIntervalMs: number
  maxWsBufferedAmount: number
  wsMaxPayloadBytes: number
  maxScreenshotBase64Bytes: number
  maxRegularWsMessageBytes: number
  maxChunkBytes: number
  drainThresholdBytes: number
  drainTimeoutMs: number
  terminalCreateRateLimit: number
  terminalCreateRateWindowMs: number
}

function readWsHandlerConfig(): WsHandlerConfig {
  // Use ?? so only unset vars fall back; preserves explicit MAX_REGULAR_WS_MESSAGE_BYTES values.
  const regularWsMessageBytesEnv = process.env.MAX_REGULAR_WS_MESSAGE_BYTES ?? process.env.DEFAULT_WS_MESSAGE_BYTES
  return {
    maxConnections: Number(process.env.MAX_CONNECTIONS || 50),
    helloTimeoutMs: Number(process.env.HELLO_TIMEOUT_MS || 5_000),
    pingIntervalMs: Number(process.env.PING_INTERVAL_MS || 30_000),
    maxWsBufferedAmount: Number(process.env.MAX_WS_BUFFERED_AMOUNT || 2 * 1024 * 1024),
    wsMaxPayloadBytes: Number(process.env.WS_MAX_PAYLOAD_BYTES || 16 * 1024 * 1024),
    maxScreenshotBase64Bytes: Number(process.env.MAX_SCREENSHOT_BASE64_BYTES || 12 * 1024 * 1024),
    maxRegularWsMessageBytes: Number(regularWsMessageBytesEnv ?? 1 * 1024 * 1024),
    maxChunkBytes: Number(process.env.MAX_WS_CHUNK_BYTES || 500 * 1024),
    drainThresholdBytes: Number(process.env.WS_DRAIN_THRESHOLD_BYTES || 512 * 1024),
    drainTimeoutMs: Number(process.env.WS_DRAIN_TIMEOUT_MS || 30_000),
    terminalCreateRateLimit: Number(process.env.TERMINAL_CREATE_RATE_LIMIT || 10),
    terminalCreateRateWindowMs: Number(process.env.TERMINAL_CREATE_RATE_WINDOW_MS || 10_000),
  }
}
const DRAIN_POLL_INTERVAL_MS = 50
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

function sameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) {
    if (!b.has(value)) return false
  }
  return true
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizeUiSessionLocator(value: unknown): SidebarSessionLocator | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as {
    provider?: unknown
    sessionId?: unknown
    serverInstanceId?: unknown
  }
  const provider = CodingCliProviderSchema.safeParse(candidate.provider)
  if (!provider.success || !isNonEmptyString(candidate.sessionId)) return undefined
  return {
    provider: provider.data,
    sessionId: candidate.sessionId,
    ...(isNonEmptyString(candidate.serverInstanceId)
      ? { serverInstanceId: candidate.serverInstanceId }
      : {}),
  }
}

function extractSessionLocatorsFromUiContent(content: Record<string, unknown>): SidebarSessionLocator[] {
  const locators: SidebarSessionLocator[] = []

  const explicit = normalizeUiSessionLocator(content.sessionRef)
  if (explicit) {
    locators.push(explicit)
  }

  const kind = content.kind
  if (kind === 'agent-chat') {
    if (isNonEmptyString(content.resumeSessionId)) {
      locators.push({ provider: 'claude', sessionId: content.resumeSessionId })
    }
    return locators
  }

  if (kind !== 'terminal') return locators

  const mode = CodingCliProviderSchema.safeParse(content.mode)
  if (!mode.success || !isNonEmptyString(content.resumeSessionId)) {
    return locators
  }

  locators.push({
    provider: mode.data,
    sessionId: content.resumeSessionId,
  })
  return locators
}

function collectSessionLocatorsFromUiLayoutNode(node: unknown, locators: SidebarSessionLocator[]): void {
  if (!node || typeof node !== 'object') return
  const candidate = node as {
    type?: unknown
    content?: unknown
    children?: unknown
  }

  if (candidate.type === 'leaf' && candidate.content && typeof candidate.content === 'object') {
    locators.push(...extractSessionLocatorsFromUiContent(candidate.content as Record<string, unknown>))
    return
  }

  if (candidate.type !== 'split' || !Array.isArray(candidate.children)) return
  for (const child of candidate.children) {
    collectSessionLocatorsFromUiLayoutNode(child, locators)
  }
}

function collectSessionLocatorsFromUiLayouts(layouts: Record<string, unknown>): SidebarSessionLocator[] {
  const locators: SidebarSessionLocator[] = []
  for (const node of Object.values(layouts)) {
    collectSessionLocatorsFromUiLayoutNode(node, locators)
  }
  return locators
}

function collectFallbackSessionLocatorsFromUiTabs(
  tabs: Array<{ id: string; fallbackSessionRef?: SidebarSessionLocator }>,
  layouts: Record<string, unknown>,
): SidebarSessionLocator[] {
  const locators: SidebarSessionLocator[] = []
  for (const tab of tabs) {
    if (layouts[tab.id] != null) continue
    const fallback = normalizeUiSessionLocator(tab.fallbackSessionRef)
    if (fallback) {
      locators.push(fallback)
    }
  }
  return locators
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

type ClientState = {
  authenticated: boolean
  supportsUiScreenshotV1: boolean
  attachedTerminalIds: Set<string>
  createdByRequestId: Map<string, string>
  terminalCreateTimestamps: number[]
  codingCliSessions: Set<string>
  codingCliSubscriptions: Map<string, () => void>
  sdkSessions: Set<string>
  sdkSubscriptions: Map<string, () => void>
  interestedSessions: Set<string>
  sidebarOpenSessionKeys: Set<string>
  helloTimer?: NodeJS.Timeout
}

type HandshakeSnapshot = {
  settings?: ServerSettings
  projects?: ProjectGroup[]
  perfLogging?: boolean
  configFallback?: {
    reason: ConfigReadError
    backupExists: boolean
  }
}

type HandshakeSnapshotProvider = () => Promise<HandshakeSnapshot>

type PendingScreenshot = {
  resolve: (result: z.infer<typeof UiScreenshotResultSchema>) => void
  reject: (err: Error) => void
  timeout: NodeJS.Timeout
  connectionId?: string
}

type ScreenshotErrorCode = 'NO_SCREENSHOT_CLIENT' | 'SCREENSHOT_TIMEOUT' | 'SCREENSHOT_CONNECTION_CLOSED'

function createScreenshotError(code: ScreenshotErrorCode, message: string): Error & { code: ScreenshotErrorCode } {
  const err = new Error(message) as Error & { code: ScreenshotErrorCode }
  err.code = code
  return err
}

export class WsHandler {
  private readonly config: WsHandlerConfig
  private readonly authToken: string
  private wss: WebSocketServer
  private connections = new Set<LiveWebSocket>()
  private clientStates = new Map<LiveWebSocket, ClientState>()
  private pingInterval: NodeJS.Timeout | null = null
  private closed = false
  private sessionRepairService?: SessionRepairService
  private handshakeSnapshotProvider?: HandshakeSnapshotProvider
  private terminalMetaListProvider?: () => TerminalMeta[]
  private codexActivityListProvider?: () => CodexActivityRecord[]
  private tabsRegistryStore?: TabsRegistryStore
  private layoutStore?: LayoutStore
  private extensionManager?: ExtensionManager
  private terminalStreamBroker: TerminalStreamBroker
  private terminalCreateLocks = new Map<string, Promise<void>>()
  private createdTerminalByRequestId = new Map<string, string>()
  private screenshotRequests = new Map<string, PendingScreenshot>()
  private sessionsRevision = 0
  private terminalsRevision = 0
  private terminalRuntimeRevisions = new Map<string, number>()
  private readonly serverInstanceId: string
  // The runtime validator is authoritative here; we keep the field typed broadly because
  // the dynamic provider schemas widen discriminated-union inference beyond what TS/Zod model well.
  private clientMessageSchema: z.ZodTypeAny
  private onTerminalExitBound = (payload: { terminalId?: string }) => {
    if (!payload?.terminalId) return
    this.forgetCreatedRequestIdsForTerminal(payload.terminalId)
  }
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
    layoutStore?: LayoutStore,
    extensionManager?: ExtensionManager,
    codexActivityListProvider?: () => CodexActivityRecord[],
  ) {
    this.config = readWsHandlerConfig()
    this.authToken = getRequiredAuthToken()
    this.sessionRepairService = sessionRepairService
    this.handshakeSnapshotProvider = handshakeSnapshotProvider
    this.terminalMetaListProvider = terminalMetaListProvider
    this.codexActivityListProvider = codexActivityListProvider
    this.tabsRegistryStore = tabsRegistryStore
    this.layoutStore = layoutStore
    this.extensionManager = extensionManager
    this.serverInstanceId = serverInstanceId && serverInstanceId.trim().length > 0
      ? serverInstanceId
      : `srv-${randomUUID()}`
    this.terminalStreamBroker = new TerminalStreamBroker(this.registry)

    // Build the set of valid CLI provider/mode names from extensions
    const canEnumerateCliExtensions = typeof extensionManager?.getAll === 'function'
    const extensionModes = canEnumerateCliExtensions
      ? extensionManager.getAll()
          .filter(e => e.manifest.category === 'cli')
          .map(e => e.manifest.name)
      : []
    const allModes = new Set<string>(['shell', ...extensionModes])

    // Build dynamic schemas for the two process-spawning messages.
    // All other schemas (SessionLocatorSchema, TerminalMetaRecordSchema, etc.)
    // already accept any string via the widened CodingCliProviderSchema.
    const dynamicTerminalCreateSchema = z.object({
      type: z.literal('terminal.create'),
      requestId: z.string().min(1),
      mode: z.string().min(1).default('shell').superRefine((val, ctx) => {
        if (!canEnumerateCliExtensions || allModes.has(val)) return
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid terminal mode: '${val}'. Valid: ${[...allModes].join(', ')}`,
        })
      }),
      shell: ShellSchema.default('system'),
      cwd: z.string().optional(),
      resumeSessionId: z.string().optional(),
      restore: z.boolean().optional(),
      tabId: z.string().min(1).optional(),
      paneId: z.string().min(1).optional(),
    })

    const dynamicProviderSchema = CodingCliProviderSchema.superRefine((val, ctx) => {
      if (!canEnumerateCliExtensions || extensionModes.includes(val)) return
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown CLI provider: '${val}'`,
      })
    })

    const dynamicCodingCliCreateSchema = z.object({
      type: z.literal('codingcli.create'),
      requestId: z.string().min(1),
      provider: dynamicProviderSchema,
      prompt: z.string().min(1),
      cwd: z.string().optional(),
      resumeSessionId: z.string().optional(),
      model: z.string().optional(),
      maxTurns: z.number().int().positive().optional(),
      permissionMode: z.enum(['default', 'plan', 'acceptEdits', 'bypassPermissions']).optional(),
      sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
    })

    this.clientMessageSchema = z.discriminatedUnion('type', [
      HelloSchema,
      PingSchema,
      dynamicTerminalCreateSchema,
      TerminalAttachSchema,
      TerminalDetachSchema,
      TerminalInputSchema,
      TerminalResizeSchema,
      TerminalKillSchema,
      CodexActivityListSchema,
      TabsSyncPushSchema,
      TabsSyncQuerySchema,
      dynamicCodingCliCreateSchema,
      CodingCliInputSchema,
      CodingCliKillSchema,
      SdkCreateSchema,
      SdkSendSchema,
      SdkPermissionRespondSchema,
      SdkQuestionRespondSchema,
      SdkInterruptSchema,
      SdkKillSchema,
      SdkAttachSchema,
      SdkSetModelSchema,
      SdkSetPermissionModeSchema,
      UiLayoutSyncSchema,
      UiScreenshotResultSchema,
    ])
    const registryWithEvents = this.registry as unknown as {
      on?: (event: string, listener: (...args: any[]) => void) => void
    }
    registryWithEvents.on?.('terminal.exit', this.onTerminalExitBound)
    this.wss = new WebSocketServer({
      server,
      path: '/ws',
      maxPayload: this.config.wsMaxPayloadBytes,
      perMessageDeflate: {
        zlibDeflateOptions: { level: 1 },
        threshold: 1024,
        serverNoContextTakeover: true,
        clientNoContextTakeover: true,
      },
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
    }, this.config.pingIntervalMs)

    // Subscribe to session repair events
    if (this.sessionRepairService) {
      const onScanned = (result: SessionScanResult) => {
        this.broadcastSessionStatus(result.sessionId, {
          type: 'session.status',
          sessionId: result.sessionId,
          status: result.status === 'healthy' ? 'healthy' : 'corrupted',
          chainDepth: result.chainDepth,
        })

        this.broadcastSessionRepairActivity(result.sessionId, {
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

        this.broadcastSessionRepairActivity(result.sessionId, {
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
        this.broadcastSessionRepairActivity(sessionId, {
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

  private broadcastSessionRepairActivity(sessionId: string, msg: unknown): void {
    for (const [ws, state] of this.clientStates) {
      if (!state.authenticated || !state.interestedSessions.has(sessionId)) {
        continue
      }
      if (ws.readyState === WebSocket.OPEN) {
        this.send(ws, msg)
      }
    }
  }

  getServer() {
    return this.wss
  }

  connectionCount() {
    return this.connections.size
  }

  private rememberCreatedRequestId(requestId: string, terminalId: string): void {
    this.createdTerminalByRequestId.set(requestId, terminalId)
  }

  private forgetCreatedRequestId(requestId: string): void {
    this.createdTerminalByRequestId.delete(requestId)
  }

  private forgetCreatedRequestIdsForTerminal(terminalId: string): void {
    for (const [requestId, cachedTerminalId] of this.createdTerminalByRequestId) {
      if (cachedTerminalId === terminalId) {
        this.createdTerminalByRequestId.delete(requestId)
      }
    }
  }

  private resolveCreatedTerminalId(requestId: string): string | undefined {
    const cached = this.createdTerminalByRequestId.get(requestId)
    if (!cached) return undefined
    const record = this.registry.get(cached)
    if (!record) {
      this.createdTerminalByRequestId.delete(requestId)
      return undefined
    }
    return cached
  }

  private terminalCreateLockKey(
    mode: TerminalMode,
    requestId: string,
    resumeSessionId?: string,
  ): string {
    if (modeSupportsResume(mode) && resumeSessionId) {
      return `session:${mode}:${resumeSessionId}`
    }
    return `request:${requestId}`
  }

  private withTerminalCreateLock(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.terminalCreateLocks.get(key) ?? Promise.resolve()

    let current: Promise<void>
    current = previous
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        if (this.terminalCreateLocks.get(key) === current) {
          this.terminalCreateLocks.delete(key)
        }
      })

    this.terminalCreateLocks.set(key, current)
    return current
  }

  private findTargetUiSocket(
    preferredConnectionId?: string,
    opts?: { requireScreenshotCapability?: boolean },
  ): LiveWebSocket | undefined {
    const authenticated = [...this.connections].filter((conn) => {
      if (conn.readyState !== WebSocket.OPEN) return false
      const state = this.clientStates.get(conn)
      if (!state?.authenticated) return false
      if (opts?.requireScreenshotCapability && !state.supportsUiScreenshotV1) return false
      return true
    })
    if (!authenticated.length) return undefined

    if (preferredConnectionId) {
      const preferred = authenticated.find((conn) => conn.connectionId === preferredConnectionId)
      if (preferred) return preferred
    }

    return authenticated.reduce<LiveWebSocket | undefined>((latest, conn) => {
      if (!latest) return conn
      const latestConnectedAt = latest.connectedAt ?? 0
      const candidateConnectedAt = conn.connectedAt ?? 0
      return candidateConnectedAt >= latestConnectedAt ? conn : latest
    }, undefined)
  }

  public requestUiScreenshot(opts: {
    scope: 'pane' | 'tab' | 'view'
    tabId?: string
    paneId?: string
    timeoutMs?: number
  }): Promise<z.infer<typeof UiScreenshotResultSchema>> {
    const timeoutMs = opts.timeoutMs ?? 10_000
    const preferredConnectionId = this.layoutStore?.getSourceConnectionId() || undefined
    const targetWs = this.findTargetUiSocket(preferredConnectionId, { requireScreenshotCapability: true })
    if (!targetWs) {
      return Promise.reject(createScreenshotError('NO_SCREENSHOT_CLIENT', 'No screenshot-capable UI client connected'))
    }

    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.screenshotRequests.delete(requestId)
        reject(createScreenshotError('SCREENSHOT_TIMEOUT', 'Timed out waiting for UI screenshot response'))
      }, timeoutMs)

      this.screenshotRequests.set(requestId, {
        resolve,
        reject,
        timeout,
        connectionId: targetWs.connectionId,
      })

      this.send(targetWs, {
        type: 'ui.command',
        command: 'screenshot.capture',
        payload: {
          requestId,
          scope: opts.scope,
          tabId: opts.tabId,
          paneId: opts.paneId,
        },
      })
    })
  }

  private onConnection(ws: LiveWebSocket, req: http.IncomingMessage) {
    if (this.connections.size >= this.config.maxConnections) {
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
      supportsUiScreenshotV1: false,
      attachedTerminalIds: new Set(),
      createdByRequestId: new Map(),
      terminalCreateTimestamps: [],
      codingCliSessions: new Set(),
      codingCliSubscriptions: new Map(),
      sdkSessions: new Set(),
      sdkSubscriptions: new Map(),
      interestedSessions: new Set(),
      sidebarOpenSessionKeys: new Set(),
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
    }, this.config.helloTimeoutMs)

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

    for (const [requestId, pending] of this.screenshotRequests) {
      if (pending.connectionId !== ws.connectionId) continue
      clearTimeout(pending.timeout)
      this.screenshotRequests.delete(requestId)
      pending.reject(createScreenshotError('SCREENSHOT_CONNECTION_CLOSED', 'UI connection closed before screenshot response'))
    }

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
    if (typeof buffered !== 'number' || buffered <= this.config.maxWsBufferedAmount) return false

    if (perfConfig.enabled && shouldLog(`ws_backpressure_${ws.connectionId || 'unknown'}`, perfConfig.rateLimitMs)) {
      logPerfEvent(
        'ws_backpressure_close',
        {
          connectionId: ws.connectionId,
          bufferedBytes: buffered,
          limitBytes: this.config.maxWsBufferedAmount,
        },
        'warn',
      )
    }
    ws.close(CLOSE_CODES.BACKPRESSURE, 'Backpressure')
    return true
  }

  private send(ws: LiveWebSocket, msg: unknown, skipBackpressureCheck = false) {
    let messageType: string | undefined
    try {
      // Backpressure guard (skipped for pre-drained chunked sends).
      const buffered = ws.bufferedAmount as number | undefined
      if (!skipBackpressureCheck && this.closeForBackpressureIfNeeded(ws, buffered)) return
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

  private safeSend(ws: LiveWebSocket, msg: unknown, skipBackpressureCheck = false) {
    if (ws.readyState === WebSocket.OPEN) {
      this.send(ws, msg, skipBackpressureCheck)
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
  private async onMessage(ws: LiveWebSocket, state: ClientState, data: WebSocket.RawData) {
    const endMessageTimer = startPerfTimer(
      'ws_message',
      { connectionId: ws.connectionId },
      { minDurationMs: perfConfig.wsSlowMs, level: 'warn' },
    )
    let messageType: string | undefined
    let payloadBytes: number | undefined
    const rawBytes = Buffer.isBuffer(data)
      ? data.length
      : Array.isArray(data)
        ? data.reduce((sum, item) => sum + item.length, 0)
        : data instanceof ArrayBuffer
          ? data.byteLength
          : Buffer.byteLength(String(data))
    if (perfConfig.enabled) payloadBytes = rawBytes

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

      const parsed = this.clientMessageSchema.safeParse(msg)
      if (!parsed.success) {
        this.sendError(ws, { code: 'INVALID_MESSAGE', message: parsed.error.message, requestId: msg?.requestId })
        return
      }

      // Runtime schema validation already succeeded above; TS cannot preserve the narrowed
      // discriminated union once provider names become dynamic, so we cast once at the boundary.
      const m = parsed.data as any
      messageType = m.type

      if (rawBytes > this.config.maxRegularWsMessageBytes && m.type !== 'ui.screenshot.result') {
        ws.close(1009, 'Message too large')
        return
      }

      if (m.type === 'ping') {
        // Respond to confirm liveness.
        this.send(ws, { type: 'pong', timestamp: nowIso() })
        return
      }

      if (m.type === 'hello') {
        if (!m.token || !timingSafeCompare(m.token, this.authToken)) {
          log.warn({ event: 'ws_auth_failed', connectionId: ws.connectionId }, 'WebSocket auth failed')
          this.sendError(ws, { code: 'NOT_AUTHENTICATED', message: 'Invalid token' })
          ws.close(CLOSE_CODES.NOT_AUTHENTICATED, 'Invalid token')
          return
        }
        state.authenticated = true
        state.supportsUiScreenshotV1 = !!m.capabilities?.uiScreenshotV1
        state.sidebarOpenSessionKeys = buildSidebarOpenSessionKeys(
          m.sidebarOpenSessions ?? [],
          this.serverInstanceId,
        )
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

        this.send(ws, {
          type: 'ready',
          timestamp: nowIso(),
          serverInstanceId: this.serverInstanceId,
        })
        this.scheduleHandshakeSnapshot(ws, state)
        return
      }

      if (!state.authenticated) {
        this.sendError(ws, { code: 'NOT_AUTHENTICATED', message: 'Send hello first' })
        ws.close(CLOSE_CODES.NOT_AUTHENTICATED, 'Not authenticated')
        return
      }

      switch (m.type) {
      case 'ui.screenshot.result': {
        const pending = this.screenshotRequests.get(m.requestId)
        if (!pending) return
        if (pending.connectionId && pending.connectionId !== ws.connectionId) return

        if (typeof m.imageBase64 === 'string' && m.imageBase64.length > this.config.maxScreenshotBase64Bytes) {
          clearTimeout(pending.timeout)
          this.screenshotRequests.delete(m.requestId)
          pending.reject(new Error('Screenshot payload too large'))
          return
        }

        clearTimeout(pending.timeout)
        this.screenshotRequests.delete(m.requestId)
        pending.resolve(m)
        return
      }
      case 'ui.layout.sync': {
        if (this.layoutStore) {
          this.layoutStore.updateFromUi(m, ws.connectionId || 'unknown')
        }
        const nextSidebarOpenSessionKeys = buildSidebarOpenSessionKeys(
          [
            ...collectSessionLocatorsFromUiLayouts(m.layouts),
            ...collectFallbackSessionLocatorsFromUiTabs(m.tabs, m.layouts),
          ],
          this.serverInstanceId,
        )
        if (!sameStringSet(state.sidebarOpenSessionKeys, nextSidebarOpenSessionKeys)) {
          state.sidebarOpenSessionKeys = nextSidebarOpenSessionKeys
        }
        return
      }
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
        let effectiveResumeSessionId = m.resumeSessionId
        try {
          await this.withTerminalCreateLock(
            this.terminalCreateLockKey(m.mode as TerminalMode, m.requestId, effectiveResumeSessionId),
            async () => {
              const resolveExistingRequestTerminalId = (requestId: string): string | undefined => {
                const local = state.createdByRequestId.get(requestId)
                if (local === REPAIR_PENDING_SENTINEL) return REPAIR_PENDING_SENTINEL
                if (local) return local
                const cached = this.resolveCreatedTerminalId(requestId)
                if (cached) {
                  state.createdByRequestId.set(requestId, cached)
                }
                return cached
              }

              const sendCreateResult = async (opts: {
                ws: LiveWebSocket
                requestId: string
                terminalId: string
                createdAt: number
                effectiveResumeSessionId?: string
              }): Promise<boolean> => {
                if (opts.ws.readyState !== WebSocket.OPEN) {
                  return false
                }

                this.send(opts.ws, {
                  type: 'terminal.created',
                  requestId: opts.requestId,
                  terminalId: opts.terminalId,
                  createdAt: opts.createdAt,
                  ...(opts.effectiveResumeSessionId ? { effectiveResumeSessionId: opts.effectiveResumeSessionId } : {}),
                })
                return true
              }

              const attachReusedTerminal = async (
                reusedTerminalId: string,
                createdAt: number,
                resumeSessionId?: string,
              ): Promise<boolean> => {
                const sent = await sendCreateResult({
                  ws,
                  requestId: m.requestId,
                  terminalId: reusedTerminalId,
                  createdAt,
                  effectiveResumeSessionId: resumeSessionId,
                })
                if (!sent) {
                  return false
                }
                state.createdByRequestId.set(m.requestId, reusedTerminalId)
                this.rememberCreatedRequestId(m.requestId, reusedTerminalId)
                terminalId = reusedTerminalId
                reused = true
                this.broadcastTerminalsChanged()
                return true
              }

              const existingId = resolveExistingRequestTerminalId(m.requestId)
              if (existingId) {
                if (existingId === REPAIR_PENDING_SENTINEL) {
                  log.debug({ requestId: m.requestId, connectionId: ws.connectionId },
                    'terminal.create already in progress (repair pending), ignoring duplicate')
                  return
                }
                const existing = this.registry.get(existingId)
                if (existing) {
                  await attachReusedTerminal(existing.terminalId, existing.createdAt, existing.resumeSessionId)
                  return
                }
                // If it no longer exists, fall through and create a new one.
                state.createdByRequestId.delete(m.requestId)
                this.forgetCreatedRequestId(m.requestId)
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
                  await attachReusedTerminal(existing.terminalId, existing.createdAt, existing.resumeSessionId)
                  return
                }
              }

              const cfg = await awaitConfig()
              const providerSettings = m.mode !== 'shell'
                ? cfg.settings?.codingCli?.providers?.[m.mode as keyof typeof cfg.settings.codingCli.providers] || {}
                : undefined

              // Re-check idempotency after async config loading in case another create won the race.
              const existingAfterConfigId = resolveExistingRequestTerminalId(m.requestId)
              if (existingAfterConfigId) {
                if (existingAfterConfigId === REPAIR_PENDING_SENTINEL) {
                  log.debug({ requestId: m.requestId, connectionId: ws.connectionId },
                    'terminal.create already in progress (repair pending), ignoring duplicate')
                  return
                }
                const existing = this.registry.get(existingAfterConfigId)
                if (existing) {
                  await attachReusedTerminal(existing.terminalId, existing.createdAt, existing.resumeSessionId)
                  return
                }
                state.createdByRequestId.delete(m.requestId)
                this.forgetCreatedRequestId(m.requestId)
              }

              // Rate limit: prevent runaway terminal creation (e.g., infinite respawn loops)
              if (!m.restore) {
                const now = Date.now()
                state.terminalCreateTimestamps = state.terminalCreateTimestamps.filter(
                  (t) => now - t < this.config.terminalCreateRateWindowMs
                )
                if (state.terminalCreateTimestamps.length >= this.config.terminalCreateRateLimit) {
                  rateLimited = true
                  log.warn({ connectionId: ws.connectionId, count: state.terminalCreateTimestamps.length }, 'terminal.create rate limited')
                  this.sendError(ws, { code: 'RATE_LIMITED', message: 'Too many terminal.create requests', requestId: m.requestId })
                  return
                }
                state.terminalCreateTimestamps.push(now)
              }

              // Re-check session ownership after async config loading in case another request
              // created or repaired a matching running session while we were waiting.
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
                  await attachReusedTerminal(existing.terminalId, existing.createdAt, existing.resumeSessionId)
                  return
                }
              }

              // Session repair is Claude-specific (uses JSONL session files).
              // Other providers (codex, opencode, etc.) don't use the same file
              // structure, so this block correctly remains gated on mode === 'claude'.
              if (m.mode === 'claude' && effectiveResumeSessionId && isValidClaudeSessionId(effectiveResumeSessionId) && this.sessionRepairService) {
                const sessionId = effectiveResumeSessionId
                const cached = this.sessionRepairService.getResult(sessionId)
                if (cached?.status === 'missing') {
                  log.info({ sessionId, connectionId: ws.connectionId }, 'Session previously marked missing; resume will start fresh')
                  effectiveResumeSessionId = undefined
                } else {
                  // Reserve requestId to prevent same-socket duplicate creates during async repair wait.
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
                envContext: { tabId: m.tabId, paneId: m.paneId },
                providerSettings: providerSettings
                  ? {
                      permissionMode: providerSettings.permissionMode,
                      model: providerSettings.model,
                      sandbox: providerSettings.sandbox,
                    }
                  : undefined,
              })

              if (m.mode !== 'shell' && typeof m.cwd === 'string' && m.cwd.trim()) {
                const recentDirectory = m.cwd.trim()
                void configStore.pushRecentDirectory(recentDirectory).catch((err) => {
                  log.warn({ err, recentDirectory }, 'Failed to record recent directory')
                })
              }

              state.createdByRequestId.set(m.requestId, record.terminalId)
              this.rememberCreatedRequestId(m.requestId, record.terminalId)
              terminalId = record.terminalId

              const sent = await sendCreateResult({
                ws,
                requestId: m.requestId,
                terminalId: record.terminalId,
                createdAt: record.createdAt,
                effectiveResumeSessionId: record.resumeSessionId ?? effectiveResumeSessionId,
              })
              if (!sent) {
                // Terminal may still exist even if created delivery failed (for
                // example: socket closed after create). Broadcast inventory so
                // other clients can discover it.
                this.broadcastTerminalsChanged()
                return
              }

              // Notify all clients that list changed
              this.broadcastTerminalsChanged()
            },
          )
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
        if (!this.registry.get(m.terminalId)) {
          this.sendError(ws, { code: 'INVALID_TERMINAL_ID', message: 'Terminal not running', terminalId: m.terminalId })
          return
        }

        const attachResult = await this.terminalStreamBroker.attach(
          ws,
          m.terminalId,
          m.cols,
          m.rows,
          m.sinceSeq,
          m.attachRequestId,
        )
        if (attachResult === 'missing') {
          this.sendError(ws, { code: 'INVALID_TERMINAL_ID', message: 'Unknown terminalId', terminalId: m.terminalId })
          return
        }
        if (attachResult === 'duplicate') return
        state.attachedTerminalIds.add(m.terminalId)
        this.broadcastTerminalRuntimeUpdatedForId(m.terminalId)
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
        this.broadcastTerminalRuntimeUpdatedForId(m.terminalId)
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
        this.broadcastTerminalsChanged()
        this.broadcastTerminalRuntimeUpdatedForId(m.terminalId)
        return
      }

      case 'codex.activity.list': {
        const terminals = this.codexActivityListProvider ? this.codexActivityListProvider() : []
        const response = CodexActivityListResponseSchema.safeParse({
          type: 'codex.activity.list.response',
          requestId: m.requestId,
          terminals,
        })
        if (!response.success) {
          log.warn({ issues: response.error.issues }, 'Invalid codex.activity.list.response payload')
          this.sendError(ws, {
            code: 'INTERNAL_ERROR',
            message: 'Codex activity unavailable',
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
            plugins: m.plugins,
          })
          state.sdkSessions.add(session.sessionId)

          // Send sdk.created FIRST so the client creates the Redux session
          // before any buffered messages (sdk.session.init, sdk.error) arrive.
          this.send(ws, { type: 'sdk.created', requestId: m.requestId, sessionId: session.sessionId })

          // When resuming a previous Claude Code session, load chat history
          // from the .jsonl file on disk so the UI can display past messages.
          // Sent before sdk.session.init so history is loaded before the UI
          // becomes interactive, preventing user messages from being overwritten.
          if (m.resumeSessionId) {
            try {
              const messages = await loadSessionHistory(m.resumeSessionId)
              this.send(ws, {
                type: 'sdk.session.snapshot',
                sessionId: session.sessionId,
                latestTurnId: messages && messages.length > 0 ? `turn-${messages.length - 1}` : null,
                status: session.status,
              })
            } catch (err) {
              log.warn({ err, resumeSessionId: m.resumeSessionId }, 'Failed to load session history from .jsonl')
            }
          } else {
            this.send(ws, {
              type: 'sdk.session.snapshot',
              sessionId: session.sessionId,
              latestTurnId: null,
              status: session.status,
            })
          }

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
          const sub = this.sdkBridge.subscribe(session.sessionId, (msg: SdkServerMessage) => {
            this.safeSend(ws, msg)
          })
          if (sub) state.sdkSubscriptions.set(session.sessionId, sub.off)

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

      case 'sdk.question.respond': {
        if (!this.sdkBridge) {
          this.sendError(ws, { code: 'INTERNAL_ERROR', message: 'SDK bridge not enabled' })
          return
        }
        if (!state.sdkSessions.has(m.sessionId) && !state.sdkSubscriptions.has(m.sessionId)) {
          this.sendError(ws, { code: 'UNAUTHORIZED', message: 'Not subscribed to this SDK session' })
          return
        }
        const ok = this.sdkBridge.respondQuestion(m.sessionId, m.requestId, m.answers)
        if (!ok) {
          this.sendError(ws, { code: 'INVALID_SESSION_ID', message: 'SDK session or question not found' })
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
          if (isValidClaudeSessionId(m.sessionId)) {
            try {
              const historicalMessages = await loadSessionHistory(m.sessionId)
              if (historicalMessages !== null) {
                this.send(ws, {
                  type: 'sdk.session.snapshot',
                  sessionId: m.sessionId,
                  latestTurnId: historicalMessages.length > 0
                    ? `turn-${historicalMessages.length - 1}`
                    : null,
                  status: 'idle',
                })
                this.send(ws, {
                  type: 'sdk.status',
                  sessionId: m.sessionId,
                  status: 'idle',
                })
                return
              }
            } catch (err) {
              log.warn({ err, sessionId: m.sessionId }, 'Failed to load durable Claude history for attach')
            }
          }
          // Send sdk.error (not generic error) so the client's SDK message handler
          // can identify the lost session and trigger immediate recovery.
          this.send(ws, {
            type: 'sdk.error',
            sessionId: m.sessionId,
            code: 'INVALID_SESSION_ID',
            message: 'SDK session not found',
          } as SdkServerMessage)
          return
        }

        // Subscribe this client to session events if not already
        let bufferReplayed = false
        if (!state.sdkSubscriptions.has(m.sessionId)) {
          const sub = this.sdkBridge.subscribe(m.sessionId, (msg: SdkServerMessage) => {
            this.safeSend(ws, msg)
          })
          if (sub) {
            state.sdkSubscriptions.set(m.sessionId, sub.off)
            bufferReplayed = sub.replayed
          }
        }

        // Send history replay. For resumed sessions, use the .jsonl file when it
        // has more messages than in-memory (covers the post-restart case where
        // in-memory is empty). For active sessions, in-memory is more current.
        let historyMessages: ChatMessage[] = session.messages
        if (session.resumeSessionId) {
          try {
            const jsonlMessages = await loadSessionHistory(session.resumeSessionId)
            if (jsonlMessages && jsonlMessages.length > session.messages.length) {
              historyMessages = jsonlMessages
            }
          } catch (err) {
            log.warn({ err, resumeSessionId: session.resumeSessionId }, 'Failed to load .jsonl history for attach')
          }
        }
        this.send(ws, {
          type: 'sdk.session.snapshot',
          sessionId: m.sessionId,
          latestTurnId: historyMessages.length > 0 ? `turn-${historyMessages.length - 1}` : null,
          status: session.status,
        })

        // Send current status
        this.send(ws, {
          type: 'sdk.status',
          sessionId: m.sessionId,
          status: session.status,
        })

        // Replay pending permissions and questions for re-attaching clients.
        // Skip if subscribe() already replayed the buffer (first subscriber),
        // since buffered messages already include these requests.
        if (!bufferReplayed) {
          if (session.pendingPermissions) {
            for (const [requestId, perm] of session.pendingPermissions) {
              this.send(ws, {
                type: 'sdk.permission.request',
                sessionId: m.sessionId,
                requestId,
                subtype: 'can_use_tool',
                tool: { name: perm.toolName, input: perm.input },
                toolUseID: perm.toolUseID,
                suggestions: perm.suggestions,
                blockedPath: perm.blockedPath,
                decisionReason: perm.decisionReason,
              } as SdkServerMessage)
            }
          }

          if (session.pendingQuestions) {
            for (const [requestId, q] of session.pendingQuestions) {
              this.send(ws, {
                type: 'sdk.question.request',
                sessionId: m.sessionId,
                requestId,
                questions: q.questions,
              } as SdkServerMessage)
            }
          }
        }
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

  broadcastAuthenticated(msg: unknown) {
    for (const ws of this.connections) {
      if (ws.readyState !== WebSocket.OPEN) continue
      const state = this.clientStates.get(ws)
      if (!state?.authenticated) continue
      this.send(ws, msg)
    }
  }

  broadcastUiCommand(command: { command: string; payload?: any }) {
    this.broadcast({ type: 'ui.command', ...command })
  }

  broadcastSessionsChanged(revision: number): void {
    this.sessionsRevision = Math.max(this.sessionsRevision, revision)
    this.broadcastAuthenticated({
      type: 'sessions.changed',
      revision,
    })
  }

  broadcastTerminalsChanged(): void {
    this.terminalsRevision += 1
    this.broadcastAuthenticated({
      type: 'terminals.changed',
      revision: this.terminalsRevision,
    })
  }

  private resolveTerminalRuntimePayload(terminalId: string): {
    terminalId: string
    title: string
    status: 'running' | 'detached' | 'exited'
    cwd?: string
    pid?: number
  } | null {
    const record = this.registry.get(terminalId) as
      | {
          terminalId: string
          title: string
          status: 'running' | 'exited'
          cwd?: string
          pty?: { pid?: number }
          clients?: Set<unknown>
        }
      | null
      | undefined

    if (!record) return null

    return {
      terminalId: record.terminalId,
      title: record.title,
      status: record.status === 'exited'
        ? 'exited'
        : ((record.clients?.size ?? 0) > 0 ? 'running' : 'detached'),
      ...(record.cwd ? { cwd: record.cwd } : {}),
      ...(typeof record.pty?.pid === 'number' ? { pid: record.pty.pid } : {}),
    }
  }

  broadcastTerminalRuntimeUpdated(msg: {
    terminalId: string
    title: string
    status: 'running' | 'detached' | 'exited'
    cwd?: string
    pid?: number
  }): void {
    const revision = (this.terminalRuntimeRevisions.get(msg.terminalId) ?? 0) + 1
    this.terminalRuntimeRevisions.set(msg.terminalId, revision)
    this.broadcastAuthenticated({
      type: 'terminal.runtime.updated',
      revision,
      ...msg,
    })
  }

  private broadcastTerminalRuntimeUpdatedForId(terminalId: string): void {
    const payload = this.resolveTerminalRuntimePayload(terminalId)
    if (!payload) return
    this.broadcastTerminalRuntimeUpdated(payload)
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

  broadcastCodexActivityUpdated(msg: { upsert?: CodexActivityRecord[]; remove?: string[] }): void {
    const parsed = CodexActivityUpdatedSchema.safeParse({
      type: 'codex.activity.updated',
      upsert: msg.upsert || [],
      remove: msg.remove || [],
    })

    if (!parsed.success) {
      log.warn({ issues: parsed.error.issues }, 'Invalid codex.activity.updated payload')
      return
    }

    this.broadcastAuthenticated(parsed.data)
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
    }, this.config.pingIntervalMs)

    log.info('WsHandler resumed after rebind')
  }

  /**
   * Gracefully close all WebSocket connections and the server.
   */
  close(): void {
    if (this.closed) return
    this.closed = true

    const registryWithEvents = this.registry as unknown as {
      off?: (event: string, listener: (...args: any[]) => void) => void
    }
    registryWithEvents.off?.('terminal.exit', this.onTerminalExitBound)

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

    for (const [requestId, pending] of this.screenshotRequests) {
      clearTimeout(pending.timeout)
      pending.reject(createScreenshotError('SCREENSHOT_CONNECTION_CLOSED', 'WebSocket server closed before screenshot response'))
      this.screenshotRequests.delete(requestId)
    }
    this.createdTerminalByRequestId.clear()

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
