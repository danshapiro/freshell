import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { FreshellEnvironment } from '../../shared/freshell-home.js'

export type NetworkHostOptions = {
  env: FreshellEnvironment
  configDir: string
  isWsl: boolean
}

/** Return whether this process is running inside WSL. */
export function isWSL(): boolean {
  try {
    return readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft')
  } catch {
    return false
  }
}

/**
 * Resolve the host Vite should bind to.  The function is deliberately pure
 * with respect to process state: callers provide environment, config path,
 * and WSL detection so Vite and tests can use the same policy without taking
 * a dependency on the legacy Node server.
 */
export function getNetworkHost({ env, configDir, isWsl }: NetworkHostOptions): string {
  const bindOverride = env.FRESHELL_BIND_HOST
  if (bindOverride === '0.0.0.0' || bindOverride === '127.0.0.1') {
    return bindOverride
  }

  // WSL must bind all interfaces so the Windows host can reach the dev server.
  if (isWsl) return '0.0.0.0'

  try {
    const configPath = join(configDir, 'config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      settings?: { network?: { host?: unknown; configured?: unknown } }
    }
    const network = config.settings?.network
    const host = network?.host === '0.0.0.0' || network?.host === '127.0.0.1'
      ? network.host
      : '127.0.0.1'
    const configured = network?.configured ?? false
    if (!configured && (env.HOST === '0.0.0.0' || env.HOST === '127.0.0.1')) {
      return env.HOST
    }
    return host
  } catch {
    if (env.HOST === '0.0.0.0' || env.HOST === '127.0.0.1') return env.HOST
    return '127.0.0.1'
  }
}
