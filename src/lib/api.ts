import type { CodingCliProviderName } from './coding-cli-types'
import type { TokenSummary } from '@shared/ws-protocol'
import type { TitleSource } from '@shared/title-source'
import {
  FreshAgentSnapshotSchema,
} from '@shared/fresh-agent-contract'
import { FreshAgentApiContractError } from '@/lib/fresh-agent-api-error'
import { getClientPerfConfig, isClientPerfLoggingEnabled, logClientPerf } from '@/lib/perf-logger'
import { getAuthToken } from '@/lib/auth'
import { sanitizeSessionLocators } from '@/lib/session-utils'
import type { SessionLocator } from '@/store/paneTypes'
import type { RecoveryInventory } from '@/lib/recovery/types'
import type { Machine } from '@/lib/machine-identity'
import {
  type FreshAgentModelCapabilitiesResponse,
} from '@shared/fresh-agent-model-capabilities'
import {
  ManagedRuntimeIncidentSummarySchema,
  ManagedRuntimeInventorySnapshotSchema,
  ManagedRuntimeMigrationPlanSchema,
  ManagedRuntimeMetricsSnapshotSchema,
  ManagedRuntimeNoticesResponseSchema,
  ManagedRuntimeRepairAuditSchema,
  ManagedRuntimeSoulDetailSchema,
  ManagedRuntimeUpdateLimitsResultSchema,
  ManagedRuntimeViewIntentSchema,
  type ManagedRuntimeIncidentSummary,
  type ManagedRuntimeInventorySnapshot,
  type ManagedRuntimeLimits,
  type ManagedRuntimeMigrationPlan,
  type ManagedRuntimeMetricsSnapshot,
  type ManagedRuntimeNotice,
  type ManagedRuntimeNoticeDeliveryState,
  type ManagedRuntimeRepairAudit,
  type ManagedRuntimeRolloutMode,
  type ManagedRuntimeSoulDetail,
  type ManagedRuntimeUpdateLimitsResult,
  type ManagedRuntimeViewIntent,
  type ManagedRuntimeViewVisibility,
} from '@shared/managed-runtime'
import { parseFreshAgentModelCapabilitiesResponse } from '@/lib/fresh-agent-model-capabilities'
import {
  SessionDirectoryPageSchema,
  SessionDirectoryQuerySchema,
  TerminalDirectoryQuerySchema,
  TerminalSearchQuerySchema,
  type SessionDirectoryItem as ReadModelSessionDirectoryItem,
  type SessionDirectoryContextUsageExtra as ReadModelSessionDirectoryContextUsageExtra,
  type SessionDirectoryIntegrityError as ReadModelSessionDirectoryIntegrityError,
  type SessionDirectoryPage as ReadModelSessionDirectoryPage,
  type SessionDirectoryQuery,
  type TerminalDirectoryQuery,
  type TerminalSearchQuery,
} from '@shared/read-models'
import { z } from 'zod'

/**
 * An HTTP response was received but carried an error status (4xx/5xx). This is a
 * real `Error` subclass so it stringifies to a readable message, carries a stack,
 * and is reliably distinguishable from transport-level failures via `instanceof`.
 * (Previously a plain object literal, which stringified to "[object Object]".)
 */
export class ApiError extends Error {
  readonly status: number
  readonly details?: unknown
  readonly retryAfterMs?: number

  constructor(status: number, message: string, details?: unknown, retryAfterMs?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.details = details
    this.retryAfterMs = retryAfterMs
  }

  // `Error.prototype.message` is non-enumerable, so a bare `JSON.stringify` of an
  // Error drops it. Preserve the shape the previous plain-object ApiError had.
  toJSON() {
    return { name: this.name, status: this.status, message: this.message, details: this.details }
  }
}

/**
 * A `fetch()` call failed at the transport layer — the request never received an
 * HTTP response (server unreachable/restarting, connection dropped). `request()`
 * throws this so callers can classify precisely by type, instead of guessing from
 * an engine-specific `TypeError` message (which also risked swallowing unrelated
 * `TypeError`s thrown while processing a successful response).
 */
export class NetworkError extends Error {
  readonly cause?: unknown

  constructor(message = 'Failed to reach the server', cause?: unknown) {
    super(message)
    this.name = 'NetworkError'
    this.cause = cause
  }
}

export type ApiRequestOptions = {
  signal?: AbortSignal
}

function getApiErrorMessage(data: unknown, fallback: string): string {
  if (typeof data === 'object' && data !== null) {
    const candidate = data as { message?: unknown; error?: unknown }
    if (typeof candidate.message === 'string' && candidate.message.trim().length > 0) {
      return candidate.message
    }
    if (typeof candidate.error === 'string' && candidate.error.trim().length > 0) {
      return candidate.error
    }
  }
  return fallback
}

function getTypedCapabilityFailure(error: unknown): FreshAgentModelCapabilitiesResponse | undefined {
  if (!error || typeof error !== 'object' || !('details' in error)) {
    return undefined
  }

  let parsed: FreshAgentModelCapabilitiesResponse
  try {
    parsed = parseFreshAgentModelCapabilitiesResponse((error as { details?: unknown }).details)
  } catch {
    return undefined
  }
  if (parsed.ok) {
    return undefined
  }
  return parsed
}

export function isApiUnauthorizedError(error: unknown): error is ApiError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status?: unknown }).status === 401
  )
}

