import {
  query,
  type Query as SdkQuery,
} from '@anthropic-ai/claude-agent-sdk'

import {
  FRESH_AGENT_MODEL_CAPABILITY_CACHE_TTL_MS,
  FreshAgentModelCapabilitiesResponseSchema,
  FreshAgentModelCapabilityErrorSchema,
  FreshAgentModelCapabilitySchema,
  type FreshAgentModelCapabilitiesResponse,
  type FreshAgentModelCapability,
} from '../../shared/fresh-agent-model-capabilities.js'
import {
  getFreshAgentDescriptor,
  type FreshAgentRuntimeProvider,
  type FreshAgentSessionType,
} from '../../shared/fresh-agent.js'
import { FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE } from '../../shared/fresh-agent-models.js'
import { formatModelDisplayName } from '../../shared/format-model-name.js'
import { createClaudeSdkOptions } from '../sdk-bridge.js'
import { logger } from '../logger.js'

const log = logger.child({ component: 'fresh-agent-model-capability-registry' })
const DEFAULT_PROBE_TIMEOUT_MS = 10_000

type ProbeQuery = Pick<SdkQuery, 'supportedModels' | 'close'>

type RegistryOptions = {
  queryFactory?: typeof query
  now?: () => number
  ttlMs?: number
  probeTimeoutMs?: number
}

type CachedCatalog = {
  fetchedAt: number
  models: FreshAgentModelCapability[]
}

function invalidCapabilityPayload(message: string): Error & {
  code: string
  retryable: boolean
} {
  return FreshAgentModelCapabilityRegistry.createError(
    'CAPABILITY_PAYLOAD_INVALID',
    message,
    false,
  )
}

function normalizeStringList(value: unknown, fieldLabel: string, modelId: string): string[] {
  if (value === undefined || value === null) {
    return []
  }

  if (!Array.isArray(value)) {
    throw invalidCapabilityPayload(
      `Capability payload has invalid ${fieldLabel} for ${modelId}`,
    )
  }

  return value.map((entry) => {
    if (typeof entry !== 'string') {
      throw invalidCapabilityPayload(
        `Capability payload has invalid ${fieldLabel} for ${modelId}`,
      )
    }

    const trimmed = entry.trim()
    if (trimmed.length === 0) {
      throw invalidCapabilityPayload(
        `Capability payload has invalid ${fieldLabel} for ${modelId}`,
      )
    }

    return trimmed
  })
}

function formatCapabilityDisplayName(rawName: string): string {
  const formatted = formatModelDisplayName(rawName)
  if (formatted !== rawName) {
    return formatted
  }

  const aliasMatch = rawName.match(/^([a-z]+)(\[[^\]]+\])?$/)
  if (!aliasMatch) {
    return rawName
  }

  const base = aliasMatch[1].charAt(0).toUpperCase() + aliasMatch[1].slice(1)
  return aliasMatch[2] ? `${base} ${aliasMatch[2]}` : base
}

function readModelId(model: Record<string, unknown>): string {
  const value = typeof model.value === 'string' ? model.value.trim() : ''
  if (value.length > 0) {
    return value
  }

  const id = typeof model.id === 'string' ? model.id.trim() : ''
  if (id.length > 0) {
    return id
  }

  throw FreshAgentModelCapabilityRegistry.createError(
    'CAPABILITY_PAYLOAD_INVALID',
    'Capability payload is missing a model id',
    false,
  )
}

