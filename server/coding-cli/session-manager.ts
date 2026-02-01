import { spawn as nodeSpawn, ChildProcess, SpawnOptionsWithoutStdio } from 'child_process'
import { EventEmitter } from 'events'
import { nanoid as defaultNanoid } from 'nanoid'
import { logger } from '../logger.js'
import type { CodingCliProvider } from './provider.js'
import type { CodingCliProviderName, CodingCliSessionInfo, NormalizedEvent } from './types.js'

export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcess

export interface CodingCliSessionOptions {
  provider: CodingCliProvider
  prompt: string
  cwd?: string
  resumeSessionId?: string
  model?: string
  maxTurns?: number
  allowedTools?: string[]
  disallowedTools?: string[]
  permissionMode?: string
  sandbox?: string
  // Test injection points
  _spawn?: SpawnFn
  _nanoid?: () => string
}

export class CodingCliSession extends EventEmitter {
  readonly id: string
  readonly provider: CodingCliProvider
  private process: ChildProcess | null = null
  private buffer = ''
  private _status: 'running' | 'completed' | 'error' = 'running'
  private _providerSessionId?: string
  private _events: NormalizedEvent[] = []
  readonly createdAt = Date.now()
  readonly prompt: string
  readonly cwd?: string

  constructor(options: CodingCliSessionOptions) {
    super()
    const nanoid = options._nanoid || defaultNanoid
    this.id = nanoid()
    this.provider = options.provider
    this.prompt = options.prompt
    this.cwd = options.cwd
    this.spawn(options)
  }

  private spawn(options: CodingCliSessionOptions) {
    const spawnFn = options._spawn || nodeSpawn
    const cmd = this.provider.getCommand()
    const args = this.provider.getStreamArgs(options)

    logger.info({ id: this.id, provider: this.provider.name, cmd, args, cwd: options.cwd }, 'Spawning coding CLI session')

    this.process = spawnFn(cmd, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.process.stdout?.on('data', (data: Buffer) => {
      this.handleStdout(data.toString())
    })

    this.process.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      logger.warn({ id: this.id, provider: this.provider.name, stderr: text }, 'Coding CLI stderr')
      this.emit('stderr', text)
    })

    this.process.on('close', (code) => {
      this._status = code === 0 ? 'completed' : 'error'
      logger.info({ id: this.id, provider: this.provider.name, code }, 'Coding CLI session closed')
      if (!this._events.some((e) => e.type === 'session.end')) {
        const endEvent: NormalizedEvent = {
          type: 'session.end',
          timestamp: new Date().toISOString(),
          sessionId: this._providerSessionId || 'unknown',
          provider: this.provider.name,
          raw: { exitCode: code },
          error: code !== 0 ? { message: `Process exited with code ${code}`, recoverable: false } : undefined,
        }
        this._events.push(endEvent)
        this.emit('event', endEvent)
      }
      this.emit('exit', code)
    })

    this.process.on('error', (err) => {
      this._status = 'error'
      logger.error({ id: this.id, provider: this.provider.name, err }, 'Coding CLI session error')
      this.emit('error', err)
    })
  }

  private handleStdout(data: string) {
    this.buffer += data
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const events = this.provider.parseEvent(line)
        for (const event of events) {
          this._events.push(event)
          if (!this._providerSessionId && event.sessionId) {
            this._providerSessionId = event.sessionId
          }
          this.emit('event', event)
        }
      } catch (err) {
        logger.warn({ id: this.id, provider: this.provider.name, line, err }, 'Failed to parse coding CLI event')
      }
    }
  }

  get status() {
    return this._status
  }

  get providerSessionId() {
    return this._providerSessionId
  }

  get events() {
    return this._events
  }

  getInfo(): CodingCliSessionInfo {
    return {
      id: this.id,
      provider: this.provider.name,
      providerSessionId: this._providerSessionId,
      status: this._status,
      createdAt: this.createdAt,
      prompt: this.prompt,
      cwd: this.cwd,
      events: this._events,
    }
  }

  sendInput(data: string) {
    if (this.process?.stdin) {
      this.process.stdin.write(data)
    }
  }

  kill() {
    if (this.process) {
      this.process.kill()
      this._status = 'error'
    }
  }
}

export class CodingCliSessionManager {
  private sessions = new Map<string, CodingCliSession>()
  private providers = new Map<CodingCliProviderName, CodingCliProvider>()

  constructor(providers: CodingCliProvider[]) {
    for (const provider of providers) {
      this.providers.set(provider.name, provider)
    }
  }

  create(
    providerName: CodingCliProviderName,
    options: Omit<CodingCliSessionOptions, 'provider'>
  ): CodingCliSession {
    const provider = this.providers.get(providerName)
    if (!provider) {
      throw new Error(`Provider not registered: ${providerName}`)
    }

    // Validate that the provider supports JSON streaming for interactive sessions.
    // Providers like Codex that only support JSON in exec mode should not be used
    // via CodingCliSessionManager - use terminal.create with PTY mode instead.
    if (!provider.supportsLiveStreaming()) {
      throw new Error(
        `Provider '${providerName}' does not support interactive JSON streaming. ` +
        `Use terminal.create with mode='${providerName}' for interactive sessions.`
      )
    }

    if (options.resumeSessionId && !provider.supportsSessionResume()) {
      throw new Error(
        `Provider '${providerName}' does not support streaming resume. ` +
        `Use terminal.create with mode='${providerName}' to resume sessions.`
      )
    }

    const session = new CodingCliSession({ ...options, provider })
    this.sessions.set(session.id, session)

    session.on('exit', () => {
      // Keep session for history, don't auto-remove
    })

    return session
  }

  hasProvider(providerName: CodingCliProviderName): boolean {
    return this.providers.has(providerName)
  }

  get(id: string): CodingCliSession | undefined {
    return this.sessions.get(id)
  }

  list(): CodingCliSessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => s.getInfo())
  }

  remove(id: string): boolean {
    const session = this.sessions.get(id)
    if (session) {
      session.kill()
      this.sessions.delete(id)
      return true
    }
    return false
  }

  shutdown() {
    for (const session of this.sessions.values()) {
      session.kill()
    }
    this.sessions.clear()
  }
}
