import net from 'node:net'
import fsp from 'node:fs/promises'
import path from 'node:path'

export interface E2eServerInfo {
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

function isWindowsStylePath(filePath: string): boolean {
  return /^[A-Za-z]:\\/.test(filePath.replace(/\//g, '\\'))
}

function applyAppDataIsolation(env: Record<string, string>, homeDir: string): Record<string, string> {
  const pathImpl = isWindowsStylePath(homeDir) ? path.win32 : path.posix
  return {
    ...env,
    FRESHELL_HOME: homeDir,
    HOME: homeDir,
    CLAUDE_HOME: pathImpl.join(homeDir, '.claude'),
    CODEX_HOME: pathImpl.join(homeDir, '.codex'),
    FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES: '1',
    XDG_DATA_HOME: pathImpl.join(homeDir, '.local', 'share'),
    LOCALAPPDATA: pathImpl.join(homeDir, 'AppData', 'Local'),
  }
}

export function applyIsolatedHomeEnvironment(env: Record<string, string>, homeDir: string): Record<string, string> {
  const nextEnv = applyAppDataIsolation({ ...env, HOME: homeDir, USERPROFILE: homeDir }, homeDir)
  const windowsHomeDir = homeDir.replace(/\//g, '\\')
  const match = windowsHomeDir.match(/^([A-Za-z]:)(\\.*)$/)
  if (match) {
    nextEnv.HOMEDRIVE = match[1]
    nextEnv.HOMEPATH = match[2]
  } else {
    delete nextEnv.HOMEDRIVE
    delete nextEnv.HOMEPATH
  }
  delete nextEnv.CLAUDE_CONFIG_DIR
  return nextEnv
}

/**
 * The caller env keys that `applyIsolatedHomeEnvironment` would replace or
 * delete for this owned home (HOME, the provider homes under it,
 * CLAUDE_CONFIG_DIR, ...), sorted. Such a caller value can never reach the
 * spawned process: provider state always lives under `<homeDir>`.
 */
export function homeIsolationConflicts(callerEnv: Record<string, string>, homeDir: string): string[] {
  const isolated = applyIsolatedHomeEnvironment({ ...callerEnv }, homeDir)
  return Object.keys(callerEnv)
    .filter((key) => isolated[key] !== callerEnv[key])
    .sort()
}

export function applyServerHomeEnvironment(
  env: Record<string, string>,
  homeDir: string,
  runtimeRootMode: 'project' | 'isolated' = 'project',
): Record<string, string> {
  if (runtimeRootMode === 'isolated' || process.platform === 'win32') {
    return applyIsolatedHomeEnvironment(env, homeDir)
  }
  return applyAppDataIsolation(env, homeDir)
}

const recentlyIssuedPorts: number[] = []
const RECENTLY_ISSUED_CAP = 64

export async function findFreePort(probe: () => Promise<number> = probeEphemeralPort): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await probe()
    if (!recentlyIssuedPorts.includes(port)) {
      recentlyIssuedPorts.push(port)
      if (recentlyIssuedPorts.length > RECENTLY_ISSUED_CAP) recentlyIssuedPorts.shift()
      return port
    }
  }
  throw new Error('findFreePort: no not-recently-issued port after 20 probes')
}

/**
 * Prove that a fixture port is available without retaining a listener.
 * This is deliberately a test-fixture transport seam, not application
 * server behavior.
 */
export async function canBindLoopbackPort(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true))
    })
  })
}

/**
 * Make one bounded loopback transport probe and always release its socket.
 * An outer abort owns cancellation for readiness and teardown tests.
 */
export async function canConnectLoopbackPort(
  port: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    let settled = false
    const finish = (connected: boolean) => {
      if (settled) return
      settled = true
      socket.off('connect', onConnect)
      socket.off('error', onError)
      socket.off('timeout', onTimeout)
      signal.removeEventListener('abort', onAbort)
      socket.destroy()
      resolve(connected)
    }
    const onConnect = () => finish(true)
    const onError = () => finish(false)
    const onTimeout = () => finish(false)
    const onAbort = () => finish(false)
    if (signal.aborted) {
      finish(false)
      return
    }
    socket.once('connect', onConnect)
    socket.once('error', onError)
    socket.setTimeout(timeoutMs, onTimeout)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function probeEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not determine free port')))
        return
      }
      server.close(() => resolve(address.port))
    })
    server.on('error', reject)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export async function ensureSetupWizardBypassConfig(configPath: string): Promise<void> {
  let existing: Record<string, unknown> | null = null
  try {
    const parsed = JSON.parse(await fsp.readFile(configPath, 'utf8'))
    existing = isRecord(parsed) ? parsed : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const settings = isRecord(existing?.settings) ? existing.settings : {}
  const network = isRecord(settings.network) ? settings.network : {}
  await fsp.writeFile(configPath, JSON.stringify({
    ...(existing ?? {}),
    version: 1,
    settings: { ...settings, network: { configured: true, host: '127.0.0.1', ...network } },
  }, null, 2))
}
