import type http from 'http'
import { randomUUID } from 'crypto'
import WebSocket, { WebSocketServer } from 'ws'
import { z } from 'zod'
import { logger } from './logger.js'
import { recordSessionLifecycleEvent } from './session-observability.js'
import { getPerfConfig, startPerfTimer } from './perf-logger.js'
import { getRequiredAuthToken, isLoopbackAddress, isOriginAllowed, timingSafeCompare } from './auth.js'
import { buildTerminalSessionRef, modeSupportsResume, terminalIdFromCreateError } from './terminal-registry.js'
import type { TerminalRecord, TerminalRegistry, TerminalMode } from './terminal-registry.js'
import { configStore, type ConfigReadError, type UserConfig } from './config-store.js'
import type { CodingCliSessionManager } from './coding-cli/session-manager.js'
import { makeSessionKey, type CodingCliProviderName, type ProjectGroup } from './coding-cli/types.js'
import type { TerminalMeta } from './terminal-metadata-service.js'
import type { SessionRepairService } from './session-scanner/service.js'
import type { SessionScanResult, SessionRepairResult } from './session-scanner/types.js'
import { isValidClaudeSessionId } from './claude-session-id.js'
import type { SdkBridge } from './sdk-bridge.js'
import {
  createClaudeFreshAgentHistorySource,
  type ClaudeFreshAgentHistorySource,
} from './fresh-agent/history/claude/history-source.js'
import type {
  ClaudeActivityRecord,
  CodexActivityRecord,
  OpencodeActivityRecord,
  TerminalTurnCompletionSnapshot,
  TerminalTurnCompleteMessage,
} from '../shared/ws-protocol.js'
import type { ExtensionManager } from './extension-manager.js'
import { allocateLocalhostPort } from './local-port.js'
import { TerminalStreamBroker } from './terminal-stream/broker.js'
import { isTerminalStreamAttachRequestIdWithinSerializedBudget } from './terminal-stream/serialized-budget.js'
import { buildSidebarOpenSessionKeys, type SidebarSessionLocator } from './sidebar-session-selection.js'
import { loadSessionHistory } from './session-history-loader.js'
import { TabRegistryRecordBaseSchema, TabRegistryRecordSchema } from './tabs-registry/types.js'
import type { TabsRegistryStore } from './tabs-registry/store.js'
import type { ServerSettings } from '../shared/settings.js'
import { stripAnsi } from './ai-prompts.js'
import type { CodexLaunchPlan, CodexLaunchPlanner } from './coding-cli/codex-app-server/launch-planner.js'
import {
  CODEX_INITIAL_LAUNCH_ATTEMPTS,
  planCodexLaunchWithRetry,
} from './coding-cli/codex-app-server/launch-retry.js'
import {
  CodexLaunchConfigError,
  getCodexSessionBindingReason,
  normalizeCodexSandboxSetting,
} from './coding-cli/codex-launch-config.js'
import {
  ErrorCode,
  ShellSchema,
  CodingCliProviderSchema,
  SessionLocatorSchema,
  TerminalMetaUpdatedSchema,
  ClaudeActivityListResponseSchema,
  ClaudeActivityListSchema,
  ClaudeActivityUpdatedSchema,
  CodexActivityListResponseSchema,
  CodexActivityListSchema,
  CodexActivityUpdatedSchema,
  OpencodeActivityListResponseSchema,
  OpencodeActivityListSchema,
  OpencodeActivityUpdatedSchema,
  TerminalTurnCompleteSchema,
  HelloSchema,
  PingSchema,
  ClientDiagnosticSchema,
  TerminalCodexCandidatePersistedSchema,
  TerminalAttachSchema,
  TerminalDetachSchema,
  TerminalInputSchema,
  TerminalResizeSchema,
  TerminalKillSchema,
  CodingCliInputSchema,
  CodingCliKillSchema,
  FreshAgentCreateSchema,
  FreshAgentAttachSchema,
  FreshAgentSendSchema,
  FreshAgentInterruptSchema,
  FreshAgentCompactSchema,
  FreshAgentApprovalRespondSchema,
  FreshAgentQuestionRespondSchema,
  FreshAgentKillSchema,
  FreshAgentForkSchema,
  UiScreenshotResultSchema,
  WS_PROTOCOL_VERSION,
} from '../shared/ws-protocol.js'
import { LiveTerminalHandleSchema, type RestoreError } from '../shared/session-contract.js'
import { CODEX_DURABILITY_SCHEMA_VERSION, CodexDurabilityRefSchema } from '../shared/codex-durability.js'
import { migrateLegacyFreshAgentContent } from '../shared/fresh-agent.js'
import { UiLayoutSyncSchema } from './agent-api/layout-schema.js'
import type { LayoutStore } from './agent-api/layout-store.js'
import {
  planCodexCreateRestoreDecision,
  resolveCodexCreateRestoreDecision,
} from './coding-cli/codex-app-server/restore-decision.js'
import { sendJsonMessage } from './ws-send.js'
import {
  buildSessionIdentityMismatchDetails,
  terminalMatchesExpectedSession,
} from './terminal-session-identity.js'
import {
  makeFreshAgentProviderErrorEvent,
  normalizeFreshAgentProviderEvent,
} from './fresh-agent/sdk-events.js'

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

type FreshAgentRuntimeManagerLike = {
  create: (input: any) => Promise<any>
  attach: (input: any) => any
  subscribe?: (locator: any, listener: (message: unknown) => void) => Promise<() => void> | (() => void)
  send?: (locator: any, input: any) => Promise<FreshAgentSendResult> | FreshAgentSendResult
  interrupt?: (locator: any) => Promise<void> | void
  compact?: (locator: any, input?: { instructions?: string }) => Promise<void> | void
  resolveApproval?: (locator: any, requestId: string | number, decision: Record<string, unknown>) => Promise<void> | void
  answerQuestion?: (locator: any, requestId: string | number, answers: Record<string, string>) => Promise<void> | void
  kill?: (locator: any) => Promise<boolean> | boolean
  fork?: (locator: any, input?: Record<string, unknown>) => Promise<unknown> | unknown
}

type FreshAgentSendResult = void | {
  sessionId?: string
  sessionRef?: { provider: string; sessionId: string }
}

type FreshAgentLocator = {
  sessionId: string
  sessionType: string
  provider: string
}

type FreshAgentCreatedRecord = {
  sessionId: string
  sessionType: string
  provider: string
  runtimeProvider: string
  sessionRef?: { provider: string; sessionId: string }
}

type FreshAgentSubscriptionEntry = {
  active: boolean
  off?: () => void
  pending?: Promise<void>
}

type WsErrorLogEntry = {
  code: string
  messageClass: string
  terminalId?: string
  count: number
  suppressedCount: number
  firstRequestId?: string
  lastRequestId?: string
}

type CreatedTerminalRequestBinding = {
  terminalId: string
  expectedSessionKey?: string
}

export type WsHandlerOptions = {
  codingCliManager?: CodingCliSessionManager
  codexLaunchPlanner?: CodexLaunchPlanner
  sdkBridge?: SdkBridge
  sessionRepairService?: SessionRepairService
  handshakeSnapshotProvider?: HandshakeSnapshotProvider
  terminalMetaListProvider?: () => TerminalMeta[]
  tabsRegistryStore?: TabsRegistryStore
  serverInstanceId?: string
  layoutStore?: LayoutStore
  extensionManager?: ExtensionManager
  codexActivityListProvider?: () => CodexActivityRecord[]
  claudeActivityListProvider?: () => ClaudeActivityRecord[]
  codexLatestTurnCompletionsProvider?: () => TerminalTurnCompletionSnapshot[]
  claudeLatestTurnCompletionsProvider?: () => TerminalTurnCompletionSnapshot[]
  agentHistorySource?: ClaudeFreshAgentHistorySource
  opencodeActivityListProvider?: () => OpencodeActivityRecord[]
  opencodeLatestTurnCompletionsProvider?: () => TerminalTurnCompletionSnapshot[]
  freshAgentRuntimeManager?: FreshAgentRuntimeManagerLike
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
  supportsTerminalOutputBatchV1?: boolean
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

const TERMINAL_FAILURE_SUMMARY_MAX_CHARS = 200

function summarizeTerminalFailureOutput(snapshot: string): string | undefined {
  const cleaned = stripAnsi(snapshot)
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)

  if (!cleaned) return undefined
  if (cleaned.length <= TERMINAL_FAILURE_SUMMARY_MAX_CHARS) return cleaned
  return `...${cleaned.slice(-TERMINAL_FAILURE_SUMMARY_MAX_CHARS)}`
}

function formatExitedTerminalAttachMessage(record: Pick<TerminalRecord, 'title' | 'mode' | 'exitCode' | 'buffer'>): string {
  const label = isNonEmptyString(record.title)
    ? record.title.trim()
    : record.mode.charAt(0).toUpperCase() + record.mode.slice(1)
  const exitSuffix = typeof record.exitCode === 'number' ? ` (exit ${record.exitCode})` : ''
  const summary = summarizeTerminalFailureOutput(record.buffer.snapshot())
  if (summary) {
    return `${label} is no longer running${exitSuffix}. Last output: ${summary}`
  }
  return `${label} is no longer running${exitSuffix}.`
}

