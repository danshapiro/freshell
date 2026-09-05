import { spawn, type ChildProcess } from 'child_process'
import http from 'http'
import fs from 'fs'
import path from 'path'

/** Runtime files the Rust server and its sanctioned Node clients need. */
export interface ServerSpawnResources {
  serverBinary: string
  clientDir: string
  claudeNodeBinary: string
  claudeSidecarEntry: string
  mcpNodeBinary: string
  mcpEntry: string
  homeDir: string
  configDir: string
  logDir: string
}

export interface ServerSpawnerOptions {
  resources: ServerSpawnResources
  port: number
  /** The token used to authenticate the readiness server-info request. */
  authToken?: string
  healthCheckTimeoutMs?: number
}

export interface ServerStopOptions {
  /** Time to wait for the Rust process to exit after SIGTERM. */
  gracefulTimeoutMs?: number
  /** Time to wait for the Rust process to exit after SIGKILL. */
  forceTimeoutMs?: number
  /** Time to allow the final server log writes to finish after process exit. */
  logFlushTimeoutMs?: number
}

export interface ServerSpawner {
  /** Spawn the Rust server. Resolves after health and authenticated provenance checks. */
  start(options: ServerSpawnerOptions): Promise<void>

  /** Stop only the exact ChildProcess captured by start(), with bounded waits. */
  stop(options?: ServerStopOptions): Promise<void>

  /** Whether the captured server child is currently running. */
  isRunning(): boolean

  /** The captured server child PID, if it is still owned. */
  pid(): number | undefined
}

const DEFAULT_GRACEFUL_TIMEOUT_MS = 5_000
const DEFAULT_FORCE_TIMEOUT_MS = 5_000
const DEFAULT_LOG_FLUSH_TIMEOUT_MS = 2_000
const REQUEST_TIMEOUT_MS = 2_000

interface HttpResponseBody {
  statusCode?: number
  body: string
}

function readAuthToken(configDir: string): string | undefined {
  try {
    const content = fs.readFileSync(path.join(configDir, '.env'), 'utf8')
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('AUTH_TOKEN=')) continue
      const value = trimmed.slice('AUTH_TOKEN='.length).trim()
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1)
      }
      return value
    }
  } catch {
    // The Rust child will report the missing token. Keep this path quiet so a
    // token never reaches the log when the config directory is unavailable.
  }
  return undefined
}

function requestHttpBody(url: string, authToken?: string): Promise<HttpResponseBody> {
  return new Promise((resolve, reject) => {
    const onResponse = (response: http.IncomingMessage) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
      response.on('error', reject)
    }

    const request = authToken
      ? http.get(url, { headers: { 'x-auth-token': authToken } }, onResponse)
      : http.get(url, onResponse)
    request.on('error', reject)
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy()
      reject(new Error('Readiness request timed out'))
    })
  })
}

async function pollHealthCheck(port: number, timeoutMs: number, processExited: () => boolean): Promise<void> {
  const startedAt = Date.now()
  let delay = 100

  while (Date.now() - startedAt < timeoutMs) {
    if (processExited()) {
      throw new Error('Server process exited before health check succeeded')
    }

    try {
      const response = await requestHttpBody(`http://localhost:${port}/api/health`)
      if (response.statusCode === 200) return
      throw new Error(`Health check returned ${response.statusCode}`)
    } catch {
      await new Promise((resolve) => setTimeout(resolve, delay))
      delay = Math.min(delay * 2, 5_000)
    }
  }

  throw new Error(`Health check timed out after ${timeoutMs}ms`)
}

