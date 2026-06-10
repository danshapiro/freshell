/**
 * Shared WebSocket protocol types — single source of truth for both server and client.
 *
 * Client→Server: Zod schemas (server validates) + inferred TypeScript types.
 * Server→Client: TypeScript types only (client trusts server, no runtime validation).
 *
 * Client MUST use `import type` to avoid bundling Zod runtime code.
 */
import { z } from 'zod'
import { WS_PROTOCOL_VERSION } from './ws-version.js'
import type { ClientExtensionEntry } from './extension-types.js'
import type { ServerSettings } from './settings.js'
import { LiveTerminalHandleSchema, SessionRefSchema, type RestoreError } from './session-contract.js'
import { CodexDurabilityRefSchema, type CodexDurabilityRef } from './codex-durability.js'

// ──────────────────────────────────────────────────────────────
// Shared enums and helpers
// ──────────────────────────────────────────────────────────────

export const ErrorCode = z.enum([
  'NOT_AUTHENTICATED',
  'INVALID_MESSAGE',
  'UNKNOWN_MESSAGE',
  'INVALID_TERMINAL_ID',
  'INVALID_SESSION_ID',
  'RESTORE_UNAVAILABLE',
  'INVALID_CREATE_REQUEST',
  'PTY_SPAWN_FAILED',
  'FILE_WATCHER_ERROR',
  'INTERNAL_ERROR',
  'RATE_LIMITED',
  'UNAUTHORIZED',
  'PROTOCOL_MISMATCH',
])

export type ErrorCode = z.infer<typeof ErrorCode>

export { WS_PROTOCOL_VERSION }

export const ShellSchema = z.enum(['system', 'cmd', 'powershell', 'wsl'])

export const CodingCliProviderSchema = z.string().min(1)

export type CodingCliProviderName = z.infer<typeof CodingCliProviderSchema>

export const SessionLocatorSchema = SessionRefSchema.extend({
  provider: CodingCliProviderSchema,
})

export type SessionLocator = z.infer<typeof SessionLocatorSchema>

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

export type TokenSummary = z.infer<typeof TokenSummarySchema>

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

export const TerminalMetaUpdatedSchema = z.object({
  type: z.literal('terminal.meta.updated'),
  upsert: z.array(TerminalMetaRecordSchema),
  remove: z.array(z.string().min(1)),
})

export const CodexActivityRecordSchema = z.object({
  terminalId: z.string().min(1),
  sessionId: z.string().optional(),
  phase: z.enum(['idle', 'pending', 'busy', 'unknown']),
  updatedAt: z.number().int().nonnegative(),
})

export type CodexActivityRecord = z.infer<typeof CodexActivityRecordSchema>

export const TerminalTurnCompletionSnapshotSchema = z.object({
  terminalId: z.string().min(1),
  at: z.number().int().nonnegative(),
  completionSeq: z.number().int().positive(),
})

export type TerminalTurnCompletionSnapshot = z.infer<typeof TerminalTurnCompletionSnapshotSchema>

export const CodexActivityListResponseSchema = z.object({
  type: z.literal('codex.activity.list.response'),
  requestId: z.string().min(1),
  terminals: z.array(CodexActivityRecordSchema),
  latestTurnCompletions: z.array(TerminalTurnCompletionSnapshotSchema).optional(),
})

export const CodexActivityUpdatedSchema = z.object({
  type: z.literal('codex.activity.updated'),
  upsert: z.array(CodexActivityRecordSchema),
  remove: z.array(z.string().min(1)),
})

export const OpencodeActivityRecordSchema = z.object({
  terminalId: z.string().min(1),
  sessionId: z.string().optional(),
  phase: z.literal('busy'),
  updatedAt: z.number().int().nonnegative(),
})

export type OpencodeActivityRecord = z.infer<typeof OpencodeActivityRecordSchema>

export const OpencodeActivityListResponseSchema = z.object({
  type: z.literal('opencode.activity.list.response'),
  requestId: z.string().min(1),
  terminals: z.array(OpencodeActivityRecordSchema),
  latestTurnCompletions: z.array(TerminalTurnCompletionSnapshotSchema).optional(),
})

export const OpencodeActivityUpdatedSchema = z.object({
  type: z.literal('opencode.activity.updated'),
  upsert: z.array(OpencodeActivityRecordSchema),
  remove: z.array(z.string().min(1)),
})

