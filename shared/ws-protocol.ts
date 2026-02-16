/**
 * Shared WebSocket protocol types — single source of truth for both server and client.
 *
 * Client→Server: Zod schemas (server validates) + inferred TypeScript types.
 * Server→Client: TypeScript types only (client trusts server, no runtime validation).
 *
 * Client MUST use `import type` to avoid bundling Zod runtime code.
 */
import { z } from 'zod'

// ──────────────────────────────────────────────────────────────
// Shared enums and helpers
// ──────────────────────────────────────────────────────────────

export const ErrorCode = z.enum([
  'NOT_AUTHENTICATED',
  'INVALID_MESSAGE',
  'UNKNOWN_MESSAGE',
  'INVALID_TERMINAL_ID',
  'INVALID_SESSION_ID',
  'PTY_SPAWN_FAILED',
  'FILE_WATCHER_ERROR',
  'INTERNAL_ERROR',
  'RATE_LIMITED',
  'UNAUTHORIZED',
])

export type ErrorCode = z.infer<typeof ErrorCode>

export const ShellSchema = z.enum(['system', 'cmd', 'powershell', 'wsl'])

export const CodingCliProviderSchema = z.enum(['claude', 'codex', 'opencode', 'gemini', 'kimi'])

export type CodingCliProviderName = z.infer<typeof CodingCliProviderSchema>

// ──────────────────────────────────────────────────────────────
// Terminal metadata schemas (used in both directions)
// ──────────────────────────────────────────────────────────────

export const TokenSummarySchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  contextTokens: z.number().int().nonnegative().optional(),
  modelContextWindow: z.number().int().positive().optional(),
  compactThresholdTokens: z.number().int().positive().optional(),
  compactPercent: z.number().int().min(0).max(100).optional(),
})

export const TerminalMetaRecordSchema = z.object({
  terminalId: z.string().min(1),
  cwd: z.string().optional(),
  checkoutRoot: z.string().optional(),
  repoRoot: z.string().optional(),
  displaySubdir: z.string().optional(),
  branch: z.string().optional(),
  isDirty: z.boolean().optional(),
  provider: CodingCliProviderSchema.optional(),
  sessionId: z.string().optional(),
  tokenUsage: TokenSummarySchema.optional(),
  updatedAt: z.number().int().nonnegative(),
})

export type TerminalMetaRecord = z.infer<typeof TerminalMetaRecordSchema>

export const TerminalMetaListResponseSchema = z.object({
  type: z.literal('terminal.meta.list.response'),
  requestId: z.string().min(1),
  terminals: z.array(TerminalMetaRecordSchema),
})

export const TerminalMetaUpdatedSchema = z.object({
  type: z.literal('terminal.meta.updated'),
  upsert: z.array(TerminalMetaRecordSchema),
  remove: z.array(z.string().min(1)),
})

// ──────────────────────────────────────────────────────────────
// SDK content block schemas (from Claude Code NDJSON)
// ──────────────────────────────────────────────────────────────

export const TextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
})

export const ThinkingBlockSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
})

export const ToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
})

export const ToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.unknown())]).optional(),
  is_error: z.boolean().optional(),
})

export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ThinkingBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
])

export type ContentBlock = z.infer<typeof ContentBlockSchema>

// ── Token usage ──

export const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
}).passthrough()

export type Usage = z.infer<typeof UsageSchema>

// ──────────────────────────────────────────────────────────────
// Client → Server messages (Zod validated)
// ──────────────────────────────────────────────────────────────

export const HelloSchema = z.object({
  type: z.literal('hello'),
  token: z.string().optional(),
  capabilities: z.object({
    sessionsPatchV1: z.boolean().optional(),
    terminalAttachChunkV1: z.boolean().optional(),
  }).optional(),
  client: z.object({
    mobile: z.boolean().optional(),
  }).optional(),
  sessions: z.object({
    active: z.string().optional(),
    visible: z.array(z.string()).optional(),
    background: z.array(z.string()).optional(),
  }).optional(),
})

export const PingSchema = z.object({
  type: z.literal('ping'),
})

