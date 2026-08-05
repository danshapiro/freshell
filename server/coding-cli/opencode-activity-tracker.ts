import { EventEmitter } from 'events'
import { z } from 'zod'
import type { TerminalTurnCompletionSnapshot } from '../../shared/ws-protocol.js'
import type { OpencodeServerEndpoint } from '../local-port.js'
import { logger } from '../logger.js'
import type { OpencodeRootResolution } from './providers/opencode.js'
import {
  confirmOpencodeAssociation,
  createOpencodeOwnershipState,
  reduceOpencodeOwnership,
  rejectOpencodeAssociation,
  type OpencodeObservation,
  type OpencodeOwnershipAction,
  type OpencodeOwnershipState,
} from './opencode-ownership-reducer.js'
import { TurnCompletionLedger } from './turn-completion-ledger.js'

export const OPENCODE_HEALTH_POLL_MS = 200
// Applies per health-wait cycle; connection failures restart the cycle after backoff.
export const OPENCODE_HEALTH_TIMEOUT_MS = 15_000
export const OPENCODE_RECONNECT_BASE_MS = 250
export const OPENCODE_RECONNECT_MAX_MS = 5_000
export const OPENCODE_BUSY_DEADMAN_MS = 120_000
export const OPENCODE_EVENT_READ_STALL_MS = 30_000
export const OPENCODE_ACTIVITY_SWEEP_MS = 5_000

export type OpencodeActivityPhase = 'busy'

export type OpencodeActivityRecord = {
  terminalId: string
  sessionId?: string
  phase: OpencodeActivityPhase
  updatedAt: number
  lastObservedAt: number
}

export type OpencodeActivityChange = {
  upsert: OpencodeActivityRecord[]
  remove: string[]
  /**
   * Terminals whose PTY exit was NOT freshell-initiated (registry
   * `spontaneous: !requestedClose`). Internal-only: the ws-handler's zod
   * re-validation strips it from the wire. Death-bell input for the
   * truly-idle emitter.
   */
  spontaneousExitRemovals?: string[]
  /** Terminals with a pending permission pause at exit time (rings even though the record is absent). */
  approvalPendingRemovals?: string[]
}

export type OpencodeAssociationRequestedEvent = {
  terminalId: string
  sessionId: string
}

