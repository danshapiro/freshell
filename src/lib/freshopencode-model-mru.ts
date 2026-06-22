import { FRESH_AGENT_MODEL_CAPABILITY_CACHE_TTL_MS } from '@/lib/fresh-agent-model-capabilities'
import type {
  FreshAgentModelCapabilities,
  FreshAgentModelCapability,
} from '@shared/fresh-agent-model-capabilities'

const STORAGE_KEY = 'freshopencode.modelMru.v2'
const MAX_ENTRIES = 5

export type FreshOpencodeModelMruEntry = {
  id: string
  displayName: string
  source: { id: string; displayName: string }
  cwdKey: string
  lastVerifiedAt: number
}

export type FreshOpencodeVisibleMruItem = {
  model: FreshAgentModelCapability
  stale: boolean
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

function parseEntry(value: unknown): FreshOpencodeModelMruEntry | undefined {
  if (!isRecord(value)) return undefined
  if (!isNonBlank(value.id)) return undefined
  if (!isNonBlank(value.displayName)) return undefined
  if (!isNonBlank(value.cwdKey)) return undefined
  if (typeof value.lastVerifiedAt !== 'number' || !Number.isFinite(value.lastVerifiedAt)) return undefined

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

export function loadFreshOpencodeModelMru(storage?: Storage): FreshOpencodeModelMruEntry[] {
  const resolved = resolveStorage(storage)
  if (!resolved) return []

  let raw: string | null
  try {
    raw = resolved.getItem(STORAGE_KEY)
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
  if (!Array.isArray(parsed)) return []

  const entries: FreshOpencodeModelMruEntry[] = []
  for (const item of parsed) {
    const entry = parseEntry(item)
    if (entry) entries.push(entry)
  }
  return entries
}

function saveEntries(storage: Storage, entries: FreshOpencodeModelMruEntry[]): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // ignore storage failures (quota, disabled storage, etc.)
  }
}

function sourceFromModel(model: FreshAgentModelCapability): { id: string; displayName: string } {
  if (model.source) {
    return { id: model.source.id, displayName: model.source.displayName }
  }
  const sourceId = model.id.includes('/') ? model.id.split('/')[0] : model.provider
  return { id: sourceId, displayName: sourceId }
}

export function recordFreshOpencodeModelUse(
  model: FreshAgentModelCapability,
  cwdKey: string,
  now: number = Date.now(),
  storage?: Storage,
): FreshOpencodeModelMruEntry[] {
  const resolved = resolveStorage(storage)
  if (!resolved) return []

  if (!isNonBlank(model.id) || !isNonBlank(cwdKey)) {
    return loadFreshOpencodeModelMru(storage)
  }

  const existing = loadFreshOpencodeModelMru(storage)
  const filtered = existing.filter(
    (entry) => !(entry.cwdKey === cwdKey && entry.id === model.id),
  )
  const next: FreshOpencodeModelMruEntry = {
    id: model.id,
    displayName: model.displayName,
    source: sourceFromModel(model),
    cwdKey,
    lastVerifiedAt: now,
  }
  const updated = [next, ...filtered].slice(0, MAX_ENTRIES)
  saveEntries(resolved, updated)
  return updated
}

function reconstructCapability(entry: FreshOpencodeModelMruEntry): FreshAgentModelCapability {
  return {
    id: entry.id,
    displayName: entry.displayName,
    provider: 'opencode',
    source: entry.source,
    supportsEffort: false,
    supportedEffortLevels: [],
    supportsAdaptiveThinking: false,
  }
}

export function buildFreshOpencodeVisibleMru(args: {
  currentModelId?: string
  cwdKey: string
  entries: FreshOpencodeModelMruEntry[]
  capabilities?: FreshAgentModelCapabilities
  now?: number
  maxVisible: number
}): FreshOpencodeVisibleMruItem[] {
  const { currentModelId, cwdKey, entries, capabilities, maxVisible } = args
  const now = args.now ?? Date.now()

  const sameCwd = entries.filter((entry) => entry.cwdKey === cwdKey)

  let items: FreshOpencodeVisibleMruItem[]
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
      .map((entry) => ({ model: reconstructCapability(entry), stale: true }))
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
export function pruneFreshOpencodeModelMru(
  capabilities: FreshAgentModelCapabilities,
  cwdKey: string,
  storage?: Storage,
): void {
  const resolved = resolveStorage(storage)
  if (!resolved) return

  const liveIds = new Set(capabilities.models.map((model) => model.id))
  const entries = loadFreshOpencodeModelMru(storage)
  const pruned = entries.filter(
    (entry) => !(entry.cwdKey === cwdKey && !liveIds.has(entry.id)),
  )
  if (pruned.length < entries.length) {
    saveEntries(resolved, pruned)
  }
}
