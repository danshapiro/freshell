import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import type pino from 'pino'
import { allocateLocalhostPort, type LoopbackServerEndpoint } from '../../../local-port.js'
import { logger } from '../../../logger.js'
import { parseServeEvent, type ParsedServeEvent } from './serve-events.js'

type OpencodeServeLogger = Pick<pino.Logger, 'warn' | 'error'>

const OWNERSHIP_ENV = 'FRESHELL_OPENCODE_SIDECAR_ID'
const DEFAULT_IDLE_POLL_MS = 500
const REQUIRED_IDLE_STATUS_POLLS = 2
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export type OpencodeServeManagerOptions = {
  command?: string
  spawnFn?: typeof spawn
  fetchFn?: typeof fetch
  allocatePort?: () => Promise<LoopbackServerEndpoint>
  /** Override the SSE consumer for tests. Returns an unsubscribe fn. */
  connectEventStream?: (url: string, handlers: { onEvent: (e: ParsedServeEvent) => void; onError: (err: unknown) => void }) => () => void
  healthTimeoutMs?: number
  env?: NodeJS.ProcessEnv
  idleShutdownMs?: number
  idlePollMs?: number
  requestTimeoutMs?: number
}

export type OpencodeServeMessage = { info: Record<string, any>; parts: Array<Record<string, any>> }
export type OpencodeServeMessagePage = { messages: OpencodeServeMessage[]; nextCursor: string | null }

type HealthResponse = { healthy?: boolean }
type OpencodeStatusMap = Record<string, { type?: unknown }>

function isIdleStatusEvent(event: ParsedServeEvent): boolean {
  if (event.kind !== 'session.status') return false
  const status = event.properties.status
  if (!status || typeof status !== 'object' || Array.isArray(status)) return false
  return (status as Record<string, unknown>).type === 'idle'
}

function isRunningStatusType(type: unknown): boolean {
  return type === 'busy' || type === 'retry'
}

function isIdleStatusType(type: unknown): boolean {
  return type === 'idle'
}

function eventShowsRunningStatusActivity(event: ParsedServeEvent): boolean {
  if (event.kind !== 'session.status') return false
  const status = event.properties.status
  if (!status || typeof status !== 'object' || Array.isArray(status)) return false
  return isRunningStatusType((status as Record<string, unknown>).type)
}

function isHealthyResponse(body: unknown): body is HealthResponse {
  return typeof body === 'object' && body !== null && (body as HealthResponse).healthy !== false
}

type RunningServe = {
  baseUrl: string
  ownershipId: string
  child: ChildProcessWithoutNullStreams
  stopEventStream: () => void
  cwdKey: string
  cwd?: string
  idleTimer?: NodeJS.Timeout
  activeRequests: number
}

type ServeRoute = {
  cwd?: string
}

const DEFAULT_CWD_KEY = '<inherit-process-cwd>'

class OpencodeServeRequestTimeoutError extends Error {
  constructor(method: string, requestPath: string, timeoutMs: number) {
    super(`opencode serve ${method} ${requestPath} timed out after ${timeoutMs}ms`)
    this.name = 'OpencodeServeRequestTimeoutError'
  }
}

export class OpencodeServeManager {
  private readonly command: string
  private readonly spawnFn: typeof spawn
  private readonly fetchFn: typeof fetch
  private readonly allocatePort: () => Promise<LoopbackServerEndpoint>
  private readonly connectEventStream?: OpencodeServeManagerOptions['connectEventStream']
  private readonly healthTimeoutMs: number
  private readonly env: NodeJS.ProcessEnv
  private readonly idleShutdownMs: number
  private readonly idlePollMs: number
  private readonly requestTimeoutMs: number
  private readonly log: OpencodeServeLogger = logger.child({ component: 'opencode-serve-manager' })
  /** sessionId → emitter of ParsedServeEvent (and a synthetic 'idle' event). */
  private readonly sessionEmitters = new Map<string, EventEmitter>()
  private readonly runningByCwd = new Map<string, RunningServe>()
  private readonly startPromiseByCwd = new Map<string, Promise<RunningServe>>()
  private readonly startAbortByCwd = new Map<string, AbortController>()
  private readonly cwdByKey = new Map<string, string | undefined>()
  private readonly sessionCwdById = new Map<string, string>()
  private shutdownRequested = false

