import { spawn } from 'node:child_process'
import { allocateLocalhostPort, type LoopbackServerEndpoint } from '../../local-port.js'
import { convertWindowsPathToWslPath, isWslEnvironment, sanitizeUserPathInput } from '../../path-utils.js'
import { CodexAppServerClient, type CodexAppServerDisconnectEvent, type CodexThreadLifecycleEvent } from './client.js'
import type {
  CodexFsWatchResult,
  CodexThreadHandle,
  CodexThreadOperationResult,
  CodexThreadResumeParams,
  CodexThreadStartParams,
} from './protocol.js'

type RuntimeStatus = 'running' | 'stopped'
export type CodexAppServerRuntimeFailureSource =
  | 'app_server_exit'
  | 'app_server_client_disconnect'

type ReadyState = {
  wsUrl: string
  processPid: number
  codexHome: string
}

type RuntimeOptions = {
  command?: string
  commandArgs?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  requestTimeoutMs?: number
  startupAttemptLimit?: number
  startupAttemptTimeoutMs?: number
  portAllocator?: () => Promise<LoopbackServerEndpoint>
}

const DEFAULT_STARTUP_ATTEMPT_LIMIT = 2
const DEFAULT_STARTUP_ATTEMPT_TIMEOUT_MS = 3_000
const STARTUP_POLL_MS = 50
const OUTPUT_TAIL_MAX_CHARS = 4 * 1024
const OUTPUT_TAIL_MAX_LINES = 40

class BoundedOutputTail {
  private value = ''

  push(chunk: Buffer | string): void {
    this.value += chunk.toString()
    const lines = this.value.split(/\r?\n/)
    if (lines.length > OUTPUT_TAIL_MAX_LINES) {
      this.value = lines.slice(-OUTPUT_TAIL_MAX_LINES).join('\n')
    }
    if (this.value.length > OUTPUT_TAIL_MAX_CHARS) {
      this.value = this.value.slice(-OUTPUT_TAIL_MAX_CHARS)
    }
  }

  snapshot(): string {
    return this.value
  }
}

