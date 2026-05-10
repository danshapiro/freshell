import path from 'node:path'
import { EventEmitter } from 'events'
import { z } from 'zod'
import type { OpencodeServerEndpoint } from '../local-port.js'
import { logger } from '../logger.js'
import { defaultOpencodeDataHome } from './providers/opencode.js'
import {
  confirmOpencodeAssociation,
  createOpencodeOwnershipState,
  reduceOpencodeOwnership,
  rejectOpencodeAssociation,
  type OpencodeObservation,
  type OpencodeOwnershipAction,
  type OpencodeOwnershipState,
} from './opencode-ownership-reducer.js'

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

export type OpencodeAssociationRequestedEvent = {
  terminalId: string
  sessionId: string
}

export type OpencodeTurnCompleteEvent = {
  terminalId: string
  sessionId: string
  at: number
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

const SessionCreatedEventSchema = z.object({
  type: z.literal('session.created'),
  properties: z.object({
    sessionID: z.string().min(1),
    info: z.object({
      id: z.string().min(1),
      parentID: z.string().nullable().optional(),
    }).passthrough(),
  }).passthrough(),
}).passthrough()

const OpencodeEventSchema = z.discriminatedUnion('type', [
  ServerConnectedEventSchema,
  SessionStatusEventSchema,
  SessionIdleEventSchema,
  SessionCreatedEventSchema,
])

const OpencodeEventTypeSchema = z.object({
  type: z.string().min(1),
}).passthrough()

const KNOWN_OPENCODE_EVENT_TYPES = new Set<z.infer<typeof OpencodeEventSchema>['type']>([
  'server.connected',
  'session.status',
  'session.idle',
  'session.created',
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
  ownership: OpencodeOwnershipState
  lastSnapshot?: {
    cycleId: number
    streamId: number
    statuses: Record<string, z.infer<typeof SessionStatusSchema>>
    at: number
  }
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

export class OpencodeActivityTracker extends EventEmitter {
  private readonly records = new Map<string, OpencodeActivityRecord>()
  private readonly monitors = new Map<string, MonitorState>()
  private readonly childSessionIds = new Map<string, Set<string>>()
  private readonly fetchImpl: FetchLike
  private readonly log: TrackerLogger
  private readonly now: () => number
  private readonly setTimeoutFn: typeof setTimeout
  private readonly clearTimeoutFn: typeof clearTimeout
  private readonly random: () => number
  private readonly dbPath?: string
  private nextCycleId = 0
  private nextStreamId = 0

  constructor(input: {
    fetchImpl?: FetchLike
    log?: TrackerLogger
    now?: () => number
    setTimeoutFn?: typeof setTimeout
    clearTimeoutFn?: typeof clearTimeout
    random?: () => number
    homeDir?: string
  } = {}) {
    super()
    this.fetchImpl = input.fetchImpl ?? fetch
    this.log = input.log ?? logger.child({ component: 'opencode-activity-tracker' })
    this.now = input.now ?? (() => Date.now())
    this.setTimeoutFn = input.setTimeoutFn ?? setTimeout
    this.clearTimeoutFn = input.clearTimeoutFn ?? clearTimeout
    this.random = input.random ?? Math.random
    const homeDir = input.homeDir ?? defaultOpencodeDataHome()
    this.dbPath = path.join(homeDir, 'opencode.db')
  }

  list(): OpencodeActivityRecord[] {
    return Array.from(this.records.values())
  }

  getActivity(terminalId: string): OpencodeActivityRecord | undefined {
    return this.records.get(terminalId)
  }

  trackTerminal(input: { terminalId: string; endpoint: OpencodeServerEndpoint; sessionId?: string }): void {
    const existing = this.monitors.get(input.terminalId)
    if (
      existing
      && existing.endpoint.hostname === input.endpoint.hostname
      && existing.endpoint.port === input.endpoint.port
      && !existing.disposed
    ) {
      existing.ownership = createOpencodeOwnershipState(input.sessionId)
      this.childSessionIds.delete(input.terminalId)
      return
    }

    this.untrackTerminal({ terminalId: input.terminalId })

    const monitor: MonitorState = {
      terminalId: input.terminalId,
      endpoint: input.endpoint,
      disposed: false,
      reconnectDelayMs: OPENCODE_RECONNECT_BASE_MS,
      ownership: createOpencodeOwnershipState(input.sessionId),
    }
    this.monitors.set(input.terminalId, monitor)
    if (input.sessionId) {
      void this.seedFromDb(monitor, [input.sessionId])
    }
    void this.runMonitor(monitor)
  }

  untrackTerminal(input: { terminalId: string }): void {
    const monitor = this.monitors.get(input.terminalId)
    if (monitor) {
      monitor.disposed = true
      monitor.lastSnapshot = undefined
      monitor.controller?.abort()
      if (monitor.reconnectTimer) {
        this.clearTimeoutFn(monitor.reconnectTimer)
        monitor.reconnectTimer = undefined
      }
      monitor.reconnectResolve?.()
      monitor.reconnectResolve = undefined
      this.monitors.delete(input.terminalId)
    }
    this.childSessionIds.delete(input.terminalId)
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
      const cycleId = ++this.nextCycleId
      try {
        await this.waitForHealth(monitor, controller.signal)
        monitor.reconnectDelayMs = OPENCODE_RECONNECT_BASE_MS
        await this.consumeEvents(monitor, cycleId, controller.signal)
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

  private async refreshSnapshot(
    monitor: MonitorState,
    cycleId: number,
    streamId: number,
    signal: AbortSignal,
  ): Promise<void> {
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

    const activeSessionIds = Object.keys(parsed.data)
    void this.resyncFromDb(monitor, activeSessionIds)

    const children = this.childSessionIds.get(monitor.terminalId)
    const filtered: Record<string, z.infer<typeof SessionStatusSchema>> = {}
    for (const [sessionId, status] of Object.entries(parsed.data)) {
      if (!children?.has(sessionId)) {
        filtered[sessionId] = status
      }
    }

    const at = this.now()
    monitor.lastSnapshot = { cycleId, streamId, statuses: parsed.data, at }
    this.observe(monitor, {
      kind: 'snapshot',
      cycleId,
      streamId,
      statuses: filtered,
      at,
    })
  }

  private async consumeEvents(monitor: MonitorState, cycleId: number, signal: AbortSignal): Promise<void> {
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
    let connected = false
    const streamId = ++this.nextStreamId

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
          const event = this.parseSseBlock(monitor.terminalId, block)
          if (event?.type === 'server.connected' && !connected) {
            connected = true
            await this.refreshSnapshot(monitor, cycleId, streamId, signal)
          } else if (event && event.type !== 'server.connected') {
            this.handleOpencodeEvent(monitor, cycleId, streamId, event)
          }
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

  private parseSseBlock(
    terminalId: string,
    block: string,
  ): z.infer<typeof OpencodeEventSchema> | undefined {
    const data = parseSseData(block)
    if (!data) return undefined

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
      return undefined
    }

    return event
  }

  private handleOpencodeEvent(
    monitor: MonitorState,
    cycleId: number,
    streamId: number,
    event: Exclude<z.infer<typeof OpencodeEventSchema>, { type: 'server.connected' }>,
  ): void {
    if (event.type === 'session.created') {
      const parentId = event.properties.info.parentID
      if (parentId) {
        this.registerChildSession(monitor.terminalId, event.properties.sessionID)
        if (monitor.lastSnapshot && monitor.ownership.kind === 'ambiguous') {
          monitor.ownership = { ...monitor.ownership, knownSessionId: parentId }
          const children = this.childSessionIds.get(monitor.terminalId)
          const filtered: Record<string, z.infer<typeof SessionStatusSchema>> = {}
          for (const [sessionId, status] of Object.entries(monitor.lastSnapshot.statuses)) {
            if (!children?.has(sessionId)) {
              filtered[sessionId] = status
            }
          }
          this.observe(monitor, {
            kind: 'snapshot',
            cycleId: monitor.lastSnapshot.cycleId,
            streamId: monitor.lastSnapshot.streamId,
            statuses: filtered,
            at: monitor.lastSnapshot.at,
          })
        }
      }
      return
    }

    const children = this.childSessionIds.get(monitor.terminalId)
    if (children?.has(event.properties.sessionID)) {
      if (event.type === 'session.idle') {
        children.delete(event.properties.sessionID)
      }
      return
    }

    if (event.type === 'session.idle') {
      this.observe(monitor, {
        kind: 'sse',
        cycleId,
        streamId,
        sessionId: event.properties.sessionID,
        status: 'idle',
        at: this.now(),
      })
      return
    }

    this.observe(monitor, {
      kind: 'sse',
      cycleId,
      streamId,
      sessionId: event.properties.sessionID,
      status: event.properties.status.type,
      at: this.now(),
    })
  }

  confirmSessionAssociation(input: { terminalId: string; sessionId: string }): void {
    const monitor = this.monitors.get(input.terminalId)
    if (!monitor || monitor.disposed) return
    const result = confirmOpencodeAssociation(monitor.ownership, { sessionId: input.sessionId })
    monitor.ownership = result.state
    this.applyActions(monitor.terminalId, result.actions)
  }

  rejectSessionAssociation(input: { terminalId: string; sessionId: string }): void {
    const monitor = this.monitors.get(input.terminalId)
    if (!monitor || monitor.disposed) return
    const result = rejectOpencodeAssociation(monitor.ownership, { sessionId: input.sessionId })
    monitor.ownership = result.state
    this.applyActions(monitor.terminalId, result.actions)
  }

  private observe(monitor: MonitorState, observation: OpencodeObservation): void {
    const result = reduceOpencodeOwnership(monitor.ownership, observation)
    monitor.ownership = result.state
    this.applyActions(monitor.terminalId, result.actions)
  }

  private applyActions(terminalId: string, actions: OpencodeOwnershipAction[]): void {
    for (const action of actions) {
      if (action.kind === 'activityUpsert') {
        this.upsertRecord({
          terminalId,
          sessionId: action.sessionId,
          phase: 'busy',
          updatedAt: action.at,
        })
        continue
      }
      if (action.kind === 'activityRemove') {
        this.removeRecord(terminalId)
        continue
      }
      if (action.kind === 'requestAssociation') {
        this.emit('association.requested', {
          terminalId,
          sessionId: action.sessionId,
        } satisfies OpencodeAssociationRequestedEvent)
        continue
      }
      if (action.kind === 'turnComplete') {
        this.emit('turn.complete', {
          terminalId,
          sessionId: action.sessionId,
          at: action.at,
        } satisfies OpencodeTurnCompleteEvent)
        continue
      }
      if (action.kind === 'warnAmbiguous') {
        this.log.warn({
          terminalId,
          sessionIds: action.sessionIds,
        }, 'OpenCode endpoint reported ambiguous session ownership; suppressing durable adoption.')
      }
    }
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

  private registerChildSession(terminalId: string, sessionId: string): void {
    let children = this.childSessionIds.get(terminalId)
    if (!children) {
      children = new Set()
      this.childSessionIds.set(terminalId, children)
    }
    children.add(sessionId)
  }

  private async resyncFromDb(monitor: MonitorState, activeSessionIds: string[]): Promise<void> {
    if (!this.dbPath || activeSessionIds.length === 0) return
    let sqlite: typeof import('node:sqlite') | undefined
    let db: InstanceType<typeof import('node:sqlite').DatabaseSync> | undefined
    try {
      sqlite = await import('node:sqlite')
      db = new sqlite.DatabaseSync(this.dbPath, { readOnly: true })
      const placeholders = activeSessionIds.map(() => '?').join(',')
      const rows = db.prepare(
        `SELECT id, parent_id FROM session WHERE id IN (${placeholders}) AND parent_id IS NOT NULL`
      ).all(...activeSessionIds) as Array<{ id: string; parent_id: string }>
      for (const row of rows) {
        this.registerChildSession(monitor.terminalId, row.id)
      }
    } catch {
      // DB unavailable or node:sqlite not supported — children unfiltered in this snapshot
    } finally {
      db?.close()
    }
  }

  private async seedFromDb(monitor: MonitorState, parentIds: string[]): Promise<void> {
    if (!this.dbPath || parentIds.length === 0) return
    let sqlite: typeof import('node:sqlite') | undefined
    let db: InstanceType<typeof import('node:sqlite').DatabaseSync> | undefined
    try {
      sqlite = await import('node:sqlite')
      db = new sqlite.DatabaseSync(this.dbPath, { readOnly: true })
      const placeholders = parentIds.map(() => '?').join(',')
      const rows = db.prepare(
        `SELECT id FROM session WHERE parent_id IN (${placeholders}) AND time_archived IS NULL`
      ).all(...parentIds) as Array<{ id: string }>
      for (const row of rows) {
        this.registerChildSession(monitor.terminalId, row.id)
      }
    } catch {
      // DB unavailable — first snapshot will catch via resyncFromDb
    } finally {
      db?.close()
    }
  }
}
