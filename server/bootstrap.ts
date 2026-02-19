/**
 * Bootstrap module for first-run auto-configuration.
 *
 * This module runs synchronously on import, BEFORE dotenv/config loads,
 * to ensure that a valid .env file exists with AUTH_TOKEN and other defaults.
 *
 * Usage: import './bootstrap.js' as the first import in server/index.ts
 */

import { execSync } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { isWSL } from './platform.js'

export type BootstrapResult = {
  action: 'created' | 'patched' | 'skipped' | 'error'
  token?: string
  error?: string
}

/**
 * Get Windows host physical LAN IPs via ipconfig.exe (WSL2 only).
 * Returns IPs from Ethernet/Wi-Fi adapters, excluding virtual adapters.
 */
function getWindowsHostIps(): string[] {
  try {
    const output = execSync('/mnt/c/Windows/System32/ipconfig.exe', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const ips: string[] = []
    let inPhysicalAdapter = false

    for (const line of output.split('\n')) {
      const trimmed = line.trim()

      // Detect adapter sections by looking for "adapter" keyword
      // Physical adapters: "Ethernet adapter X:", "Wireless LAN adapter X:"
      // Virtual adapters: contain vEthernet, WSL, Docker, VirtualBox, VMware
      if (trimmed.match(/adapter/i) && trimmed.endsWith(':')) {
        const isVirtual = /vEthernet|WSL|Docker|VirtualBox|VMware/i.test(trimmed)
        inPhysicalAdapter = !isVirtual
      }

      // Extract IPv4 address if in a physical adapter section
      if (inPhysicalAdapter) {
        const ipv4Match = trimmed.match(/IPv4.*?:\s*(\d+\.\d+\.\d+\.\d+)/)
        if (ipv4Match) {
          ips.push(ipv4Match[1])
        }
      }
    }

    return ips
  } catch {
    return []
  }
}

/**
 * Score an IP address for LAN likelihood.
 * Higher score = more likely to be the user's actual LAN IP.
 */
function scoreLanIp(ip: string, netmask: string): number {
  const parts = ip.split('.').map(Number)

  // Docker bridge (172.17.0.1) - deprioritize
  if (ip.startsWith('172.17.')) return 0

  // VPN-style /32 addresses - deprioritize
  if (netmask === '255.255.255.255') return 1

  // 192.168.x.x - most common home/office LAN
  if (parts[0] === 192 && parts[1] === 168) return 100

  // 10.x.x.x with typical LAN subnets - common corporate/home
  if (parts[0] === 10) {
    // Prefer 10.0.x.x or 10.1.x.x over unusual ranges like 10.255.x.x
    if (parts[1] <= 10) return 90
    return 50
  }

  // 172.16-31.x.x (private range, excluding Docker)
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return 80

  // Other private IPs
  return 10
}

/**
 * Read the network host from ~/.freshell/config.json directly.
 *
 * This MUST NOT use dotenv or getNetworkHost() because bootstrap runs
 * before dotenv/config loads. Reading from config.json directly is safe
 * because config.json is written atomically by the server.
 *
 * The HOST env var is intentionally ignored here — dotenv hasn't loaded yet,
 * so process.env.HOST may be stale or missing. NetworkManager.initializeFromStartup()
 * rebuilds origins with the correct effective host shortly after server startup.
 */
export function readConfigHost(): '127.0.0.1' | '0.0.0.0' {
  try {
    const configPath = path.join(os.homedir(), '.freshell', 'config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    const host = config.settings?.network?.host
    return (host === '0.0.0.0' || host === '127.0.0.1') ? host : '127.0.0.1'
  } catch {
    return '127.0.0.1'
  }
}

/**
 * Detect all non-loopback IPv4 addresses from network interfaces.
 * Returns IPs sorted by LAN likelihood (most likely first).
 * In WSL, queries Windows host for physical LAN IPs.
 */
export function detectLanIps(): string[] {
  // In WSL, get Windows host's physical LAN IPs instead of WSL's virtual IPs
  if (isWSL()) {
    const windowsIps = getWindowsHostIps()
    if (windowsIps.length > 0) {
      // Score and sort Windows IPs (using /24 as assumed netmask)
      const scored = windowsIps.map((ip) => ({ address: ip, netmask: '255.255.255.0' }))
      scored.sort((a, b) => scoreLanIp(b.address, b.netmask) - scoreLanIp(a.address, a.netmask))
      return scored.map((ip) => ip.address)
    }
    // Fall through to native detection if Windows query fails
  }

  const interfaces = os.networkInterfaces()
  const ips: Array<{ address: string; netmask: string }> = []

  for (const [, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        ips.push({ address: addr.address, netmask: addr.netmask })
      }
    }
  }

  // Sort by LAN score (highest first)
  ips.sort((a, b) => scoreLanIp(b.address, b.netmask) - scoreLanIp(a.address, a.netmask))

  return ips.map((ip) => ip.address)
}

/**
 * Generate a cryptographically secure 64-character hex token.
 */
export function generateAuthToken(): string {
  return crypto.randomBytes(32).toString('hex')
}

/**
 * Build ALLOWED_ORIGINS string from localhost + LAN IPs.
 * Includes both dev port (5173) and production port (3001).
 */
export function buildAllowedOrigins(lanIps: string[]): string {
  const origins: string[] = [
    'http://localhost:5173',
    'http://localhost:3001',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:3001',
  ]

  for (const ip of lanIps) {
    origins.push(`http://${ip}:5173`)
    origins.push(`http://${ip}:3001`)
  }

  return origins.join(',')
}

/**
 * Parse a .env file into a key-value object.
 * Returns empty object if file doesn't exist.
 */
export function parseEnvFile(envPath: string): Record<string, string> {
  if (!fs.existsSync(envPath)) {
    return {}
  }

  const content = fs.readFileSync(envPath, 'utf-8')
  const env: Record<string, string> = {}

  for (const line of content.split('\n')) {
    const trimmed = line.trim()

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    // Parse key=value
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue

    const key = trimmed.slice(0, eqIdx).trim()
    let value = trimmed.slice(eqIdx + 1).trim()

    // Remove surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    env[key] = value
  }

  return env
}

/**
 * Check if we need to generate a new AUTH_TOKEN.
 * Returns true if the token is missing, empty, or a known placeholder value.
 */
export function checkNeedsAuthToken(env: Record<string, string>): boolean {
  const token = env.AUTH_TOKEN?.trim()

  if (!token) {
    return true
  }

  // Known placeholder values that should be replaced
  const placeholders = [
    'replace-with-a-long-random-token',
    'your-token-here',
    'changeme',
  ]

  return placeholders.includes(token.toLowerCase())
}

/**
 * Ensure a valid .env file exists with AUTH_TOKEN.
 *
 * - If .env doesn't exist: create it with generated token, origins, and port
 * - If .env exists but AUTH_TOKEN is missing/placeholder: patch it
 * - If .env has valid AUTH_TOKEN: skip (do nothing)
 */
export function ensureEnvFile(envPath: string): BootstrapResult {
  try {
    const exists = fs.existsSync(envPath)
    const existingEnv = parseEnvFile(envPath)
    const needsToken = checkNeedsAuthToken(existingEnv)

    if (!needsToken) {
      return { action: 'skipped' }
    }

    // Generate new token and detect LAN IPs
    const token = generateAuthToken()
    const configHost = readConfigHost()
    const lanIps = configHost === '0.0.0.0' ? detectLanIps() : []
    const origins = buildAllowedOrigins(lanIps)

    if (!exists) {
      // Create new .env file
      const content = [
        '# Auto-generated by Freshell first-run setup',
        `AUTH_TOKEN=${token}`,
        `ALLOWED_ORIGINS=${origins}`,
        'PORT=3001',
        '',
      ].join('\n')

      fs.writeFileSync(envPath, content, 'utf-8')
      return { action: 'created', token }
    } else {
      // Patch existing .env - read original content and add/update AUTH_TOKEN
      const originalContent = fs.readFileSync(envPath, 'utf-8')
      const lines = originalContent.split('\n')
      const newLines: string[] = []
      let foundAuthToken = false

      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.startsWith('AUTH_TOKEN=') || trimmed === 'AUTH_TOKEN') {
          // Replace the AUTH_TOKEN line
          newLines.push(`AUTH_TOKEN=${token}`)
          foundAuthToken = true
        } else {
          newLines.push(line)
        }
      }

      // If AUTH_TOKEN wasn't in the file at all, prepend it
      if (!foundAuthToken) {
        newLines.unshift(`AUTH_TOKEN=${token}`)
        newLines.unshift('# Auto-generated AUTH_TOKEN by Freshell first-run setup')
      }

      fs.writeFileSync(envPath, newLines.join('\n'), 'utf-8')
      return { action: 'patched', token }
    }
  } catch (err: any) {
    return { action: 'error', error: err?.message || String(err) }
  }
}

// --- Auto-run on import ---
// Determine .env path relative to this file (should be project root)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const envPath = path.join(projectRoot, '.env')

const result = ensureEnvFile(envPath)

if (result.action === 'created') {
  console.log(`[bootstrap] Created .env with auto-generated AUTH_TOKEN`)
  console.log(`[bootstrap] Token: ${result.token?.slice(0, 8)}...${result.token?.slice(-8)}`)
} else if (result.action === 'patched') {
  console.log(`[bootstrap] Patched .env with new AUTH_TOKEN`)
  console.log(`[bootstrap] Token: ${result.token?.slice(0, 8)}...${result.token?.slice(-8)}`)
} else if (result.action === 'error') {
  console.error(`[bootstrap] Failed to ensure .env: ${result.error}`)
}

