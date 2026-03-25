import { z } from 'zod'
import type { LocalSettingsPatch, ServerSettings } from './settings.js'

export const MAX_BOOTSTRAP_PAYLOAD_BYTES = 12 * 1024
export const MAX_REALTIME_MESSAGE_BYTES = 16 * 1024
export const MAX_DIRECTORY_PAGE_ITEMS = 50
export const MAX_AGENT_TIMELINE_ITEMS = 30
export const MAX_TERMINAL_SCROLLBACK_PAGE_BYTES = 64 * 1024
export const READ_MODEL_LANES = ['critical', 'visible', 'background'] as const
export const ReadModelLaneSchema = z.enum(READ_MODEL_LANES)
export const READ_MODEL_LANE_PRIORITY = {
  critical: 0,
  visible: 1,
  background: 2,
} as const

export type BootstrapPayload = {
  settings: ServerSettings
  legacyLocalSettingsSeed?: LocalSettingsPatch
  platform: unknown
  shell: { authenticated: boolean; ready?: boolean; tasks?: Record<string, boolean> }
  perf?: { logging: boolean }
  configFallback?: { reason: string; backupExists: boolean }
}

export const ReadModelPrioritySchema = z.enum(['visible', 'background'])

export const SessionDirectoryQuerySchema = z.object({
  query: z.string().optional(),
  tier: z.enum(['title', 'userMessages', 'fullText']).default('title'),
  cursor: z.string().min(1).optional(),
  priority: ReadModelPrioritySchema,
  revision: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(MAX_DIRECTORY_PAGE_ITEMS).optional(),
  includeSubagents: z.coerce.boolean().optional(),
  includeNonInteractive: z.coerce.boolean().optional(),
  includeEmpty: z.coerce.boolean().optional(),
})

export const SessionDirectoryItemSchema = z.object({
  sessionId: z.string().min(1),
  provider: z.string().min(1),
  sessionKey: z.string().min(1).optional(),
  projectPath: z.string().min(1),
  title: z.string().optional(),
  summary: z.string().optional(),
  snippet: z.string().optional(),
  matchedIn: z.enum(['title', 'summary', 'firstUserMessage', 'userMessage', 'assistantMessage']).optional(),
  lastActivityAt: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative().optional(),
  archived: z.boolean().optional(),
  cwd: z.string().optional(),
  sessionType: z.string().optional(),
  firstUserMessage: z.string().optional(),
  isSubagent: z.boolean().optional(),
  isNonInteractive: z.boolean().optional(),
  isRunning: z.boolean(),
  runningTerminalId: z.string().optional(),
})

export const SessionDirectoryPageSchema = z.object({
  items: z.array(SessionDirectoryItemSchema),
  nextCursor: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  partial: z.boolean().optional(),
  partialReason: z.enum(['budget', 'io_error']).optional(),
})

export const TerminalDirectoryQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  priority: ReadModelPrioritySchema,
  revision: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(MAX_DIRECTORY_PAGE_ITEMS).optional(),
})

export const AgentTimelinePageQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  priority: ReadModelPrioritySchema.optional(),
  limit: z.number().int().positive().max(MAX_AGENT_TIMELINE_ITEMS).optional(),
  includeBodies: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
})

export const TerminalScrollbackQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).optional(),
})

export const TerminalSearchQuerySchema = z.object({
  query: z.string().min(1),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).optional(),
})

export type ReadModelPriority = z.infer<typeof ReadModelPrioritySchema>
export type ReadModelLane = z.infer<typeof ReadModelLaneSchema>
export type SessionDirectoryQuery = z.infer<typeof SessionDirectoryQuerySchema>
export type SessionDirectoryItem = z.infer<typeof SessionDirectoryItemSchema>
export type SessionDirectoryPage = z.infer<typeof SessionDirectoryPageSchema>
export type TerminalDirectoryQuery = z.infer<typeof TerminalDirectoryQuerySchema>
export type AgentTimelinePageQuery = z.infer<typeof AgentTimelinePageQuerySchema>
export type TerminalScrollbackQuery = z.infer<typeof TerminalScrollbackQuerySchema>
export type TerminalSearchQuery = z.infer<typeof TerminalSearchQuerySchema>
