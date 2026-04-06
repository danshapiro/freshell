import { EventEmitter } from 'events'
import { z } from 'zod'
import type { OpencodeServerEndpoint } from '../local-port.js'
import { logger } from '../logger.js'

export const OPENCODE_HEALTH_POLL_MS = 200
// Applies per health-wait cycle; connection failures restart the cycle after backoff.
export const OPENCODE_HEALTH_TIMEOUT_MS = 15_000
export const OPENCODE_RECONNECT_BASE_MS = 250
export const OPENCODE_RECONNECT_MAX_MS = 5_000

export type OpencodeActivityPhase = 'busy'

export type OpencodeActivityRecord = {
  terminalId: string
  sessionId?: string
  phase: OpencodeActivityPhase
  updatedAt: number
}

export type OpencodeActivityChange = {
  upsert: OpencodeActivityRecord[]
  remove: string[]
}

const SessionIdleStatusSchema = z.object({
  type: z.literal('idle'),
}).passthrough()

const SessionBusyStatusSchema = z.object({
  type: z.literal('busy'),
}).passthrough()

const SessionRetryStatusSchema = z.object({
  type: z.literal('retry'),
}).passthrough()

const SessionStatusSchema = z.discriminatedUnion('type', [
  SessionIdleStatusSchema,
  SessionBusyStatusSchema,
  SessionRetryStatusSchema,
])

const SessionStatusMapSchema = z.record(z.string(), SessionStatusSchema)

const ServerConnectedEventSchema = z.object({
  type: z.literal('server.connected'),
}).passthrough()

const SessionStatusEventSchema = z.object({
  type: z.literal('session.status'),
  properties: z.object({
    sessionID: z.string().min(1),
    status: SessionStatusSchema,
  }).passthrough(),
}).passthrough()

const SessionIdleEventSchema = z.object({
  type: z.literal('session.idle'),
  properties: z.object({
    sessionID: z.string().min(1),
  }).passthrough(),
}).passthrough()

const OpencodeEventSchema = z.discriminatedUnion('type', [
  ServerConnectedEventSchema,
  SessionStatusEventSchema,
  SessionIdleEventSchema,
])

const OpencodeEventTypeSchema = z.object({
  type: z.string().min(1),
}).passthrough()

const KNOWN_OPENCODE_EVENT_TYPES = new Set<z.infer<typeof OpencodeEventSchema>['type']>([
  'server.connected',
  'session.status',
  'session.idle',
])

type FetchLike = typeof fetch

type TrackerLogger = {
  warn: (payload: object, message?: string) => void
}

type MonitorState = {
  terminalId: string
  endpoint: OpencodeServerEndpoint
  disposed: boolean
  controller?: AbortController
  reconnectDelayMs: number
  reconnectTimer?: ReturnType<typeof setTimeout>
  reconnectResolve?: () => void
}

function createAbortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function createAbortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(createAbortError())
      return
    }
    signal.addEventListener('abort', () => reject(createAbortError()), { once: true })
  })
}

function parseSseData(block: string): string | undefined {
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue
    if (!line.startsWith('data:')) continue
    dataLines.push(line.slice(5).trimStart())
  }
  return dataLines.length > 0 ? dataLines.join('\n') : undefined
}

function parseOpencodeEvent(data: string): z.infer<typeof OpencodeEventSchema> | undefined {
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(data)
  } catch {
    throw new Error('OpenCode event payload was not valid JSON.')
  }

  const parsedType = OpencodeEventTypeSchema.safeParse(parsedJson)
  if (!parsedType.success) {
    throw new Error('OpenCode event payload did not include a string type.')
  }
  if (!KNOWN_OPENCODE_EVENT_TYPES.has(parsedType.data.type as z.infer<typeof OpencodeEventSchema>['type'])) {
    return undefined
  }

  const parsedEvent = OpencodeEventSchema.safeParse(parsedJson)
  if (!parsedEvent.success) {
    throw new Error('OpenCode event payload did not match the expected schema.')
  }

  return parsedEvent.data
}

function extractBusySessionId(
  snapshot: Record<string, z.infer<typeof SessionStatusSchema>>,
  currentSessionId?: string,
): string | undefined {
  const busySessionIds = Object.entries(snapshot)
    .filter(([, status]) => status.type !== 'idle')
    .map(([sessionId]) => sessionId)
    .sort()
  if (busySessionIds.length === 0) return undefined
  if (currentSessionId && busySessionIds.includes(currentSessionId)) {
    return currentSessionId
  }
  return busySessionIds[0]
}

export class OpencodeActivityTracker extends EventEmitter {
  private readonly records = new Map<string, OpencodeActivityRecord>()
  private readonly monitors = new Map<string, MonitorState>()
  private readonly fetchImpl: FetchLike
  private readonly log: TrackerLogger
  private readonly now: () => number
  private readonly setTimeoutFn: typeof setTimeout
  private readonly clearTimeoutFn: typeof clearTimeout
  private readonly random: () => number