type RuntimeChildDiagnostics = {
  wsUrl: string
  wsPort: number
  startedAt: number
  stdoutTail: BoundedOutputTail
  stderrTail: BoundedOutputTail
  processError?: Error
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function resolveAppServerCwd(cwd: string | undefined): string | undefined {
  if (typeof cwd !== 'string') return undefined
  const candidate = sanitizeUserPathInput(cwd)
  if (!candidate) return undefined
  if (isWslEnvironment()) {
    return convertWindowsPathToWslPath(candidate) ?? candidate
  }
  return candidate
}

export class CodexAppServerRuntime {
  private child: ReturnType<typeof spawn> | null = null
  private childDiagnostics: RuntimeChildDiagnostics | null = null
  private client: CodexAppServerClient | null = null
  private ready: ReadyState | null = null
  private ensureReadyPromise: Promise<ReadyState> | null = null
  private statusValue: RuntimeStatus = 'stopped'
  private readonly exitHandlers = new Set<(error?: Error, source?: CodexAppServerRuntimeFailureSource) => void>()
  private readonly threadStartedHandlers = new Set<(thread: CodexThreadHandle) => void>()
  private readonly threadLifecycleHandlers = new Set<(event: CodexThreadLifecycleEvent) => void>()
  private readonly fsChangedHandlers = new Set<(event: { watchId: string; changedPaths: string[] }) => void>()

  private readonly command: string
  private readonly commandArgs: string[]
  private readonly cwd?: string
  private readonly env?: NodeJS.ProcessEnv
  private readonly requestTimeoutMs?: number
  private readonly startupAttemptLimit: number
  private readonly startupAttemptTimeoutMs: number
  private readonly portAllocator: () => Promise<LoopbackServerEndpoint>

  constructor(options: RuntimeOptions = {}) {
    this.command = options.command ?? (process.env.CODEX_CMD || 'codex')
    this.commandArgs = options.commandArgs ?? []
    this.cwd = resolveAppServerCwd(options.cwd)
    this.env = options.env
    this.requestTimeoutMs = options.requestTimeoutMs
    this.startupAttemptLimit = options.startupAttemptLimit ?? DEFAULT_STARTUP_ATTEMPT_LIMIT
    this.startupAttemptTimeoutMs = options.startupAttemptTimeoutMs ?? DEFAULT_STARTUP_ATTEMPT_TIMEOUT_MS
    this.portAllocator = options.portAllocator ?? allocateLocalhostPort
  }

  status(): RuntimeStatus {
    return this.statusValue
  }

  onExit(handler: (error?: Error, source?: CodexAppServerRuntimeFailureSource) => void): () => void {
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

  onThreadLifecycle(handler: (event: CodexThreadLifecycleEvent) => void): () => void {
    this.threadLifecycleHandlers.add(handler)
    return () => {
      this.threadLifecycleHandlers.delete(handler)
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

    return this.publishReady(await this.ensureReadyPromise)
  }

  private publishReady(ready: ReadyState): ReadyState {
    this.ready = ready
    this.statusValue = 'running'
    return ready
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
        ...(this.cwd ? { cwd: this.cwd } : {}),
        env: {
          ...process.env,
          ...this.env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const childDiagnostics: RuntimeChildDiagnostics = {
        wsUrl,
        wsPort: endpoint.port,
        startedAt: Date.now(),
        stdoutTail: new BoundedOutputTail(),
        stderrTail: new BoundedOutputTail(),
      }

      // Drain child stdio continuously while retaining a bounded tail for
      // incident diagnostics.
      child.stdout?.on('data', (chunk) => childDiagnostics.stdoutTail.push(chunk))
      child.stderr?.on('data', (chunk) => childDiagnostics.stderrTail.push(chunk))

      this.child = child
      this.childDiagnostics = childDiagnostics
      this.attachChildErrorHandler(child, childDiagnostics)
      this.attachChildExitHandler(child, childDiagnostics)

      const client = new CodexAppServerClient(
        { wsUrl },
        this.requestTimeoutMs ? { requestTimeoutMs: this.requestTimeoutMs } : {},
      )
      client.onDisconnect((event) => {
        this.handleClientDisconnect(client, event)
      })
      client.onThreadLifecycle((event) => {
        for (const handler of this.threadLifecycleHandlers) {
          handler(event)
        }
      })
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
        const initialized = await this.waitForInitialize(client, child, childDiagnostics)
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
    diagnostics: RuntimeChildDiagnostics,
  ): Promise<{ codexHome: string }> {
    const deadline = Date.now() + this.startupAttemptTimeoutMs
    let lastError: Error | undefined

    while (Date.now() < deadline) {
      if (diagnostics.processError) {
        throw this.createUnexpectedExitError(
          child,
          diagnostics,
          child.exitCode,
          child.signalCode,
          `Codex app-server runtime failed to start: ${diagnostics.processError.message}`,
        )
      }
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

  private attachChildErrorHandler(child: ReturnType<typeof spawn>, diagnostics: RuntimeChildDiagnostics): void {
    child.once('error', (error) => {
      diagnostics.processError = error instanceof Error ? error : new Error(String(error))
      if (this.child !== child) {
        return
      }

      const wasReady = this.ready !== null
      this.child = null
      this.childDiagnostics = null
      this.ready = null
      this.statusValue = 'stopped'

      const client = this.client
      this.client = null
      void client?.close().catch(() => undefined)

      if (!wasReady) {
        return
      }

      const runtimeError = this.createUnexpectedExitError(
        child,
        diagnostics,
        child.exitCode,
        child.signalCode,
        `Codex app-server runtime errored unexpectedly: ${diagnostics.processError.message}`,
      )
      for (const handler of this.exitHandlers) {
        handler(runtimeError, 'app_server_exit')
      }
    })
  }

  private attachChildExitHandler(child: ReturnType<typeof spawn>, diagnostics: RuntimeChildDiagnostics): void {
    child.once('exit', (code, signal) => {
      if (this.child !== child) {
        return
      }

      const wasReady = this.ready !== null
      this.child = null
      this.childDiagnostics = null
      this.ready = null
      this.statusValue = 'stopped'

      const client = this.client
      this.client = null
      void client?.close().catch(() => undefined)
      if (!wasReady) {
        return
      }

      const error = this.createUnexpectedExitError(child, diagnostics, code, signal)
      for (const handler of this.exitHandlers) {
        handler(error, 'app_server_exit')
      }
    })
  }

  private handleClientDisconnect(client: CodexAppServerClient, event: CodexAppServerDisconnectEvent): void {
    if (this.client !== client) {
      return
    }

    const child = this.child
    const diagnostics = this.childDiagnostics
    const wasReady = this.ready !== null
    this.client = null
    this.ready = null
    this.statusValue = 'stopped'

    if (!wasReady) {
      void this.stopActiveChild().catch(() => undefined)
      return
    }

    const error = child && diagnostics
      ? this.createUnexpectedExitError(
        child,
        diagnostics,
        child.exitCode,
        child.signalCode,
        event.reason === 'error'
          ? `Codex app-server client socket errored: ${event.error?.message ?? 'unknown error'}`
          : 'Codex app-server client socket closed unexpectedly.',
      )
      : new Error(event.reason === 'error'
          ? `Codex app-server client socket errored: ${event.error?.message ?? 'unknown error'}`
          : 'Codex app-server client socket closed unexpectedly.')
    for (const handler of this.exitHandlers) {
      handler(error, 'app_server_client_disconnect')
    }
    void this.stopActiveChild().catch(() => undefined)
  }

  private createUnexpectedExitError(
    child: ReturnType<typeof spawn>,
    diagnostics: RuntimeChildDiagnostics,
    code: number | null,
    signal: NodeJS.Signals | null,
    prefix = 'Codex app-server runtime exited unexpectedly.',
  ): Error {
    const elapsedMs = Date.now() - diagnostics.startedAt
    const stdoutTail = diagnostics.stdoutTail.snapshot()
    const stderrTail = diagnostics.stderrTail.snapshot()
    return new Error([
      prefix,
      `pid ${child.pid ?? 'unknown'}`,
      `ws port ${diagnostics.wsPort}`,
      `ws url ${diagnostics.wsUrl}`,
      `exit code ${code ?? 'unknown'}`,
      `signal ${signal ?? 'none'}`,
      `elapsed ${elapsedMs}ms`,
      `stdout tail: ${stdoutTail || '(empty)'}`,
      `stderr tail: ${stderrTail || '(empty)'}`,
    ].join(' '))
  }

  private async stopActiveChild(): Promise<void> {
    const child = this.child
    this.child = null
    this.childDiagnostics = null
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
