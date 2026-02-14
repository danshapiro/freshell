import { z } from 'zod'
import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'

// ── Content blocks (from Claude Code NDJSON) ──

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

// ── Browser → Server SDK messages ──

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

// ── Server → Browser SDK messages ──

export type SdkServerMessage =
  | { type: 'sdk.created'; requestId: string; sessionId: string }
  | { type: 'sdk.session.init'; sessionId: string; cliSessionId?: string; model?: string; cwd?: string; tools?: Array<{ name: string }> }
  | { type: 'sdk.assistant'; sessionId: string; content: ContentBlock[]; model?: string; usage?: z.infer<typeof UsageSchema> }
  | { type: 'sdk.stream'; sessionId: string; event: unknown; parentToolUseId?: string | null }
  | { type: 'sdk.result'; sessionId: string; result?: string; durationMs?: number; costUsd?: number; usage?: z.infer<typeof UsageSchema> }
  | { type: 'sdk.permission.request'; sessionId: string; requestId: string; subtype: string; tool?: { name: string; input?: Record<string, unknown> }; toolUseID?: string; suggestions?: unknown[]; blockedPath?: string; decisionReason?: string }
  | { type: 'sdk.permission.cancelled'; sessionId: string; requestId: string }
  | { type: 'sdk.status'; sessionId: string; status: SdkSessionStatus }
  | { type: 'sdk.error'; sessionId: string; message: string }
  | { type: 'sdk.history'; sessionId: string; messages: Array<{ role: 'user' | 'assistant'; content: ContentBlock[]; timestamp?: string }> }
  | { type: 'sdk.exit'; sessionId: string; exitCode?: number }
  | { type: 'sdk.killed'; sessionId: string; success: boolean }
  | { type: 'sdk.models'; sessionId: string; models: Array<{ value: string; displayName: string; description: string }> }

export type SdkSessionStatus = 'creating' | 'starting' | 'connected' | 'running' | 'idle' | 'compacting' | 'exited'

// ── SDK Session State (server-side, in-memory) ──

export interface SdkSessionState {
  sessionId: string
  cliSessionId?: string
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
  costUsd: number
  totalInputTokens: number
  totalOutputTokens: number
}
