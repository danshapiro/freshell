// Re-export content block schemas shared by the SDK bridge and Fresh Agent
// adapters. Browser-facing SDK websocket schemas intentionally do not live here.
export {
  TextBlockSchema,
  ThinkingBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  ContentBlockSchema,
  UsageSchema,
} from '../shared/ws-protocol.js'

export type {
  ContentBlock,
  Usage,
} from '../shared/ws-protocol.js'

// ── SDK type re-exports (from @anthropic-ai/claude-agent-sdk) ──
// These replace the hand-rolled CLI schemas. The SDK handles CLI message
// parsing internally; we re-export types for use in the bridge layer.

export type {
  SDKMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKSystemMessage,
  SDKPartialAssistantMessage,
  SDKUserMessage,
  SDKStatusMessage,
  SDKToolProgressMessage,
  SDKToolUseSummaryMessage,
  Options as SdkOptions,
  Query as SdkQuery,
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk'

import type { PermissionUpdate, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { ContentBlock, Usage } from '../shared/ws-protocol.js'
import type { FreshAgentSessionCommand } from '../shared/fresh-agent-contract.js'

export type SdkSessionStatus = 'creating' | 'starting' | 'connected' | 'running' | 'idle' | 'compacting' | 'exited'
export type SdkRestoreFailureCode =
  | 'RESTORE_NOT_FOUND'
  | 'RESTORE_UNAVAILABLE'
  | 'RESTORE_INTERNAL'
  | 'RESTORE_DIVERGED'
  | 'RESTORE_STALE_REVISION'

export type SdkServerMessage =
  | { type: 'sdk.created'; requestId: string; sessionId: string }
  | {
    type: 'sdk.create.failed'
    requestId: string
    code: SdkRestoreFailureCode | string
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
  | { type: 'sdk.session.changed'; sessionId: string; reason?: string }
  | { type: 'sdk.session.metadata'; sessionId: string; cliSessionId?: string; model?: string; cwd?: string; tools?: Array<{ name: string }> }
  | { type: 'sdk.assistant'; sessionId: string; content: ContentBlock[]; model?: string; usage?: Usage }
  | { type: 'sdk.stream'; sessionId: string; event: unknown; parentToolUseId?: string | null }
  | { type: 'sdk.result'; sessionId: string; result?: string; durationMs?: number; costUsd?: number; usage?: Usage }
  | { type: 'sdk.permission.request'; sessionId: string; requestId: string; subtype: string; tool?: { name: string; input?: Record<string, unknown> }; toolUseID?: string; suggestions?: unknown[]; blockedPath?: string; decisionReason?: string }
  | { type: 'sdk.permission.cancelled'; sessionId: string; requestId: string }
  | { type: 'sdk.status'; sessionId: string; status: SdkSessionStatus }
  | { type: 'sdk.turn.complete'; sessionId: string; at: number }
  | { type: 'sdk.turn.waiting'; sessionId: string; at: number }
  | { type: 'sdk.error'; sessionId: string; message: string; code?: string }
  | { type: 'sdk.exit'; sessionId: string; exitCode?: number }
  | { type: 'sdk.killed'; sessionId: string; success: boolean }
  | { type: 'sdk.question.request'; sessionId: string; requestId: string; questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }> }

// ── SDK Session State (server-side, in-memory) ──

export interface QuestionOption {
  label: string
  description: string
}

export interface QuestionDefinition {
  question: string
  header: string
  options: QuestionOption[]
  multiSelect: boolean
}

export interface SdkSessionState {
  sessionId: string
  cliSessionId?: string
  resumeSessionId?: string
  cwd?: string
  model?: string
  permissionMode?: string
  effort?: string
  plugins?: string[]
  tools?: Array<{ name: string }>
  status: SdkSessionStatus
  createdAt: number
  messages: Array<{ role: 'user' | 'assistant'; content: ContentBlock[]; timestamp: string; model?: string; messageId?: string }>
  streamingActive: boolean
  streamingText: string
  pendingPermissions: Map<string, {
    toolName: string
    input: Record<string, unknown>
    toolUseID: string
    suggestions?: PermissionUpdate[]
    blockedPath?: string
    decisionReason?: string
    resolve: (result: PermissionResult) => void
  }>
  pendingQuestions: Map<string, {
    originalInput: Record<string, unknown>
    questions: QuestionDefinition[]
    resolve: (result: PermissionResult) => void
  }>
  costUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  /** Last emitted turn-complete `at`, kept per session so the edge stays strictly monotonic. */
  lastTurnCompleteAt?: number
  /** Last emitted turn-waiting `at`, kept per session so the waiting edge stays strictly monotonic, independent of the completion edge. */
  lastWaitingAt?: number
  /** Latest system/init `terminal_slash_commands` name-list. The SDK marks it optional: absent = empty subtract list (data-driven; no name denylist). */
  terminalCommandNames?: string[]
  /** True once the first system/init frame has landed — the join gate for publishing the command catalog. */
  commandsInitSeen?: boolean
  /** Latest validated catalog rows from a catalog source (create-time probe or commands_changed push), before the terminal subtract. REPLACE-assigned, never mutated. */
  commandCatalog?: FreshAgentSessionCommand[]
  /** True once a commands_changed push has been incorporated; a late-resolving create-probe is dropped as stale. */
  commandsChangedSeen?: boolean
  /** Published catalog = commandCatalog minus rows whose name is in the latest terminal list. Undefined until the init-frame + catalog-source join has fired. */
  commands?: FreshAgentSessionCommand[]
}

export interface SdkReplayState {
  watermark: number
  session: SdkSessionState
}

export interface SdkReplayEntry {
  sequence: number
  message: SdkServerMessage
}

export interface SdkReplayDrain extends SdkReplayState {
  bufferedMessages: SdkReplayEntry[]
}

export interface SdkReplayGate {
  drain: () => SdkReplayDrain | null
}

export type SdkCreatedSession = SdkSessionState & {
  replayGate: SdkReplayGate
}
