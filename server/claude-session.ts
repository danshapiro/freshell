import { spawn as nodeSpawn, ChildProcess, SpawnOptionsWithoutStdio } from 'child_process'
import { EventEmitter } from 'events'
import { nanoid as defaultNanoid } from 'nanoid'
import { ClaudeEvent, parseClaudeEvent } from './claude-stream-types'
import { logger } from './logger'

// Allow dependency injection for testing
export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcess

export interface ClaudeSessionOptions {
  prompt: string
  cwd?: string
  resumeSessionId?: string
  model?: string
  maxTurns?: number
  allowedTools?: string[]
  disallowedTools?: string[]
  permissionMode?: 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions'
  // Test injection points
  _spawn?: SpawnFn
  _nanoid?: () => string
}

export interface ClaudeSessionInfo {
  id: string
  claudeSessionId?: string
  status: 'running' | 'completed' | 'error'
  createdAt: number
  prompt: string
  cwd?: string
  events: ClaudeEvent[]
}

export class ClaudeSession extends EventEmitter {
  readonly id: string
  private process: ChildProcess | null = null
  private buffer = ''
  private _status: 'running' | 'completed' | 'error' = 'running'
  private _claudeSessionId?: string
  private _events: ClaudeEvent[] = []
  readonly createdAt = Date.now()
  readonly prompt: string
  readonly cwd?: string

  constructor(options: ClaudeSessionOptions) {
    super()
    const nanoid = options._nanoid || defaultNanoid
    this.id = nanoid()
    this.prompt = options.prompt
    this.cwd = options.cwd
    this.spawn(options)
  }

  private spawn(options: ClaudeSessionOptions) {
    const spawnFn = options._spawn || nodeSpawn
    const args = ['-p', options.prompt, '--output-format', 'stream-json']

    if (options.resumeSessionId) {
      args.push('--resume', options.resumeSessionId)
    }
    if (options.model) {
      args.push('--model', options.model)
    }
    if (options.maxTurns) {
      args.push('--max-turns', String(options.maxTurns))
    }
    if (options.permissionMode) {
      args.push('--permission-mode', options.permissionMode)
    }
    if (options.allowedTools?.length) {
      for (const tool of options.allowedTools) {
        args.push('--allowedTools', tool)
      }
    }
    if (options.disallowedTools?.length) {
      for (const tool of options.disallowedTools) {
        args.push('--disallowedTools', tool)
      }
    }

    const claudeCmd = process.env.CLAUDE_CMD || 'claude'
    logger.info({ id: this.id, cmd: claudeCmd, args, cwd: options.cwd }, 'Spawning Claude session')

    this.process = spawnFn(claudeCmd, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.process.stdout?.on('data', (data: Buffer) => {
      this.handleStdout(data.toString())
    })

    this.process.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      logger.warn({ id: this.id, stderr: text }, 'Claude stderr')
      this.emit('stderr', text)
    })

    this.process.on('close', (code) => {
      this._status = code === 0 ? 'completed' : 'error'
      logger.info({ id: this.id, code }, 'Claude session closed')
      this.emit('exit', code)
    })

    this.process.on('error', (err) => {
      this._status = 'error'
      logger.error({ id: this.id, err }, 'Claude session error')
      this.emit('error', err)
    })
  }

  private handleStdout(data: string) {
    this.buffer += data
    const lines = this.buffer.split('\n')

    // Keep incomplete last line in buffer
    this.buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const event = parseClaudeEvent(line)
        this._events.push(event)

        // Extract Claude's session ID from init event
        if (event.type === 'system' && 'subtype' in event && event.subtype === 'init') {
          this._claudeSessionId = event.session_id
        }

        this.emit('event', event)
      } catch (err) {
        logger.warn({ id: this.id, line, err }, 'Failed to parse Claude event')
      }
    }
  }

  get status() {
    return this._status
  }

  get claudeSessionId() {
    return this._claudeSessionId
  }

  get events() {
    return this._events
  }

  getInfo(): ClaudeSessionInfo {
    return {
      id: this.id,
      claudeSessionId: this._claudeSessionId,
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

export class ClaudeSessionManager {
  private sessions = new Map<string, ClaudeSession>()

  create(options: ClaudeSessionOptions): ClaudeSession {
    const session = new ClaudeSession(options)
    this.sessions.set(session.id, session)

    session.on('exit', () => {
      // Keep session for history, don't auto-remove
    })

    return session
  }

  get(id: string): ClaudeSession | undefined {
    return this.sessions.get(id)
  }

  list(): ClaudeSessionInfo[] {
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

export const claudeSessionManager = new ClaudeSessionManager()