// Gateway/availability statuses: the server (or a proxy in front of it, e.g. the
// Vite dev proxy) couldn't service the request right now. During a restart these
// are expected and transient — unlike a 500 (app bug) or 4xx (client error).
const TRANSIENT_HTTP_STATUSES = new Set([502, 503, 504])

/** Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfterMs(value: string | null | undefined, nowMs = Date.now()): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const dateMs = Date.parse(trimmed)
  if (!Number.isFinite(dateMs)) return undefined
  return Math.max(0, dateMs - nowMs)
}

function isAbortError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'AbortError'
  }
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * True when a request failed for an EXPECTED, transient reason — the server was
 * momentarily unreachable or unavailable (unreachable/restarting, connection
 * dropped, request aborted, or a gateway 502/503/504). Callers should treat
 * these quietly (retry/skip) rather than logging error/warn noise; otherwise
 * every server restart floods the logs.
 *
 * Deliberately precise: a bare `TypeError` (e.g. a null-deref while processing a
 * *successful* response) is NOT transient — it's a real bug and must surface.
 * Only the dedicated {@link NetworkError} thrown by `request()`, an abort, or a
 * gateway-unavailable {@link ApiError} qualify.
 *
 * CAVEAT: some freshell endpoints return 503 in *steady state* (e.g. the
 * fresh-agent routes respond 503 when the runtime is not available on this
 * server). Do not use this helper to gate calls to those endpoints — a 503
 * there is a meaningful answer, not a transient outage.
 */
export function isTransientRequestFailure(error: unknown): boolean {
  if (error instanceof NetworkError) return true
  if (isAbortError(error)) return true
  if (error instanceof ApiError && TRANSIENT_HTTP_STATUSES.has(error.status)) return true
  return false
}

/**
 * Bounded retry for the shared rate-limit bucket's 429s. A fresh page's
 * boot burst (settings, sessions, terminal directory, the naming bootstrap)
 * or a reconnect storm can drain the ONE bucket every `/api` route shares:
 * a 429 there is transient, and the callers below (the sidebar snapshot,
 * the session-names bootstrap) have no later re-trigger — without the
 * retry the surface stays stale/empty until the next invalidation.
 * Retries at most 5 times, honoring the server's Retry-After hint.
 */
export const API_429_MAX_RETRIES = 5
const API_429_DELAY_MS = 600

export async function with429Retry<T>(
  attempt: () => Promise<T>,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  for (let tries = 0; ; tries += 1) {
    try {
      return await attempt()
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 429 || tries >= API_429_MAX_RETRIES) {
        throw error
      }
      const hinted = (error as ApiError & { retryAfterMs?: number }).retryAfterMs
      const delayMs = typeof hinted === 'number' && hinted > 0 ? hinted : API_429_DELAY_MS
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs)
        options.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new DOMException('Aborted', 'AbortError'))
        }, { once: true })
      })
    }
  }
}

async function request<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const perfEnabled = isClientPerfLoggingEnabled() && typeof performance !== 'undefined'
  const perfConfig = getClientPerfConfig()
  const startAt = perfEnabled ? performance.now() : 0

  const headers = new Headers(options.headers || {})
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json')
  }

  const token = getAuthToken()
  if (token) {
    headers.set('x-auth-token', token)
  }

  let res: Response
  try {
    res = await fetch(path, { ...options, headers })
  } catch (err) {
    // fetch() rejects only on a transport-level failure or an abort. Preserve
    // abort semantics; wrap genuine network failures in a typed error so callers
    // can classify them precisely (see isTransientRequestFailure) without
    // matching engine-specific messages or over-broad `instanceof TypeError`.
    if (isAbortError(err)) throw err
    throw new NetworkError('Failed to reach the server', err)
  }
  const headersAt = perfEnabled ? performance.now() : 0
  let text: string
  try {
    text = await res.text()
  } catch (err) {
    // The connection can also die mid-body (e.g. the server was killed while
    // responding) — that is the same transport-level failure as a rejected fetch.
    if (isAbortError(err)) throw err
    throw new NetworkError('Connection lost while reading the response', err)
  }
  const bodyAt = perfEnabled ? performance.now() : 0

  let data: any = null
  let parseMs: number | undefined
  if (text) {
    const parseStart = perfEnabled ? performance.now() : 0
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    } finally {
      if (perfEnabled) {
        parseMs = performance.now() - parseStart
      }
    }
  } else {
    data = null
  }

  if (perfEnabled) {
    const totalMs = bodyAt - startAt
    const ttfbMs = headersAt - startAt
    const bodyMs = bodyAt - headersAt
    const payloadChars = text.length
    const method = options.method || 'GET'

    if (totalMs >= perfConfig.apiSlowMs) {
      logClientPerf(
        'perf.api_slow',
        {
          path,
          method,
          status: res.status,
          durationMs: Number(totalMs.toFixed(2)),
          ttfbMs: Number(ttfbMs.toFixed(2)),
          bodyMs: Number(bodyMs.toFixed(2)),
          parseMs: parseMs !== undefined ? Number(parseMs.toFixed(2)) : undefined,
          payloadChars,
        },
        'warn',
      )
    }

    if (parseMs !== undefined && parseMs >= perfConfig.apiParseSlowMs) {
      logClientPerf(
        'perf.api_parse_slow',
        {
          path,
          method,
          status: res.status,
          parseMs: Number(parseMs.toFixed(2)),
          payloadChars,
        },
        'warn',
      )
    }
  }

  if (!res.ok) {
    const retryAfterMs = res.status === 429
      ? parseRetryAfterMs(typeof res.headers?.get === 'function' ? res.headers.get('retry-after') : undefined)
      : undefined
    throw new ApiError(res.status, getApiErrorMessage(data, res.statusText), data, retryAfterMs)
  }

  return data as T
}