  constructor(options: OpencodeServeManagerOptions = {}) {
    this.command = options.command ?? 'opencode'
    this.spawnFn = options.spawnFn ?? spawn
    this.fetchFn = options.fetchFn ?? fetch
    this.allocatePort = options.allocatePort ?? allocateLocalhostPort
    this.connectEventStream = options.connectEventStream
    this.healthTimeoutMs = options.healthTimeoutMs ?? 20_000
    this.env = options.env ?? process.env
    this.idleShutdownMs = options.idleShutdownMs ?? 15 * 60_000
    this.idlePollMs = options.idlePollMs ?? DEFAULT_IDLE_POLL_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  private routeFromCwd(cwd?: string): { cwdKey: string; cwd?: string } {
    const trimmed = typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : undefined
    if (!trimmed) return { cwdKey: DEFAULT_CWD_KEY }
    const resolved = path.resolve(trimmed)
    return { cwdKey: resolved, cwd: resolved }
  }

  private routeForSession(sessionId: string, fallback?: ServeRoute): { cwdKey: string; cwd?: string } {
    const existingKey = this.sessionCwdById.get(sessionId)
    if (existingKey) {
      return { cwdKey: existingKey, ...(this.cwdByKey.get(existingKey) ? { cwd: this.cwdByKey.get(existingKey) } : {}) }
    }
    return this.routeFromCwd(fallback?.cwd)
  }

  rememberSessionCwd(sessionId: string, cwd?: string): void {
    if (!sessionId) return
    const route = this.routeFromCwd(cwd)
    this.cwdByKey.set(route.cwdKey, route.cwd)
    this.sessionCwdById.set(sessionId, route.cwdKey)
  }

  private forgetSessionsForCwd(cwdKey: string): void {
    for (const [sessionId, sessionCwdKey] of this.sessionCwdById.entries()) {
      if (sessionCwdKey !== cwdKey) continue
      this.sessionCwdById.delete(sessionId)
      this.sessionEmitters.delete(sessionId)
    }
    if (cwdKey === DEFAULT_CWD_KEY) {
      for (const sessionId of this.sessionEmitters.keys()) {
        if (!this.sessionCwdById.has(sessionId)) this.sessionEmitters.delete(sessionId)
      }
    }
  }

  private clearIdleTimer(running: RunningServe): void {
    if (!running.idleTimer) return
    clearTimeout(running.idleTimer)
    running.idleTimer = undefined
  }

  private scheduleIdleShutdown(running: RunningServe): void {
    this.clearIdleTimer(running)
    if (running.cwdKey === DEFAULT_CWD_KEY || this.idleShutdownMs <= 0 || running.activeRequests > 0) return
    running.idleTimer = setTimeout(() => {
      running.idleTimer = undefined
      if (running.activeRequests > 0) return
      if (this.runningByCwd.get(running.cwdKey) !== running) return
      this.runningByCwd.delete(running.cwdKey)
      this.startPromiseByCwd.delete(running.cwdKey)
      this.startAbortByCwd.delete(running.cwdKey)
      try { running.stopEventStream() } catch { /* ignore */ }
      void killOwnedProcesses(running.child, running.ownershipId, this.log)
    }, this.idleShutdownMs)
    running.idleTimer.unref?.()
  }

  private discardRunning(route: { cwdKey: string; cwd?: string }, reason: string): void {
    const running = this.runningByCwd.get(route.cwdKey)
    if (!running) return
    this.runningByCwd.delete(route.cwdKey)
    this.startPromiseByCwd.delete(route.cwdKey)
    this.startAbortByCwd.delete(route.cwdKey)
    this.forgetSessionsForCwd(route.cwdKey)
    this.clearIdleTimer(running)
    try { running.stopEventStream() } catch { /* ignore */ }
    this.log.warn({ reason, cwd: route.cwd }, 'discarding opencode serve sidecar')
    void killOwnedProcesses(running.child, running.ownershipId, this.log)
  }

  private async fetchWithRequestTimeout(
    url: string,
    requestPath: string,
    init: RequestInit | undefined,
  ): Promise<Response> {
    if (this.requestTimeoutMs <= 0) {
      return await this.fetchFn(url, init)
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
    }, this.requestTimeoutMs)
    timeout.unref?.()

    try {
      return await this.fetchFn(url, { ...init, signal: controller.signal })
    } catch (error) {
      if (timedOut) {
        throw new OpencodeServeRequestTimeoutError(init?.method ?? 'GET', requestPath, this.requestTimeoutMs)
      }
      throw error
    } finally {
      clearTimeout(timeout)
      upstreamSignal?.removeEventListener('abort', abortFromUpstream)
    }
  }

