import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { allocateLocalhostPort, type LoopbackServerEndpoint } from '../../../local-port.js'
import {
  FreshAgentModelCapabilitySchema,
  type FreshAgentModelCapability,
} from '../../../../shared/fresh-agent-model-capabilities.js'

const DEFAULT_HEALTH_TIMEOUT_MS = 20_000
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000
const DEFAULT_HEALTH_POLL_INTERVAL_MS = 150
const MAX_DISPLAY_NAME_LENGTH = 120
const CONTROL_CHAR_PATTERN = /[\x00-\x1F\x7F]/g

export type OpencodeModelCatalogProviderOptions = {
  command?: string
  spawnFn?: typeof spawn
  fetchFn?: typeof fetch
  allocatePort?: () => Promise<LoopbackServerEndpoint>
  env?: NodeJS.ProcessEnv
  healthTimeoutMs?: number
  requestTimeoutMs?: number
}

export type OpencodeModelCatalogRequest = {
  cwd?: string
  signal?: AbortSignal
}

export type OpencodeModelCatalogResult = {
  providers: Record<string, unknown>
}

export type OpencodeModelCatalogProvider = {
  getCatalog(request?: OpencodeModelCatalogRequest): Promise<OpencodeModelCatalogResult>
}

class OpencodeCatalogRequestTimeoutError extends Error {
  constructor(requestPath: string, timeoutMs: number) {
    super(`opencode catalog GET ${requestPath} timed out after ${timeoutMs}ms`)
    this.name = 'OpencodeCatalogRequestTimeoutError'
  }
}

export function createOpencodeModelCatalogProvider(
  options: OpencodeModelCatalogProviderOptions = {},
): OpencodeModelCatalogProvider {
  const command = options.command ?? 'opencode'
  const spawnFn = options.spawnFn ?? spawn
  const fetchFn = options.fetchFn ?? fetch
  const allocatePort = options.allocatePort ?? allocateLocalhostPort
  const env = options.env ?? process.env
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

  async function fetchWithTimeout(
    url: string,
    requestPath: string,
    init: RequestInit | undefined,
  ): Promise<Response> {
    if (requestTimeoutMs <= 0) {
      return await fetchFn(url, init)
    }
    const controller = new AbortController()
    let timedOut = false
    const upstreamSignal = init?.signal
    const abortFromUpstream = () => controller.abort()
    if (upstreamSignal?.aborted) {
      controller.abort()
    } else {
      upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true })
    }
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, requestTimeoutMs)
    timeout.unref?.()

    try {
      return await fetchFn(url, { ...init, signal: controller.signal })
    } catch (error) {
      if (timedOut) {
        throw new OpencodeCatalogRequestTimeoutError(requestPath, requestTimeoutMs)
      }
      throw error
    } finally {
      clearTimeout(timeout)
      upstreamSignal?.removeEventListener('abort', abortFromUpstream)
    }
  }

  async function waitForHealth(
    baseUrl: string,
    child: ChildProcessWithoutNullStreams,
    signal: AbortSignal,
  ): Promise<void> {
    const stopChild = () => {
      killChildGroup(child)
    }
    const deadline = Date.now() + healthTimeoutMs
    let stderr = ''
    let childExitError: Error | undefined
    const onStderr = (chunk: Buffer | string) => { stderr += String(chunk) }
    const onExit = (code: number | null, signalName: string | null) => {
      if (childExitError) return
      childExitError = new Error(
        signalName
          ? `opencode catalog serve exited with signal ${signalName}`
          : `opencode catalog serve exited with code ${code}`,
      )
      exitReject(childExitError)
    }
    const onError = (err: Error) => {
      if (childExitError) return
      childExitError = err
      exitReject(err)
    }
    let exitReject: (err: Error) => void = () => {}
    const exitPromise = new Promise<never>((_, reject) => { exitReject = reject })
    exitPromise.catch(() => { /* prevent unhandled rejection if no racer is awaiting */ })
    child.stderr?.on('data', onStderr)
    child.on('exit', onExit)
    child.on('error', onError)
    try {
      while (Date.now() < deadline) {
        if (signal.aborted) {
          stopChild()
          throw new Error('opencode catalog startup was aborted')
        }
        if (/ServeError|Failed to start server|EADDRINUSE/i.test(stderr)) {
          stopChild()
          throw new Error(`opencode catalog serve failed to start on ${baseUrl}: ${stderr.trim()}`)
        }
        try {
          const res = await Promise.race([
            fetchWithTimeout(`${baseUrl}/global/health`, '/global/health', { method: 'GET' }),
            exitPromise,
          ])
          if (res.ok) {
            const body = await res.json().catch(() => ({}))
            if (typeof body === 'object' && body !== null && (body as { healthy?: unknown }).healthy !== false) {
              return
            }
          }
        } catch (error) {
          if (childExitError) {
            stopChild()
            throw childExitError
          }
          // not up yet
        }
        await Promise.race([
          new Promise((r) => setTimeout(r, DEFAULT_HEALTH_POLL_INTERVAL_MS)),
          exitPromise,
        ])
      }
      stopChild()
      throw new Error(`opencode catalog serve did not become healthy within ${healthTimeoutMs}ms`)
    } finally {
      child.stderr?.off('data', onStderr)
      child.off('exit', onExit)
      child.off('error', onError)
    }
  }

  async function getCatalog(
    request: OpencodeModelCatalogRequest = {},
  ): Promise<OpencodeModelCatalogResult> {
    const cwd = typeof request.cwd === 'string' && request.cwd.trim().length > 0
      ? request.cwd.trim()
      : undefined
    const endpoint = await allocatePort()
    const baseUrl = `http://${endpoint.hostname}:${endpoint.port}`
    const args = ['serve', '--pure', '--hostname', endpoint.hostname, '--port', String(endpoint.port)]
    const child = spawnFn(
      command,
      args,
      {
        ...(cwd ? { cwd } : {}),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      },
    ) as unknown as ChildProcessWithoutNullStreams
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', () => {})

    try {
      await waitForHealth(baseUrl, child, request.signal ?? new AbortController().signal)
      const res = await fetchWithTimeout(
        `${baseUrl}/config/providers`,
        '/config/providers',
        { method: 'GET', ...(request.signal ? { signal: request.signal } : {}) },
      )
      if (!res.ok) {
        throw new Error(`opencode catalog GET /config/providers → ${res.status}`)
      }
      const raw = await res.json()
      return { providers: readProviderRecord(raw) }
    } finally {
      killChildGroup(child)
    }
  }

  return { getCatalog }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Kill the child's entire process group if possible (Linux/macOS),
 * falling back to child.kill() otherwise. */