export const api = {
  get<T = any>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    return request<T>(path, options)
  },
  post<T = any>(path: string, body: unknown, options: ApiRequestOptions = {}): Promise<T> {
    return request<T>(path, { ...options, method: 'POST', body: JSON.stringify(body) })
  },
  patch<T = any>(path: string, body: unknown, options: ApiRequestOptions = {}): Promise<T> {
    return request<T>(path, { ...options, method: 'PATCH', body: JSON.stringify(body) })
  },
  put<T = any>(path: string, body: unknown, options: ApiRequestOptions = {}): Promise<T> {
    return request<T>(path, { ...options, method: 'PUT', body: JSON.stringify(body) })
  },
  delete<T = any>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    return request<T>(path, { ...options, method: 'DELETE' })
  },
}

function buildQueryString(entries: Array<[string, string | number | undefined]>): string {
  const params = new URLSearchParams()
  for (const [key, value] of entries) {
    if (value === undefined) continue
    params.set(key, String(value))
  }
  const query = params.toString()
  return query.length > 0 ? `?${query}` : ''
}

export async function getBootstrap(options: ApiRequestOptions = {}): Promise<any> {
  return api.get('/api/bootstrap', options)
}

function parseMachine(value: unknown): Machine {
  if (!value || typeof value !== 'object') throw new Error('Invalid machine response')
  const machine = value as Record<string, unknown>
  if (typeof machine.id !== 'string' || !machine.id.trim()) throw new Error('Invalid machine id')
  if (typeof machine.label !== 'string' || !machine.label.trim()) throw new Error('Invalid machine label')
  const createdAt = machine.createdAt
  const lastSeenAt = machine.lastSeenAt
  if (
    typeof createdAt !== 'number'
    || !Number.isFinite(createdAt)
    || typeof lastSeenAt !== 'number'
    || !Number.isFinite(lastSeenAt)
  ) {
    throw new Error('Invalid machine timestamps')
  }
  return {
    id: machine.id,
    label: machine.label,
    createdAt,
    lastSeenAt,
  }
}

export async function getMachines(): Promise<Machine[]> {
  const response = await api.get<{ machines?: unknown }>('/api/machines')
  if (!Array.isArray(response.machines)) throw new Error('Invalid machines response')
  return response.machines.map(parseMachine)
}

export async function createMachine(label: string): Promise<Machine> {
  const response = await api.post<{ machine?: unknown }>('/api/machines', { label })
  return parseMachine(response.machine)
}

export async function renameMachine(machineId: string, label: string): Promise<Machine> {
  const response = await api.patch<{ machine?: unknown }>(`/api/machines/${encodeURIComponent(machineId)}`, { label })
  return parseMachine(response.machine)
}

export async function getRecoveryInventory(
  clientInstanceId: string,
  bootAgoMs: number,
  options: { machineId?: string } = {},
): Promise<RecoveryInventory> {
  return api.get<RecoveryInventory>(
    `/api/recovery/inventory${buildQueryString([
      ['clientInstanceId', clientInstanceId],
      ['bootAgoMs', Math.max(0, Math.round(bootAgoMs))],
      ['machineId', options.machineId?.trim() || undefined],
    ])}`,
  )
}

export function createManagedRuntimeRequestId(): string {
  const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `request-runtime-ui-${suffix}`
}

export async function getManagedRuntimeInventory(
  workspaceId?: string,
  options: ApiRequestOptions = {},
): Promise<ManagedRuntimeInventorySnapshot> {
  const query = buildQueryString([['workspaceId', workspaceId]])
  return ManagedRuntimeInventorySnapshotSchema.parse(
    await api.get(`/api/runtime/souls${query}`, options),
  )
}

export async function getManagedRuntimeReadiness(
  options: ApiRequestOptions = {},
): Promise<Pick<ManagedRuntimeInventorySnapshot, 'revision' | 'readiness' | 'pendingProjectionCount'>> {
  const response = await api.get('/api/runtime/readiness', options)
  const parsed = ManagedRuntimeInventorySnapshotSchema.pick({
    revision: true,
    readiness: true,
    pendingProjectionCount: true,
  }).parse(response)
  return parsed
}

export async function getManagedRuntimeSoul(
  soulId: string,
  options: ApiRequestOptions = {},
): Promise<ManagedRuntimeSoulDetail> {
  return ManagedRuntimeSoulDetailSchema.parse(
    await api.get(`/api/runtime/souls/${encodeURIComponent(soulId)}`, options),
  )
}

export async function retryManagedRuntimeSoul(
  soulId: string,
  expectedIntentRevision: number,
  requestId = createManagedRuntimeRequestId(),
): Promise<unknown> {
  return api.post(`/api/runtime/souls/${encodeURIComponent(soulId)}/retry`, {
    requestId,
    expectedIntentRevision,
  })
}

const ManagedRuntimeStopResultSchema = z.object({
  outcome: z.enum(['verified_empty', 'blocked_ownership', 'backend_unavailable', 'termination_unconfirmed']),
})