export const TerminalCreateSchema = z.object({
  type: z.literal('terminal.create'),
  requestId: z.string().min(1),
  mode: z.enum(['shell', 'claude', 'codex', 'opencode', 'gemini', 'kimi']).default('shell'),
  shell: ShellSchema.default('system'),
  cwd: z.string().optional(),
  resumeSessionId: z.string().optional(),
  restore: z.boolean().optional(),
})

export const TerminalAttachSchema = z.object({
  type: z.literal('terminal.attach'),
  terminalId: z.string().min(1),
})

export const TerminalDetachSchema = z.object({
  type: z.literal('terminal.detach'),
  terminalId: z.string().min(1),
})

export const TerminalInputSchema = z.object({
  type: z.literal('terminal.input'),
  terminalId: z.string().min(1),
  data: z.string(),
})

export const TerminalResizeSchema = z.object({
  type: z.literal('terminal.resize'),
  terminalId: z.string().min(1),
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(2).max(500),
})

export const TerminalKillSchema = z.object({
  type: z.literal('terminal.kill'),
  terminalId: z.string().min(1),
})

export const TerminalListSchema = z.object({
  type: z.literal('terminal.list'),
  requestId: z.string().min(1),
})

export const TerminalMetaListSchema = z.object({
  type: z.literal('terminal.meta.list'),
  requestId: z.string().min(1),
})

