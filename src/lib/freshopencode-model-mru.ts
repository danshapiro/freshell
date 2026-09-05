import { FRESH_AGENT_MODEL_CAPABILITY_CACHE_TTL_MS } from '@/lib/fresh-agent-model-capabilities'
import type {
  FreshAgentModelCapabilities,
  FreshAgentModelCapability,
} from '@shared/fresh-agent-model-capabilities'

export const FRESH_AGENT_MODEL_MRU_MAX_ENTRIES = 5
const MAX_LEVEL_ENTRIES = 50

/**
 * Providers that share the cwd-scoped model MRU + per-model last-used-level
 * stores. The store keys keep the historical freshopencode prefix so existing
 * entries survive. Each session type has its own namespace.
 */
export type FreshAgentModelMruProvider = 'freshopencode' | 'freshcodex' | 'freshclaude' | 'kilroy'

export type FreshAgentModelMruEntry = {
  id: string
  displayName: string
  source: { id: string; displayName: string }
  cwdKey: string
  lastVerifiedAt: number
}

export type FreshAgentVisibleMruItem = {
  model: FreshAgentModelCapability
  stale: boolean
}

export type FreshAgentModelLevelMruEntry = {
  modelId: string
  level: string
  cwdKey: string
  lastUsedAt: number
}

function modelMruStorageKey(provider: FreshAgentModelMruProvider): string {
  return `${provider}.modelMru.v2`
}

function levelMruStorageKey(provider: FreshAgentModelMruProvider): string {
  return `${provider}.modelLevelMru.v1`
}

function runtimeProviderFor(provider: FreshAgentModelMruProvider): FreshAgentModelCapability['provider'] {
  if (provider === 'freshcodex') return 'codex'
  return provider === 'freshopencode' ? 'opencode' : 'claude'
}