export type ManagedRuntimeStopResult = z.infer<typeof ManagedRuntimeStopResultSchema>

export async function stopManagedRuntimeSoul(
  soulId: string,
  expectedIntentRevision: number,
  requestId = createManagedRuntimeRequestId(),
): Promise<ManagedRuntimeStopResult> {
  return ManagedRuntimeStopResultSchema.parse(await api.post(`/api/runtime/souls/${encodeURIComponent(soulId)}/stop`, {
    requestId,
    expectedIntentRevision,
  }))
}

export async function updateManagedRuntimeLimits(
  soulId: string,
  expectedIntentRevision: number,
  limits: ManagedRuntimeLimits,
  requestId = createManagedRuntimeRequestId(),
): Promise<ManagedRuntimeUpdateLimitsResult> {
  return ManagedRuntimeUpdateLimitsResultSchema.parse(
    await api.patch(`/api/runtime/souls/${encodeURIComponent(soulId)}/limits`, {
      requestId,
      expectedIntentRevision,
      ...limits,
    }),
  )
}

export async function updateManagedRuntimeViewVisibility(
  viewId: string,
  visibility: ManagedRuntimeViewVisibility,
  expectedRevision: number,
  expectedSoulIntentRevision: number,
  requestId = createManagedRuntimeRequestId(),
  options: ApiRequestOptions = {},
): Promise<ManagedRuntimeViewIntent> {
  return ManagedRuntimeViewIntentSchema.parse(
    await api.patch(`/api/runtime/views/${encodeURIComponent(viewId)}`, {
      requestId,
      visibility,
      expectedRevision,
      expectedSoulIntentRevision,
    }, options),
  )
}

export async function getManagedRuntimeIncidentSummary(
  incidentId: string,
  options: ApiRequestOptions = {},
): Promise<ManagedRuntimeIncidentSummary> {
  return ManagedRuntimeIncidentSummarySchema.parse(
    await api.get(`/api/runtime/incidents/${encodeURIComponent(incidentId)}/summary`, options),
  )
}

export async function getManagedRuntimeNotices(
  profileId: string,
  limit = 20,
  options: ApiRequestOptions = {},
): Promise<ManagedRuntimeNotice[]> {
  const query = buildQueryString([
    ['profileId', profileId],
    ['limit', Math.max(1, Math.min(100, Math.round(limit)))],
  ])
  return ManagedRuntimeNoticesResponseSchema.parse(
    await api.get(`/api/runtime/notices${query}`, options),
  ).notices
}

export async function recordManagedRuntimeNoticeReceipt(
  noticeId: string,
  profileId: string,
  state: ManagedRuntimeNoticeDeliveryState,
  requestId = createManagedRuntimeRequestId(),
): Promise<void> {
  await api.post(`/api/runtime/notices/${encodeURIComponent(noticeId)}/receipt`, {
    requestId,
    profileId,
    state,
  })
}

export async function getManagedRuntimeMetricsSnapshot(
  options: ApiRequestOptions = {},
): Promise<ManagedRuntimeMetricsSnapshot> {
  return ManagedRuntimeMetricsSnapshotSchema.parse(
    await api.get('/api/runtime/metrics', options),
  )
}

export async function planManagedRuntimeMigration(
  requestedMode: ManagedRuntimeRolloutMode,
  options: {
    backupPath?: string
    legacyMetadataPath?: string
  } = {},
): Promise<ManagedRuntimeMigrationPlan> {
  return ManagedRuntimeMigrationPlanSchema.parse(
    await api.post('/api/runtime/migration/plan', {
      requestId: createManagedRuntimeRequestId(),
      requestedMode,
      backupPath: options.backupPath,
      legacyMetadataPath: options.legacyMetadataPath,
    }),
  )
}

export async function applyManagedRuntimeMigration(
  requestedMode: ManagedRuntimeRolloutMode,
  options: {
    backupPath?: string
    legacyMetadataPath?: string
  } = {},
): Promise<ManagedRuntimeMigrationPlan> {
  return ManagedRuntimeMigrationPlanSchema.parse(
    await api.post('/api/runtime/migration/apply', {
      requestId: createManagedRuntimeRequestId(),
      requestedMode,
      backupPath: options.backupPath,
      legacyMetadataPath: options.legacyMetadataPath,
    }),
  )
}

export async function auditManagedRuntimeRepair(
  apply = false,
): Promise<ManagedRuntimeRepairAudit> {
  return ManagedRuntimeRepairAuditSchema.parse(
    await api.post('/api/runtime/repair', {
      requestId: createManagedRuntimeRequestId(),
      apply,
    }),
  )
}

export async function getFreshAgentModelCapabilities(
  sessionType: string,
  options: ApiRequestOptions & { cwd?: string } = {},
): Promise<FreshAgentModelCapabilitiesResponse> {
  const { cwd, ...requestOptions } = options
  const query = cwd ? `?${new URLSearchParams({ cwd }).toString()}` : ''
  try {
    return parseFreshAgentModelCapabilitiesResponse(
      await api.get(`/api/fresh-agent/model-capabilities/${encodeURIComponent(sessionType)}${query}`, requestOptions),
    )
  } catch (error) {
    const typedFailure = getTypedCapabilityFailure(error)
    if (typedFailure) {
      return typedFailure
    }
    throw error
  }
}