function normalizeModelCapability(
  rawModel: unknown,
  runtimeProvider: FreshAgentRuntimeProvider,
): FreshAgentModelCapability {
  if (!rawModel || typeof rawModel !== 'object' || Array.isArray(rawModel)) {
    throw FreshAgentModelCapabilityRegistry.createError(
      'CAPABILITY_PAYLOAD_INVALID',
      'Capability payload must contain model objects',
      false,
    )
  }

  const model = rawModel as Record<string, unknown>
  const id = readModelId(model)
  const rawDisplayName = typeof model.displayName === 'string'
    ? model.displayName.trim()
    : typeof model.display_name === 'string'
      ? model.display_name.trim()
      : id
  const supportedEffortLevels = normalizeStringList(
    model.supportedEffortLevels
    ?? model.supported_effort_levels
    ?? model.effortLevels
    ?? model.effort_levels,
    'supported effort levels',
    id,
  )
  // The settings surface renders effort controls from the live levels list, so
  // normalize the boolean to that same source of truth and avoid UI/runtime drift.
  const supportsEffort = supportedEffortLevels.length > 0
  const supportsAdaptiveThinking = typeof model.supportsAdaptiveThinking === 'boolean'
    ? model.supportsAdaptiveThinking
    : typeof model.supports_adaptive_thinking === 'boolean'
      ? model.supports_adaptive_thinking
      : false

  return FreshAgentModelCapabilitySchema.parse({
    id,
    displayName: formatCapabilityDisplayName(rawDisplayName || id),
    provider: runtimeProvider,
    description: typeof model.description === 'string' ? model.description : undefined,
    supportsEffort,
    supportedEffortLevels,
    supportsAdaptiveThinking,
  })
}

export function normalizeFreshAgentModelCapabilityCatalog(
  rawModels: unknown,
  runtimeProvider: FreshAgentRuntimeProvider = 'claude',
): FreshAgentModelCapability[] {
  if (!Array.isArray(rawModels)) {
    throw invalidCapabilityPayload('Capability payload must be an array of models')
  }

  return rawModels.map((rawModel) => normalizeModelCapability(rawModel, runtimeProvider))
}

export class FreshAgentModelCapabilityRegistry {
  private readonly queryFactory: typeof query
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly probeTimeoutMs: number
  private cachedCatalog: CachedCatalog | null = null
  private inFlightRefresh: Promise<CachedCatalog> | null = null

  constructor(options: RegistryOptions = {}) {
    this.queryFactory = options.queryFactory ?? query
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? FRESH_AGENT_MODEL_CAPABILITY_CACHE_TTL_MS
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  }

  static createError(code: string, message: string, retryable: boolean): Error & {
    code: string
    retryable: boolean
  } {
    return Object.assign(new Error(message), { code, retryable })
  }

  async getCapabilities(sessionType: FreshAgentSessionType): Promise<FreshAgentModelCapabilitiesResponse> {
    const descriptor = this.requireDescriptor(sessionType)
    if (descriptor.runtimeProvider !== 'claude') {
      return this.createStaticSuccess(sessionType, descriptor.runtimeProvider)
    }

    const cached = this.cachedCatalog
    if (cached && this.now() - cached.fetchedAt <= this.ttlMs) {
      return this.createSuccess(sessionType, descriptor.runtimeProvider, cached, 'cached')
    }

    try {
      const catalog = await this.refreshCatalog()
      return this.createSuccess(sessionType, descriptor.runtimeProvider, catalog, 'fresh')
    } catch (error) {
      return this.createFailure(sessionType, descriptor.runtimeProvider, error)
    }
  }

  async refreshCapabilities(sessionType: FreshAgentSessionType): Promise<FreshAgentModelCapabilitiesResponse> {
    const descriptor = this.requireDescriptor(sessionType)
    if (descriptor.runtimeProvider !== 'claude') {
      return this.createStaticSuccess(sessionType, descriptor.runtimeProvider)
    }

    try {
      const catalog = await this.refreshCatalog()
      return this.createSuccess(sessionType, descriptor.runtimeProvider, catalog, 'fresh')
    } catch (error) {
      return this.createFailure(sessionType, descriptor.runtimeProvider, error)
    }
  }

  private requireDescriptor(sessionType: FreshAgentSessionType) {
    const descriptor = getFreshAgentDescriptor(sessionType)
    if (!descriptor) {
      throw FreshAgentModelCapabilityRegistry.createError(
        'MODEL_CAPABILITIES_SESSION_TYPE_UNSUPPORTED',
        `Fresh-agent session type ${sessionType} is not supported`,
        false,
      )
    }
    return descriptor
  }

