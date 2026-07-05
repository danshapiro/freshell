import type { TestServerInfo } from './test-server.js'

/**
 * External-target seam for the T3 oracle.
 *
 * When `FRESHELL_E2E_TARGET_URL` is set, the e2e-browser suite connects to an
 * EXTERNALLY-provided, already-running server (e.g. the Rust `freshell-server`
 * port) instead of spawning a fresh Node `TestServer`. This lets the identical
 * Playwright specs grade the port for full-flow + visual parity against the
 * ORIGINAL's committed baselines.
 *
 * This module changes NOTHING about the default behavior: when
 * `FRESHELL_E2E_TARGET_URL` is unset, `createE2eServerHandle()` returns a normal
 * `TestServer` and the suite behaves exactly as before.
 *
 * Env vars (all optional except the URL):
 * - FRESHELL_E2E_TARGET_URL     http(s) base URL of the running server to grade.
 * - FRESHELL_E2E_TARGET_TOKEN   auth token the specs navigate with (?token=...).
 * - FRESHELL_E2E_TARGET_WS_URL  override the ws(s) URL (default: derived + "/ws").
 * - FRESHELL_E2E_TARGET_HOME    the target's HOME dir, if co-located, so
 *                               filesystem-coupled specs (serverInfo.homeDir) work.
 * - FRESHELL_E2E_TARGET_TIMEOUT_MS  health-probe timeout (default 30000).
 */

/**
 * The minimal server surface the fixtures rely on. Both the local `TestServer`
 * and the `ExternalServer` satisfy this structurally.
 */
export interface E2eServerHandle {
  start(): Promise<TestServerInfo>
  stop(): Promise<void>
  readonly info: TestServerInfo
}

export function externalTargetConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.FRESHELL_E2E_TARGET_URL === 'string'
    && env.FRESHELL_E2E_TARGET_URL.trim().length > 0
}

export interface ExternalTarget {
  port: number
  baseUrl: string
  wsUrl: string
  token: string
  homeDir: string
}

export function resolveExternalTarget(env: NodeJS.ProcessEnv = process.env): ExternalTarget {
  const raw = (env.FRESHELL_E2E_TARGET_URL ?? '').trim()
  if (!raw) throw new Error('FRESHELL_E2E_TARGET_URL is not set')

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`FRESHELL_E2E_TARGET_URL is not a valid URL: ${JSON.stringify(raw)}`)
  }

  const isSecure = url.protocol === 'https:' || url.protocol === 'wss:'
  const defaultPort = isSecure ? 443 : 80
  const port = url.port ? Number(url.port) : defaultPort
  const baseUrl = `${isSecure ? 'https:' : 'http:'}//${url.host}`

  const wsUrlEnv = (env.FRESHELL_E2E_TARGET_WS_URL ?? '').trim()
  const wsUrl = wsUrlEnv || `${isSecure ? 'wss:' : 'ws:'}//${url.host}/ws`

  const token = (env.FRESHELL_E2E_TARGET_TOKEN ?? '').trim()
  const homeDir = (env.FRESHELL_E2E_TARGET_HOME ?? '').trim()

  return { port, baseUrl, wsUrl, token, homeDir }
}

/**
 * A server handle that points at an already-running EXTERNAL server.
 *
 * `start()` only verifies the target is reachable/healthy (so a misconfigured
 * URL fails fast instead of every spec timing out). `stop()` is a deliberate
 * no-op: we do NOT own the external process's lifecycle, so we must never kill
 * it (this is what keeps the seam safe against, e.g., the user's live server).
 */
export class ExternalServer implements E2eServerHandle {
  private _info: TestServerInfo | null = null
  private readonly startTimeoutMs: number

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {
    this.startTimeoutMs = Number(env.FRESHELL_E2E_TARGET_TIMEOUT_MS ?? 30_000)
  }

  get info(): TestServerInfo {
    if (!this._info) throw new Error('ExternalServer not started')
    return this._info
  }

  async start(): Promise<TestServerInfo> {
    const target = resolveExternalTarget(this.env)
    await this.waitForHealth(target.baseUrl, this.startTimeoutMs)
    this._info = {
      port: target.port,
      baseUrl: target.baseUrl,
      wsUrl: target.wsUrl,
      token: target.token,
      // The external server's filesystem is not owned/controlled by the suite.
      // If co-located, callers can supply FRESHELL_E2E_TARGET_HOME so the
      // filesystem-coupled specs (serverInfo.homeDir) still work.
      configDir: target.homeDir,
      homeDir: target.homeDir,
      logsDir: '',
      debugLogPath: '',
      pid: -1,
      runtimeRoot: '',
    }
    return this._info
  }

  async stop(): Promise<void> {
    // Intentional no-op: we never launched the external server, so we never
    // stop it. Only the process that owns it may tear it down.
    this._info = null
  }

  private async waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
    const start = Date.now()
    let lastError: unknown = null

    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(`${baseUrl}/api/health`)
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as { ok?: boolean } | null
          if (body?.ok) return
        }
        lastError = new Error(`health returned HTTP ${res.status}`)
      } catch (error) {
        lastError = error
      }
      await new Promise((r) => setTimeout(r, 200))
    }

    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for external target health at ` +
      `${baseUrl}/api/health (FRESHELL_E2E_TARGET_URL). ` +
      `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    )
  }
}

/**
 * Returns the server handle the e2e fixtures should use for a worker:
 * - `ExternalServer` when `FRESHELL_E2E_TARGET_URL` is set (grade the port);
 * - a fresh local `TestServer` otherwise (the original, default behavior).
 *
 * `TestServer` is imported lazily so that an external-target run does not even
 * load the local-spawn machinery.
 */
export async function createE2eServerHandle(
  env: NodeJS.ProcessEnv = process.env,
): Promise<E2eServerHandle> {
  if (externalTargetConfigured(env)) {
    return new ExternalServer(env)
  }
  const { TestServer } = await import('./test-server.js')
  return new TestServer()
}
