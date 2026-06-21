import { z } from 'zod'

export const FRESH_AGENT_MODEL_CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000

export const FreshAgentModelCapabilitiesOpaqueStringSchema = z.string().trim().min(1)
export const FreshAgentModelCapabilitiesStatusSchema = z.enum(['fresh', 'cached', 'unavailable'])
export const FreshAgentModelCapabilitiesSessionTypeSchema = z.enum([
  'freshclaude',
  'freshcodex',
  'kilroy',
  'freshopencode',
])
export const FreshAgentModelCapabilitiesRuntimeProviderSchema = z.enum([
  'claude',
  'codex',
  'opencode',
])

export const FreshAgentTrackedModelSelectionSchema = z.object({
  kind: z.literal('tracked'),
  modelId: FreshAgentModelCapabilitiesOpaqueStringSchema,
}).strict()

export const FreshAgentExactModelSelectionSchema = z.object({
  kind: z.literal('exact'),
  modelId: FreshAgentModelCapabilitiesOpaqueStringSchema,
}).strict()

export const FreshAgentModelSelectionSchema = z.discriminatedUnion('kind', [
  FreshAgentTrackedModelSelectionSchema,
  FreshAgentExactModelSelectionSchema,
])

export const FreshAgentModelCapabilitySourceSchema = z.object({
  id: FreshAgentModelCapabilitiesOpaqueStringSchema,
  displayName: FreshAgentModelCapabilitiesOpaqueStringSchema,
}).strict()

export const FreshAgentModelCapabilitySchema = z.object({
  id: FreshAgentModelCapabilitiesOpaqueStringSchema,
  displayName: FreshAgentModelCapabilitiesOpaqueStringSchema,
  provider: FreshAgentModelCapabilitiesRuntimeProviderSchema,
  description: z.string().optional(),
  source: FreshAgentModelCapabilitySourceSchema.optional(),
  supportsEffort: z.boolean(),
  supportedEffortLevels: z.array(FreshAgentModelCapabilitiesOpaqueStringSchema),
  supportsAdaptiveThinking: z.boolean(),
}).strict()

export const FreshAgentModelCapabilitiesSchema = z.object({
  sessionType: FreshAgentModelCapabilitiesSessionTypeSchema,
  runtimeProvider: FreshAgentModelCapabilitiesRuntimeProviderSchema,
  status: z.enum(['fresh', 'cached']),
  fetchedAt: z.number().int().nonnegative(),
  models: z.array(FreshAgentModelCapabilitySchema),
}).strict()

export const FreshAgentModelCapabilityErrorSchema = z.object({
  code: FreshAgentModelCapabilitiesOpaqueStringSchema,
  message: FreshAgentModelCapabilitiesOpaqueStringSchema,
  retryable: z.boolean().optional(),
}).strict()

export const FreshAgentModelCapabilitiesResponseSchema = z.discriminatedUnion('ok', [
  FreshAgentModelCapabilitiesSchema.extend({
    ok: z.literal(true),
  }).strict(),
  z.object({
    ok: z.literal(false),
    sessionType: FreshAgentModelCapabilitiesSessionTypeSchema,
    runtimeProvider: FreshAgentModelCapabilitiesRuntimeProviderSchema,
    status: z.literal('unavailable'),
    fetchedAt: z.number().int().nonnegative().optional(),
    models: z.array(FreshAgentModelCapabilitySchema).length(0),
    error: FreshAgentModelCapabilityErrorSchema,
  }).strict(),
])

export type FreshAgentModelSelection = z.infer<typeof FreshAgentModelSelectionSchema>
export type FreshAgentTrackedModelSelection = z.infer<typeof FreshAgentTrackedModelSelectionSchema>
export type FreshAgentExactModelSelection = z.infer<typeof FreshAgentExactModelSelectionSchema>
export type FreshAgentModelCapabilitySource = z.infer<typeof FreshAgentModelCapabilitySourceSchema>
export type FreshAgentModelCapability = z.infer<typeof FreshAgentModelCapabilitySchema>
export type FreshAgentModelCapabilities = z.infer<typeof FreshAgentModelCapabilitiesSchema>
export type FreshAgentModelCapabilitiesState = z.infer<typeof FreshAgentModelCapabilitiesResponseSchema>
export type FreshAgentModelCapabilityError = z.infer<typeof FreshAgentModelCapabilityErrorSchema>
export type FreshAgentModelCapabilitiesResponse = z.infer<typeof FreshAgentModelCapabilitiesResponseSchema>
