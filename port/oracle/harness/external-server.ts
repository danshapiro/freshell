import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TestServer,
  findFreePort,
  applyIsolatedHomeEnvironment,
} from '../../../test/e2e-browser/helpers/test-server.js'

/**
 * External-process server harness for the equivalence oracle.
 *
 * A thin wrapper that boots the SYSTEM-UNDER-TEST as an isolated external child
 * on a free loopback port with a deterministic auth token and a fully isolated
 * HOME, tags it with ownership-sentinel env vars so any grandchildren are
 * attributable to THIS probe, and exposes a minimal
 * `{ wsUrl, token, port, pid, homeDir, stop() }` handle.
 *
 * TWO TARGETS share one env contract and one capture path (the whole point of an
 * external-process harness — capture is transport-only):
 *   - `node` (DEFAULT): the ORIGINAL server (`dist/server/index.js`) via the E2E
 *     `TestServer`.
 *   - `rust`: the PORT (`target/release/freshell-server`), spawned directly with
 *     the SAME env contract (PORT, AUTH_TOKEN, FRESHELL_BIND_HOST=127.0.0.1,
 *     isolated HOME, the `network:{configured:true}` config pre-seed, ownership
 *     sentinels). Selected via `options.target` or `FRESHELL_ORACLE_TARGET=rust`.
 *
 * SAFETY: this never binds :3001 and never touches a server it did not spawn.
 * `stop()` SIGTERM→SIGKILLs the tracked pid and removes the workspaces it created.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../../..')

export type OracleTarget = 'node' | 'rust'

export interface ExternalServerHandle {
  /** Which implementation was booted (`node` original vs `rust` port). */
  target: OracleTarget
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
  /**
   * Which implementation to boot. Defaults to `FRESHELL_ORACLE_TARGET === 'rust'`
   * ? 'rust' : 'node' — so the default stays the original node server and the
   * Rust port is opt-in (per-call or via the env var).
   */
  target?: OracleTarget
  /** Provider tag recorded in the ownership sentinel (default: 'oracle'). */
  provider?: string
  /** Health-poll budget in ms (default: 60000 — generous for cold WSL boots). */
  startTimeoutMs?: number
  /** Pipe the spawned server's stdout/stderr to this process's console. */
  verbose?: boolean
  /** Extra env vars to inject into the spawned server. */
  env?: Record<string, string>
  /**
   * Hook to populate the server's ISOLATED HOME before it boots (and before it
   * lazily spawns any coding-CLI sidecars). Used by T2 to seed provider auth.
   */
  setupHome?: (homeDir: string) => Promise<void>
}

export function serverEntryPath(root: string = PROJECT_ROOT): string {
  return path.join(root, 'dist', 'server', 'index.js')
}

/** Absolute path of the built Rust server binary (release profile). */
export function rustServerBinPath(root: string = PROJECT_ROOT): string {
  return path.join(root, 'target', 'release', 'freshell-server')
}

/**
 * Ensure the production node server bundle exists. Builds it with `npm run
 * build:server` if missing. Safe to call repeatedly — a no-op once built.
 */
export function ensureServerBuilt(root: string = PROJECT_ROOT): string {
  const entry = serverEntryPath(root)
  if (fs.existsSync(entry)) return entry

  const result = spawnSync('npm', ['run', 'build:server'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  })
  if (result.status !== 0) {
    throw new Error(
      `\`npm run build:server\` failed (exit ${result.status ?? 'signal ' + result.signal}); ` +
        'cannot boot the external oracle server.',
    )
  }
  if (!fs.existsSync(entry)) {
    throw new Error(`build:server completed but ${entry} is still missing.`)
  }
  return entry
}

let rustBuildDone = false

/**
 * Ensure the Rust `freshell-server` release binary exists. Builds it once with
 * `cargo build --release -p freshell-server` (idempotent + cached by cargo).
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
      `\`cargo build --release -p freshell-server\` failed ` +
        `(exit ${result.status ?? 'signal ' + result.signal}); cannot boot the Rust oracle target.`,
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

function resolveTarget(options: StartExternalServerOptions): OracleTarget {
  if (options.target) return options.target
  return process.env.FRESHELL_ORACLE_TARGET === 'rust' ? 'rust' : 'node'
}

/**
 * Boot the freshell server (original OR Rust port) as an isolated external
 * process and return a handle for driving + reaping it.
 */
