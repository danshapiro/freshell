import { z } from 'zod'
import type { LocalSettingsPatch, ServerSettings } from './settings.js'
import { TokenSummarySchema } from './ws-protocol.js'

export const MAX_BOOTSTRAP_PAYLOAD_BYTES = 12 * 1024
export const MAX_REALTIME_MESSAGE_BYTES = 16 * 1024
export const MAX_DIRECTORY_PAGE_ITEMS = 50
export const MAX_FRESH_AGENT_THREAD_TURNS = 30
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
  configFallback?: { reason: string; backupExists: boolean; backupPath?: string }
  /** Effective server config dir (`~/.freshell` or the named profile's dir). */
  configDir?: string
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
  /**
   * STATUS-STRIP (fresh-agent context meter): composite `provider:sessionId`
   * keys the client needs usage for regardless of sidebar search/pagination.
   * Matching sessions are returned in `contextUsageExtras` — never merged into
   * `items`, so sidebar rendering is untouched. Capped at the 200-pane ceiling
   * (larger workspaces would otherwise reject every sidebar fetch).
   */
  includeKeys: z.array(z.string().min(1)).max(200).optional(),
})

export const SessionDirectoryItemSchema = z.object({
  sessionId: z.string().min(1),
  provider: z.string().min(1),
  projectPath: z.string().min(1),
  checkoutPath: z.string().optional(),
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
  liveTerminalOnly: z.boolean().optional(),
  /**
   * STATUS-STRIP: live token usage (incl. compactPercent) from the session
   * indexer / terminal metadata. Powers the fresh-agent strip context meter.
   */
  tokenUsage: TokenSummarySchema.optional(),
  /**
   * b5fb provenance exposure for the reviewed reset flow. `titleOverridden` is
   * true exactly when a stored titleOverride currently applies to this row;
   * `providerTitle` is the parsed pre-override title (absent when none was
   * parsed); `titleOverrideSource` is the override row's titleSource
   * (absent when the override never recorded one).
   */
  titleOverridden: z.boolean().optional(),
  providerTitle: z.string().optional(),
  titleOverrideSource: z.enum(['user', 'ai', 'first-message', 'legacy', 'dir']).optional(),
})

/**
 * STATUS-STRIP: a usage-carrying session returned out-of-band when the client
 * asked for it via `includeKeys` but the row was filtered out of the paged
 * `items` (sidebar search / pagination). Deliberately NOT merged into items.
 */
export const SessionDirectoryContextUsageExtraSchema = z.object({
  provider: z.string().min(1),
  sessionId: z.string().min(1),
  tokenUsage: TokenSummarySchema.optional(),
})

/**
 * A server-detected read-model integrity issue.  The response deliberately
 * contains counts only: the server log has the bounded diagnostic samples and
 * source paths, while a browser response must not expose local filesystem
 * details.
 */
export const SessionDirectoryIntegrityErrorSchema = z.object({
  kind: z.literal('identity_collision'),
  collisionCount: z.number().int().positive(),
  duplicateItemCount: z.number().int().min(2),
})

export const SessionDirectoryPageSchema = z.object({
  items: z.array(SessionDirectoryItemSchema),
  nextCursor: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  partial: z.boolean().optional(),
  // Keep this closed to the pre-existing transport reasons. Integrity errors
  // travel in `integrityError`, so an older cached SPA can strip that unknown
  // field and still parse a collision response instead of crashing on a new
  // enum value.
  partialReason: z.enum(['budget', 'io_error']).optional(),
  /**
   * Present when conflicted persisted rows were quarantined from this page.
   * `partial` is also true in that case so existing partial-result consumers
   * retain their conservative behavior.
   */
  integrityError: SessionDirectoryIntegrityErrorSchema.optional(),
  // SESSION-05 (project colors): the resolved per-project color map,
  // present only when at least one color is configured. This page is the
  // channel the client's refetch-after-`sessions.changed` reads to recolor
  // History project headers (both servers emit it — Node:
  // `server/session-directory/service.ts`; Rust:
  // `crates/freshell-server/src/session_directory.rs`).
  projectColors: z.record(z.string(), z.string()).optional(),
  /** STATUS-STRIP: present only when `includeKeys` matched sessions that fell outside `items`. */
  contextUsageExtras: z.array(SessionDirectoryContextUsageExtraSchema).optional(),
  /** STATUS-STRIP: monotonic per-process response sequence — clients order competing pages by it (unlike `revision`, which is a data-derived max timestamp and is NOT monotonic). */
  snapshotSeq: z.number().int().positive().optional(),
  /** The serving server's instance id — pages are only orderable by snapshotSeq within one instance. */
  serverInstance: z.string().min(1).optional(),
  /** STATUS-STRIP: per-PROCESS boot nonce — sequence comparisons are valid within the same instance+boot namespace only (the clock-seeded counter alone cannot prove monotonicity across restarts under wall-clock rewind). */
  bootId: z.string().min(1).optional(),
})

export const TerminalDirectoryQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  priority: ReadModelPrioritySchema,
  revision: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(MAX_DIRECTORY_PAGE_ITEMS).optional(),
})

export const FreshAgentThreadTurnsQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  priority: ReadModelPrioritySchema.optional(),
  revision: z.coerce.number().int().nonnegative(),
  cwd: z.string().trim().min(1).optional(),
  limit: z.number().int().positive().max(MAX_FRESH_AGENT_THREAD_TURNS).optional(),
  includeBodies: z.union([
    z.boolean(),
    z.enum(['true', 'false']).transform((v) => v === 'true'),
  ]).optional(),
})

export const FreshAgentThreadTurnBodyQuerySchema = z.object({
  revision: z.coerce.number().int().nonnegative(),
  cwd: z.string().trim().min(1).optional(),
})

export const RestoreStaleRevisionResponseSchema = z.object({
  error: z.string().min(1),
  code: z.literal('RESTORE_STALE_REVISION'),
  currentRevision: z.number().int().nonnegative(),
})

export const FreshAgentStaleRevisionResponseSchema = z.object({
  error: z.string().min(1),
  code: z.literal('STALE_THREAD_REVISION'),
  currentRevision: z.number().int().nonnegative(),
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
export type SessionDirectoryContextUsageExtra = z.infer<typeof SessionDirectoryContextUsageExtraSchema>
export type SessionDirectoryIntegrityError = z.infer<typeof SessionDirectoryIntegrityErrorSchema>
export type SessionDirectoryPage = z.infer<typeof SessionDirectoryPageSchema>
export type TerminalDirectoryQuery = z.infer<typeof TerminalDirectoryQuerySchema>
export type FreshAgentThreadTurnsQuery = z.infer<typeof FreshAgentThreadTurnsQuerySchema>
export type FreshAgentThreadTurnBodyQuery = z.infer<typeof FreshAgentThreadTurnBodyQuerySchema>
export type RestoreStaleRevisionResponse = z.infer<typeof RestoreStaleRevisionResponseSchema>
export type FreshAgentStaleRevisionResponse = z.infer<typeof FreshAgentStaleRevisionResponseSchema>
export type TerminalScrollbackQuery = z.infer<typeof TerminalScrollbackQuerySchema>
export type TerminalSearchQuery = z.infer<typeof TerminalSearchQuerySchema>
