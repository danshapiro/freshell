import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type pino from 'pino'
import { allocateLocalhostPort, type LoopbackServerEndpoint } from '../../../local-port.js'
import { logger } from '../../../logger.js'
import { parseServeEvent, type ParsedServeEvent } from './serve-events.js'

type OpencodeServeLogger = Pick<pino.Logger, 'warn' | 'error'>

const OWNERSHIP_ENV = 'FRESHELL_OPENCODE_SIDECAR_ID'

export type OpencodeServeManagerOptions = {
  command?: string
  spawnFn?: typeof spawn
  fetchFn?: typeof fetch
  allocatePort?: () => Promise<LoopbackServerEndpoint>
  /** Override the SSE consumer for tests. Returns an unsubscribe fn. */
  connectEventStream?: (url: string, handlers: { onEvent: (e: ParsedServeEvent) => void; onError: (err: unknown) => void }) => () => void
  healthTimeoutMs?: number
}

export type OpencodeServeMessage = { info: Record<string, any>; parts: Array<Record<string, any>> }
export type OpencodeServeMessagePage = { messages: OpencodeServeMessage[]; nextCursor: string | null }

type HealthResponse = { healthy?: boolean }

function isHealthyResponse(body: unknown): body is HealthResponse {
  return typeof body === 'object' && body !== null && (body as HealthResponse).healthy !== false
}

type RunningServe = {
  baseUrl: string
  ownershipId: string
  child: ChildProcessWithoutNullStreams
  stopEventStream: () => void
}

export class OpencodeServeManager {
  private readonly command: string
  private readonly spawnFn: typeof spawn
  private readonly fetchFn: typeof fetch
  private readonly allocatePort: () => Promise<LoopbackServerEndpoint>
  private readonly connectEventStream?: OpencodeServeManagerOptions['connectEventStream']
  private readonly healthTimeoutMs: number
  private readonly log: OpencodeServeLogger = logger.child({ component: 'opencode-serve-manager' })
  /** sessionId → emitter of ParsedServeEvent (and a synthetic 'idle' event). */
  private readonly sessionEmitters = new Map<string, EventEmitter>()
  private running: RunningServe | undefined
  private startPromise: Promise<RunningServe> | undefined

  constructor(options: OpencodeServeManagerOptions = {}) {
    this.command = options.command ?? 'opencode'
    this.spawnFn = options.spawnFn ?? spawn
    this.fetchFn = options.fetchFn ?? fetch
    this.allocatePort = options.allocatePort ?? allocateLocalhostPort
    this.connectEventStream = options.connectEventStream
    this.healthTimeoutMs = options.healthTimeoutMs ?? 20_000
  }

  async ensureStarted(): Promise<{ baseUrl: string }> {
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
    const endpoint = await this.allocatePort()
    const baseUrl = `http://${endpoint.hostname}:${endpoint.port}`
    const ownershipId = randomUUID()
    const child = this.spawnFn(
      this.command,
      ['serve', '--hostname', endpoint.hostname, '--port', String(endpoint.port)],
      { env: { ...process.env, [OWNERSHIP_ENV]: ownershipId } },
    ) as ChildProcessWithoutNullStreams
    child.on('error', (err) => this.log.error({ err }, 'opencode serve process error'))
    child.on('close', (code) => {
      this.log.warn({ code }, 'opencode serve exited')
      if (this.running?.child === child) {
        this.running = undefined
        this.startPromise = undefined
      }
    })

    await this.waitForHealth(baseUrl, child)

    const stopEventStream = this.connectEventStream
      ? this.connectEventStream(`${baseUrl}/event`, {
          onEvent: (e) => this.dispatchEvent(e),
          onError: (err) => this.log.warn({ err }, 'opencode serve event stream error'),
        })
      : this.startDefaultEventStream(baseUrl)

    const running: RunningServe = { baseUrl, ownershipId, child, stopEventStream }
    this.running = running
    return running
  }

  private async waitForHealth(baseUrl: string, child: ChildProcessWithoutNullStreams): Promise<void> {
    const stopChild = () => {
      if (!child.killed) {
        try { child.kill() } catch { /* already gone */ }
      }
    }
    const deadline = Date.now() + this.healthTimeoutMs
    let stderr = ''
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    while (Date.now() < deadline) {
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
  }

  // ── HTTP client ────────────────────────────────────────────────────────
  private async requireBase(): Promise<string> {
    const { baseUrl } = await this.ensureStarted()
    return baseUrl
  }

  private async json<T>(path: string, init?: RequestInit & { notFoundValue?: T }): Promise<T> {
    const base = await this.requireBase()
    const res = await this.fetchFn(`${base}${path}`, init)
    if (!res.ok && res.status !== 204) {
      if (res.status === 404 && init?.notFoundValue !== undefined) return init.notFoundValue
      const text = await res.text().catch(() => '')
      throw new Error(`opencode serve ${init?.method ?? 'GET'} ${path} → ${res.status} ${text}`)
    }
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  async createSession(input: { title?: string; parentID?: string } = {}): Promise<{ id: string; directory?: string; title?: string }> {
    return this.json('/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
  }

  async getSession(id: string): Promise<Record<string, any>> {
    return this.json(`/session/${encodeURIComponent(id)}`, { method: 'GET' })
  }

  async promptAsync(id: string, body: { parts: Array<Record<string, unknown>>; model?: { providerID: string; modelID: string }; variant?: string; agent?: string }): Promise<void> {
    await this.json(`/session/${encodeURIComponent(id)}/prompt_async`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  async listMessages(id: string, query: { limit?: number; before?: string }): Promise<OpencodeServeMessagePage> {
    const base = await this.requireBase()
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
  }

  async getMessage(id: string, messageId: string): Promise<OpencodeServeMessage | null> {
    return this.json<OpencodeServeMessage | null>(
      `/session/${encodeURIComponent(id)}/message/${encodeURIComponent(messageId)}`,
      { method: 'GET', notFoundValue: null },
    )
  }

  async abort(id: string): Promise<void> {
    await this.json(`/session/${encodeURIComponent(id)}/abort`, { method: 'POST' })
  }

  async compact(id: string): Promise<void> {
    await this.json(`/session/${encodeURIComponent(id)}/compact`, { method: 'POST' })
  }

  async fork(id: string): Promise<{ id: string }> {
    return this.json(`/session/${encodeURIComponent(id)}/fork`, { method: 'POST' })
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
      const timer = setTimeout(() => {
        emitter.off('event', handler)
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for OpenCode session ${sessionId} to go idle.`))
      }, timeoutMs)
      timer.unref?.()
      const handler = (event: ParsedServeEvent) => {
        if (event.kind === 'session.idle') {
          clearTimeout(timer)
          emitter.off('event', handler)
          resolve()
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
          let idx: number
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            for (const line of block.split('\n')) {
              const trimmed = line.replace(/\r$/, '')
              if (!trimmed.startsWith('data:')) continue
              const data = trimmed.slice(5).trim()
              if (!data) continue
              try {
                const parsed = parseServeEvent(JSON.parse(data))
                if (parsed) this.dispatchEvent(parsed)
              } catch { /* ignore malformed frame */ }
            }
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
    const running = this.running
    this.running = undefined
    this.startPromise = undefined
    if (!running) return
    try { running.stopEventStream() } catch { /* ignore */ }
    await killOwnedProcesses(running.child, running.ownershipId, this.log)
    this.sessionEmitters.clear()
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
