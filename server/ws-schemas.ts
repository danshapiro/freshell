import { z } from 'zod'
import {
  SdkCreateSchema,
  SdkSendSchema,
  SdkPermissionRespondSchema,
  SdkInterruptSchema,
  SdkKillSchema,
  SdkAttachSchema,
} from './sdk-bridge-types.js'

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

export const HelloSchema = z.object({
  type: z.literal('hello'),
  token: z.string().optional(),
  capabilities: z.object({
    sessionsPatchV1: z.boolean().optional(),
    terminalAttachChunkV1: z.boolean().optional(),
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

export const ShellSchema = z.enum(['system', 'cmd', 'powershell', 'wsl'])

export const TerminalCreateSchema = z.object({
  type: z.literal('terminal.create'),
  requestId: z.string().min(1),
  // Mode supports shell and all coding CLI providers (future providers need spawn logic)
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

export const CodingCliProviderSchema = z.enum(['claude', 'codex', 'opencode', 'gemini', 'kimi'])

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
])