function resolveStorage(storage?: Storage): Storage | undefined {
  if (storage) return storage
  if (typeof globalThis !== 'undefined') {
    return globalThis.localStorage
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseEntry(value: unknown): FreshAgentModelMruEntry | undefined {
  if (!isRecord(value)) return undefined
  if (!isNonBlank(value.id)) return undefined
  if (!isNonBlank(value.displayName)) return undefined
  if (!isNonBlank(value.cwdKey)) return undefined
  if (!isFiniteNumber(value.lastVerifiedAt)) return undefined

  const source = value.source
  if (!isRecord(source)) return undefined
  if (!isNonBlank(source.id)) return undefined
  if (!isNonBlank(source.displayName)) return undefined

  return {
    id: value.id,
    displayName: value.displayName,
    source: { id: source.id, displayName: source.displayName },
    cwdKey: value.cwdKey,
    lastVerifiedAt: value.lastVerifiedAt,
  }
}

function parseLevelEntry(value: unknown): FreshAgentModelLevelMruEntry | undefined {
  if (!isRecord(value)) return undefined
  if (!isNonBlank(value.modelId)) return undefined
  if (!isNonBlank(value.level)) return undefined
  if (!isNonBlank(value.cwdKey)) return undefined
  if (!isFiniteNumber(value.lastUsedAt)) return undefined
  return {
    modelId: value.modelId,
    level: value.level,
    cwdKey: value.cwdKey,
    lastUsedAt: value.lastUsedAt,
  }
}

function loadJsonArray(storage: Storage, key: string): unknown[] {
  let raw: string | null
  try {
    raw = storage.getItem(key)
  } catch {
    return []
  }
  if (!raw) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  return Array.isArray(parsed) ? parsed : []
}

function saveJson(storage: Storage, key: string, value: unknown): void {
  try {
    storage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore storage failures (quota, disabled storage, etc.)
  }
}

export function loadFreshAgentModelMru(
  provider: FreshAgentModelMruProvider,
  storage?: Storage,
): FreshAgentModelMruEntry[] {
  const resolved = resolveStorage(storage)
  if (!resolved) return []

  const entries: FreshAgentModelMruEntry[] = []
  for (const item of loadJsonArray(resolved, modelMruStorageKey(provider))) {
    const entry = parseEntry(item)
    if (entry) entries.push(entry)
  }
  return entries
}

function sourceFromModel(model: FreshAgentModelCapability): { id: string; displayName: string } {
  if (model.source) {
    return { id: model.source.id, displayName: model.source.displayName }
  }
  const sourceId = model.id.includes('/') ? model.id.split('/')[0] : model.provider
  return { id: sourceId, displayName: sourceId }
}

export function recordFreshAgentModelUse(
  provider: FreshAgentModelMruProvider,
  model: FreshAgentModelCapability,
  cwdKey: string,
  now: number = Date.now(),
  storage?: Storage,
): FreshAgentModelMruEntry[] {
  const resolved = resolveStorage(storage)
  if (!resolved) return []

  if (!isNonBlank(model.id) || !isNonBlank(cwdKey)) {
    return loadFreshAgentModelMru(provider, storage)
  }

  const existing = loadFreshAgentModelMru(provider, storage)
  const filtered = existing.filter(
    (entry) => !(entry.cwdKey === cwdKey && entry.id === model.id),
  )
  const next: FreshAgentModelMruEntry = {
    id: model.id,
    displayName: model.displayName,
    source: sourceFromModel(model),
    cwdKey,
    lastVerifiedAt: now,
  }
  const updated = [next, ...filtered].slice(0, FRESH_AGENT_MODEL_MRU_MAX_ENTRIES)
  saveJson(resolved, modelMruStorageKey(provider), updated)
  return updated
}

function reconstructCapability(
  provider: FreshAgentModelMruProvider,
  entry: FreshAgentModelMruEntry,
): FreshAgentModelCapability {
  return {
    id: entry.id,
    displayName: entry.displayName,
    provider: runtimeProviderFor(provider),
    source: entry.source,
    supportsEffort: false,
    supportedEffortLevels: [],
    supportsAdaptiveThinking: false,
  }
}

export function buildFreshAgentVisibleMru(
  provider: FreshAgentModelMruProvider,
  args: {
    currentModelId?: string
    cwdKey: string
    entries: FreshAgentModelMruEntry[]
    capabilities?: FreshAgentModelCapabilities
    now?: number
    maxVisible: number
  },
): FreshAgentVisibleMruItem[] {
  const { currentModelId, cwdKey, entries, capabilities, maxVisible } = args
  const now = args.now ?? Date.now()

  const sameCwd = entries.filter((entry) => entry.cwdKey === cwdKey)

  let items: FreshAgentVisibleMruItem[]
  if (capabilities) {
    const liveById = new Map<string, FreshAgentModelCapability>(
      capabilities.models.map((model) => [model.id, model]),
    )
    items = sameCwd
      .filter((entry) => liveById.has(entry.id))
      .map((entry) => ({ model: liveById.get(entry.id) as FreshAgentModelCapability, stale: false }))
  } else {
    items = sameCwd
      .filter((entry) => now - entry.lastVerifiedAt <= FRESH_AGENT_MODEL_CAPABILITY_CACHE_TTL_MS)
      .map((entry) => ({ model: reconstructCapability(provider, entry), stale: true }))
  }

  if (currentModelId) {
    const currentIndex = items.findIndex((item) => item.model.id === currentModelId)
    if (currentIndex > 0) {
      const [current] = items.splice(currentIndex, 1)
      items.unshift(current)
    }
  }

  return items.slice(0, maxVisible)
}

/** Remove MRU entries whose (cwdKey, id) is not present in the live
 * enabled catalog, so stale entries do not reappear after TTL expiry. */
export function pruneFreshAgentModelMru(
  provider: FreshAgentModelMruProvider,
  capabilities: FreshAgentModelCapabilities,
  cwdKey: string,
  storage?: Storage,
): void {
  const resolved = resolveStorage(storage)
  if (!resolved) return

  const liveIds = new Set(capabilities.models.map((model) => model.id))
  const entries = loadFreshAgentModelMru(provider, storage)
  const pruned = entries.filter(
    (entry) => !(entry.cwdKey === cwdKey && !liveIds.has(entry.id)),
  )
  if (pruned.length < entries.length) {
    saveJson(resolved, modelMruStorageKey(provider), pruned)
  }
}

export function loadFreshAgentModelLevelMru(
  provider: FreshAgentModelMruProvider,
  storage?: Storage,
): FreshAgentModelLevelMruEntry[] {
  const resolved = resolveStorage(storage)
  if (!resolved) return []

  const entries: FreshAgentModelLevelMruEntry[] = []
  for (const item of loadJsonArray(resolved, levelMruStorageKey(provider))) {
    const entry = parseLevelEntry(item)
    if (entry) entries.push(entry)
  }
  return entries
}

/**
 * Record the level the user committed for a model. One entry per
 * (cwdKey, modelId); the newest commit wins. "Default" (no variant) is
 * deliberately never written here — a model without levels always
 * preselects its single Default row, so there is nothing to remember.
 */
export function recordFreshAgentModelLevelUse(
  provider: FreshAgentModelMruProvider,
  args: { modelId: string; level: string; cwdKey: string },
  now: number = Date.now(),
  storage?: Storage,
): FreshAgentModelLevelMruEntry[] {
  const resolved = resolveStorage(storage)
  if (!resolved) return []

  const { modelId, level, cwdKey } = args
  if (!isNonBlank(modelId) || !isNonBlank(level) || !isNonBlank(cwdKey)) {
    return loadFreshAgentModelLevelMru(provider, storage)
  }

  const existing = loadFreshAgentModelLevelMru(provider, storage)
  const filtered = existing.filter(
    (entry) => !(entry.cwdKey === cwdKey && entry.modelId === modelId),
  )
  const next: FreshAgentModelLevelMruEntry = { modelId, level, cwdKey, lastUsedAt: now }
  const updated = [next, ...filtered].slice(0, MAX_LEVEL_ENTRIES)
  saveJson(resolved, levelMruStorageKey(provider), updated)
  return updated
}

export function resolveFreshAgentModelLastUsedLevel(
  provider: FreshAgentModelMruProvider,
  args: { modelId: string; cwdKey: string },
  storage?: Storage,
): string | undefined {
  if (!isNonBlank(args.modelId) || !isNonBlank(args.cwdKey)) return undefined
  return loadFreshAgentModelLevelMru(provider, storage).find(
    (entry) => entry.cwdKey === args.cwdKey && entry.modelId === args.modelId,
  )?.level
}
