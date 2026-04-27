import { z } from 'zod'

export const AGENT_CHAT_CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000

export const AgentChatOpaqueStringSchema = z.string().trim().min(1)

export const AgentChatTrackedModelSelectionSchema = z.object({
  kind: z.literal('tracked'),
  modelId: AgentChatOpaqueStringSchema,
}).strict()

export const AgentChatExactModelSelectionSchema = z.object({
  kind: z.literal('exact'),
  modelId: AgentChatOpaqueStringSchema,
}).strict()

export const AgentChatModelSelectionSchema = z.discriminatedUnion('kind', [
  AgentChatTrackedModelSelectionSchema,
  AgentChatExactModelSelectionSchema,
])

export const AgentChatModelCapabilitySchema = z.object({
  id: AgentChatOpaqueStringSchema,
  displayName: AgentChatOpaqueStringSchema,
  description: z.string().optional(),
  supportsEffort: z.boolean(),
  supportedEffortLevels: z.array(AgentChatOpaqueStringSchema),
  supportsAdaptiveThinking: z.boolean(),
}).strict()

export const AgentChatCapabilitiesSchema = z.object({
  provider: AgentChatOpaqueStringSchema,
  fetchedAt: z.number().int().nonnegative(),
  models: z.array(AgentChatModelCapabilitySchema),
}).strict()

export const AgentChatCapabilityErrorSchema = z.object({
  code: AgentChatOpaqueStringSchema,
  message: AgentChatOpaqueStringSchema,
  retryable: z.boolean().optional(),
}).strict()

export const AgentChatCapabilitiesResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    capabilities: AgentChatCapabilitiesSchema,
  }).strict(),
  z.object({
    ok: z.literal(false),
    error: AgentChatCapabilityErrorSchema,
  }).strict(),
])

export type AgentChatModelSelection = z.infer<typeof AgentChatModelSelectionSchema>
export type AgentChatTrackedModelSelection = z.infer<typeof AgentChatTrackedModelSelectionSchema>
export type AgentChatExactModelSelection = z.infer<typeof AgentChatExactModelSelectionSchema>
export type AgentChatModelCapability = z.infer<typeof AgentChatModelCapabilitySchema>
export type AgentChatCapabilities = z.infer<typeof AgentChatCapabilitiesSchema>
export type AgentChatCapabilityError = z.infer<typeof AgentChatCapabilityErrorSchema>
export type AgentChatCapabilitiesResponse = z.infer<typeof AgentChatCapabilitiesResponseSchema>