export type OpencodeTurnCompleteEvent = {
  terminalId: string
  sessionId: string
  at: number
  completionSeq: number
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

const SessionErrorEventSchema = z
  .object({
    type: z.literal('session.error'),
    properties: z
      .object({
        sessionID: z.string().min(1),
        error: z.object({ name: z.string().min(1) }).passthrough(),
      })
      .passthrough(),
  })
  .passthrough()

const MessageUpdatedEventSchema = z
  .object({
    type: z.literal('message.updated'),
    properties: z
      .object({
        sessionID: z.string().min(1),
        info: z
          .object({ error: z.object({ name: z.string().min(1) }).passthrough().optional() })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough()

// derives from opencode 1.18.11: permission.asked carries a unique permission
// id (echoed back as requestID on permission.replied) and the ASKING session's
// id -- a child session asks under its OWN sessionID while the parent turn
// blocks on the answer.
const PermissionAskedEventSchema = z
  .object({
    type: z.literal('permission.asked'),
    properties: z.object({ id: z.string().min(1), sessionID: z.string().min(1) }).passthrough(),
  })
  .passthrough()

const PermissionRepliedEventSchema = z
  .object({
    type: z.literal('permission.replied'),
    properties: z.object({ sessionID: z.string().min(1), requestID: z.string().min(1) }).passthrough(),
  })
  .passthrough()

const OpencodeEventSchema = z.discriminatedUnion('type', [
  ServerConnectedEventSchema,
  SessionStatusEventSchema,
  SessionIdleEventSchema,
  SessionCreatedEventSchema,
  SessionErrorEventSchema,
  MessageUpdatedEventSchema,
  PermissionAskedEventSchema,
  PermissionRepliedEventSchema,
])

const OpencodeEventTypeSchema = z.object({
  type: z.string().min(1),
}).passthrough()

const KNOWN_OPENCODE_EVENT_TYPES = new Set<z.infer<typeof OpencodeEventSchema>['type']>([
  'server.connected',
  'session.status',
  'session.idle',
  'session.created',
  'session.error',
  'message.updated',
  'permission.asked',
  'permission.replied',
])

// derives from opencode 1.18.11: /global/health returns { healthy, version },
// both required. session.idle is already deprecated upstream and a v1->v2
// event/health migration is in progress — warn on untested versions, but keep
// bells ON (best-effort; the gate converts silent drift into a logged warning).
const TESTED_OPENCODE_VERSION_RANGE = '1.18.'

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
  versionWarned?: boolean
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

const defaultResolveOpencodeSessionRoots = async (
  sessionIds: readonly string[],
): Promise<OpencodeRootResolution> => ({
  rootsBySessionId: new Map(sessionIds.map((sessionId) => [sessionId, sessionId])),
  unresolvedSessionIds: new Set<string>(),
})

export class OpencodeActivityTracker extends EventEmitter {
  private readonly records = new Map<string, OpencodeActivityRecord>()
  private readonly completionLedger = new TurnCompletionLedger()
  private readonly monitors = new Map<string, MonitorState>()
  private readonly childSessionIds = new Map<string, Set<string>>()
  private readonly sessionRootsByTerminal = new Map<string, Map<string, string>>()
  // Pending permission-request ids per terminal (codex pendingApprovals mirror).
  private readonly pendingPermissions = new Map<string, Set<string>>()
  private readonly fetchImpl: FetchLike
  private readonly log: TrackerLogger
  private readonly now: () => number
  private readonly setTimeoutFn: typeof setTimeout
  private readonly clearTimeoutFn: typeof clearTimeout
  private readonly random: () => number
  private readonly resolveOpencodeSessionRoots: (sessionIds: readonly string[]) => Promise<OpencodeRootResolution>
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
    resolveOpencodeSessionRoots?: (sessionIds: readonly string[]) => Promise<OpencodeRootResolution>
    allowIdentityRootResolverForTests?: boolean
  } = {}) {
    super()
    this.fetchImpl = input.fetchImpl ?? fetch
    this.log = input.log ?? logger.child({ component: 'opencode-activity-tracker' })
    this.now = input.now ?? (() => Date.now())
    this.setTimeoutFn = input.setTimeoutFn ?? setTimeout
    this.clearTimeoutFn = input.clearTimeoutFn ?? clearTimeout
    this.random = input.random ?? Math.random
    if (input.resolveOpencodeSessionRoots) {
      this.resolveOpencodeSessionRoots = input.resolveOpencodeSessionRoots
    } else if (input.allowIdentityRootResolverForTests || process.env.NODE_ENV === 'test') {
      this.resolveOpencodeSessionRoots = defaultResolveOpencodeSessionRoots
    } else {
      throw new Error('OpenCode root session resolver is required outside tests.')
    }
  }

  list(): OpencodeActivityRecord[] {
    return Array.from(this.records.values())
  }

  getActivity(terminalId: string): OpencodeActivityRecord | undefined {
    return this.records.get(terminalId)
  }

  listLatestCompletions(): TerminalTurnCompletionSnapshot[] {
    return this.completionLedger.listLatestCompletions()
  }

  expire(at = this.now()): void {
    for (const record of Array.from(this.records.values())) {
      if (at - record.lastObservedAt > OPENCODE_BUSY_DEADMAN_MS) {
        this.removeRecord(record.terminalId)
      }
    }
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
      existing.versionWarned = false
      this.childSessionIds.delete(input.terminalId)
      this.sessionRootsByTerminal.delete(input.terminalId)
      this.pendingPermissions.delete(input.terminalId)
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
    void this.runMonitor(monitor)
  }

  untrackTerminal(input: { terminalId: string; spontaneous?: boolean }): void {
    const monitor = this.monitors.get(input.terminalId)
    // Engagement inputs are captured BEFORE teardown destroys them.
    // candidate/ambiguous ownership never death-rings (D4: that noise is why
    // opencode death bells were excluded before).
    const ownershipKind = monitor?.ownership.kind
    // `monitor !== undefined` gates the whole path: the wiring subscribes to
    // EVERY registry terminal.exit (non-opencode panes included), so a
    // never-tracked terminal must fall through to the silent removeRecord
    // branch exactly as today. A permission pause removes only the record,
    // never the monitor, so paused panes keep their monitor and stay eligible.
    const deathBellEligible =
      monitor !== undefined &&
      input.spontaneous === true &&
      ownershipKind !== 'candidate' &&
      ownershipKind !== 'ambiguous' &&
      ownershipKind !== 'awaitingAssociation'
    const approvalPending = this.hasPendingPermissions(input.terminalId)
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
    this.sessionRootsByTerminal.delete(input.terminalId)
    this.pendingPermissions.delete(input.terminalId)
    if (deathBellEligible) {
      // Emit UNCONDITIONALLY: the record is usually already gone (turn ended
      // or pause demoted), and the emitter needs the marked removal to reach
      // its armed-grace / approval-pending checks.
      this.records.delete(input.terminalId)
      this.emit('changed', {
        upsert: [],
        remove: [input.terminalId],
        spontaneousExitRemovals: [input.terminalId],
        ...(approvalPending ? { approvalPendingRemovals: [input.terminalId] } : {}),
      } satisfies OpencodeActivityChange)
    } else {
      this.removeRecord(input.terminalId)
    }
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
          await this.warnOnVersionDrift(monitor, response)
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

  private async warnOnVersionDrift(monitor: MonitorState, response: Response): Promise<void> {
    if (monitor.versionWarned) return
    let version: unknown
    try {
      const body = (await response.json()) as { version?: unknown } | null
      version = body?.version
    } catch {
      return
    }
    if (typeof version !== 'string' || version.startsWith(TESTED_OPENCODE_VERSION_RANGE)) return
    monitor.versionWarned = true
    this.log.warn(
      { terminalId: monitor.terminalId, endpoint: monitor.endpoint, version },
      `OpenCode version ${version} has not been tested with the freshell activity tracker `
      + `(tested: ${TESTED_OPENCODE_VERSION_RANGE}x); keeping attention bells on best-effort.`,
    )
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

    const at = this.now()
    const classified = await this.classifySnapshotStatuses(monitor, parsed.data)
    monitor.lastSnapshot = { cycleId, streamId, statuses: classified.statuses, at }
    this.warnIfMultipleActiveRoots(monitor.terminalId, classified.statuses, classified.unresolvedSessionIds)
    if (classified.unresolvedSessionIds.size > 0) {
      this.upsertRecord({
        terminalId: monitor.terminalId,
        phase: 'busy',
        updatedAt: at,
      })
      return
    }
    this.observe(monitor, {
      kind: 'snapshot',
      cycleId,
      streamId,
      statuses: classified.statuses,
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
    let readStallTimer: ReturnType<typeof setTimeout> | undefined
    let readStallPromise: Promise<never> = new Promise<never>(() => {})

    const resetReadStallTimer = () => {
      if (readStallTimer) {
        this.clearTimeoutFn(readStallTimer)
        readStallTimer = undefined
      }
      readStallPromise = new Promise<never>((_, reject) => {
        readStallTimer = this.setTimeoutFn(() => {
          readStallTimer = undefined
          reject(new Error('OpenCode event stream stalled without data.'))
        }, OPENCODE_EVENT_READ_STALL_MS)
      })
    }
    resetReadStallTimer()

    try {
      while (true) {
        const result = await Promise.race([
          reader.read(),
          abortPromise,
          readStallPromise,
        ])

        if (result.done) {
          return
        }

        resetReadStallTimer()

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
            await this.handleOpencodeEvent(monitor, cycleId, streamId, event)
          }
          separatorIndex = buffer.indexOf('\n\n')
        }
      }
    } finally {
      if (readStallTimer) {
        this.clearTimeoutFn(readStallTimer)
      }
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

  private async handleOpencodeEvent(
    monitor: MonitorState,
    cycleId: number,
    streamId: number,
    event: Exclude<z.infer<typeof OpencodeEventSchema>, { type: 'server.connected' }>,
  ): Promise<void> {
    if (event.type === 'session.created') {
      const parentId = event.properties.info.parentID
      if (parentId) {
        this.registerChildSession(monitor.terminalId, event.properties.sessionID, parentId)
        if (monitor.lastSnapshot && monitor.ownership.kind === 'ambiguous') {
          monitor.ownership = { ...monitor.ownership, knownSessionId: parentId }
          this.observe(monitor, {
            kind: 'snapshot',
            cycleId: monitor.lastSnapshot.cycleId,
            streamId: monitor.lastSnapshot.streamId,
            statuses: this.classifyKnownSnapshotStatuses(monitor.terminalId, monitor.lastSnapshot.statuses),
            at: monitor.lastSnapshot.at,
          })
        }
      }
      return
    }

    if (event.type === 'session.error') {
      const rawSessionId = event.properties.sessionID
      const rootSessionId = await this.resolveRootForEvent(monitor, rawSessionId)
      // Child or unresolved errors never gate the root's turn (a sub-agent
      // abort must not silence the parent; conservative for unknown ids).
      if (rootSessionId === undefined || rootSessionId !== rawSessionId) return
      this.observe(monitor, {
        kind: 'error',
        cycleId,
        streamId,
        sessionId: rootSessionId,
        errorName: event.properties.error.name,
        at: this.now(),
      })
      return
    }

    if (event.type === 'message.updated') {
      // W2 abort marker (derives from opencode 1.18.11): an abort landing
      // between assistant-message creation and LLM stream start emits NO
      // session.error — only message.updated with info.error.name ===
      // 'MessageAbortedError', always BEFORE the idle edge. Error-less
      // message.updated is routine message churn: no attention signal.
      const errorName = event.properties.info.error?.name
      if (errorName === undefined) return
      const rawSessionId = event.properties.sessionID
      const rootSessionId = await this.resolveRootForEvent(monitor, rawSessionId)
      // Same raw-equality scoping as session.error: child or unresolved
      // markers never gate the root's turn.
      if (rootSessionId === undefined || rootSessionId !== rawSessionId) return
      this.observe(monitor, {
        kind: 'error',
        cycleId,
        streamId,
        sessionId: rootSessionId,
        errorName,
        at: this.now(),
      })
      return
    }

    if (event.type === 'permission.asked') {
      // Root-resolve the asker (D3): children CAN ask -- the event is stamped
      // with the CHILD session id and the parent turn blocks on it (opencode
      // v1.18.11 source, validation pass 2026-08-03). Multi-level chain walk;
      // mappings are retained for the session's lifetime.
      const rootSessionId = await this.resolveRootForEvent(monitor, event.properties.sessionID)
      if (rootSessionId === undefined) return
      const ownership = monitor.ownership
      // Arm under knownBusy OR candidate ownership: a fresh pane is candidate
      // for its ENTIRE first turn by construction (the bind lands only at the
      // first idle edge), and the single busy unbound session on the pane's
      // own per-pane endpoint is this pane's turn -- first-turn tool-permission
      // asks are the most common attention scenario and must ring (D3).
      // Ambiguous/quiet stays conservative (no bells).
      if (
        (ownership.kind !== 'knownBusy' && ownership.kind !== 'candidate') ||
        ownership.sessionId !== rootSessionId
      ) {
        return
      }
      const pending = this.pendingPermissions.get(monitor.terminalId) ?? new Set<string>()
      const newlyInserted = !pending.has(event.properties.id)
      pending.add(event.properties.id)
      this.pendingPermissions.set(monitor.terminalId, pending)
      if (!newlyInserted) return // duplicate asked never re-arms
      const at = this.now()
      // Demote FIRST (record removal is opencode's not-busy on the wire),
      // boundary SECOND -- the gate must see not-busy before it arms
      // (codex ordering, codex-activity-tracker.ts:377-382).
      this.removeRecord(monitor.terminalId)
      this.emit('attention.boundary', { terminalId: monitor.terminalId, at })
      return
    }

    if (event.type === 'permission.replied') {
      const pending = this.pendingPermissions.get(monitor.terminalId)
      if (!pending?.delete(event.properties.requestID)) return
      if (pending.size > 0) return
      this.pendingPermissions.delete(monitor.terminalId)
      const ownership = monitor.ownership
      // Restore under candidate too -- pause mechanics are identical (D3).
      if (ownership.kind !== 'knownBusy' && ownership.kind !== 'candidate') return
      // Resume busy immediately (codex resume_busy_after_approval analog):
      // the reply proves a human is present; busy re-entry cancels the armed
      // grace window without waiting ~1s for the next session.status{busy}.
      this.upsertRecord({
        terminalId: monitor.terminalId,
        sessionId: ownership.sessionId,
        phase: 'busy',
        updatedAt: this.now(),
        lastObservedAt: this.now(),
      })
      return
    }

    const observedSessionId = await this.resolveRootForEvent(monitor, event.properties.sessionID)
    const observedStatus = event.type === 'session.idle'
      ? 'idle'
      : event.properties.status.type

    if (observedStatus === 'idle') {
      // Child sessions go idle mid-parent-turn (live trace: child idle 921ms
      // before the parent, events-D.log). Remapping a CHILD idle onto the
      // root falsely completes the root's turn — suppress it. The root's own
      // idle (raw id == resolved root) passes through unchanged.
      if (observedSessionId !== undefined && observedSessionId !== event.properties.sessionID) {
        return
      }
      this.observe(monitor, {
        kind: 'sse',
        cycleId,
        streamId,
        sessionId: observedSessionId ?? event.properties.sessionID,
        status: 'idle',
        at: this.now(),
      })
      return
    }

    if (!observedSessionId) {
      this.upsertRecord({
        terminalId: monitor.terminalId,
        phase: 'busy',
        updatedAt: this.now(),
      })
      return
    }

    this.observe(monitor, {
      kind: 'sse',
      cycleId,
      streamId,
      sessionId: observedSessionId,
      status: observedStatus,
      at: this.now(),
    })
  }

  private async resolveRootForEvent(
    monitor: MonitorState,
    sessionId: string,
  ): Promise<string | undefined> {
    const knownRoot = this.resolveKnownRoot(monitor.terminalId, sessionId)
    if (knownRoot) return knownRoot

    try {
      const resolved = await this.resolveOpencodeSessionRoots([sessionId])
      for (const [resolvedSessionId, rootSessionId] of resolved.rootsBySessionId) {
        this.registerSessionRoot(monitor.terminalId, resolvedSessionId, rootSessionId)
      }
      return resolved.rootsBySessionId.get(sessionId)
    } catch (err) {
      this.log.warn({
        err,
        terminalId: monitor.terminalId,
        sessionId,
      }, 'Failed to resolve OpenCode root session for activity event')
      return undefined
    }
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
    // Gate the pending-permission clear on actual rejection: only clear if the
    // rejection matched the current ownership state (awaitingAssociation + matching sessionId).
    // Rust parity: rejectOpencodeAssociation only modifies state if matched; we only
    // clear pendingPermissions inside that matched arm to avoid stale-claim leaks.
    const preRejectOwnership = monitor.ownership
    const result = rejectOpencodeAssociation(monitor.ownership, { sessionId: input.sessionId })
    monitor.ownership = result.state
    // Clear pending permissions only if ownership actually changed (rejection matched)
    if (preRejectOwnership.kind === 'awaitingAssociation' && preRejectOwnership.sessionId === input.sessionId) {
      this.pendingPermissions.delete(input.terminalId)
    }
    this.applyActions(monitor.terminalId, result.actions)
  }

  private observe(monitor: MonitorState, observation: OpencodeObservation): void {
    const result = reduceOpencodeOwnership(monitor.ownership, observation)
    monitor.ownership = result.state
    this.applyActions(monitor.terminalId, result.actions)
  }

  private hasPendingPermissions(terminalId: string): boolean {
    return (this.pendingPermissions.get(terminalId)?.size ?? 0) > 0
  }

  // NOTE: applyActions runs AFTER the reducer transition, so the ownership it
  // reads is the POST-observation state -- that is what distinguishes a
  // knownBusy turn end (now quiet) from a candidate one (now awaitingAssociation).
  private applyActions(terminalId: string, actions: OpencodeOwnershipAction[]): void {
    const ownership = this.monitors.get(terminalId)?.ownership
    const pauseActive = this.hasPendingPermissions(terminalId)
    const idleEdge = actions.some((a) => a.kind === 'activityRemove')
    const completionEdge = actions.some((a) => a.kind === 'turnComplete')
    if (pauseActive && (idleEdge || completionEdge)) {
      // Mid-pause turn end: the pause is THE attention episode for this turn.
      // Never mint a second bell (codex PR #597 mid-pause silent-claim
      // hardening, mirrored). A completion WITHOUT an idle edge is the
      // DEFERRED completion minted at confirmOpencodeAssociation
      // (candidate-armed pauses, D3) -- swallowed the same way.
      const awaitingBind = ownership?.kind === 'awaitingAssociation'
      const aborted = awaitingBind && ownership.aborted === true
      if (awaitingBind && !aborted) {
        // Candidate turn end mid-pause: KEEP the pause claim alive so the
        // deferred completion minted at confirm is swallowed on its own pass
        // through this branch. The armed grace window stays live -- the pause
        // bell (rung or still in grace) is the episode's bell.
      } else {
        this.pendingPermissions.delete(terminalId)
      }
      if ((!completionEdge && !awaitingBind) || aborted) {
        // Abort mid-pause (knownBusy -> quiet, or aborted candidate ->
        // awaitingAssociation{aborted}): human at keyboard -- force-emit the
        // removal so the emitter cancels any still-armed grace window (the
        // record itself was already removed at pause entry).
        this.removeRecord(terminalId, { forceEmit: true })
      }
      for (const action of actions) {
        if (action.kind === 'turnComplete') continue // swallowed: no frame, no ledger entry
        if (action.kind === 'activityRemove') continue // handled above / already removed
        this.applyAction(terminalId, action)
      }
      return
    }
    if (pauseActive && actions.some((a) => a.kind === 'activityUpsert')) {
      this.pendingPermissions.delete(terminalId) // busy resumed out-of-band: pause over
    }
    for (const action of actions) this.applyAction(terminalId, action)
  }

  private applyAction(terminalId: string, action: OpencodeOwnershipAction): void {
    if (action.kind === 'activityUpsert') {
      this.upsertRecord({
        terminalId,
        ...(action.sessionId ? { sessionId: action.sessionId } : {}),
        phase: 'busy',
        updatedAt: action.at,
      })
      return
    }
    if (action.kind === 'activityRemove') {
      this.removeRecord(terminalId)
      return
    }
    if (action.kind === 'requestAssociation') {
      this.emit('association.requested', {
        terminalId,
        sessionId: action.sessionId,
      } satisfies OpencodeAssociationRequestedEvent)
      return
    }
    if (action.kind === 'turnComplete') {
      this.emit('turn.complete', this.completionLedger.recordTurnCompletion({
        terminalId,
        sessionId: action.sessionId,
        at: action.at,
      }))
      return
    }
    if (action.kind === 'warnAmbiguous') {
      this.log.warn({
        terminalId,
        sessionIds: action.sessionIds,
      }, 'OpenCode endpoint reported ambiguous session ownership; suppressing durable adoption.')
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

  private upsertRecord(record: Omit<OpencodeActivityRecord, 'lastObservedAt'> & { lastObservedAt?: number }): void {
    const nextRecord: OpencodeActivityRecord = {
      ...record,
      lastObservedAt: record.lastObservedAt ?? record.updatedAt,
    }
    const previous = this.records.get(nextRecord.terminalId)
    if (
      previous
      && previous.sessionId === nextRecord.sessionId
      && previous.phase === nextRecord.phase
      && previous.updatedAt === nextRecord.updatedAt
      && previous.lastObservedAt === nextRecord.lastObservedAt
    ) {
      return
    }
    this.records.set(nextRecord.terminalId, nextRecord)
    this.emit('changed', {
      upsert: [nextRecord],
      remove: [],
    } satisfies OpencodeActivityChange)
  }

  // forceEmit re-broadcasts the removal even when the record is already gone
  // (mid-pause abort: the emitter must see a fresh not-busy edge to cancel a
  // still-armed grace window).
  private removeRecord(terminalId: string, opts?: { forceEmit?: boolean }): void {
    const existed = this.records.delete(terminalId)
    if (!existed && !opts?.forceEmit) return
    this.emit('changed', {
      upsert: [],
      remove: [terminalId],
    } satisfies OpencodeActivityChange)
  }

  private registerChildSession(terminalId: string, sessionId: string, parentId: string): void {
    let children = this.childSessionIds.get(terminalId)
    if (!children) {
      children = new Set()
      this.childSessionIds.set(terminalId, children)
    }
    children.add(sessionId)
    const rootSessionId = this.resolveKnownRoot(terminalId, parentId) ?? parentId
    this.registerSessionRoot(terminalId, parentId, rootSessionId)
    this.registerSessionRoot(terminalId, sessionId, rootSessionId)
  }

  private registerSessionRoot(terminalId: string, sessionId: string, rootSessionId: string): void {
    let roots = this.sessionRootsByTerminal.get(terminalId)
    if (!roots) {
      roots = new Map()
      this.sessionRootsByTerminal.set(terminalId, roots)
    }
    roots.set(sessionId, rootSessionId)
    roots.set(rootSessionId, rootSessionId)
  }

  private resolveKnownRoot(terminalId: string, sessionId: string): string | undefined {
    const roots = this.sessionRootsByTerminal.get(terminalId)
    if (!roots) return undefined
    let current = sessionId
    const seen = new Set<string>()
    while (true) {
      if (seen.has(current)) return undefined
      seen.add(current)
      const next = roots.get(current)
      if (!next) return current === sessionId ? undefined : current
      if (next === current) return current
      current = next
    }
  }

  private warnIfMultipleActiveRoots(
    terminalId: string,
    statuses: Record<string, z.infer<typeof SessionStatusSchema>>,
    unresolvedSessionIds: Set<string>,
  ): void {
    const activeSessionIds = Object.entries(statuses)
      .filter(([, status]) => status.type !== 'idle')
      .map(([sessionId]) => sessionId)
      .sort()
    const rootSessionIds = activeSessionIds.filter((sessionId) => !unresolvedSessionIds.has(sessionId))
    const unresolvedActiveSessionIds = activeSessionIds.filter((sessionId) => unresolvedSessionIds.has(sessionId))
    if (rootSessionIds.length + unresolvedActiveSessionIds.length <= 1) return

    this.log.warn({
      terminalId,
      rootSessionIds,
      unresolvedSessionIds: unresolvedActiveSessionIds,
    }, 'OpenCode reported multiple active root sessions; leaving terminal activity unbound.')
  }

  private async classifySnapshotStatuses(
    monitor: MonitorState,
    statuses: Record<string, z.infer<typeof SessionStatusSchema>>,
  ): Promise<{
      statuses: Record<string, z.infer<typeof SessionStatusSchema>>
      unresolvedSessionIds: Set<string>
    }> {
    const activeSessionIds = Object.entries(statuses)
      .filter(([, status]) => status.type !== 'idle')
      .map(([sessionId]) => sessionId)
    const unresolvedCandidates = activeSessionIds.filter(
      (sessionId) => !this.resolveKnownRoot(monitor.terminalId, sessionId),
    )

    let unresolvedSessionIds = new Set<string>()
    if (unresolvedCandidates.length > 0) {
      try {
        const resolution = await this.resolveOpencodeSessionRoots(unresolvedCandidates)
        for (const [sessionId, rootSessionId] of resolution.rootsBySessionId) {
          this.registerSessionRoot(monitor.terminalId, sessionId, rootSessionId)
        }
        unresolvedSessionIds = resolution.unresolvedSessionIds
      } catch (err) {
        this.log.warn({
          err,
          terminalId: monitor.terminalId,
          sessionIds: unresolvedCandidates,
        }, 'Failed to resolve OpenCode root sessions before activity classification')
        unresolvedSessionIds = new Set(unresolvedCandidates)
      }
    }

    return {
      statuses: this.classifyKnownSnapshotStatuses(monitor.terminalId, statuses),
      unresolvedSessionIds,
    }
  }

  private classifyKnownSnapshotStatuses(
    terminalId: string,
    statuses: Record<string, z.infer<typeof SessionStatusSchema>>,
  ): Record<string, z.infer<typeof SessionStatusSchema>> {
    const classified: Record<string, z.infer<typeof SessionStatusSchema>> = {}
    for (const [sessionId, status] of Object.entries(statuses)) {
      const rootSessionId = this.resolveKnownRoot(terminalId, sessionId) ?? sessionId
      const existing = classified[rootSessionId]
      if (!existing || existing.type === 'idle' || status.type !== 'idle') {
        classified[rootSessionId] = status
      }
    }
    return classified
  }
}
