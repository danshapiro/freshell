import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import net from 'net'
import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export interface TestServerInfo {
  port: number
  baseUrl: string
  wsUrl: string
  token: string
  configDir: string
  pid: number
}

export interface TestServerOptions {
  /** Extra environment variables to pass to the server process */
  env?: Record<string, string>
  /** Timeout in ms to wait for the server to become healthy (default: 30000) */
  startTimeoutMs?: number
  /** Whether to pipe server stdout/stderr to the test console (default: false) */
  verbose?: boolean
}

/**
 * Find an available ephemeral port by briefly binding to port 0.
 * The OS assigns a free port, we read it, then close immediately.
 */
export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('Could not determine free port')))
        return
      }
      const port = addr.port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

function findProjectRoot(): string {
  let dir = path.resolve(__dirname)
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir
    }
    dir = path.dirname(dir)
  }
  throw new Error('Could not find project root (no package.json found)')
}

/**
 * Spawns an isolated Freshell server for E2E testing.
 *
 * Each instance gets:
 * - An ephemeral port (discovered via findFreePort, then passed as PORT env var)
 * - A unique AUTH_TOKEN
 * - An isolated HOME directory (prevents touching ~/.freshell or ~/.claude)
 * - Isolated log directory
 */
export class TestServer {
  private process: ChildProcess | null = null
  private _info: TestServerInfo | null = null
  private configDir: string | null = null
  private stdoutBuffer = ''
  private stderrBuffer = ''
  private readonly options: TestServerOptions

  constructor(options: TestServerOptions = {}) {
    this.options = options
  }

  get info(): TestServerInfo {
    if (!this._info) throw new Error('TestServer not started')
    return this._info
  }

  async start(): Promise<TestServerInfo> {
    if (this.process) throw new Error('TestServer already started')

    const token = randomUUID()
    const port = await findFreePort()
    this.configDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-e2e-'))

    // Create the .freshell config dir inside the temp HOME so the server doesn't error
    const freshellDir = path.join(this.configDir, '.freshell')
    await fsp.mkdir(freshellDir, { recursive: true })

    // Pre-seed config.json so the SetupWizard does not block the UI.
    // On non-WSL systems (including CI), the client shows a SetupWizard modal
    // when config.json is missing, blocking all interaction. This minimal config
    // marks the network as already configured, bypassing the wizard.
    const configPath = path.join(freshellDir, 'config.json')
    await fsp.writeFile(configPath, JSON.stringify({
      version: 1,
      settings: {
        network: {
          configured: true,
          host: '127.0.0.1',
        },
      },
    }, null, 2))

    // Create a logs dir
    const logsDir = path.join(this.configDir, '.freshell', 'logs')
    await fsp.mkdir(logsDir, { recursive: true })

    const projectRoot = findProjectRoot()

    // We need the built server and client for production mode
    const serverEntry = path.join(projectRoot, 'dist', 'server', 'index.js')
    if (!fs.existsSync(serverEntry)) {
      throw new Error(
        `Built server not found at ${serverEntry}. Run "npm run build" first, ` +
        'or let the Playwright globalSetup handle it.'
      )
    }

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      PORT: String(port),
      AUTH_TOKEN: token,
      HOME: this.configDir,
      NODE_ENV: 'production',
      FRESHELL_LOG_DIR: logsDir,
      HIDE_STARTUP_TOKEN: 'true',
      // Force bind to 127.0.0.1 to skip WSL2 port forwarding (which
      // requires a UAC prompt and blocks server startup for 60s).
      FRESHELL_BIND_HOST: '127.0.0.1',
      ...this.options.env,
    }

    // Remove any env vars that might interfere
    delete env.VITE_PORT

    this.process = spawn('node', [serverEntry], {
      cwd: projectRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const pid = this.process.pid!

    this.process.stdout!.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      this.stdoutBuffer += text
      if (this.options.verbose) process.stdout.write(`[test-server:${pid}] ${text}`)
    })

    this.process.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      this.stderrBuffer += text
      if (this.options.verbose) process.stderr.write(`[test-server:${pid}] ${text}`)
    })

    const baseUrl = `http://127.0.0.1:${port}`
    const wsUrl = `ws://127.0.0.1:${port}`

    // Wait for health check to pass (confirms server is listening on the port)
    const timeoutMs = this.options.startTimeoutMs ?? 30_000
    await this.waitForHealth(baseUrl, timeoutMs)

    this._info = { port, baseUrl, wsUrl, token, configDir: this.configDir, pid }
    return this._info
  }

  async stop(): Promise<void> {
    if (!this.process) return

    const proc = this.process
    this.process = null
    this.stdoutBuffer = ''
    this.stderrBuffer = ''

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL')
        resolve()
      }, 5000)

      proc.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })

      proc.kill('SIGTERM')
    }).finally(async () => {
      if (this.configDir) {
        await fsp.rm(this.configDir, { recursive: true, force: true }).catch(() => {})
        this.configDir = null
      }
      this._info = null
    })
  }

  private async waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
    const start = Date.now()

    while (Date.now() - start < timeoutMs) {
      // Check if the process crashed
      if (this.process?.exitCode !== null && this.process?.exitCode !== undefined) {
        throw new Error(
          `Test server exited with code ${this.process.exitCode} before becoming ready.\n` +
          `stderr: ${this.stderrBuffer}\nstdout: ${this.stdoutBuffer}`
        )
      }

      try {
        const res = await fetch(`${baseUrl}/api/health`)
        if (res.ok) {
          const body = await res.json()
          if (body.ok) return
        }
      } catch {
        // Server not ready yet — connection refused is expected
      }
      await new Promise((r) => setTimeout(r, 200))
    }

    throw new Error(
      `Timed out waiting for test server health after ${timeoutMs}ms.\n` +
      `stdout: ${this.stdoutBuffer}\nstderr: ${this.stderrBuffer}`
    )
  }
}
