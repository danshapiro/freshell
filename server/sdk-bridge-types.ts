import { z } from 'zod'

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
  input: z.record(z.unknown()),
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

// ── CLI → Server NDJSON messages ──

const CliSystemSchema = z.object({
  type: z.literal('system'),
  subtype: z.string(),
  session_id: z.string().optional(),
  tools: z.array(z.object({ name: z.string() }).passthrough()).optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  permission_mode: z.string().optional(),
  mcp_servers: z.array(z.unknown()).optional(),
}).passthrough()

const CliAssistantSchema = z.object({
  type: z.literal('assistant'),
  message: z.object({
    content: z.array(ContentBlockSchema),
    model: z.string().optional(),
    usage: UsageSchema.optional(),
    stop_reason: z.string().optional(),
  }).passthrough(),
}).passthrough()

const CliResultSchema = z.object({
  type: z.literal('result'),
  result: z.string().optional(),
  duration_ms: z.number().optional(),
  cost_usd: z.number().optional(),
  usage: UsageSchema.optional(),
}).passthrough()

const CliStreamEventSchema = z.object({
  type: z.literal('stream_event'),
  event: z.object({
    type: z.string(),
  }).passthrough(),
}).passthrough()

const CliControlRequestSchema = z.object({
  type: z.literal('control_request'),
  id: z.string(),
  subtype: z.string(),
  tool: z.object({
    name: z.string(),
    input: z.record(z.unknown()).optional(),
  }).passthrough().optional(),
}).passthrough()

const CliToolProgressSchema = z.object({
  type: z.literal('tool_progress'),
}).passthrough()

const CliToolUseSummarySchema = z.object({
  type: z.literal('tool_use_summary'),
}).passthrough()

const CliKeepAliveSchema = z.object({
  type: z.literal('keep_alive'),
}).passthrough()

const CliAuthStatusSchema = z.object({
  type: z.literal('auth_status'),
}).passthrough()

export const CliMessageSchema = z.discriminatedUnion('type', [
  CliSystemSchema,
  CliAssistantSchema,
  CliResultSchema,
  CliStreamEventSchema,
  CliControlRequestSchema,
  CliToolProgressSchema,
  CliToolUseSummarySchema,
  CliKeepAliveSchema,
  CliAuthStatusSchema,
])

export type CliMessage = z.infer<typeof CliMessageSchema>

// ── Browser → Server SDK messages ──

export const SdkCreateSchema = z.object({
  type: z.literal('sdk.create'),
  requestId: z.string().min(1),
  cwd: z.string().optional(),
  resumeSessionId: z.string().optional(),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
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
  updatedInput: z.record(z.unknown()).optional(),
  message: z.string().optional(),
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

export const BrowserSdkMessageSchema = z.discriminatedUnion('type', [
  SdkCreateSchema,
  SdkSendSchema,
  SdkPermissionRespondSchema,
  SdkInterruptSchema,
  SdkKillSchema,
  SdkAttachSchema,
])

export type BrowserSdkMessage = z.infer<typeof BrowserSdkMessageSchema>

// ── Server → Browser SDK messages ──

export type SdkServerMessage =
  | { type: 'sdk.created'; requestId: string; sessionId: string }
  | { type: 'sdk.session.init'; sessionId: string; cliSessionId?: string; model?: string; cwd?: string; tools?: Array<{ name: string }> }
  | { type: 'sdk.assistant'; sessionId: string; content: ContentBlock[]; model?: string; usage?: z.infer<typeof UsageSchema> }
  | { type: 'sdk.stream'; sessionId: string; event: unknown }
  | { type: 'sdk.result'; sessionId: string; result?: string; durationMs?: number; costUsd?: number; usage?: z.infer<typeof UsageSchema> }
  | { type: 'sdk.permission.request'; sessionId: string; requestId: string; subtype: string; tool?: { name: string; input?: Record<string, unknown> } }
  | { type: 'sdk.permission.cancelled'; sessionId: string; requestId: string }
  | { type: 'sdk.status'; sessionId: string; status: SdkSessionStatus }
  | { type: 'sdk.error'; sessionId: string; message: string }
  | { type: 'sdk.history'; sessionId: string; messages: Array<{ role: 'user' | 'assistant'; content: ContentBlock[]; timestamp?: string }> }
  | { type: 'sdk.exit'; sessionId: string; exitCode?: number }

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
  pendingPermissions: Map<string, { subtype: string; tool?: { name: string; input?: Record<string, unknown> } }>
  costUsd: number
  totalInputTokens: number
  totalOutputTokens: number
}
