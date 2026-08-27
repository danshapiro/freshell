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
  ensureSetupWizardBypassConfig,
} from '../../../test/e2e-browser/helpers/server-fixture-support.js'

/**
 * External-process harness for the Rust server used by the port oracle.
 *
 * Every invocation builds (or reuses) the worktree's Rust release binary,
 * starts that binary on an ephemeral loopback port, and gives it an isolated
 * HOME plus ownership sentinels. The returned handle owns the child and all
 * temporary directories, so `stop()` can reap exactly what this probe started.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../../..')

export interface ExternalServerHandle {
  /** ws://127.0.0.1:<port>/ws */
  wsUrl: string
  /** http://127.0.0.1:<port> */
  baseUrl: string
  /** Deterministic auth token to send in `hello`. */
  token: string
  /** Ephemeral loopback port the server bound. */
  port: number
  /** PID of the spawned server process (tracked for reaping). */
  pid: number
  /** Isolated HOME the server ran under. */
  homeDir: string
  /** Directory the isolated server writes its debug logs to. */
  logsDir: string
  /** Absolute path of the isolated server's debug log file (readable pre-teardown). */
  debugLogPath: string
  /** Root of the ownership-sentinel probe workspace this harness owns. */
  probeHome: string
  /** Path to the ownership sentinel file inside `probeHome`. */
  sentinelPath: string
  /** SIGTERM→SIGKILL the tracked pid and remove the workspaces (idempotent). */
  stop(): Promise<void>
}

export interface StartExternalServerOptions {
  /** Provider tag recorded in the ownership sentinel (default: `oracle`). */
  provider?: string
  /** Health-poll budget in ms (default: 60000 — generous for cold boots). */
  startTimeoutMs?: number
  /** Pipe the spawned server's stdout/stderr to this process's console. */
  verbose?: boolean
  /** Extra env vars to inject into the spawned server. */
  env?: Record<string, string>
  /** Populate the isolated HOME before the Rust server boots. */
  setupHome?: (homeDir: string) => Promise<void>
}

/** Absolute path of the built Rust server binary (release profile). */
export function rustServerBinPath(root: string = PROJECT_ROOT): string {
  return path.join(root, 'target', 'release', 'freshell-server')
}

let rustBuildDone = false

/** Ensure the worktree's Rust server release binary exists. */
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
      `\`cargo build --release -p freshell-server\` failed ` +
        `(exit ${result.status ?? 'signal ' + result.signal}); cannot boot the Rust oracle server.`,
    )
  }
  if (!fs.existsSync(bin)) {
    throw new Error(`cargo build completed but ${bin} is still missing.`)
  }
  rustBuildDone = true
  return bin
}

async function createProbeWorkspace(
  provider: string,
): Promise<{ probeHome: string; sentinelPath: string }> {
  const probeHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-oracle-probe-'))
  const sentinelPath = path.join(probeHome, 'probe-sentinel.json')
  await fsp.writeFile(
    sentinelPath,
    JSON.stringify(
      {
        provider,
        tempRoot: probeHome,
        sentinelPath,
        createdAt: new Date().toISOString(),
        probeRunId: randomUUID(),
        owner: 'port/oracle/harness/external-server.ts',
      },
      null,
      2,
    ),
    'utf8',
  )
  return { probeHome, sentinelPath }
}

/**
 * Boot an owned Rust server on a free loopback port.
 *
 * Port 3001 is reserved for the user's self-hosted instance. The harness
 * rejects it explicitly even when a caller supplies PORT, and otherwise uses
 * the repository's free-port helper. No listener inspection is needed because
 * ownership is established from this child process and its PID ledger.
 */