export const ClaudeActivityRecordSchema = z.object({
  terminalId: z.string().min(1),
  sessionId: z.string().optional(),
  phase: z.enum(['idle', 'busy']),
  updatedAt: z.number().int().nonnegative(),
})

export type ClaudeActivityRecord = z.infer<typeof ClaudeActivityRecordSchema>

export const ClaudeActivityListResponseSchema = z.object({
  type: z.literal('claude.activity.list.response'),
  requestId: z.string().min(1),
  terminals: z.array(ClaudeActivityRecordSchema),
  latestTurnCompletions: z.array(TerminalTurnCompletionSnapshotSchema).optional(),
})

export const ClaudeActivityUpdatedSchema = z.object({
  type: z.literal('claude.activity.updated'),
  upsert: z.array(ClaudeActivityRecordSchema),
  remove: z.array(z.string().min(1)),
})

export const TerminalTurnCompleteSchema = z.object({
  type: z.literal('terminal.turn.complete'),
  terminalId: z.string().min(1),
  provider: z.enum(['opencode', 'claude', 'codex']),
  sessionId: z.string().min(1).optional(),
  at: z.number().int().nonnegative(),
  completionSeq: z.number().int().positive(),
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
  protocolVersion: z.literal(WS_PROTOCOL_VERSION),
  capabilities: z.object({
    uiScreenshotV1: z.boolean().optional(),
    terminalOutputBatchV1: z.boolean().optional(),
  }).optional(),
  client: z.object({
    mobile: z.boolean().optional(),
  }).optional(),
  sidebarOpenSessions: z.array(SessionLocatorSchema).optional(),
  sessions: z.object({
    active: z.string().optional(),
    visible: z.array(z.string()).optional(),
    background: z.array(z.string()).optional(),
  }).optional(),
})

export const PingSchema = z.object({
  type: z.literal('ping'),
})

export const ClientDiagnosticSchema = z.object({
  type: z.literal('client.diagnostic'),
  event: z.literal('restore_unavailable'),
  reason: z.literal('dead_live_handle'),
  terminalId: z.string().min(1),
  tabId: z.string().min(1),
  paneId: z.string().min(1),
  mode: z.string().min(1),
  hasSessionRef: z.literal(false),
})

export const TerminalCreateSchema = z.object({
  type: z.literal('terminal.create'),
  requestId: z.string().min(1),
  mode: z.string().default('shell'),
  shell: ShellSchema.default('system'),
  cwd: z.string().optional(),
  sessionRef: SessionLocatorSchema.optional(),
  codexDurability: CodexDurabilityRefSchema.optional(),
  liveTerminal: LiveTerminalHandleSchema.optional(),
  restore: z.boolean().optional(),
  recoveryIntent: z.literal('fresh_after_restore_unavailable').optional(),
  tabId: z.string().min(1).optional(),
  paneId: z.string().min(1).optional(),
}).strict()

export const TerminalCodexCandidatePersistedSchema = z.object({
  type: z.literal('terminal.codex.candidate.persisted'),
  terminalId: z.string().min(1),
  candidateThreadId: z.string().min(1),
  rolloutPath: z.string().min(1),
  capturedAt: z.number().int().nonnegative(),
}).strict()

export const TerminalAttachIntentSchema = z.enum([
  'viewport_hydrate',
  'keepalive_delta',
  'transport_reconnect',
])

export const TerminalAttachPrioritySchema = z.enum([
  'foreground',
  'background',
])

