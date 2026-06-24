import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type pino from 'pino'
import { allocateLocalhostPort, type LoopbackServerEndpoint } from '../../../local-port.js'
import { logger } from '../../../logger.js'
import { parseServeEvent, type ParsedServeEvent } from './serve-events.js'

type OpencodeServeLogger = Pick<pino.Logger, 'warn' | 'error' | 'debug' | 'info'>

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
}

type ServeRoute = {
  cwd?: string
}

function withRoute(requestPath: string, route: ServeRoute = {}): string {
  const cwd = typeof route.cwd === 'string' && route.cwd.trim().length > 0 ? route.cwd : undefined
  if (!cwd) return requestPath
  const url = new URL(requestPath, 'http://freshell.local')
  url.searchParams.set('directory', cwd)
  return `${url.pathname}${url.search}`
}

class OpencodeServeRequestTimeoutError extends Error {
  constructor(method: string, requestPath: string, timeoutMs: number) {
    super(`opencode serve ${method} ${requestPath} timed out after ${timeoutMs}ms`)
    this.name = 'OpencodeServeRequestTimeoutError'
  }
}

export class OpencodeServeLostError extends Error {
  readonly sessionId: string
  constructor(sessionId: string) {
    super(`opencode serve sidecar was lost while waiting for session ${sessionId} to go idle.`)
    this.name = 'OpencodeServeLostError'
    this.sessionId = sessionId
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
  private readonly idlePollMs: number
  private readonly requestTimeoutMs: number
  private readonly log: OpencodeServeLogger = logger.child({ component: 'opencode-serve-manager' })
  /** sessionId → emitter of ParsedServeEvent (and a synthetic 'idle' event). */
  private readonly sessionEmitters = new Map<string, EventEmitter>()
  private running: RunningServe | undefined
  private startPromise: Promise<RunningServe> | undefined
  private startAbort: AbortController | undefined
  private shutdownRequested = false

  constructor(options: OpencodeServeManagerOptions = {}) {
    this.env = options.env ?? process.env
    this.command = options.command ?? (this.env.OPENCODE_CMD || 'opencode')
    this.spawnFn = options.spawnFn ?? spawn
    this.fetchFn = options.fetchFn ?? fetch
    this.allocatePort = options.allocatePort ?? allocateLocalhostPort
    this.connectEventStream = options.connectEventStream
    this.healthTimeoutMs = options.healthTimeoutMs ?? 20_000
    this.idlePollMs = options.idlePollMs ?? DEFAULT_IDLE_POLL_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  private emitLostForAllSessions(): void {
    const emitters = Array.from(this.sessionEmitters.entries())
    this.sessionEmitters.clear()
    for (const [sessionId, emitter] of emitters) {
      emitter.emit('lost', new OpencodeServeLostError(sessionId))
    }
  }

  private discardRunning(reason: string): void {
    const running = this.running
    if (!running) return
    this.running = undefined
    this.startPromise = undefined
    try { running.stopEventStream() } catch { /* ignore */ }
    this.emitLostForAllSessions()
    this.log.warn({ reason }, 'discarding opencode serve sidecar')
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

  async ensureStarted(): Promise<{ baseUrl: string }> {
    if (this.shutdownRequested) {
      throw new Error('opencode serve manager is shutting down')
    }
    if (this.running) return { baseUrl: this.running.baseUrl }
    if (!this.startPromise) {
      this.startPromise = this.start().catch((err) => {
        this.startPromise = undefined
        throw err
      })
    }
    const running = await this.startPromise
    return { baseUrl: running.baseUrl }
  }

  private async start(): Promise<RunningServe> {
    const startAbort = new AbortController()
    this.startAbort = startAbort
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
          env: { ...this.env, [OWNERSHIP_ENV]: ownershipId },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ) as unknown as ChildProcessWithoutNullStreams
      // Drain stdout/stderr so the child's pipe buffers never back-pressure
      // and stall the serve process. Diagnostics are captured below before health.
      child.stdout?.on('data', () => {})
      child.stderr?.on('data', (chunk) => {
        this.log.debug({ chunk: chunk.toString().trim() }, 'opencode serve stderr')
      })
      child.on('error', (err) => this.log.error({ err }, 'opencode serve process error'))
      child.on('close', (code, signal) => {
        this.log.warn({ code, signal }, 'opencode serve exited')
        if (this.running && this.running.child === child) {
          const running = this.running
          this.running = undefined
          this.startPromise = undefined
          try { running.stopEventStream() } catch { /* ignore */ }
          void killOwnedProcesses(running.child, running.ownershipId, this.log)
          this.emitLostForAllSessions()
        }
      })

      await this.waitForHealth(baseUrl, child, startSignal)

      if (this.shutdownRequested || startSignal.aborted) {
        this.stopChild(child)
        throw new Error('opencode serve startup was aborted')
      }

      const stopEventStream = this.connectEventStream
        ? this.connectEventStream(`${baseUrl}/global/event`, {
            onEvent: (e) => this.dispatchEvent(e),
            onError: (err) => this.log.warn({ err }, 'opencode serve event stream error'),
          })
        : this.startDefaultEventStream(baseUrl)

      const running: RunningServe = {
        baseUrl,
        ownershipId,
        child,
        stopEventStream,
      }
      this.running = running
      return running
    } catch (err) {
      if (child) this.stopChild(child)
      this.startPromise = undefined
      throw err
    } finally {
      if (this.startAbort === startAbort) this.startAbort = undefined
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
  private async requireBase(): Promise<string> {
    const { baseUrl } = await this.ensureStarted()
    return baseUrl
  }

  private async json<T>(requestPath: string, init?: RequestInit & { notFoundValue?: T }): Promise<T> {
    const base = await this.requireBase()
    try {
      const res = await this.fetchWithRequestTimeout(`${base}${requestPath}`, requestPath, init)
      if (!res.ok && res.status !== 204) {
        if (res.status === 404 && init?.notFoundValue !== undefined) return init.notFoundValue
        const text = await res.text().catch(() => '')
        throw new Error(`opencode serve ${init?.method ?? 'GET'} ${requestPath} → ${res.status} ${text}`)
      }
      if (res.status === 204) return undefined as T
      return (await res.json()) as T
    } catch (error) {
      if (error instanceof OpencodeServeRequestTimeoutError) {
        this.discardRunning('request_timeout')
      }
      throw error
    }
  }

  private async getSessionStatusMap(route: ServeRoute = {}, init?: RequestInit): Promise<OpencodeStatusMap> {
    return this.json<OpencodeStatusMap>(withRoute('/session/status', route), { method: 'GET', ...init })
  }

  async getSessionStatus(sessionId: string, route: ServeRoute = {}): Promise<{ type?: unknown } | undefined> {
    const statuses = await this.getSessionStatusMap(route)
    return statuses[sessionId]
  }

  async createSession(input: { title?: string; parentID?: string; directory?: string } = {}): Promise<{ id: string; directory?: string; title?: string }> {
    const body: { title?: string; parentID?: string } = {}
    if (input.title !== undefined) body.title = input.title
    if (input.parentID !== undefined) body.parentID = input.parentID
    return this.json(withRoute('/session', { cwd: input.directory }), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  async getSession(id: string, route: ServeRoute = {}): Promise<Record<string, any>> {
    return this.json<Record<string, any>>(
      withRoute(`/session/${encodeURIComponent(id)}`, route),
      { method: 'GET' },
    )
  }

  async promptAsync(
    id: string,
    body: { parts: Array<Record<string, unknown>>; model?: { providerID: string; modelID: string }; variant?: string; agent?: string },
    route: ServeRoute = {},
  ): Promise<void> {
    await this.json(withRoute(`/session/${encodeURIComponent(id)}/prompt_async`, route), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  async listMessages(id: string, query: { limit?: number; before?: string }, route: ServeRoute = {}): Promise<OpencodeServeMessagePage> {
    const base = await this.requireBase()
    const params = new URLSearchParams()
    if (typeof query.limit === 'number') params.set('limit', String(query.limit))
    if (query.before) params.set('before', query.before)
    const qs = params.toString()
    const requestPath = withRoute(`/session/${encodeURIComponent(id)}/message${qs ? `?${qs}` : ''}`, route)
    let res: Response
    try {
      res = await this.fetchWithRequestTimeout(`${base}${requestPath}`, `/session/${encodeURIComponent(id)}/message`, { method: 'GET' })
    } catch (error) {
      if (error instanceof OpencodeServeRequestTimeoutError) {
        this.discardRunning('request_timeout')
      }
      throw error
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`opencode serve GET messages → ${res.status} ${text}`)
    }
    const messages = (await res.json()) as OpencodeServeMessage[]
    const nextCursor = res.headers.get('x-next-cursor') || null
    return { messages: Array.isArray(messages) ? messages : [], nextCursor }
  }

  async getMessage(id: string, messageId: string, route: ServeRoute = {}): Promise<OpencodeServeMessage | null> {
    return this.json<OpencodeServeMessage | null>(
      withRoute(`/session/${encodeURIComponent(id)}/message/${encodeURIComponent(messageId)}`, route),
      { method: 'GET', notFoundValue: null },
    )
  }

  async abort(id: string, route: ServeRoute = {}): Promise<void> {
    await this.json(withRoute(`/session/${encodeURIComponent(id)}/abort`, route), { method: 'POST' })
  }

  async compact(id: string, body?: { instructions?: string }, route: ServeRoute = {}): Promise<void> {
    await this.json(withRoute(`/session/${encodeURIComponent(id)}/summarize`, route), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
  }

  async fork(id: string, route: ServeRoute = {}): Promise<{ id: string; directory?: string }> {
    return this.json<{ id: string; directory?: string }>(
      withRoute(`/session/${encodeURIComponent(id)}/fork`, route),
      { method: 'POST' },
    )
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

  onceIdle(sessionId: string, timeoutMs: number, route: ServeRoute = {}): Promise<void> {
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
        emitter.off('lost', onLost)
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
          const statuses = await this.getSessionStatusMap(route)
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
      const onLost = (err: OpencodeServeLostError) => fail(err)
      emitter.on('event', handler)
      emitter.on('lost', onLost)
    })
  }

  private startDefaultEventStream(baseUrl: string): () => void {
    const controller = new AbortController()
    void this.consumeEvents(`${baseUrl}/global/event`, controller.signal)
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
    this.startAbort?.abort()

    // Reap any in-flight start() so it terminates its child and any start
    // promise settles before we touch the running sidecar.
    if (this.startPromise) {
      try { await this.startPromise } catch { /* ignore startup errors */ }
      this.startPromise = undefined
    }

    const running = this.running
    this.running = undefined
    this.startPromise = undefined
    if (!running) return
    try { running.stopEventStream() } catch { /* ignore */ }
    this.emitLostForAllSessions()
    await killOwnedProcesses(running.child, running.ownershipId, this.log)
  }

  /** @internal test/inspection accessor */
  get baseUrlOrUndefined(): string | undefined {
    return this.running?.baseUrl
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
