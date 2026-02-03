import { execSync } from 'child_process'
import fs from 'fs'

const IPV4_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/
const NETSH_PATH = '/mnt/c/Windows/System32/netsh.exe'
const POWERSHELL_PATH = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
const DEFAULT_PORT = 3001
const DEV_PORT = 5173

export type PortProxyRule = {
  connectAddress: string
  connectPort: number
}

/**
 * Parse netsh interface portproxy show v4tov4 output.
 * Returns a Map of listenPort -> { connectAddress, connectPort } for rules listening on 0.0.0.0.
 */
export function parsePortProxyRules(output: string): Map<number, PortProxyRule> {
  const rules = new Map<number, PortProxyRule>()

  for (const line of output.split('\n')) {
    // Match lines like: 0.0.0.0         3001        172.30.149.249  3001
    const match = line.match(/^([\d.]+)\s+(\d+)\s+([\d.]+)\s+(\d+)/)
    if (match) {
      const [, listenAddr, listenPort, connectAddr, connectPort] = match
      if (listenAddr === '0.0.0.0') {
        rules.set(parseInt(listenPort, 10), {
          connectAddress: connectAddr,
          connectPort: parseInt(connectPort, 10),
        })
      }
    }
  }

  return rules
}

/**
 * Get the current WSL2 IPv4 address.
 * Returns the first IPv4 address from `hostname -I`, skipping any IPv6 addresses.
 */
export function getWslIp(): string | null {
  try {
    const output = execSync('hostname -I', { encoding: 'utf-8', timeout: 5000 })
    const addresses = output.trim().split(/\s+/).filter(Boolean)

    // Find first IPv4 address (skip IPv6)
    for (const addr of addresses) {
      if (IPV4_REGEX.test(addr)) {
        return addr
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Query existing Windows port proxy rules.
 * Returns a Map of listenPort -> { connectAddress, connectPort }.
 */
export function getExistingPortProxyRules(): Map<number, PortProxyRule> {
  try {
    const output = execSync(
      `${NETSH_PATH} interface portproxy show v4tov4`,
      { encoding: 'utf-8', timeout: 10000 }
    )
    return parsePortProxyRules(output)
  } catch {
    return new Map()
  }
}

/**
 * Get the list of ports that need forwarding.
 * Uses PORT from environment (or default 3001).
 * Includes dev port 5173 unless NODE_ENV is 'production'.
 */
export function getRequiredPorts(): number[] {
  const serverPort = parseInt(process.env.PORT || String(DEFAULT_PORT), 10)
  const ports = [serverPort]

  // Include dev server port unless in production
  if (process.env.NODE_ENV !== 'production') {
    ports.push(DEV_PORT)
  }

  return ports
}

/**
 * Check if port forwarding rules need to be updated.
 * Returns true if any required port is missing, points to wrong IP, or wrong connect port.
 */
export function needsPortForwardingUpdate(
  wslIp: string,
  requiredPorts: number[],
  existingRules: Map<number, PortProxyRule>
): boolean {
  for (const port of requiredPorts) {
    const rule = existingRules.get(port)
    if (!rule) {
      return true
    }
    if (rule.connectAddress !== wslIp || rule.connectPort !== port) {
      return true
    }
  }
  return false
}

/**
 * Build PowerShell script to configure port forwarding and firewall.
 * Uses \$null escaping to prevent shell variable expansion.
 * Firewall rule restricted to private profile for security.
 */
export function buildPortForwardingScript(wslIp: string, ports: number[]): string {
  const commands: string[] = []

  // Delete existing rules (without listenaddress to catch all variants)
  // Use \$null to prevent sh from expanding $null
  for (const port of ports) {
    commands.push(
      `netsh interface portproxy delete v4tov4 listenport=${port} 2>\\$null`
    )
  }

  // Add new rules
  for (const port of ports) {
    commands.push(
      `netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=${port} connectaddress=${wslIp} connectport=${port}`
    )
  }

  // Firewall rule (delete then add for idempotency)
  // SECURITY: profile=private restricts to private networks only (not public Wi-Fi)
  commands.push(`netsh advfirewall firewall delete rule name="Freshell LAN Access" 2>\\$null`)
  commands.push(
    `netsh advfirewall firewall add rule name="Freshell LAN Access" dir=in action=allow protocol=tcp localport=${ports.join(',')} profile=private`
  )

  return commands.join('; ')
}

/**
 * Check if running inside WSL2.
 */
function isWSL2(): boolean {
  try {
    const version = fs.readFileSync('/proc/version', 'utf-8')
    return version.toLowerCase().includes('microsoft')
  } catch {
    return false
  }
}

export type SetupResult = 'success' | 'skipped' | 'failed' | 'not-wsl2'

/**
 * Set up Windows port forwarding for WSL2 LAN access.
 *
 * - Detects if running in WSL2
 * - Gets required ports from environment
 * - Checks existing port proxy rules
 * - Launches elevated PowerShell to add/update rules if needed
 * - Verifies rules were actually applied
 *
 * Returns:
 * - 'not-wsl2': Not running in WSL2, no action needed
 * - 'skipped': Rules already configured correctly
 * - 'success': Rules were added/updated and verified
 * - 'failed': Failed to configure (UAC dismissed, error, or verification failed)
 */
export function setupWslPortForwarding(): SetupResult {
  if (!isWSL2()) {
    return 'not-wsl2'
  }

  const wslIp = getWslIp()
  if (!wslIp) {
    console.error('[wsl-port-forward] Failed to detect WSL2 IP address')
    return 'failed'
  }

  const requiredPorts = getRequiredPorts()
  const existingRules = getExistingPortProxyRules()

  if (!needsPortForwardingUpdate(wslIp, requiredPorts, existingRules)) {
    console.log(`[wsl-port-forward] Rules up to date for ${wslIp}`)
    return 'skipped'
  }

  console.log(`[wsl-port-forward] Configuring port forwarding for ${wslIp}...`)
  console.log('[wsl-port-forward] UAC prompt required - please approve to enable LAN access')

  try {
    const script = buildPortForwardingScript(wslIp, requiredPorts)
    // Escape single quotes for PowerShell ArgumentList
    const escapedScript = script.replace(/'/g, "''")

    execSync(
      `${POWERSHELL_PATH} -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-Command', '${escapedScript}'"`,
      { encoding: 'utf-8', timeout: 60000, stdio: 'inherit' }
    )

    // Verify rules were actually applied (UAC cancel doesn't always throw)
    const verifyRules = getExistingPortProxyRules()
    if (needsPortForwardingUpdate(wslIp, requiredPorts, verifyRules)) {
      console.error('[wsl-port-forward] Rules were not applied - UAC may have been cancelled')
      return 'failed'
    }

    console.log('[wsl-port-forward] Port forwarding configured successfully')
    return 'success'
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[wsl-port-forward] Failed to configure: ${message}`)
    return 'failed'
  }
}
