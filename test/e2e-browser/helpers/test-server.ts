import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import net from 'net'
import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { resolveDebugLogPath } from '../../../server/logger.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export interface TestServerInfo {
  port: number
  baseUrl: string
  wsUrl: string
  token: string
  configDir: string
  homeDir: string
  logsDir: string
  debugLogPath: string
  pid: number
  runtimeRoot: string
}

export interface TestServerOptions {
  /** Extra environment variables to pass to the server process */
  env?: Record<string, string>
  /** Optional setup hook for populating the isolated HOME before the server starts */
  setupHome?: (homeDir: string) => Promise<void>
  /** Preserve the isolated HOME after stop for audit collection */
  preserveHomeOnStop?: boolean
  /** Timeout in ms to wait for the server to become healthy (default: 30000) */
  startTimeoutMs?: number
  /** Whether to pipe server stdout/stderr to the test console (default: false) */
  verbose?: boolean
  authStrategy?: 'explicit-env' | 'bootstrap'
  runtimeRootMode?: 'project' | 'isolated'
}

function isWindowsStylePath(filePath: string): boolean {
  return /^[A-Za-z]:\\/.test(filePath.replace(/\//g, '\\'))
}

export function applyIsolatedHomeEnvironment(
  env: Record<string, string>,
  homeDir: string,
): Record<string, string> {
  const pathImpl = isWindowsStylePath(homeDir) ? path.win32 : path.posix
  const nextEnv = {
    ...env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    CLAUDE_HOME: pathImpl.join(homeDir, '.claude'),
    CODEX_HOME: pathImpl.join(homeDir, '.codex'),
    XDG_DATA_HOME: pathImpl.join(homeDir, '.local', 'share'),
    LOCALAPPDATA: pathImpl.join(homeDir, 'AppData', 'Local'),
  }

  const windowsHomeDir = homeDir.replace(/\//g, '\\')
  const windowsDrivePathMatch = windowsHomeDir.match(/^([A-Za-z]:)(\\.*)$/)
  if (windowsDrivePathMatch) {
    nextEnv.HOMEDRIVE = windowsDrivePathMatch[1]
    nextEnv.HOMEPATH = windowsDrivePathMatch[2]
  } else {
    delete nextEnv.HOMEDRIVE
    delete nextEnv.HOMEPATH
  }

  return nextEnv
}

export function applyTestServerHomeEnvironment(
  env: Record<string, string>,
  homeDir: string,
  runtimeRootMode: TestServerOptions['runtimeRootMode'] = 'project',
): Record<string, string> {
  if (runtimeRootMode === 'isolated') {
    return applyIsolatedHomeEnvironment(env, homeDir)
  }

  return {
    ...env,
    HOME: homeDir,
  }
}

export function requireBuiltServerEntry(
  projectRoot: string,
  existsSync: (filePath: string) => boolean = fs.existsSync,
): string {
  const serverEntry = path.join(projectRoot, 'dist', 'server', 'index.js')
  if (!existsSync(serverEntry)) {
    throw new Error(
      `Built server not found at ${serverEntry}. Run "npm run build" first, ` +
      'or let the Playwright globalSetup handle it.'
    )
  }
  return serverEntry
}

function validateTestServerOptions(options: TestServerOptions): void {
  const authStrategy = options.authStrategy ?? 'explicit-env'
  const runtimeRootMode = options.runtimeRootMode ?? 'project'

  if (authStrategy === 'bootstrap' && runtimeRootMode !== 'isolated') {
    throw new Error('authStrategy "bootstrap" requires runtimeRootMode "isolated"')
  }
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

async function createIsolatedRuntimeRoot(projectRoot: string): Promise<string> {
  requireBuiltServerEntry(projectRoot)
  const runtimeRootsParent = path.join(projectRoot, '.worktrees')
  await fsp.mkdir(runtimeRootsParent, { recursive: true })
  const runtimeRoot = await fsp.mkdtemp(path.join(runtimeRootsParent, 'test-server-runtime-'))

  try {
    await fsp.copyFile(path.join(projectRoot, 'package.json'), path.join(runtimeRoot, 'package.json'))
    await fsp.cp(path.join(projectRoot, 'dist'), path.join(runtimeRoot, 'dist'), { recursive: true })
    return runtimeRoot
  } catch (error) {
    await fsp.rm(runtimeRoot, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

function readAuthTokenFromEnvFile(envText: string): string {
  const match = envText.match(/^AUTH_TOKEN=(.+)$/m)
  if (!match) {
    throw new Error('Bootstrapped .env did not contain AUTH_TOKEN')
  }
  return match[1].trim()
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
  private runtimeRootDir: string | null = null
  private stdoutBuffer = ''
  private stderrBuffer = ''
  private readonly options: TestServerOptions

  constructor(options: TestServerOptions = {}) {
    validateTestServerOptions(options)
    this.options = options
  }

  get info(): TestServerInfo {
    if (!this._info) throw new Error('TestServer not started')
    return this._info
  }

  private async cleanupArtifacts(forceRemoveHome: boolean): Promise<void> {
    if (this.configDir && (forceRemoveHome || !this.options.preserveHomeOnStop)) {
      await fsp.rm(this.configDir, { recursive: true, force: true }).catch(() => {})
    }
    if (this.runtimeRootDir) {
      await fsp.rm(this.runtimeRootDir, { recursive: true, force: true }).catch(() => {})
    }
    this.configDir = null
    this.runtimeRootDir = null
    this._info = null
    this.stdoutBuffer = ''
    this.stderrBuffer = ''
  }

  private async stopProcess(forceRemoveHome: boolean): Promise<void> {
    const proc = this.process
    this.process = null

    if (!proc) {
      await this.cleanupArtifacts(forceRemoveHome)
      return
    }

    await new Promise<void>((resolve) => {
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
      await this.cleanupArtifacts(forceRemoveHome)
    })
  }

  async start(): Promise<TestServerInfo> {
    if (this.process) throw new Error('TestServer already started')

    try {
      const explicitToken = randomUUID()
      const port = await findFreePort()
      this.configDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-e2e-'))
      const homeDir = this.configDir

      if (this.options.setupHome) {
        await this.options.setupHome(homeDir)
      }

      // Create the .freshell config dir inside the temp HOME so the server doesn't error
      const freshellDir = path.join(homeDir, '.freshell')
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
      const logsDir = path.join(homeDir, '.freshell', 'logs')
      await fsp.mkdir(logsDir, { recursive: true })

      const projectRoot = findProjectRoot()
      const runtimeRootMode = this.options.runtimeRootMode ?? 'project'
      const runtimeRoot = runtimeRootMode === 'isolated'
        ? await createIsolatedRuntimeRoot(projectRoot)
        : projectRoot

      this.runtimeRootDir = runtimeRootMode === 'isolated' ? runtimeRoot : null

      // We need the built server and client for production mode
      const serverEntry = requireBuiltServerEntry(runtimeRoot)

      const authStrategy = this.options.authStrategy ?? 'explicit-env'
      const env = applyTestServerHomeEnvironment({
        ...process.env as Record<string, string>,
        PORT: String(port),
        NODE_ENV: 'production',
        FRESHELL_LOG_DIR: logsDir,
        HIDE_STARTUP_TOKEN: 'true',
        // Force bind to 127.0.0.1 to skip WSL2 port forwarding (which
        // requires a UAC prompt and blocks server startup for 60s).
        FRESHELL_BIND_HOST: '127.0.0.1',
        ...this.options.env,
      }, homeDir, runtimeRootMode)

      if (authStrategy === 'explicit-env') {
        env.AUTH_TOKEN = explicitToken
      } else {
        delete env.AUTH_TOKEN
      }

      // Remove any env vars that might interfere
      delete env.VITE_PORT

      this.process = spawn('node', [serverEntry], {
        cwd: runtimeRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const pid = this.process.pid!
      const debugLogPath = resolveDebugLogPath(env, homeDir) ?? path.join(logsDir, `server-debug.production.${port}.jsonl`)

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
      const wsUrl = `ws://127.0.0.1:${port}/ws`

      // Wait for health check to pass (confirms server is listening on the port)
      const timeoutMs = this.options.startTimeoutMs ?? 30_000
      await this.waitForHealth(baseUrl, timeoutMs)

      const token = authStrategy === 'bootstrap'
        ? readAuthTokenFromEnvFile(await fsp.readFile(path.join(runtimeRoot, '.env'), 'utf8'))
        : explicitToken

      this._info = {
        port,
        baseUrl,
        wsUrl,
        token,
        configDir: homeDir,
        homeDir,
        logsDir,
        debugLogPath,
        pid,
        runtimeRoot,
      }
      return this._info
    } catch (error) {
      await this.stopProcess(true)
      throw error
    }
  }

  async stop(): Promise<void> {
    await this.stopProcess(false)
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