export const TerminalAttachSchema = z.object({
  type: z.literal('terminal.attach'),
  terminalId: z.string().min(1),
  sinceSeq: z.number().int().nonnegative().optional(),
  maxReplayBytes: z.number().int().positive().optional(),
  attachRequestId: z.string().min(1).optional(),
  intent: TerminalAttachIntentSchema,
  priority: TerminalAttachPrioritySchema.optional(),
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(2).max(500),
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

export const CodexActivityListSchema = z.object({
  type: z.literal('codex.activity.list'),
  requestId: z.string().min(1),
})

export const OpencodeActivityListSchema = z.object({
  type: z.literal('opencode.activity.list'),
  requestId: z.string().min(1),
})

export const ClaudeActivityListSchema = z.object({
  type: z.literal('claude.activity.list'),
  requestId: z.string().min(1),
})

export const UiLayoutSyncSchema = z.object({
  type: z.literal('ui.layout.sync'),
  tabs: z.array(z.object({
    id: z.string(),
    title: z.string().optional(),
    fallbackSessionRef: SessionLocatorSchema.optional(),
  })),
  activeTabId: z.string().nullable().optional(),
  layouts: z.record(z.string(), z.unknown()),
  activePane: z.record(z.string(), z.string()),
  paneTitles: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  timestamp: z.number(),
})

export const UiScreenshotResultSchema = z.object({
  type: z.literal('ui.screenshot.result'),
  requestId: z.string().min(1),
  ok: z.boolean(),
  mimeType: z.literal('image/png').optional(),
  imageBase64: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  changedFocus: z.boolean().optional(),
  restoredFocus: z.boolean().optional(),
  error: z.string().optional(),
}).strict()

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
  effort: z.string().trim().min(1).optional(),
  plugins: z.array(z.string()).optional(),
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
  resumeSessionId: z.string().min(1).optional(),
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

export const SdkQuestionRespondSchema = z.object({
  type: z.literal('sdk.question.respond'),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  answers: z.record(z.string(), z.string()),
})

export const FreshAgentCreateSchema = z.object({
  type: z.literal('freshAgent.create'),
  requestId: z.string().min(1),
  sessionType: z.enum(['freshclaude', 'freshcodex', 'kilroy', 'freshopencode']),
  provider: z.enum(['claude', 'codex', 'opencode']).optional(),
  cwd: z.string().optional(),
  resumeSessionId: z.string().optional(),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
  sessionRef: z.object({ provider: z.string().min(1), sessionId: z.string().min(1) }).optional(),
  modelSelection: z.object({ kind: z.string().min(1), modelId: z.string().min(1) }).optional().or(z.null()),
  effort: z.string().trim().min(1).optional(),
  plugins: z.array(z.string()).optional(),
})

export const FreshAgentAttachSchema = z.object({
  type: z.literal('freshAgent.attach'),
  sessionId: z.string().min(1),
  sessionType: z.enum(['freshclaude', 'freshcodex', 'kilroy', 'freshopencode']),
  provider: z.enum(['claude', 'codex', 'opencode']),
  resumeSessionId: z.string().optional(),
})

export const FreshAgentSendSchema = z.object({
  type: z.literal('freshAgent.send'),
  sessionId: z.string().min(1),
  sessionType: z.enum(['freshclaude', 'freshcodex', 'kilroy', 'freshopencode']),
  provider: z.enum(['claude', 'codex', 'opencode']),
  text: z.string().min(1),
  settings: z.object({
    cwd: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    permissionMode: z.string().min(1).optional(),
    sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
    effort: z.string().trim().min(1).optional(),
  }).optional(),
  images: z.array(z.object({
    mediaType: z.string(),
    data: z.string(),
  })).optional(),
})

export const FreshAgentInterruptSchema = z.object({
  type: z.literal('freshAgent.interrupt'),
  sessionId: z.string().min(1),
  sessionType: z.enum(['freshclaude', 'freshcodex', 'kilroy', 'freshopencode']),
  provider: z.enum(['claude', 'codex', 'opencode']),
})

export const FreshAgentCompactSchema = z.object({
  type: z.literal('freshAgent.compact'),
  sessionId: z.string().min(1),
  sessionType: z.enum(['freshclaude', 'freshcodex', 'kilroy', 'freshopencode']),
  provider: z.enum(['claude', 'codex', 'opencode']),
  instructions: z.string().trim().min(1).optional(),
})

export const FreshAgentApprovalRespondSchema = z.object({
  type: z.literal('freshAgent.approval.respond'),
  sessionId: z.string().min(1),
  sessionType: z.enum(['freshclaude', 'freshcodex', 'kilroy', 'freshopencode']),
  provider: z.enum(['claude', 'codex', 'opencode']),
  requestId: z.union([z.string().min(1), z.number().int()]),
  decision: z.record(z.string(), z.unknown()),
})

export const FreshAgentQuestionRespondSchema = z.object({
  type: z.literal('freshAgent.question.respond'),
  sessionId: z.string().min(1),
  sessionType: z.enum(['freshclaude', 'freshcodex', 'kilroy', 'freshopencode']),
  provider: z.enum(['claude', 'codex', 'opencode']),
  requestId: z.union([z.string().min(1), z.number().int()]),
  answers: z.record(z.string(), z.string()),
})

export const FreshAgentKillSchema = z.object({
  type: z.literal('freshAgent.kill'),
  sessionId: z.string().min(1),
  sessionType: z.enum(['freshclaude', 'freshcodex', 'kilroy', 'freshopencode']),
  provider: z.enum(['claude', 'codex', 'opencode']),
})

export const FreshAgentForkSchema = z.object({
  type: z.literal('freshAgent.fork'),
  requestId: z.string().min(1).optional(),
  sessionId: z.string().min(1),
  sessionType: z.enum(['freshclaude', 'freshcodex', 'kilroy', 'freshopencode']),
  provider: z.enum(['claude', 'codex', 'opencode']),
  input: z.record(z.string(), z.unknown()).optional(),
})

export const BrowserSdkMessageSchema = z.discriminatedUnion('type', [
  FreshAgentCreateSchema,
  FreshAgentAttachSchema,
  FreshAgentSendSchema,
  FreshAgentInterruptSchema,
  FreshAgentCompactSchema,
  FreshAgentApprovalRespondSchema,
  FreshAgentQuestionRespondSchema,
  FreshAgentKillSchema,
  FreshAgentForkSchema,
  SdkCreateSchema,
  SdkSendSchema,
  SdkPermissionRespondSchema,
  SdkQuestionRespondSchema,
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
  ClientDiagnosticSchema,
  TerminalCreateSchema,
  TerminalCodexCandidatePersistedSchema,
  TerminalAttachSchema,
  TerminalDetachSchema,
  TerminalInputSchema,
  TerminalResizeSchema,
  TerminalKillSchema,
  CodexActivityListSchema,
  OpencodeActivityListSchema,
  ClaudeActivityListSchema,
  UiLayoutSyncSchema,
  UiScreenshotResultSchema,
  CodingCliCreateSchema,
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
  SdkCreateSchema,
  SdkSendSchema,
  SdkPermissionRespondSchema,
  SdkQuestionRespondSchema,
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
  bootId?: string
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
  sessionRef?: SessionLocator
  clearCodexDurability?: boolean
  restoreError?: RestoreError
}

export type TerminalAttachReadyMessage = {
  type: 'terminal.attach.ready'
  terminalId: string
  streamId: string
  geometryEpoch?: number
  geometryAuthority?: TerminalGeometryAuthority
  requestedSinceSeq?: number
  effectiveSinceSeq?: number
  replayResetReason?: 'geometry_authority_unknown'
  headSeq: number
  replayFromSeq: number
  replayToSeq: number
  attachRequestId?: string
  sessionRef?: SessionLocator
}

export type TerminalGeometryAuthority = 'single_client' | 'server_stream' | 'multi_client_unknown'

export type TerminalStreamChangedMessage = {
  type: 'terminal.stream.changed'
  terminalId: string
  streamId: string
  reason: 'new_pty_session' | 'codex_pty_recovery' | 'retention_lost' | 'server_restart_incompatible_retention'
  attachRequestId?: string
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

export type TerminalStatusMessage = {
  type: 'terminal.status'
  terminalId: string
  status: 'running' | 'recovering'
  reason?: string
  attempt?: number
}

export type TerminalOutputMessage = {
  type: 'terminal.output'
  terminalId: string
  streamId: string
  seqStart: number
  seqEnd: number
  data: string
  attachRequestId?: string
  source?: 'live' | 'replay'
}

export type TerminalOutputBatchSegment = {
  seqStart: number
  seqEnd: number
  endOffset: number
  data?: string
  rawFrameCount: number
  barrier?: 'control' | 'startup_probe' | 'osc52' | 'request_mode' | 'turn_complete' | 'gap' | 'geometry'
}

export type TerminalOutputBatchMessage = {
  type: 'terminal.output.batch'
  terminalId: string
  streamId: string
  attachRequestId: string
  source: 'live' | 'replay'
  seqStart: number
  seqEnd: number
  data: string
  serializedBytes: number
  segments: TerminalOutputBatchSegment[]
}

export type TerminalOutputGapMessage = {
  type: 'terminal.output.gap'
  terminalId: string
  streamId: string
  fromSeq: number
  toSeq: number
  reason: 'queue_overflow' | 'replay_window_exceeded' | 'replay_budget_exceeded'
  attachRequestId?: string
}

export type TerminalTitleUpdatedMessage = {
  type: 'terminal.title.updated'
  terminalId: string
  title: string
}

export type TerminalSessionAssociatedMessage = {
  type: 'terminal.session.associated'
  terminalId: string
  sessionRef: SessionLocator
}

export type TerminalCodexDurabilityUpdatedMessage = {
  type: 'terminal.codex.durability.updated'
  terminalId: string
  durability: CodexDurabilityRef
}

export type TerminalInputBlockedMessage = {
  type: 'terminal.input.blocked'
  terminalId: string
  reason: 'codex_identity_pending' | 'codex_identity_capture_timeout' | 'codex_identity_unavailable' | 'codex_recovery_pending' | 'codex_clean_exit_decision_pending' | 'codex_lifecycle_loss_pending'
}

export type TerminalsChangedMessage = {
  type: 'terminals.changed'
  revision: number
}

export type TerminalMetaUpdatedMessage = z.infer<typeof TerminalMetaUpdatedSchema>

export type CodexActivityListResponseMessage = z.infer<typeof CodexActivityListResponseSchema>

export type CodexActivityUpdatedMessage = z.infer<typeof CodexActivityUpdatedSchema>

export type OpencodeActivityListResponseMessage = z.infer<typeof OpencodeActivityListResponseSchema>

export type OpencodeActivityUpdatedMessage = z.infer<typeof OpencodeActivityUpdatedSchema>

export type ClaudeActivityListResponseMessage = z.infer<typeof ClaudeActivityListResponseSchema>
export type ClaudeActivityUpdatedMessage = z.infer<typeof ClaudeActivityUpdatedSchema>

export type TerminalTurnCompleteMessage = z.infer<typeof TerminalTurnCompleteSchema>

// -- Sessions --

export type SessionsChangedMessage = {
  type: 'sessions.changed'
  revision: number
}

// -- Settings --

export type SettingsUpdatedMessage = {
  type: 'settings.updated'
  settings: ServerSettings
}

// -- UI commands --

export type UiCommandMessage = {
  type: 'ui.command'
  command: string
  payload?: unknown
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
  accepted: boolean
  openRecords: number
  closedRecords: number
}

export type TabsSyncSnapshotOpenRecord = Record<string, unknown> & {
  deviceId: string
  deviceLabel: string
  clientInstanceId: string
}

export type TabsSyncSnapshotClosedRecord = Record<string, unknown> & {
  deviceId: string
  deviceLabel: string
}

export type TabsSyncSnapshotMessage = {
  type: 'tabs.sync.snapshot'
  requestId: string
  data: {
    localOpen: TabsSyncSnapshotOpenRecord[]
    sameDeviceOpen: TabsSyncSnapshotOpenRecord[]
    remoteOpen: TabsSyncSnapshotOpenRecord[]
    closed: TabsSyncSnapshotClosedRecord[]
    devices: Array<{ deviceId: string; deviceLabel: string; lastSeenAt: number }>
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
export type SdkRestoreFailureCode =
  | 'RESTORE_NOT_FOUND'
  | 'RESTORE_UNAVAILABLE'
  | 'RESTORE_INTERNAL'
  | 'RESTORE_DIVERGED'
  | 'RESTORE_STALE_REVISION'

export type FreshAgentServerMessage =
  | { type: 'freshAgent.created'; requestId: string; sessionId: string; sessionType: string; provider: string; runtimeProvider: string; sessionRef?: { provider: string; sessionId: string } }
  | { type: 'freshAgent.create.failed'; requestId: string; code: string; message: string; retryable?: boolean }
  | { type: 'freshAgent.event'; sessionId: string; sessionType: string; provider: string; event: unknown }
  | { type: 'freshAgent.forked'; requestId?: string; parentSessionId: string; sessionId: string; sessionType: string; provider: string; runtimeProvider: string; sessionRef?: { provider: string; sessionId: string } }
  | { type: 'freshAgent.killed'; sessionId: string; sessionType: string; provider: string; success: boolean }

export type SdkServerMessage =
  | { type: 'sdk.created'; requestId: string; sessionId: string }
  | {
    type: 'sdk.create.failed'
    requestId: string
    code: SdkRestoreFailureCode
    message: string
    retryable?: boolean
  }
  | {
    type: 'sdk.session.snapshot'
    sessionId: string
    latestTurnId: string | null
    status: SdkSessionStatus
    timelineSessionId?: string
    revision: number
    streamingActive?: boolean
    streamingText?: string
  }
  | { type: 'sdk.session.init'; sessionId: string; cliSessionId?: string; model?: string; cwd?: string; tools?: Array<{ name: string }> }
  | { type: 'sdk.session.metadata'; sessionId: string; cliSessionId?: string; model?: string; cwd?: string; tools?: Array<{ name: string }> }
  | { type: 'sdk.assistant'; sessionId: string; content: ContentBlock[]; model?: string; usage?: Usage }
  | { type: 'sdk.stream'; sessionId: string; event: unknown; parentToolUseId?: string | null }
  | { type: 'sdk.result'; sessionId: string; result?: string; durationMs?: number; costUsd?: number; usage?: Usage }
  | { type: 'sdk.permission.request'; sessionId: string; requestId: string; subtype: string; tool?: { name: string; input?: Record<string, unknown> }; toolUseID?: string; suggestions?: unknown[]; blockedPath?: string; decisionReason?: string }
  | { type: 'sdk.permission.cancelled'; sessionId: string; requestId: string }
  | { type: 'sdk.status'; sessionId: string; status: SdkSessionStatus }
  | { type: 'sdk.error'; sessionId: string; message: string; code?: string }
  | { type: 'sdk.exit'; sessionId: string; exitCode?: number }
  | { type: 'sdk.killed'; sessionId: string; success: boolean }
  | { type: 'sdk.question.request'; sessionId: string; requestId: string; questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }> }

// -- Extensions --

export type ExtensionRegistryMessage = {
  type: 'extensions.registry'
  extensions: ClientExtensionEntry[]
}

export type ExtensionServerStartingMessage = {
  type: 'extension.server.starting'
  name: string
}

export type ExtensionServerReadyMessage = {
  type: 'extension.server.ready'
  name: string
  port: number
}

export type ExtensionServerErrorMessage = {
  type: 'extension.server.error'
  name: string
  error: string
}

export type ExtensionServerStoppedMessage = {
  type: 'extension.server.stopped'
  name: string
}

export type TerminalInventoryMessage = {
  type: 'terminal.inventory'
  bootId: string
  terminals: Array<{
    terminalId: string
    title: string
    description?: string
    mode: string
    sessionRef?: SessionLocator
    createdAt: number
    lastActivityAt: number
    status: 'running' | 'exited'
    runtimeStatus?: 'running' | 'recovering'
    cwd?: string
    codexDurability?: CodexDurabilityRef
  }>
  terminalMeta: TerminalMetaRecord[]
}

// ── Server message discriminated union ──

export type ServerMessage =
  | ReadyMessage
  | PongMessage
  | ErrorMessage
  | TerminalCreatedMessage
  | TerminalAttachReadyMessage
  | TerminalStreamChangedMessage
  | TerminalDetachedMessage
  | TerminalExitMessage
  | TerminalStatusMessage
  | TerminalOutputMessage
  | TerminalOutputBatchMessage
  | TerminalOutputGapMessage
  | TerminalTitleUpdatedMessage
  | TerminalSessionAssociatedMessage
  | TerminalCodexDurabilityUpdatedMessage
  | TerminalInputBlockedMessage
  | TerminalsChangedMessage
  | TerminalMetaUpdatedMessage
  | TerminalInventoryMessage
  | CodexActivityListResponseMessage
  | CodexActivityUpdatedMessage
  | OpencodeActivityListResponseMessage
  | OpencodeActivityUpdatedMessage
  | ClaudeActivityListResponseMessage
  | ClaudeActivityUpdatedMessage
  | TerminalTurnCompleteMessage
  | SessionsChangedMessage
  | SettingsUpdatedMessage
  | UiCommandMessage
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
  | FreshAgentServerMessage
  | SdkServerMessage
  | ExtensionRegistryMessage
  | ExtensionServerStartingMessage
  | ExtensionServerReadyMessage
  | ExtensionServerErrorMessage
  | ExtensionServerStoppedMessage