export async function refreshFreshAgentModelCapabilities(
  sessionType: string,
  options: ApiRequestOptions & { cwd?: string } = {},
): Promise<FreshAgentModelCapabilitiesResponse> {
  const { cwd, ...requestOptions } = options
  const query = cwd ? `?${new URLSearchParams({ cwd }).toString()}` : ''
  try {
    return parseFreshAgentModelCapabilitiesResponse(
      await api.post(`/api/fresh-agent/model-capabilities/${encodeURIComponent(sessionType)}/refresh${query}`, {}, requestOptions),
    )
  } catch (error) {
    const typedFailure = getTypedCapabilityFailure(error)
    if (typedFailure) {
      return typedFailure
    }
    throw error
  }
}

export async function getSessionDirectoryPage(
  query: SessionDirectoryQuery,
  options: ApiRequestOptions = {},
): Promise<any> {
  const parsed = SessionDirectoryQuerySchema.parse(query)
  return api.get(
    `/api/session-directory${buildQueryString([
      ['query', parsed.query],
      ['tier', parsed.tier === 'title' ? undefined : parsed.tier],
      ['cursor', parsed.cursor],
      ['priority', parsed.priority],
      ['revision', parsed.revision],
      ['limit', parsed.limit],
      ['includeSubagents', parsed.includeSubagents ? '1' : undefined],
      ['includeNonInteractive', parsed.includeNonInteractive ? '1' : undefined],
      ['includeEmpty', parsed.includeEmpty ? '1' : undefined],
      ['includeKeys', parsed.includeKeys && parsed.includeKeys.length > 0 ? parsed.includeKeys.join(',') : undefined],
    ])}`,
    options,
  )
}

export async function getTerminalDirectoryPage(
  query: TerminalDirectoryQuery,
  options: ApiRequestOptions = {},
): Promise<any> {
  const parsed = TerminalDirectoryQuerySchema.parse(query)
  return api.get(
    `/api/terminals${buildQueryString([
      ['cursor', parsed.cursor],
      ['priority', parsed.priority],
      ['revision', parsed.revision],
      ['limit', parsed.limit],
    ])}`,
    options,
  )
}

export async function getFreshAgentThreadSnapshot(
  sessionType: string,
  provider: string,
  threadId: string,
  query: { revision?: number; cwd?: string; trigger?: string; signal?: AbortSignal } = {},
  options: ApiRequestOptions = {},
): Promise<any> {
  const signal = query.signal ?? options.signal
  const data = await api.get(
    `/api/fresh-agent/threads/${encodeURIComponent(sessionType)}/${encodeURIComponent(provider)}/${encodeURIComponent(threadId)}${buildQueryString([
      ['revision', query.revision],
      ['cwd', query.cwd],
      ['trigger', query.trigger],
    ])}`,
    { ...options, signal },
  )
  const parsed = FreshAgentSnapshotSchema.safeParse(data)
  if (!parsed.success) {
    throw new FreshAgentApiContractError('Fresh-agent snapshot response did not match the shared contract.', parsed.error.issues)
  }
  return parsed.data
}

export async function searchTerminalView(
  terminalId: string,
  query: TerminalSearchQuery,
  options: ApiRequestOptions = {},
): Promise<any> {
  const parsed = TerminalSearchQuerySchema.parse(query)
  return api.get(
    `/api/terminals/${encodeURIComponent(terminalId)}/search${buildQueryString([
      ['query', parsed.query],
      ['cursor', parsed.cursor],
      ['limit', parsed.limit],
    ])}`,
    options,
  )
}

export type VersionInfo = {
  currentVersion: string
  updateCheck: {
    updateAvailable: boolean
    currentVersion: string
    latestVersion: string | null
    releaseUrl: string | null
    error: string | null
  } | null
}

export type SearchResult = {
  sessionId: string
  provider: CodingCliProviderName
  projectPath: string
  checkoutPath?: string
  title?: string
  summary?: string
  sessionType?: string
  matchedIn: 'title' | 'userMessage' | 'assistantMessage' | 'summary'
  snippet?: string
  lastActivityAt: number
  createdAt?: number
  archived?: boolean
  cwd?: string
  firstUserMessage?: string
  isSubagent?: boolean
  isNonInteractive?: boolean
  isRunning?: boolean
  runningTerminalId?: string
  liveTerminalOnly?: boolean
  /** STATUS-STRIP: live token usage from the server read model. */
  tokenUsage?: TokenSummary
  /** b5fb: true exactly when a stored titleOverride currently applies to this row. */
  titleOverridden?: boolean
  /** b5fb: the parsed pre-override (provider-native) title, when one was parsed. */
  providerTitle?: string
  /** b5fb: the applied override row's recorded titleSource, when it recorded one. */
  titleOverrideSource?: TitleSource
}

