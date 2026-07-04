import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TestServer } from '../../../test/e2e-browser/helpers/test-server.js'

/**
 * External-process server harness for the equivalence oracle.
 *
 * A thin wrapper over the existing E2E `TestServer` that:
 *   (a) ensures `dist/server/index.js` is built (builds it if missing),
 *   (b) boots the REAL freshell server as an isolated child on a free loopback
 *       port with a deterministic auth token and a fully isolated HOME,
 *   (c) tags the child with ownership-sentinel env vars so any terminal /
 *       coding-cli grandchildren it spawns are attributable to THIS probe (and
 *       thus safely reapable), and
 *   (d) exposes a minimal `{ wsUrl, token, port, pid, homeDir, stop() }` handle.
 *
 * SAFETY: this never binds :3001 and never touches a server it did not spawn.
 * `stop()` delegates to TestServer's tracked-pid SIGTERM→SIGKILL reaper and then
 * removes the probe workspace this harness created.
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
  /** PID of the spawned node server process (tracked for reaping). */
  pid: number
  /** Isolated HOME the server ran under (owned + cleaned up by TestServer). */
  homeDir: string
  /** Root of the ownership-sentinel probe workspace this harness owns. */
  probeHome: string
  /** Path to the ownership sentinel file inside `probeHome`. */
  sentinelPath: string
  /** SIGTERM→SIGKILL the tracked pid and remove the probe workspace (idempotent). */
  stop(): Promise<void>
}

export interface StartExternalServerOptions {
  /** Provider tag recorded in the ownership sentinel (default: 'oracle'). */
  provider?: string
  /** Health-poll budget in ms (default: 60000 — generous for cold WSL boots). */
  startTimeoutMs?: number
  /** Pipe the spawned server's stdout/stderr to this process's console. */
  verbose?: boolean
  /** Extra env vars to inject into the spawned server. */
  env?: Record<string, string>
}

export function serverEntryPath(root: string = PROJECT_ROOT): string {
  return path.join(root, 'dist', 'server', 'index.js')
}

/**
 * Ensure the production server bundle exists. Builds it with `npm run
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
 * Boot the original freshell server as an isolated external process and return
 * a handle for driving + reaping it.
 */
export async function startExternalServer(
  options: StartExternalServerOptions = {},
): Promise<ExternalServerHandle> {
  const provider = options.provider ?? 'oracle'
  ensureServerBuilt()

  const { probeHome, sentinelPath } = await createProbeWorkspace(provider)

  const server = new TestServer({
    authStrategy: 'explicit-env',
    runtimeRootMode: 'isolated',
    startTimeoutMs: options.startTimeoutMs ?? 60_000,
    verbose: options.verbose ?? false,
    env: {
      // Force loopback: WSL servers default to 0.0.0.0. TestServer already sets
      // this, but we assert it here too so the harness is self-documenting.
      FRESHELL_BIND_HOST: '127.0.0.1',
      // Ownership sentinels — inherited by every terminal / coding-cli child the
      // server spawns, so a future reaper can prove those grandchildren are ours.
      FRESHELL_PROBE_HOME: probeHome,
      FRESHELL_PROBE_SENTINEL: sentinelPath,
      FRESHELL_PROBE_PROVIDER: provider,
      ...options.env,
    },
  })

  let info
  try {
    info = await server.start()
  } catch (err) {
    await fsp.rm(probeHome, { recursive: true, force: true }).catch(() => {})
    throw err
  }

  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    try {
      // Delegates to TestServer's tracked-pid SIGTERM→5s→SIGKILL reaper and its
      // isolated HOME / runtime-root cleanup.
      await server.stop()
    } finally {
      await fsp.rm(probeHome, { recursive: true, force: true }).catch(() => {})
    }
  }

  return {
    wsUrl: info.wsUrl,
    baseUrl: info.baseUrl,
    token: info.token,
    port: info.port,
    pid: info.pid,
    homeDir: info.homeDir,
    probeHome,
    sentinelPath,
    stop,
  }
}