  private async withRunning<T>(
    route: { cwdKey: string; cwd?: string },
    fn: (baseUrl: string) => Promise<T>,
  ): Promise<T> {
    const { baseUrl } = await this.ensureStarted(route.cwd ? { cwd: route.cwd } : {})
    const running = this.runningByCwd.get(route.cwdKey)
    if (!running) return fn(baseUrl)
    this.clearIdleTimer(running)
    running.activeRequests += 1
    try {
      return await fn(baseUrl)
    } finally {
      running.activeRequests -= 1
      this.scheduleIdleShutdown(running)
    }
  }

  async ensureStarted(input: ServeRoute = {}): Promise<{ baseUrl: string }> {
    if (this.shutdownRequested) {
      throw new Error('opencode serve manager is shutting down')
    }
    const route = this.routeFromCwd(input.cwd)
    this.cwdByKey.set(route.cwdKey, route.cwd)
    const running = this.runningByCwd.get(route.cwdKey)
    if (running) return { baseUrl: running.baseUrl }
    if (!this.startPromiseByCwd.has(route.cwdKey)) {
      const promise = this.start(route).catch((err) => {
        this.startPromiseByCwd.delete(route.cwdKey)
        throw err
      })
      this.startPromiseByCwd.set(route.cwdKey, promise)
    }
    const next = await this.startPromiseByCwd.get(route.cwdKey)!
    this.startPromiseByCwd.delete(route.cwdKey)
    return { baseUrl: next.baseUrl }
  }

