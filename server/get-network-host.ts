import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import dotenv from 'dotenv'

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
 * Used by vite.config.ts and server/index.ts for bind address.
 *
 * IMPORTANT: Calls dotenv.config() INSIDE the function (not at module top level)
 * to avoid loading .env as a side effect of importing this module. This matters
 * for server/index.ts where bootstrap.ts must run BEFORE dotenv loads .env
 * (bootstrap creates/patches .env with AUTH_TOKEN).
 */
export function getNetworkHost(): string {
  // Load .env if not already loaded. Idempotent — dotenv won't overwrite
  // vars already in process.env. This ensures vite.config.ts (which doesn't
  // import 'dotenv/config') can still see HOST from .env.
  dotenv.config()

  // On WSL2, binding to 127.0.0.1 makes the server unreachable from the
  // Windows host browser. Always bind to 0.0.0.0 so Windows can connect.
  if (isWSL2()) return '0.0.0.0'

  try {
    const configPath = join(homedir(), '.freshell', 'config.json')
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

function isWSL2(): boolean {
  try {
    const version = readFileSync('/proc/version', 'utf-8')
    return version.toLowerCase().includes('microsoft')
  } catch {
    return false
  }
}