// Coding CLI session schemas
export const CodingCliCreateSchema = z.object({
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

export const CodingCliInputSchema = z.object({
  type: z.literal('codingcli.input'),
  sessionId: z.string().min(1),
  data: z.string(),
})

export const CodingCliKillSchema = z.object({
  type: z.literal('codingcli.kill'),
  sessionId: z.string().min(1),
})

// SDK browser→server schemas
export const SdkCreateSchema = z.object({
  type: z.literal('sdk.create'),
  requestId: z.string().min(1),
  cwd: z.string().optional(),
  resumeSessionId: z.string().optional(),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
  effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
})

export const SdkSendSchema = z.object({
  type: z.literal('sdk.send'),
  sessionId: z.string().min(1),
  text: z.string().min(1),
  images: z.array(z.object({
    mediaType: z.string(),
    data: z.string(),
  })).optional(),
})

export const SdkPermissionRespondSchema = z.object({
  type: z.literal('sdk.permission.respond'),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  behavior: z.enum(['allow', 'deny']),
  updatedInput: z.record(z.string(), z.unknown()).optional(),
  updatedPermissions: z.array(z.unknown()).optional(),
  message: z.string().optional(),
  interrupt: z.boolean().optional(),
})

export const SdkInterruptSchema = z.object({
  type: z.literal('sdk.interrupt'),
  sessionId: z.string().min(1),
})

export const SdkKillSchema = z.object({
  type: z.literal('sdk.kill'),
  sessionId: z.string().min(1),
})

export const SdkAttachSchema = z.object({
  type: z.literal('sdk.attach'),
  sessionId: z.string().min(1),
})

export const SdkSetModelSchema = z.object({
  type: z.literal('sdk.set-model'),
  sessionId: z.string().min(1),
  model: z.string().min(1),
})

export const SdkSetPermissionModeSchema = z.object({
  type: z.literal('sdk.set-permission-mode'),
  sessionId: z.string().min(1),
  permissionMode: z.string().min(1),
})

export const BrowserSdkMessageSchema = z.discriminatedUnion('type', [
  SdkCreateSchema,
  SdkSendSchema,
  SdkPermissionRespondSchema,
  SdkInterruptSchema,
  SdkKillSchema,
  SdkAttachSchema,
  SdkSetModelSchema,
  SdkSetPermissionModeSchema,
])

export type BrowserSdkMessage = z.infer<typeof BrowserSdkMessageSchema>

// ── Client message discriminated union ──

export const ClientMessageSchema = z.discriminatedUnion('type', [
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
])

export type ClientMessage = z.infer<typeof ClientMessageSchema>

// ──────────────────────────────────────────────────────────────
// Server → Client messages (TypeScript types only)
// ──────────────────────────────────────────────────────────────

// -- Core protocol --

export type ReadyMessage = {
  type: 'ready'
  timestamp: string
  serverInstanceId?: string
}

export type PongMessage = {
  type: 'pong'
  timestamp: string
}

export type ErrorMessage = {
  type: 'error'
  code: ErrorCode
  message: string
  requestId?: string
  terminalId?: string
  timestamp: string
}

// -- Terminal lifecycle --

export type TerminalCreatedMessage = {
  type: 'terminal.created'
  requestId: string
  terminalId: string
  createdAt: number
  effectiveResumeSessionId?: string
} & ({ snapshot: string; snapshotChunked?: never } | { snapshotChunked: true; snapshot?: never })

export type TerminalAttachedMessage = {
  type: 'terminal.attached'
  terminalId: string
  snapshot: string
}

export type TerminalAttachedStartMessage = {
  type: 'terminal.attached.start'
  terminalId: string
  totalCodeUnits: number
  totalChunks: number
}

export type TerminalAttachedChunkMessage = {
  type: 'terminal.attached.chunk'
  terminalId: string
  chunk: string
}

export type TerminalAttachedEndMessage = {
  type: 'terminal.attached.end'
  terminalId: string
  totalCodeUnits: number
  totalChunks: number
}

export type TerminalDetachedMessage = {
  type: 'terminal.detached'
  terminalId: string
}

export type TerminalExitMessage = {
  type: 'terminal.exit'
  terminalId: string
  exitCode: number
}

export type TerminalOutputMessage = {
  type: 'terminal.output'
  terminalId: string
  data: string
}

export type TerminalSnapshotMessage = {
  // Reserved for compatibility with older/experimental clients that expect
  // a standalone snapshot frame. Current server flow uses terminal.attached*
  // and terminal.created snapshot payloads instead.
  type: 'terminal.snapshot'
  terminalId: string
  snapshot: string
}

export type TerminalTitleUpdatedMessage = {
  type: 'terminal.title.updated'
  terminalId: string
  title: string
}

export type TerminalSessionAssociatedMessage = {
  type: 'terminal.session.associated'
  terminalId: string
  sessionId: string
}

export type TerminalListUpdatedMessage = {
  type: 'terminal.list.updated'
}

export type TerminalListResponseMessage = {
  type: 'terminal.list.response'
  requestId: string
  terminals: Array<{
    terminalId: string
    title: string
    description?: string
    mode: 'shell' | CodingCliProviderName
    resumeSessionId?: string
    createdAt: number
    lastActivityAt: number
    status: 'running' | 'exited'
    hasClients: boolean
    cwd?: string
  }>
}

export type TerminalMetaListResponseMessage = z.infer<typeof TerminalMetaListResponseSchema>

export type TerminalMetaUpdatedMessage = z.infer<typeof TerminalMetaUpdatedSchema>

export type TerminalIdleWarningMessage = {
  type: 'terminal.idle.warning'
  terminalId: string
  killMinutes: number
  warnMinutes: number
  lastActivityAt: number
}

// -- Sessions --

export type SessionsUpdatedMessage = {
  type: 'sessions.updated'
  // Intentionally unknown to avoid coupling this shared protocol package to
  // client-only ProjectGroup types.
  projects: unknown[]
  clear?: true
  append?: true
}

export type SessionsPatchMessage = {
  type: 'sessions.patch'
  // Intentionally unknown to avoid coupling this shared protocol package to
  // client-only ProjectGroup types.
  upsertProjects: unknown[]
  removeProjectPaths: string[]
}

// -- Settings --

export type SettingsUpdatedMessage = {
  type: 'settings.updated'
  // Intentionally unknown to avoid coupling this shared protocol package to
  // client-only AppSettings types.
  settings: unknown
}

// -- Performance logging --

export type PerfLoggingMessage = {
  type: 'perf.logging'
  enabled: boolean
}

export type ConfigFallbackMessage = {
  type: 'config.fallback'
  reason: 'PARSE_ERROR' | 'VERSION_MISMATCH' | 'READ_ERROR' | 'ENOENT'
  backupExists: boolean
}

// -- Tabs sync --

export type TabsSyncAckMessage = {
  type: 'tabs.sync.ack'
  updated: number
}

export type TabsSyncSnapshotMessage = {
  type: 'tabs.sync.snapshot'
  requestId: string
  data: {
    localOpen: unknown[]
    remoteOpen: unknown[]
    closed: unknown[]
  }
}

// -- Session repair --

export type SessionStatusMessage = {
  type: 'session.status'
  sessionId: string
  status: string
  chainDepth?: number
  orphansFixed?: number
}

export type SessionRepairActivityMessage = {
  type: 'session.repair.activity'
  event: 'scanned' | 'repaired' | 'error'
  sessionId: string
  status?: string
  chainDepth?: number
  orphanCount?: number
  orphansFixed?: number
  message?: string
}

// -- Coding CLI --

export type CodingCliCreatedMessage = {
  type: 'codingcli.created'
  requestId: string
  sessionId: string
  provider: CodingCliProviderName
}

export type CodingCliEventMessage = {
  type: 'codingcli.event'
  sessionId: string
  provider: CodingCliProviderName
  // Provider-specific payload shape. Consumers should narrow/cast based on
  // provider and local event normalization contracts.
  event: unknown
}

export type CodingCliExitMessage = {
  type: 'codingcli.exit'
  sessionId: string
  provider: CodingCliProviderName
  exitCode: number
}

export type CodingCliStderrMessage = {
  type: 'codingcli.stderr'
  sessionId: string
  provider: CodingCliProviderName
  text: string
}

export type CodingCliKilledMessage = {
  type: 'codingcli.killed'
  sessionId: string
  success: boolean
}

export type CodingCliWsMessage =
  | CodingCliEventMessage
  | CodingCliCreatedMessage
  | CodingCliExitMessage
  | CodingCliStderrMessage

// -- SDK server→client messages --

export type SdkSessionStatus = 'creating' | 'starting' | 'connected' | 'running' | 'idle' | 'compacting' | 'exited'

export type SdkServerMessage =
  | { type: 'sdk.created'; requestId: string; sessionId: string }
  | { type: 'sdk.session.init'; sessionId: string; cliSessionId?: string; model?: string; cwd?: string; tools?: Array<{ name: string }> }
  | { type: 'sdk.assistant'; sessionId: string; content: ContentBlock[]; model?: string; usage?: Usage }
  | { type: 'sdk.stream'; sessionId: string; event: unknown; parentToolUseId?: string | null }
  | { type: 'sdk.result'; sessionId: string; result?: string; durationMs?: number; costUsd?: number; usage?: Usage }
  | { type: 'sdk.permission.request'; sessionId: string; requestId: string; subtype: string; tool?: { name: string; input?: Record<string, unknown> }; toolUseID?: string; suggestions?: unknown[]; blockedPath?: string; decisionReason?: string }
  | { type: 'sdk.permission.cancelled'; sessionId: string; requestId: string }
  | { type: 'sdk.status'; sessionId: string; status: SdkSessionStatus }
  | { type: 'sdk.error'; sessionId: string; message: string }
  | { type: 'sdk.history'; sessionId: string; messages: Array<{ role: 'user' | 'assistant'; content: ContentBlock[]; timestamp?: string }> }
  | { type: 'sdk.exit'; sessionId: string; exitCode?: number }
  | { type: 'sdk.killed'; sessionId: string; success: boolean }
  | { type: 'sdk.models'; sessionId: string; models: Array<{ value: string; displayName: string; description: string }> }

// ── Server message discriminated union ──

export type ServerMessage =
  | ReadyMessage
  | PongMessage
  | ErrorMessage
  | TerminalCreatedMessage
  | TerminalAttachedMessage
  | TerminalAttachedStartMessage
  | TerminalAttachedChunkMessage
  | TerminalAttachedEndMessage
  | TerminalDetachedMessage
  | TerminalExitMessage
  | TerminalOutputMessage
  | TerminalSnapshotMessage
  | TerminalTitleUpdatedMessage
  | TerminalSessionAssociatedMessage
  | TerminalListUpdatedMessage
  | TerminalListResponseMessage
  | TerminalMetaListResponseMessage
  | TerminalMetaUpdatedMessage
  | TerminalIdleWarningMessage
  | SessionsUpdatedMessage
  | SessionsPatchMessage
  | SettingsUpdatedMessage
  | PerfLoggingMessage
  | ConfigFallbackMessage
  | TabsSyncAckMessage
  | TabsSyncSnapshotMessage
  | SessionStatusMessage
  | SessionRepairActivityMessage
  | CodingCliCreatedMessage
  | CodingCliEventMessage
  | CodingCliExitMessage
  | CodingCliStderrMessage
  | CodingCliKilledMessage
  | SdkServerMessage
