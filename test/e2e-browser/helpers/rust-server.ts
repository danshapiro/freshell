import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
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
 * and stops ONLY that PID and its owned tree — never a process it didn't
 * spawn (e.g. the user's live `:3001` server, or an unrelated sentinel).
 *
 * **Process-group boundary (read before touching kill logic):**
 * `kill(-pid, ...)` (group-kill) only reaches processes that stayed in the
 * server's OWN process group. PTY shell children the server spawns
 * (`crates/freshell-terminal/src/pty.rs`, via `portable-pty`) become the
 * leader of their OWN session/group on Unix -- their PPID stays the server's
 * PID for as long as they live, but their PGID is their own, so `kill(-pid,
 * ...)` cannot reach OR observe them at all. The mechanism that actually
 * reaps them is the Rust server's OWN graceful SIGTERM shutdown
 * (`main.rs`'s `shutdown_signal` -> each `PtyTerminal`'s `Drop` -> exact-PID
 * kill + wait -- "no orphan shells" by design, see that module's doc
 * comment). `killCurrentProcess()` below enumerates the server's live
 * descendant tree BEFORE signaling and individually verifies + backstops it
 * AFTER; this closes the narrow gap where the 5s SIGKILL escalation fires
 * before the server's graceful path finishes running. It is a backstop, not
 * the primary reap mechanism.
 *
 * This mirrors the Node `TestServer` (`test-server.ts`) isolation contract so
 * both fixtures share one safety story, and reuses its `findFreePort` /
 * `applyIsolatedHomeEnvironment` / `ensureSetupWizardBypassConfig` helpers
 * directly. The binary-path/build and health-poll logic is PORTED (not
 * imported) from the oracle harness's `port/oracle/harness/external-server.ts`
 * (`rustServerBinPath`, `ensureRustServerBuilt`, `startRustServer`,
 * `waitForRustHealth`) — ported rather than imported so the general-purpose
 * `test/e2e-browser/helpers/` seam does not take a dependency on the
 * `port/oracle/` module tree. If that source drifts, re-sync the pieces
 * below against it.
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
 *
 * INTENTIONAL DIVERGENCE from that source: the Cloud Run e2e image prebuilds
 * the binary, selects it via `FRESHELL_E2E_RUST_SERVER_BIN`, and runs specs in
 * a 2-CPU / 2-GiB task where a workspace `cargo build` gets killed outright.
 * When the override is set, this short-circuits through
 * `resolveRustServerBin`'s FAIL-CLOSED validation (:2015) and returns the
 * override — cargo NEVER runs on that path (a typo'd override must throw, not
 * silently run a different binary). The oracle harness deliberately keeps the
 * source behavior: it runs on dev/CI machines with cargo available and no
 * prebuilt-image contract.
 */
export function ensureRustServerBuilt(root: string = PROJECT_ROOT): string {
  if (process.env.FRESHELL_E2E_RUST_SERVER_BIN?.trim()) {
    return resolveRustServerBin(process.env, () => {
      throw new Error('unreachable: FRESHELL_E2E_RUST_SERVER_BIN is set; buildHead must not run')
    }).bin
  }
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

/** Resolve the freshell-server binary the harness will spawn. FAIL CLOSED
 *  (:2015): when `FRESHELL_E2E_RUST_SERVER_BIN` is set it MUST be an executable
 *  file or this THROWS — a typo/stale/non-exec path must never silently fall back
 *  to the FIXED HEAD binary (which would make the historical-regression proof run
 *  the wrong binary and pass). Returns `{ bin, source }`; `source` is `'override'`
 *  or `'built'`. `buildHead` is injected so tests need not compile HEAD. */
export function resolveRustServerBin(
  env: NodeJS.ProcessEnv,
  buildHead: () => string = ensureRustServerBuilt,
  cwd: string = process.cwd(),
): { bin: string; source: 'override' | 'built' } {
  const overrideBin = env.FRESHELL_E2E_RUST_SERVER_BIN
  if (overrideBin !== undefined && overrideBin.trim() !== '') {
    // Resolve once, then use this exact absolute path for validation, hashing,
    // and spawn. In particular, a slashless override must never be statted in
    // cwd but later executed by PATH lookup as a different program.
    const p = path.resolve(cwd, overrideBin.trim())
    let st: fs.Stats
    try {
      st = fs.statSync(p)
    } catch {
      throw new Error(`FRESHELL_E2E_RUST_SERVER_BIN is set but does not exist: ${p}`)
    }
    if (!st.isFile()) {
      throw new Error(`FRESHELL_E2E_RUST_SERVER_BIN is set but is not a regular file: ${p}`)
    }
    try {
      fs.accessSync(p, fs.constants.X_OK)
    } catch {
      throw new Error(`FRESHELL_E2E_RUST_SERVER_BIN is set but is not executable: ${p}`)
    }
    return { bin: p, source: 'override' }
  }
  return { bin: buildHead(), source: 'built' }
}

/** sha256 of a binary, for evidence that the SELECTED override was actually run. */
export function rustServerBinSha256(bin: string): string {
  return createHash('sha256').update(fs.readFileSync(bin)).digest('hex')
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
 * Source of truth: `test-server.ts`'s `ensureSetupWizardBypassConfig`
 * (currently module-private there, so this is a byte-for-byte PORT, not an
 * import -- same rationale as the `port/oracle/` pieces below: keep this
 * general-purpose fixture's imports scoped to what `test-server.ts` already
 * exports today). If that source drifts, re-sync this copy against it.
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

/**
 * Recursively enumerate the live descendant PIDs of `pid` (children,
 * grandchildren, ...) by walking `ps --ppid` breadth-first. Used to find PTY
 * shell children the Rust server spawns: they `setsid()` into their OWN
 * session/group (see the class doc comment below), so `kill(-pid, ...)`
 * cannot reach or observe them, but their PPID chain up to `pid` is
 * unaffected by that -- PPID tracks parentage, PGID tracks the signal-group
 * boundary, and these children only change the latter.
 *
 * Ownership-safe to individually signal any PID this returns: each one was
 * discovered by walking the OWN descendant tree of a PID this fixture
 * spawned, so it can never be a sibling/unrelated process.
 */
function listChildPids(parentPid: number): number[] {
  const result = spawnSync('ps', ['-o', 'pid=', '--ppid', String(parentPid)], {
    encoding: 'utf8',
  })
  if (result.status !== 0 || !result.stdout) return []
  return result.stdout
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0)
}

export function ownedDescendantPids(rootPid: number): number[] {
  const seen = new Set<number>()
  let frontier = [rootPid]
  while (frontier.length > 0) {
    const next: number[] = []
    for (const pid of frontier) {
      for (const child of listChildPids(pid)) {
        if (!seen.has(child)) {
          seen.add(child)
          next.push(child)
        }
      }
    }
    frontier = next
  }
  return Array.from(seen)
}

/** True if `pid` is alive right now (an exact PID, never a process-group). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * AGENT-24 kilroy-lane Gemini-independence scrub list — the single source of
 * truth shared by `fresh-agent-control-rust.spec.ts` and its unit pin in
 * `rust-server.test.ts`. Every env name that could hand the spawned Rust
 * server Gemini-summary availability must be here: `main.rs` consumes
 * `GOOGLE_GENERATIVE_AI_API_KEY` (env wins over `settings.ai.geminiApiKey`)
 * and the Rust-only `FRESHELL_GEMINI_BASE_URL` endpoint seam, while a
 * developer shell commonly exports `GEMINI_API_KEY` or other `GEMINI_*` vars.
 * Used as `stripEnvPrefixes` entries — exact names strip exact keys, the
 * `GEMINI_` entry strips any prefixed key — so no dev-machine credential can
 * leak through boot()'s `...process.env` spread NOR an `options.env` set.
 */
export const GEMINI_STRIP_ENV_PREFIXES: string[] = [
  'GEMINI_',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GEMINI_API_KEY',
  'FRESHELL_GEMINI_BASE_URL',
]

export interface RustServerOptions {
  /** Reuse this isolated HOME instead of creating a fresh mkdtemp one. */
  homeDir?: string
  /** Preserve the isolated HOME after stop() (for audit/debugging). */
  preserveHomeOnStop?: boolean
  /** Use a specific auth token instead of generating a random one. */
  token?: string
  /** Extra env vars merged into (and able to override) the spawned server's environment. */
  env?: Record<string, string>
  /**
   * Env var name PREFIXES deleted from the spawned server's environment after
   * the merge (same `delete env.X` pattern as VITE_PORT in boot()). `env` can
   * only add/override keys — never delete inherited `process.env` keys — so
   * proving a lane's STRUCTURAL independence from a developer machine's
   * credentials (e.g. `['GEMINI_']` for the AGENT-24 kilroy lane) lives here.
   */
  stripEnvPrefixes?: string[]
  /** Hook to populate the isolated HOME before the server boots. */
  setupHome?: (homeDir: string) => Promise<void>
  /** Timeout in ms to wait for the server to become healthy (default: 60000). */
  startTimeoutMs?: number
  /** Pipe the spawned server's stdout/stderr to this process's console. */
  verbose?: boolean
  /**
   * Test seam (kata f3wp): overrides how start() picks its port.
   * Default: findFreePort. restart paths intentionally reuse the prior port.
   */
  portPicker?: () => Promise<number>
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

    const pickPort = this.options.portPicker ?? findFreePort
    const token = this.options.token ?? randomUUID()
    const maxBootAttempts = 3
    let lastError: unknown
    for (let attempt = 1; attempt <= maxBootAttempts; attempt++) {
      const port = await pickPort()
      try {
        const info = await this.boot(homeDir, port, token)
        // DEFLAKE (f3wp, validated): /api/health is UNAUTHENTICATED and
        // instance-anonymous (200 {"ok":true,...} regardless of token), so a
        // FOREIGN test server that stole the port satisfies the health poll
        // while our child dies -- a silent false-positive boot. Confirm the
        // server that answered is OURS via a token-gated endpoint before
        // declaring success; a foreign server rejects our token.
        const identity = await fetch(`${info.baseUrl}/api/server-info`, {
          headers: { 'x-auth-token': token },
          // Node 22's fetch has no default timeout (kata f3wp): a foreign
          // process that answered /api/health but never responds on this
          // endpoint would otherwise hang the whole boot-retry loop instead
          // of failing fast into the next attempt.
          signal: AbortSignal.timeout(2000),
        }).catch((fetchError: unknown) => {
          // DEFLAKE (f3wp council round 2, B6): AbortSignal.timeout()
          // rejects with a TimeoutError/AbortError DOMException whose
          // message never matches the bindRace classifier below, so left
          // uncaught this silently skipped the "fail fast into the next
          // attempt" path promised above and instead hard-failed with full
          // teardown (home dir deleted, evidence destroyed) on a mere
          // stall. Reshape it into the bind-race vocabulary the classifier
          // already understands: a foreign server stalling on this
          // identity check is the same "something else owns this port"
          // retry case as one that answers outright wrong.
          const name = fetchError instanceof Error ? fetchError.name : ''
          if (name === 'TimeoutError' || name === 'AbortError') {
            throw new Error(
              `bind race: foreign server on port ${port} stalled responding to server-info identity check`,
            )
          }
          throw fetchError
        })
        if (!identity.ok) {
          throw new Error(
            `bind race: foreign server answered health on port ${port} (server-info ${identity.status})`,
          )
        }
        return info
      } catch (error) {
        lastError = error
        // Between attempts: PROCESS-ONLY cleanup. Do NOT call
        // stopProcess(true) here -- it deletes the owned home dir and nulls
        // this.homeDir/this._info (rust-server.ts:575-588), so any retried
        // boot would leave restart()/restartAbrupt() throwing "RustServer
        // not started" and leak the home dir on stop(). killCurrentProcess()
        // (rust-server.ts:504-541) kills only the child and touches neither.
        await this.killCurrentProcess()
        // Retry ONLY the bind-race shape (kata f3wp): the child exited or
        // never became healthy because the probed port was stolen between
        // findFreePort's close and the server's bind -- or a foreign server
        // answered the health poll (identity check above). Everything else
        // is a genuine boot failure -- clean up fully and rethrow immediately
        // (preserving the original single-attempt failure semantics).
        const message = error instanceof Error ? error.message : String(error)
        const bindRace = /EADDRINUSE|address (?:already )?in use|bind race/i.test(message)
        if (!bindRace) {
          await this.stopProcess(true)
          throw error
        }
      }
    }
    // All attempts exhausted: full cleanup (home dir included), as the
    // original pre-retry catch did.
    await this.stopProcess(true)
    throw lastError
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

  /**
   * ABRUPT-death restart (the WSL-restart-like compound mode from
   * `docs/plans/2026-07-19-state-sync-resilience-assessment.md` §7): SIGKILL
   * the server process group -- NO graceful shutdown, so the server's own
   * PTY-reaping `Drop` path (see the class doc comment) never runs and no
   * clean WS close frames are sent -- then boot a fresh process bound to the
   * SAME home, port, and token (same disk state, same reconnect target).
   *
   * Because the graceful reap never ran, the fixture-side ownership-safe
   * descendant sweep (`reapSurvivingChildren`) is the PRIMARY reap mechanism
   * here, not a backstop -- it must run BEFORE the reboot so an orphaned PTY
   * child can never linger past the fixture.
   */
  async restartAbrupt(): Promise<TestServerInfo> {
    const homeDir = this.homeDir
    const priorInfo = this._info
    if (!homeDir || !priorInfo) throw new Error('RustServer not started; cannot restartAbrupt()')

    const proc = this.process
    const pid = proc?.pid
    this.process = null

    if (proc && pid) {
      const childPidsBeforeKill = ownedDescendantPids(pid)

      await new Promise<void>((resolve) => {
        // SIGKILL delivery is effectively immediate, but keep a hard cap so a
        // pathological wait can never hang the fixture.
        const timeout = setTimeout(resolve, 5000)
        proc.once('exit', () => {
          clearTimeout(timeout)
          resolve()
        })
        try {
          // Negative pid targets the server's OWN process group only (see
          // `killCurrentProcess` for the ownership rationale).
          process.kill(-pid, 'SIGKILL')
        } catch {
          clearTimeout(timeout)
          resolve()
        }
      })

      await this.reapSurvivingChildren(childPidsBeforeKill)
    }

    return this.boot(homeDir, priorInfo.port, priorInfo.token)
  }

  async stop(): Promise<void> {
    await this.stopProcess(!this.options.preserveHomeOnStop)
  }

  /** Spawn the binary bound to the given home/port/token and wait for health. */
  private async boot(homeDir: string, port: number, token: string): Promise<TestServerInfo> {
    const { bin, source } = resolveRustServerBin(process.env)
    if (source === 'override') {
      // eslint-disable-next-line no-console
      console.log(`[rust-server] using FRESHELL_E2E_RUST_SERVER_BIN=${bin} sha256=${rustServerBinSha256(bin).slice(0, 12)}`)
    }

    // Ordering matches `TestServer.start()`: `setupHome` runs BEFORE the
    // wizard-bypass config write, so a caller-provided `setupHome` may
    // itself seed `.freshell/config.json` and have `ensureSetupWizardBypassConfig`
    // merge on top of it (rather than the bypass write happening first and
    // setupHome silently clobbering it).
    if (this.options.setupHome) {
      await this.options.setupHome(homeDir)
    }

    const freshellDir = path.join(homeDir, '.freshell')
    await fsp.mkdir(freshellDir, { recursive: true })
    await ensureSetupWizardBypassConfig(path.join(freshellDir, 'config.json'))

    const logsDir = path.join(freshellDir, 'logs')
    await fsp.mkdir(logsDir, { recursive: true })

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
    // Caller-requested credential scrubs (see RustServerOptions.stripEnvPrefixes).
    for (const prefix of this.options.stripEnvPrefixes ?? []) {
      for (const key of Object.keys(env)) {
        if (key.startsWith(prefix)) {
          delete (env as Record<string, string | undefined>)[key]
        }
      }
    }

    this.stdoutBuffer = ''
    this.stderrBuffer = ''

    this.process = spawn(bin, [], {
      cwd: PROJECT_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // New process group: lets stop() group-kill this server PID via
      // `kill(-pid, ...)` without ever touching a PID it did not spawn.
      // NOTE: this covers same-group descendants only. PTY shell children
      // the server spawns become their OWN session/group leader (see the
      // class doc comment above) and are reaped by the server's own
      // graceful SIGTERM shutdown, backstopped by `killCurrentProcess()`'s
      // individual-PID sweep below.
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
   * Live descendant PIDs of the CURRENT server process right now (e.g. PTY
   * shell children) -- see the class doc comment for why these are NOT
   * reachable via `kill(-pid, ...)`. Ownership-safe to individually signal:
   * each one was discovered by walking the descendant tree of a PID this
   * fixture spawned, so it can never be a sibling/unrelated process.
   * Returns `[]` if the server isn't running or currently has no children.
   */
  ownedChildPids(): number[] {
    const pid = this.process?.pid
    if (!pid) return []
    return ownedDescendantPids(pid)
  }

  /**
   * Terminate the current process (SIGTERM, escalating to SIGKILL after 5s)
   * WITHOUT touching the isolated HOME. Used directly by `restart()`, and as
   * the first step of `stopProcess()`.
   *
   * Group-kill (`kill(-pid, ...)`) only reaches same-group descendants. PTY
   * shell children `setsid()` into their OWN session/group (class doc
   * comment above) and are reaped by the server's OWN graceful SIGTERM
   * shutdown -- NOT by this group-kill. To backstop the narrow case where
   * the 5s SIGKILL escalation fires before that graceful path finishes, this
   * snapshots the live descendant tree BEFORE signaling, then individually
   * verifies + (if needed) reaps any survivors AFTER the group-kill settles.
   */
  private async killCurrentProcess(): Promise<void> {
    const proc = this.process
    const pid = proc?.pid
    this.process = null

    if (!proc || !pid) return

    const childPidsBeforeKill = ownedDescendantPids(pid)

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
        // Negative pid targets the server's OWN process-group leader (the
        // server + any children that stayed in its group), never a
        // sibling/unrelated process. Does NOT reach PTY shell children --
        // see the class doc comment and `childPidsBeforeKill` below.
        process.kill(-pid, 'SIGTERM')
      } catch {
        clearTimeout(timeout)
        resolve()
      }
    })

    await this.reapSurvivingChildren(childPidsBeforeKill)
  }

  /**
   * Backstop for the SIGKILL-escalation gap: individually verify each PID
   * enumerated BEFORE the group-kill above is actually dead, and if any
   * survived, SIGTERM then SIGKILL it directly. Ownership-safe because every
   * PID here was discovered by walking the descendant tree of a PID this
   * fixture spawned (see `ownedDescendantPids`).
   */
  private async reapSurvivingChildren(pids: number[]): Promise<void> {
    const alive = pids.filter((childPid) => isPidAlive(childPid))
    if (alive.length === 0) return

    for (const childPid of alive) {
      try {
        process.kill(childPid, 'SIGTERM')
      } catch {
        // Already gone.
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 500))

    for (const childPid of alive) {
      if (isPidAlive(childPid)) {
        try {
          process.kill(childPid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    }
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
        // Per-poll bound (f3wp, validated): a bind-race occupier that ACCEPTS
        // the TCP connection but never answers HTTP makes an unbounded fetch
        // hang indefinitely (Node 22 fetch has no default timeout), blocking
        // the child-exit check above for the entire health budget and beyond.
        // A healthy server answers in milliseconds; 2s is generous.
        const res = await fetch(`${baseUrl}/api/health`, {
          signal: AbortSignal.timeout(2000),
        })
        if (res.ok) {
          const body = (await res.json()) as { ok?: boolean }
          if (body.ok) return
        }
      } catch {
        // Not listening yet (or a wedged occupier) — expected during boot.
      }
      await new Promise((r) => setTimeout(r, 200))
    }

    throw new Error(
      `Timed out waiting for Rust server health after ${timeoutMs}ms.\n` +
      `stdout: ${this.stdoutBuffer}\nstderr: ${this.stderrBuffer}`,
    )
  }
}
