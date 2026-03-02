// Re-export shared protocol types for backward compatibility.
// All Zod schemas and message types now live in shared/ws-protocol.ts.
export {
  TextBlockSchema,
  ThinkingBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  ContentBlockSchema,
  UsageSchema,
  SdkCreateSchema,
  SdkSendSchema,
  SdkPermissionRespondSchema,
  SdkQuestionRespondSchema,
  SdkInterruptSchema,
  SdkKillSchema,
  SdkAttachSchema,
  SdkSetModelSchema,
  SdkSetPermissionModeSchema,
  BrowserSdkMessageSchema,
} from '../shared/ws-protocol.js'

export type {
  ContentBlock,
  Usage,
  BrowserSdkMessage,
  SdkServerMessage,
  SdkSessionStatus,
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
import type { ContentBlock, SdkSessionStatus } from '../shared/ws-protocol.js'

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
  tools?: Array<{ name: string }>
  status: SdkSessionStatus
  createdAt: number
  messages: Array<{ role: 'user' | 'assistant'; content: ContentBlock[]; timestamp: string }>
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
}