  constructor(input: {
    fetchImpl?: FetchLike
    log?: TrackerLogger
    now?: () => number
    setTimeoutFn?: typeof setTimeout
    clearTimeoutFn?: typeof clearTimeout
    random?: () => number
  } = {}) {
    super()
    this.fetchImpl = input.fetchImpl ?? fetch
    this.log = input.log ?? logger.child({ component: 'opencode-activity-tracker' })
    this.now = input.now ?? (() => Date.now())
    this.setTimeoutFn = input.setTimeoutFn ?? setTimeout
    this.clearTimeoutFn = input.clearTimeoutFn ?? clearTimeout
    this.random = input.random ?? Math.random
  }

  list(): OpencodeActivityRecord[] {
    return Array.from(this.records.values())
  }

  getActivity(terminalId: string): OpencodeActivityRecord | undefined {
    return this.records.get(terminalId)
  }

  trackTerminal(input: { terminalId: string; endpoint: OpencodeServerEndpoint }): void {
    const existing = this.monitors.get(input.terminalId)
    if (
      existing
      && existing.endpoint.hostname === input.endpoint.hostname
      && existing.endpoint.port === input.endpoint.port
      && !existing.disposed
    ) {
      return
    }

    this.untrackTerminal({ terminalId: input.terminalId })

    const monitor: MonitorState = {
      terminalId: input.terminalId,
      endpoint: input.endpoint,
      disposed: false,
      reconnectDelayMs: OPENCODE_RECONNECT_BASE_MS,
    }
    this.monitors.set(input.terminalId, monitor)
    void this.runMonitor(monitor)
  }

  untrackTerminal(input: { terminalId: string }): void {
    const monitor = this.monitors.get(input.terminalId)
    if (monitor) {
      monitor.disposed = true
      monitor.controller?.abort()
      if (monitor.reconnectTimer) {
        this.clearTimeoutFn(monitor.reconnectTimer)
        monitor.reconnectTimer = undefined
      }
      monitor.reconnectResolve?.()
      monitor.reconnectResolve = undefined
      this.monitors.delete(input.terminalId)
    }
    this.removeRecord(input.terminalId)
  }

  dispose(): void {
    for (const terminalId of Array.from(this.monitors.keys())) {
      this.untrackTerminal({ terminalId })
    }
  }

  private async runMonitor(monitor: MonitorState): Promise<void> {
    while (!monitor.disposed) {
      const controller = new AbortController()
      monitor.controller = controller
      try {
        await this.waitForHealth(monitor, controller.signal)
        await this.refreshSnapshot(monitor, controller.signal)
        monitor.reconnectDelayMs = OPENCODE_RECONNECT_BASE_MS
        await this.consumeEvents(monitor, controller.signal)
      } catch (error) {
        if (monitor.disposed || isAbortError(error)) {
          return
        }
        this.log.warn({
          terminalId: monitor.terminalId,
          endpoint: monitor.endpoint,
          err: error,
        }, 'OpenCode activity tracker cycle failed; retrying.')
      } finally {
        if (monitor.controller === controller) {
          monitor.controller = undefined
        }
      }

      if (monitor.disposed) return
      await this.sleepWithBackoff(monitor)
    }
  }

  private async waitForHealth(monitor: MonitorState, signal: AbortSignal): Promise<void> {
    const startedAt = this.now()
    while (true) {
      try {
        const response = await this.fetchImpl(this.buildUrl(monitor.endpoint, '/global/health'), {
          signal,
        })
        if (response.ok) {
          return
        }
      } catch (error) {
        if (isAbortError(error)) {
          throw error
        }
      }
      if (this.now() - startedAt >= OPENCODE_HEALTH_TIMEOUT_MS) {
        throw new Error('Timed out waiting for OpenCode health endpoint.')
      }
      await this.sleep(signal, OPENCODE_HEALTH_POLL_MS)
    }
  }

  private async refreshSnapshot(monitor: MonitorState, signal: AbortSignal): Promise<void> {
    const response = await this.fetchImpl(this.buildUrl(monitor.endpoint, '/session/status'), {
      signal,
    })
    if (!response.ok) {
      throw new Error(`OpenCode session status request failed with ${response.status}.`)
    }

    const parsed = SessionStatusMapSchema.safeParse(await response.json())
    if (!parsed.success) {
      throw new Error('OpenCode session status response did not match the expected schema.')
    }

    const current = this.records.get(monitor.terminalId)
    const busySessionId = extractBusySessionId(parsed.data, current?.sessionId)
    if (!busySessionId) {
      this.removeRecord(monitor.terminalId)
      return
    }

    this.upsertRecord({
      terminalId: monitor.terminalId,
      sessionId: busySessionId,
      phase: 'busy',
      updatedAt: this.now(),
    })
  }

