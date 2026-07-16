import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findFreePort,
  applyIsolatedHomeEnvironment,
  type TestServerInfo,
} from './test-server.js'
import type { E2eServerHandle } from './external-target.js'

/**
 * HARNESS-01 — an OWNED Rust-server Playwright fixture.
 *
 * Builds/locates `freshell-server`, starts it on an ephemeral loopback port
 * with a unique token and an isolated `FRESHELL_HOME`, records its exact PID
 * (spawned as the leader of its OWN process group), waits for `/api/health`,
 * and stops ONLY that PID and its owned children — `kill(-pid, ...)` targets
 * the whole process group this fixture created, never a process it didn't
 * spawn (e.g. the user's live `:3001` server, or an unrelated sentinel).
 *
 * This mirrors the Node `TestServer` (`test-server.ts`) isolation contract so
 * both fixtures share one safety story, and reuses its `findFreePort` /
 * `applyIsolatedHomeEnvironment` helpers directly. The binary-path/build and
 * health-poll logic is PORTED (not imported) from the oracle harness's
 * `port/oracle/harness/external-server.ts` (`rustServerBinPath`,
 * `ensureRustServerBuilt`, `startRustServer`, `waitForRustHealth`) — ported
 * rather than imported so the general-purpose `test/e2e-browser/helpers/`
 * seam does not take a dependency on the `port/oracle/` module tree. If that
 * source drifts, re-sync the pieces below against it.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function findProjectRoot(startDir: string): string {
  let dir = path.resolve(startDir)
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    dir = path.dirname(dir)
  }
  throw new Error('Could not find project root (no package.json found)')
}

const PROJECT_ROOT = findProjectRoot(__dirname)

/**
 * Absolute path of the built Rust server binary (release profile).
 * Source of truth: `port/oracle/harness/external-server.ts`'s `rustServerBinPath`.
 */
export function rustServerBinPath(root: string = PROJECT_ROOT): string {
  return path.join(root, 'target', 'release', 'freshell-server')
}

let rustBuildDone = false

/**
 * Ensure the Rust `freshell-server` release binary exists, building it once
 * with `cargo build --release -p freshell-server` if missing (idempotent —
 * cargo itself no-ops on a clean, unchanged build).
 * Source of truth: `port/oracle/harness/external-server.ts`'s `ensureRustServerBuilt`.
 */
export function ensureRustServerBuilt(root: string = PROJECT_ROOT): string {
  const bin = rustServerBinPath(root)
  if (rustBuildDone && fs.existsSync(bin)) return bin

  const result = spawnSync('cargo', ['build', '--release', '-p', 'freshell-server'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  })
  if (result.status !== 0) {
    throw new Error(
      '`cargo build --release -p freshell-server` failed ' +
      `(exit ${result.status ?? 'signal ' + result.signal}); cannot boot the Rust server fixture.`,
    )
  }
  if (!fs.existsSync(bin)) {
    throw new Error(`cargo build completed but ${bin} is still missing.`)
  }
  rustBuildDone = true
  return bin
}

/**
 * Absolute path of the built `dist/client` SPA directory. `main.rs`'s
 * `resolve_client_dir()` already falls back to `<worktree>/dist/client` when
 * `FRESHELL_CLIENT_DIR` is unset, but this fixture sets it explicitly so
 * behavior does not depend on where cargo's `CARGO_MANIFEST_DIR` resolves to.
 */
export function rustClientDistPath(root: string = PROJECT_ROOT): string {
  return path.join(root, 'dist', 'client')
}

