import { readFileSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import dotenv from 'dotenv'
import { getFreshellConfigDir } from './freshell-home.js'
import { isWSL } from './platform.js'

/** Where this process's `.env` lives: FRESHELL_CONFIG_DIR when explicit
 *  (daemon units, named Electron profiles), else the cwd. */
function resolveDotenvAnchor(): string {
  const override = process.env.FRESHELL_CONFIG_DIR?.trim()
  if (override) return resolvePath(override)
  return process.cwd()
}

/**
 * Read the effective network bind host from ~/.freshell/config.json.
 *
 * Logic mirrors server/index.ts bind-host resolution:
 * - On WSL2, always returns '0.0.0.0' — binding to localhost makes the
 *   server unreachable from the Windows host, which is the normal access
 *   path. This is not "remote access", it's basic WSL2 functionality.
 * - If user hasn't configured (configured === false) and HOST env var
 *   is set to a valid bind address, use HOST (backward compat for
 *   existing deployments like systemd/Docker).
 * - Otherwise use config.json's network.host.
 * - Falls back to '127.0.0.1' if config is missing or invalid.
 *
 * Used by config/vite/vite.config.ts and server/index.ts for bind address.
 *
 * IMPORTANT: Calls dotenv.config() INSIDE the function (not at module top level)
 * to avoid loading .env as a side effect of importing this module. This matters
 * for server/index.ts where bootstrap.ts must run BEFORE dotenv loads .env
 * (bootstrap creates/patches .env with AUTH_TOKEN).
 */
export function getNetworkHost(): string {
  // Load .env if not already loaded. Idempotent — dotenv won't overwrite
  // vars already in process.env. Anchor to the same location/bootstrap the
  // server uses (FRESHELL_CONFIG_DIR when explicit, else cwd), so a daemon
  // unit's real .env is not silently swapped for a stray cwd one.
  const envPath = join(resolveDotenvAnchor(), '.env')
  dotenv.config({ path: envPath })

  // Explicit override for E2E tests and CI. Takes precedence over WSL
  // auto-detection and config file. Only valid bind addresses are accepted.
  const bindOverride = process.env.FRESHELL_BIND_HOST
  if (bindOverride === '0.0.0.0' || bindOverride === '127.0.0.1') {
    return bindOverride
  }

  // On WSL, binding to 127.0.0.1 makes the server unreachable from the
  // Windows host browser. Always bind to 0.0.0.0 so Windows can connect.
  if (isWSL()) return '0.0.0.0'

  try {
    const configPath = join(getFreshellConfigDir(), 'config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    const rawHost = config.settings?.network?.host
    // Whitelist only valid bind addresses to prevent malformed config from
    // causing bind errors. Any invalid value falls back to localhost.
    const host = (rawHost === '0.0.0.0' || rawHost === '127.0.0.1') ? rawHost : '127.0.0.1'
    const configured = config.settings?.network?.configured ?? false
    const envHost = process.env.HOST
    // HOST env only honored when unconfigured
    if (!configured && (envHost === '0.0.0.0' || envHost === '127.0.0.1')) {
      return envHost
    }
    return host
  } catch {
    // No config file — check HOST env as fallback for fresh installs
    const envHost = process.env.HOST
    if (envHost === '0.0.0.0' || envHost === '127.0.0.1') return envHost
    return '127.0.0.1'
  }
}