async function verifyRustServerInfo(
  port: number,
  authToken: string | undefined,
  processExited: () => boolean,
): Promise<void> {
  if (!authToken) {
    throw new Error('Cannot verify Rust server-info without an AUTH_TOKEN')
  }
  if (processExited()) {
    throw new Error('Server process exited before server-info verification succeeded')
  }

  const response = await requestHttpBody(`http://localhost:${port}/api/server-info`, authToken)
  if (response.statusCode !== 200) {
    throw new Error(`Authenticated server-info check returned ${response.statusCode}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(response.body)
  } catch {
    throw new Error('Authenticated server-info response was not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Authenticated server-info response was not an object')
  }
  const info = parsed as Record<string, unknown>
  if (info.runtime !== 'rust') {
    throw new Error(`Rust server-info runtime must be "rust", received ${JSON.stringify(info.runtime)}`)
  }
  if (typeof info.commit !== 'string' || info.commit.length === 0) {
    throw new Error('Rust server-info did not include build provenance (commit)')
  }
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode != null || child.signalCode != null
}

function logServerFailure(event: string, error: unknown, pid?: number): void {
  console.error(JSON.stringify({
    severity: 'error',
    component: 'electron-server-spawner',
    event,
    pid,
    error: error instanceof Error ? error.message : String(error),
  }))
}

function pipeServerLog(child: ChildProcess, logDir: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const logStream = fs.createWriteStream(path.join(logDir, 'server.log'), { flags: 'a' })
      logStream.once('finish', resolve)
      logStream.once('close', resolve)
      logStream.on('error', (error) => {
        // File-open and disk errors arrive asynchronously. Drain the child pipes
        // after a log failure so a full pipe cannot block the Rust server.
        child.stdout?.unpipe(logStream)
        child.stderr?.unpipe(logStream)
        child.stdout?.resume()
        child.stderr?.resume()
        logServerFailure('server_log_failed', error, child.pid)
        resolve()
      })
      child.stdout?.pipe(logStream, { end: false })
      child.stderr?.pipe(logStream, { end: false })
      // close runs after both stdio pipes have closed; either pipe ending first
      // must not close the shared destination while the other still has output.
      child.once('close', () => logStream.end())
    } catch (error) {
      child.stdout?.resume()
      child.stderr?.resume()
      logServerFailure('server_log_failed', error, child.pid)
      resolve()
    }
  })
}

export function createServerSpawner(): ServerSpawner {
  let childProcess: ChildProcess | null = null
  let running = false
  let processExited = false
  let logCompletion: Promise<void> | undefined

  async function flushServerLog(timeoutMs = DEFAULT_LOG_FLUSH_TIMEOUT_MS): Promise<void> {
    const completion = logCompletion
    if (!completion) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        completion,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Server log did not finish before the shutdown deadline')), timeoutMs)
        }),
      ])
      if (logCompletion === completion) logCompletion = undefined
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return {
    async start(options: ServerSpawnerOptions): Promise<void> {
      if (childProcess || logCompletion) {
        await this.stop()
      }

      const { resources, port } = options
      const timeoutMs = options.healthCheckTimeoutMs ?? 30_000
      const inheritedEnv: Record<string, string | undefined> = { ...process.env }
      // Do not let Electron's Node-only module lookup/runtime mode leak into
      // the standalone Rust process. Keep normal process values (PATH, HOME,
      // and platform-specific variables) intact.
      delete inheritedEnv.NODE_PATH
      delete inheritedEnv.NODE_ENV
      // AUTH_TOKEN must come from the app-bound config directory's `.env`.
      // An inherited shell token would take precedence over dotenv loading
      // and could make the browser's configured token fail authentication.
      delete inheritedEnv.AUTH_TOKEN
      const env: Record<string, string | undefined> = {
        ...inheritedEnv,
        PORT: String(port),
        FRESHELL_HOME: resources.homeDir,
        FRESHELL_CLIENT_DIR: resources.clientDir,
        FRESHELL_CLAUDE_NODE: resources.claudeNodeBinary,
        FRESHELL_CLAUDE_SIDECAR: resources.claudeSidecarEntry,
        FRESHELL_MCP_NODE: resources.mcpNodeBinary,
        FRESHELL_MCP_ENTRY: resources.mcpEntry,
      }
      fs.mkdirSync(resources.logDir, { recursive: true })
      const spawned = spawn(resources.serverBinary, [], {
        env,
        cwd: resources.configDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      })
      childProcess = spawned
      running = true
      processExited = false

      const markExited = () => {
        if (childProcess === spawned) {
          processExited = true
          running = false
          childProcess = null
        }
      }
      spawned.once('close', markExited)
      spawned.on('error', (error) => {
        // A failed spawn has no PID. Errors from kill() or IPC on an existing
        // child do not establish that it exited, so keep tracking that child.
        if (spawned.pid === undefined) markExited()
        logServerFailure('server_process_failed', error, spawned.pid)
      })

      logCompletion = pipeServerLog(spawned, resources.logDir)

      try {
        await pollHealthCheck(port, timeoutMs, () => processExited)
        const authToken = options.authToken ?? readAuthToken(resources.configDir)
        await verifyRustServerInfo(port, authToken, () => processExited)
      } catch (error) {
        // A rejected start never reaches the main window's quit cleanup.
        // Release this exact child before reporting the readiness failure.
        try {
          await this.stop()
        } catch (stopError) {
          logServerFailure('server_start_cleanup_failed', stopError, spawned.pid)
          throw new AggregateError([error, stopError], 'Server startup and cleanup failed')
        }
        throw error
      }
    },

    async stop(options: ServerStopOptions = {}): Promise<void> {
      const proc = childProcess
      if (!proc) {
        running = false
        await flushServerLog(options.logFlushTimeoutMs)
        return
      }

      const gracefulTimeoutMs = options.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS
      const forceTimeoutMs = options.forceTimeoutMs ?? DEFAULT_FORCE_TIMEOUT_MS

      await new Promise<void>((resolve, reject) => {
        let settled = false
        let gracefulTimer: ReturnType<typeof setTimeout> | undefined
        let forceTimer: ReturnType<typeof setTimeout> | undefined

        const finish = (error?: Error) => {
          if (settled) return
          settled = true
          if (gracefulTimer) clearTimeout(gracefulTimer)
          if (forceTimer) clearTimeout(forceTimer)
          proc.removeListener('close', onExit)
          if (error) reject(error)
          else resolve()
        }

        const onExit = () => {
          if (childProcess === proc) {
            childProcess = null
            running = false
            processExited = true
          }
          finish()
        }

        proc.once('close', onExit)
        if (childHasExited(proc)) {
          onExit()
          return
        }

        try {
          proc.kill('SIGTERM')
        } catch {
          // The forced escalation below still targets this exact child.
        }

        gracefulTimer = setTimeout(() => {
          if (settled) return
          if (childHasExited(proc)) {
            onExit()
            return
          }
          try {
            proc.kill('SIGKILL')
          } catch {
            // The second bounded deadline reports the inability to stop it.
          }
          forceTimer = setTimeout(() => {
            if (settled) return
            if (childHasExited(proc)) {
              onExit()
              return
            }
            finish(new Error(`Server process ${proc.pid ?? 'unknown'} did not exit after SIGKILL`))
          }, forceTimeoutMs)
        }, gracefulTimeoutMs)
      })
      await flushServerLog(options.logFlushTimeoutMs)
    },

    isRunning(): boolean {
      return running
    },

    pid(): number | undefined {
      return childProcess?.pid
    },
  }
}