async function readJsonFileIfPresent(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(filePath, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Pre-seed `.freshell/config.json` with the setup-wizard bypass, byte-for-byte
 * the fields `test-server.ts`'s `ensureSetupWizardBypassConfig` writes for the
 * Node original, so both fixtures skip the same first-run wizard.
 */
async function ensureSetupWizardBypassConfig(configPath: string): Promise<void> {
  const existing = await readJsonFileIfPresent(configPath)
  const existingSettings = existing && typeof existing.settings === 'object' && existing.settings !== null
    ? existing.settings as Record<string, unknown>
    : {}
  const existingNetwork = existingSettings.network && typeof existingSettings.network === 'object'
    ? existingSettings.network as Record<string, unknown>
    : {}

  await fsp.writeFile(configPath, JSON.stringify({
    ...(existing ?? {}),
    version: 1,
    settings: {
      ...existingSettings,
      network: {
        configured: true,
        host: '127.0.0.1',
        ...existingNetwork,
      },
    },
  }, null, 2))
}

export interface RustServerOptions {
  /** Reuse this isolated HOME instead of creating a fresh mkdtemp one. */
  homeDir?: string
  /** Preserve the isolated HOME after stop() (for audit/debugging). */
  preserveHomeOnStop?: boolean
  /** Use a specific auth token instead of generating a random one. */
  token?: string
  /** Extra env vars merged into (and able to override) the spawned server's environment. */
  env?: Record<string, string>
  /** Hook to populate the isolated HOME before the server boots. */
  setupHome?: (homeDir: string) => Promise<void>
  /** Timeout in ms to wait for the server to become healthy (default: 60000). */
  startTimeoutMs?: number
  /** Pipe the spawned server's stdout/stderr to this process's console. */
  verbose?: boolean
}

/**
 * Owned Rust-server Playwright fixture (HARNESS-01). Implements the same
 * `E2eServerHandle` seam as the Node `TestServer` (`start`/`stop`/`info`),
 * plus `restart()` for same-home/same-port/same-token recovery testing.
 */
export class RustServer implements E2eServerHandle {
  private process: ChildProcess | null = null
  private _info: TestServerInfo | null = null
  private homeDir: string | null = null
  private ownsHomeDir = false
  private stdoutBuffer = ''
  private stderrBuffer = ''
  private readonly options: RustServerOptions

  constructor(options: RustServerOptions = {}) {
    this.options = options
  }

  get info(): TestServerInfo {
    if (!this._info) throw new Error('RustServer not started')
    return this._info
  }

  async start(): Promise<TestServerInfo> {
    if (this.process) throw new Error('RustServer already started')

    let homeDir: string
    if (this.options.homeDir) {
      homeDir = this.options.homeDir
      this.ownsHomeDir = false
    } else {
      homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-e2e-rust-'))
      this.ownsHomeDir = true
    }
    this.homeDir = homeDir

    try {
      const port = await findFreePort()
      const token = this.options.token ?? randomUUID()
      const info = await this.boot(homeDir, port, token)
      return info
    } catch (error) {
      await this.stopProcess(true)
      throw error
    }
  }

  /**
   * Stop the current process (keeping the isolated HOME) and boot a fresh
   * process bound to the SAME home, port, and token. Proves durable state
   * (config, session index, reconnecting clients) survives a restart under
   * the same fixture. Reusing the same port matters: the browser client's WS
   * auto-reconnect targets the original port, so a restart onto a different
   * port would never let an existing page reconnect.
   */
  async restart(): Promise<TestServerInfo> {
    const homeDir = this.homeDir
    const priorInfo = this._info
    if (!homeDir || !priorInfo) throw new Error('RustServer not started; cannot restart()')

    await this.killCurrentProcess() // process only -- the isolated HOME is never touched
    return this.boot(homeDir, priorInfo.port, priorInfo.token)
  }

  async stop(): Promise<void> {
    await this.stopProcess(!this.options.preserveHomeOnStop)
  }

  /** Spawn the binary bound to the given home/port/token and wait for health. */
  private async boot(homeDir: string, port: number, token: string): Promise<TestServerInfo> {
    const bin = ensureRustServerBuilt()

    const freshellDir = path.join(homeDir, '.freshell')
    await fsp.mkdir(freshellDir, { recursive: true })
    await ensureSetupWizardBypassConfig(path.join(freshellDir, 'config.json'))

    const logsDir = path.join(freshellDir, 'logs')
    await fsp.mkdir(logsDir, { recursive: true })

    if (this.options.setupHome) {
      await this.options.setupHome(homeDir)
    }

    const env = applyIsolatedHomeEnvironment(
      {
        ...(process.env as Record<string, string>),
        PORT: String(port),
        NODE_ENV: 'production',
        FRESHELL_LOG_DIR: logsDir,
        HIDE_STARTUP_TOKEN: 'true',
        // MANDATORY: WSL's default heuristic binds 0.0.0.0 (main.rs); force
        // loopback-only so this fixture never exposes a LAN listener.
        FRESHELL_BIND_HOST: '127.0.0.1',
        FRESHELL_CLIENT_DIR: rustClientDistPath(),
        AUTH_TOKEN: token,
        ...this.options.env,
      },
      homeDir,
    )
    // Remove any inherited PORT-adjacent var that might interfere.
    delete (env as Record<string, string | undefined>).VITE_PORT

    this.stdoutBuffer = ''
    this.stderrBuffer = ''

    this.process = spawn(bin, [], {
      cwd: PROJECT_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // New process group: lets stop() reap the whole owned tree via
      // `kill(-pid, ...)` without ever touching a PID it did not spawn.
      detached: true,
    })

    const pid = this.process.pid
    if (!pid) throw new Error('Rust server failed to spawn (no pid)')

    this.process.stdout!.on('data', (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString()
      if (this.options.verbose) process.stdout.write(`[rust-server:${pid}] ${chunk}`)
    })
    this.process.stderr!.on('data', (chunk: Buffer) => {
      this.stderrBuffer += chunk.toString()
      if (this.options.verbose) process.stderr.write(`[rust-server:${pid}] ${chunk}`)
    })

    const baseUrl = `http://127.0.0.1:${port}`
    const wsUrl = `ws://127.0.0.1:${port}/ws`

    const timeoutMs = this.options.startTimeoutMs ?? 60_000
    await this.waitForHealth(baseUrl, timeoutMs)

    this._info = {
      port,
      baseUrl,
      wsUrl,
      token,
      configDir: homeDir,
      homeDir,
      logsDir,
      debugLogPath: path.join(logsDir, `freshell-server.rust.${port}.log`),
      pid,
      runtimeRoot: PROJECT_ROOT,
    }
    return this._info
  }

  /**
   * Terminate the current process (SIGTERM, escalating to SIGKILL after 5s)
   * WITHOUT touching the isolated HOME. Used directly by `restart()`, and as
   * the first step of `stopProcess()`.
   */
  private async killCurrentProcess(): Promise<void> {
    const proc = this.process
    const pid = proc?.pid
    this.process = null

    if (!proc || !pid) return

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          // Process group already gone.
        }
        resolve()
      }, 5000)

      proc.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })

      try {
        // Negative pid targets the WHOLE process group this fixture
        // created (the server + any children it spawned), never a
        // sibling/unrelated process.
        process.kill(-pid, 'SIGTERM')
      } catch {
        clearTimeout(timeout)
        resolve()
      }
    })
  }

  private async stopProcess(forceRemoveHome: boolean): Promise<void> {
    await this.killCurrentProcess()

    if (this.homeDir && this.ownsHomeDir && (forceRemoveHome || !this.options.preserveHomeOnStop)) {
      await fsp.rm(this.homeDir, { recursive: true, force: true }).catch(() => {})
      this.homeDir = null
    } else if (forceRemoveHome) {
      this.homeDir = null
    }

    this._info = null
    this.stdoutBuffer = ''
    this.stderrBuffer = ''
  }

  private async waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
    const start = Date.now()

    while (Date.now() - start < timeoutMs) {
      if (this.process?.exitCode !== null && this.process?.exitCode !== undefined) {
        throw new Error(
          `Rust server exited with code ${this.process.exitCode} before becoming ready.\n` +
          `stderr: ${this.stderrBuffer}\nstdout: ${this.stdoutBuffer}`,
        )
      }
      try {
        const res = await fetch(`${baseUrl}/api/health`)
        if (res.ok) {
          const body = (await res.json()) as { ok?: boolean }
          if (body.ok) return
        }
      } catch {
        // Not listening yet — expected during boot.
      }
      await new Promise((r) => setTimeout(r, 200))
    }

    throw new Error(
      `Timed out waiting for Rust server health after ${timeoutMs}ms.\n` +
      `stdout: ${this.stdoutBuffer}\nstderr: ${this.stderrBuffer}`,
    )
  }
}