export type SearchResponse = {
  results: SearchResult[]
  tier: 'title' | 'userMessages' | 'fullText'
  query: string
  totalScanned: number
  /** Opaque cursor for the next page of matches, or null when the last page was returned. */
  nextCursor: string | null
  /** True when the server has additional matches beyond this page (nextCursor is non-null). */
  hasMore: boolean
  partial?: boolean
  partialReason?: 'budget' | 'io_error'
  /** Server-detected persisted-session integrity issue; conflicted rows were omitted. */
  integrityError?: ReadModelSessionDirectoryIntegrityError
  /** SESSION-05: the page's per-project color map (only present when the server emitted one). */
  projectColors?: Record<string, string>
  /** STATUS-STRIP: usage for `includeKeys` sessions that fell outside the search results. */
  contextUsageExtras?: ReadModelSessionDirectoryContextUsageExtra[]
  /** STATUS-STRIP: session-directory revision of the data snapshot (NOT monotonic — see snapshotSeq). */
  revision?: number
  /** STATUS-STRIP: monotonic per-instance page sequence — the ordering key for competing usage writes. */
  snapshotSeq?: number
  /** STATUS-STRIP: the serving server's instance id — snapshotSeq comparisons within it only. */
  serverInstance?: string
  /** STATUS-STRIP: per-process boot nonce — snapshotSeq ordering is trusted only within the same instance+boot. */
  bootId?: string
}

export type SearchOptions = {
  query: string
  tier?: 'title' | 'userMessages' | 'fullText'
  limit?: number
  maxFiles?: number
  /** Opaque cursor from a previous SearchResponse.nextCursor, used to fetch the next page. */
  cursor?: string
  signal?: AbortSignal
  includeSubagents?: boolean
  includeNonInteractive?: boolean
  includeEmpty?: boolean
  /** STATUS-STRIP: `provider:sessionId` keys to keep usage-live regardless of the search filter. */
  includeKeys?: string[]
}

function encodeSessionCursor(before: number | undefined, beforeId: string | undefined): string | undefined {
  if (before === undefined || beforeId === undefined) return undefined
  const raw = JSON.stringify({ lastActivityAt: before, key: beforeId })
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function groupDirectoryItemsAsProjects(
  items: ReadModelSessionDirectoryItem[],
  projectColors?: Record<string, string>,
) {
  const groups = new Map<string, Array<ReadModelSessionDirectoryItem>>()
  for (const item of items) {
    const bucket = groups.get(item.projectPath) ?? []
    bucket.push(item)
    groups.set(item.projectPath, bucket)
  }

  return Array.from(groups.entries()).map(([projectPath, sessions]) => ({
    projectPath,
    // SESSION-05: items carry no color field — the page-level
    // `projectColors` map (shared/read-models.ts) is the channel. Overlay
    // it here, the single construction site for session-window project
    // groups, so History's header swatch (`project.color`) and the sidebar
    // selectors see it. Absent map (older server) → no color, exactly the
    // pre-SESSION-05 behavior.
    ...(projectColors?.[projectPath] ? { color: projectColors[projectPath] } : {}),
    sessions: sessions.map((item) => ({
      provider: item.provider,
      sessionId: item.sessionId,
      projectPath: item.projectPath,
      ...(item.checkoutPath ? { checkoutPath: item.checkoutPath } : {}),
      lastActivityAt: item.lastActivityAt,
      createdAt: item.createdAt,
      archived: item.archived,
      cwd: item.cwd,
      title: item.title,
      summary: item.summary,
      isSubagent: item.isSubagent,
      isNonInteractive: item.isNonInteractive,
      isRunning: item.isRunning,
      runningTerminalId: item.runningTerminalId,
      liveTerminalOnly: item.liveTerminalOnly,
      firstUserMessage: item.firstUserMessage,
      sessionType: item.sessionType,
      // STATUS-STRIP: window rows carry live usage so the fresh-agent strip
      // context meter reads the same data the sidebar fetches.
      ...(item.tokenUsage ? { tokenUsage: item.tokenUsage } : {}),
      // b5fb: the reviewed reset flow's provenance fields (allowlist mapper —
      // forward explicitly or they never reach Redux).
      ...(item.titleOverridden ? { titleOverridden: true } : {}),
      ...(item.providerTitle !== undefined ? { providerTitle: item.providerTitle } : {}),
      ...(item.titleOverrideSource ? { titleOverrideSource: item.titleOverrideSource } : {}),
      // Unified agent names (Task 2 projection): the row's canonical ref +
      // last-known name — a fresh second client's sessionNames cache
      // bootstraps from these (its ready-time read races its hydration).
      ...(item.nameRef ? { nameRef: item.nameRef } : {}),
      ...(item.sessionName !== undefined ? { sessionName: item.sessionName } : {}),
    })),
  }))
}

export async function setSessionMetadata(
  provider: string,
  sessionId: string,
  sessionType: string,
  options: { sessionTypeSource?: 'explicit' | 'materialized' } = {},
): Promise<void> {
  await api.post('/api/session-metadata', {
    provider,
    sessionId,
    sessionType,
    sessionTypeSource: options.sessionTypeSource ?? 'explicit',
  })
}

/**
 * kata b8ke (Task 6's REST contract): the typed result of
 * `POST /api/sessions/handoff`. Success commits the new owner (terminal or
 * fresh-agent); failure carries the typed recoverable code. The server
 * answers typed failures with 409/400/401 — the SAME body rides the
 * ApiError, so `requestSessionHandoff` surfaces it as the failure arm
 * instead of throwing.
 */
export const SessionHandoffErrorCodeSchema = z.enum([
  'HANDOFF_IN_PROGRESS',
  'REAP_TIMEOUT',
  'TARGET_SPAWN_FAILED',
  'STALE_GENERATION',
  'SESSION_NOT_FOUND',
  'BAD_REQUEST',
  'UNAUTHORIZED',
  /** b8ke R4-4: an ordinary retry against a PlatformLimited fence — the
   *  acknowledged force-clear is the only recovery. */
  'PLATFORM_LIMITED_FENCED',
  'SESSION_FENCED',
  /** b8ke delta round-3 F4: the INITIAL reap-time platform-limited
   *  failure (session_handoff.rs emits it when the prior's confirmed
   *  reap cannot verify the descendant tree on this platform) — the
   *  fence it leaves behind is recoverable through the acknowledged
   *  force-clear, so the frame must PARSE (pre-fix the schema rejected
   *  the code, requestSessionHandoff rethrew, and the caller converted
   *  it to generic HANDOFF_REQUEST_FAILED — the Banner's Force-clear
   *  action was unreachable through the real API path). */
  'PLATFORM_LIMITED',
  /** b8ke stabilization: the capability preflight refused before entering
   * Handoff, so the existing owner is still live and there is no stale fence
   * for the operator to clear. */
  'PLATFORM_LIMITED_PRECHECK',
  /** b8ke delta round-3 F5: an ordinary retry against a StaleStart
   *  fence (the unconfirmed stale-start residue) — the acknowledged
   *  force-clear accepts StaleStart with the same typed risk. */
  'STALE_START_FENCED',
  /** b8ke e3r3 F5: the in-window durable flavor write failed (both
   *  runtimes reaped; the typed recoverable result must reach the
   *  caller). */
  'SESSION_METADATA_WRITE_FAILED',
  /** b8ke e3r3 F3: an ordinary retry against a StaleStop fence (the
   *  stale-Stopping watchdog's unconfirmed residue). */
  'STALE_STOP_FENCED',
  /** b8ke ext r28 F2: an ordinary (unacknowledged) retry against a
   *  CLEARED-UNVERIFIED key — the r16-F4 clear's typed refusal (the
   *  clear is not permission to start a writer; the acknowledged-risk
   *  arm is the only start). */
  'CLEARED_UNVERIFIED_FENCED',
  /** b8ke ext r34 F3: the typed 400 for a half-supplied observed (epoch,
   *  generation) fence pair (session_handoff.rs's wire_fence refusal).
   *  Current browser callers always send both fields together, but the
   *  typed REST/client contract must parse the server's documented
   *  response instead of converting it to a generic
   *  HANDOFF_REQUEST_FAILED ("could not reach the server") for malformed
   *  callers. */
  'INVALID_FENCE',
])
export type SessionHandoffErrorCode = z.infer<typeof SessionHandoffErrorCodeSchema>

const SessionHandoffOwnerSchema = z.union([
  z.object({
    kind: z.literal('terminal'),
    terminalId: z.string(),
    mode: z.string(),
  }),
  z.object({
    kind: z.literal('fresh-agent'),
    sessionId: z.string(),
    sessionType: z.string(),
    provider: z.string(),
  }),
])

const SessionHandoffFailureSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: SessionHandoffErrorCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
    ownerKind: z.enum(['terminal', 'fresh-agent']).optional(),
    ownerGeneration: z.number().int().nonnegative().optional(),
  }),
})

