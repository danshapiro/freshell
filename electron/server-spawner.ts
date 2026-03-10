import { spawn, type ChildProcess } from 'child_process'
import http from 'http'
import fs from 'fs'
import path from 'path'

export type ServerSpawnMode =
  | {
      mode: 'production'
      nodeBinary: string
      serverEntry: string
      nativeModulesDir: string      // recompiled native modules (node-pty)
      serverNodeModulesDir: string  // pruned production dependencies
    }
  | { mode: 'dev'; tsxPath: string; serverSourceEntry: string }

export interface ServerSpawnerOptions {
  spawn: ServerSpawnMode
  port: number
  envFile: string      // path to .env
  configDir: string    // ~/.freshell
  healthCheckTimeoutMs?: number  // override for tests
}

export interface ServerSpawner {
  /** Spawn the server process. Resolves when /api/health responds. */
  start(options: ServerSpawnerOptions): Promise<void>

  /** Kill the server process gracefully (SIGTERM, then SIGKILL after timeout). */
  stop(): Promise<void>

  /** Whether the server is currently running. */
  isRunning(): boolean

  /** The child process PID, if running. */
  pid(): number | undefined
}

export function createServerSpawner(): ServerSpawner {
  let childProcess: ChildProcess | null = null
  let running = false
  /** Set to true when the spawned process exits (close or error). Checked during health check polling. */
  let processExited = false
  /** Reference to the close/error handler registered during start(), so stop() can remove it. */
  let startCloseHandler: (() => void) | null = null

  async function pollHealthCheck(port: number, timeoutMs: number): Promise<void> {
    const startTime = Date.now()
    let delay = 100

    while (Date.now() - startTime < timeoutMs) {
      // If the child process exited before the health check succeeded, fail fast
      if (processExited) {
        throw new Error('Server process exited before health check succeeded')
      }

      try {
        await new Promise<void>((resolve, reject) => {
          const req = http.get(`http://localhost:${port}/api/health`, (res) => {
            if (res.statusCode === 200) {
              resolve()
            } else {
              reject(new Error(`Health check returned ${res.statusCode}`))
            }
            res.resume()
          })
          req.on('error', reject)
          req.setTimeout(2000, () => {
            req.destroy()
            reject(new Error('Health check request timeout'))
          })
        })
        return // Success
      } catch {
        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, delay))
        delay = Math.min(delay * 2, 5000) // Exponential backoff, cap at 5s
      }
    }

    throw new Error(`Health check timed out after ${timeoutMs}ms`)
  }

  return {
    async start(options: ServerSpawnerOptions): Promise<void> {
      // Kill existing process if running (double-start idempotent)
      if (childProcess && running) {
        await this.stop()
      }

      const { spawn: spawnMode, port, configDir } = options
      const timeoutMs = options.healthCheckTimeoutMs ?? 30_000

      let cmd: string
      let args: string[]
      const env: Record<string, string> = {
        ...process.env as Record<string, string>,
        PORT: String(port),
      }

      if (spawnMode.mode === 'production') {
        cmd = spawnMode.nodeBinary
        args = [spawnMode.serverEntry]
        env.NODE_ENV = 'production'
        // native-modules first so recompiled node-pty wins over server-node-modules copy
        env.NODE_PATH = [
          spawnMode.nativeModulesDir,
          spawnMode.serverNodeModulesDir,
        ].join(path.delimiter)
      } else {
        cmd = spawnMode.tsxPath
        args = ['tsx', spawnMode.serverSourceEntry]
        // Explicitly remove NODE_ENV for dev mode (process.env may have it set)
        delete env.NODE_ENV
      }

      // Ensure log directory exists
      const logDir = path.join(configDir, 'logs')
      try {
        fs.mkdirSync(logDir, { recursive: true })
      } catch {
        // Ignore
      }

      childProcess = spawn(cmd, args, {
        env,
        cwd: configDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      })

      running = true
      processExited = false

      startCloseHandler = () => {
        running = false
        processExited = true
      }

      childProcess.on('close', startCloseHandler)
      childProcess.on('error', startCloseHandler)

      // Pipe to log file
      try {
        const logStream = fs.createWriteStream(path.join(logDir, 'server.log'), { flags: 'a' })
        childProcess.stdout?.pipe(logStream)
        childProcess.stderr?.pipe(logStream)
      } catch {
        // Ignore log errors
      }

      await pollHealthCheck(port, timeoutMs)
    },

    async stop(): Promise<void> {
      if (!childProcess) return

      const proc = childProcess
      childProcess = null

      // Remove the close/error handlers registered during start()
      // so they don't fire alongside the stop() handler below.
      if (startCloseHandler) {
        proc.removeListener('close', startCloseHandler)
        proc.removeListener('error', startCloseHandler)
        startCloseHandler = null
      }

      return new Promise<void>((resolve) => {
        // SIGKILL fallback after 5s
        const killTimeout = setTimeout(() => {
          try {
            proc.kill('SIGKILL')
          } catch {
            // Ignore -- process may have already exited
          }
          running = false
          resolve()
        }, 5000)

        // Use once() so this handler auto-removes after firing
        proc.once('close', () => {
          clearTimeout(killTimeout)
          running = false
          resolve()
        })

        proc.kill('SIGTERM')
      })
    },

    isRunning(): boolean {
      return running
    },

    pid(): number | undefined {
      return childProcess?.pid
    },
  }
}