function killChildGroup(child: ChildProcessWithoutNullStreams): void {
  if (child.killed) return
  try {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM')
    else child.kill()
  } catch {
    try { child.kill() } catch { /* already gone */ }
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function cleanDisplayName(value: string): string {
  const stripped = value.replace(CONTROL_CHAR_PATTERN, '').trim()
  if (stripped.length === 0) return ''
  if (stripped.length > MAX_DISPLAY_NAME_LENGTH) {
    return stripped.slice(0, MAX_DISPLAY_NAME_LENGTH)
  }
  return stripped
}

/** Normalize the `providers` field to a Record keyed by provider id.
 * opencode 1.17.x serves providers as an array of Info objects, but
 * schemas may also use an object record. Accept both formats. */
function readProvidersField(rawProviders: unknown): Record<string, unknown> {
  if (isRecord(rawProviders)) {
    return { ...rawProviders }
  }
  if (Array.isArray(rawProviders)) {
    const record: Record<string, unknown> = {}
    for (const entry of rawProviders) {
      if (isRecord(entry)) {
        const id = readNonEmptyString(entry.id)
        if (id) record[id] = entry
      }
    }
    return record
  }
  return {}
}

function readProviderRecord(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) return {}
  return readProvidersField(raw.providers)
}

function readProviderMap(raw: unknown): Map<string, unknown> {
  const result = new Map<string, unknown>()
  if (!isRecord(raw)) return result
  const rawProviders = raw.providers
  if (isRecord(rawProviders)) {
    for (const [key, value] of Object.entries(rawProviders)) {
      result.set(key, value)
    }
  } else if (Array.isArray(rawProviders)) {
    for (const entry of rawProviders) {
      if (isRecord(entry)) {
        const id = readNonEmptyString(entry.id)
        if (id) result.set(id, entry)
      }
    }
  }
  return result
}

function readModelEntries(provider: Record<string, unknown>): Map<string, unknown> {
  const models = new Map<string, unknown>()
  const rawModels = provider.models
  if (isRecord(rawModels)) {
    for (const [key, value] of Object.entries(rawModels)) {
      models.set(key, value)
    }
  }
  return models
}

function compareBySourceThenNameThenId(
  a: FreshAgentModelCapability,
  b: FreshAgentModelCapability,
): number {
  const aSourceId = a.source?.id ?? ''
  const bSourceId = b.source?.id ?? ''
  return aSourceId.localeCompare(bSourceId, undefined, { sensitivity: 'base' })
    || a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
    || a.id.localeCompare(b.id, undefined, { sensitivity: 'base' })
}

export function normalizeOpencodeEnabledModelCatalog(raw: unknown): FreshAgentModelCapability[] {
  const providers = readProviderMap(raw)
  const models: FreshAgentModelCapability[] = []
  for (const [providerKey, rawProvider] of providers) {
    const provider = readRecord(rawProvider)
    if (!provider) continue
    const providerId = readNonEmptyString(provider.id) ?? providerKey
    if (!providerId || providerId.includes('/')) continue
    const providerDisplayName = cleanDisplayName(readNonEmptyString(provider.name) ?? providerId) || providerId
    for (const [modelKey, rawModel] of readModelEntries(provider)) {
      const model = readRecord(rawModel)
      if (!model) continue
      const modelId = readNonEmptyString(model.id) ?? modelKey
      if (!modelId) continue
      const displayName = cleanDisplayName(
        readNonEmptyString(model.name)
          ?? readNonEmptyString(model.displayName)
          ?? readNonEmptyString(model.display_name)
          ?? modelId,
      ) || modelId
      models.push(FreshAgentModelCapabilitySchema.parse({
        id: `${providerId}/${modelId}`,
        displayName,
        provider: 'opencode',
        source: { id: providerId, displayName: providerDisplayName },
        supportsEffort: true,
        supportedEffortLevels: ['minimal', 'low', 'medium', 'high', 'max'],
        supportsAdaptiveThinking: true,
      }))
    }
  }
  return models.sort(compareBySourceThenNameThenId)
}