function assertCodexCreateTerminalRunning(record: Pick<TerminalRecord, 'status'>): void {
  if (record.status !== 'running') {
    throw new Error('Codex terminal PTY exited before create completed.')
  }
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

function normalizeTerminalInventoryForClient(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const terminal = value as Record<string, unknown>
  const { resumeSessionId: legacyResumeSessionId, ...rest } = terminal
  const explicitSessionRef = normalizeUiSessionLocator(terminal.sessionRef)
  const provider = typeof terminal.mode === 'string' && modeSupportsResume(terminal.mode as TerminalMode)
    ? terminal.mode
    : undefined
  const codexDurability = terminal.codexDurability as { state?: unknown; durableThreadId?: unknown } | undefined
  const canMigrateLegacySessionRef = provider !== 'codex' || (
    codexDurability?.state === 'durable'
    && codexDurability.durableThreadId === legacyResumeSessionId
  )
  const migratedSessionRef = provider && isNonEmptyString(legacyResumeSessionId) && canMigrateLegacySessionRef
    ? { provider, sessionId: legacyResumeSessionId }
    : undefined
  const sessionRef = explicitSessionRef ?? migratedSessionRef
  return {
    ...rest,
    ...(sessionRef ? { sessionRef } : {}),
  }
}

function extractSessionLocatorsFromUiContent(content: Record<string, unknown>): SidebarSessionLocator[] {
  const normalizedContent = migrateLegacyFreshAgentContent(content) as Record<string, unknown>
  const locators: SidebarSessionLocator[] = []

  const explicit = normalizeUiSessionLocator(normalizedContent.sessionRef)
  if (explicit) {
    locators.push(explicit)
  }

  const kind = normalizedContent.kind
  if (kind !== 'terminal') return locators

  const mode = CodingCliProviderSchema.safeParse(normalizedContent.mode)
  if (!mode.success || !isNonEmptyString(normalizedContent.resumeSessionId)) {
    return locators
  }

  locators.push({
    provider: mode.data,
    sessionId: normalizedContent.resumeSessionId,
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
  clientInstanceId: true,
})

const TabsSyncPushSchema = z.object({
  type: z.literal('tabs.sync.push'),
  deviceId: z.string().min(1),
  deviceLabel: z.string().min(1),
  clientInstanceId: z.string().min(1),
  snapshotRevision: z.number().int().nonnegative(),
  records: z.array(TabsSyncPushRecordSchema),
})
type TabsSyncPushRecord = z.infer<typeof TabsSyncPushRecordSchema>

const TabsSyncQuerySchema = z.object({
  type: z.literal('tabs.sync.query'),
  requestId: z.string().min(1),
  deviceId: z.string().min(1),
  clientInstanceId: z.string().min(1),
  closedTabRetentionDays: z.number().int().min(1).max(30),
})

const TabsSyncClientRetireSchema = z.object({
  type: z.literal('tabs.sync.client.retire'),
  deviceId: z.string().min(1),
  clientInstanceId: z.string().min(1),
  snapshotRevision: z.number().int().nonnegative(),
})

type ClientState = {
  authenticated: boolean
  supportsUiScreenshotV1: boolean
  supportsTerminalOutputBatchV1: boolean
  attachedTerminalIds: Set<string>
  createdByRequestId: Map<string, CreatedTerminalRequestBinding | typeof REPAIR_PENDING_SENTINEL>
  claudeFreshSessionIdByRequestId: Map<string, string>
  terminalCreateTimestamps: number[]
  codingCliSessions: Set<string>
  codingCliSubscriptions: Map<string, () => void>
  freshAgentSubscriptions: Map<string, FreshAgentSubscriptionEntry>
  freshAgentAuthorizations: Set<string>
  wsErrorLogs: Map<string, WsErrorLogEntry>
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

class TerminalCreateAdmissionError extends Error {}

export class WsHandler {
  private readonly config: WsHandlerConfig
  private readonly authToken: string
  private readonly registry: TerminalRegistry
  private readonly codingCliManager?: CodingCliSessionManager
  private readonly codexLaunchPlanner?: CodexLaunchPlanner
  private readonly sdkBridge?: SdkBridge
  private wss: WebSocketServer
  private connections = new Set<LiveWebSocket>()
  private clientStates = new Map<LiveWebSocket, ClientState>()
  private pingInterval: NodeJS.Timeout | null = null
  private closed = false
  private sessionRepairService?: SessionRepairService
  private handshakeSnapshotProvider?: HandshakeSnapshotProvider
  private terminalMetaListProvider?: () => TerminalMeta[]
  private codexActivityListProvider?: () => CodexActivityRecord[]
  private claudeActivityListProvider?: () => ClaudeActivityRecord[]
  private opencodeActivityListProvider?: () => OpencodeActivityRecord[]
  private codexLatestTurnCompletionsProvider?: () => TerminalTurnCompletionSnapshot[]
  private claudeLatestTurnCompletionsProvider?: () => TerminalTurnCompletionSnapshot[]
  private opencodeLatestTurnCompletionsProvider?: () => TerminalTurnCompletionSnapshot[]
  private tabsRegistryStore?: TabsRegistryStore
  private layoutStore?: LayoutStore
  private extensionManager?: ExtensionManager
  private agentHistorySource?: ClaudeFreshAgentHistorySource
  private freshAgentRuntimeManager?: FreshAgentRuntimeManagerLike
  private terminalStreamBroker: TerminalStreamBroker
  private terminalCreateLocks = new Map<string, Promise<void>>()
  private createdTerminalByRequestId = new Map<string, CreatedTerminalRequestBinding>()
  private sdkCreateLocks = new Map<string, Promise<void>>()
  private createdSdkSessionByRequestId = new Map<string, string>()
  private sdkSessionByCreateOwnerKey = new Map<string, string>()
  private freshAgentCreateLocks = new Map<string, Promise<void>>()
  private createdFreshAgentByRequestId = new Map<string, FreshAgentCreatedRecord>()
  private screenshotRequests = new Map<string, PendingScreenshot>()
  private sessionsRevision = 0
  private terminalsRevision = 0

  private readonly serverInstanceId: string
  private readonly bootId: string
  // The runtime validator is authoritative here; we keep the field typed broadly because
  // the dynamic provider schemas widen discriminated-union inference beyond what TS/Zod model well.
  private clientMessageSchema: z.ZodTypeAny
  private onTerminalExitBound = (payload: { terminalId?: string }) => {
    if (!payload?.terminalId) return
    this.forgetCreatedRequestIdsForTerminal(payload.terminalId)
  }
  private onCodexDurabilityUpdatedBound = (payload: { terminalId?: string; durability?: unknown }) => {
    if (!payload?.terminalId || payload.durability === undefined) return
    this.broadcast({
      type: 'terminal.codex.durability.updated',
      terminalId: payload.terminalId,
      durability: payload.durability,
    })
    this.broadcastTerminalsChanged()
  }
  private sessionRepairListeners?: {
    scanned: (result: SessionScanResult) => void
    repaired: (result: SessionRepairResult) => void
    error: (sessionId: string, error: Error) => void
  }

  constructor(
    server: http.Server,
    registry: TerminalRegistry,
    options: WsHandlerOptions = {},
  ) {
    this.config = readWsHandlerConfig()
    this.authToken = getRequiredAuthToken()
    this.registry = registry
    this.codingCliManager = options.codingCliManager
    this.codexLaunchPlanner = options.codexLaunchPlanner
    this.sdkBridge = options.sdkBridge
    this.sessionRepairService = options.sessionRepairService
    this.handshakeSnapshotProvider = options.handshakeSnapshotProvider
    this.terminalMetaListProvider = options.terminalMetaListProvider
    this.codexActivityListProvider = options.codexActivityListProvider
    this.claudeActivityListProvider = options.claudeActivityListProvider
    this.opencodeActivityListProvider = options.opencodeActivityListProvider
    this.codexLatestTurnCompletionsProvider = options.codexLatestTurnCompletionsProvider
    this.claudeLatestTurnCompletionsProvider = options.claudeLatestTurnCompletionsProvider
    this.opencodeLatestTurnCompletionsProvider = options.opencodeLatestTurnCompletionsProvider
    this.tabsRegistryStore = options.tabsRegistryStore
    this.layoutStore = options.layoutStore
    this.extensionManager = options.extensionManager
    this.freshAgentRuntimeManager = options.freshAgentRuntimeManager
    this.agentHistorySource = options.agentHistorySource ?? (this.sdkBridge
      ? createClaudeFreshAgentHistorySource({
        loadSessionHistory,
        getLiveSessionBySdkSessionId: (sdkSessionId) => this.sdkBridge?.getLiveSession(sdkSessionId),
        getLiveSessionByCliSessionId: (timelineSessionId) => this.sdkBridge?.findLiveSessionByCliSessionId(timelineSessionId),
      })
      : undefined)
    this.serverInstanceId = options.serverInstanceId && options.serverInstanceId.trim().length > 0
      ? options.serverInstanceId
      : `srv-${randomUUID()}`
    this.bootId = `boot-${randomUUID()}`
    this.registry.setServerInstanceId?.(this.serverInstanceId)
    this.terminalStreamBroker = new TerminalStreamBroker(this.registry)

    // Build the set of valid CLI provider/mode names from extensions
    const extensionManager = this.extensionManager
    const canEnumerateCliExtensions = typeof extensionManager?.getAll === 'function'
    const extensionModes = canEnumerateCliExtensions && extensionManager
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
      sessionRef: SessionLocatorSchema.optional(),
      codexDurability: CodexDurabilityRefSchema.optional(),
      liveTerminal: LiveTerminalHandleSchema.optional(),
      restore: z.boolean().optional(),
      recoveryIntent: z.literal('fresh_after_restore_unavailable').optional(),
      tabId: z.string().min(1).optional(),
      paneId: z.string().min(1).optional(),
    }).strict()

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
    }).strict()

    this.clientMessageSchema = z.discriminatedUnion('type', [
      HelloSchema,
      PingSchema,
      ClientDiagnosticSchema,
      dynamicTerminalCreateSchema,
      TerminalCodexCandidatePersistedSchema,
      TerminalAttachSchema,
      TerminalDetachSchema,
      TerminalInputSchema,
      TerminalResizeSchema,
      TerminalKillSchema,
      CodexActivityListSchema,
      ClaudeActivityListSchema,
      OpencodeActivityListSchema,
      TabsSyncPushSchema,
      TabsSyncQuerySchema,
      TabsSyncClientRetireSchema,
      dynamicCodingCliCreateSchema,
      CodingCliInputSchema,
      CodingCliKillSchema,
      FreshAgentCreateSchema,
      FreshAgentAttachSchema,
      FreshAgentSendSchema,
      FreshAgentInterruptSchema,
      FreshAgentCompactSchema,
      FreshAgentApprovalRespondSchema,
      FreshAgentQuestionRespondSchema,
      FreshAgentKillSchema,
      FreshAgentForkSchema,
      UiLayoutSyncSchema,
      UiScreenshotResultSchema,
    ])
    const registryWithEvents = this.registry as unknown as {
      on?: (event: string, listener: (...args: any[]) => void) => void
    }
    registryWithEvents.on?.('terminal.exit', this.onTerminalExitBound)
    registryWithEvents.on?.('terminal.codex.durability.updated', this.onCodexDurabilityUpdatedBound)
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

  private rememberCreatedRequestId(
    requestId: string,
    terminalId: string,
    expectedSessionKey?: string,
  ): void {
    this.createdTerminalByRequestId.set(requestId, {
      terminalId,
      ...(expectedSessionKey ? { expectedSessionKey } : {}),
    })
  }

  private forgetCreatedRequestId(requestId: string): void {
    this.createdTerminalByRequestId.delete(requestId)
  }

  private forgetCreatedRequestIdsForTerminal(terminalId: string): void {
    for (const [requestId, binding] of this.createdTerminalByRequestId) {
      if (binding.terminalId === terminalId) {
        this.createdTerminalByRequestId.delete(requestId)
      }
    }
  }

  private createdRequestBindingMatchesExpectedSession(
    binding: CreatedTerminalRequestBinding,
    expectedSessionKey: string | undefined,
  ): boolean {
    return binding.expectedSessionKey === expectedSessionKey
  }

  private resolveCreatedTerminalBinding(
    requestId: string,
    expectedSessionKey: string | undefined,
  ): CreatedTerminalRequestBinding | undefined {
    const cached = this.createdTerminalByRequestId.get(requestId)
    if (!cached || !this.createdRequestBindingMatchesExpectedSession(cached, expectedSessionKey)) {
      return undefined
    }
    const record = this.registry.get(cached.terminalId)
    if (!record) {
      this.createdTerminalByRequestId.delete(requestId)
      return undefined
    }
    return cached
  }

  private expectedSessionKey(expectedSessionRef: { provider: string; sessionId: string } | undefined): string | undefined {
    if (!expectedSessionRef) return undefined
    return makeSessionKey(expectedSessionRef.provider as CodingCliProviderName, expectedSessionRef.sessionId)
  }

  private sendSessionIdentityMismatch(
    ws: LiveWebSocket,
    params: {
      operation: 'terminal.attach' | 'terminal.input' | 'terminal.resize'
      requestId?: string
      terminalId: string
      expectedSessionRef: { provider: string; sessionId: string }
      record: Pick<TerminalRecord, 'mode' | 'resumeSessionId' | 'codexDurability'>
      attemptedInputBytes?: number
    },
  ): void {
    const details = buildSessionIdentityMismatchDetails(params.record, params.expectedSessionRef)
    log.warn({
      connectionId: ws.connectionId,
      terminalId: params.terminalId,
      operation: params.operation,
      expectedSessionRef: details.expectedSessionRef,
      actualSessionRef: details.actualSessionRef,
      ...(params.attemptedInputBytes !== undefined ? { attemptedInputBytes: params.attemptedInputBytes } : {}),
    }, 'Terminal operation rejected due to canonical session identity mismatch')
    this.sendError(ws, {
      code: 'SESSION_IDENTITY_MISMATCH',
      message: 'Terminal session does not match the expected session.',
      requestId: params.requestId,
      terminalId: params.terminalId,
      expectedSessionRef: details.expectedSessionRef,
      actualSessionRef: details.actualSessionRef,
    })
  }

  private async planCodexLaunch(
    cwd: string | undefined,
    resumeSessionId: string | undefined,
    providerSettings: { model?: string; sandbox?: string; permissionMode?: string } | undefined,
    attempts = 1,
  ) {
    if (!this.codexLaunchPlanner) {
      throw new Error('Codex terminal launch requires the app-server launch planner.')
    }
    const input = {
      cwd,
      resumeSessionId,
      model: providerSettings?.model,
      sandbox: normalizeCodexSandboxSetting(providerSettings?.sandbox),
      approvalPolicy: providerSettings?.permissionMode,
    }
    return planCodexLaunchWithRetry({
      planner: this.codexLaunchPlanner,
      input,
      attempts,
      logger: log,
    })
  }

  private assertTerminalCreateAccepted(): void {
    if (this.closed) {
      throw new TerminalCreateAdmissionError('Server is shutting down; terminal.create is no longer accepted.')
    }
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

  private reserveClaudeFreshSessionId(state: ClientState, requestId: string): string {
    const existing = state.claudeFreshSessionIdByRequestId.get(requestId)
    if (existing) return existing
    const next = randomUUID()
    state.claudeFreshSessionIdByRequestId.set(requestId, next)
    return next
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

  private withFreshAgentCreateLock(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.freshAgentCreateLocks.get(key) ?? Promise.resolve()

    let current: Promise<void>
    current = previous
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        if (this.freshAgentCreateLocks.get(key) === current) {
          this.freshAgentCreateLocks.delete(key)
        }
      })

    this.freshAgentCreateLocks.set(key, current)
    return current
  }

  private clearFreshAgentCreateCachesForSession(sessionId: string): void {
    for (const [requestId, cached] of this.createdFreshAgentByRequestId.entries()) {
      if (cached.sessionId === sessionId) {
        this.createdFreshAgentByRequestId.delete(requestId)
      }
    }
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
    if (this.closed) {
      ws.close(CLOSE_CODES.SERVER_SHUTDOWN, 'Server shutting down')
      return
    }

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
      supportsTerminalOutputBatchV1: false,
      attachedTerminalIds: new Set(),
      createdByRequestId: new Map(),
      claudeFreshSessionIdByRequestId: new Map(),
      terminalCreateTimestamps: [],
      codingCliSessions: new Set(),
      codingCliSubscriptions: new Map(),
      freshAgentSubscriptions: new Map(),
      freshAgentAuthorizations: new Set(),
      wsErrorLogs: new Map(),
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
    this.cancelAllFreshAgentSubscriptions(state)
    this.flushWsErrorLogSummaries(state, 'connection_close')

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

  private freshAgentKey(locator: FreshAgentLocator): string {
    return `${locator.sessionType}:${locator.provider}:${locator.sessionId}`
  }

  private freshAgentEventMessage(locator: FreshAgentLocator, event: unknown) {
    return {
      type: 'freshAgent.event',
      sessionId: locator.sessionId,
      sessionType: locator.sessionType,
      provider: locator.provider,
      event: normalizeFreshAgentProviderEvent(event),
    }
  }

  private authorizeFreshAgentSession(state: ClientState, locator: FreshAgentLocator): void {
    state.freshAgentAuthorizations.add(this.freshAgentKey(locator))
  }

  private isFreshAgentAuthorized(state: ClientState, locator: FreshAgentLocator): boolean {
    return state.freshAgentAuthorizations.has(this.freshAgentKey(locator))
  }

  private requireFreshAgentAuthorization(
    ws: LiveWebSocket,
    state: ClientState,
    locator: FreshAgentLocator,
  ): boolean {
    if (this.isFreshAgentAuthorized(state, locator)) return true
    this.sendError(ws, {
      code: 'UNAUTHORIZED',
      message: 'Not authorized for this Fresh Agent session',
    })
    return false
  }

  private freshAgentUnavailableMessage() {
    return 'Fresh Agent runtime is not enabled'
  }

  private freshClientsEnabled(settings?: ServerSettings): boolean {
    return settings?.freshAgent?.enabled ?? false
  }

  private sendFreshAgentSubscriptionError(ws: LiveWebSocket, locator: FreshAgentLocator, error: unknown): void {
    this.safeSend(ws, this.freshAgentEventMessage(locator, {
      ...makeFreshAgentProviderErrorEvent(locator.sessionId, {
        code: 'FRESH_AGENT_SUBSCRIBE_FAILED',
        message: errorMessage(error),
      }),
    }))
  }

  private logFreshAgentSubscriptionOffError(locator: FreshAgentLocator, error: unknown): void {
    log.warn({
      err: error instanceof Error ? error : new Error(String(error)),
      sessionId: locator.sessionId,
      sessionType: locator.sessionType,
      provider: locator.provider,
    }, 'Fresh Agent subscription cleanup failed')
  }

  private ensureFreshAgentSubscription(
    ws: LiveWebSocket,
    state: ClientState,
    locator: FreshAgentLocator,
  ): void {
    const manager = this.freshAgentRuntimeManager
    if (!manager?.subscribe) return

    const key = this.freshAgentKey(locator)
    const existing = state.freshAgentSubscriptions.get(key)
    if (existing) {
      existing.active = true
      return
    }

    const entry: FreshAgentSubscriptionEntry = { active: true }
    state.freshAgentSubscriptions.set(key, entry)

    const listener = (event: unknown) => {
      if (!entry.active) return
      this.safeSend(ws, this.freshAgentEventMessage(locator, event))
    }

    entry.pending = Promise.resolve()
      .then(() => manager.subscribe?.(locator, listener))
      .then((off) => {
        entry.pending = undefined
        if (!entry.active) {
          if (off) {
            try {
              off()
            } catch (error) {
              this.logFreshAgentSubscriptionOffError(locator, error)
            }
          }
          state.freshAgentSubscriptions.delete(key)
          return
        }
        if (off) {
          entry.off = off
        }
      })
      .catch((error) => {
        entry.pending = undefined
        state.freshAgentSubscriptions.delete(key)
        if (entry.active) {
          this.sendFreshAgentSubscriptionError(ws, locator, error)
        }
      })
  }

  private cancelFreshAgentSubscription(
    state: ClientState,
    locator: FreshAgentLocator,
  ): void {
    const key = this.freshAgentKey(locator)
    const entry = state.freshAgentSubscriptions.get(key)
    if (!entry) return

    entry.active = false
    state.freshAgentSubscriptions.delete(key)
    if (entry.off) {
      try {
        entry.off()
      } catch (error) {
        this.logFreshAgentSubscriptionOffError(locator, error)
      }
    }
  }

  private cancelAllFreshAgentSubscriptions(state: ClientState): void {
    if (!state.freshAgentSubscriptions) return
    for (const [key, entry] of Array.from(state.freshAgentSubscriptions.entries())) {
      entry.active = false
      state.freshAgentSubscriptions.delete(key)
      if (entry.off) {
        try {
          entry.off()
        } catch (error) {
          log.warn({
            err: error instanceof Error ? error : new Error(String(error)),
            key,
          }, 'Fresh Agent subscription cleanup failed')
        }
      }
    }
  }

  private send(ws: LiveWebSocket, msg: unknown, skipBackpressureCheck = false) {
    sendJsonMessage(ws, msg, {
      skipBackpressureCheck,
      maxBufferedAmount: this.config.maxWsBufferedAmount,
      backpressureCloseCode: CLOSE_CODES.BACKPRESSURE,
      backpressureCloseReason: 'Backpressure',
    })
  }

  private safeSend(ws: LiveWebSocket, msg: unknown, skipBackpressureCheck = false) {
    if (ws.readyState === WebSocket.OPEN) {
      this.send(ws, msg, skipBackpressureCheck)
    }
  }

  private classifyWsError(params: { code: z.infer<typeof ErrorCode>; message: string }): string {
    if (params.code === 'INVALID_TERMINAL_ID') {
      return 'terminal_not_running'
    }
    return params.code.toLowerCase()
  }

  private wsErrorLogKey(params: {
    code: z.infer<typeof ErrorCode>
    messageClass: string
    terminalId?: string
  }): string {
    return `${params.code}:${params.messageClass}:${params.terminalId ?? ''}`
  }

  private recordWsErrorLog(
    ws: LiveWebSocket,
    params: { code: z.infer<typeof ErrorCode>; message: string; requestId?: string; terminalId?: string },
  ): void {
    const state = this.clientStates.get(ws)
    const messageClass = this.classifyWsError(params)
    const key = this.wsErrorLogKey({
      code: params.code,
      messageClass,
      terminalId: params.terminalId,
    })
    const logs = state?.wsErrorLogs
    const existing = logs?.get(key)
    if (existing) {
      existing.count += 1
      existing.suppressedCount += 1
      if (params.requestId) {
        existing.lastRequestId = params.requestId
      }
      return
    }

    const entry: WsErrorLogEntry = {
      code: params.code,
      messageClass,
      terminalId: params.terminalId,
      count: 1,
      suppressedCount: 0,
      firstRequestId: params.requestId,
      lastRequestId: params.requestId,
    }
    logs?.set(key, entry)
    log.warn({
      event: 'ws_send_error',
      connectionId: ws.connectionId || 'unknown',
      code: params.code,
      messageClass,
      ...(params.requestId ? { requestId: params.requestId } : {}),
      ...(params.terminalId ? { terminalId: params.terminalId } : {}),
    }, 'ws_send_error')
  }

  private flushWsErrorLogSummaries(state: ClientState, reason: 'connection_close'): void {
    if (!state.wsErrorLogs) return
    for (const entry of state.wsErrorLogs.values()) {
      if (entry.suppressedCount <= 0) continue
      log.warn({
        event: 'ws_send_error_suppressed_summary',
        reason,
        code: entry.code,
        messageClass: entry.messageClass,
        ...(entry.terminalId ? { terminalId: entry.terminalId } : {}),
        suppressedCount: entry.suppressedCount,
        totalCount: entry.count,
        ...(entry.firstRequestId ? { firstRequestId: entry.firstRequestId } : {}),
        ...(entry.lastRequestId ? { lastRequestId: entry.lastRequestId } : {}),
      }, 'ws_send_error_suppressed_summary')
    }
    state.wsErrorLogs.clear()
  }

  private sendError(
    ws: LiveWebSocket,
    params: {
      code: z.infer<typeof ErrorCode>
      message: string
      requestId?: string
      terminalId?: string
      expectedSessionRef?: { provider: string; sessionId: string }
      actualSessionRef?: { provider: string; sessionId: string }
    },
  ) {
    this.recordWsErrorLog(ws, params)
    this.send(ws, {
      type: 'error',
      code: params.code,
      message: params.message,
      requestId: params.requestId,
      terminalId: params.terminalId,
      expectedSessionRef: params.expectedSessionRef,
      actualSessionRef: params.actualSessionRef,
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

      // Send terminal inventory so the client knows what's alive
      const terminals = this.registry.list().map(normalizeTerminalInventoryForClient)
      const terminalMeta = this.terminalMetaListProvider?.() ?? []
      this.safeSend(ws, {
        type: 'terminal.inventory',
        bootId: this.bootId,
        terminals,
        terminalMeta,
      })
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

      if (rawBytes > this.config.maxRegularWsMessageBytes) {
        const isScreenshotResult = msg?.type === 'ui.screenshot.result'
        if (!isScreenshotResult) {
          this.sendError(ws, {
            code: 'INVALID_MESSAGE',
            message: `WebSocket message exceeds ${this.config.maxRegularWsMessageBytes} bytes.`,
            requestId: msg?.requestId,
          })
          return
        }

        const allowedScreenshotResultKeys = new Set([
          'type',
          'requestId',
          'ok',
          'mimeType',
          'imageBase64',
          'width',
          'height',
          'changedFocus',
          'restoredFocus',
          'error',
        ])
        const unknownKeys = msg && typeof msg === 'object'
          ? Object.keys(msg).filter((key) => !allowedScreenshotResultKeys.has(key))
          : []
        if (unknownKeys.length > 0) {
          this.sendError(ws, {
            code: 'INVALID_MESSAGE',
            message: `Unknown field in oversized screenshot result message: ${unknownKeys.join(', ')}`,
            requestId: msg?.requestId,
          })
          return
        }
      }

      if (msg?.type === 'hello' && msg?.protocolVersion !== WS_PROTOCOL_VERSION) {
        this.sendError(ws, {
          code: 'PROTOCOL_MISMATCH',
          message: `Expected protocol version ${WS_PROTOCOL_VERSION}. Please reload the page.`,
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
        state.supportsTerminalOutputBatchV1 = !!m.capabilities?.terminalOutputBatchV1
        ws.supportsTerminalOutputBatchV1 = state.supportsTerminalOutputBatchV1
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
          bootId: this.bootId,
        })
        this.scheduleHandshakeSnapshot(ws, state)
        return
      }

      if (!state.authenticated) {
        this.sendError(ws, { code: 'NOT_AUTHENTICATED', message: 'Send hello first' })
        ws.close(CLOSE_CODES.NOT_AUTHENTICATED, 'Not authenticated')
        return
      }

      if (this.closed && m.type === 'terminal.create') {
        this.sendError(ws, {
          code: 'INTERNAL_ERROR',
          message: 'Server is shutting down; terminal.create is no longer accepted.',
          requestId: m.requestId,
        })
        return
      }

      switch (m.type) {
      case 'client.diagnostic': {
        if (m.event === 'restore_unavailable') {
          recordSessionLifecycleEvent({
            kind: 'client_restore_unavailable',
            terminalId: m.terminalId,
            connectionId: ws.connectionId || 'unknown',
            ...(m.tabId ? { tabId: m.tabId } : {}),
            ...(m.paneId ? { paneId: m.paneId } : {}),
            mode: m.mode,
            reason: m.reason,
            hasSessionRef: m.hasSessionRef,
          })
        }
        return
      }
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
        recordSessionLifecycleEvent({
          kind: 'terminal_create_requested',
          requestId: m.requestId,
          connectionId: ws.connectionId || 'unknown',
          ...(m.tabId ? { tabId: m.tabId } : {}),
          ...(m.paneId ? { paneId: m.paneId } : {}),
          ...(m.cwd ? { cwd: m.cwd } : {}),
          mode: m.mode as TerminalMode,
          restoreRequested: m.restore === true,
          hasRequestedSessionRef: !!m.sessionRef,
          ...(m.resumeSessionId || m.sessionRef?.sessionId ? { requestedSessionId: m.resumeSessionId ?? m.sessionRef.sessionId } : {}),
        })
        if (m.recoveryIntent === 'fresh_after_restore_unavailable') {
          recordSessionLifecycleEvent({
            kind: 'restore_unavailable_fresh_fallback',
            requestId: m.requestId,
            connectionId: ws.connectionId || 'unknown',
            ...(m.tabId ? { tabId: m.tabId } : {}),
            ...(m.paneId ? { paneId: m.paneId } : {}),
            mode: m.mode as TerminalMode,
            reason: m.recoveryIntent,
            restoreRequested: false,
            treatedAsFresh: true,
            hasSessionRef: !!m.sessionRef,
          })
        }
        const endCreateTimer = startPerfTimer(
          'terminal_create',
          { connectionId: ws.connectionId, mode: m.mode, shell: m.shell },
          { minDurationMs: perfConfig.slowTerminalCreateMs, level: 'warn' },
        )
        let terminalId: string | undefined
        let pendingCodexPlan: CodexLaunchPlan | undefined
        let reused = false
        let error = false
        let rateLimited = false
        const requestedSessionRef = normalizeUiSessionLocator(m.sessionRef)
        const expectedSessionRef = requestedSessionRef && requestedSessionRef.provider === m.mode
          ? requestedSessionRef
          : undefined
        const expectedSessionKey = this.expectedSessionKey(expectedSessionRef)
        if (
          m.recoveryIntent === 'fresh_after_restore_unavailable'
          && (
            m.restore === true
            || !!m.resumeSessionId
            || !!requestedSessionRef
            || !!m.codexDurability
            || !!m.liveTerminal
          )
        ) {
          error = true
          this.sendError(ws, {
            code: 'INVALID_CREATE_REQUEST',
            message: 'Fresh recovery requests cannot include restore identity.',
            requestId: m.requestId,
          })
          endCreateTimer({ error, rateLimited })
          return
        }
        const hasReusableRequestedLiveTerminal = Boolean(
          (m.mode !== 'codex' || expectedSessionRef)
          && m.liveTerminal?.serverInstanceId === this.serverInstanceId
            && m.liveTerminal.terminalId
            && (() => {
              const live = this.registry.get(m.liveTerminal.terminalId)
              return live && live.status === 'running' && live.mode === m.mode
            })(),
        )
        const codexDurabilityForDecision = m.mode === 'codex' && expectedSessionRef
          ? m.codexDurability
          : undefined
        const codexRestorePlan = m.mode === 'codex'
          ? planCodexCreateRestoreDecision({
            restoreRequested: m.restore === true,
            legacyResumeSessionId: m.resumeSessionId,
            sessionRef: expectedSessionRef,
            codexDurability: codexDurabilityForDecision,
          })
          : undefined
        let effectiveResumeSessionId: string | undefined
        let sessionBindingReason: 'start' | 'resume' | undefined
        if (codexRestorePlan?.kind === 'durable_session_ref_resume') {
          effectiveResumeSessionId = codexRestorePlan.sessionId
        } else if (m.mode !== 'codex') {
          effectiveResumeSessionId = requestedSessionRef && requestedSessionRef.provider === m.mode
            ? requestedSessionRef.sessionId
            : m.resumeSessionId
        }
        if (m.mode !== 'codex' && !effectiveResumeSessionId && requestedSessionRef && requestedSessionRef.provider === m.mode) {
          effectiveResumeSessionId = requestedSessionRef.sessionId
        }
        const shouldPreallocateFreshClaudeSession =
          m.mode === 'claude'
          && m.restore !== true
          && !requestedSessionRef
          && !m.resumeSessionId
        if (shouldPreallocateFreshClaudeSession) {
          effectiveResumeSessionId = this.reserveClaudeFreshSessionId(state, m.requestId)
          sessionBindingReason = 'start'
          recordSessionLifecycleEvent({
            kind: 'claude_fresh_session_preallocated',
            requestId: m.requestId,
            connectionId: ws.connectionId || 'unknown',
            sessionId: effectiveResumeSessionId,
            ...(m.tabId ? { tabId: m.tabId } : {}),
            ...(m.paneId ? { paneId: m.paneId } : {}),
            ...(m.cwd ? { cwd: m.cwd } : {}),
          })
        } else if (effectiveResumeSessionId && m.mode === 'claude') {
          sessionBindingReason = 'resume'
        }
        if (codexRestorePlan?.kind === 'reject_invalid_raw_codex_resume_request') {
          error = true
          this.sendError(ws, {
            code: codexRestorePlan.code,
            message: codexRestorePlan.message,
            requestId: m.requestId,
          })
          endCreateTimer({ error, rateLimited })
          return
        }
        if (
          m.restore === true
          && modeSupportsResume(m.mode as TerminalMode)
          && !hasReusableRequestedLiveTerminal
          && m.mode !== 'codex'
          && m.resumeSessionId
          && !requestedSessionRef
        ) {
          error = true
          this.sendError(ws, {
            code: 'INVALID_MESSAGE',
            message: 'Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity.',
            requestId: m.requestId,
          })
          endCreateTimer({ error, rateLimited })
          return
        }
        if (
          m.restore === true
          && modeSupportsResume(m.mode as TerminalMode)
          && !hasReusableRequestedLiveTerminal
          && (
            !requestedSessionRef
            || requestedSessionRef.provider !== m.mode
            || (m.mode === 'claude' && !isValidClaudeSessionId(requestedSessionRef.sessionId))
          )
        ) {
          error = true
          recordSessionLifecycleEvent({
            kind: 'restore_unavailable',
            requestId: m.requestId,
            connectionId: ws.connectionId || 'unknown',
            ...(m.tabId ? { tabId: m.tabId } : {}),
            ...(m.paneId ? { paneId: m.paneId } : {}),
            mode: m.mode as TerminalMode,
            reason: 'missing_canonical_session_id',
            restoreRequested: true,
            hasSessionRef: !!requestedSessionRef,
          })
          this.sendError(ws, {
            code: 'RESTORE_UNAVAILABLE',
            message: 'Restore requires a canonical session reference.',
            requestId: m.requestId,
          })
          endCreateTimer({ error, rateLimited })
          return
        }
        try {
          await this.withTerminalCreateLock(
            this.terminalCreateLockKey(m.mode as TerminalMode, m.requestId, effectiveResumeSessionId),
            async () => {
              const resolveExistingRequestBinding = (
                requestId: string,
              ): CreatedTerminalRequestBinding | typeof REPAIR_PENDING_SENTINEL | undefined => {
                const local = state.createdByRequestId.get(requestId)
                if (local === REPAIR_PENDING_SENTINEL) return REPAIR_PENDING_SENTINEL
                if (local) return this.createdRequestBindingMatchesExpectedSession(local, expectedSessionKey) ? local : undefined
                const cached = this.resolveCreatedTerminalBinding(requestId, expectedSessionKey)
                if (cached) {
                  state.createdByRequestId.set(requestId, cached)
                }
                return cached
              }

              const sendCreateResult = async (opts: {
                ws: LiveWebSocket
                requestId: string
                record: TerminalRecord
                clearCodexDurability?: boolean
                restoreError?: RestoreError
              }): Promise<boolean> => {
                if (opts.ws.readyState !== WebSocket.OPEN) {
                  return false
                }

                const sessionRef = buildTerminalSessionRef(opts.record)
                this.send(opts.ws, {
                  type: 'terminal.created',
                  requestId: opts.requestId,
                  terminalId: opts.record.terminalId,
                  createdAt: opts.record.createdAt,
                  ...(opts.record.cwd ? { cwd: opts.record.cwd } : {}),
                  ...(sessionRef ? { sessionRef } : {}),
                  ...(opts.clearCodexDurability ? { clearCodexDurability: true } : {}),
                  ...(opts.restoreError ? { restoreError: opts.restoreError } : {}),
                })
                return true
              }

              const attachReusedTerminal = async (
                record: TerminalRecord,
                opts: { reuseSource: string; allowCodexWithoutExpectedSession?: boolean },
              ): Promise<boolean> => {
                if (
                  expectedSessionRef
                  && !terminalMatchesExpectedSession(record, expectedSessionRef)
                ) {
                  log.warn({
                    requestId: m.requestId,
                    connectionId: ws.connectionId,
                    terminalId: record.terminalId,
                    reuseSource: opts.reuseSource,
                    ...buildSessionIdentityMismatchDetails(record, expectedSessionRef),
                  }, 'Ignoring terminal reuse candidate with mismatched canonical session identity')
                  return false
                }
                if (
                  m.mode === 'codex'
                  && !expectedSessionRef
                  && !opts.allowCodexWithoutExpectedSession
                ) {
                  log.warn({
                    requestId: m.requestId,
                    connectionId: ws.connectionId,
                    terminalId: record.terminalId,
                    reuseSource: opts.reuseSource,
                  }, 'Ignoring Codex terminal reuse candidate without a canonical expected session')
                  return false
                }
                const sent = await sendCreateResult({
                  ws,
                  requestId: m.requestId,
                  record,
                })
                if (!sent) {
                  return false
                }
                const binding = {
                  terminalId: record.terminalId,
                  ...(expectedSessionKey ? { expectedSessionKey } : {}),
                }
                state.createdByRequestId.set(m.requestId, binding)
                this.rememberCreatedRequestId(m.requestId, record.terminalId, expectedSessionKey)
                terminalId = record.terminalId
                reused = true
                const sessionRef = buildTerminalSessionRef(record)
                recordSessionLifecycleEvent({
                  kind: 'terminal_created',
                  requestId: m.requestId,
                  connectionId: ws.connectionId || 'unknown',
                  terminalId: record.terminalId,
                  ...(m.tabId ? { tabId: m.tabId } : {}),
                  ...(m.paneId ? { paneId: m.paneId } : {}),
                  ...(m.cwd ? { cwd: m.cwd } : {}),
                  mode: m.mode as TerminalMode,
                  reused: true,
                  hasSessionRef: !!sessionRef,
                })
                this.broadcastTerminalsChanged()
                return true
              }
              const requestedLiveTerminal = (): TerminalRecord | undefined => {
                if (m.liveTerminal?.serverInstanceId !== this.serverInstanceId) return undefined
                const live = this.registry.get(m.liveTerminal.terminalId)
                return live && live.status === 'running' && live.mode === m.mode ? live : undefined
              }

              const existingBinding = resolveExistingRequestBinding(m.requestId)
              if (existingBinding) {
                if (existingBinding === REPAIR_PENDING_SENTINEL) {
                  log.debug({ requestId: m.requestId, connectionId: ws.connectionId },
                    'terminal.create already in progress (repair pending), ignoring duplicate')
                  return
                }
                const existing = this.registry.get(existingBinding.terminalId)
                if (existing) {
                  const attached = await attachReusedTerminal(existing, {
                    reuseSource: 'request_id_cache',
                    allowCodexWithoutExpectedSession: true,
                  })
                  if (attached) return
                }
                // If it no longer exists, fall through and create a new one.
                state.createdByRequestId.delete(m.requestId)
                this.forgetCreatedRequestId(m.requestId)
              }
              if (m.mode === 'codex') {
                const decision = await resolveCodexCreateRestoreDecision({
                  restoreRequested: m.restore === true,
                  legacyResumeSessionId: m.resumeSessionId,
                  sessionRef: expectedSessionRef,
                  codexDurability: codexDurabilityForDecision,
                })

                if (
                  decision.kind === 'reject_invalid_raw_codex_resume_request'
                  || decision.kind === 'reject_missing_codex_session_ref'
                ) {
                  error = true
                  this.sendError(ws, {
                    code: decision.code,
                    message: decision.message,
                    requestId: m.requestId,
                  })
                  return
                }

                if (decision.kind === 'durable_session_ref_resume') {
                  effectiveResumeSessionId = decision.sessionId
                } else if (decision.kind === 'fresh_codex_launch') {
                  effectiveResumeSessionId = undefined
                }
              }

              const live = requestedLiveTerminal()
              if (live) {
                const attached = await attachReusedTerminal(live, {
                  reuseSource: 'requested_live_terminal',
                })
                if (attached) return
              }

              if (modeSupportsResume(m.mode as TerminalMode) && effectiveResumeSessionId) {
                let existing = this.registry.getCanonicalRunningTerminalBySession(
                  m.mode as TerminalMode,
                  effectiveResumeSessionId,
                  m.cwd,
                )
                if (!existing) {
                  this.registry.repairLegacySessionOwners(
                    m.mode as TerminalMode,
                    effectiveResumeSessionId,
                    m.cwd,
                  )
                  existing = this.registry.getCanonicalRunningTerminalBySession(
                    m.mode as TerminalMode,
                    effectiveResumeSessionId,
                    m.cwd,
                  )
                }
                if (existing) {
                  const attached = await attachReusedTerminal(existing, {
                    reuseSource: 'canonical_session_owner',
                  })
                  if (attached) return
                }
              }

              const cfg = await awaitConfig()
              const providerSettings = m.mode !== 'shell'
                ? cfg.settings?.codingCli?.providers?.[m.mode as keyof typeof cfg.settings.codingCli.providers] || {}
                : undefined

              // Re-check idempotency after async config loading in case another create won the race.
              const existingAfterConfigBinding = resolveExistingRequestBinding(m.requestId)
              if (existingAfterConfigBinding) {
                if (existingAfterConfigBinding === REPAIR_PENDING_SENTINEL) {
                  log.debug({ requestId: m.requestId, connectionId: ws.connectionId },
                    'terminal.create already in progress (repair pending), ignoring duplicate')
                  return
                }
                const existing = this.registry.get(existingAfterConfigBinding.terminalId)
                if (existing) {
                  const attached = await attachReusedTerminal(existing, {
                    reuseSource: 'request_id_cache_after_config',
                    allowCodexWithoutExpectedSession: true,
                  })
                  if (attached) return
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
                  m.cwd,
                )
                if (!existing) {
                  this.registry.repairLegacySessionOwners(
                    m.mode as TerminalMode,
                    effectiveResumeSessionId,
                    m.cwd,
                  )
                  existing = this.registry.getCanonicalRunningTerminalBySession(
                    m.mode as TerminalMode,
                    effectiveResumeSessionId,
                    m.cwd,
                  )
                }
                if (existing) {
                  const attached = await attachReusedTerminal(existing, {
                    reuseSource: 'canonical_session_owner_after_config',
                  })
                  if (attached) return
                }
              }

              // Session repair is Claude-specific (uses JSONL session files).
              // Other providers (codex, opencode, etc.) don't use the same file
              // structure, so this block correctly remains gated on mode === 'claude'.
              if (
                m.mode === 'claude'
                && sessionBindingReason !== 'start'
                && effectiveResumeSessionId
                && isValidClaudeSessionId(effectiveResumeSessionId)
                && this.sessionRepairService
              ) {
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

              const requestedCodexResumeSessionId = m.mode === 'codex'
                ? effectiveResumeSessionId
                : undefined
              this.assertTerminalCreateAccepted()
              const codexPlan = m.mode === 'codex'
                ? await this.planCodexLaunch(
                  m.cwd,
                  requestedCodexResumeSessionId,
                  providerSettings,
                  CODEX_INITIAL_LAUNCH_ATTEMPTS,
                )
                : undefined
              pendingCodexPlan = codexPlan

              this.assertTerminalCreateAccepted()

              const codexRecovery = codexPlan
                ? {
                    planCreate: (input: { cwd?: string; resumeSessionId: string }) =>
                      this.planCodexLaunch(input.cwd ?? m.cwd, input.resumeSessionId, providerSettings),
                  }
                : undefined

              const spawnProviderSettings = (
                providerSettings
                  ? {
                    ...(m.mode === 'codex'
                      ? {}
                      : {
                        permissionMode: providerSettings.permissionMode,
                        model: providerSettings.model,
                        sandbox: providerSettings.sandbox,
                      }),
                    ...(m.mode === 'opencode'
                      ? { opencodeServer: await allocateLocalhostPort() }
                      : {}),
                    ...(codexPlan ? {
                      codexAppServer: {
                        ...codexPlan.remote,
                        sidecar: codexPlan.sidecar,
                        recovery: codexRecovery,
                        deferLifecycleUntilPublished: true,
                      },
                    } : {}),
                  }
                  : (codexPlan
                    ? {
                      codexAppServer: {
                        ...codexPlan.remote,
                        sidecar: codexPlan.sidecar,
                        recovery: codexRecovery,
                        deferLifecycleUntilPublished: true,
                      },
                    }
                    : undefined)
              )

              this.assertTerminalCreateAccepted()
              const terminalSessionBindingReason = codexPlan
                ? getCodexSessionBindingReason(m.mode, requestedCodexResumeSessionId)
                : sessionBindingReason
              const record = this.registry.create({
                mode: m.mode as TerminalMode,
                shell: m.shell as 'system' | 'cmd' | 'powershell' | 'wsl',
                cwd: m.cwd,
                resumeSessionId: effectiveResumeSessionId,
                ...(terminalSessionBindingReason ? { sessionBindingReason: terminalSessionBindingReason } : {}),
                envContext: { tabId: m.tabId, paneId: m.paneId },
                providerSettings: spawnProviderSettings,
              })
              terminalId = record.terminalId
              this.assertTerminalCreateAccepted()
              if (codexPlan) {
                await codexPlan.sidecar.adopt({ terminalId: record.terminalId, generation: 0 })
                this.assertTerminalCreateAccepted()
                assertCodexCreateTerminalRunning(record)
                this.assertTerminalCreateAccepted()
                this.registry.publishCodexSidecar?.(record.terminalId)
                pendingCodexPlan = undefined
                if (effectiveResumeSessionId) {
                  recordSessionLifecycleEvent({
                    kind: 'codex_durable_resume_started',
                    provider: 'codex',
                    terminalId: record.terminalId,
                    sessionId: effectiveResumeSessionId,
                    generation: 0,
                    source: 'sidecar',
                  })
                }
              }
              this.assertTerminalCreateAccepted()

              if (m.mode !== 'shell' && typeof m.cwd === 'string' && m.cwd.trim()) {
                const recentDirectory = m.cwd.trim()
                void configStore.pushRecentDirectory(recentDirectory).catch((err) => {
                  log.warn({ err, recentDirectory }, 'Failed to record recent directory')
                })
              }

              const createdBinding = {
                terminalId: record.terminalId,
                ...(expectedSessionKey ? { expectedSessionKey } : {}),
              }
              state.createdByRequestId.set(m.requestId, createdBinding)
              this.rememberCreatedRequestId(m.requestId, record.terminalId, expectedSessionKey)

              const sent = await sendCreateResult({
                ws,
                requestId: m.requestId,
                record,
              })
              if (!sent) {
                // Terminal may still exist even if created delivery failed (for
                // example: socket closed after create). Broadcast inventory so
                // other clients can discover it.
                this.broadcastTerminalsChanged()
                return
              }
              recordSessionLifecycleEvent({
                kind: 'terminal_created',
                requestId: m.requestId,
                connectionId: ws.connectionId || 'unknown',
                terminalId: record.terminalId,
                ...(m.tabId ? { tabId: m.tabId } : {}),
                ...(m.paneId ? { paneId: m.paneId } : {}),
                ...(m.cwd ? { cwd: m.cwd } : {}),
                mode: m.mode as TerminalMode,
                reused: false,
                hasSessionRef: !!effectiveResumeSessionId,
              })

              // Notify all clients that list changed
              this.broadcastTerminalsChanged()
            },
          )
        } catch (err: any) {
          error = true
          const cleanupErrors: string[] = []
          const cleanupTerminalId = terminalId ?? terminalIdFromCreateError(err)
          if (typeof cleanupTerminalId === 'string') {
            await this.registry.killAndWait(cleanupTerminalId).catch((killErr) => {
              cleanupErrors.push(`created terminal cleanup failed: ${errorMessage(killErr)}`)
              log.warn({ err: killErr, terminalId: cleanupTerminalId }, 'terminal.create cleanup failed')
            })
          }
          if (pendingCodexPlan) {
            await pendingCodexPlan.sidecar.shutdown().catch((shutdownErr) => {
              cleanupErrors.push(`Codex sidecar cleanup failed: ${errorMessage(shutdownErr)}`)
              log.warn({ err: shutdownErr }, 'terminal.create pending Codex sidecar cleanup failed')
            })
          }
          const errorMessageText = cleanupErrors.length > 0
            ? `${err?.message || 'Failed to spawn PTY'}; cleanup failed: ${cleanupErrors.join('; ')}`
            : err?.message || 'Failed to spawn PTY'
          // Clean up repair sentinel if terminal creation failed
          if (state.createdByRequestId.get(m.requestId) === REPAIR_PENDING_SENTINEL) {
            state.createdByRequestId.delete(m.requestId)
          }
          log.warn({ err, connectionId: ws.connectionId }, 'terminal.create failed')
          this.sendError(ws, {
            code: err instanceof CodexLaunchConfigError
              ? 'INVALID_MESSAGE'
              : err instanceof TerminalCreateAdmissionError
                ? 'INTERNAL_ERROR'
                : 'PTY_SPAWN_FAILED',
            message: errorMessageText,
            requestId: m.requestId,
          })
        } finally {
          endCreateTimer({ terminalId, reused, error, rateLimited })
        }
        return
      }

      case 'terminal.attach': {
        if (!isTerminalStreamAttachRequestIdWithinSerializedBudget(m.attachRequestId)) {
          this.sendError(ws, {
            code: 'INVALID_MESSAGE',
            message: 'attachRequestId exceeds terminal output serialized application JSON byte budget',
            terminalId: m.terminalId,
          })
          return
        }

        const record = this.registry.get(m.terminalId)
        const expectedSessionRef = normalizeUiSessionLocator(m.expectedSessionRef)
        if (!record) {
          recordSessionLifecycleEvent({
            kind: 'invalid_terminal_id_without_session_ref',
            terminalId: m.terminalId,
            connectionId: ws.connectionId || 'unknown',
            operation: 'terminal.attach',
          })
          this.sendError(ws, {
            code: 'INVALID_TERMINAL_ID',
            message: 'Terminal not running',
            requestId: m.attachRequestId,
            terminalId: m.terminalId,
          })
          return
        }
        if (record.status !== 'running') {
          recordSessionLifecycleEvent({
            kind: 'invalid_terminal_id_without_session_ref',
            terminalId: m.terminalId,
            connectionId: ws.connectionId || 'unknown',
            operation: 'terminal.attach',
          })
          this.sendError(ws, {
            code: 'INVALID_TERMINAL_ID',
            message: formatExitedTerminalAttachMessage(record),
            requestId: m.attachRequestId,
            terminalId: m.terminalId,
          })
          return
        }
        if (expectedSessionRef && !terminalMatchesExpectedSession(record, expectedSessionRef)) {
          this.sendSessionIdentityMismatch(ws, {
            operation: 'terminal.attach',
            requestId: m.attachRequestId,
            terminalId: record.terminalId,
            expectedSessionRef,
            record,
          })
          return
        }

        const attachBroker = this.terminalStreamBroker as {
          attach: (
            ws: LiveWebSocket,
            terminalId: string,
            intent: 'viewport_hydrate' | 'keepalive_delta' | 'transport_reconnect',
            cols: number,
            rows: number,
            sinceSeq: number | undefined,
            attachRequestId?: string,
            maxReplayBytes?: number,
            priority?: 'foreground' | 'background',
            terminalOutputBatchV1?: boolean,
          ) => Promise<any>
          attachWithExpectedSession?: (
            ws: LiveWebSocket,
            terminalId: string,
            intent: 'viewport_hydrate' | 'keepalive_delta' | 'transport_reconnect',
            cols: number,
            rows: number,
            sinceSeq: number | undefined,
            expectedSessionRef: { provider: string; sessionId: string } | undefined,
            attachRequestId?: string,
            maxReplayBytes?: number,
            priority?: 'foreground' | 'background',
            terminalOutputBatchV1?: boolean,
          ) => Promise<any>
        }
        const attachResult = typeof attachBroker.attachWithExpectedSession === 'function'
          ? await attachBroker.attachWithExpectedSession(
            ws,
            m.terminalId,
            m.intent,
            m.cols,
            m.rows,
            m.sinceSeq,
            expectedSessionRef,
            m.attachRequestId,
            m.maxReplayBytes,
            m.priority ?? 'foreground',
            state.supportsTerminalOutputBatchV1,
          )
          : await attachBroker.attach(
            ws,
            m.terminalId,
            m.intent,
            m.cols,
            m.rows,
            m.sinceSeq,
            m.attachRequestId,
            m.maxReplayBytes,
            m.priority ?? 'foreground',
            state.supportsTerminalOutputBatchV1,
          )
        if (attachResult === 'invalid_attach_request_id') {
          this.sendError(ws, {
            code: 'INVALID_MESSAGE',
            message: 'attachRequestId exceeds terminal output serialized application JSON byte budget',
            terminalId: m.terminalId,
          })
          return
        }
        if (attachResult === 'missing') {
          const latestRecord = this.registry.get(m.terminalId)
          if (latestRecord && latestRecord.status !== 'running') {
            recordSessionLifecycleEvent({
              kind: 'invalid_terminal_id_without_session_ref',
              terminalId: m.terminalId,
              connectionId: ws.connectionId || 'unknown',
              operation: 'terminal.attach',
            })
            this.sendError(ws, {
              code: 'INVALID_TERMINAL_ID',
              message: formatExitedTerminalAttachMessage(latestRecord),
              requestId: m.attachRequestId,
              terminalId: m.terminalId,
            })
            return
          }
          recordSessionLifecycleEvent({
            kind: 'invalid_terminal_id_without_session_ref',
            terminalId: m.terminalId,
            connectionId: ws.connectionId || 'unknown',
            operation: 'terminal.attach',
          })
          this.sendError(ws, {
            code: 'INVALID_TERMINAL_ID',
            message: 'Unknown terminalId',
            requestId: m.attachRequestId,
            terminalId: m.terminalId,
          })
          return
        }
        if (typeof attachResult === 'object' && attachResult.status === 'session_identity_mismatch') {
          if (expectedSessionRef) {
            this.sendSessionIdentityMismatch(ws, {
              operation: 'terminal.attach',
              requestId: m.attachRequestId,
              terminalId: m.terminalId,
              expectedSessionRef,
              record: this.registry.get(m.terminalId) ?? record,
            })
          }
          return
        }
        if (attachResult === 'duplicate') return
        state.attachedTerminalIds.add(m.terminalId)
        return
      }

      case 'terminal.detach': {
        const ok = this.terminalStreamBroker.detach(m.terminalId, ws)
        state.attachedTerminalIds.delete(m.terminalId)
        if (!ok) {
          if (!this.registry.get(m.terminalId)) {
            recordSessionLifecycleEvent({
              kind: 'invalid_terminal_id_without_session_ref',
              terminalId: m.terminalId,
              connectionId: ws.connectionId || 'unknown',
              operation: 'terminal.detach',
            })
          }
          this.sendError(ws, { code: 'INVALID_TERMINAL_ID', message: 'Unknown terminalId', terminalId: m.terminalId })
          return
        }
        this.send(ws, { type: 'terminal.detached', terminalId: m.terminalId })
        return
      }

      case 'terminal.input': {
        const expectedSessionRef = normalizeUiSessionLocator(m.expectedSessionRef)
        const result = typeof this.registry.inputIfSessionMatches === 'function'
          ? this.registry.inputIfSessionMatches(m.terminalId, m.data, expectedSessionRef)
          : this.registry.input(m.terminalId, m.data)
        if (result.status === 'session_identity_mismatch') {
          const record = this.registry.get(m.terminalId)
          if (record && expectedSessionRef) {
            this.sendSessionIdentityMismatch(ws, {
              operation: 'terminal.input',
              terminalId: m.terminalId,
              expectedSessionRef,
              record,
              attemptedInputBytes: Buffer.byteLength(m.data, 'utf8'),
            })
            return
          }
        }
        if (result.status === 'blocked_codex_identity_pending') {
          log.debug({
            terminalId: m.terminalId,
            connectionId: ws.connectionId,
            attemptedInputBytes: Buffer.byteLength(m.data, 'utf8'),
          }, 'Codex terminal input blocked until restore identity is captured')
          this.send(ws, {
            type: 'terminal.input.blocked',
            terminalId: m.terminalId,
            reason: 'codex_identity_pending',
          })
          return
        }
        if (result.status === 'blocked_codex_identity_capture_timeout') {
          log.warn({
            terminalId: m.terminalId,
            connectionId: ws.connectionId,
            attemptedInputBytes: Buffer.byteLength(m.data, 'utf8'),
          }, 'Codex terminal input blocked after restore identity capture timed out')
          this.send(ws, {
            type: 'terminal.input.blocked',
            terminalId: m.terminalId,
            reason: 'codex_identity_capture_timeout',
          })
          return
        }
        if (result.status === 'blocked_codex_identity_unavailable') {
          log.warn({
            terminalId: m.terminalId,
            connectionId: ws.connectionId,
            attemptedInputBytes: Buffer.byteLength(m.data, 'utf8'),
            reason: result.reason,
          }, 'Codex terminal input blocked because restore identity is unavailable')
          this.send(ws, {
            type: 'terminal.input.blocked',
            terminalId: m.terminalId,
            reason: 'codex_identity_unavailable',
          })
          return
        }
        if (result.status === 'blocked_codex_recovery_pending') {
          log.debug({
            terminalId: m.terminalId,
            connectionId: ws.connectionId,
            attemptedInputBytes: Buffer.byteLength(m.data, 'utf8'),
          }, 'Codex terminal input blocked while durable recovery is in progress')
          this.send(ws, {
            type: 'terminal.input.blocked',
            terminalId: m.terminalId,
            reason: 'codex_recovery_pending',
          })
          return
        }
        if (result.status === 'blocked_codex_clean_exit_decision_pending') {
          log.debug({
            terminalId: m.terminalId,
            connectionId: ws.connectionId,
            attemptedInputBytes: Buffer.byteLength(m.data, 'utf8'),
          }, 'Codex terminal input blocked while clean exit state is being resolved')
          this.send(ws, {
            type: 'terminal.input.blocked',
            terminalId: m.terminalId,
            reason: 'codex_clean_exit_decision_pending',
          })
          return
        }
        if (result.status === 'blocked_codex_lifecycle_loss_pending') {
          log.debug({
            terminalId: m.terminalId,
            connectionId: ws.connectionId,
            attemptedInputBytes: Buffer.byteLength(m.data, 'utf8'),
          }, 'Codex terminal input blocked while lifecycle loss is being resolved')
          this.send(ws, {
            type: 'terminal.input.blocked',
            terminalId: m.terminalId,
            reason: 'codex_lifecycle_loss_pending',
          })
          return
        }
        if (result.status !== 'written') {
          if (result.status === 'no_terminal') {
            recordSessionLifecycleEvent({
              kind: 'invalid_terminal_id_without_session_ref',
              terminalId: m.terminalId,
              connectionId: ws.connectionId || 'unknown',
              operation: 'terminal.input',
              attemptedInputBytes: typeof m.data === 'string' ? Buffer.byteLength(m.data) : 0,
            })
          }
          this.sendError(ws, { code: 'INVALID_TERMINAL_ID', message: 'Terminal not running', terminalId: m.terminalId })
        }
        return
      }

      case 'terminal.codex.candidate.persisted': {
        const result = this.registry.acknowledgeCodexCandidatePersisted(m)
        if (result !== 'accepted') {
          log.warn({
            terminalId: m.terminalId,
            candidateThreadId: m.candidateThreadId,
            rolloutPath: m.rolloutPath,
            connectionId: ws.connectionId,
            reason: result,
          }, 'Received Codex candidate persisted acknowledgement that did not match server state')
        }
        return
      }

      case 'terminal.resize': {
        const expectedSessionRef = normalizeUiSessionLocator(m.expectedSessionRef)
        const result = typeof this.registry.resizeIfSessionMatches === 'function'
          ? this.registry.resizeIfSessionMatches(m.terminalId, m.cols, m.rows, expectedSessionRef)
          : (this.registry.resize(m.terminalId, m.cols, m.rows)
              ? { status: 'resized' as const }
              : { status: 'missing' as const })
        if (result.status === 'session_identity_mismatch') {
          const record = this.registry.get(m.terminalId)
          if (record && expectedSessionRef) {
            this.sendSessionIdentityMismatch(ws, {
              operation: 'terminal.resize',
              terminalId: m.terminalId,
              expectedSessionRef,
              record,
            })
            return
          }
        }
        if (result.status !== 'resized' && result.status !== 'unchanged') {
          if (!this.registry.get(m.terminalId)) {
            recordSessionLifecycleEvent({
              kind: 'invalid_terminal_id_without_session_ref',
              terminalId: m.terminalId,
              connectionId: ws.connectionId || 'unknown',
              operation: 'terminal.resize',
            })
          }
          this.sendError(ws, { code: 'INVALID_TERMINAL_ID', message: 'Terminal not running', terminalId: m.terminalId })
        } else {
          this.terminalStreamBroker.recordResize(m.terminalId, ws, m.cols, m.rows)
        }
        return
      }

      case 'terminal.kill': {
        let ok: boolean
        try {
          ok = await this.registry.killAndWait(m.terminalId)
        } catch (err) {
          log.warn({ err, terminalId: m.terminalId, connectionId: ws.connectionId }, 'terminal.kill failed')
          this.sendError(ws, {
            code: 'INTERNAL_ERROR',
            message: `Failed to kill terminal: ${errorMessage(err)}`,
            terminalId: m.terminalId,
          })
          return
        }
        if (!ok) {
          recordSessionLifecycleEvent({
            kind: 'invalid_terminal_id_without_session_ref',
            terminalId: m.terminalId,
            connectionId: ws.connectionId || 'unknown',
            operation: 'terminal.kill',
          })
          this.sendError(ws, { code: 'INVALID_TERMINAL_ID', message: 'Unknown terminalId', terminalId: m.terminalId })
          return
        }
        this.broadcastTerminalsChanged()
        return
      }

      case 'codex.activity.list': {
        const terminals = this.codexActivityListProvider ? this.codexActivityListProvider() : []
        const latestTurnCompletions = this.codexLatestTurnCompletionsProvider ? this.codexLatestTurnCompletionsProvider() : []
        const response = CodexActivityListResponseSchema.safeParse({
          type: 'codex.activity.list.response',
          requestId: m.requestId,
          terminals,
          latestTurnCompletions,
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

      case 'opencode.activity.list': {
        const terminals = this.opencodeActivityListProvider ? this.opencodeActivityListProvider() : []
        const latestTurnCompletions = this.opencodeLatestTurnCompletionsProvider ? this.opencodeLatestTurnCompletionsProvider() : []
        const response = OpencodeActivityListResponseSchema.safeParse({
          type: 'opencode.activity.list.response',
          requestId: m.requestId,
          terminals,
          latestTurnCompletions,
        })
        if (!response.success) {
          log.warn({ issues: response.error.issues }, 'Invalid opencode.activity.list.response payload')
          this.sendError(ws, {
            code: 'INTERNAL_ERROR',
            message: 'OpenCode activity unavailable',
            requestId: m.requestId,
          })
          return
        }
        this.send(ws, response.data)
        return
      }

      case 'claude.activity.list': {
        const terminals = this.claudeActivityListProvider ? this.claudeActivityListProvider() : []
        const latestTurnCompletions = this.claudeLatestTurnCompletionsProvider ? this.claudeLatestTurnCompletionsProvider() : []
        const response = ClaudeActivityListResponseSchema.safeParse({
          type: 'claude.activity.list.response',
          requestId: m.requestId,
          terminals,
          latestTurnCompletions,
        })
        if (!response.success) {
          log.warn({ issues: response.error.issues }, 'Invalid claude.activity.list.response payload')
          this.sendError(ws, {
            code: 'INTERNAL_ERROR',
            message: 'Claude activity unavailable',
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
        try {
          const result = await this.tabsRegistryStore.replaceClientSnapshot({
            deviceId: m.deviceId,
            deviceLabel: m.deviceLabel,
            clientInstanceId: m.clientInstanceId,
            snapshotRevision: m.snapshotRevision,
            records: m.records.map((record: TabsSyncPushRecord) => ({
              ...record,
              serverInstanceId: this.serverInstanceId,
              deviceId: m.deviceId,
              deviceLabel: m.deviceLabel,
            })),
          })
          this.send(ws, {
            type: 'tabs.sync.ack',
            accepted: result.accepted,
            openRecords: result.openRecords,
            closedRecords: result.closedRecords,
          })
        } catch (error) {
          this.sendError(ws, {
            code: 'INVALID_MESSAGE',
            message: error instanceof Error ? error.message : String(error),
          })
        }
        return
      }

      case 'tabs.sync.client.retire': {
        if (!this.tabsRegistryStore) {
          this.sendError(ws, {
            code: 'INTERNAL_ERROR',
            message: 'Tabs registry unavailable',
          })
          return
        }
        try {
          await this.tabsRegistryStore.retireClientSnapshot({
            deviceId: m.deviceId,
            clientInstanceId: m.clientInstanceId,
            snapshotRevision: m.snapshotRevision,
          })
        } catch (error) {
          this.sendError(ws, {
            code: 'INVALID_MESSAGE',
            message: error instanceof Error ? error.message : String(error),
          })
        }
        return
      }

      case 'tabs.sync.query': {
        if (!this.tabsRegistryStore) {
          this.sendError(ws, {
            code: 'INTERNAL_ERROR',
            message: 'Tabs registry unavailable',
            requestId: m.requestId,
          })
          return
        }
        try {
          const data = await this.tabsRegistryStore.query({
            deviceId: m.deviceId,
            clientInstanceId: m.clientInstanceId,
            closedTabRetentionDays: m.closedTabRetentionDays,
          })
          this.send(ws, {
            type: 'tabs.sync.snapshot',
            requestId: m.requestId,
            data,
          })
        } catch (error) {
          this.sendError(ws, {
            code: 'INVALID_MESSAGE',
            message: error instanceof Error ? error.message : String(error),
            requestId: m.requestId,
          })
        }
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

      case 'freshAgent.create': {
        const manager = this.freshAgentRuntimeManager
        if (!manager) {
          this.send(ws, {
            type: 'freshAgent.create.failed',
            requestId: m.requestId,
            code: 'FRESH_AGENT_RUNTIME_UNAVAILABLE',
            message: this.freshAgentUnavailableMessage(),
            retryable: false,
          })
          return
        }

        await this.withFreshAgentCreateLock(m.requestId, async () => {
          const cached = this.createdFreshAgentByRequestId.get(m.requestId)
          if (cached) {
            this.authorizeFreshAgentSession(state, {
              sessionId: cached.sessionId,
              sessionType: cached.sessionType,
              provider: cached.runtimeProvider,
            })
            this.send(ws, {
              type: 'freshAgent.created',
              requestId: m.requestId,
              ...cached,
            })
            this.ensureFreshAgentSubscription(ws, state, {
              sessionId: cached.sessionId,
              sessionType: cached.sessionType,
              provider: cached.runtimeProvider,
            })
            return
          }

          const cfg = await awaitConfig()
          if (!this.freshClientsEnabled(cfg.settings)) {
            this.send(ws, {
              type: 'freshAgent.create.failed',
              requestId: m.requestId,
              code: 'FRESH_CLIENTS_DISABLED',
              message: 'Fresh clients are disabled',
              retryable: true,
            })
            return
          }

          try {
            const result = await manager.create({
              requestId: m.requestId,
              sessionType: m.sessionType,
              provider: m.provider,
              cwd: m.cwd,
              legacyRestoreContext: m.legacyRestoreContext,
              resumeSessionId: m.resumeSessionId,
              sessionRef: m.sessionRef,
              model: m.model,
              modelSelection: m.modelSelection ?? undefined,
              permissionMode: m.permissionMode,
              sandbox: m.sandbox,
              effort: m.effort,
              plugins: m.plugins,
            })
            const runtimeProvider = typeof result?.runtimeProvider === 'string'
              ? result.runtimeProvider
              : m.provider
            if (!runtimeProvider) {
              throw new Error('Fresh Agent runtime provider was not resolved')
            }
            const record: FreshAgentCreatedRecord = {
              sessionId: result.sessionId,
              sessionType: result.sessionType ?? m.sessionType,
              provider: runtimeProvider,
              runtimeProvider,
              ...(result.sessionRef ? { sessionRef: result.sessionRef } : {}),
            }
            this.createdFreshAgentByRequestId.set(m.requestId, record)
            this.authorizeFreshAgentSession(state, {
              sessionId: record.sessionId,
              sessionType: record.sessionType,
              provider: record.runtimeProvider,
            })
            this.send(ws, {
              type: 'freshAgent.created',
              requestId: m.requestId,
              ...record,
            })
            this.ensureFreshAgentSubscription(ws, state, {
              sessionId: record.sessionId,
              sessionType: record.sessionType,
              provider: record.runtimeProvider,
            })
          } catch (error) {
            log.warn({
              err: error instanceof Error ? error : new Error(String(error)),
              requestId: m.requestId,
              sessionType: m.sessionType,
              provider: m.provider,
            }, 'freshAgent.create failed')
            const code = typeof (error as { code?: unknown })?.code === 'string'
              ? (error as { code: string }).code
              : 'FRESH_AGENT_CREATE_FAILED'
            this.send(ws, {
              type: 'freshAgent.create.failed',
              requestId: m.requestId,
              code,
              message: errorMessage(error),
              retryable: true,
            })
          }
        })
        return
      }

      case 'freshAgent.attach': {
        const manager = this.freshAgentRuntimeManager
        if (!manager) {
          this.sendError(ws, { code: 'INTERNAL_ERROR', message: this.freshAgentUnavailableMessage() })
          return
        }
        const locator = { sessionId: m.sessionId, sessionType: m.sessionType, provider: m.provider }
        try {
          await Promise.resolve(manager.attach(locator))
          this.authorizeFreshAgentSession(state, locator)
          this.ensureFreshAgentSubscription(ws, state, locator)
        } catch (error) {
          log.warn({
            err: error instanceof Error ? error : new Error(String(error)),
            ...locator,
          }, 'freshAgent.attach failed')
          this.sendError(ws, { code: 'INTERNAL_ERROR', message: errorMessage(error) })
        }
        return
      }

      case 'freshAgent.send': {
        const manager = this.freshAgentRuntimeManager
        if (!manager?.send) {
          this.sendError(ws, { code: 'INTERNAL_ERROR', message: this.freshAgentUnavailableMessage() })
          return
        }
        const locator = { sessionId: m.sessionId, sessionType: m.sessionType, provider: m.provider }
        if (!this.requireFreshAgentAuthorization(ws, state, locator)) return
        try {
          const result = await manager.send(locator, { text: m.text, images: m.images, settings: m.settings })
          if (result?.sessionId && result.sessionId !== m.sessionId) {
            this.authorizeFreshAgentSession(state, {
              sessionId: result.sessionId,
              sessionType: m.sessionType,
              provider: m.provider,
            })
            this.ensureFreshAgentSubscription(ws, state, {
              sessionId: result.sessionId,
              sessionType: m.sessionType,
              provider: m.provider,
            })
            this.send(ws, {
              type: 'freshAgent.session.materialized',
              previousSessionId: m.sessionId,
              sessionId: result.sessionId,
              sessionType: m.sessionType,
              provider: m.provider,
              sessionRef: result.sessionRef ?? { provider: m.provider, sessionId: result.sessionId },
            })
          }
        } catch (error) {
          this.sendError(ws, { code: 'INTERNAL_ERROR', message: errorMessage(error) })
        }
        return
      }

      case 'freshAgent.interrupt': {
        const manager = this.freshAgentRuntimeManager
        if (!manager?.interrupt) {
          this.sendError(ws, { code: 'INTERNAL_ERROR', message: this.freshAgentUnavailableMessage() })
          return
        }
        const locator = { sessionId: m.sessionId, sessionType: m.sessionType, provider: m.provider }
        if (!this.requireFreshAgentAuthorization(ws, state, locator)) return
        try {
          await manager.interrupt(locator)
        } catch (error) {
          this.sendError(ws, { code: 'INTERNAL_ERROR', message: errorMessage(error) })
        }
        return
      }

      case 'freshAgent.compact': {
        const manager = this.freshAgentRuntimeManager
        if (!manager?.compact) {
          this.sendError(ws, { code: 'INTERNAL_ERROR', message: this.freshAgentUnavailableMessage() })
          return
        }
        const locator = { sessionId: m.sessionId, sessionType: m.sessionType, provider: m.provider }
        if (!this.requireFreshAgentAuthorization(ws, state, locator)) return
        try {
          await manager.compact(locator, { instructions: m.instructions })
        } catch (error) {
          this.sendError(ws, { code: 'INTERNAL_ERROR', message: errorMessage(error) })
        }
        return
      }

      case 'freshAgent.approval.respond': {
        const manager = this.freshAgentRuntimeManager
        if (!manager?.resolveApproval) {
          this.sendError(ws, { code: 'INTERNAL_ERROR', message: this.freshAgentUnavailableMessage() })
          return
        }
        const locator = { sessionId: m.sessionId, sessionType: m.sessionType, provider: m.provider }
        if (!this.requireFreshAgentAuthorization(ws, state, locator)) return
        try {
          await manager.resolveApproval(locator, m.requestId, m.decision)
        } catch (error) {
          this.sendError(ws, { code: 'INTERNAL_ERROR', message: errorMessage(error) })
        }
        return
      }

      case 'freshAgent.question.respond': {
        const manager = this.freshAgentRuntimeManager
        if (!manager?.answerQuestion) {
          this.sendError(ws, { code: 'INTERNAL_ERROR', message: this.freshAgentUnavailableMessage() })
          return
        }
        const locator = { sessionId: m.sessionId, sessionType: m.sessionType, provider: m.provider }
        if (!this.requireFreshAgentAuthorization(ws, state, locator)) return
        try {
          await manager.answerQuestion(locator, m.requestId, m.answers)
        } catch (error) {
          this.sendError(ws, { code: 'INTERNAL_ERROR', message: errorMessage(error) })
        }
        return
      }

      case 'freshAgent.fork': {
        const manager = this.freshAgentRuntimeManager
        if (!manager?.fork) {
          this.sendError(ws, { code: 'INTERNAL_ERROR', message: this.freshAgentUnavailableMessage() })
          return
        }
        const locator = { sessionId: m.sessionId, sessionType: m.sessionType, provider: m.provider }
        if (!this.requireFreshAgentAuthorization(ws, state, locator)) return
        try {
          const forked = await manager.fork(locator, m.input)
          const forkedRecord = forked && typeof forked === 'object' ? forked as Record<string, unknown> : {}
          const forkedSessionId = typeof forkedRecord.threadId === 'string'
            ? forkedRecord.threadId
            : (typeof forkedRecord.sessionId === 'string' ? forkedRecord.sessionId : undefined)
          if (forkedSessionId) {
            this.authorizeFreshAgentSession(state, {
              sessionId: forkedSessionId,
              sessionType: m.sessionType,
              provider: m.provider,
            })
            this.send(ws, {
              type: 'freshAgent.forked',
              requestId: m.requestId,
              parentSessionId: m.sessionId,
              sessionId: forkedSessionId,
              sessionType: m.sessionType,
              provider: m.provider,
              runtimeProvider: m.provider,
              sessionRef: { provider: m.provider, sessionId: forkedSessionId },
            })
            this.ensureFreshAgentSubscription(ws, state, {
              sessionId: forkedSessionId,
              sessionType: m.sessionType,
              provider: m.provider,
            })
          }
        } catch (error) {
          this.sendError(ws, { code: 'INTERNAL_ERROR', message: errorMessage(error) })
        }
        return
      }

      case 'freshAgent.kill': {
        const manager = this.freshAgentRuntimeManager
        if (!manager?.kill) {
          this.sendError(ws, { code: 'INTERNAL_ERROR', message: this.freshAgentUnavailableMessage() })
          return
        }
        const locator = { sessionId: m.sessionId, sessionType: m.sessionType, provider: m.provider }
        if (!this.requireFreshAgentAuthorization(ws, state, locator)) return
        this.cancelFreshAgentSubscription(state, locator)
        try {
          const success = await manager.kill(locator)
          this.clearFreshAgentCreateCachesForSession(m.sessionId)
          state.freshAgentAuthorizations.delete(this.freshAgentKey(locator))
          this.send(ws, {
            type: 'freshAgent.killed',
            sessionId: m.sessionId,
            sessionType: m.sessionType,
            provider: m.provider,
            success,
          })
        } catch (error) {
          this.sendError(ws, { code: 'INTERNAL_ERROR', message: errorMessage(error) })
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

  broadcastOpencodeActivityUpdated(msg: { upsert?: OpencodeActivityRecord[]; remove?: string[] }): void {
    const parsed = OpencodeActivityUpdatedSchema.safeParse({
      type: 'opencode.activity.updated',
      upsert: msg.upsert || [],
      remove: msg.remove || [],
    })

    if (!parsed.success) {
      log.warn({ issues: parsed.error.issues }, 'Invalid opencode.activity.updated payload')
      return
    }

    this.broadcastAuthenticated(parsed.data)
  }

  broadcastClaudeActivityUpdated(msg: { upsert?: ClaudeActivityRecord[]; remove?: string[] }): void {
    const parsed = ClaudeActivityUpdatedSchema.safeParse({
      type: 'claude.activity.updated',
      upsert: msg.upsert || [],
      remove: msg.remove || [],
    })

    if (!parsed.success) {
      log.warn({ issues: parsed.error.issues }, 'Invalid claude.activity.updated payload')
      return
    }

    this.broadcastAuthenticated(parsed.data)
  }

  broadcastTerminalTurnComplete(msg: Omit<TerminalTurnCompleteMessage, 'type'>): void {
    const parsed = TerminalTurnCompleteSchema.safeParse({
      type: 'terminal.turn.complete',
      ...msg,
    })

    if (!parsed.success) {
      log.warn({ issues: parsed.error.issues }, 'Invalid terminal.turn.complete payload')
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
    registryWithEvents.off?.('terminal.codex.durability.updated', this.onCodexDurabilityUpdatedBound)

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
    this.createdFreshAgentByRequestId.clear()
    this.freshAgentCreateLocks.clear()

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
  const timeoutMs = process.env.CONFIG_LOAD_TIMEOUT_MS
    ? Number(process.env.CONFIG_LOAD_TIMEOUT_MS)
    : 15_000
  try {
    return await Promise.race([
      configStore.snapshot(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('Config snapshot timed out')), timeoutMs),
      ),
    ])
  } catch (err) {
    logger.warn({ err }, 'Config snapshot failed or timed out; using defaults')
    return {
      version: 1 as const,
      settings: {} as UserConfig['settings'],
      sessionOverrides: {},
      terminalOverrides: {},
      projectColors: {},
      recentDirectories: [],
    }
  }
}