  private async consumeEvents(monitor: MonitorState, signal: AbortSignal): Promise<void> {
    const response = await this.fetchImpl(this.buildUrl(monitor.endpoint, '/event'), {
      signal,
      headers: { accept: 'text/event-stream' },
    })
    if (!response.ok || !response.body) {
      throw new Error(`OpenCode event stream request failed with ${response.status}.`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const abortPromise = createAbortPromise(signal)
    let buffer = ''

    try {
      while (true) {
        const result = await Promise.race([
          reader.read(),
          abortPromise,
        ])

        if (result.done) {
          return
        }

        buffer += decoder.decode(result.value, { stream: true })
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n')

        let separatorIndex = buffer.indexOf('\n\n')
        while (separatorIndex >= 0) {
          const block = buffer.slice(0, separatorIndex)
          buffer = buffer.slice(separatorIndex + 2)
          this.handleSseBlock(monitor.terminalId, block)
          separatorIndex = buffer.indexOf('\n\n')
        }
      }
    } finally {
      try {
        await reader.cancel()
      } catch {
        // ignore cancellation errors during teardown
      }
    }
  }

  private handleSseBlock(terminalId: string, block: string): void {
    const data = parseSseData(block)
    if (!data) return

    let event: z.infer<typeof OpencodeEventSchema> | undefined
    try {
      event = parseOpencodeEvent(data)
    } catch (error) {
      const endpoint = this.monitors.get(terminalId)?.endpoint
      this.log.warn({
        terminalId,
        endpoint,
        err: error,
      }, 'OpenCode event payload was invalid; skipping payload.')
      return
    }

    if (!event) return
    if (event.type === 'server.connected') return
    if (event.type === 'session.idle') {
      this.removeRecordForSession(terminalId, event.properties.sessionID)
      return
    }
    if (event.properties.status.type === 'idle') {
      this.removeRecordForSession(terminalId, event.properties.sessionID)
      return
    }

    this.upsertRecord({
      terminalId,
      sessionId: event.properties.sessionID,
      phase: 'busy',
      updatedAt: this.now(),
    })
  }

  private async sleepWithBackoff(monitor: MonitorState): Promise<void> {
    const baseDelay = monitor.reconnectDelayMs
    const jitter = Math.floor(baseDelay * 0.1 * this.random())
    const delayMs = Math.min(OPENCODE_RECONNECT_MAX_MS, baseDelay + jitter)
    monitor.reconnectDelayMs = Math.min(OPENCODE_RECONNECT_MAX_MS, baseDelay * 2)
    await new Promise<void>((resolve) => {
      monitor.reconnectResolve = resolve
      monitor.reconnectTimer = this.setTimeoutFn(() => {
        monitor.reconnectTimer = undefined
        monitor.reconnectResolve = undefined
        resolve()
      }, delayMs)
    })
  }

  private async sleep(signal: AbortSignal, delayMs: number): Promise<void> {
    if (signal.aborted) {
      throw createAbortError()
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => {
      if (timer) {
        this.clearTimeoutFn(timer)
      }
    }

    try {
      await Promise.race([
        new Promise<void>((resolve) => {
          timer = this.setTimeoutFn(() => {
            timer = undefined
            resolve()
          }, delayMs)
          signal.addEventListener('abort', onAbort, { once: true })
        }),
        createAbortPromise(signal),
      ])
    } finally {
      signal.removeEventListener('abort', onAbort)
      if (timer) {
        this.clearTimeoutFn(timer)
      }
    }
  }

  private buildUrl(endpoint: OpencodeServerEndpoint, pathname: string): string {
    return `http://${endpoint.hostname}:${endpoint.port}${pathname}`
  }

  private removeRecordForSession(terminalId: string, sessionId: string): void {
    const existing = this.records.get(terminalId)
    if (!existing) return
    if (existing.sessionId && existing.sessionId !== sessionId) return
    this.removeRecord(terminalId)
  }

  private upsertRecord(record: OpencodeActivityRecord): void {
    const previous = this.records.get(record.terminalId)
    if (
      previous
      && previous.sessionId === record.sessionId
      && previous.phase === record.phase
      && previous.updatedAt === record.updatedAt
    ) {
      return
    }
    this.records.set(record.terminalId, record)
    this.emit('changed', {
      upsert: [record],
      remove: [],
    } satisfies OpencodeActivityChange)
  }

  private removeRecord(terminalId: string): void {
    if (!this.records.delete(terminalId)) return
    this.emit('changed', {
      upsert: [],
      remove: [terminalId],
    } satisfies OpencodeActivityChange)
  }
}