  private createStaticSuccess(
    sessionType: FreshAgentSessionType,
    runtimeProvider: FreshAgentRuntimeProvider,
  ): FreshAgentModelCapabilitiesResponse {
    const models = (FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE[sessionType] ?? []).map((option) => {
      const supportedEffortLevels = [...(option.thinkingEfforts ?? [])]
      return FreshAgentModelCapabilitySchema.parse({
        id: option.value,
        displayName: option.label,
        provider: runtimeProvider,
        supportsEffort: supportedEffortLevels.length > 0,
        supportedEffortLevels,
        supportsAdaptiveThinking: supportedEffortLevels.length > 0,
      })
    })

    return FreshAgentModelCapabilitiesResponseSchema.parse({
      ok: true,
      sessionType,
      runtimeProvider,
      status: 'fresh',
      fetchedAt: this.now(),
      models,
    })
  }

  private async refreshCatalog(): Promise<CachedCatalog> {
    if (this.inFlightRefresh) {
      return this.inFlightRefresh
    }

    const task = this.probeCatalog()
      .then((catalog) => {
        this.cachedCatalog = catalog
        return catalog
      })
      .finally(() => {
        this.inFlightRefresh = null
      })

    this.inFlightRefresh = task
    return task
  }

  private async probeCatalog(): Promise<CachedCatalog> {
    const abortController = new AbortController()
    const probeQuery = this.queryFactory({
      prompt: (async function* emptyPrompt() {})(),
      options: createClaudeSdkOptions({
        abortController,
        stderr: (data: string) => {
          log.warn({ data: data.trimEnd() }, 'Capability probe stderr')
        },
      }),
    }) as ProbeQuery
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    try {
      const rawModels = await Promise.race([
        Promise.resolve(probeQuery.supportedModels()),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            abortController.abort()
            reject(FreshAgentModelCapabilityRegistry.createError(
              'CAPABILITY_PROBE_FAILED',
              `Capability probe timed out after ${this.probeTimeoutMs}ms`,
              true,
            ))
          }, this.probeTimeoutMs)
        }),
      ])
      return {
        fetchedAt: this.now(),
        models: normalizeFreshAgentModelCapabilityCatalog(rawModels, 'claude'),
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && 'retryable' in error) {
        throw error
      }
      throw FreshAgentModelCapabilityRegistry.createError(
        'CAPABILITY_PROBE_FAILED',
        error instanceof Error ? error.message : String(error),
        true,
      )
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId)
      }
      try {
        await Promise.resolve(probeQuery.close())
      } catch (closeError) {
        log.warn({ err: closeError }, 'Capability probe close failed')
      }
    }
  }

  private createSuccess(
    sessionType: FreshAgentSessionType,
    runtimeProvider: FreshAgentRuntimeProvider,
    catalog: CachedCatalog,
    status: 'fresh' | 'cached',
  ): FreshAgentModelCapabilitiesResponse {
    return FreshAgentModelCapabilitiesResponseSchema.parse({
      ok: true,
      sessionType,
      runtimeProvider,
      status,
      fetchedAt: catalog.fetchedAt,
      models: catalog.models,
    })
  }

  private createFailure(
    sessionType: FreshAgentSessionType,
    runtimeProvider: FreshAgentRuntimeProvider,
    error: unknown,
  ): FreshAgentModelCapabilitiesResponse {
    const normalized = FreshAgentModelCapabilityErrorSchema.parse({
      code: typeof (error as { code?: unknown })?.code === 'string'
        ? (error as { code: string }).code
        : 'CAPABILITY_PROBE_FAILED',
      message: error instanceof Error ? error.message : String(error),
      retryable: typeof (error as { retryable?: unknown })?.retryable === 'boolean'
        ? (error as { retryable: boolean }).retryable
        : true,
    })

    return FreshAgentModelCapabilitiesResponseSchema.parse({
      ok: false,
      sessionType,
      runtimeProvider,
      status: 'unavailable',
      models: [],
      error: normalized,
    })
  }
}
