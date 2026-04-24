import { spawn } from 'node:child_process'
import { allocateLocalhostPort, type LoopbackServerEndpoint } from '../../local-port.js'
import { CodexAppServerClient } from './client.js'
import type {
  CodexFsWatchResult,
  CodexThreadHandle,
  CodexThreadOperationResult,
  CodexThreadResumeParams,
  CodexThreadStartParams,
} from './protocol.js'

type RuntimeStatus = 'running' | 'stopped'

type ReadyState = {
  wsUrl: string
  processPid: number
  codexHome: string
}

type RuntimeOptions = {
  command?: string
  commandArgs?: string[]
  env?: NodeJS.ProcessEnv
  requestTimeoutMs?: number
  startupAttemptLimit?: number
  startupAttemptTimeoutMs?: number
  portAllocator?: () => Promise<LoopbackServerEndpoint>
}

const DEFAULT_STARTUP_ATTEMPT_LIMIT = 2
const DEFAULT_STARTUP_ATTEMPT_TIMEOUT_MS = 3_000
const STARTUP_POLL_MS = 50

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class CodexAppServerRuntime {
  private child: ReturnType<typeof spawn> | null = null
  private client: CodexAppServerClient | null = null
  private ready: ReadyState | null = null
  private ensureReadyPromise: Promise<ReadyState> | null = null
  private statusValue: RuntimeStatus = 'stopped'
  private readonly exitHandlers = new Set<(error?: Error) => void>()
  private readonly threadStartedHandlers = new Set<(thread: CodexThreadHandle) => void>()
  private readonly fsChangedHandlers = new Set<(event: { watchId: string; changedPaths: string[] }) => void>()

  private readonly command: string
  private readonly commandArgs: string[]
  private readonly env?: NodeJS.ProcessEnv
  private readonly requestTimeoutMs?: number
  private readonly startupAttemptLimit: number
  private readonly startupAttemptTimeoutMs: number
  private readonly portAllocator: () => Promise<LoopbackServerEndpoint>

  constructor(options: RuntimeOptions = {}) {
    this.command = options.command ?? (process.env.CODEX_CMD || 'codex')
    this.commandArgs = options.commandArgs ?? []
    this.env = options.env
    this.requestTimeoutMs = options.requestTimeoutMs
    this.startupAttemptLimit = options.startupAttemptLimit ?? DEFAULT_STARTUP_ATTEMPT_LIMIT
    this.startupAttemptTimeoutMs = options.startupAttemptTimeoutMs ?? DEFAULT_STARTUP_ATTEMPT_TIMEOUT_MS
    this.portAllocator = options.portAllocator ?? allocateLocalhostPort
  }

  status(): RuntimeStatus {
    return this.statusValue
  }

  onExit(handler: (error?: Error) => void): () => void {
    this.exitHandlers.add(handler)
    return () => {
      this.exitHandlers.delete(handler)
    }
  }

  onThreadStarted(handler: (thread: CodexThreadHandle) => void): () => void {
    this.threadStartedHandlers.add(handler)
    return () => {
      this.threadStartedHandlers.delete(handler)
    }
  }

  onFsChanged(handler: (event: { watchId: string; changedPaths: string[] }) => void): () => void {
    this.fsChangedHandlers.add(handler)
    return () => {
      this.fsChangedHandlers.delete(handler)
    }
  }

  async ensureReady(): Promise<ReadyState> {
    if (this.ready) return this.ready
    if (this.ensureReadyPromise) return this.ensureReadyPromise

    this.ensureReadyPromise = this.startRuntime().finally(() => {
      this.ensureReadyPromise = null
    })

    this.ready = await this.ensureReadyPromise
    this.statusValue = 'running'
    return this.ready
  }

  async startThread(
    params: Omit<CodexThreadStartParams, 'experimentalRawEvents' | 'persistExtendedHistory'>,
  ): Promise<CodexThreadOperationResult & { wsUrl: string }> {
    const ready = await this.ensureReady()
    return {
      ...(await this.client!.startThread(params)),
      wsUrl: ready.wsUrl,
    }
  }

  async resumeThread(
    params: Omit<CodexThreadResumeParams, 'persistExtendedHistory'>,
  ): Promise<CodexThreadOperationResult & { wsUrl: string }> {
    const ready = await this.ensureReady()
    return {
      ...(await this.client!.resumeThread(params)),
      wsUrl: ready.wsUrl,
    }
  }

  async watchPath(targetPath: string, watchId: string): Promise<CodexFsWatchResult> {
    await this.ensureReady()
    return this.client!.watchPath(targetPath, watchId)
  }

  async unwatchPath(watchId: string): Promise<void> {
    await this.ensureReady()
    await this.client!.unwatchPath(watchId)
  }

  async shutdown(): Promise<void> {
    this.ready = null
    this.ensureReadyPromise = null
    this.statusValue = 'stopped'

    const client = this.client
    this.client = null
    if (client) {
      await client.close().catch(() => undefined)
    }

    await this.stopActiveChild()
  }

  async simulateChildExitForTest(): Promise<void> {
    await this.stopActiveChild()
  }

  private async startRuntime(): Promise<ReadyState> {
    let lastError: Error | undefined

    for (let attempt = 1; attempt <= this.startupAttemptLimit; attempt += 1) {
      const endpoint = await this.portAllocator()
      const wsUrl = `ws://${endpoint.hostname}:${endpoint.port}`
      const child = spawn(this.command, [
        ...this.commandArgs,
        'app-server',
        '--listen',
        wsUrl,
      ], {
        env: {
          ...process.env,
          ...this.env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      // Drain child stdio continuously so verbose app-server or MCP startup logs
      // cannot fill the pipe buffer and stall JSON-RPC request handling.
      child.stdout?.resume()
      child.stderr?.resume()

      this.child = child
      this.attachChildExitHandler(child)

      const client = new CodexAppServerClient(
        { wsUrl },
        this.requestTimeoutMs ? { requestTimeoutMs: this.requestTimeoutMs } : {},
      )
      client.onThreadStarted((thread) => {
        for (const handler of this.threadStartedHandlers) {
          handler(thread)
        }
      })
      client.onFsChanged((event) => {
        for (const handler of this.fsChangedHandlers) {
          handler(event)
        }
      })
      this.client = client

      try {
        const initialized = await this.waitForInitialize(client, child)
        this.statusValue = 'running'
        return {
          wsUrl,
          processPid: child.pid ?? 0,
          codexHome: initialized.codexHome,
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        await client.close().catch(() => undefined)
        if (this.client === client) {
          this.client = null
        }
        await this.stopActiveChild()
      }
    }

    throw new Error(
      `Failed to start Codex app-server on a loopback endpoint after ${this.startupAttemptLimit} attempts: ${lastError?.message ?? 'unknown error'}`,
    )
  }

  private async waitForInitialize(
    client: CodexAppServerClient,
    child: ReturnType<typeof spawn>,
  ): Promise<{ codexHome: string }> {
    const deadline = Date.now() + this.startupAttemptTimeoutMs
    let lastError: Error | undefined

    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        break
      }

      try {
        const initialized = await client.initialize()
        return {
          codexHome: initialized.codexHome,
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        await sleep(STARTUP_POLL_MS)
      }
    }

    throw lastError ?? new Error('Codex app-server exited before it finished initializing.')
  }

  private attachChildExitHandler(child: ReturnType<typeof spawn>): void {
    child.once('exit', () => {
      if (this.child !== child) {
        return
      }

      this.child = null
      this.ready = null
      this.ensureReadyPromise = null
      this.statusValue = 'stopped'

      const client = this.client
      this.client = null
      void client?.close().catch(() => undefined)
      for (const handler of this.exitHandlers) {
        handler(new Error('Codex app-server runtime exited unexpectedly.'))
      }
    })
  }

  private async stopActiveChild(): Promise<void> {
    const child = this.child
    this.child = null
    this.ready = null
    this.statusValue = 'stopped'

    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return
    }

    child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL')
        }
        resolve()
      }, 1_000)
      child.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }
}