export const SessionHandoffResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    operationId: z.string(),
    generation: z.number().int().nonnegative(),
    owner: SessionHandoffOwnerSchema,
  }),
  // b8ke focused round-4 R4-4 + ext r12 F1: the acknowledged
  // force-clear's TYPED answer — the fence was cleared (the key sits in
  // the typed cleared-unverified state) but NO handoff ran and no owner
  // is committed. The answer carries NO retry instruction: the clear
  // STOPS at the clear (the client surfaces the cleared state with an
  // explicit user action to re-initiate the handoff, which then goes
  // through the coordinator fresh, as any new request would).
  z.object({
    ok: z.literal(true),
    /** b8ke ext r28 F2: the reason-typed cleared label. The r25 server
     *  change made the acknowledged force-clear accept the STALE-reason
     *  fences alongside PlatformLimited, so the server emits all three;
     *  the enum stays closed (a server that ever emits an unexpected
     *  label fails the parse loudly). */
    cleared: z.enum(['platform-limited-fence', 'stale-start-fence', 'stale-stop-fence']),
    operationId: z.string(),
    generation: z.number().int().nonnegative(),
    // Older servers omitted this field. Absence is deliberately treated as
    // unconfirmed so the client never infers process death from compatibility.
    shutdownConfirmed: z.boolean().default(false),
  }),
  SessionHandoffFailureSchema,
])
export type SessionHandoffResult = z.infer<typeof SessionHandoffResultSchema>

export type SessionHandoffRequestBody = {
  action?: 'switch' | 'clear-stale-bookkeeping' | 'stop-and-reopen'
  provider: string
  sessionId: string
  targetKind: 'terminal' | 'fresh-agent'
  /** fresh-agent target: freshcodex | freshopencode | freshclaude | kilroy. */
  sessionType?: string
  /** terminal target CLI mode. */
  mode?: string
  cwd?: string
  tabId?: string
  paneId?: string
  /** The observed (epoch, generation) fence pair — sent together or not at all. */
  observedEpoch?: number
  observedGeneration?: number
  deviceId?: string
  /** Deprecated compatibility alias. The server accepts it only when no
   *  explicit action is supplied, mapping `true` to clear-only. */
  acknowledgePlatformLimitedRisk?: boolean
}