export async function startExternalServer(
  options: StartExternalServerOptions = {},
): Promise<ExternalServerHandle> {
  const provider = options.provider ?? 'oracle'
  const { probeHome, sentinelPath } = await createProbeWorkspace(provider)
  let homeDirForCleanup: string | undefined

  try {
    const bin = ensureRustServerBuilt()
    const requestedPort = options.env?.PORT ? Number(options.env.PORT) : await findFreePort()
    if (!Number.isInteger(requestedPort) || requestedPort <= 0 || requestedPort > 65_535) {
      throw new Error(`invalid oracle server port: ${options.env?.PORT ?? requestedPort}`)
    }
    if (requestedPort === 3001) {
      throw new Error('oracle server port 3001 is reserved for the self-hosted server')
    }

    const token = randomUUID()
    const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-oracle-rust-'))
    homeDirForCleanup = homeDir
    const freshellDir = path.join(homeDir, '.freshell')
    await fsp.mkdir(freshellDir, { recursive: true })
    await ensureSetupWizardBypassConfig(path.join(freshellDir, 'config.json'))
    const logsDir = path.join(freshellDir, 'logs')
    await fsp.mkdir(logsDir, { recursive: true })

    if (options.setupHome) await options.setupHome(homeDir)

    const env = applyIsolatedHomeEnvironment(
      {
        ...(process.env as Record<string, string>),
        PORT: String(requestedPort),
        NODE_ENV: 'production',
        FRESHELL_LOG_DIR: logsDir,
        HIDE_STARTUP_TOKEN: 'true',
        FRESHELL_BIND_HOST: '127.0.0.1',
        AUTH_TOKEN: token,
        FRESHELL_PROBE_HOME: probeHome,
        FRESHELL_PROBE_SENTINEL: sentinelPath,
        FRESHELL_PROBE_PROVIDER: provider,
        ...options.env,
      },
      homeDir,
    )

    const child: ChildProcess = spawn(bin, [], {
      cwd: PROJECT_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const pid = child.pid
    if (!pid) throw new Error('Rust server failed to spawn (no pid)')

    let stdoutBuffer = ''
    let stderrBuffer = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString()
      if (options.verbose) process.stdout.write(`[rust-server:${pid}] ${chunk}`)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString()
      if (options.verbose) process.stderr.write(`[rust-server:${pid}] ${chunk}`)
    })

    const baseUrl = `http://127.0.0.1:${requestedPort}`
    const wsUrl = `ws://127.0.0.1:${requestedPort}/ws`
    let stopped = false

    const cleanupHomes = async () => {
      await fsp.rm(homeDir, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(probeHome, { recursive: true, force: true }).catch(() => {})
    }

    const stop = async (): Promise<void> => {
      if (stopped) return
      stopped = true
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            child.kill('SIGKILL')
            resolve()
          }, 5_000)
          child.once('exit', () => {
            clearTimeout(timeout)
            resolve()
          })
          child.kill('SIGTERM')
        })
      }
      await cleanupHomes()
    }

    try {
      await waitForRustHealth(
        child,
        baseUrl,
        options.startTimeoutMs ?? 60_000,
        () => stderrBuffer,
        () => stdoutBuffer,
      )
    } catch (err) {
      await stop()
      throw err
    }

    return {
      wsUrl,
      baseUrl,
      token,
      port: requestedPort,
      pid,
      homeDir,
      logsDir,
      debugLogPath: path.join(logsDir, `freshell-server.rust.${requestedPort}.log`),
      probeHome,
      sentinelPath,
      stop,
    }
  } catch (err) {
    if (homeDirForCleanup) {
      await fsp.rm(homeDirForCleanup, { recursive: true, force: true }).catch(() => {})
    }
    await fsp.rm(probeHome, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

/** Poll `/api/health` until `{ ok: true }`, or fail if the process exits. */
async function waitForRustHealth(
  child: ChildProcess,
  baseUrl: string,
  timeoutMs: number,
  stderr: () => string,
  stdout: () => string,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null && child.exitCode !== undefined) {
      throw new Error(
        `Rust server exited with code ${child.exitCode} before becoming ready.\n` +
          `stderr: ${stderr()}\nstdout: ${stdout()}`,
      )
    }
    try {
      const res = await fetch(`${baseUrl}/api/health`)
      if (res.ok) {
        const body = (await res.json()) as { ok?: unknown }
        if (body.ok) return
      }
    } catch {
      // Not listening yet — expected during boot.
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(
    `Timed out waiting for Rust server health after ${timeoutMs}ms.\n` +
      `stdout: ${stdout()}\nstderr: ${stderr()}`,
  )
}