  private async start(route: { cwdKey: string; cwd?: string }): Promise<RunningServe> {
    const startAbort = new AbortController()
    this.startAbortByCwd.set(route.cwdKey, startAbort)
    const startSignal = startAbort.signal
    let child: ChildProcessWithoutNullStreams | undefined
    try {
      const endpoint = await this.allocatePort()
      const baseUrl = `http://${endpoint.hostname}:${endpoint.port}`
      const ownershipId = randomUUID()
      child = this.spawnFn(
        this.command,
        ['serve', '--hostname', endpoint.hostname, '--port', String(endpoint.port)],
        {
          ...(route.cwd ? { cwd: route.cwd } : {}),
          env: { ...this.env, [OWNERSHIP_ENV]: ownershipId },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ) as unknown as ChildProcessWithoutNullStreams
      // Drain stdout/stderr so the child's pipe buffers never back-pressure
      // and stall the serve process. Diagnostics are captured below before health.
      child.stdout?.on('data', () => {})
      child.stderr?.on('data', () => {})
      child.on('error', (err) => this.log.error({ err }, 'opencode serve process error'))
      child.on('close', (code) => {
        this.log.warn({ code }, 'opencode serve exited')
        const runningEntry = this.runningByCwd.get(route.cwdKey)
        if (runningEntry && runningEntry.child === child) {
          this.runningByCwd.delete(route.cwdKey)
          this.startPromiseByCwd.delete(route.cwdKey)
          this.startAbortByCwd.delete(route.cwdKey)
          this.clearIdleTimer(runningEntry)
          try { runningEntry.stopEventStream() } catch { /* ignore */ }
          void killOwnedProcesses(runningEntry.child, runningEntry.ownershipId, this.log)
          this.forgetSessionsForCwd(route.cwdKey)
        }
      })

      await this.waitForHealth(baseUrl, child, startSignal)

      if (this.shutdownRequested || startSignal.aborted) {
        this.stopChild(child)
        throw new Error('opencode serve startup was aborted')
      }

      const stopEventStream = this.connectEventStream
        ? this.connectEventStream(`${baseUrl}/event`, {
            onEvent: (e) => this.dispatchEvent(e),
            onError: (err) => this.log.warn({ err }, 'opencode serve event stream error'),
          })
        : this.startDefaultEventStream(baseUrl)

      const running: RunningServe = {
        baseUrl,
        ownershipId,
        child,
        stopEventStream,
        cwdKey: route.cwdKey,
        ...(route.cwd ? { cwd: route.cwd } : {}),
        activeRequests: 0,
      }
      this.runningByCwd.set(route.cwdKey, running)
      this.scheduleIdleShutdown(running)
      return running
    } catch (err) {
      if (child) this.stopChild(child)
      this.startPromiseByCwd.delete(route.cwdKey)
      throw err
    } finally {
      if (this.startAbortByCwd.get(route.cwdKey) === startAbort) this.startAbortByCwd.delete(route.cwdKey)
    }
  }

  private stopChild(child: ChildProcessWithoutNullStreams): void {
    if (!child.killed) {
      try { child.kill() } catch { /* already gone */ }
    }
  }

  private async waitForHealth(baseUrl: string, child: ChildProcessWithoutNullStreams, signal: AbortSignal): Promise<void> {
    const stopChild = () => { this.stopChild(child) }
    const deadline = Date.now() + this.healthTimeoutMs
    let stderr = ''
    const onStderr = (chunk: Buffer | string) => { stderr += String(chunk) }
    child.stderr?.on('data', onStderr)
    try {
      while (Date.now() < deadline) {
        if (signal.aborted) {
          stopChild()
          throw new Error('opencode serve startup was aborted')
        }
        if (/ServeError|Failed to start server|EADDRINUSE/i.test(stderr)) {
          stopChild()
          throw new Error(`opencode serve failed to start on ${baseUrl}: ${stderr.trim()}`)
        }
        try {
          const res = await this.fetchFn(`${baseUrl}/global/health`, { method: 'GET' })
          if (res.ok) {
            const body = await res.json().catch(() => ({}))
            if (isHealthyResponse(body)) return
          }
        } catch {
          // not up yet
        }
        await new Promise((r) => setTimeout(r, 150))
      }
      stopChild()
      throw new Error(`opencode serve did not become healthy within ${this.healthTimeoutMs}ms`)
    } finally {
      child.stderr?.off('data', onStderr)
    }
  }

  // ── HTTP client ────────────────────────────────────────────────────────
  private async json<T>(
    route: ServeRoute & { sessionId?: string },
    requestPath: string,
    init?: RequestInit & { notFoundValue?: T },
  ): Promise<T> {
    const resolved = route.sessionId
      ? this.routeForSession(route.sessionId, route)
      : this.routeFromCwd(route.cwd)
    try {
      return await this.withRunning(resolved, async (base) => {
        const res = await this.fetchWithRequestTimeout(`${base}${requestPath}`, requestPath, init)
        if (!res.ok && res.status !== 204) {
          if (res.status === 404 && init?.notFoundValue !== undefined) return init.notFoundValue
          const text = await res.text().catch(() => '')
          throw new Error(`opencode serve ${init?.method ?? 'GET'} ${requestPath} → ${res.status} ${text}`)
        }
        if (res.status === 204) return undefined as T
        return (await res.json()) as T
      })
    } catch (error) {
      if (error instanceof OpencodeServeRequestTimeoutError) {
        this.discardRunning(resolved, 'request_timeout')
      }
      throw error
    }
  }

  private async getSessionStatusMap(route: ServeRoute = {}, init?: RequestInit): Promise<OpencodeStatusMap> {
    return this.json<OpencodeStatusMap>(route, '/session/status', { method: 'GET', ...init })
  }

  async createSession(input: { title?: string; parentID?: string; directory?: string } = {}): Promise<{ id: string; directory?: string; title?: string }> {
    const body: { title?: string; parentID?: string; directory?: string } = {}
    if (input.title !== undefined) body.title = input.title
    if (input.parentID !== undefined) body.parentID = input.parentID
    if (input.directory !== undefined) body.directory = input.directory
    const session = await this.json<{ id: string; directory?: string; title?: string }>(
      input.directory ? { cwd: input.directory } : {},
      '/session',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
    if (typeof session.id === 'string') this.rememberSessionCwd(session.id, session.directory ?? input.directory)
    return session
  }

  async getSession(id: string, route: ServeRoute = {}): Promise<Record<string, any>> {
    const session = await this.json<Record<string, any>>(
      { ...route, sessionId: id },
      `/session/${encodeURIComponent(id)}`,
      { method: 'GET' },
    )
    if (typeof session?.directory === 'string' && session.directory.length > 0) {
      this.rememberSessionCwd(id, session.directory)
    }
    return session
  }

  async promptAsync(
    id: string,
    body: { parts: Array<Record<string, unknown>>; model?: { providerID: string; modelID: string }; variant?: string; agent?: string },
    route: ServeRoute = {},
  ): Promise<void> {
    await this.json({ ...route, sessionId: id }, `/session/${encodeURIComponent(id)}/prompt_async`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  async listMessages(id: string, query: { limit?: number; before?: string }, route: ServeRoute = {}): Promise<OpencodeServeMessagePage> {
    const resolved = this.routeForSession(id, route)
    return this.withRunning(resolved, async (base) => {
      const params = new URLSearchParams()
      if (typeof query.limit === 'number') params.set('limit', String(query.limit))
      if (query.before) params.set('before', query.before)
      const qs = params.toString()
      const url = `${base}/session/${encodeURIComponent(id)}/message${qs ? `?${qs}` : ''}`
      const res = await this.fetchFn(url, { method: 'GET' })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`opencode serve GET messages → ${res.status} ${text}`)
      }
      const messages = (await res.json()) as OpencodeServeMessage[]
      const nextCursor = res.headers.get('x-next-cursor') || null
      return { messages: Array.isArray(messages) ? messages : [], nextCursor }
    })
  }

  async getMessage(id: string, messageId: string, route: ServeRoute = {}): Promise<OpencodeServeMessage | null> {
    return this.json<OpencodeServeMessage | null>(
      { ...route, sessionId: id },
      `/session/${encodeURIComponent(id)}/message/${encodeURIComponent(messageId)}`,
      { method: 'GET', notFoundValue: null },
    )
  }

  async abort(id: string, route: ServeRoute = {}): Promise<void> {
    await this.json({ ...route, sessionId: id }, `/session/${encodeURIComponent(id)}/abort`, { method: 'POST' })
  }

  async compact(id: string, body?: { instructions?: string }, route: ServeRoute = {}): Promise<void> {
    await this.json({ ...route, sessionId: id }, `/session/${encodeURIComponent(id)}/summarize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
  }

  async fork(id: string, route: ServeRoute = {}): Promise<{ id: string; directory?: string }> {
    const child = await this.json<{ id: string; directory?: string }>(
      { ...route, sessionId: id },
      `/session/${encodeURIComponent(id)}/fork`,
      { method: 'POST' },
    )
    if (typeof child.id === 'string') {
      const returnedDirectory = typeof child.directory === 'string' && child.directory.trim().length > 0
        ? child.directory
        : undefined
      const fallbackDirectory = typeof route.cwd === 'string' && route.cwd.trim().length > 0
        ? route.cwd
        : undefined
      const childDirectory = returnedDirectory ?? fallbackDirectory
      if (childDirectory) this.rememberSessionCwd(child.id, childDirectory)
    }
    return child
  }

  // ── SSE fan-out (Task A3 adds subscribe/onceIdle) ──────────────────────
  private emitterFor(sessionId: string): EventEmitter {
    let emitter = this.sessionEmitters.get(sessionId)
    if (!emitter) {
      emitter = new EventEmitter()
      emitter.setMaxListeners(0)
      this.sessionEmitters.set(sessionId, emitter)
    }
    return emitter
  }

  private dispatchEvent(parsed: ParsedServeEvent): void {
    if (!parsed.sessionId) return
    this.emitterFor(parsed.sessionId).emit('event', parsed)
  }

  subscribe(sessionId: string, listener: (event: ParsedServeEvent) => void): () => void {
    const emitter = this.emitterFor(sessionId)
    emitter.on('event', listener)
    return () => emitter.off('event', listener)
  }

  onceIdle(sessionId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const emitter = this.emitterFor(sessionId)
      let settled = false
      let observedActivity = false
      let pollInFlight = false
      let idleStatusPolls = 0
      let warnedStatusFallbackFailure = false

      const cleanup = () => {
        clearTimeout(timer)
        clearInterval(pollTimer)
        emitter.off('event', handler)
      }
      const finish = () => {
        if (settled) return
        settled = true
        cleanup()
        resolve()
      }
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const markActivity = () => {
        observedActivity = true
        idleStatusPolls = 0
      }
      const checkStatusMap = async () => {
        if (settled || pollInFlight) return
        pollInFlight = true
        try {
          const statuses = await this.getSessionStatusMap(this.routeForSession(sessionId))
          const status = statuses[sessionId]
          if (status && isRunningStatusType(status.type)) {
            markActivity()
            return
          }
          if (observedActivity && (!status || isIdleStatusType(status.type))) {
            idleStatusPolls += 1
            if (idleStatusPolls >= REQUIRED_IDLE_STATUS_POLLS) finish()
            return
          }
          idleStatusPolls = 0
        } catch (err) {
          idleStatusPolls = 0
          if (!warnedStatusFallbackFailure) {
            warnedStatusFallbackFailure = true
            this.log.warn({ err, sessionId }, 'OpenCode idle status fallback failed')
          }
        } finally {
          pollInFlight = false
        }
      }

      const timer = setTimeout(() => {
        fail(new Error(`Timed out after ${timeoutMs}ms waiting for OpenCode session ${sessionId} to go idle.`))
      }, timeoutMs)
      timer.unref?.()

      const pollTimer = setInterval(() => { void checkStatusMap() }, this.idlePollMs)
      pollTimer.unref?.()

      const handler = (event: ParsedServeEvent) => {
        if (event.kind === 'session.idle' || isIdleStatusEvent(event)) {
          finish()
          return
        }
        if (eventShowsRunningStatusActivity(event)) {
          markActivity()
          void checkStatusMap()
        }
      }
      emitter.on('event', handler)
    })
  }

  private startDefaultEventStream(baseUrl: string): () => void {
    const controller = new AbortController()
    void this.consumeEvents(`${baseUrl}/event`, controller.signal)
    return () => controller.abort()
  }

  // Mirrors server/coding-cli/opencode-activity-tracker.ts block parsing.
  private async consumeEvents(url: string, signal: AbortSignal): Promise<void> {
    let backoff = 250
    while (!signal.aborted) {
      try {
        const res = await this.fetchFn(url, { method: 'GET', headers: { accept: 'text/event-stream' }, signal })
        if (!res.ok || !res.body) throw new Error(`event stream status ${res.status}`)
        backoff = 250
        const reader = (res.body as ReadableStream<Uint8Array>).getReader()
        const decoder = new TextDecoder()
        let buf = ''
        while (!signal.aborted) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          // Normalize CRLF so '\r\n\r\n' event boundaries are treated uniformly.
          buf = buf.replace(/\r\n/g, '\n')
          let idx: number
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            const dataLines: string[] = []
            for (const line of block.split('\n')) {
              const trimmed = line.replace(/\r$/, '')
              if (!trimmed || trimmed.startsWith(':')) continue
              if (!trimmed.startsWith('data:')) continue
              dataLines.push(trimmed.slice(5).trimStart())
            }
            if (dataLines.length === 0) continue
            const data = dataLines.join('\n')
            try {
              const parsed = parseServeEvent(JSON.parse(data))
              if (parsed) this.dispatchEvent(parsed)
            } catch { /* ignore malformed frame */ }
          }
        }
      } catch (err) {
        if (signal.aborted) return
        this.log.warn({ err }, 'opencode serve event stream dropped; reconnecting')
        await new Promise((r) => setTimeout(r, backoff))
        backoff = Math.min(5000, backoff * 2)
      }
    }
  }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true
    for (const controller of this.startAbortByCwd.values()) {
      controller.abort()
    }

    const starts = [...this.startPromiseByCwd.values()]
    if (starts.length > 0) {
      await Promise.all(starts.map(async (promise) => {
        try { await promise } catch { /* ignore startup errors */ }
      }))
      this.startPromiseByCwd.clear()
    }

    const running = [...this.runningByCwd.values()]
    this.runningByCwd.clear()
    this.startPromiseByCwd.clear()
    this.startAbortByCwd.clear()
    await Promise.all(running.map(async (entry) => {
      this.clearIdleTimer(entry)
      try { entry.stopEventStream() } catch { /* ignore */ }
      await killOwnedProcesses(entry.child, entry.ownershipId, this.log)
    }))
    this.sessionEmitters.clear()
    this.sessionCwdById.clear()
    this.cwdByKey.clear()
  }

  /** @internal test/inspection accessor */
  get baseUrlOrUndefined(): string | undefined {
    return [...this.runningByCwd.values()][0]?.baseUrl
  }
}

async function killOwnedProcesses(child: ChildProcessWithoutNullStreams, ownershipId: string, log: OpencodeServeLogger): Promise<void> {
  // Direct child first.
  if (!child.killed) {
    try { child.kill() } catch { /* already gone */ }
  }
  // opencode serve forks a detached listener; reap any process carrying our
  // ownership env tag (Linux /proc). Best-effort and platform-guarded.
  if (process.platform === 'linux') {
    try {
      const { readdir, readFile } = await import('node:fs/promises')
      const entries = await readdir('/proc').catch(() => [] as string[])
      for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue
        const pid = Number(entry)
        const environ = await readFile(`/proc/${pid}/environ`).catch(() => null)
        if (!environ) continue
        if (environ.toString('utf8').split('\0').includes(`${OWNERSHIP_ENV}=${ownershipId}`)) {
          try { process.kill(pid, 'SIGTERM') } catch { /* ignore */ }
        }
      }
    } catch (err) {
      log.warn({ err }, 'ownership-scoped serve cleanup failed')
    }
  }
}

export { OWNERSHIP_ENV as OPENCODE_SIDECAR_OWNERSHIP_ENV }
