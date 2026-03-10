import { z } from 'zod'

export const ReadModelPrioritySchema = z.enum(['visible', 'background'])

export const SessionDirectoryQuerySchema = z.object({
  query: z.string().optional(),
  cursor: z.string().min(1).optional(),
  priority: ReadModelPrioritySchema,
  revision: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(50).optional(),
})

export const TerminalDirectoryQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  priority: ReadModelPrioritySchema,
  revision: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(50).optional(),
})

export const AgentTimelinePageQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  priority: ReadModelPrioritySchema.optional(),
  limit: z.number().int().positive().max(50).optional(),
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
export type SessionDirectoryQuery = z.infer<typeof SessionDirectoryQuerySchema>
export type TerminalDirectoryQuery = z.infer<typeof TerminalDirectoryQuerySchema>
export type AgentTimelinePageQuery = z.infer<typeof AgentTimelinePageQuerySchema>
export type TerminalScrollbackQuery = z.infer<typeof TerminalScrollbackQuerySchema>
export type TerminalSearchQuery = z.infer<typeof TerminalSearchQuerySchema>