export async function startExternalServer(
  options: StartExternalServerOptions = {},
): Promise<ExternalServerHandle> {
  const provider = options.provider ?? 'oracle'
  const target = resolveTarget(options)
  const { probeHome, sentinelPath } = await createProbeWorkspace(provider)

  try {
    return target === 'rust'
      ? await startRustServer(options, provider, probeHome, sentinelPath)
      : await startNodeServer(options, provider, probeHome, sentinelPath)
  } catch (err) {
    await fsp.rm(probeHome, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

/** Boot the ORIGINAL node server via the E2E TestServer (the reference). */
async function startNodeServer(
  options: StartExternalServerOptions,
  _provider: string,
  probeHome: string,
  sentinelPath: string,
): Promise<ExternalServerHandle> {
  ensureServerBuilt()

  const server = new TestServer({
    authStrategy: 'explicit-env',
    runtimeRootMode: 'isolated',
    startTimeoutMs: options.startTimeoutMs ?? 60_000,
    verbose: options.verbose ?? false,
    ...(options.setupHome ? { setupHome: options.setupHome } : {}),
    env: {
      // Force loopback: WSL servers default to 0.0.0.0. TestServer already sets
      // this, but we assert it here too so the harness is self-documenting.
      FRESHELL_BIND_HOST: '127.0.0.1',
      // Ownership sentinels — inherited by every grandchild the server spawns.
      FRESHELL_PROBE_HOME: probeHome,
      FRESHELL_PROBE_SENTINEL: sentinelPath,
      FRESHELL_PROBE_PROVIDER: _provider,
      ...options.env,
    },
  })

  const info = await server.start()

  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    try {
      await server.stop()
    } finally {
      await fsp.rm(probeHome, { recursive: true, force: true }).catch(() => {})
    }
  }

  return {
    target: 'node',
    wsUrl: info.wsUrl,
    baseUrl: info.baseUrl,
    token: info.token,
    port: info.port,
    pid: info.pid,
    homeDir: info.homeDir,
    logsDir: info.logsDir,
    debugLogPath: info.debugLogPath,
    probeHome,
    sentinelPath,
    stop,
  }
}

/**
 * Boot the RUST port (`target/release/freshell-server`) as an isolated external
 * process, replicating the exact env contract the E2E `TestServer` gives the
 * node original: ephemeral PORT, explicit AUTH_TOKEN, FRESHELL_BIND_HOST=loopback,
 * an isolated HOME whose `.freshell/config.json` pre-seeds
 * `network:{configured:true,host:'127.0.0.1'}` (the setup-wizard bypass), an
 * isolated logs dir, and the ownership sentinels.
 */
async function startRustServer(
  options: StartExternalServerOptions,
  _provider: string,
  probeHome: string,
  sentinelPath: string,
): Promise<ExternalServerHandle> {
  const bin = ensureRustServerBuilt()

  const port = options.env?.PORT ? Number(options.env.PORT) : await findFreePort()
  const token = randomUUID()
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-oracle-rust-'))
  const freshellDir = path.join(homeDir, '.freshell')
  await fsp.mkdir(freshellDir, { recursive: true })
  // Setup-wizard bypass config — byte-for-byte the network fields the E2E
  // TestServer's ensureSetupWizardBypassConfig() pre-seeds for the node original.
  await fsp.writeFile(
    path.join(freshellDir, 'config.json'),
    JSON.stringify(
      { version: 1, settings: { network: { configured: true, host: '127.0.0.1' } } },
      null,
      2,
    ),
  )
  const logsDir = path.join(freshellDir, 'logs')
  await fsp.mkdir(logsDir, { recursive: true })

  if (options.setupHome) {
    await options.setupHome(homeDir)
  }

  const env = applyIsolatedHomeEnvironment(
    {
      ...(process.env as Record<string, string>),
      PORT: String(port),
      NODE_ENV: 'production',
      FRESHELL_LOG_DIR: logsDir,
      HIDE_STARTUP_TOKEN: 'true',
      FRESHELL_BIND_HOST: '127.0.0.1',
      AUTH_TOKEN: token,
      FRESHELL_PROBE_HOME: probeHome,
      FRESHELL_PROBE_SENTINEL: sentinelPath,
      FRESHELL_PROBE_PROVIDER: _provider,
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

  const baseUrl = `http://127.0.0.1:${port}`
  const wsUrl = `ws://127.0.0.1:${port}/ws`

  const cleanupHomes = async () => {
    await fsp.rm(homeDir, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(probeHome, { recursive: true, force: true }).catch(() => {})
  }

  let stopped = false
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
    await waitForRustHealth(child, baseUrl, options.startTimeoutMs ?? 60_000, () => stderrBuffer, () => stdoutBuffer)
  } catch (err) {
    await stop()
    throw err
  }

  return {
    target: 'rust',
    wsUrl,
    baseUrl,
    token,
    port,
    pid,
    homeDir,
    logsDir,
    debugLogPath: path.join(logsDir, `freshell-server.rust.${port}.log`),
    probeHome,
    sentinelPath,
    stop,
  }
}

/** Poll `/api/health` until `{ ok: true }`, or fail fast if the process exits. */
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
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(
    `Timed out waiting for Rust server health after ${timeoutMs}ms.\n` +
      `stdout: ${stdout()}\nstderr: ${stderr()}`,
  )
}