export async function requestSessionHandoff(
  body: SessionHandoffRequestBody,
): Promise<SessionHandoffResult> {
  let raw: unknown
  try {
    raw = await api.post('/api/sessions/handoff', body)
  } catch (err) {
    // Typed failures arrive as non-2xx statuses carrying the SAME typed
    // body — surface them as the failure arm; anything else rethrows.
    const details = err instanceof ApiError ? err.details : undefined
    const failure = SessionHandoffFailureSchema.safeParse(details)
    if (failure.success) return failure.data
    throw err
  }
  return SessionHandoffResultSchema.parse(raw)
}

export async function fetchSidebarSessionsSnapshot(options: {
  limit?: number
  before?: number
  beforeId?: string
  openSessions?: SessionLocator[]
  signal?: AbortSignal
  includeSubagents?: boolean
  includeNonInteractive?: boolean
  includeEmpty?: boolean
  /** STATUS-STRIP: `provider:sessionId` keys to keep usage-live regardless of the window. */
  includeKeys?: string[]
} = {}): Promise<any> {
  const {
    limit = 100,
    before,
    beforeId,
    openSessions = [],
    signal,
    includeSubagents,
    includeNonInteractive,
    includeEmpty,
    includeKeys,
  } = options
  sanitizeSessionLocators(openSessions)

  const page = SessionDirectoryPageSchema.parse(await with429Retry(
    () => getSessionDirectoryPage({
      priority: 'visible',
      tier: 'title' as const,
      limit: Math.min(limit, 50),
      cursor: encodeSessionCursor(before, beforeId),
      includeSubagents,
      includeNonInteractive,
      includeEmpty,
      ...(includeKeys && includeKeys.length > 0 ? { includeKeys } : {}),
    }, {
      signal,
    }),
    { signal },
  )) as ReadModelSessionDirectoryPage

  const projects = groupDirectoryItemsAsProjects(page.items, page.projectColors)
  const oldest = page.items.at(-1)

  return {
    projects,
    totalSessions: page.items.length,
    oldestIncludedTimestamp: oldest?.lastActivityAt ?? 0,
    oldestIncludedSessionId: oldest ? `${oldest.provider}:${oldest.sessionId}` : '',
    hasMore: page.nextCursor !== null,
    partial: page.partial,
    partialReason: page.partialReason,
    integrityError: page.integrityError,
    revision: page.revision,
    ...(page.snapshotSeq !== undefined ? { snapshotSeq: page.snapshotSeq } : {}),
    ...(page.serverInstance ? { serverInstance: page.serverInstance } : {}),
    ...(page.bootId ? { bootId: page.bootId } : {}),
    ...(page.contextUsageExtras ? { contextUsageExtras: page.contextUsageExtras } : {}),
  }
}

export async function searchSessions(options: SearchOptions): Promise<SearchResponse> {
  const { query, tier = 'title', limit, cursor, signal, includeSubagents, includeNonInteractive, includeEmpty, includeKeys } = options
  const page = SessionDirectoryPageSchema.parse(await getSessionDirectoryPage({
    priority: 'visible',
    query,
    tier,
    ...(limit ? { limit } : {}),
    ...(cursor ? { cursor } : {}),
    includeSubagents,
    includeNonInteractive,
    includeEmpty,
    ...(includeKeys && includeKeys.length > 0 ? { includeKeys } : {}),
  }, {
    signal,
  })) as ReadModelSessionDirectoryPage

  const response: SearchResponse = {
    results: page.items.map((item) => ({
      sessionId: item.sessionId,
      provider: item.provider,
      projectPath: item.projectPath,
      title: item.title,
      summary: item.summary,
      matchedIn: item.matchedIn === 'firstUserMessage' ? 'userMessage' : item.matchedIn ?? 'title',
      snippet: item.snippet,
      lastActivityAt: item.lastActivityAt,
      createdAt: item.createdAt,
      archived: item.archived,
      cwd: item.cwd,
      sessionType: item.sessionType,
      firstUserMessage: item.firstUserMessage,
      isSubagent: item.isSubagent,
      isNonInteractive: item.isNonInteractive,
      isRunning: item.isRunning,
      runningTerminalId: item.runningTerminalId,
      liveTerminalOnly: item.liveTerminalOnly,
      ...(item.tokenUsage ? { tokenUsage: item.tokenUsage } : {}),
      // b5fb: forward the reset-flow provenance fields (allowlist mapper).
      ...(item.titleOverridden ? { titleOverridden: true } : {}),
      ...(item.providerTitle !== undefined ? { providerTitle: item.providerTitle } : {}),
      ...(item.titleOverrideSource ? { titleOverrideSource: item.titleOverrideSource } : {}),
    })),
    tier,
    query,
    totalScanned: page.items.length,
    nextCursor: page.nextCursor,
    hasMore: page.nextCursor !== null,
    revision: page.revision,
    ...(page.snapshotSeq !== undefined ? { snapshotSeq: page.snapshotSeq } : {}),
    ...(page.serverInstance ? { serverInstance: page.serverInstance } : {}),
    ...(page.bootId ? { bootId: page.bootId } : {}),
    ...(page.projectColors ? { projectColors: page.projectColors } : {}),
    ...(page.contextUsageExtras ? { contextUsageExtras: page.contextUsageExtras } : {}),
  }

  if (page.partial) {
    response.partial = page.partial
    response.partialReason = page.partialReason
  }
  if (page.integrityError) {
    response.integrityError = page.integrityError
  }

  return response
}
